import { test } from "node:test";
import assert from "node:assert/strict";
import { createCameraGlance } from "./camera-glance.js";

function make({
  flags = {}, jpeg = Buffer.from([1, 2, 3]), snapshotThrows = false,
  visionResult = "PERSON: yes\nA person sitting at a desk, smiling.", visionThrows = false,
  onVision, agentRunRejects = false, ...opts
} = {}) {
  const f = { autonomy: true, busy: false, held: false, transActive: false, micActive: false, playing: false, ...flags };
  const snaps = [], visions = [], runs = [];
  const deviceRpc = { requestBinary: async (msg, o) => { snaps.push({ msg, o }); if (snapshotThrows) throw new Error("offline"); return jpeg; } };
  const vision = { describe: async (buf, o) => { visions.push({ buf, o }); if (onVision) onVision(f); if (visionThrows) throw new Error("vision down"); return visionResult; } };
  const agent = { busy: () => f.busy, getAutonomy: () => f.autonomy, run: async (input, oo) => { runs.push({ input, opts: oo }); if (agentRunRejects) throw new Error("nope"); return { text: "" }; } };
  const ptt = { isHeld: () => f.held };
  const transcriber = { isActive: () => f.transActive };
  const audioOut = { isPlayingOrTail: () => f.playing };
  const micListener = { isActive: () => f.micActive };
  const calls = [];
  const scheduler = (fn, ms) => { const h = { fn, ms }; calls.push(h); return h; };
  let now = 0;
  const c = createCameraGlance({
    agent, deviceRpc, vision, ptt, transcriber, audioOut, micListener,
    intervalMs: 86400000, checkMs: 1800000, startHour: 0, endHour: 24,
    clock: () => now, scheduler, clear: () => {}, ...opts,
  });
  return { c, calls, snaps, visions, runs, f, setNow: (n) => { now = n; } };
}

test("intervalMs 0 disables: start schedules nothing", () => {
  const { c, calls } = make({ intervalMs: 0 });
  c.start();
  assert.equal(calls.length, 0);
});

test("each tick reschedules the next poll", async () => {
  const { c, calls } = make();
  c.start();
  await calls[0].fn();
  assert.equal(calls.length, 2);
});

test("autonomy off → no snapshot", async () => {
  const { c, calls, snaps } = make({ flags: { autonomy: false } });
  c.start();
  await calls[0].fn();
  assert.equal(snaps.length, 0);
});

for (const flag of ["busy", "held", "transActive", "micActive", "playing"]) {
  test(`skips the tick when ${flag}`, async () => {
    const { c, calls, snaps } = make({ flags: { [flag]: true } });
    c.start();
    await calls[0].fn();
    assert.equal(snaps.length, 0);
  });
}

test("outside 7am–10pm Eastern → no snapshot", async () => {
  const { c, calls, snaps, setNow } = make({ startHour: 7, endHour: 22 });
  setNow(Date.parse("2026-06-13T06:00:00Z")); // 2:00am EDT
  c.start();
  await calls[0].fn();
  assert.equal(snaps.length, 0);
});

test("a visible person → she remarks on what she saw (interactive turn, source 'glance')", async () => {
  const { c, calls, snaps, visions, runs } = make();
  c.start();
  await calls[0].fn();
  assert.deepEqual(snaps[0].msg, { type: "snapshot" });
  assert.deepEqual(snaps[0].o, { expectTag: 0x02 });
  assert.equal(visions.length, 1);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].opts.source, "glance");
  assert.match(runs[0].input, /sitting at a desk/);
  assert.doesNotMatch(runs[0].input, /PERSON:/); // the structured detection tag is stripped from her prompt
});

test("an empty room → she glances but stays silent (no agent turn)", async () => {
  const { c, calls, visions, runs, snaps, setNow } = make({ visionResult: "PERSON: no\nAn empty room with a desk." });
  c.start();
  await calls[0].fn();
  assert.equal(visions.length, 1);     // she did look
  assert.equal(runs.length, 0);        // but said nothing
  // and it still counts as today's glance (rate-limited)
  setNow(60000);
  await calls[calls.length - 1].fn();
  assert.equal(snaps.length, 1);
});

test("snapshot failure (device offline) does NOT burn the daily slot — it retries", async () => {
  const { c, calls, snaps, runs, setNow } = make({ snapshotThrows: true });
  c.start();
  await calls[0].fn();
  assert.equal(snaps.length, 1);
  assert.equal(runs.length, 0);
  setNow(60000);
  await calls[calls.length - 1].fn();
  assert.equal(snaps.length, 2); // retried
});

test("a vision hiccup still counts as the day's glance (no retry spam), and says nothing", async () => {
  const { c, calls, runs, snaps, setNow } = make({ visionThrows: true });
  c.start();
  await calls[0].fn();
  assert.equal(runs.length, 0);
  setNow(60000);
  await calls[calls.length - 1].fn();
  assert.equal(snaps.length, 1); // did not re-snapshot
});

test("a conversation starting during the glance drops the remark", async () => {
  const { c, calls, runs } = make({ onVision: (f) => { f.busy = true; } });
  c.start();
  await calls[0].fn();
  assert.equal(runs.length, 0);
});

test("an agent.run rejection does not escape the tick", async () => {
  const { c, calls } = make({ agentRunRejects: true });
  c.start();
  await calls[0].fn(); // must not throw
});
