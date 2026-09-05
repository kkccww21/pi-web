import type { SshSessionWrapper } from "./ssh-terminal";

const HEARTBEAT_INTERVAL_MS = 30_000;
const REPLAY_SLICE_BYTES = 64 * 1024;

/**
 * SSE transport for an SSH session's PTY output.
 *
 * Frames:
 * - `connected`  — initial snapshot (exited state) as a default `data:` event
 * - `replay`     — buffered tail chunks, each carrying an `id:` byte offset
 * - `output`     — live PTY chunks, same `id:` semantics
 * - `exit`       — emitted once, then the stream closes
 *
 * The `id:` field is the cumulative byte count delivered. EventSource
 * reconnects automatically and sends it back as `Last-Event-ID`, so a dropped
 * connection resumes from the ring buffer without client-side dedupe.
 */
export function createSshEventStream(
  req: Request,
  session: SshSessionWrapper,
): ReadableStream<Uint8Array> {
  let cancelStream: () => void = () => {};

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let unsubscribeOutput: (() => void) | null = null;
      let unsubscribeExit: (() => void) | null = null;
      let abortHandler: (() => void) | null = null;

      const cleanup = (closeController: boolean) => {
        if (closed) return;
        closed = true;
        if (heartbeat !== null) clearInterval(heartbeat);
        unsubscribeOutput?.();
        unsubscribeExit?.();
        unsubscribeOutput = null;
        unsubscribeExit = null;
        if (abortHandler) req.signal.removeEventListener("abort", abortHandler);
        if (closeController) {
          try { controller.close(); } catch { /* stream already closed */ }
        }
      };
      cancelStream = () => cleanup(true);

      const enqueueText = (text: string) => {
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(text));
          return true;
        } catch {
          cleanup(false);
          return false;
        }
      };
      const sendChunk = (event: string, base64: string, byteOffset: number) => {
        if (closed) return;
        enqueueText(`event: ${event}\ndata: ${JSON.stringify({ data: base64 })}\nid: ${byteOffset}\n\n`);
      };
      const sendExit = (info: { code: number | null; signal: string | null }) => {
        if (closed) return;
        enqueueText(`event: exit\ndata: ${JSON.stringify(info)}\n\n`);
        cleanup(true);
      };

      // Initial frame forces the response headers out immediately.
      enqueueText(":\n\n");
      enqueueText(`data: ${JSON.stringify({
        type: "connected",
        id: session.id,
        exited: session.hasExited(),
      })}\n\n`);

      // Replay: from the client's Last-Event-ID offset, or the full buffered
      // tail when there is no prior connection. `getReplayFrom` clamps an
      // offset that predates the ring window, so derive the replay's true
      // starting offset from the session's cumulative byte count.
      const lastEventId = req.headers.get("last-event-id");
      const resumeOffset = lastEventId !== null ? Number.parseInt(lastEventId, 10) : 0;
      const replayBase = Number.isFinite(resumeOffset) && resumeOffset > 0
        ? session.getReplayFrom(resumeOffset)
        : session.getReplayBuffer();
      let sentBytes = session.byteLength() - replayBase.length;
      for (let i = 0; i < replayBase.length; i += REPLAY_SLICE_BYTES) {
        const slice = replayBase.subarray(i, i + REPLAY_SLICE_BYTES);
        sentBytes += slice.length;
        sendChunk("replay", slice.toString("base64"), sentBytes);
        if (closed) break;
      }

      if (session.hasExited()) {
        sendExit(session.getExitInfo() ?? { code: null, signal: "terminated" });
        return;
      }

      unsubscribeOutput = session.onOutput((base64, byteOffset) => {
        sendChunk("output", base64, byteOffset);
      });
      unsubscribeExit = session.onExit((info) => {
        sendExit(info);
      });

      abortHandler = () => cleanup(true);
      if (req.signal.aborted) {
        cleanup(true);
        return;
      }
      req.signal.addEventListener("abort", abortHandler, { once: true });

      heartbeat = setInterval(() => enqueueText(":\n\n"), HEARTBEAT_INTERVAL_MS);
    },
    cancel() {
      cancelStream();
    },
  });
}
