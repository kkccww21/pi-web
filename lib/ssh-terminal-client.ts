// Client-side helpers for the SSH terminal feature (/api/ssh/*).

export interface SshConnectOptions {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKeyPath?: string;
}

export interface SshSessionInfo {
  id: string;
  host: string;
  port: number;
  username: string;
}

export class SshClientError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "SshClientError";
  }
}

async function parseError(res: Response): Promise<never> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  throw new SshClientError(body.error ?? `HTTP ${res.status}`, res.status);
}

export async function fetchSshDefaults(): Promise<{ username: string; agentAvailable: boolean }> {
  const res = await fetch("/api/ssh/defaults");
  if (!res.ok) await parseError(res);
  return await res.json() as { username: string; agentAvailable: boolean };
}

export async function createSshSession(options: SshConnectOptions): Promise<SshSessionInfo> {
  const res = await fetch("/api/ssh/new", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
  });
  if (!res.ok) await parseError(res);
  return await res.json() as SshSessionInfo;
}

export async function destroySshSession(sessionId: string): Promise<void> {
  try {
    // keepalive: this DELETE is also fired from `pagehide` on refresh/close,
    // where a normal fetch would be cancelled before leaving the page.
    await fetch(`/api/ssh/${encodeURIComponent(sessionId)}`, { method: "DELETE", keepalive: true });
  } catch {
    // Best effort: the server-side idle/linger timers clean up anyway.
  }
}

export async function sendSshResize(sessionId: string, cols: number, rows: number): Promise<void> {
  await fetch(`/api/ssh/${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "resize", cols, rows }),
  }).catch(() => { /* transient failures are retried by the next resize */ });
}

export function encodeBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function decodeBase64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Serializes keystroke POSTs through a promise chain so rapid `onData` events
 * cannot race each other onto different HTTP/1.1 connections and arrive at the
 * PTY out of order. Errors are swallowed: the stream reconnect or an exit
 * event handles the session state, and dropped keystrokes are unavoidable then.
 */
export function createSshInputQueue(sessionId: string): { push(data: string): void; clear(): void } {
  let tail: Promise<void> = Promise.resolve();
  let cleared = false;
  return {
    push(data: string) {
      if (cleared) return;
      tail = tail.then(() => fetch(`/api/ssh/${encodeURIComponent(sessionId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "input", data }),
      }).then(() => undefined, () => undefined));
    },
    clear() {
      cleared = true;
    },
  };
}
