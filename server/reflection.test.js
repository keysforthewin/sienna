import { test } from "node:test";
import assert from "node:assert/strict";
import { createReflection, REFLECTION_PROMPT } from "./reflection.js";

function makeAgent({ busy = false } = {}) {
  const runs = [];
  return { runs, busy: () => busy, run: async (input, opts) => { runs.push({ input, opts }); return { text: "" }; } };
}
function makeScheduler() {
  const calls = [];
  let cleared = 0;
  const scheduler = (fn, ms) => { const h = { fn, ms, cleared: false }; calls.push(h); return h; };
  const clear = (h) => { if (h && !h.cleared) { h.cleared = true; cleared++; } };
  return { scheduler, clear, calls, clearedCount: () => cleared };
}

test("onInteraction schedules one reflection per delay, at the configured offsets", () => {
  const s = makeScheduler();
  const r = createReflection({ agent: makeAgent(), delaysMs: [300000, 7200000, 86400000], scheduler: s.scheduler, clear: s.clear });
  r.start();
  r.onInteraction();
  assert.deepEqual(s.calls.map((c) => c.ms), [300000, 7200000, 86400000]);
});

test("a fired reflection runs the agent with source 'reflection'", () => {
  const s = makeScheduler();
  const agent = makeAgent();
  const r = createReflection({ agent, delaysMs: [300000], scheduler: s.scheduler, clear: s.clear });
  r.start();
  r.onInteraction();
  s.calls[0].fn();
  assert.equal(agent.runs.length, 1);
  assert.equal(agent.runs[0].input, REFLECTION_PROMPT);
  assert.equal(agent.runs[0].opts.source, "reflection");
});

test("a reflection that fires while she's busy is skipped (the conversation reschedules)", () => {
  const s = makeScheduler();
  const agent = makeAgent({ busy: true });
  const r = createReflection({ agent, delaysMs: [300000], scheduler: s.scheduler, clear: s.clear });
  r.start();
  r.onInteraction();
  s.calls[0].fn();
  assert.equal(agent.runs.length, 0);
});

test("a new interaction cancels still-pending reflections and starts a fresh sequence", () => {
  const s = makeScheduler();
  const r = createReflection({ agent: makeAgent(), delaysMs: [300000, 7200000, 86400000], scheduler: s.scheduler, clear: s.clear });
  r.start();
  r.onInteraction();                 // sequence 1: +5m, +2h, +24h
  const seq1 = s.calls.slice(0, 3);
  seq1[0].fn();                      // the +5m one fires
  r.onInteraction();                 // fresh interaction
  assert.equal(seq1[1].cleared, true);  // the pending +2h is canceled
  assert.equal(seq1[2].cleared, true);  // the pending +24h is canceled
  assert.equal(s.calls.length, 6);      // a fresh sequence of 3
  assert.deepEqual(s.calls.slice(3).map((c) => c.ms), [300000, 7200000, 86400000]);
});

test("empty delays schedule nothing (reflection disabled)", () => {
  const s = makeScheduler();
  const r = createReflection({ agent: makeAgent(), delaysMs: [], scheduler: s.scheduler, clear: s.clear });
  r.start();
  r.onInteraction();
  assert.equal(s.calls.length, 0);
});

test("onInteraction before start does nothing", () => {
  const s = makeScheduler();
  const r = createReflection({ agent: makeAgent(), delaysMs: [300000], scheduler: s.scheduler, clear: s.clear });
  r.onInteraction();
  assert.equal(s.calls.length, 0);
});

test("stop cancels pending reflections", () => {
  const s = makeScheduler();
  const r = createReflection({ agent: makeAgent(), delaysMs: [300000, 7200000], scheduler: s.scheduler, clear: s.clear });
  r.start();
  r.onInteraction();
  r.stop();
  assert.equal(s.clearedCount(), 2);
});

test("reflection prompt invites her to listen and to start a conversation when she has something to say", () => {
  assert.match(REFLECTION_PROMPT, /listen to the room/);
  assert.match(REFLECTION_PROMPT, /start a conversation/);
});

test("reflection prompt invites her to set her lights to her mood", () => {
  assert.match(REFLECTION_PROMPT, /necklace/);
  assert.match(REFLECTION_PROMPT, /blue light/);
  assert.match(REFLECTION_PROMPT, /bindi/);
});

test("a fired reflection evolves the personality after the run completes", async () => {
  const s = makeScheduler();
  const order = [];
  const agent = {
    busy: () => false,
    run: async () => { order.push("run"); return { text: "" }; },
    evolvePersonality: async () => { order.push("evolve"); },
  };
  const r = createReflection({ agent, delaysMs: [300000], scheduler: s.scheduler, clear: s.clear });
  r.start();
  r.onInteraction();
  s.calls[0].fn();
  await new Promise((res) => setImmediate(res));   // let the .then chain settle
  assert.deepEqual(order, ["run", "evolve"]);
});

test("a busy tick neither runs nor evolves", async () => {
  const s = makeScheduler();
  let evolved = 0;
  const agent = { busy: () => true, run: async () => ({}), evolvePersonality: async () => { evolved++; } };
  const r = createReflection({ agent, delaysMs: [300000], scheduler: s.scheduler, clear: s.clear });
  r.start();
  r.onInteraction();
  s.calls[0].fn();
  await new Promise((res) => setImmediate(res));
  assert.equal(evolved, 0);
});
