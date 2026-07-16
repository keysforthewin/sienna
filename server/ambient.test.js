import { test } from "node:test";
import assert from "node:assert/strict";
import { createAmbientTrigger } from "./ambient.js";

function harness({ checkMs = 1000, minIntervalMs = 100 } = {}) {
  const calls = [];
  const scheduler = (fn, ms) => { const h = { fn, ms }; calls.push(h); return h; };
  let now = 0;
  const state = { within: true, gate: true, acted: true, runs: 0, throwOnRun: false };
  const t = createAmbientTrigger({
    checkMs, minIntervalMs,
    withinHours: () => state.within,
    gate: () => state.gate,
    run: async () => { state.runs++; if (state.throwOnRun) throw new Error("boom"); return state.acted; },
    clock: () => now, scheduler, clear: () => {},
  });
  const last = () => calls[calls.length - 1];
  return { t, calls, state, last, setNow: (n) => { now = n; } };
}

test("checkMs 0 disables: start schedules nothing", () => {
  const { t, calls } = harness({ checkMs: 0 });
  t.start();
  assert.equal(calls.length, 0);
});

test("each tick reschedules (steady cadence) even when gated off", async () => {
  const { t, calls, state } = harness();
  state.gate = false;
  t.start();
  assert.equal(calls.length, 1);
  await calls[0].fn();
  assert.equal(calls.length, 2);   // rescheduled
  assert.equal(state.runs, 0);     // but did not run
});

test("runs when the window is open, gate passes, and the interval has elapsed", async () => {
  const { t, calls, state } = harness();
  t.start();
  await calls[0].fn();
  assert.equal(state.runs, 1);
});

test("a completed run resets the daily clock (min-interval suppresses the next)", async () => {
  const { t, calls, state, last, setNow } = harness({ minIntervalMs: 100 });
  t.start();
  await calls[0].fn();             // runs at now=0, lastAt=0
  assert.equal(state.runs, 1);
  setNow(50);                      // < minInterval
  await last().fn();
  assert.equal(state.runs, 1);     // suppressed
  setNow(150);                     // >= minInterval
  await last().fn();
  assert.equal(state.runs, 2);     // runs again
});

test("skips when outside the active-hours window", async () => {
  const { t, calls, state } = harness();
  state.within = false;
  t.start();
  await calls[0].fn();
  assert.equal(state.runs, 0);
});

test("a falsy run() (didn't act) does NOT burn the daily clock, so it retries", async () => {
  const { t, calls, state, last, setNow } = harness({ minIntervalMs: 100000 });
  state.acted = false;
  t.start();
  await calls[0].fn();             // run() returns false
  assert.equal(state.runs, 1);
  setNow(10);                      // far inside minInterval, but last attempt didn't act
  await last().fn();
  assert.equal(state.runs, 2);     // retried
});

test("a throwing run() is swallowed and does not wedge the in-flight guard", async () => {
  const { t, calls, state, last } = harness();
  state.throwOnRun = true;
  t.start();
  await calls[0].fn();
  assert.equal(state.runs, 1);
  state.throwOnRun = false;
  await last().fn();
  assert.equal(state.runs, 2);     // not wedged
});

test("overlapping ticks do not double-run (re-entrancy guard)", async () => {
  let release; const held = new Promise((r) => { release = r; });
  let runs = 0, now = 0;
  const calls = [];
  const t = createAmbientTrigger({
    checkMs: 1000, minIntervalMs: 0,
    withinHours: () => true, gate: () => true,
    run: async () => { runs++; await held; return true; },
    clock: () => now, scheduler: (fn, ms) => { const h = { fn, ms }; calls.push(h); return h; }, clear: () => {},
  });
  t.start();
  const p1 = calls[0].fn();                 // enters run(), awaits held
  await calls[calls.length - 1].fn();       // second tick while first is in flight → guarded
  assert.equal(runs, 1);
  release();
  await p1;
});
