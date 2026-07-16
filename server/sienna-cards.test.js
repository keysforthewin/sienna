import { test } from "node:test";
import assert from "node:assert/strict";
import { toCard, mergeActivity } from "./sienna-cards.js";

const T = new Date("2026-01-01T00:00:00Z");

test("toCard(message) maps role/content/source/spoken and ts from Date", () => {
  const c = toCard("message", { _id: "m1", ts: T, role: "assistant", content: "hi there", source: "ptt", spoken: true });
  assert.equal(c.kind, "message");
  assert.equal(c.id, "m1");
  assert.equal(c.ts, T.getTime());
  assert.equal(c.role, "assistant");
  assert.equal(c.content, "hi there");
  assert.equal(c.source, "ptt");
  assert.equal(c.spoken, true);
});

test("toCard(memory) maps text->content, tags, source, ts", () => {
  const c = toCard("memory", { _id: "x1", ts: T, text: "steve likes coffee", tags: ["coffee"], source: "remember" });
  assert.equal(c.kind, "memory");
  assert.equal(c.id, "x1");
  assert.equal(c.content, "steve likes coffee");
  assert.deepEqual(c.tags, ["coffee"]);
  assert.equal(c.source, "remember");
  assert.equal(c.ts, T.getTime());
});

test("toCard(memory) defaults tags to [] when missing", () => {
  const c = toCard("memory", { _id: "x2", ts: T, text: "fact" });
  assert.deepEqual(c.tags, []);
});

test("toCard(personality) current uses updated_at and is flagged current", () => {
  const c = toCard("personality", { _id: "current", text: "I am Sienna", version: 3, updated_at: T, char_count: 11 });
  assert.equal(c.kind, "personality");
  assert.equal(c.id, "current");
  assert.equal(c.ts, T.getTime());
  assert.equal(c.content, "I am Sienna");
  assert.equal(c.version, 3);
  assert.equal(c.current, true);
});

test("toCard(personality) history uses replaced_at, carries reason, not current", () => {
  const c = toCard("personality", { _id: "h1", text: "older me", version: 2, replaced_at: T, reason: "reflection" });
  assert.equal(c.ts, T.getTime());
  assert.equal(c.version, 2);
  assert.equal(c.reason, "reflection");
  assert.equal(c.current, false);
});

test("toCard normalizes a numeric ts and an ISO-string ts", () => {
  assert.equal(toCard("message", { _id: "a", ts: 1700000000000, role: "user", content: "x" }).ts, 1700000000000);
  assert.equal(toCard("message", { _id: "b", ts: "2026-01-01T00:00:00Z", role: "user", content: "x" }).ts, T.getTime());
});

test("toCard yields null ts for missing/invalid timestamps", () => {
  assert.equal(toCard("memory", { _id: "a", text: "x" }).ts, null);
  assert.equal(toCard("memory", { _id: "b", text: "x", ts: "not-a-date" }).ts, null);
});

test("toCard stringifies non-string ids", () => {
  assert.equal(toCard("memory", { _id: { toString: () => "objid" }, text: "x" }).id, "objid");
});

test("toCard(tool) keys the id on tool_id, stringifies input, carries summary/error", () => {
  const c = toCard("tool", {
    _id: "doc1", tool_id: "tu_42", ts: T, name: "set_rgb",
    input: { r: 255, g: 0, b: 0 }, summary: "rgb set", is_error: false, source: "ptt",
  });
  assert.equal(c.kind, "tool");
  assert.equal(c.id, "tool-tu_42");        // keyed on tool-use id, not the Mongo _id
  assert.equal(c.ts, T.getTime());
  assert.equal(c.name, "set_rgb");
  assert.equal(c.content, JSON.stringify({ r: 255, g: 0, b: 0 }));
  assert.equal(c.summary, "rgb set");
  assert.equal(c.is_error, false);
  assert.equal(c.source, "ptt");
});

test("toCard(tool) empty input → empty content; error flag coerced", () => {
  const c = toCard("tool", { _id: "d2", tool_id: "tu_9", ts: T, name: "read_light_sensor", input: {}, is_error: 1 });
  assert.equal(c.content, "");
  assert.equal(c.is_error, true);
});

test("mergeActivity flattens, sorts newest-first, and respects limit", () => {
  const messages = [{ kind: "message", id: "m2", ts: 200 }, { kind: "message", id: "m1", ts: 100 }];
  const memories = [{ kind: "memory", id: "x1", ts: 150 }];
  const merged = mergeActivity([messages, memories], 2);
  assert.deepEqual(merged.map((c) => c.id), ["m2", "x1"]);
});

test("mergeActivity breaks ts ties by id descending (stable across re-fetches)", () => {
  const a = [{ kind: "message", id: "aaa", ts: 100 }];
  const b = [{ kind: "memory", id: "ccc", ts: 100 }, { kind: "memory", id: "bbb", ts: 100 }];
  const merged = mergeActivity([a, b]);
  assert.deepEqual(merged.map((c) => c.id), ["ccc", "bbb", "aaa"]);
});

test("mergeActivity sorts null-ts cards last", () => {
  const merged = mergeActivity([[{ kind: "memory", id: "z", ts: null }, { kind: "message", id: "y", ts: 5 }]]);
  assert.deepEqual(merged.map((c) => c.id), ["y", "z"]);
});

test("toCard(image) maps filename + source, ts from Date", () => {
  const c = toCard("image", { _id: "img1", ts: T, filename: "2026-c.jpg", source: "camera" });
  assert.equal(c.kind, "image");
  assert.equal(c.id, "img1");
  assert.equal(c.ts, T.getTime());
  assert.equal(c.filename, "2026-c.jpg");
  assert.equal(c.source, "camera");
});

test("toCard(image) tolerates a missing filename/source", () => {
  const c = toCard("image", { _id: "img2", ts: T });
  assert.equal(c.filename, null);
  assert.equal(c.source, null);
});
