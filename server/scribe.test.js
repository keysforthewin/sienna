import { test } from "node:test";
import assert from "node:assert/strict";
import { createScribeSession } from "./scribe.js";

// A fake `ws` client: records the ctor args + sent frames and lets the test
// drive events. `new Ctor()` returns this object (constructor returning an
// object), so createScribeSession's internal `new wsCtor(...)` hands it back.
function makeFakeCtor() {
  let inst = null;
  function Ctor(url, opts) {
    inst = {
      url, opts, handlers: {}, sent: [], readyState: 1 /* OPEN */, closed: false,
      on(e, cb) { (this.handlers[e] ||= []).push(cb); return this; },
      emit(e, ...a) { (this.handlers[e] || []).forEach((cb) => cb(...a)); },
      send(d) { this.sent.push(d); },
      close() { this.closed = true; this.readyState = 3; },
    };
    return inst;
  }
  return { ctor: Ctor, get: () => inst };
}

test("opens the realtime endpoint with the right params and header", () => {
  const { ctor, get } = makeFakeCtor();
  createScribeSession({ apiKey: "SECRET_KEY", modelId: "scribe_v2_realtime", callbacks: {}, wsCtor: ctor });
  const fake = get();
  assert.ok(fake.url.startsWith("wss://api.elevenlabs.io/v1/speech-to-text/realtime?"));
  assert.ok(fake.url.includes("model_id=scribe_v2_realtime"));
  assert.ok(fake.url.includes("audio_format=pcm_16000"));
  assert.ok(fake.url.includes("commit_strategy=manual")); // server-driven commits (endpointer)
  assert.ok(!fake.url.includes("language_code"));
  assert.equal(fake.opts.headers["xi-api-key"], "SECRET_KEY");
});

test("commit_strategy is configurable; vad params attach only in vad mode", () => {
  const a = makeFakeCtor();
  createScribeSession({ apiKey: "k", commitStrategy: "vad", vadSilenceSecs: 0.7, vadThreshold: 0.5, callbacks: {}, wsCtor: a.ctor });
  assert.ok(a.get().url.includes("commit_strategy=vad"));
  assert.ok(a.get().url.includes("vad_silence_threshold_secs=0.7"));
  assert.ok(a.get().url.includes("vad_threshold=0.5"));
  // In manual mode the vad knobs are ignored (no commits from VAD anyway).
  const b = makeFakeCtor();
  createScribeSession({ apiKey: "k", commitStrategy: "manual", vadSilenceSecs: 0.7, callbacks: {}, wsCtor: b.ctor });
  assert.ok(!b.get().url.includes("vad_silence_threshold_secs"));
});

test("includes language_code only when a language is given", () => {
  const { ctor, get } = makeFakeCtor();
  createScribeSession({ apiKey: "k", language: "en", callbacks: {}, wsCtor: ctor });
  assert.ok(get().url.includes("language_code=en"));
});

test("createScribeSession requires an apiKey", () => {
  const { ctor } = makeFakeCtor();
  assert.throws(() => createScribeSession({ callbacks: {}, wsCtor: ctor }), /apiKey/);
});

test("sendPcm emits one base64 input_audio_chunk when OPEN", () => {
  const { ctor, get } = makeFakeCtor();
  const s = createScribeSession({ apiKey: "k", callbacks: {}, wsCtor: ctor });
  const fake = get();
  fake.emit("open");
  const buf = Buffer.from([1, 2, 3, 4]);
  s.sendPcm(buf);
  assert.equal(fake.sent.length, 1);
  const msg = JSON.parse(fake.sent[0]);
  assert.equal(msg.message_type, "input_audio_chunk");
  assert.equal(msg.audio_base_64, buf.toString("base64"));
  assert.equal(msg.commit, false); // normal frames don't commit
});

test("sendPcm with { commit:true } force-commits the buffered utterance", () => {
  const { ctor, get } = makeFakeCtor();
  const s = createScribeSession({ apiKey: "k", callbacks: {}, wsCtor: ctor });
  const fake = get();
  fake.emit("open");
  s.sendPcm(Buffer.from([5, 6]), { commit: true });
  assert.equal(JSON.parse(fake.sent[0]).commit, true);
});

test("buffers frames sent while CONNECTING and flushes them in order on open", () => {
  const { ctor, get } = makeFakeCtor();
  const s = createScribeSession({ apiKey: "k", callbacks: {}, wsCtor: ctor });
  const fake = get();
  fake.readyState = 0; // CONNECTING — the realtime handshake hasn't finished
  s.sendPcm(Buffer.from([1]));
  s.sendPcm(Buffer.from([2]), { commit: true });
  assert.equal(fake.sent.length, 0, "nothing goes on the wire before the socket opens");
  fake.readyState = 1; // OPEN
  fake.emit("open");   // flush the catch-up buffer, in order, ahead of live frames
  assert.equal(fake.sent.length, 2);
  assert.equal(JSON.parse(fake.sent[0]).audio_base_64, Buffer.from([1]).toString("base64"));
  assert.equal(JSON.parse(fake.sent[0]).commit, false);
  assert.equal(JSON.parse(fake.sent[1]).audio_base_64, Buffer.from([2]).toString("base64"));
  assert.equal(JSON.parse(fake.sent[1]).commit, true, "the commit flag rides through the buffer");
});

test("the pre-open catch-up buffer is capped (~5 s); oldest frames drop on overflow", () => {
  const { ctor, get } = makeFakeCtor();
  const s = createScribeSession({ apiKey: "k", callbacks: {}, wsCtor: ctor });
  const fake = get();
  fake.readyState = 0; // CONNECTING
  // 1 s of 16 kHz mono int16 = 32000 bytes. Queue 6 s → the 5 s cap keeps the
  // most recent 5, dropping the oldest so the flush stays contiguous with live.
  const SEC = 32000;
  for (let i = 0; i < 6; i++) s.sendPcm(Buffer.alloc(SEC, i));
  fake.readyState = 1;
  fake.emit("open");
  assert.equal(fake.sent.length, 5, "only 5 s survives the cap");
  const first = Buffer.from(JSON.parse(fake.sent[0]).audio_base_64, "base64");
  assert.equal(first[0], 1, "the oldest (index 0) frame was dropped");
  const last = Buffer.from(JSON.parse(fake.sent[4]).audio_base_64, "base64");
  assert.equal(last[0], 5, "the newest frame is kept");
});

test("frames sent while CLOSING/CLOSED are dropped, not buffered", () => {
  const { ctor, get } = makeFakeCtor();
  const s = createScribeSession({ apiKey: "k", callbacks: {}, wsCtor: ctor });
  const fake = get();
  fake.readyState = 3; // CLOSED — this socket will never open
  s.sendPcm(Buffer.from([9]));
  fake.emit("open");   // even a stray open must surface nothing — nothing was queued
  assert.equal(fake.sent.length, 0);
});

test("dispatches partial/committed/error messages to callbacks", () => {
  const { ctor, get } = makeFakeCtor();
  const events = [];
  const s = createScribeSession({
    apiKey: "SECRET_KEY",
    callbacks: {
      onPartial: (t) => events.push(["partial", t]),
      onCommitted: (t) => events.push(["committed", t]),
      onError: (kind, detail) => events.push(["error", kind, detail]),
    },
    wsCtor: ctor,
  });
  const fake = get();
  fake.emit("message", JSON.stringify({ message_type: "partial_transcript", text: "hel" }));
  fake.emit("message", JSON.stringify({ message_type: "committed_transcript", text: "hello" }));
  fake.emit("message", JSON.stringify({ message_type: "auth_error", error: "bad key" }));
  assert.deepEqual(events[0], ["partial", "hel"]);
  assert.deepEqual(events[1], ["committed", "hello"]);
  assert.equal(events[2][0], "error");
  assert.equal(events[2][1], "auth_error");
  // The API key must never leak into anything handed to onError.
  for (const e of events) {
    assert.ok(!JSON.stringify(e).includes("SECRET_KEY"));
  }
  s.close();
  assert.equal(fake.closed, true);
});
