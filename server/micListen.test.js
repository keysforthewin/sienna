import { test } from "node:test";
import assert from "node:assert/strict";
import { createMicListener } from "./micListen.js";

function makeMic() {
  return {
    acquired: [], released: [], online: true,
    acquire(tok) { this.acquired.push(tok); return this.online; },
    release(tok) { this.released.push(tok); },
    reset() {},
  };
}

function makeScribeFactory() {
  const sessions = [];
  const factory = ({ callbacks }) => {
    const s = {
      callbacks, sent: [], closed: false,
      sendPcm(b) { this.sent.push(b); },
      close() { this.closed = true; },
    };
    sessions.push(s);
    return s;
  };
  return { factory, sessions };
}

// Resolves immediately; records the ms it was asked to sleep.
function recordingSleep() {
  const fn = (ms) => { fn.calls.push(ms); return Promise.resolve(); };
  fn.calls = [];
  return fn;
}

// Stays pending until flush() — lets a test fire Scribe callbacks before the
// listen window "ends".
function manualSleep() {
  let resolve;
  const fn = (ms) => { fn.calls.push(ms); return new Promise((r) => { resolve = r; }); };
  fn.calls = [];
  fn.flush = () => resolve();
  return fn;
}

const uuid = () => "abc";

test("listen acquires + releases the mic token exactly once and closes the session", async () => {
  const mic = makeMic();
  const { factory, sessions } = makeScribeFactory();
  const l = createMicListener({ micStream: mic, scribeFactory: factory, sleep: recordingSleep(), uuid });
  const r = await l.listen({ seconds: 10 });
  assert.deepEqual(mic.acquired, ["listen:abc"]);
  assert.deepEqual(mic.released, ["listen:abc"]);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].closed, true);
  assert.equal(l.isActive(), false);
  // No speech happened during the (immediate) window → a silent observation.
  assert.deepEqual(r, { ok: true, transcript: "", heardSpeech: false });
});

test("listen releases the token even when the Scribe session fails to open", async () => {
  const mic = makeMic();
  const l = createMicListener({
    micStream: mic,
    scribeFactory: () => { throw new Error("boom"); },
    sleep: recordingSleep(), uuid,
  });
  const r = await l.listen({});
  assert.equal(r.ok, false);
  assert.equal(r.reason, "scribe_init_failed");
  assert.deepEqual(mic.acquired, ["listen:abc"]);
  assert.deepEqual(mic.released, ["listen:abc"]); // not leaked
  assert.equal(l.isActive(), false);
});

test("listen returns device_offline and opens no session when the device is gone", async () => {
  const mic = makeMic();
  mic.online = false;
  const { factory, sessions } = makeScribeFactory();
  const l = createMicListener({ micStream: mic, scribeFactory: factory, sleep: recordingSleep(), uuid });
  const r = await l.listen({ seconds: 10 });
  assert.deepEqual(r, { ok: false, reason: "device_offline" });
  assert.equal(sessions.length, 0);
  assert.deepEqual(mic.acquired, ["listen:abc"]);
  assert.deepEqual(mic.released, []); // nothing acquired to release
  assert.equal(l.isActive(), false);
});

test("listen accumulates committed transcripts (committed wins over partial)", async () => {
  const mic = makeMic();
  const { factory, sessions } = makeScribeFactory();
  const sleep = manualSleep();
  const l = createMicListener({ micStream: mic, scribeFactory: factory, sleep, uuid });
  const p = l.listen({ seconds: 30 });
  sessions[0].callbacks.onPartial("hel");
  sessions[0].callbacks.onCommitted("hello");
  sessions[0].callbacks.onCommitted("  there  "); // trimmed
  sessions[0].callbacks.onCommitted("   ");        // whitespace-only ignored
  sleep.flush();
  const r = await p;
  assert.deepEqual(r, { ok: true, transcript: "hello there", heardSpeech: true });
});

test("listen falls back to the last partial when VAD never commits before the deadline", async () => {
  const mic = makeMic();
  const { factory, sessions } = makeScribeFactory();
  const sleep = manualSleep();
  const l = createMicListener({ micStream: mic, scribeFactory: factory, sleep, uuid });
  const p = l.listen({ seconds: 30 });
  sessions[0].callbacks.onPartial("half a sen");
  sleep.flush();
  const r = await p;
  assert.deepEqual(r, { ok: true, transcript: "half a sen", heardSpeech: true });
});

test("disabled (no scribeFactory) reports not_configured and no-ops the rest", async () => {
  const mic = makeMic();
  const l = createMicListener({ micStream: mic, scribeFactory: null, sleep: recordingSleep(), uuid });
  const r = await l.listen({ seconds: 10 });
  assert.deepEqual(r, { ok: false, reason: "not_configured" });
  assert.deepEqual(mic.acquired, []);
  l.feedPcm(Buffer.from([1])); // no throw
  l.handleDeviceDisconnect();  // no throw
  assert.equal(l.isActive(), false);
});

test("feedPcm forwards to the session only while a listen is in flight", async () => {
  const mic = makeMic();
  const { factory, sessions } = makeScribeFactory();
  const sleep = manualSleep();
  const l = createMicListener({ micStream: mic, scribeFactory: factory, sleep, uuid });
  const buf = Buffer.from([1, 2]);
  l.feedPcm(buf);            // before listen → dropped
  const p = l.listen({ seconds: 30 });
  l.feedPcm(buf);            // active → forwarded
  assert.equal(sessions[0].sent.length, 1);
  sleep.flush();
  await p;
  l.feedPcm(buf);            // after window → dropped
  assert.equal(sessions[0].sent.length, 1);
});

test("handleDeviceDisconnect mid-listen closes the session, stops feeding, and the window still resolves", async () => {
  const mic = makeMic();
  const { factory, sessions } = makeScribeFactory();
  const sleep = manualSleep();
  const l = createMicListener({ micStream: mic, scribeFactory: factory, sleep, uuid });
  const p = l.listen({ seconds: 30 });
  l.handleDeviceDisconnect();
  assert.equal(sessions[0].closed, true);
  l.feedPcm(Buffer.from([9])); // session gone → dropped
  assert.equal(sessions[0].sent.length, 0);
  sleep.flush();
  const r = await p; // deferred finally runs without throwing
  assert.equal(r.ok, true);
  assert.equal(l.isActive(), false);
});

test("listen clamps the window to [min, max] and defaults when omitted", async () => {
  const mic = makeMic();
  const { factory } = makeScribeFactory();
  const sleep = recordingSleep();
  const l = createMicListener({
    micStream: mic, scribeFactory: factory, sleep, uuid,
    defaultSeconds: 20, minSeconds: 5, maxSeconds: 30,
  });
  await l.listen({ seconds: 1000 }); // over max
  await l.listen({ seconds: 1 });    // under min
  await l.listen({});                // omitted → default
  assert.deepEqual(sleep.calls, [30000, 5000, 20000]);
});

test("listen({maxSeconds}) raises the clamp ceiling for that call (eavesdrop's longer window)", async () => {
  const mic = makeMic();
  const { factory } = makeScribeFactory();
  const sleep = recordingSleep();
  const l = createMicListener({
    micStream: mic, scribeFactory: factory, sleep, uuid,
    defaultSeconds: 20, minSeconds: 5, maxSeconds: 30,
  });
  await l.listen({ seconds: 60 });                 // no override → clamped to the tool max (30s)
  await l.listen({ seconds: 60, maxSeconds: 60 }); // override → full 60s for eavesdrop
  assert.deepEqual(sleep.calls, [30000, 60000]);
});

test("a second listen while one is in flight returns busy without re-acquiring", async () => {
  const mic = makeMic();
  const { factory } = makeScribeFactory();
  const sleep = manualSleep();
  const l = createMicListener({ micStream: mic, scribeFactory: factory, sleep, uuid });
  const p = l.listen({ seconds: 30 });
  const second = await l.listen({ seconds: 30 });
  assert.deepEqual(second, { ok: false, reason: "busy" });
  assert.deepEqual(mic.acquired, ["listen:abc"]); // only the first acquired
  sleep.flush();
  await p;
});
