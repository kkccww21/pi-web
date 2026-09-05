// Fork-local addition: streaming HTML preview for files larger than the
// 256KB text cap enforced by /api/files type=read. Deliberately kept in its
// own route file (instead of extending /api/files) so upstream changes to
// that route never conflict with this feature. Authorization mirrors the
// /api/files GET handler and reuses the same shared security helpers.
import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import {
  getAllowedFileRoots,
  isExistingFilePathAllowed,
  isFilePathAllowed,
  isWindowsAbsolutePath,
  normalizeSlashes,
} from "@/lib/file-access";
import { isFilePathReferencedBySession } from "@/lib/session-file-references";
import { isApiRequestAllowed } from "@/lib/request-security";

const PREVIEWABLE_EXTENSIONS = new Set(["html", "htm"]);

function filePathFromSegments(segments: string[]): string {
  const joined = segments.join("/");
  const slashJoined = normalizeSlashes(joined);
  if (isWindowsAbsolutePath(slashJoined)) return slashJoined;
  return "/" + joined.replace(/^\/+/, "");
}

function createHtmlBodyStream(filePath: string): ReadableStream<Uint8Array> {
  const fileStream = fs.createReadStream(filePath);
  let closed = false;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      fileStream.on("data", (chunk: Buffer) => {
        if (closed) return;
        try {
          controller.enqueue(new Uint8Array(chunk));
        } catch {
          closed = true;
          fileStream.destroy();
        }
      });
      fileStream.once("end", () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // The response was already abandoned by the client.
        }
      });
      fileStream.once("error", (error) => {
        if (closed) return;
        closed = true;
        try {
          controller.error(error);
        } catch {
          // The response was already abandoned by the client.
        }
      });
    },
    cancel() {
      closed = true;
      fileStream.destroy();
    },
  });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  try {
    const { path: segments } = await params;
    const filePath = filePathFromSegments(segments);
    const sessionId = request.nextUrl.searchParams.get("sessionId");

    const allowedRoots = await getAllowedFileRoots();
    const allowedByRoot = isFilePathAllowed(filePath, allowedRoots);
    const allowedBySessionReference =
      !allowedByRoot && await isFilePathReferencedBySession(filePath, sessionId);
    if (!allowedByRoot && !allowedBySessionReference) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (!stat.isFile()) {
      return NextResponse.json({ error: "Not a file" }, { status: 400 });
    }

    const existingAuthorizationPath = stat ? filePath : path.dirname(filePath);
    if (
      !allowedBySessionReference
      && !isExistingFilePathAllowed(existingAuthorizationPath, allowedRoots)
    ) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const ext = filePath.toLowerCase().split(".").pop() ?? "";
    if (!PREVIEWABLE_EXTENSIONS.has(ext)) {
      return NextResponse.json({ error: "Preview not available for this file type" }, { status: 415 });
    }

    // The iframe itself is sandboxed (allow-scripts, opaque origin), so the
    // framed document cannot reach same-origin APIs: its requests are marked
    // cross-site by fetch metadata and rejected by isApiRequestAllowed.
    return new Response(createHtmlBodyStream(filePath), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
        "Content-Security-Policy": "frame-ancestors 'self'",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
