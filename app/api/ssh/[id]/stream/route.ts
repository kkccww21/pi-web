import { createSshEventStream } from "@/lib/ssh-event-stream";
import { isApiRequestAllowed } from "@/lib/request-security";
import { getSshSession } from "@/lib/ssh-terminal";

export const dynamic = "force-dynamic";

// GET /api/ssh/[id]/stream - SSE stream of PTY output
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isApiRequestAllowed(req)) {
    return new Response("Untrusted API request", { status: 403 });
  }
  if (req.signal.aborted) return new Response(null, { status: 204 });

  const { id } = await params;
  const session = getSshSession(id);
  if (!session) {
    return new Response("SSH session not found", { status: 404 });
  }

  const stream = createSshEventStream(req, session);
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
