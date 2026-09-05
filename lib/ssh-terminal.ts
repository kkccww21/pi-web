import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client, type ClientChannel, type ConnectConfig } from "ssh2";

export interface SshCreateOptions {
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKeyPath?: string;
  cols?: number;
  rows?: number;
}

export interface SshExitInfo {
  code: number | null;
  signal: string | null;
}

export class SshSessionError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "SshSessionError";
  }
}

const MAX_SESSIONS = 3;
const IDLE_TIMEOUT_MS = 15 * 60_000;
const EXIT_LINGER_MS = 5 * 60_000;
const RING_BUFFER_LIMIT = 128 * 1024;
const CONNECT_TIMEOUT_MS = 15_000;
const KEEPALIVE_INTERVAL_MS = 30_000;

type OutputListener = (chunkBase64: string, byteOffset: number) => void;
type ExitListener = (info: SshExitInfo) => void;

declare global {
  var __sshSessions: Map<string, SshSessionWrapper> | undefined;
}

function getSshRegistry(): Map<string, SshSessionWrapper> {
  if (!globalThis.__sshSessions) {
    globalThis.__sshSessions = new Map();
    const destroyAll = () => globalThis.__sshSessions?.forEach((session) => session.destroy());
    process.once("exit", destroyAll);
    process.once("SIGINT", destroyAll);
    process.once("SIGTERM", destroyAll);
  }
  return globalThis.__sshSessions;
}

export function getSshSession(id: string): SshSessionWrapper | undefined {
  return globalThis.__sshSessions?.get(id);
}

export function getSshSessionCount(): number {
  return globalThis.__sshSessions?.size ?? 0;
}

/** Mirror the byte accounting used by the SSE `id:` field. */
export class RingBuffer {
  private chunks: Buffer[] = [];
  private totalBytes = 0;

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.totalBytes += chunk.length;
    while (this.totalBytes > RING_BUFFER_LIMIT && this.chunks.length > 1) {
      const dropped = this.chunks.shift();
      if (dropped) this.totalBytes -= dropped.length;
    }
  }

  byteLength(): number {
    return this.totalBytes;
  }

  /** Full buffered tail, capped at the ring window. */
  tail(): Buffer {
    return Buffer.concat(this.chunks);
  }

  /**
   * Bytes from `offset` onwards. Clamps to the buffered window: an offset that
   * predates the ring's earliest retained byte replays the whole tail instead.
   */
  from(offset: number): Buffer {
    if (offset >= this.totalBytes) return Buffer.alloc(0);
    let skip = offset;
    const kept: Buffer[] = [];
    for (const chunk of this.chunks) {
      if (skip >= chunk.length) {
        skip -= chunk.length;
        continue;
      }
      kept.push(skip > 0 ? chunk.subarray(skip) : chunk);
      skip = 0;
    }
    return Buffer.concat(kept);
  }
}

function resolveAuth(options: SshCreateOptions): Pick<ConnectConfig, "password" | "privateKey"> {
  if (options.password) return { password: options.password };
  const candidatePaths = options.privateKeyPath
    ? [options.privateKeyPath]
    : [
        join(homedir(), ".ssh", "id_ed25519"),
        join(homedir(), ".ssh", "id_rsa"),
      ];
  for (const keyPath of candidatePaths) {
    if (!existsSync(keyPath)) continue;
    try {
      return { privateKey: readFileSync(keyPath, "utf8") };
    } catch {
      continue;
    }
  }
  // No explicit credential: ssh-agent (SSH_AUTH_SOCK) is ssh2's built-in
  // fallback when neither password nor privateKey is set.
  return {};
}

export class SshSessionWrapper {
  readonly id: string;
  readonly target: { host: string; port: number; username: string };
  readonly createdAt = Date.now();

  private conn: Client | null = null;
  private stream: ClientChannel | null = null;
  private outputBuffer = new RingBuffer();
  private outputListeners = new Set<OutputListener>();
  private exitListeners = new Set<ExitListener>();
  private exitInfo: SshExitInfo | null = null;
  private exitDelivered = false;
  private destroyed = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private lingerTimer: ReturnType<typeof setTimeout> | null = null;

  private constructor(id: string, target: { host: string; port: number; username: string }) {
    this.id = id;
    this.target = target;
  }

  static async create(options: SshCreateOptions): Promise<SshSessionWrapper> {
    const registry = getSshRegistry();
    // Count sessions that already exited but are lingering for replay — they
    // still hold memory, so they count toward the limit.
    if (registry.size >= MAX_SESSIONS) {
      throw new SshSessionError("SSH session limit reached (max 3)", 409);
    }

    const host = options.host;
    const port = options.port ?? 22;
    const username = options.username;
    const wrapper = new SshSessionWrapper(randomUUID(), { host, port, username });

    const auth = resolveAuth(options);
    const config: ConnectConfig = {
      host,
      port,
      username,
      ...auth,
      readyTimeout: CONNECT_TIMEOUT_MS,
      keepaliveInterval: KEEPALIVE_INTERVAL_MS,
    };

    const conn = new Client();
    let streamExit: SshExitInfo | null = null;
    const stream = await new Promise<ClientChannel>((resolve, reject) => {
      let settled = false;
      const fail = (message: string, status = 502) => {
        if (settled) return;
        settled = true;
        try { conn.end(); } catch { /* already closed */ }
        reject(new SshSessionError(message, status));
      };

      conn
        .once("ready", () => {
          conn.shell(
            { term: "xterm-256color", cols: options.cols, rows: options.rows },
            (error, channel) => {
              if (error) {
                fail(`Failed to open shell: ${error.message}`);
                return;
              }
              if (settled) return;
              settled = true;
              resolve(channel);
            },
          );
        })
        .once("error", (error: Error) => fail(`SSH connection failed: ${error.message}`))
        .once("timeout", () => fail("SSH connection timed out"));

      try {
        conn.connect(config);
      } catch (error) {
        fail(`SSH connection failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    wrapper.conn = conn;
    wrapper.stream = stream;
    registry.set(wrapper.id, wrapper);
    wrapper.armIdleTimer();

    // Host keys are auto-accepted on purpose: this is a locally hosted tool
    // already guarded by proxy.ts (Basic auth + host/origin checks). Add a
    // `hostVerifier` here if pinning ever becomes necessary.
    stream.on("data", (chunk: Buffer) => wrapper.handleOutput(chunk));
    // The `exit` event carries the status; `close` fires afterwards with no
    // arguments, so capture the status here and finalize on close.
    stream.on("exit", (codeOrSignal: number | string | null, signal?: string) => {
      if (typeof codeOrSignal === "number" || codeOrSignal === null) {
        streamExit = { code: typeof codeOrSignal === "number" ? codeOrSignal : null, signal: signal ?? null };
      }
    });
    stream.on("close", () => wrapper.handleExit(streamExit ?? { code: null, signal: null }));
    conn.on("error", () => wrapper.handleExit({ code: null, signal: "error" }));
    conn.on("end", () => wrapper.handleExit({ code: null, signal: "end" }));

    return wrapper;
  }

  isAlive(): boolean {
    return !this.destroyed && this.exitInfo === null;
  }

  hasExited(): boolean {
    return this.exitInfo !== null;
  }

  getExitInfo(): SshExitInfo | null {
    return this.exitInfo;
  }

  write(data: string): void {
    if (this.destroyed || this.exitInfo) return;
    this.armIdleTimer();
    try {
      this.stream?.write(data);
    } catch {
      // Write errors surface as conn error/close → exit event.
    }
  }

  resize(cols: number, rows: number): void {
    if (this.destroyed || this.exitInfo) return;
    this.armIdleTimer();
    try {
      this.stream?.setWindow(rows, cols, 0, 0);
    } catch {
      // Resize failures are harmless; the next resize retries.
    }
  }

  onOutput(listener: OutputListener): () => void {
    this.outputListeners.add(listener);
    return () => this.outputListeners.delete(listener);
  }

  onExit(listener: ExitListener): () => void {
    // Exit may have fired before subscription (slow SSE connect): deliver late.
    if (this.exitDelivered) listener(this.exitInfo ?? { code: null, signal: "terminated" });
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  getReplayBuffer(): Buffer {
    return this.outputBuffer.tail();
  }

  getReplayFrom(offset: number): Buffer {
    return this.outputBuffer.from(offset);
  }

  byteLength(): number {
    return this.outputBuffer.byteLength();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    if (this.lingerTimer !== null) clearTimeout(this.lingerTimer);
    this.outputListeners.clear();
    this.exitListeners.clear();
    try { this.stream?.end(); } catch { /* already closed */ }
    try { this.conn?.end(); } catch { /* already closed */ }
    this.conn = null;
    this.stream = null;
    globalThis.__sshSessions?.delete(this.id);
  }

  private handleOutput(chunk: Buffer): void {
    this.outputBuffer.push(chunk);
    // Cumulative offset after this chunk — doubles as the SSE `id:` value.
    const byteOffset = this.outputBuffer.byteLength();
    const base64 = chunk.toString("base64");
    for (const listener of this.outputListeners) listener(base64, byteOffset);
  }

  private handleExit(info: SshExitInfo): void {
    if (this.exitInfo) return;
    this.exitInfo = info;
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.exitDelivered = true;
    for (const listener of this.exitListeners) {
      try { listener(info); } catch { /* listener errors must not break exit delivery */ }
    }
    // Linger so a reconnecting SSE client can still replay the tail.
    this.lingerTimer = setTimeout(() => this.destroy(), EXIT_LINGER_MS);
    if (typeof this.lingerTimer.unref === "function") this.lingerTimer.unref();
  }

  private armIdleTimer(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.destroy(), IDLE_TIMEOUT_MS);
    if (typeof this.idleTimer.unref === "function") this.idleTimer.unref();
  }
}
