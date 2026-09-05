import { NextResponse } from "next/server";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";
import { getSshSession } from "@/lib/ssh-terminal";

export const dynamic = "force-dynamic";

// POST /api/ssh/[id] - write input to the PTY or resize it
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  const { id } = await params;
  const session = getSshSession(id);
  if (!session) {
    return NextResponse.json({ error: "SSH session not found" }, { status: 404 });
  }

  try {
    const body = await req.json() as { type?: string; data?: string; cols?: number; rows?: number };

    if (body.type === "input") {
      if (typeof body.data !== "string") {
        return NextResponse.json({ error: "data (base64 string) is required" }, { status: 400 });
      }
      if (session.hasExited()) {
        return NextResponse.json({ ok: false, exited: true });
      }
      session.write(Buffer.from(body.data, "base64").toString("utf8"));
      return NextResponse.json({ ok: true });
    }

    if (body.type === "resize") {
      const cols = Math.min(500, Math.max(2, Math.trunc(Number(body.cols) || 0)));
      const rows = Math.min(200, Math.max(1, Math.trunc(Number(body.rows) || 0)));
      if (!cols || !rows) {
        return NextResponse.json({ error: "cols and rows are required" }, { status: 400 });
      }
      session.resize(cols, rows);
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: `Unknown type: ${String(body.type)}` }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

// DELETE /api/ssh/[id] - destroy the SSH session (idempotent)
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  const { id } = await params;
  getSshSession(id)?.destroy();
  return NextResponse.json({ ok: true });
}
