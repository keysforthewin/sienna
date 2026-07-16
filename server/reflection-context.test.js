import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectActivity, shuffle, sampleActivity, renderCard, buildReflectionPrompt,
} from "./reflection-context.js";

// A deterministic rng cycling through a fixed sequence in [0,1). Lets us assert
// shuffle/sample are reproducible without depending on Math.random.
function seqRng(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

test("shuffle is deterministic under a fixed rng and doesn't mutate input", () => {
  const input = [1, 2, 3, 4, 5];
  const rng = seqRng([0.1, 0.9, 0.3, 0.7, 0.5]);
  const a = shuffle(input, rng);
  const rng2 = seqRng([0.1, 0.9, 0.3, 0.7, 0.5]);
  const b = shuffle(input, rng2);
  assert.deepEqual(a, b);                       // same rng → same order
  assert.deepEqual(input, [1, 2, 3, 4, 5]);     // input untouched
  assert.deepEqual([...a].sort(), [1, 2, 3, 4, 5]); // a permutation
});

test("sampleActivity respects size and returns at most that many", () => {
  const cards = Array.from({ length: 50 }, (_, i) => ({ kind: "memory", id: String(i), content: `m${i}` }));
  const out = sampleActivity(cards, 20, seqRng([0.5]));
  assert.equal(out.length, 20);
  const small = sampleActivity(cards.slice(0, 3), 20, seqRng([0.5]));
  assert.equal(small.length, 3);                // never more than available
});

test("renderCard formats each kind", () => {
  assert.match(renderCard({ kind: "message", role: "assistant", source: "text", content: "hi" }), /^You said: hi$/);
  assert.match(renderCard({ kind: "message", role: "user", source: "ptt", content: "yo" }), /^Heard \(ptt\): yo$/);
  assert.match(renderCard({ kind: "memory", content: "fact", tags: ["a", "b"] }), /^Remembered: fact \[a, b\]$/);
  assert.match(renderCard({ kind: "personality", version: 3, reason: "reflection", content: "me" }), /^Personality \(v3, reflection\): me$/);
  assert.match(renderCard({ kind: "tool", name: "set_rgb", summary: "rgb set" }), /^Did set_rgb: rgb set$/);
  assert.match(renderCard({ kind: "image" }), /camera/);
});

test("buildReflectionPrompt includes random framing, past reflections, and self-expression", () => {
  const out = buildReflectionPrompt({
    base: "BASE_INSTRUCTION",
    sample: [
      { kind: "memory", id: "1", content: "liked the rain" },
      { kind: "message", id: "2", role: "assistant", source: "reflection", content: "felt calm" },
    ],
    pastReflections: [{ content: "I reflected on calm yesterday" }],
    rng: seqRng([0.5, 0.2, 0.8]),
  });
  assert.match(out, /BASE_INSTRUCTION/);
  assert.match(out, /random, shuffled/i);
  assert.match(out, /liked the rain/);
  assert.match(out, /recently reflected on/i);
  assert.match(out, /I reflected on calm yesterday/);
  // self-expression invitation: lights / bindi / voice
  assert.match(out, /bindi|RGB|blue light|white body lights/i);
  assert.match(out, /your own voice/i);
});

test("buildReflectionPrompt with no sample/past still returns base + invitation", () => {
  const out = buildReflectionPrompt({ base: "BASE" });
  assert.match(out, /^BASE/);
  assert.match(out, /bindi/i);
  assert.doesNotMatch(out, /random, shuffled/i);
  assert.doesNotMatch(out, /recently reflected on/i);
});

test("collectActivity merges all kinds newest-first via toCard", async () => {
  const memory = {
    listRecentMessages: async () => [{ _id: "m1", ts: 100, role: "user", content: "hi" }],
    recentMemories: async () => [{ _id: "mem1", ts: 300, text: "fact" }],
    listPersonalityVersions: async () => [{ _id: "current", updated_at: 200, text: "me", version: 2 }],
    recentToolCalls: async () => [{ _id: "t1", tool_id: "tu1", ts: 400, name: "look", summary: "saw a room" }],
    recentImages: async () => [{ _id: "i1", ts: 50, filename: "a.jpg" }],
  };
  const cards = await collectActivity({ memory, limit: 100 });
  assert.equal(cards.length, 5);
  // newest-first: tool(400) > memory(300) > personality(200) > message(100) > image(50)
  assert.deepEqual(cards.map((c) => c.kind), ["tool", "memory", "personality", "message", "image"]);
});

test("collectActivity with `since` keeps only cards at or after the cutoff", async () => {
  const memory = {
    listRecentMessages: async () => [{ _id: "m1", ts: 100, role: "user", content: "old" }, { _id: "m2", ts: 500, role: "user", content: "new" }],
    recentMemories: async () => [{ _id: "mem1", ts: 300, text: "mid" }],
    listPersonalityVersions: async () => [{ _id: "current", updated_at: 200, text: "me", version: 2 }],
    recentToolCalls: async () => [{ _id: "t1", tool_id: "tu1", ts: 400, name: "look", summary: "saw" }],
    recentImages: async () => [{ _id: "i1", ts: 50, filename: "a.jpg" }],
  };
  const cards = await collectActivity({ memory, limit: 100, since: 300 });
  // ts >= 300: message(500), memory(300), tool(400) — newest-first
  assert.deepEqual(cards.map((c) => c.ts), [500, 400, 300]);
});
