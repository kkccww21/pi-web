import { userInfo } from "node:os";
import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

// GET /api/ssh/defaults - suggested connect defaults for the SSH dialog
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  let username = "";
  try {
    username = userInfo().username;
  } catch {
    username = "";
  }
  return NextResponse.json({
    username,
    agentAvailable: Boolean(process.env.SSH_AUTH_SOCK),
  });
}
