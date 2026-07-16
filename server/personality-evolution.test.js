import { test } from "node:test";
import assert from "node:assert/strict";
import { createPersonalityEvolution } from "./personality-evolution.js";

// Fake memory: just the surface the pipeline reads/writes.
function makeMemory({ personality = null, music = [], cards = {} } = {}) {
  const saved = [];
  return {
    saved,
    ready: () => true,
    getPersonality: async () => personality,
    getMusicHistory: async () => music,
    setPersonality: async (text, opts) => { saved.push({ text, opts }); return { version: saved.length }; },
    // collectActivity readers — return whatever the test supplies, else empty.
    listRecentMessages: async () => cards.messages || [],
    recentMemories: async () => cards.memories || [],
    listPersonalityVersions: async () => cards.personality || (personality ? [{ _id: "current", ...personality }] : []),
    recentToolCalls: async () => cards.tools || [],
    recentImages: async () => cards.images || [],
  };
}

// Fake client: returns queued text responses, records the prompts it saw.
function makeClient(texts) {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (args) => {
        calls.push(args);
        const t = texts.shift() ?? "";
        return { content: [{ type: "text", text: t }], stop_reason: "end_turn" };
      },
    },
  };
}

test("skips with no LLM call when nothing has happened since the last update", async () => {
  const memory = makeMemory({ personality: { text: "me", version: 3, updated_at: 1000 } });
  const client = makeClient(["should not be used"]);
  const eng = createPersonalityEvolution({ client, memory, model: "m", tokenLimit: 100, evolveMaxTokens: 200 });
  const r = await eng.evolve();
  assert.deepEqual(r, { skipped: true, reason: "no_activity" });
  assert.equal(client.calls.length, 0);
  assert.equal(memory.saved.length, 0);
});

test("evolves additively and saves with reason 'evolution' when under the limit", async () => {
  const memory = makeMemory({
    personality: { text: "old me", version: 1, updated_at: 0 },
    music: [{ id: "v1", title: "Sapphire", artist: "X", ts: 50 }],
    cards: { memories: [{ _id: "mem1", ts: 40, text: "steve laughed" }] },
  });
  const client = makeClient(["grown personality"]);
  const eng = createPersonalityEvolution({ client, memory, model: "m", tokenLimit: 100, evolveMaxTokens: 200 });
  const r = await eng.evolve();
  assert.equal(r.evolved, true);
  assert.equal(memory.saved.length, 1);
  assert.equal(memory.saved[0].text, "grown personality");
  assert.equal(memory.saved[0].opts.reason, "evolution");
  assert.equal(client.calls.length, 1); // no compression pass needed
  // The evolve prompt carried the current personality + the song + the memory.
  const userText = client.calls[0].messages[0].content;
  assert.match(userText, /old me/);
  assert.match(userText, /Sapphire/);
  assert.match(userText, /steve laughed/);
});

test("compresses in a second pass only when over the token limit", async () => {
  const memory = makeMemory({
    personality: { text: "old", version: 1, updated_at: 0 },
    cards: { memories: [{ _id: "mem1", ts: 40, text: "a thing happened" }] },
  });
  // tokenLimit = 5 tokens ≈ 20 chars. First reply is 40 chars (over) → compress.
  const client = makeClient(["x".repeat(40), "tight"]);
  const eng = createPersonalityEvolution({ client, memory, model: "m", tokenLimit: 5, evolveMaxTokens: 200 });
  const r = await eng.evolve();
  assert.equal(client.calls.length, 2);                  // evolve + compress
  assert.match(client.calls[1].messages[0].content, /too long/i);
  assert.equal(memory.saved[0].text, "tight");
});

test("hard-truncates as a last resort when compression is still over the limit", async () => {
  const memory = makeMemory({
    personality: { text: "old", version: 1, updated_at: 0 },
    cards: { memories: [{ _id: "mem1", ts: 40, text: "a thing happened" }] },
  });
  const client = makeClient(["x".repeat(40), "y".repeat(40)]); // both over a 5-token (20-char) cap
  const eng = createPersonalityEvolution({ client, memory, model: "m", tokenLimit: 5, evolveMaxTokens: 200 });
  await eng.evolve();
  // charBudget = tokenLimit*4 = 20; truncated to 19 chars + ellipsis.
  assert.ok(memory.saved[0].text.length <= 20);
  assert.ok(memory.saved[0].text.endsWith("…"));
});

test("skips when the db is not ready", async () => {
  const memory = makeMemory();
  memory.ready = () => false;
  const client = makeClient(["nope"]);
  const eng = createPersonalityEvolution({ client, memory, model: "m", tokenLimit: 100, evolveMaxTokens: 200 });
  assert.deepEqual(await eng.evolve(), { skipped: true, reason: "db_unavailable" });
  assert.equal(client.calls.length, 0);
});

test("skips (does not save) when the model returns an empty response", async () => {
  const memory = makeMemory({
    personality: { text: "old", version: 1, updated_at: 0 },
    cards: { memories: [{ _id: "mem1", ts: 40, text: "a thing happened" }] },
  });
  const client = makeClient([""]);   // Pass 1 yields empty text
  const eng = createPersonalityEvolution({ client, memory, model: "m", tokenLimit: 100, evolveMaxTokens: 200 });
  assert.deepEqual(await eng.evolve(), { skipped: true, reason: "empty" });
  assert.equal(client.calls.length, 1);   // no compression pass
  assert.equal(memory.saved.length, 0);   // nothing persisted
});
