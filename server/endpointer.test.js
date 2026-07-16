import { test } from "node:test";
import assert from "node:assert/strict";
import { createSpeechEndpointer } from "./endpointer.js";

// A controllable clock; mic_rms arrives ~20 Hz (50 ms/frame). Helpers feed a run
// of frames advancing the clock by `stepMs` each.
function makeClock() {
  let t = 0;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

function feedFrames(ep, clock, values, stepMs = 50) {
  for (const v of values) { ep.feed(v); clock.advance(stepMs); }
}

test("fires once after silenceMs of quiet following enough speech", () => {
  const clock = makeClock();
  let fires = 0;
  const ep = createSpeechEndpointer({
    onEndpoint: () => fires++, clock: clock.now,
    speechFactor: 2.5, silenceMs: 800, minSpeechMs: 200,
  });
  ep.feed(100); clock.advance(50);          // seed floor ≈ 100
  feedFrames(ep, clock, Array(10).fill(50)); // quiet → floor settles low
  feedFrames(ep, clock, Array(10).fill(5000)); // ~500 ms of speech (>> floor*2.5)
  assert.equal(fires, 0);                    // still talking
  feedFrames(ep, clock, Array(20).fill(40)); // ~1000 ms quiet → endpoint
  assert.equal(fires, 1);
});

test("a brief blip under minSpeechMs does not fire", () => {
  const clock = makeClock();
  let fires = 0;
  const ep = createSpeechEndpointer({ onEndpoint: () => fires++, clock: clock.now, silenceMs: 800, minSpeechMs: 200 });
  ep.feed(100);
  feedFrames(ep, clock, Array(10).fill(50));
  ep.feed(5000); clock.advance(50);          // single 50 ms voice frame
  feedFrames(ep, clock, Array(20).fill(40)); // long quiet
  assert.equal(fires, 0);
});

test("pure quiet never fires", () => {
  const clock = makeClock();
  let fires = 0;
  const ep = createSpeechEndpointer({ onEndpoint: () => fires++, clock: clock.now });
  feedFrames(ep, clock, Array(40).fill(60));
  assert.equal(fires, 0);
});

test("fires once per utterance, re-arming on the next speech run", () => {
  const clock = makeClock();
  let fires = 0;
  const ep = createSpeechEndpointer({ onEndpoint: () => fires++, clock: clock.now, silenceMs: 600, minSpeechMs: 150 });
  ep.feed(80);
  feedFrames(ep, clock, Array(8).fill(40));
  feedFrames(ep, clock, Array(8).fill(4000));  // utterance 1
  feedFrames(ep, clock, Array(16).fill(30));   // quiet → fire
  assert.equal(fires, 1);
  feedFrames(ep, clock, Array(8).fill(4000));  // utterance 2
  feedFrames(ep, clock, Array(16).fill(30));   // quiet → fire again
  assert.equal(fires, 2);
});

test("does not fire while inactive (no transcription live)", () => {
  const clock = makeClock();
  let active = false;
  let fires = 0;
  const ep = createSpeechEndpointer({ onEndpoint: () => fires++, isActive: () => active, clock: clock.now, silenceMs: 600, minSpeechMs: 150 });
  ep.feed(80);
  feedFrames(ep, clock, Array(8).fill(40));
  feedFrames(ep, clock, Array(8).fill(4000));  // speech while inactive
  feedFrames(ep, clock, Array(16).fill(30));
  assert.equal(fires, 0);
  active = true;                                // now listening
  feedFrames(ep, clock, Array(8).fill(4000));
  feedFrames(ep, clock, Array(16).fill(30));
  assert.equal(fires, 1);
});

test("ignores frames while she is speaking (echo guard)", () => {
  const clock = makeClock();
  let speaking = true;
  let fires = 0;
  const ep = createSpeechEndpointer({ onEndpoint: () => fires++, isSpeaking: () => speaking, clock: clock.now, silenceMs: 600, minSpeechMs: 150 });
  ep.feed(80);
  feedFrames(ep, clock, Array(8).fill(4000));   // "her TTS" — ignored
  feedFrames(ep, clock, Array(16).fill(30));
  assert.equal(fires, 0);
  speaking = false;                              // she's done
  feedFrames(ep, clock, Array(8).fill(40));
  feedFrames(ep, clock, Array(8).fill(4000));    // real user speech
  feedFrames(ep, clock, Array(16).fill(30));
  assert.equal(fires, 1);
});

test("reset() clears state so a fresh utterance is needed", () => {
  const clock = makeClock();
  let fires = 0;
  const ep = createSpeechEndpointer({ onEndpoint: () => fires++, clock: clock.now, silenceMs: 600, minSpeechMs: 150 });
  ep.feed(80);
  feedFrames(ep, clock, Array(8).fill(4000));    // mid-utterance
  ep.reset();
  feedFrames(ep, clock, Array(16).fill(30));     // quiet, but speech state was reset
  assert.equal(fires, 0);
});

test("non-numeric rms is ignored", () => {
  const clock = makeClock();
  let fires = 0;
  const ep = createSpeechEndpointer({ onEndpoint: () => fires++, clock: clock.now });
  assert.doesNotThrow(() => { ep.feed(undefined); ep.feed(NaN); ep.feed("x"); });
  assert.equal(fires, 0);
});
