import { test } from "node:test";
import assert from "node:assert/strict";
import { createTranscriber, createDisabledTranscriber } from "./transcriber.js";

function makeBridge() {
  return {
    broadcasts: [],
    broadcastToBrowsers(m) { this.broadcasts.push(m); },
    has(type, pred = () => true) { return this.broadcasts.some((m) => m.type === type && pred(m)); },
  };
}

function makeScribeFactory() {
  const sessions = [];
  const factory = ({ callbacks }) => {
    const s = {
      callbacks, sent: [], closed: false,
      sendPcm(b, opts = {}) { this.sent.push({ buf: b, commit: !!opts.commit }); },
      close() { this.closed = true; },
    };
    sessions.push(s);
    return s;
  };
  return { factory, sessions };
}

function makeMic() {
  return {
    acquired: [], released: [], online: true,
    acquire(tok) { this.acquired.push(tok); return this.online; },
    release(tok) { this.released.push(tok); },
    reset() {},
  };
}

test("start opens the mic + Scribe session and broadcasts state true", () => {
  const bridge = makeBridge();
  const mic = makeMic();
  const { factory, sessions } = makeScribeFactory();
  const t = createTranscriber({ bridge, scribeFactory: factory, micStream: mic });
  t.start();
  assert.deepEqual(mic.acquired, ["transcription"]);
  assert.equal(sessions.length, 1);
  assert.ok(bridge.has("transcription_state", (m) => m.active === true));
  assert.equal(t.isActive(), true);
});

test("start with no device broadcasts device_offline and opens no session", () => {
  const bridge = makeBridge();
  const mic = makeMic();
  mic.online = false;
  const { factory, sessions } = makeScribeFactory();
  const t = createTranscriber({ bridge, scribeFactory: factory, micStream: mic });
  t.start();
  assert.equal(sessions.length, 0);
  assert.ok(bridge.has("transcription_error", (m) => m.error === "device_offline"));
  assert.ok(!bridge.has("transcription_state", (m) => m.active === true));
  assert.equal(t.isActive(), false);
});

test("feedPcm forwards to the session only while active", () => {
  const bridge = makeBridge();
  const mic = makeMic();
  const { factory, sessions } = makeScribeFactory();
  const t = createTranscriber({ bridge, scribeFactory: factory, micStream: mic });
  const buf = Buffer.from([1, 2]);
  t.feedPcm(buf);                 // before start → dropped
  t.start();
  t.feedPcm(buf);                 // active → forwarded
  assert.equal(sessions[0].sent.length, 1);
  t.stop();
  t.feedPcm(buf);                 // after stop → dropped
  assert.equal(sessions[0].sent.length, 1);
});

test("commitNextChunk latches a force-commit onto exactly the next frame", () => {
  const bridge = makeBridge();
  const mic = makeMic();
  const { factory, sessions } = makeScribeFactory();
  const t = createTranscriber({ bridge, scribeFactory: factory, micStream: mic });
  t.start();
  t.feedPcm(Buffer.from([1]));   // normal
  t.commitNextChunk();
  t.feedPcm(Buffer.from([2]));   // carries commit:true
  t.feedPcm(Buffer.from([3]));   // back to normal
  assert.deepEqual(sessions[0].sent.map((f) => f.commit), [false, true, false]);
});

test("commitNextChunk is a no-op when not transcribing", () => {
  const bridge = makeBridge();
  const mic = makeMic();
  const { factory, sessions } = makeScribeFactory();
  const t = createTranscriber({ bridge, scribeFactory: factory, micStream: mic });
  assert.doesNotThrow(() => t.commitNextChunk());  // before start
  t.start();
  t.commitNextChunk();
  t.feedPcm(Buffer.from([1]));
  assert.equal(sessions[0].sent[0].commit, true);  // latch survived until the first frame
});

test("shouldFeed() gates the mic feed (echo gate while she speaks)", () => {
  const bridge = makeBridge();
  const mic = makeMic();
  const { factory, sessions } = makeScribeFactory();
  let speaking = false;
  const t = createTranscriber({ bridge, scribeFactory: factory, micStream: mic, shouldFeed: () => !speaking });
  t.start();
  t.feedPcm(Buffer.from([1]));   // forwarded
  speaking = true;
  t.feedPcm(Buffer.from([2]));   // dropped (her TTS echo)
  speaking = false;
  t.feedPcm(Buffer.from([3]));   // forwarded
  assert.equal(sessions[0].sent.length, 2);
});

test("partial and committed transcripts broadcast with the right final flag", () => {
  const bridge = makeBridge();
  const mic = makeMic();
  const { factory, sessions } = makeScribeFactory();
  const t = createTranscriber({ bridge, scribeFactory: factory, micStream: mic });
  t.start();
  sessions[0].callbacks.onPartial("hel");
  sessions[0].callbacks.onCommitted("hello");
  assert.ok(bridge.has("transcript", (m) => m.final === false && m.text === "hel"));
  assert.ok(bridge.has("transcript", (m) => m.final === true && m.text === "hello"));
});

test("onFinalTranscript fires for committed (not partial) transcripts", () => {
  const bridge = makeBridge();
  const mic = makeMic();
  const { factory, sessions } = makeScribeFactory();
  const finals = [];
  const t = createTranscriber({ bridge, scribeFactory: factory, micStream: mic, onFinalTranscript: (x) => finals.push(x) });
  t.start();
  sessions[0].callbacks.onPartial("hel");      // must NOT route
  sessions[0].callbacks.onCommitted("hello");  // routes to agent
  sessions[0].callbacks.onCommitted("   ");    // whitespace-only must NOT route
  assert.deepEqual(finals, ["hello"]);
});

test("a Scribe error auto-stops the session", () => {
  const bridge = makeBridge();
  const mic = makeMic();
  const { factory, sessions } = makeScribeFactory();
  const t = createTranscriber({ bridge, scribeFactory: factory, micStream: mic });
  t.start();
  sessions[0].callbacks.onError("auth_error");
  assert.ok(bridge.has("transcription_error", (m) => m.error === "auth_error"));
  assert.equal(sessions[0].closed, true);
  assert.deepEqual(mic.released, ["transcription"]);
  assert.ok(bridge.has("transcription_state", (m) => m.active === false));
  assert.equal(t.isActive(), false);
});

test("stop closes the session, stops the mic, and is idempotent", () => {
  const bridge = makeBridge();
  const mic = makeMic();
  const { factory, sessions } = makeScribeFactory();
  const t = createTranscriber({ bridge, scribeFactory: factory, micStream: mic });
  t.start();
  t.stop();
  assert.equal(sessions[0].closed, true);
  assert.deepEqual(mic.released, ["transcription"]);
  assert.ok(bridge.has("transcription_state", (m) => m.active === false));
  const before = bridge.broadcasts.length;
  t.stop(); // no-op
  assert.equal(bridge.broadcasts.length, before);
});

test("device disconnect tears down without messaging the absent device", () => {
  const bridge = makeBridge();
  const mic = makeMic();
  const { factory, sessions } = makeScribeFactory();
  const t = createTranscriber({ bridge, scribeFactory: factory, micStream: mic });
  t.start();
  t.handleDeviceDisconnect();
  assert.equal(sessions[0].closed, true);
  assert.deepEqual(mic.released, []); // arbiter NOT released on disconnect
  assert.ok(bridge.has("transcription_state", (m) => m.active === false));
  assert.ok(bridge.has("transcription_error", (m) => m.error === "device_disconnected"));
  assert.equal(t.isActive(), false);
});

test("disabled transcriber reports not_configured and no-ops the rest", () => {
  const bridge = makeBridge();
  const t = createDisabledTranscriber({ bridge });
  t.start();
  assert.ok(bridge.has("transcription_error", (m) => m.error === "not_configured"));
  t.feedPcm(Buffer.from([1]));
  t.stop();
  t.handleDeviceDisconnect();
  assert.equal(t.isActive(), false);
});
