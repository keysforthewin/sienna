import { test } from "node:test";
import assert from "node:assert/strict";
import { createMusicSuggester, parseQueries } from "./music-suggest.js";

const clientReplying = (text, calls = []) => ({
  messages: {
    create: async (req) => { calls.push(req); return { content: [{ type: "text", text }] }; },
  },
});

test("parses a clean JSON array, trimming and deduping", () => {
  const out = parseQueries('["jazz piano", " jazz piano ", "bossa nova", "", 42, "Jazz Piano"]', { count: 10 });
  assert.deepEqual(out, ["jazz piano", "bossa nova"]);
});

test("strips prose and markdown fences around the array", () => {
  const out = parseQueries('Sure! Here you go:\n```json\n["a", "b"]\n```\nEnjoy!', { count: 10 });
  assert.deepEqual(out, ["a", "b"]);
});

test("excludes the original query and caps at count", () => {
  const out = parseQueries('["Indian Music", "bhangra", "bollywood", "sitar"]', { count: 2, exclude: "indian  music" });
  assert.deepEqual(out, ["bhangra", "bollywood"]);
});

test("returns [] on garbage instead of throwing", () => {
  assert.deepEqual(parseQueries("no array here", { count: 10 }), []);
  assert.deepEqual(parseQueries('{"not": "an array"}', { count: 10 }), []);
  assert.deepEqual(parseQueries("[unclosed", { count: 10 }), []);
});

test("suggester sends the query to the model and returns the parsed list", async () => {
  const calls = [];
  const suggest = createMusicSuggester({ client: clientReplying('["bhangra hits", "bollywood classics"]', calls), count: 10 });
  const out = await suggest("indian music");
  assert.deepEqual(out, ["bhangra hits", "bollywood classics"]);
  assert.equal(calls[0].messages[0].content, "indian music");
  assert.match(calls[0].system, /10 DIFFERENT search queries/);
});

test("an unparseable model reply yields [] (caller falls back to static variants)", async () => {
  const suggest = createMusicSuggester({ client: clientReplying("I cannot help with that.") });
  assert.deepEqual(await suggest("x"), []);
});

test("client errors propagate to the caller", async () => {
  const client = { messages: { create: async () => { throw new Error("rate limited"); } } };
  const suggest = createMusicSuggester({ client });
  await assert.rejects(() => suggest("x"), /rate limited/);
});
