import { test } from "node:test";
import assert from "node:assert/strict";
import { createCommitBeep } from "./commitBeep.js";

test("fires once, scaling amplitude by the master volume and clamping to 1", () => {
  const calls = [];
  const volume = { getPercent: () => 200 };   // 2.0× — the default boost
  const b = createCommitBeep({
    playTone: (a) => calls.push(a), volume,
    hz: 880, durationMs: 200, amplitude: 0.5, cooldownMs: 0, clock: () => 0,
  });
  b.trigger();
  assert.equal(calls.length, 1);
  // 0.5 * 2.0 = 1.0 (the rail) — not 2.0, which PlayToneCmd would reject.
  assert.deepEqual(calls[0], { hz: 880, durationMs: 200, amplitude: 1 });
});

test("clamps amplitude at 1 even at high volume", () => {
  const calls = [];
  const volume = { getPercent: () => 400 };
  const b = createCommitBeep({ playTone: (a) => calls.push(a), volume, amplitude: 0.5, cooldownMs: 0, clock: () => 0 });
  b.trigger();
  assert.equal(calls[0].amplitude, 1);   // 0.5 * 4.0 = 2.0 → clamped
});

test("no volume injected ⇒ amplitude passes through unscaled", () => {
  const calls = [];
  const b = createCommitBeep({ playTone: (a) => calls.push(a), amplitude: 0.4, cooldownMs: 0, clock: () => 0 });
  b.trigger();
  assert.equal(calls[0].amplitude, 0.4);
});

test("hz2 plays a second tone right after the first (a rising chirp), same dur+amp", () => {
  const calls = [];
  const b = createCommitBeep({
    playTone: (a) => calls.push(a),
    hz: 1440, hz2: 1540, durationMs: 50, amplitude: 0.25, cooldownMs: 0, clock: () => 0,
  });
  b.trigger();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { hz: 1440, durationMs: 50, amplitude: 0.25 });
  assert.deepEqual(calls[1], { hz: 1540, durationMs: 50, amplitude: 0.25 });
});

test("hz2=0 (the default) keeps it a single tone", () => {
  const calls = [];
  const b = createCommitBeep({ playTone: (a) => calls.push(a), hz: 80, durationMs: 50, amplitude: 1, cooldownMs: 0, clock: () => 0 });
  b.trigger();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].hz, 80);
});

test("cooldown suppresses a second beep within the window", () => {
  const calls = [];
  let t = 0;
  const b = createCommitBeep({ playTone: (a) => calls.push(a), cooldownMs: 600, clock: () => t });
  b.trigger(); assert.equal(calls.length, 1);
  t = 300; b.trigger(); assert.equal(calls.length, 1);   // within cooldown ⇒ suppressed
  t = 700; b.trigger(); assert.equal(calls.length, 2);   // past cooldown ⇒ fires
});

test("does not beep while she is speaking (barge-in: keep it out of her TTS)", () => {
  const calls = [];
  let speaking = true;
  const b = createCommitBeep({
    playTone: (a) => calls.push(a), isSpeaking: () => speaking, cooldownMs: 0, clock: () => 0,
  });
  b.trigger(); assert.equal(calls.length, 0);            // suppressed while speaking
  speaking = false;
  b.trigger(); assert.equal(calls.length, 1);            // and not stuck on cooldown after
});

test("disabled: never beeps", () => {
  const calls = [];
  const b = createCommitBeep({ playTone: (a) => calls.push(a), enabled: false, cooldownMs: 0, clock: () => 0 });
  b.trigger();
  assert.equal(calls.length, 0);
});

test("swallows a throwing playTone so it can never break STT routing", () => {
  const b = createCommitBeep({ playTone: () => { throw new Error("boom"); }, cooldownMs: 0, clock: () => 0 });
  assert.doesNotThrow(() => b.trigger());
});
