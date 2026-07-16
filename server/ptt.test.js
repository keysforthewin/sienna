import { test } from "node:test";
import assert from "node:assert/strict";
import { createPttCoordinator } from "./ptt.js";

// Deterministic timer harness: timers are held until fired by their delay.
function makeTimers() {
  let nextId = 0;
  const timers = new Map();
  return {
    scheduler: (fn, ms) => { const h = { id: ++nextId, fn, ms, unref() {} }; timers.set(h.id, h); return h; },
    clear: (h) => { if (h) timers.delete(h.id); },
    // Fire the (single) pending timer with this delay; throws if absent.
    fire(ms) {
      const hit = [...timers.values()].find((t) => t.ms === ms);
      assert.ok(hit, `no pending timer with ms=${ms} (pending: ${[...timers.values()].map((t) => t.ms)})`);
      timers.delete(hit.id);
      hit.fn();
    },
    has: (ms) => [...timers.values()].some((t) => t.ms === ms),
    count: () => timers.size,
  };
}

function makeTranscriber({ startWorks = true, commitWorks = true } = {}) {
  const calls = { start: 0, stop: 0, commitNow: 0 };
  let active = false;
  return {
    calls,
    setActive(v) { active = v; },
    isActive: () => active,
    start() { calls.start++; if (startWorks) active = true; },
    stop() { calls.stop++; active = false; },
    commitNow() { calls.commitNow++; return commitWorks && active; },
  };
}

const GRACE = 300, COMMIT = 2000, HOLD = 60000;

function build(overrides = {}) {
  const timers = makeTimers();
  const transcriber = overrides.transcriber || makeTranscriber();
  const runs = [];
  const beeps = [];
  const listenBeeps = [];
  const gate = [];                       // ordered "mute"/"unmute" calls on the transmit gate
  const order = [];                      // interleaved "beep"/"run" — proves the commit beep precedes the LLM call
  const ptt = createPttCoordinator({
    transcriber,
    runAgent: (text, source) => { order.push("run"); runs.push({ text, source }); return Promise.resolve(); },
    mute: () => gate.push("mute"),
    unmute: () => gate.push("unmute"),
    isSpeakerAudible: overrides.isSpeakerAudible || (() => false),
    onListenStart: () => listenBeeps.push(1),
    onRouted: () => { order.push("beep"); beeps.push(1); },
    maxHoldMs: HOLD, releaseGraceMs: GRACE, commitTimeoutMs: COMMIT,
    scheduler: timers.scheduler, clear: timers.clear,
  });
  return { ptt, timers, transcriber, runs, beeps, listenBeeps, gate, order };
}

function unmutes(gate) { return gate.filter((g) => g === "unmute").length; }

test("press while idle opens the mic — listen beep fires", () => {
  const { ptt, transcriber, listenBeeps } = build();
  ptt.onButton(true);
  assert.equal(transcriber.calls.start, 1);
  assert.equal(listenBeeps.length, 1);
  assert.equal(ptt.isHeld(), true);
});

test("press mutes the transmit gate; nothing is stopped", () => {
  const { ptt, gate } = build();
  ptt.onButton(true);
  assert.deepEqual(gate, ["mute"]);      // mute only — no unmute, no other gate calls
});

test("finalize unmutes: full press→speech→release cycle ends unmuted", () => {
  const { ptt, timers, gate } = build();
  ptt.onButton(true);
  ptt.onUtterance("turn the lights red");
  ptt.onCommitObserved();
  ptt.onButton(false);
  assert.equal(unmutes(gate), 0, "raw release must NOT unmute");
  timers.fire(GRACE);                    // forced commit goes out
  assert.equal(unmutes(gate), 0, "still muted through the grace + forced commit");
  ptt.onUtterance("please");
  ptt.onCommitObserved();                // commit lands → finalize
  assert.equal(unmutes(gate), 1, "exactly one unmute, at finalize");
  assert.equal(gate[gate.length - 1], "unmute");
});

test("release with no active hold still unmutes (transcriber didn't start)", () => {
  const transcriber = makeTranscriber({ startWorks: false });
  const { ptt, gate } = build({ transcriber });
  ptt.onButton(true);                    // mutes; hold never establishes
  assert.equal(ptt.isHeld(), false);
  ptt.onButton(false);
  assert.deepEqual(gate, ["mute", "unmute"]);
});

test("endNow and cancel both unmute", () => {
  const a = build();
  a.ptt.onButton(true);
  a.ptt.endNow();
  assert.equal(a.gate[a.gate.length - 1], "unmute");

  const b = build();
  b.ptt.onButton(true);
  b.ptt.cancel();
  assert.equal(b.gate[b.gate.length - 1], "unmute");
});

test("max-hold auto-finalize unmutes", () => {
  const { ptt, timers, gate } = build();
  ptt.onButton(true);
  ptt.onUtterance("are you there");
  timers.fire(HOLD);                     // lost release → auto-finalize path
  timers.fire(GRACE);
  ptt.onCommitObserved();
  assert.equal(unmutes(gate), 1);
  assert.equal(gate[gate.length - 1], "unmute");
});

test("physical release arriving after max-hold auto-finalize does NOT unmute early", () => {
  const { ptt, timers, gate, runs } = build();
  ptt.onButton(true);
  ptt.onUtterance("are you there");
  timers.fire(HOLD);                     // cap auto-finalizes → state "finalizing"
  ptt.onButton(false);                   // the real release edge lands during the grace window
  assert.equal(unmutes(gate), 0, "no unmute while finalizing — trailing frames are still committing");
  timers.fire(GRACE);                    // forced commit goes out
  assert.equal(unmutes(gate), 0, "still muted through the forced commit");
  ptt.onCommitObserved();                // commit lands → finalize
  assert.equal(unmutes(gate), 1, "exactly one unmute, at finalize");
  assert.equal(gate[gate.length - 1], "unmute");
  assert.deepEqual(runs, [{ text: "are you there", source: "ptt" }]);
});

test("re-press during finalizing keeps the gate muted (no unmute until the eventual finalize)", () => {
  const { ptt, timers, gate } = build();
  ptt.onButton(true);
  ptt.onUtterance("first half");
  ptt.onButton(false);
  ptt.onButton(true);                    // re-press before the grace fired
  assert.equal(unmutes(gate), 0, "still muted across release + re-press");
  ptt.onUtterance("second half");
  ptt.onButton(false);
  timers.fire(GRACE);
  ptt.onCommitObserved();                // eventual finalize
  assert.equal(unmutes(gate), 1, "exactly one unmute at the end");
  assert.equal(gate[gate.length - 1], "unmute");
});

test("listen beep rides the press edge — fires even if Scribe can't start; not on a re-press resume", () => {
  // The cue now means "you pressed", not "mic ready": scribe.js catches up any
  // audio spoken before the socket opens, so the beep no longer waits on (or
  // depends on) transcriber.start() succeeding.
  const dead = makeTranscriber({ startWorks: false });
  const a = build({ transcriber: dead });
  a.ptt.onButton(true);
  assert.equal(a.listenBeeps.length, 1, "a fresh press always cues immediately");

  const b = build();
  b.ptt.onButton(true);
  b.ptt.onButton(false);
  b.ptt.onButton(true);          // re-press during finalizing resumes the SAME hold
  assert.equal(b.listenBeeps.length, 1, "one cue per fresh hold — a re-press resume is silent");
});

test("a manual Speech-panel session is never hijacked — and that ignored press does NOT beep", () => {
  const transcriber = makeTranscriber();
  transcriber.setActive(true);           // the panel already owns the session
  const { ptt, listenBeeps } = build({ transcriber });
  ptt.onButton(true);
  assert.equal(listenBeeps.length, 0, "an ignored press is silent");
});

test("the commit beep fires immediately BEFORE the agent/LLM call", () => {
  const { ptt, timers, order } = build();
  ptt.onButton(true);
  ptt.onUtterance("what's the weather");
  ptt.onButton(false);
  timers.fire(GRACE);
  ptt.onCommitObserved();                // commit lands → finalize → beep then run
  assert.deepEqual(order, ["beep", "run"], "she chirps 'heard you' the instant before routing");
});

test("press while she is speaking silences her (mute), then opens the mic", () => {
  const { ptt, transcriber, gate } = build();
  ptt.onButton(true);
  assert.deepEqual(gate, ["mute"]);      // mute is unconditional — covers an audible speaker
  assert.equal(transcriber.calls.start, 1);
  assert.equal(ptt.isHeld(), true);
});

test("mute still runs when the transcriber can't start (no Scribe)", () => {
  const transcriber = makeTranscriber({ startWorks: false });
  const { ptt, gate } = build({ transcriber });
  ptt.onButton(true);
  assert.deepEqual(gate, ["mute"]);      // a tap always means "stop talking"
  assert.equal(ptt.isHeld(), false);     // stayed idle — nothing to transcribe with
});

test("mid-hold commits accumulate without routing; release joins them into ONE turn", () => {
  const { ptt, timers, transcriber, runs, beeps } = build();
  ptt.onButton(true);
  ptt.onUtterance("turn the");           // ElevenLabs VAD finalized a mid-hold pause
  ptt.onCommitObserved();
  ptt.onUtterance("lights red");
  ptt.onCommitObserved();
  assert.equal(runs.length, 0);
  assert.equal(beeps.length, 0);
  ptt.onButton(false);
  timers.fire(GRACE);                    // grace elapses → forced commit goes out
  assert.equal(transcriber.calls.commitNow, 1);
  ptt.onUtterance("please");             // the forced commit's transcript
  ptt.onCommitObserved();                // …observed → finalize immediately
  assert.deepEqual(runs, [{ text: "turn the lights red please", source: "ptt" }]);
  assert.equal(beeps.length, 1);
  assert.equal(transcriber.calls.stop, 1);
  assert.equal(timers.count(), 0);
});

test("an EMPTY forced-commit answer finalizes immediately (no timeout wait)", () => {
  const { ptt, timers, runs } = build();
  ptt.onButton(true);
  ptt.onUtterance("hello there");
  ptt.onCommitObserved();
  ptt.onButton(false);
  timers.fire(GRACE);
  ptt.onCommitObserved();                // empty commit: onUtterance never fired
  assert.deepEqual(runs, [{ text: "hello there", source: "ptt" }]);
  assert.equal(timers.count(), 0);
});

test("forced commit never answered → commit timeout finalizes with accumulated parts", () => {
  const { ptt, timers, runs } = build();
  ptt.onButton(true);
  ptt.onUtterance("what time is it");
  ptt.onButton(false);
  timers.fire(GRACE);
  timers.fire(COMMIT);
  assert.deepEqual(runs, [{ text: "what time is it", source: "ptt" }]);
});

test("release with no speech routes nothing — no beep, transcriber stopped", () => {
  const { ptt, timers, transcriber, runs, beeps } = build();
  ptt.onButton(true);
  ptt.onButton(false);
  timers.fire(GRACE);
  ptt.onCommitObserved();                // empty commit
  assert.equal(runs.length, 0);
  assert.equal(beeps.length, 0);
  assert.equal(transcriber.calls.stop, 1);
});

test("commitNow failing (session died mid-hold) finalizes immediately with parts", () => {
  const transcriber = makeTranscriber({ commitWorks: false });
  const { ptt, timers, runs } = build({ transcriber });
  ptt.onButton(true);
  ptt.onUtterance("lights off");
  ptt.onButton(false);
  timers.fire(GRACE);
  assert.deepEqual(runs, [{ text: "lights off", source: "ptt" }]);
});

test("stuck button: the max-hold cap auto-finalizes", () => {
  const { ptt, timers, transcriber, runs } = build();
  ptt.onButton(true);
  ptt.onUtterance("are you there");
  timers.fire(HOLD);                     // release event was lost
  timers.fire(GRACE);
  ptt.onCommitObserved();
  assert.deepEqual(runs, [{ text: "are you there", source: "ptt" }]);
  assert.equal(transcriber.calls.stop, 1);
});

test("re-press during finalizing cancels it and resumes the hold (same session)", () => {
  const { ptt, timers, transcriber, runs } = build();
  ptt.onButton(true);
  ptt.onUtterance("first half");
  ptt.onButton(false);
  assert.equal(ptt.isHeld(), false);
  ptt.onButton(true);                    // quick re-press before the grace elapsed
  assert.equal(ptt.isHeld(), true);
  assert.equal(transcriber.calls.start, 1, "no second session");
  assert.equal(timers.has(GRACE), false, "finalization cancelled");
  ptt.onUtterance("second half");
  ptt.onButton(false);
  timers.fire(GRACE);
  ptt.onCommitObserved();
  assert.deepEqual(runs, [{ text: "first half second half", source: "ptt" }]);
});

test("duplicate press while held is a no-op; stray release while idle is a no-op", () => {
  const { ptt, timers, transcriber } = build();
  ptt.onButton(false);                   // stray release (post-disconnect reset / bounce)
  assert.equal(transcriber.calls.start, 0);
  ptt.onButton(true);
  ptt.onButton(true);                    // bounce
  assert.equal(transcriber.calls.start, 1);
  assert.equal(timers.count(), 1);       // exactly one hold timer
});

test("a manual Speech-panel session is never hijacked", () => {
  const transcriber = makeTranscriber();
  transcriber.setActive(true);           // someone else (the panel) owns the session
  const { ptt } = build({ transcriber });
  ptt.onButton(true);
  assert.equal(ptt.isHeld(), false);
  assert.equal(transcriber.calls.start, 0);
  ptt.onButton(false);
  assert.equal(transcriber.calls.stop, 0, "release must not stop the panel's session");
});

test("unowned commits route per-utterance with the beep, except while the speaker is audible", () => {
  let audible = true;
  const { ptt, runs, beeps } = build({ isSpeakerAudible: () => audible });
  ptt.onUtterance("her own echo");       // unowned + audible → dropped
  assert.equal(runs.length, 0);
  audible = false;
  ptt.onUtterance("real panel speech");
  assert.deepEqual(runs, [{ text: "real panel speech", source: "ptt" }]);
  assert.equal(beeps.length, 1);
});

test("endNow aborts the session without routing", () => {
  const { ptt, timers, transcriber, runs } = build();
  ptt.onButton(true);
  ptt.onUtterance("never mind all this");
  ptt.endNow();
  assert.equal(runs.length, 0);
  assert.equal(transcriber.calls.stop, 1);
  assert.equal(timers.count(), 0);
  assert.equal(ptt.isHeld(), false);
});

test("cancel (device disconnect) clears state WITHOUT stopping the transcriber", () => {
  const { ptt, timers, transcriber, runs } = build();
  ptt.onButton(true);
  ptt.onUtterance("half an utter");
  ptt.cancel();
  assert.equal(transcriber.calls.stop, 0, "index.js already tears the transcriber down");
  assert.equal(timers.count(), 0);
  ptt.onButton(false);                   // the device's release never arrives / is stale
  assert.equal(runs.length, 0);
  // a fresh press later starts a brand-new session
  transcriber.setActive(false);
  ptt.onButton(true);
  assert.equal(ptt.isHeld(), true);
  assert.equal(transcriber.calls.start, 2);
});

test("stale ownership reconciles: session died underneath us, next press re-acquires", () => {
  const transcriber = makeTranscriber();
  const { ptt, timers } = build({ transcriber });
  ptt.onButton(true);
  transcriber.setActive(false);          // Scribe onError/onClose killed it mid-hold
  ptt.onButton(false);
  timers.fire(GRACE);                    // commitNow returns false → immediate finalize
  ptt.onButton(true);
  assert.equal(ptt.isHeld(), true);
  assert.equal(transcriber.calls.start, 2);
});
