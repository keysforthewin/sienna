import { test } from "node:test";
import assert from "node:assert/strict";
import { createEavesdrop } from "./eavesdrop.js";

function make({ flags = {}, listenResult, onListen, agentRunRejects = false, ...opts } = {}) {
  const f = { autonomy: true, busy: false, held: false, transActive: false, micActive: false, playing: false, ...flags };
  const listens = [];
  const runs = [];
  const micListener = {
    listen: async (args) => { listens.push(args); if (onListen) onListen(f); return listenResult ?? { ok: true, heardSpeech: true, transcript: "hi there" }; },
    isActive: () => f.micActive,
  };
  const agent = {
    busy: () => f.busy, getAutonomy: () => f.autonomy,
    run: async (input, o) => { runs.push({ input, opts: o }); if (agentRunRejects) throw new Error("nope"); return { text: "" }; },
  };
  const ptt = { isHeld: () => f.held };
  const transcriber = { isActive: () => f.transActive };
  const audioOut = { isPlayingOrTail: () => f.playing };
  const calls = [];
  const scheduler = (fn, ms) => { const h = { fn, ms }; calls.push(h); return h; };
  let now = 0;
  const e = createEavesdrop({
    agent, micListener, transcriber, ptt, audioOut,
    intervalMs: 86400000, checkMs: 1800000, seconds: 60,
    startHour: 0, endHour: 24,           // default window always-open (non-window tests are time-agnostic)
    clock: () => now, scheduler, clear: () => {},
    ...opts,
  });
  return { e, calls, listens, runs, f, setNow: (n) => { now = n; } };
}

test("intervalMs 0 disables: start schedules nothing", () => {
  const { e, calls } = make({ intervalMs: 0 });
  e.start();
  assert.equal(calls.length, 0);
});

test("each tick reschedules the next poll", async () => {
  const { e, calls } = make();
  e.start();
  assert.equal(calls.length, 1);
  await calls[0].fn();
  assert.equal(calls.length, 2);
});

test("autonomy off → no listen", async () => {
  const { e, calls, listens } = make({ flags: { autonomy: false } });
  e.start();
  await calls[0].fn();
  assert.equal(listens.length, 0);
});

for (const flag of ["busy", "held", "transActive", "micActive", "playing"]) {
  test(`skips the tick when ${flag}`, async () => {
    const { e, calls, listens } = make({ flags: { [flag]: true } });
    e.start();
    await calls[0].fn();
    assert.equal(listens.length, 0);
  });
}

test("outside 7am–10pm Eastern → no listen", async () => {
  const { e, calls, listens, setNow } = make({ startHour: 7, endHour: 22 });
  setNow(Date.parse("2026-06-13T06:00:00Z")); // 2:00am EDT
  e.start();
  await calls[0].fn();
  assert.equal(listens.length, 0);
});

test("inside the window, overheard speech routes one eavesdrop turn over a 60s window", async () => {
  const { e, calls, listens, runs, setNow } = make({ startHour: 7, endHour: 22, seconds: 60 });
  setNow(Date.parse("2026-06-13T16:00:00Z")); // 12:00pm EDT
  e.start();
  await calls[0].fn();
  assert.equal(listens.length, 1);
  assert.deepEqual(listens[0], { seconds: 60, maxSeconds: 60 });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].opts.source, "eavesdrop");
  assert.match(runs[0].input, /overheard/);
});

test("a failed listen (device offline) does NOT burn the daily slot — it retries", async () => {
  const { e, calls, listens, setNow } = make({ listenResult: { ok: false, reason: "device_offline" } });
  e.start();
  await calls[0].fn();
  assert.equal(listens.length, 1);
  setNow(60000); // 1 min later, far inside the day
  await calls[calls.length - 1].fn();
  assert.equal(listens.length, 2); // retried — it never actually listened
});

test("listening and hearing silence still counts as the day's eavesdrop (rate-limited after)", async () => {
  const { e, calls, listens, setNow } = make({ listenResult: { ok: true, heardSpeech: false, transcript: "" } });
  e.start();
  await calls[0].fn();
  assert.equal(listens.length, 1);
  setNow(60000);
  await calls[calls.length - 1].fn();
  assert.equal(listens.length, 1); // did NOT re-listen within the day
});

test("a conversation starting mid-window drops the overheard transcript", async () => {
  const { e, calls, runs } = make({ onListen: (f) => { f.busy = true; } });
  e.start();
  await calls[0].fn();
  assert.equal(runs.length, 0); // routed nothing — a real turn took over
});

test("an agent.run rejection does not escape the tick", async () => {
  const { e, calls } = make({ agentRunRejects: true });
  e.start();
  await calls[0].fn(); // must not throw
});
