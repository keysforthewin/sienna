import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createElevenLabsTts } from "./tts.js";

const OPTS = { apiKey: "sk-test", voiceId: "voice123", modelId: "eleven_v3" };

test("createElevenLabsTts requires an apiKey", () => {
  assert.throws(() => createElevenLabsTts({ voiceId: "v", modelId: "m" }), /apiKey/);
});

test("synthesizePcm16 requests raw pcm_16000 with audio/pcm accept (buffered)", async () => {
  let captured = null;
  const fakeFetch = async (url, init) => {
    captured = { url, init };
    return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([0, 1, 2, 3]).buffer };
  };
  const tts = createElevenLabsTts({ ...OPTS, fetchImpl: fakeFetch });

  const out = await tts.synthesizePcm16("speak this");

  assert.ok(captured.url.includes("output_format=pcm_16000"), "URL has pcm output format");
  assert.equal(captured.init.headers.accept, "audio/pcm");
  assert.deepEqual(JSON.parse(captured.init.body), { text: "speak this", model_id: "eleven_v3" });
  assert.deepEqual(out, Buffer.from([0, 1, 2, 3]));
});

test("stream hits the /stream endpoint and returns the raw body stream", async () => {
  let captured = null;
  const body = Readable.from([Buffer.from([1, 0]), Buffer.from([2, 0])]);
  const fakeFetch = async (url, init) => { captured = { url, init }; return { ok: true, status: 200, body }; };
  const tts = createElevenLabsTts({ ...OPTS, fetchImpl: fakeFetch });

  const out = await tts.stream("stream this");

  assert.ok(captured.url.includes("/voice123/stream"), "URL hits the streaming endpoint");
  assert.ok(captured.url.includes("output_format=pcm_16000"), "URL has pcm output format");
  assert.equal(captured.init.headers.accept, "audio/pcm");
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers["xi-api-key"], "sk-test");
  // No opts → minimal body (matches the proven speak/api-tts body).
  assert.deepEqual(JSON.parse(captured.init.body), { text: "stream this", model_id: "eleven_v3" });
  assert.equal(out, body, "returns the body stream itself (not buffered)");
});

test("stream includes optional params when provided, and NEVER sends previous/next_text", async () => {
  let captured = null;
  const fakeFetch = async (url, init) => { captured = { url, init }; return { ok: true, status: 200, body: Readable.from([]) }; };
  const tts = createElevenLabsTts({ ...OPTS, fetchImpl: fakeFetch });   // OPTS.modelId === "eleven_v3"

  // eleven_v3 (the only model we use) rejects previous_text/next_text with 400
  // unsupported_model, which would fail every chunk after the first in a chunked
  // reply — so the body must never carry them, even if a caller passes them.
  await tts.stream("chunk two", {
    previousText: "chunk one",
    nextText: "chunk three",
    voiceSettings: { stability: 0.5 },
    applyTextNormalization: "on",
    languageCode: "en",
  });

  assert.deepEqual(JSON.parse(captured.init.body), {
    text: "chunk two",
    model_id: "eleven_v3",
    voice_settings: { stability: 0.5 },
    apply_text_normalization: "on",
    language_code: "en",
  });
});

test("stream uses the configured stream output format", async () => {
  let captured = null;
  const fakeFetch = async (url, init) => { captured = { url, init }; return { ok: true, status: 200, body: Readable.from([]) }; };
  const tts = createElevenLabsTts({ ...OPTS, streamOutputFormat: "pcm_24000", fetchImpl: fakeFetch });

  await tts.stream("hi");
  assert.ok(captured.url.includes("output_format=pcm_24000"), "URL uses the configured format");
});

test("stream merges an external abort signal with the timeout", async () => {
  let captured = null;
  const fakeFetch = async (url, init) => { captured = { url, init }; return { ok: true, status: 200, body: Readable.from([]) }; };
  const tts = createElevenLabsTts({ ...OPTS, fetchImpl: fakeFetch });

  // An already-aborted external signal → the merged signal the fetch sees is aborted.
  await tts.stream("hi", { signal: AbortSignal.abort() });
  assert.ok(captured.init.signal instanceof AbortSignal);
  assert.equal(captured.init.signal.aborted, true, "merged signal reflects the external abort");

  // A live (non-aborted) external signal → merged signal is not aborted.
  const ac = new AbortController();
  await tts.stream("hi", { signal: ac.signal });
  assert.equal(captured.init.signal.aborted, false);

  // No external signal → still an (un-aborted) AbortSignal from the timeout.
  await tts.stream("hi");
  assert.ok(captured.init.signal instanceof AbortSignal);
  assert.equal(captured.init.signal.aborted, false);
});

test("stream throws with status on a non-ok response", async () => {
  const fakeFetch = async () => ({ ok: false, status: 500, text: async () => "boom" });
  const tts = createElevenLabsTts({ ...OPTS, fetchImpl: fakeFetch });
  await assert.rejects(() => tts.stream("hi"), /500/);
});
