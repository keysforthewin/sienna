// Composition test (no sockets): wires the REAL transcriber + scribe + PTT
// coordinator together — only the raw WebSocket and the agent are faked — to
// prove the whole chain end to end:
//   press → mic PCM streams into Scribe → release → grace → forced commit rides
//   a synthetic silence frame → committed transcript → ONE agent run (joined).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createTranscriber } from "./transcriber.js";
import { createScribeSession } from "./scribe.js";
import { createPttCoordinator } from "./ptt.js";

// Fake raw WebSocket: when it receives an input_audio_chunk with commit:true it
// "transcribes" the next queued phrase back as a committed_transcript (an empty
// queue answers with an empty transcript, the way a silent commit resolves).
function makeFakeWsCtor(phrases) {
  let inst = null;
  function Ctor() {
    inst = {
      handlers: {}, readyState: 1 /* OPEN */, sent: [],
      on(e, cb) { (this.handlers[e] ||= []).push(cb); return this; },
      emit(e, ...a) { (this.handlers[e] || []).forEach((cb) => cb(...a)); },
      send(d) {
        this.sent.push(JSON.parse(d));
        const m = JSON.parse(d);
        if (m.message_type === "input_audio_chunk" && m.commit) {
          const text = phrases.shift() ?? "";
          this.emit("message", JSON.stringify({ message_type: "committed_transcript", text }));
        }
      },
      close() { this.readyState = 3; },
    };
    return inst;
  }
  return { ctor: Ctor, get: () => inst };
}

test("press → speak → release → forced commit → one joined ptt agent run", async () => {
  const phrases = ["turn the kitchen lights blue"];
  const { ctor, get } = makeFakeWsCtor(phrases);
  const scribeFactory = ({ callbacks }) => createScribeSession({ apiKey: "k", wsCtor: ctor, callbacks });
  const micStream = { acquire: () => true, release() {}, reset() {} };

  let ptt;  // lazy: transcriber callbacks → ptt (as in index.js)
  const transcriber = createTranscriber({
    bridge: { broadcastToBrowsers() {} },
    scribeFactory, micStream,
    onFinalTranscript: (t) => ptt.onUtterance(t),
    onCommitObserved: () => ptt.onCommitObserved(),
  });

  const runs = [];
  const beeps = [];
  // Deterministic timers: capture and fire by hand.
  const timers = [];
  ptt = createPttCoordinator({
    transcriber,
    runAgent: (text, source) => { runs.push({ text, source }); return Promise.resolve(); },
    onRouted: () => beeps.push(1),
    releaseGraceMs: 300, commitTimeoutMs: 2000, maxHoldMs: 60000,
    scheduler: (fn, ms) => { const h = { fn, ms, unref() {} }; timers.push(h); return h; },
    clear: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
  });
  const fire = (ms) => {
    const i = timers.findIndex((t) => t.ms === ms);
    assert.ok(i >= 0, `no pending timer ms=${ms}`);
    timers.splice(i, 1)[0].fn();
  };

  // 1) Button down → mic opens, Scribe session is live.
  ptt.onButton(true);
  get().emit("open");
  assert.equal(transcriber.isActive(), true);
  assert.equal(ptt.isHeld(), true);

  // 2) The device streams PCM while held (no commits fire — VAD stays quiet).
  for (let i = 0; i < 10; i++) transcriber.feedPcm(Buffer.alloc(1600));
  assert.equal(runs.length, 0);

  // 3) Button up → grace elapses → the forced commit rides a synthetic silence
  //    frame → fake Scribe answers with the transcript → ONE routed run + beep.
  ptt.onButton(false);
  fire(300);
  const commits = get().sent.filter((m) => m.message_type === "input_audio_chunk" && m.commit);
  assert.equal(commits.length, 1, "exactly one forced commit reached Scribe");
  assert.deepEqual(runs, [{ text: "turn the kitchen lights blue", source: "ptt" }]);
  assert.equal(beeps.length, 1);
  assert.equal(transcriber.isActive(), false, "session released after the turn");
  assert.equal(timers.length, 0, "no timers leaked");
});

test("mid-hold VAD commits join with the release tail into one run", async () => {
  const phrases = [];
  const { ctor, get } = makeFakeWsCtor(phrases);
  const scribeFactory = ({ callbacks }) => createScribeSession({ apiKey: "k", wsCtor: ctor, callbacks });
  const micStream = { acquire: () => true, release() {}, reset() {} };

  let ptt;
  const transcriber = createTranscriber({
    bridge: { broadcastToBrowsers() {} },
    scribeFactory, micStream,
    onFinalTranscript: (t) => ptt.onUtterance(t),
    onCommitObserved: () => ptt.onCommitObserved(),
  });

  const runs = [];
  const timers = [];
  ptt = createPttCoordinator({
    transcriber,
    runAgent: (text, source) => { runs.push({ text, source }); return Promise.resolve(); },
    releaseGraceMs: 300, commitTimeoutMs: 2000, maxHoldMs: 60000,
    scheduler: (fn, ms) => { const h = { fn, ms, unref() {} }; timers.push(h); return h; },
    clear: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
  });
  const fire = (ms) => {
    const i = timers.findIndex((t) => t.ms === ms);
    assert.ok(i >= 0, `no pending timer ms=${ms}`);
    timers.splice(i, 1)[0].fn();
  };

  ptt.onButton(true);
  get().emit("open");

  // ElevenLabs VAD finalizes a mid-hold pause on its own (no commit flag from us).
  get().emit("message", JSON.stringify({ message_type: "committed_transcript", text: "remind me tomorrow" }));
  assert.equal(runs.length, 0, "mid-hold commit accumulates, never routes");

  // Release: the forced commit returns the trailing words.
  phrases.push("to water the plants");
  ptt.onButton(false);
  fire(300);
  assert.deepEqual(runs, [{ text: "remind me tomorrow to water the plants", source: "ptt" }]);
});
