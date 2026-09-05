import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { RingBuffer } = await jiti.import("./ssh-terminal.ts");
const { encodeBase64Utf8, decodeBase64ToBytes } = await jiti.import("./ssh-terminal-client.ts");

test("ring buffer keeps the latest bytes within the limit", () => {
  const buffer = new RingBuffer();
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  buffer.push(chunk);
  buffer.push(chunk);
  buffer.push(chunk);
  // 3 × 64KB pushed, limit is 128KB → the first chunk is trimmed.
  assert.equal(buffer.byteLength(), 128 * 1024);
  const tail = buffer.tail();
  assert.equal(tail.length, 128 * 1024);
  assert.ok(tail.every((byte) => byte === 0x61));
});

test("ring buffer from() replays exactly the bytes after the offset", () => {
  const buffer = new RingBuffer();
  buffer.push(Buffer.from("hello "));
  const offsetAfterHello = buffer.byteLength();
  buffer.push(Buffer.from("world"));
  assert.equal(buffer.from(offsetAfterHello).toString("utf8"), "world");
  assert.equal(buffer.from(0).toString("utf8"), "hello world");
  assert.equal(buffer.from(buffer.byteLength() + 10).length, 0);
});

test("ring buffer from() clamps an offset that predates the window", () => {
  const buffer = new RingBuffer();
  const bigChunk = Buffer.alloc(200 * 1024, 0x62);
  buffer.push(bigChunk); // trimmed down to the 128KB limit
  const trimmed = buffer.tail();
  // An offset older than the retained window replays the full tail.
  assert.deepEqual(buffer.from(0), trimmed);
});

test("base64 helpers round-trip multibyte UTF-8", () => {
  const text = "hello 世界 🌍 \u00e9\u4e2d";
  const encoded = encodeBase64Utf8(text);
  assert.equal(Buffer.from(decodeBase64ToBytes(encoded)).toString("utf8"), text);
});
