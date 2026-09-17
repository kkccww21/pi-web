/**
 * Repair session histories that contain empty tool-call identifiers.
 *
 * Some OpenAI-compatible upstreams occasionally stream assistant tool calls
 * whose `id`/`name` fields are empty. pi records such a call and its
 * "Tool not found" result verbatim, so the session file (and the live
 * in-memory transcript) ends up with tool-result messages whose
 * `toolCallId` is `""`. Strict OpenAI-format upstreams then reject every
 * subsequent request with 400 ("missing field `tool_call_id`") and the
 * session can never be retried.
 *
 * This module restores the invariant "tool-call ids are never empty" without
 * changing the semantic content of the history:
 * - empty `toolCall.id` gets a synthetic non-empty id;
 * - empty `toolCall.name` is inferred from the recorded arguments;
 * - empty `toolResult.toolCallId` is paired with the matching assistant
 *   call (results are recorded in assistant source order).
 *
 * It is applied in two places: to the persisted session file before the SDK
 * loads it (startRpcSession), and to the in-memory transcript before every
 * prompt, so a session poisoned mid-run heals itself on the next retry.
 */

import { basename, dirname, join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";

export interface SanitizeResult {
  changed: boolean;
  repairs: number;
}

/**
 * Minimal structural view of pi's message types. Deliberately loose so both
 * SDK `AgentMessage[]` (in memory) and session-file `entry.message` objects
 * are accepted without importing private SDK types.
 */
export interface AgentMessageLike {
  role?: string;
  content?: unknown;
  toolCallId?: string;
  toolName?: string;
}

interface ToolCallBlockLike {
  type?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}

const isBlank = (value: unknown): boolean =>
  typeof value !== "string" || value.trim() === "";

/** Synthetic ids are namespaced so they can never collide with provider ids. */
let syntheticCounter = 0;
function nextSyntheticCallId(): string {
  syntheticCounter += 1;
  return `call_piweb_${Date.now().toString(36)}_${syntheticCounter.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Infer the intended tool name from recorded call arguments. */
export function inferToolNameFromArguments(args: unknown, hint: unknown): string {
  if (!isBlank(hint)) return hint as string;
  if (typeof args !== "object" || args === null || Array.isArray(args)) return "unknown_tool";
  const a = args as Record<string, unknown>;
  if ("command" in a || "shell" in a || "cmd" in a) return "bash";
  if ("edits" in a || ("oldText" in a && "newText" in a)) return "edit";
  if ("path" in a && "content" in a && !("offset" in a) && !("limit" in a)) return "write";
  if ("path" in a && ("offset" in a || "limit" in a)) return "read";
  if ("pattern" in a || "regex" in a) return "grep";
  if ("query" in a) return "search";
  if ("url" in a) return "fetch";
  return "unknown_tool";
}

/**
 * Sanitize a message list in place. Returns the number of field repairs.
 *
 * Tool results are consumed in order against the pending call ids of the
 * most recent assistant message, because the agent loop records results in
 * the assistant's source order.
 */
export function sanitizeAgentMessages(messages: AgentMessageLike[]): number {
  let repairs = 0;
  let pendingCallIds: string[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    if (message.role === "assistant") {
      pendingCallIds = [];
      const content = message.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!block || typeof block !== "object" || (block as ToolCallBlockLike).type !== "toolCall") continue;
        const call = block as ToolCallBlockLike;
        if (!isBlank(call.id) && !isBlank(call.name)) {
          pendingCallIds.push(call.id as string);
          continue;
        }
        if (isBlank(call.id)) {
          call.id = nextSyntheticCallId();
          repairs += 1;
        }
        if (isBlank(call.name)) {
          call.name = inferToolNameFromArguments(call.arguments, call.name);
          repairs += 1;
        }
        pendingCallIds.push(call.id as string);
      }
    } else if (message.role === "toolResult") {
      const expected = pendingCallIds.shift();
      if (isBlank(message.toolCallId)) {
        message.toolCallId = expected ?? nextSyntheticCallId();
        repairs += 1;
      }
    } else {
      pendingCallIds = [];
    }
  }
  return repairs;
}

/**
 * Repair a persisted pi session file in place. Untouched lines are
 * preserved byte-for-byte; only entries whose message actually changed are
 * re-serialized. When the file changes, the original content is copied to
 * `<backupDir>/<fileName>` (created only on the first repair of a file).
 *
 * The sanitizer runs over the file's full ordered message list so that a
 * tool-result entry pairs with the call id of the (possibly earlier) line
 * that holds the assistant message.
 */
export function sanitizeSessionFile(sessionFile: string, backupDir?: string): SanitizeResult {
  if (!sessionFile || !existsSync(sessionFile)) return { changed: false, repairs: 0 };
  const original = readFileSync(sessionFile, "utf8");
  const lines = original.split("\n");
  interface Ref {
    lineIndex: number;
    entry: { message?: AgentMessageLike };
    message: AgentMessageLike;
  }
  const refs: Ref[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i]) continue;
    let entry: { type?: string; message?: AgentMessageLike };
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue; // Structural corruption is out of scope for this repair.
    }
    if (!entry || entry.type !== "message" || !entry.message) continue;
    refs.push({ lineIndex: i, entry, message: entry.message });
  }
  const snapshots = new Map<number, string>();
  for (const ref of refs) snapshots.set(ref.lineIndex, JSON.stringify(ref.message));
  const repairs = sanitizeAgentMessages(refs.map((ref) => ref.message));
  let changedEntries = 0;
  for (const ref of refs) {
    if (JSON.stringify(ref.message) === snapshots.get(ref.lineIndex)) continue;
    lines[ref.lineIndex] = JSON.stringify(ref.entry);
    changedEntries += 1;
  }
  if (repairs > 0) {
    if (backupDir) {
      const backupPath = join(backupDir, basename(sessionFile));
      if (!existsSync(backupPath)) {
        mkdirSync(dirname(backupPath), { recursive: true });
        writeFileSync(backupPath, original, "utf8");
      }
    }
    writeFileSync(sessionFile, lines.join("\n"), "utf8");
  }
  return { changed: changedEntries > 0, repairs };
}
