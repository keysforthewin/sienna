import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";

const MINIMAL = { DASHBOARD_TOKEN: "toktoktok" };

test("STT defaults to ElevenLabs native VAD for the quickest reliable finalization", () => {
  const c = loadConfig(MINIMAL);
  // VAD finalizes in ~120-150 ms and (verified against the live API) is robust to
  // the high-gain mic's noise floor — unlike the energy endpointer, which is the
  // single point of failure that made manual mode hang. So VAD is the default.
  assert.equal(c.ELEVENLABS_STT_COMMIT_STRATEGY, "vad");
  // Snappy end-of-speech: 0.4 s of silence commits (matches the old 400 ms intent).
  assert.equal(c.ELEVENLABS_STT_VAD_SILENCE_SECS, 0.4);
  // Speech/non-speech probability gate; 0.4 stays robust against a loud floor.
  assert.equal(c.ELEVENLABS_STT_VAD_THRESHOLD, 0.4);
});

test("commit strategy + vad knobs remain overridable from the environment", () => {
  const c = loadConfig({ ...MINIMAL, ELEVENLABS_STT_COMMIT_STRATEGY: "manual", ELEVENLABS_STT_VAD_SILENCE_SECS: "0.8", ELEVENLABS_STT_VAD_THRESHOLD: "0.5" });
  assert.equal(c.ELEVENLABS_STT_COMMIT_STRATEGY, "manual");
  assert.equal(c.ELEVENLABS_STT_VAD_SILENCE_SECS, 0.8);
  assert.equal(c.ELEVENLABS_STT_VAD_THRESHOLD, 0.5);
});

test("push-to-talk defaults: 60 s hold cap, 300 ms release grace, 2 s commit timeout", () => {
  const c = loadConfig(MINIMAL);
  assert.equal(c.SIENNA_PTT_MAX_HOLD_MS, 60000);
  assert.equal(c.SIENNA_PTT_RELEASE_GRACE_MS, 300);
  assert.equal(c.SIENNA_PTT_COMMIT_TIMEOUT_MS, 2000);
});

test("commit beep defaults: a rising 1540→1640 Hz / 50 ms chirp", () => {
  const c = loadConfig(MINIMAL);
  assert.equal(c.SIENNA_COMMIT_BEEP_HZ, 1540);
  assert.equal(c.SIENNA_COMMIT_BEEP_HZ2, 1640);
  assert.equal(c.SIENNA_COMMIT_BEEP_MS, 50);
  assert.equal(c.SIENNA_COMMIT_BEEP_AMPLITUDE, 0.25);
});

test("Gemini token pricing defaults are present (per 1M tokens)", () => {
  const c = loadConfig(MINIMAL);
  assert.equal(c.GEMINI_PRICE_INPUT_PER_1M, 0.3);
  assert.equal(c.GEMINI_PRICE_OUTPUT_PER_1M, 2.5);
  assert.equal(c.GEMINI_PRICE_IMAGE_PER_1M, 0.3);
});

test("Gemini API key + sentence-chunked TTS knobs are configurable env", () => {
  const c = loadConfig(MINIMAL);
  assert.equal(c.GEMINI_API_KEY, undefined);
  // sentence-chunker: small first chunk, coalesce toward target; device-native pcm
  assert.equal(c.SIENNA_TTS_CHUNK_FIRST_CHARS, 60);
  assert.equal(c.SIENNA_TTS_CHUNK_TARGET_CHARS, 200);
  assert.equal(c.ELEVENLABS_STREAM_OUTPUT_FORMAT, "pcm_16000");
  const c2 = loadConfig({
    ...MINIMAL, GEMINI_API_KEY: "k",
    SIENNA_TTS_CHUNK_FIRST_CHARS: "40", SIENNA_TTS_CHUNK_TARGET_CHARS: "300",
    ELEVENLABS_STREAM_OUTPUT_FORMAT: "pcm_24000",
  });
  assert.equal(c2.GEMINI_API_KEY, "k");
  assert.equal(c2.SIENNA_TTS_CHUNK_FIRST_CHARS, 40);
  assert.equal(c2.SIENNA_TTS_CHUNK_TARGET_CHARS, 300);
  assert.equal(c2.ELEVENLABS_STREAM_OUTPUT_FORMAT, "pcm_24000");
});

test("music start-confirm timeout default", () => {
  assert.equal(loadConfig(MINIMAL).SIENNA_MUSIC_START_CONFIRM_MS, 8000);
});

test("speak-listen config defaults", () => {
  const c = loadConfig(MINIMAL);
  assert.equal(c.SIENNA_SPEAK_LISTEN, true);
  assert.equal(c.SIENNA_SPEAK_LISTEN_SECONDS, 10);
  assert.equal(c.SIENNA_SPEAK_LISTEN_DRAIN_CAP_MS, 4000);
});

test("speak-listen disable via env", () => {
  const c = loadConfig({ ...MINIMAL, SIENNA_SPEAK_LISTEN: "false" });
  assert.equal(c.SIENNA_SPEAK_LISTEN, false);
});
