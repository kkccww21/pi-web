import { NextResponse } from "next/server";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";
import { SshSessionWrapper, SshSessionError } from "@/lib/ssh-terminal";

export const dynamic = "force-dynamic";

// POST /api/ssh/new - create an SSH session and open a PTY shell
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body = await req.json() as {
      host?: string;
      port?: number;
      username?: string;
      password?: string;
      privateKeyPath?: string;
      cols?: number;
      rows?: number;
    };

    const host = typeof body.host === "string" ? body.host.trim() : "";
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const port = body.port ?? 22;
    if (!host || !username) {
      return NextResponse.json({ error: "host and username are required" }, { status: 400 });
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return NextResponse.json({ error: "port must be an integer between 1 and 65535" }, { status: 400 });
    }

    const session = await SshSessionWrapper.create({
      host,
      port,
      username,
      password: typeof body.password === "string" && body.password.length > 0 ? body.password : undefined,
      privateKeyPath: typeof body.privateKeyPath === "string" && body.privateKeyPath.trim().length > 0
        ? body.privateKeyPath.trim()
        : undefined,
      cols: typeof body.cols === "number" ? body.cols : undefined,
      rows: typeof body.rows === "number" ? body.rows : undefined,
    });

    return NextResponse.json({
      id: session.id,
      host: session.target.host,
      port: session.target.port,
      username: session.target.username,
    });
  } catch (error) {
    if (error instanceof SshSessionError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
