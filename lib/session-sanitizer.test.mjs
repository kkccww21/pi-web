import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

async function loadSubject() {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url).import("./session-sanitizer.ts");
  } catch {
    return import("./session-sanitizer.ts");
  }
}

const { inferToolNameFromArguments, sanitizeAgentMessages, sanitizeSessionFile } =
  await loadSubject();

const emptyPair = () => [
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "x" },
      { type: "text", text: "" },
      { type: "toolCall", id: "", name: "", arguments: { edits: "[...]", path: "/tmp/f.js" } },
    ],
  },
  {
    role: "toolResult",
    toolCallId: "",
    toolName: "",
    content: [{ type: "text", text: "Tool  not found" }],
    isError: true,
  },
];

test("repairs an empty toolCall/toolResult pair and keeps the ids matched", () => {
  const messages = emptyPair();
  const repairs = sanitizeAgentMessages(messages);
  assert.ok(repairs >= 3, `expected at least 3 repairs, got ${repairs}`);
  const call = messages[0].content.find((b) => b.type === "toolCall");
  assert.ok(typeof call.id === "string" && call.id.length > 0);
  assert.equal(call.name, "edit");
  assert.equal(messages[1].toolCallId, call.id);
});

test("is idempotent and leaves healthy history untouched", () => {
  const healthy = [
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call_abc", name: "bash", arguments: { command: "ls" } }],
    },
    { role: "toolResult", toolCallId: "call_abc", toolName: "bash", content: [] },
  ];
  assert.equal(sanitizeAgentMessages(healthy), 0);
  const poisoned = emptyPair();
  assert.ok(sanitizeAgentMessages(poisoned) > 0);
  assert.equal(sanitizeAgentMessages(poisoned), 0, "second pass must find nothing to repair");
});;

test("pairs results in source order when valid and empty calls are mixed", () => {
  const messages = [
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "call_ok", name: "bash", arguments: {} },
        { type: "toolCall", id: "", name: "", arguments: { command: "pwd" } },
      ],
    },
    { role: "toolResult", toolCallId: "call_ok", toolName: "bash", content: [] },
    { role: "toolResult", toolCallId: "", toolName: "", content: [] },
  ];
  sanitizeAgentMessages(messages);
  assert.equal(messages[2].toolCallId, messages[0].content[1].id, "empty result must take the empty call's synthetic id");
  assert.ok(messages[0].content[1].id.startsWith("call_piweb_"), "synthetic id must be namespaced");
  assert.equal(messages[0].content[1].name, "bash");
});

test("orphan toolResult without a preceding assistant call still gets a non-empty id", () => {
  const messages = [{ role: "toolResult", toolCallId: "", toolName: "", content: [] }];
  sanitizeAgentMessages(messages);
  assert.ok(messages[0].toolCallId.length > 0);
});

test("a user message boundary drops pending call ids", () => {
  const messages = [
    { role: "assistant", content: [{ type: "toolCall", id: "", name: "", arguments: {} }] },
    { role: "user", content: "next prompt" },
    { role: "toolResult", toolCallId: "", toolName: "", content: [] },
  ];
  const repairs = sanitizeAgentMessages(messages);
  assert.equal(repairs, 3, "call id + call name + orphan result id, no cross-boundary pairing");
  assert.notEqual(messages[2].toolCallId, messages[0].content[0].id);
});

test("infers the tool name from the recorded arguments", () => {
  assert.equal(inferToolNameFromArguments({ command: "ls" }, ""), "bash");
  assert.equal(inferToolNameFromArguments({ edits: "x", path: "/p" }, ""), "edit");
  assert.equal(inferToolNameFromArguments({ path: "/p", content: "c" }, ""), "write");
  assert.equal(inferToolNameFromArguments({ path: "/p", limit: 10 }, ""), "read");
  assert.equal(inferToolNameFromArguments({ pattern: "q" }, ""), "grep");
  assert.equal(inferToolNameFromArguments({ url: "https://x" }, ""), "fetch");
  assert.equal(inferToolNameFromArguments({}, ""), "unknown_tool");
  assert.equal(inferToolNameFromArguments(null, "edit"), "edit", "non-empty hint wins");
});

test("sanitizeSessionFile repairs a jsonl file, preserves other lines, and backs up", () => {
  const dir = join(tmpdir(), `pi-sanitize-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "session.jsonl");
  const validLine = JSON.stringify({
    type: "message",
    id: "ok1",
    parentId: null,
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "call_valid", name: "bash", arguments: {} }],
    },
  });
  const badAssistant = JSON.stringify({
    type: "message",
    id: "a",
    parentId: "ok1",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "", name: "", arguments: { command: "pwd" } }],
    },
  });
  const badResult = JSON.stringify({
    type: "message",
    id: "b",
    parentId: "a",
    message: { role: "toolResult", toolCallId: "", toolName: "", content: [] },
  });
  writeFileSync(file, `${validLine}\n${badAssistant}\n${badResult}\n`, "utf8");
  const backupDir = join(dir, "backups");

  const result = sanitizeSessionFile(file, backupDir);
  assert.equal(result.changed, true);
  assert.equal(result.repairs, 3, "call id + call name + result id");

  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  assert.equal(lines[0], validLine, "untouched line must be byte-identical");
  const repairedCall = JSON.parse(lines[1]).message.content[0];
  const repairedResult = JSON.parse(lines[2]).message;
  assert.ok(repairedCall.id.length > 0);
  assert.equal(repairedCall.name, "bash");
  assert.equal(repairedResult.toolCallId, repairedCall.id, "file-level pairing must match across lines");
  assert.ok(existsSync(join(backupDir, "session.jsonl")), "original must be backed up");

  const again = sanitizeSessionFile(file, backupDir);
  assert.equal(again.changed, false, "second pass must be a no-op");
  rmSync(dir, { recursive: true, force: true });
});

test("sanitizeSessionFile is a no-op for missing or clean files", () => {
  assert.deepEqual(sanitizeSessionFile("/nonexistent/session.jsonl"), { changed: false, repairs: 0 });
  const dir = join(tmpdir(), `pi-sanitize-clean-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "clean.jsonl");
  writeFileSync(
    file,
    JSON.stringify({ type: "message", id: "c", parentId: null, message: { role: "user", content: "hi" } }) + "\n",
    "utf8",
  );
  assert.deepEqual(sanitizeSessionFile(file), { changed: false, repairs: 0 });
  rmSync(dir, { recursive: true, force: true });
});
