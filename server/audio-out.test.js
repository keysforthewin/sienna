import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable, PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { createAudioOut } from "./audio-out.js";
import { createVolume } from "./volume.js";

function makeBridge({ online = true } = {}) {
  return {
    texts: [],
    bins: [],
    online,
    sendToDevice(p) { this.texts.push(typeof p === "string" ? JSON.parse(p) : p); return this.online; },
    sendBinaryToDevice(buf) { this.bins.push(Buffer.from(buf)); return this.online; },
    cmds(type) { return this.texts.filter((t) => t.type === type); },
  };
}

const noSleep = () => Promise.resolve();
const refGen = () => "R";
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

// Fake HTTP streaming TTS: each stream() call returns the next pre-fed body (a
// Readable of byte chunks), records the text + opts (incl. the abort signal), so a
// test can drive chunk ordering and in-flight aborts.
function makeTts() {
  const calls = [];
  const pending = [];
  return {
    calls,
    stream: async (text, opts = {}) => {
      calls.push({ text, opts });
      return pending.length ? pending.shift() : Readable.from([]);
    },
    feed(...byteArrays) { pending.push(Readable.from(byteArrays.map((b) => Buffer.from(b)))); },
    synthesizePcm16: async () => Buffer.alloc(0),
  };
}

test("streamPcm sends start, tagged 0x03 frames, then end", async () => {
  const bridge = makeBridge();
  const audio = createAudioOut({ bridge, tts: {}, sleep: noSleep, refGen, chunkSamples: 4 });
  // 10 samples / 4 per frame ⇒ 3 frames (4,4,2)
  const int16 = Int16Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const frames = await audio.streamPcm(int16);
  assert.equal(frames, 3);
  assert.equal(bridge.cmds("play_audio_start").length, 1);
  assert.equal(bridge.cmds("play_audio_end").length, 1);
  assert.equal(bridge.bins.length, 3);
  assert.ok(bridge.bins.every((b) => b[0] === 0x03));
  // last frame holds 2 samples ⇒ 1 tag + 4 bytes
  assert.equal(bridge.bins[2].length, 1 + 4);
});

test("streamPcm honours a subarray byteOffset (no slicing bug)", async () => {
  const bridge = makeBridge();
  const audio = createAudioOut({ bridge, tts: {}, sleep: noSleep, refGen, chunkSamples: 2 });
  const backing = Int16Array.from([99, 99, 11, 22, 33, 44]);
  const view = backing.subarray(2); // [11,22,33,44], byteOffset = 4
  await audio.streamPcm(view);
  // first frame samples 11,22 → little-endian bytes 11,0,22,0 after the 0x03 tag
  assert.deepEqual([...bridge.bins[0]], [0x03, 11, 0, 22, 0]);
});

test("stop() aborts mid-stream", async () => {
  const bridge = makeBridge();
  const holder = {};
  const audio = createAudioOut({
    bridge, tts: {}, refGen, chunkSamples: 2,
    sleep: async () => { holder.audio.stop(); }, // abort after the first frame's pacing
  });
  holder.audio = audio;
  const int16 = Int16Array.from([1, 2, 3, 4, 5, 6, 7, 8]); // would be 4 frames
  await audio.streamPcm(int16);
  assert.ok(bridge.bins.length < 4, `expected early abort, got ${bridge.bins.length} frames`);
});

test("device offline ⇒ no frames", async () => {
  const bridge = makeBridge({ online: false });
  const audio = createAudioOut({ bridge, tts: {}, sleep: noSleep, refGen });
  const frames = await audio.streamPcm(Int16Array.from([1, 2, 3, 4]));
  assert.equal(frames, 0);
  assert.equal(bridge.bins.length, 0);
});

test("speak streams ElevenLabs chunks as they arrive (paced, not buffered)", async () => {
  const bridge = makeBridge();
  let askedText = null;
  const tts = {
    stream: async (t) => { askedText = t; return Readable.from([Buffer.from([1, 0, 2, 0]), Buffer.from([3, 0, 4, 0])]); },
  };
  const audio = createAudioOut({ bridge, tts, sleep: noSleep, refGen, chunkSamples: 2 });
  const frames = await audio.speak("[happy] hi");
  assert.equal(askedText, "[happy] hi");
  assert.equal(frames, 2);
  assert.equal(bridge.cmds("play_audio_start").length, 1);
  assert.equal(bridge.cmds("play_audio_end").length, 1);
  assert.equal(bridge.bins.length, 2); // 8 bytes / (2 samples*2) = 2 frames
  assert.ok(bridge.bins.every((b) => b[0] === 0x03));
});

test("speak falls back to buffered synthesis when streaming fails", async () => {
  const bridge = makeBridge();
  let askedText = null;
  const tts = { synthesizePcm16: async (t) => { askedText = t; return Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]); } };
  const audio = createAudioOut({ bridge, tts, sleep: noSleep, refGen, chunkSamples: 2 });
  await audio.speak("[happy] hi");
  assert.equal(askedText, "[happy] hi");
  assert.equal(bridge.cmds("play_audio_start").length, 1);
  assert.equal(bridge.bins.length, 2); // 8 bytes / (2 samples*2) = 2 frames
});

test("applies the master volume gain to streamed frames", async () => {
  const bridge = makeBridge();
  const volume = createVolume({ initialPercent: 200 });
  const audio = createAudioOut({ bridge, tts: {}, volume, sleep: noSleep, refGen, chunkSamples: 2 });
  await audio.streamPcm(Int16Array.from([100, -50])); // one 2-sample frame
  assert.equal(bridge.bins.length, 1);
  const frame = bridge.bins[0];
  assert.equal(frame[0], 0x03);            // playback tag intact
  assert.equal(frame.readInt16LE(1), 200); // 100 × 2.0
  assert.equal(frame.readInt16LE(3), -100); // -50 × 2.0
});

test("paced loop waits on device backpressure (bufferedAmount) before sending", async () => {
  // chunkSamples 2 ⇒ frameBytes 4 ⇒ HIGH = 32, LOW = 8 (frameBytes × 8 / × 2).
  let buffered = 40;                  // start above the high-water mark
  let sleeps = 0;
  const bridge = {
    ...makeBridge(),
    deviceBufferedAmount() { return buffered; },
  };
  // Each "sleep" simulates the device socket draining by one frame.
  const sleep = () => { sleeps += 1; buffered = Math.max(0, buffered - 4); return Promise.resolve(); };
  const audio = createAudioOut({ bridge, tts: {}, sleep, refGen, chunkSamples: 2 });

  const frames = await audio.streamPcm(Int16Array.from([1, 2])); // one frame

  assert.equal(frames, 1);
  assert.equal(bridge.bins.length, 1, "frame is still delivered after draining");
  // Drained from 40 down to ≤ LOW (8) before the single frame went out: ≥ 8 polls.
  assert.ok(sleeps >= 8, `expected the loop to wait for drain, saw ${sleeps} sleeps`);
});

test("no backpressure gating when bridge lacks deviceBufferedAmount", async () => {
  const bridge = makeBridge();        // no deviceBufferedAmount accessor
  const audio = createAudioOut({ bridge, tts: {}, sleep: noSleep, refGen, chunkSamples: 2 });
  const frames = await audio.streamPcm(Int16Array.from([1, 2, 3, 4]));
  assert.equal(frames, 2);            // unaffected — clean no-op fallback
  assert.equal(bridge.bins.length, 2);
});

test("a superseding playback stops an in-flight paced stream (no zombie/overlapping frames)", async () => {
  // Regression: streamStdout/streamBytes used to check only `abort`, which withPlayback
  // resets to false on the new playback — so the old loop kept sending frames concurrently
  // with the new one (interleaved → static, needs server restart). It must also check
  // `generation`, like every other paced loop.
  const bridge = makeBridge();
  const gates = [];
  const sleep = () => new Promise((r) => gates.push(r));  // each frame's pacing parks here
  const audio = createAudioOut({ bridge, tts: {}, sleep, refGen, chunkSamples: 2 });

  const p1 = audio.streamPcm(Int16Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])); // 5 frames
  await flush();
  assert.equal(bridge.bins.length, 1, "first stream sent frame 1 then parked on pacing");

  const p2 = audio.streamPcm(Int16Array.from([11, 12])); // preempts → generation++
  await flush();
  while (gates.length) gates.shift()();                  // wake every parked loop
  await Promise.allSettled([p1, p2]);

  // The superseded stream must NOT have sent its remaining 4 frames.
  assert.ok(bridge.bins.length <= 3, `superseded stream kept sending: ${bridge.bins.length} frames`);
});

// --- speakStream: sentence-chunked gapless streamed speech (HTTP /stream) ---

test("speakStream defers the device until begin(), then paces queued audio as 0x03 frames", async () => {
  const bridge = makeBridge();
  const tts = makeTts();
  const audio = createAudioOut({ bridge, tts, sleep: noSleep, refGen, chunkSamples: 2, firstChars: 1, targetChars: 1 });
  const ctrl = await audio.speakStream({ deferDeviceStart: true });
  tts.feed([1, 0, 2, 0, 3, 0, 4, 0]);  // body for the one chunk → 2 frames @ chunkSamples 2
  ctrl.push("Hello world. ");          // one confirmed sentence → one chunk, synthesized during "generation"
  await flush();
  assert.equal(bridge.cmds("play_audio_start").length, 0, "device not started until begin()");
  assert.equal(audio.isPlaying(), true, "playback is held open across the stream");
  ctrl.begin();
  const r = await ctrl.end();
  assert.equal(bridge.cmds("play_audio_start").length, 1);
  assert.equal(bridge.cmds("play_audio_end").length, 1);
  assert.equal(bridge.bins.length, 2);
  assert.ok(bridge.bins.every((b) => b[0] === 0x03));
  assert.equal(r.frames, 2);
  assert.equal(tts.calls[0].text, "Hello world.");
  await ctrl.done;
  assert.equal(audio.isPlaying(), false, "isPlaying drops only after the device finishes");
});

test("speakStream synthesizes EVERY sentence in order (v3: standalone, no previous_text)", async () => {
  const bridge = makeBridge();
  const tts = makeTts();
  const audio = createAudioOut({ bridge, tts, sleep: noSleep, refGen, chunkSamples: 2, firstChars: 1, targetChars: 1 });
  const ctrl = await audio.speakStream({ deferDeviceStart: true });
  tts.feed([1, 0, 2, 0]);  // chunk 1 → bytes 1,2
  tts.feed([3, 0, 4, 0]);  // chunk 2 → bytes 3,4
  ctrl.begin();
  ctrl.push("One. Two. ");  // two confirmed sentences → two chunks; BOTH must stream
  const r = await ctrl.end();
  assert.deepEqual(tts.calls.map((c) => c.text), ["One.", "Two."]);
  // v3 only: NO previous_text/next_text on any chunk (sending them 400s eleven_v3,
  // which is what cut her off after the first sentence).
  assert.equal(tts.calls[0].opts.previousText, undefined);
  assert.equal(tts.calls[1].opts.previousText, undefined);
  assert.equal(tts.calls[1].opts.nextText, undefined);
  // both chunks reach the device in order — the whole reply is spoken
  assert.deepEqual([...bridge.bins[0]], [0x03, 1, 0, 2, 0]);
  assert.deepEqual([...bridge.bins[1]], [0x03, 3, 0, 4, 0]);
  assert.equal(r.frames, 2);
});

test("speakStream applies the master volume gain", async () => {
  const bridge = makeBridge();
  const tts = makeTts();
  const volume = createVolume({ initialPercent: 200 });
  const audio = createAudioOut({ bridge, tts, volume, sleep: noSleep, refGen, chunkSamples: 2, firstChars: 1, targetChars: 1 });
  const ctrl = await audio.speakStream({ deferDeviceStart: true });
  tts.feed(Int16Array.from([100, -50]).buffer); // one 2-sample frame
  ctrl.begin();
  ctrl.push("Hi there now. ");
  const r = await ctrl.end();
  assert.equal(bridge.bins.length, 1);
  assert.equal(bridge.bins[0].readInt16LE(1), 200);  // 100 × 2.0
  assert.equal(bridge.bins[0].readInt16LE(3), -100); // -50 × 2.0
  assert.equal(r.frames, 1);
});

test("speakStream on an offline device sends no frames and aborts the in-flight synthesis", async () => {
  const bridge = makeBridge({ online: false });
  const tts = makeTts();
  const audio = createAudioOut({ bridge, tts, sleep: noSleep, refGen, chunkSamples: 2, firstChars: 1, targetChars: 1 });
  const ctrl = await audio.speakStream({ deferDeviceStart: true });
  tts.feed([1, 0, 2, 0]);
  ctrl.push("Hello world. ");
  await flush();
  ctrl.begin();
  const r = await ctrl.end();
  assert.equal(r.frames, 0);
  assert.equal(bridge.bins.length, 0);
  assert.equal(tts.calls[0].opts.signal.aborted, true, "device-offline aborts the synthesis fetch");
});

test("aborting before begin() never starts the device (tool-round preamble can't leak)", async () => {
  const bridge = makeBridge();
  const tts = makeTts();
  const audio = createAudioOut({ bridge, tts, sleep: noSleep, refGen, chunkSamples: 2, firstChars: 1, targetChars: 1 });
  const ctrl = await audio.speakStream({ deferDeviceStart: true });
  tts.feed([1, 0, 2, 0]);
  ctrl.push("Let me check. ");   // synthesized but never released to the device
  await flush();
  ctrl.abort();
  await ctrl.done;
  assert.equal(bridge.cmds("play_audio_start").length, 0);
  assert.equal(bridge.bins.length, 0);
  assert.equal(tts.calls[0].opts.signal.aborted, true, "abort cancels the in-flight v3 render");
});

test("speakStream drains audio pushed AFTER an earlier chunk already played (no early exit / no hang)", async () => {
  const bridge = makeBridge();
  const tts = makeTts();
  const audio = createAudioOut({ bridge, tts, sleep: noSleep, refGen, chunkSamples: 2, firstChars: 1, targetChars: 1 });
  const ctrl = await audio.speakStream({ deferDeviceStart: false });
  tts.feed([1, 0, 2, 0]);   // chunk 1
  ctrl.push("One. ");
  await flush();            // worker synthesizes + drain paces chunk 1; worker then parks
  assert.equal(bridge.bins.length, 1);
  tts.feed([3, 0, 4, 0]);   // chunk 2 arrives later
  ctrl.push("Two. ");
  await flush();
  const r = await ctrl.end();
  assert.equal(bridge.bins.length, 2, "both chunks reached the device");
  assert.deepEqual([...bridge.bins[1]], [0x03, 3, 0, 4, 0]);
  assert.equal(r.frames, 2);
});

test("speakStream skips a chunk whose synthesis fails and still speaks the rest", async () => {
  const bridge = makeBridge();
  let n = 0;
  const tts = {
    calls: [],
    stream: async (text, opts = {}) => {
      tts.calls.push({ text, opts });
      n += 1;
      if (n === 2) throw new Error("elevenlabs 400: unsupported_model"); // 2nd chunk fails
      return Readable.from([Buffer.from(n === 1 ? [1, 0, 2, 0] : [5, 0, 6, 0])]);
    },
  };
  const audio = createAudioOut({ bridge, tts, sleep: noSleep, refGen, chunkSamples: 2, firstChars: 1, targetChars: 1 });
  const ctrl = await audio.speakStream({ deferDeviceStart: true });
  ctrl.begin();
  ctrl.push("One. Two. Three. ");   // three sentences → three chunks; chunk 2 throws
  const r = await ctrl.end();
  assert.deepEqual(tts.calls.map((c) => c.text), ["One.", "Two.", "Three."]); // all attempted
  // chunk 1 + chunk 3 reached the device; the failed chunk 2 was skipped, not fatal
  assert.equal(bridge.bins.length, 2);
  assert.deepEqual([...bridge.bins[0]], [0x03, 1, 0, 2, 0]);
  assert.deepEqual([...bridge.bins[1]], [0x03, 5, 0, 6, 0]);
  assert.equal(r.frames, 2);
});

test("a new playback preempts and aborts an in-flight speakStream session", async () => {
  const bridge = makeBridge();
  const tts = makeTts();
  const audio = createAudioOut({ bridge, tts, sleep: noSleep, refGen, chunkSamples: 2, firstChars: 1, targetChars: 1 });
  const ctrl = await audio.speakStream({ deferDeviceStart: true });
  tts.feed([1, 0, 2, 0]);
  ctrl.begin();
  ctrl.push("Hello world. ");
  await flush();
  await audio.streamPcm(Int16Array.from([9, 9]));   // a preempting playback (e.g. her next speak)
  assert.equal(tts.calls[0].opts.signal.aborted, true);
  await ctrl.done;
});

test("speakStream returns null when no streaming TTS is configured", async () => {
  const bridge = makeBridge();
  const audio = createAudioOut({ bridge, tts: {}, sleep: noSleep, refGen });
  assert.equal(await audio.speakStream(), null);
});

// --- spawn-based playback ---
// Tracks exitCode and emits a single `close` on either stdout-end OR kill(), so the
// awaited playYoutubeTrack path resolves even when a track is killed mid-stream
// (user stop / preempt) rather than draining to EOF.
function fakeChild(stdoutChunks, { code = 0 } = {}) {
  const ee = new EventEmitter();
  ee.killed = false;
  ee.exitCode = null;
  let closed = false;
  const close = (c) => { if (closed) return; closed = true; ee.exitCode = c; ee.emit("close", c); };
  ee.stdout = Readable.from(stdoutChunks.map((c) => Buffer.from(c)));
  ee.stderr = Readable.from([]);
  ee.stdin = new Writable({ write(_c, _e, cb) { cb(); } });
  ee.kill = () => { ee.killed = true; process.nextTick(() => close(null)); };
  ee.stdout.on("end", () => process.nextTick(() => close(code)));
  return ee;
}

test("playUrl spawns ffmpeg with 16k mono s16le args and streams stdout", async () => {
  const bridge = makeBridge();
  const spawns = [];
  // 4 samples → 8 bytes; one frame of chunkSamples=4
  const spawn = (cmd, args) => { spawns.push({ cmd, args }); return fakeChild([[1, 0, 2, 0, 3, 0, 4, 0]]); };
  const audio = createAudioOut({ bridge, tts: {}, spawn, sleep: noSleep, refGen, chunkSamples: 4, ffmpegPath: "ffmpeg" });
  await audio.playUrl("http://example.com/a.mp3");
  assert.equal(spawns[0].cmd, "ffmpeg");
  assert.deepEqual(spawns[0].args, ["-i", "http://example.com/a.mp3", "-ac", "1", "-ar", "16000", "-f", "s16le", "-loglevel", "error", "pipe:1"]);
  assert.equal(bridge.bins.length, 1);
  assert.equal(bridge.cmds("play_audio_end").length, 1);
});

test("playYoutube spawns yt-dlp piped into ffmpeg", async () => {
  const bridge = makeBridge();
  const spawns = [];
  const spawn = (cmd, args) => {
    spawns.push({ cmd, args });
    return cmd === "yt-dlp" ? fakeChild([]) : fakeChild([[5, 0, 6, 0]]);
  };
  const audio = createAudioOut({ bridge, tts: {}, spawn, sleep: noSleep, refGen, chunkSamples: 2, ytDlpPath: "yt-dlp", ffmpegPath: "ffmpeg" });
  await audio.playYoutube("https://youtu.be/x");
  assert.equal(spawns[0].cmd, "yt-dlp");
  assert.deepEqual(spawns[0].args, ["-f", "bestaudio", "-o", "-", "--quiet", "https://youtu.be/x"]);
  assert.equal(spawns[1].cmd, "ffmpeg");
  assert.equal(bridge.bins.length, 1);
});

test("musicFilter inserts an -af chain into the ffmpeg decode (playUrl + playYoutube)", async () => {
  const bridge = makeBridge();
  const spawns = [];
  const spawn = (cmd, args) => { spawns.push({ cmd, args }); return cmd === "yt-dlp" ? fakeChild([]) : fakeChild([[1, 0, 2, 0]]); };
  const filter = "acompressor=threshold=0.1:ratio=12,alimiter=limit=0.5:level=false";
  const audio = createAudioOut({ bridge, tts: {}, spawn, sleep: noSleep, refGen, chunkSamples: 2, musicFilter: filter });
  await audio.playUrl("http://example.com/a.mp3");
  assert.deepEqual(spawns[0].args, ["-i", "http://example.com/a.mp3", "-af", filter, "-ac", "1", "-ar", "16000", "-f", "s16le", "-loglevel", "error", "pipe:1"]);
  await audio.playYoutube("https://youtu.be/x");
  assert.equal(spawns[2].cmd, "ffmpeg");
  assert.deepEqual(spawns[2].args, ["-i", "pipe:0", "-af", filter, "-ac", "1", "-ar", "16000", "-f", "s16le", "-loglevel", "error", "pipe:1"]);
});

test("player_client extractor-args are inserted, and a search expr can be the target (fused start)", async () => {
  const bridge = makeBridge();
  const spawns = [];
  const spawn = (cmd, args) => { spawns.push({ cmd, args }); return cmd === "yt-dlp" ? fakeChild([]) : fakeChild([[5, 0, 6, 0]]); };
  const audio = createAudioOut({ bridge, tts: {}, spawn, sleep: noSleep, refGen, chunkSamples: 2, playerClients: "default,android" });
  await audio.playYoutubeTrack("ytsearch1:indian music");   // a search expression, not a URL
  assert.deepEqual(spawns[0].args, [
    "-f", "bestaudio", "--extractor-args", "youtube:player_client=default,android",
    "-I", "1", "-o", "-", "--quiet", "ytsearch1:indian music",
  ]);
});

test("a music-search URL target is pinned to its top result (-I 1); watch URLs are not", async () => {
  // The jukebox's fused cold start hands a music.youtube.com search URL straight
  // to the player; it resolves like a playlist, so without -I 1 yt-dlp would
  // stream the entire songs shelf back-to-back.
  const bridge = makeBridge();
  const spawns = [];
  const spawn = (cmd, args) => { spawns.push({ cmd, args }); return cmd === "yt-dlp" ? fakeChild([]) : fakeChild([[5, 0, 6, 0]]); };
  const audio = createAudioOut({ bridge, tts: {}, spawn, sleep: noSleep, refGen, chunkSamples: 2 });
  await audio.playYoutubeTrack("https://music.youtube.com/search?q=jazz#songs");
  assert.deepEqual(spawns[0].args, ["-f", "bestaudio", "-I", "1", "-o", "-", "--quiet", "https://music.youtube.com/search?q=jazz#songs"]);
  await audio.playYoutubeTrack("https://www.youtube.com/watch?v=abc");
  assert.deepEqual(spawns[2].args, ["-f", "bestaudio", "-o", "-", "--quiet", "https://www.youtube.com/watch?v=abc"]);
});

test("leadIn is a no-op when the speaker is idle — plays immediately", async () => {
  const bridge = makeBridge();
  const spawn = (cmd) => (cmd === "yt-dlp" ? fakeChild([]) : fakeChild([[1, 0, 2, 0], [3, 0, 4, 0]]));
  const audio = createAudioOut({ bridge, tts: {}, spawn, sleep: noSleep, refGen, chunkSamples: 2 });
  const r = await audio.playYoutubeTrack("https://youtu.be/x", { leadIn: true });
  assert.equal(r.reason, "ended");
  assert.equal(r.frames, 2);
  assert.equal(bridge.cmds("play_audio_start").length, 1);
});

test("leadIn waits for the current VOICE playback (the announcement) to finish — no preempt", async () => {
  // The announcement is her voice (the speak/auto-spoken heads-up); the lead-in
  // watches the VOICE channel, so the music takes over right as it ends.
  const bridge = makeBridge();
  const spawn = (cmd) => (cmd === "yt-dlp" ? fakeChild([]) : fakeChild([[5, 0, 6, 0], [7, 0, 8, 0]]));
  // A real (tiny) sleep, not noSleep: the lead-in polls `voice.playing` while the
  // announcement plays out — both need real macrotasks (timers/stream IO) to advance,
  // which a zero-delay microtask flood would starve.
  const tinySleep = () => new Promise((r) => setTimeout(r, 1));
  const audio = createAudioOut({ bridge, tts: {}, spawn, sleep: tinySleep, refGen, chunkSamples: 2 });
  const first = audio.streamPcm(Int16Array.from([1, 2, 3, 4]));          // her announcement (voice)
  const r = await audio.playYoutubeTrack("url-music", { leadIn: true }); // must wait, not talk over
  await first;
  assert.equal(r.reason, "ended", "the music played (it was not superseded)");
  assert.equal(r.frames, 2, "and streamed its full audio");
  // Both played in sequence — the announcement was NOT cut off mid-stream.
  assert.equal(bridge.cmds("play_audio_start").length, 2);
  assert.equal(bridge.cmds("play_audio_end").length, 2);
  assert.deepEqual([...bridge.bins[0]], [0x03, 1, 0, 2, 0]);
  assert.deepEqual([...bridge.bins[1]], [0x03, 3, 0, 4, 0]);
});

// --- playYoutubeTrack: the awaited, reason-reporting variant the jukebox drives ---

test("playYoutubeTrack reports 'ended' and frame count on a clean finish", async () => {
  const bridge = makeBridge();
  const spawn = (cmd) => (cmd === "yt-dlp" ? fakeChild([]) : fakeChild([[1, 0, 2, 0], [3, 0, 4, 0]]));
  const audio = createAudioOut({ bridge, tts: {}, spawn, sleep: noSleep, refGen, chunkSamples: 2 });
  const r = await audio.playYoutubeTrack("https://youtu.be/x");
  assert.equal(r.reason, "ended");
  assert.equal(r.frames, 2);
  assert.equal(bridge.cmds("play_audio_end").length, 1);
});

test("playYoutubeTrack reports 'error' when ffmpeg exits non-zero", async () => {
  const bridge = makeBridge();
  const spawn = (cmd) => (cmd === "yt-dlp" ? fakeChild([]) : fakeChild([[1, 0, 2, 0]], { code: 1 }));
  const audio = createAudioOut({ bridge, tts: {}, spawn, sleep: noSleep, refGen, chunkSamples: 2 });
  const r = await audio.playYoutubeTrack("https://youtu.be/x");
  assert.equal(r.reason, "error");
});

test("playYoutubeTrack reports 'stopped' when the user stops mid-track", async () => {
  const bridge = makeBridge();
  const holder = {};
  let fired = false;
  const spawn = (cmd) => (cmd === "yt-dlp" ? fakeChild([]) : fakeChild([[1, 0, 2, 0], [3, 0, 4, 0]]));
  const audio = createAudioOut({
    bridge, tts: {}, spawn, refGen, chunkSamples: 2,
    sleep: async () => { if (!fired) { fired = true; holder.audio.stop(); } },
  });
  holder.audio = audio;
  const r = await audio.playYoutubeTrack("https://youtu.be/x");
  assert.equal(r.reason, "stopped");
});

test("playYoutubeTrack reports 'superseded' when another MUSIC playback preempts it", async () => {
  const bridge = makeBridge();
  const holder = {};
  let fired = false;
  const spawn = (cmd) => (cmd === "yt-dlp" ? fakeChild([]) : fakeChild([[1, 0, 2, 0], [3, 0, 4, 0]]));
  const audio = createAudioOut({
    bridge, tts: {}, spawn, refGen, chunkSamples: 2,
    sleep: async () => { if (!fired) { fired = true; holder.bP = holder.audio.playYoutubeTrack("https://youtu.be/y"); } },
  });
  holder.audio = audio;
  const r = await audio.playYoutubeTrack("https://youtu.be/x");
  await holder.bP;
  assert.equal(r.reason, "superseded");
});

test("playYoutubeTrack awaits ffmpeg close, not just stdout EOF", async () => {
  const bridge = makeBridge();
  // Children whose close we fire MANUALLY, after stdout has already drained.
  const mkManual = (chunks) => {
    const ee = new EventEmitter();
    ee.killed = false; ee.exitCode = null;
    ee.stdout = Readable.from(chunks.map((c) => Buffer.from(c)));
    ee.stderr = Readable.from([]);
    ee.stdin = new Writable({ write(_c, _e, cb) { cb(); } });
    ee.kill = () => { ee.killed = true; };
    ee.fireClose = (code) => { ee.exitCode = code; ee.emit("close", code); };
    return ee;
  };
  const ytC = mkManual([]);
  const ffC = mkManual([[1, 0, 2, 0]]);
  const spawn = (cmd) => (cmd === "yt-dlp" ? ytC : ffC);
  const audio = createAudioOut({ bridge, tts: {}, spawn, sleep: noSleep, refGen, chunkSamples: 2 });
  let resolved = false;
  const p = audio.playYoutubeTrack("https://youtu.be/x").then((r) => { resolved = true; return r; });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(resolved, false, "should still be awaiting the close events");
  ytC.fireClose(0); ffC.fireClose(0);
  const r = await p;
  assert.equal(resolved, true);
  assert.equal(r.reason, "ended");
});

// --- buffered drain (the anti-lag producer/consumer split) ---
// Wrap an arbitrary stdout stream in the child shape playUrl/playYoutube expect.
// kill() destroys stdout (mirrors SIGKILL closing ffmpeg's pipe) AND fires close,
// so an aborted producer parked in `for await` unblocks instead of hanging.
function fakeChildFromStream(stdout, { code = 0 } = {}) {
  const ee = new EventEmitter();
  ee.killed = false;
  ee.exitCode = null;
  let closed = false;
  const close = (c) => { if (closed) return; closed = true; ee.exitCode = c; ee.emit("close", c); };
  ee.stdout = stdout;
  ee.stderr = Readable.from([]);
  ee.stdin = new Writable({ write(_c, _e, cb) { cb(); } });
  ee.kill = () => { ee.killed = true; try { ee.stdout.destroy(); } catch { /* already */ } process.nextTick(() => close(null)); };
  ee.stdout.on("end", () => process.nextTick(() => close(code)));
  return ee;
}

// A source that yields each burst after an awaited gap (simulates yt-dlp jitter).
async function* stallingStdout(bursts, gapMs) {
  for (const b of bursts) {
    await new Promise((r) => setTimeout(r, gapMs));
    yield Buffer.from(b);
  }
}

function makeGate() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, open: () => resolve() };
}

test("buffered drain delivers every frame in order despite a stalling source", async () => {
  const bridge = makeBridge();
  const stdout = Readable.from(stallingStdout([[1, 0, 2, 0], [3, 0, 4, 0], [5, 0, 6, 0]], 3));
  const spawn = () => fakeChildFromStream(stdout);
  // prebufferMs 0 ⇒ start immediately, so the drain must park on underrun between
  // the source's gaps and resume cleanly — never sending a torn/duplicate frame.
  const audio = createAudioOut({ bridge, tts: {}, spawn, sleep: noSleep, refGen, chunkSamples: 2, prebufferMs: 0 });
  await audio.playUrl("http://example.com/a.mp3");
  assert.equal(bridge.bins.length, 3);
  assert.deepEqual([...bridge.bins[0]], [0x03, 1, 0, 2, 0]);
  assert.deepEqual([...bridge.bins[1]], [0x03, 3, 0, 4, 0]);
  assert.deepEqual([...bridge.bins[2]], [0x03, 5, 0, 6, 0]);
  assert.equal(bridge.cmds("play_audio_start").length, 1);
  assert.equal(bridge.cmds("play_audio_end").length, 1);
});

test("per-track summary logs streaming-health counters (deviceBuf/pauses/queue/underruns/maxGap)", async () => {
  const bridge = makeBridge();
  const logs = [];
  // 8 bytes ⇒ 2 frames at chunkSamples=2 (frameBytes=4). Finite source ⇒ clean exit.
  const spawn = () => fakeChild([[1, 0, 2, 0, 3, 0, 4, 0]]);
  const audio = createAudioOut({ bridge, tts: {}, spawn, sleep: noSleep, refGen, chunkSamples: 2, log: (m) => logs.push(m) });
  await audio.playUrl("http://example.com/a.mp3");
  const summary = logs.find((l) => l.includes("drain done"));
  assert.ok(summary, "a per-track summary line is always logged");
  assert.match(summary, /deviceBuf peak=\d+ \(HIGH=\d+\)/);
  assert.match(summary, /pauses=\d+ pausedMs=\d+/);
  assert.match(summary, /queue min=\d+\/\d+ underruns=0/);   // finite source never underran
  assert.match(summary, /maxGap=\d+ms/);
});

test("summary counts queue underruns when the source stalls mid-track", async () => {
  const bridge = makeBridge();
  const logs = [];
  // prebufferMs 0 ⇒ start immediately, so the drain catches the producer between the
  // source's gaps — each catch-up is one underrun (the source-starvation signal).
  const stdout = Readable.from(stallingStdout([[1, 0, 2, 0], [3, 0, 4, 0], [5, 0, 6, 0]], 3));
  const spawn = () => fakeChildFromStream(stdout);
  const audio = createAudioOut({ bridge, tts: {}, spawn, sleep: noSleep, refGen, chunkSamples: 2, prebufferMs: 0, log: (m) => logs.push(m) });
  await audio.playUrl("http://example.com/a.mp3");
  const summary = logs.find((l) => l.includes("drain done"));
  assert.match(summary, /underruns=[1-9]/, "a stalling source registers ≥1 underrun");
});

test("audioStatsMs>0 emits live audio-stats sampler lines during playback", async () => {
  const bridge = makeBridge();
  const logs = [];
  let t = 0;
  const clock = () => (t += 50);   // each clock() read advances 50ms ⇒ sampler trips per frame
  const spawn = () => fakeChild([[1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0]]);  // 3 frames
  const audio = createAudioOut({
    bridge, tts: {}, spawn, sleep: noSleep, refGen, chunkSamples: 2,
    audioStatsMs: 10, clock, log: (m) => logs.push(m),
  });
  await audio.playUrl("http://example.com/a.mp3");
  assert.ok(logs.some((l) => l.startsWith("audio-stats music ")), "live sampler lines are emitted when enabled");
});

test("audioStatsMs=0 (default) emits NO live sampler lines", async () => {
  const bridge = makeBridge();
  const logs = [];
  const spawn = () => fakeChild([[1, 0, 2, 0, 3, 0, 4, 0]]);
  const audio = createAudioOut({ bridge, tts: {}, spawn, sleep: noSleep, refGen, chunkSamples: 2, log: (m) => logs.push(m) });
  await audio.playUrl("http://example.com/a.mp3");
  assert.ok(!logs.some((l) => l.startsWith("audio-stats ")), "no sampler noise by default");
});

test("buffered drain holds play_audio_start until the pre-buffer fills", async () => {
  const bridge = makeBridge();
  const pt = new PassThrough();
  const spawn = () => fakeChildFromStream(pt);
  // prebufferMs 1000 ⇒ ~32000-byte target; we feed only 4 bytes, so it must wait.
  const audio = createAudioOut({ bridge, tts: {}, spawn, sleep: noSleep, refGen, chunkSamples: 2, prebufferMs: 1000, prebufferTimeoutMs: 100000 });
  const p = audio.playUrl("http://example.com/a.mp3");
  pt.write(Buffer.from([1, 0, 2, 0]));
  await flush();
  assert.equal(bridge.cmds("play_audio_start").length, 0, "must not start before the pre-buffer fills");
  assert.equal(bridge.bins.length, 0);
  pt.end();                              // sourceDone releases the pre-roll → play what we have
  await p;
  assert.equal(bridge.cmds("play_audio_start").length, 1);
  assert.equal(bridge.bins.length, 1);
  assert.equal(bridge.cmds("play_audio_end").length, 1);
});

test("buffered drain applies backpressure (producer stops pulling while the consumer is blocked)", async () => {
  const bridge = makeBridge();
  let pulled = 0;                          // how far the producer has consumed the source
  async function* counted() {
    for (let i = 1; i <= 100; i++) { pulled += 1; yield Buffer.from([i & 0xff, 0, i & 0xff, 0]); }
  }
  // highWaterMark 4 ⇒ the stream pulls from the generator roughly one frame at a
  // time, so `pulled` tracks what the producer actually consumed (no big read-ahead).
  const stdout = Readable.from(counted(), { highWaterMark: 4 });
  const spawn = () => fakeChildFromStream(stdout);
  const gate = makeGate();
  let firstSleep = true;
  const sleep = () => { if (firstSleep) { firstSleep = false; return gate.promise; } return Promise.resolve(); };
  // prebufferMs 0 ⇒ start immediately; maxBufferMs 1 ⇒ ~32-byte queue cap.
  const audio = createAudioOut({ bridge, tts: {}, spawn, sleep, refGen, chunkSamples: 2, prebufferMs: 0, maxBufferMs: 1 });
  const p = audio.playUrl("http://example.com/a.mp3");
  await flush(20);
  // The drain is frozen on the gated first sleep; the queue cap must have parked the
  // producer long before it consumed all 100 source chunks.
  assert.ok(bridge.bins.length < 100, `expected partial drain while gated, got ${bridge.bins.length}`);
  assert.ok(pulled < 100, `backpressure must stop the producer early, but it pulled ${pulled}/100`);
  const pulledWhileGated = pulled;
  gate.open();
  await p;
  assert.equal(bridge.bins.length, 100, "everything drains once the consumer is released");
  assert.ok(pulled > pulledWhileGated, "the producer resumes pulling after the consumer drains");
});

test("buffered drain returns 0 frames and no audio when the device is offline", async () => {
  const bridge = makeBridge({ online: false });
  const spawn = () => fakeChildFromStream(Readable.from([Buffer.from([1, 0, 2, 0])]));
  const audio = createAudioOut({ bridge, tts: {}, spawn, sleep: noSleep, refGen, chunkSamples: 2 });
  await audio.playUrl("http://example.com/a.mp3"); // resolves (no hang)
  assert.equal(bridge.bins.length, 0);
  assert.equal(bridge.cmds("play_audio_start").length, 1, "start is attempted once");
});

test("playYoutubeTrack reports 0 frames when the device is offline (jukebox bails)", async () => {
  const bridge = makeBridge({ online: false });
  const spawn = (cmd) => (cmd === "yt-dlp" ? fakeChild([]) : fakeChild([[1, 0, 2, 0]]));
  const audio = createAudioOut({ bridge, tts: {}, spawn, sleep: noSleep, refGen, chunkSamples: 2 });
  const r = await audio.playYoutubeTrack("https://youtu.be/x");
  assert.equal(r.frames, 0);
});

test("buffered drain sends nothing when aborted during the pre-buffer", async () => {
  const bridge = makeBridge();
  const pt = new PassThrough();
  const holder = {};
  const spawn = () => fakeChildFromStream(pt);
  const audio = createAudioOut({ bridge, tts: {}, spawn, sleep: noSleep, refGen, chunkSamples: 2, prebufferMs: 1000, prebufferTimeoutMs: 100000 });
  holder.audio = audio;
  const p = audio.playUrl("http://example.com/a.mp3");
  pt.write(Buffer.from([1, 0, 2, 0]));   // not enough to fill the pre-buffer
  await flush();
  assert.equal(bridge.cmds("play_audio_start").length, 0, "still parked in the pre-roll");
  audio.stop();                          // abort while pre-buffering
  await p;                               // must resolve (producer tied off)
  assert.equal(bridge.cmds("play_audio_start").length, 0, "never started");
  assert.equal(bridge.bins.length, 0);
});

test("buffered drain stops sending frames after an abort mid-stream", async () => {
  const bridge = makeBridge();
  const holder = {};
  let fired = false;
  const spawn = () => fakeChildFromStream(Readable.from([
    Buffer.from([1, 0, 2, 0]), Buffer.from([3, 0, 4, 0]), Buffer.from([5, 0, 6, 0]),
  ]));
  const audio = createAudioOut({
    bridge, tts: {}, spawn, refGen, chunkSamples: 2, prebufferMs: 0,
    sleep: async () => { if (!fired) { fired = true; holder.audio.stop(); } },
  });
  holder.audio = audio;
  await audio.playUrl("http://example.com/a.mp3");
  assert.ok(bridge.bins.length < 3, `expected early abort, got ${bridge.bins.length} frames`);
});

test("buffered drain starts after the pre-buffer timeout even if the source stalls", async () => {
  const bridge = makeBridge();
  const pt = new PassThrough();
  const spawn = () => fakeChildFromStream(pt);
  const audio = createAudioOut({ bridge, tts: {}, spawn, sleep: noSleep, refGen, chunkSamples: 2, prebufferMs: 1000, prebufferTimeoutMs: 30 });
  const p = audio.playUrl("http://example.com/a.mp3");
  pt.write(Buffer.from([1, 0, 2, 0]));   // less than the pre-buffer; stream stays open
  await new Promise((r) => setTimeout(r, 60)); // wait past the timeout
  assert.equal(bridge.cmds("play_audio_start").length, 1, "the timeout must start playback");
  assert.equal(bridge.bins.length, 1, "and play the little it has");
  pt.end();
  await p;
  assert.equal(bridge.cmds("play_audio_end").length, 1);
});

// ---- pause / resume (MUSIC channel only: the jukebox pause tool) ----

// A sleep that pauses the drain on the FIRST pacing gap (after frame 1) so the
// next frame parks on the resume gate — a deterministic mid-stream freeze.
function pauseAfterFirstFrame(holder) {
  let first = true;
  return async () => { if (first) { first = false; holder.audio.pause(); } };
}

test("pause freezes the music drain on a frame boundary; resume continues it", async () => {
  const bridge = makeBridge();
  const holder = {};
  const spawn = () => fakeChild([[1, 0, 2, 0], [3, 0, 4, 0], [5, 0, 6, 0], [7, 0, 8, 0]]); // 4 frames
  const audio = createAudioOut({ bridge, tts: {}, spawn, refGen, chunkSamples: 2, sleep: pauseAfterFirstFrame(holder), prebufferMs: 0 });
  holder.audio = audio;
  const p = audio.playUrl("http://x");
  await flush();
  assert.equal(bridge.bins.length, 1);                     // frozen after frame 1
  assert.equal(audio.isPaused(), true);
  assert.equal(audio.isPlaying(), false);                  // music never closes the her-voice gate
  assert.equal(bridge.cmds("play_audio_end").length, 1);   // pause silenced the device
  audio.resume();
  await p;
  assert.equal(bridge.bins.length, 4);                     // resumed → all frames sent in order
  assert.equal(audio.isPaused(), false);
  assert.equal(bridge.cmds("play_audio_start").length, 2); // initial + lazy re-arm after resume
});

test("stop() while paused unwinds the drain (no resume needed)", async () => {
  const bridge = makeBridge();
  const holder = {};
  const spawn = () => fakeChild([[1, 0, 2, 0], [3, 0, 4, 0], [5, 0, 6, 0], [7, 0, 8, 0]]);
  const audio = createAudioOut({ bridge, tts: {}, spawn, refGen, chunkSamples: 2, sleep: pauseAfterFirstFrame(holder), prebufferMs: 0 });
  holder.audio = audio;
  const p = audio.playUrl("http://x");
  await flush();
  assert.equal(audio.isPaused(), true);
  audio.stop();                       // hard stop while frozen
  await p;                            // must resolve, not hang
  assert.ok(bridge.bins.length < 4, `expected early stop, got ${bridge.bins.length} frames`);
  assert.equal(audio.isPaused(), false);
  assert.equal(audio.isPlaying(), false);
});

test("starting a new MUSIC playback clears a pause freeze and supersedes", async () => {
  const bridge = makeBridge();
  const holder = {};
  let calls = 0;
  const spawn = () => { calls += 1; return calls === 1 ? fakeChild([[1, 0, 2, 0], [3, 0, 4, 0]]) : fakeChild([[9, 0, 10, 0]]); };
  const audio = createAudioOut({ bridge, tts: {}, spawn, refGen, chunkSamples: 2, sleep: pauseAfterFirstFrame(holder), prebufferMs: 0 });
  holder.audio = audio;
  const p1 = audio.playUrl("http://one");
  await flush();
  assert.equal(audio.isPaused(), true);
  const p2 = audio.playUrl("http://two");      // preempts → clears the freeze
  await flush();
  assert.equal(audio.isPaused(), false);
  await p2;
  await p1.catch(() => {});                    // let the superseded stream unwind
  assert.deepEqual([...bridge.bins.at(-1)], [0x03, 9, 0, 10, 0], "the new playback's audio went out");
});

test("pause/resume are no-ops when nothing is playing", () => {
  const bridge = makeBridge();
  const audio = createAudioOut({ bridge, tts: {}, sleep: noSleep, refGen });
  assert.equal(audio.pause(), false);
  assert.equal(audio.resume(), false);
  assert.equal(audio.isPaused(), false);
});

// ---- post-speech echo-tail mic hold-off (isPlayingOrTail) ----
// The server clears `playing` the instant its drain loop ends, but the device ring +
// DMA + room reverb keep emitting briefly. isPlayingOrTail() reports true for tailMs
// AFTER playback ends so the echo gate stays closed through that acoustic tail and
// her own decaying voice can't be transcribed back to her.

test("isPlayingOrTail holds the gate closed for tailMs after playback, then opens", async () => {
  const bridge = makeBridge();
  const tts = makeTts();
  let nowMs = 1000;
  const audio = createAudioOut({ bridge, tts, sleep: noSleep, refGen, chunkSamples: 2, firstChars: 1, targetChars: 1, clock: () => nowMs, tailMs: 500 });
  const ctrl = await audio.speakStream({ deferDeviceStart: true });
  tts.feed([1, 0, 2, 0]);
  ctrl.push("Hi. ");
  ctrl.begin();
  await ctrl.end();
  await ctrl.done;
  assert.equal(audio.isPlaying(), false, "playback finished");
  assert.equal(audio.isPlayingOrTail(), true, "tail keeps the gate closed right after playback");
  nowMs += 499;
  assert.equal(audio.isPlayingOrTail(), true, "still within the tail window");
  nowMs += 2;                                            // 501 ms past end
  assert.equal(audio.isPlayingOrTail(), false, "tail elapsed → gate opens");
});

test("isPlayingOrTail is true during playback (gated while she speaks, like isPlaying)", async () => {
  const bridge = makeBridge();
  const tts = makeTts();
  const audio = createAudioOut({ bridge, tts, sleep: noSleep, refGen, chunkSamples: 2, firstChars: 1, targetChars: 1, tailMs: 500 });
  const ctrl = await audio.speakStream({ deferDeviceStart: true });
  tts.feed([1, 0, 2, 0]);
  ctrl.push("Hi. ");
  await flush();
  assert.equal(audio.isPlayingOrTail(), true, "held open across the stream");
  ctrl.begin();
  await ctrl.end();
  await ctrl.done;
});

test("tailMs=0 ⇒ no reverb margin (gate opens as soon as the device buffer drains)", async () => {
  const bridge = makeBridge();
  const tts = makeTts();
  let nowMs = 1000;
  const audio = createAudioOut({ bridge, tts, sleep: noSleep, refGen, chunkSamples: 2, firstChars: 1, targetChars: 1, clock: () => nowMs, tailMs: 0 });
  const ctrl = await audio.speakStream({ deferDeviceStart: true });
  tts.feed([1, 0, 2, 0]);
  ctrl.push("Hi. ");
  ctrl.begin();
  await ctrl.end();
  await ctrl.done;
  nowMs += 1;                                            // past the sub-ms device buffer for this tiny clip
  assert.equal(audio.isPlayingOrTail(), false, "no extra margin when tailMs=0");
});

test("the hold-off covers audio still BUFFERED on the device (sent faster than realtime)", async () => {
  // The drain sends faster than realtime, so at drain-end the device still has unplayed
  // audio buffered. The gate must stay closed until that buffer would finish playing —
  // (sent − played) — plus the tailMs margin, NOT just a flat tailMs (which leaks the
  // last word for short clips). chunkSamples 1600 = 100ms/frame; sleep advances the
  // clock 40ms/frame, so each 100ms frame is "sent" in 40ms → the device falls behind.
  const bridge = makeBridge();
  let nowMs = 0;
  const audio = createAudioOut({
    bridge, tts: {}, refGen, chunkSamples: 1600,
    clock: () => nowMs,
    sleep: async () => { nowMs += 40; },
    tailMs: 100,
  });
  await audio.streamPcm(new Int16Array(8000));   // 5 frames = 8000 samples = 500ms of audio
  // 5 frames, 4 inter-frame sleeps → clock at drain-end = 160ms. sentMs=500, playedMs=160,
  // bufferedMs=340 → recentlyPlayedUntil = 160 + 340 + 100(margin) = 600ms.
  assert.equal(audio.isPlaying(), false);
  assert.equal(audio.isPlayingOrTail(), true, "device still draining the buffered audio");
  nowMs = 599;
  assert.equal(audio.isPlayingOrTail(), true, "still within buffer-drain + margin (a flat 100ms tail would have leaked here)");
  nowMs = 601;
  assert.equal(audio.isPlayingOrTail(), false, "buffer drained + margin elapsed → gate opens");
});

test("a hard stop flushes the device buffer ⇒ the hold-off doesn't wait for the dropped audio", async () => {
  // hardStop() flushes the device ring, so the buffered (unplayed) audio never comes out.
  // The hold-off must NOT keep the gate closed for it — only the reverb margin applies —
  // so the mic re-engages promptly when she's interrupted.
  const bridge = makeBridge();
  let nowMs = 0;
  const holder = {};
  const audio = createAudioOut({
    bridge, tts: {}, refGen, chunkSamples: 1600,
    clock: () => nowMs,
    sleep: async () => { nowMs += 40; holder.audio.hardStop(); },   // hard-cut after frame 1
    tailMs: 100,
  });
  holder.audio = audio;
  await audio.streamPcm(new Int16Array(8000));   // would be 5 frames; hardStop cuts it after 1
  // frame1 at nowMs=0 (sent 100ms), then sleep→40 + hardStop (flush). drain-end clock=40.
  // flushed ⇒ bufferedMs forced to 0 ⇒ recentlyPlayedUntil = 40 + 0 + 100 = 140 (NOT 40+60+100=200).
  assert.equal(audio.isPlayingOrTail(), true, "still within the reverb margin");
  nowMs = 150;
  assert.equal(audio.isPlayingOrTail(), false, "flush ⇒ gate reopens after the margin, not the dropped buffer");
});

// ---- transmit gate: PTT mute ----

test("mute() before playback: frames drop, device flushed once, never armed", async () => {
  const bridge = makeBridge();
  const audio = createAudioOut({ bridge, tts: {}, sleep: noSleep, refGen, chunkSamples: 2 });
  audio.mute();
  const frames = await audio.streamPcm(Int16Array.from([1, 2, 3, 4]));
  assert.equal(frames, 2);                                   // playback "ran" silently
  assert.equal(bridge.bins.length, 0);                       // nothing transmitted
  assert.equal(bridge.cmds("stop_audio").length, 1);         // the mute flush
  assert.equal(bridge.cmds("play_audio_start").length, 0);   // never armed
  assert.equal(bridge.cmds("play_audio_end").length, 0);     // never armed ⇒ nothing to end
});

test("mute mid-stream drops frames; unmute re-arms with a fresh play_audio_start", async () => {
  const bridge = makeBridge();
  const holder = {};
  let n = 0;
  const audio = createAudioOut({
    bridge, tts: {}, refGen, chunkSamples: 2,
    sleep: async () => { n += 1; if (n === 1) holder.audio.mute(); if (n === 2) holder.audio.unmute(); },
  });
  holder.audio = audio;
  const frames = await audio.streamPcm(Int16Array.from([1, 2, 3, 4, 5, 6, 7, 8])); // 4 frames
  assert.equal(frames, 4);
  assert.equal(bridge.bins.length, 3);                       // frame 2 dropped while muted
  assert.equal(bridge.cmds("stop_audio").length, 1);
  assert.equal(bridge.cmds("play_audio_start").length, 2);   // initial arm + re-arm after unmute
});

test("mute() is idempotent (one flush) and isMuted() reports state", async () => {
  const bridge = makeBridge();
  const audio = createAudioOut({ bridge, tts: {}, sleep: noSleep, refGen });
  assert.equal(audio.isMuted(), false);
  audio.mute(); audio.mute();
  assert.equal(audio.isMuted(), true);
  assert.equal(bridge.cmds("stop_audio").length, 1);
  audio.unmute();
  assert.equal(audio.isMuted(), false);
});

test("dropped frames are throttled at realtime (frame duration), not pacingMs", async () => {
  const bridge = makeBridge();
  const sleeps = [];
  const audio = createAudioOut({
    bridge, tts: {}, refGen, chunkSamples: 1600, pacingMs: 80,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  audio.mute();
  await audio.streamPcm(new Int16Array(4800)); // 3 × 1600-sample frames = 100 ms each
  assert.deepEqual(sleeps, [100, 100]);        // frameMs, not 80 (no sleep after the last frame)
});

test("music drain paces sent frames at musicPacingMs (not the faster voice pacingMs)", async () => {
  // Over-delivering a long track at the 1.6x voice rate overflows the device ring
  // (dropped frames / choppy); music must pace near realtime instead.
  const bridge = makeBridge();
  const sleeps = [];
  // 8 bytes ⇒ 2 frames at chunkSamples=2. No deviceBufferedAmount ⇒ no drain-poll sleeps,
  // so every captured sleep is the inter-frame music pacing.
  const spawn = () => fakeChild([[1, 0, 2, 0, 3, 0, 4, 0]]);
  const audio = createAudioOut({
    bridge, tts: {}, spawn, refGen, chunkSamples: 2,
    pacingMs: 83, musicPacingMs: 100,   // 100 is within the music-pace clamp [80,136]
    sleep: async (ms) => { sleeps.push(ms); },
  });
  await audio.playUrl("http://example.com/a.mp3");
  assert.ok(sleeps.length >= 1, "music drain sleeps between frames");
  assert.ok(sleeps.every((s) => s === 100), `music paces at musicPacingMs, saw ${sleeps}`);
  assert.ok(!sleeps.includes(83), "music must not use the voice pacingMs");
});

test("setMusicPacingMs changes the live pace, clamps to bounds, and fires onChange", async () => {
  const bridge = makeBridge();
  const changes = [];
  const audio = createAudioOut({
    bridge, tts: {}, refGen, chunkSamples: 2, musicPacingMs: 120,
    onMusicPacingChange: (ms) => changes.push(ms),
  });
  const { min, max } = audio.musicPacingBounds();
  assert.equal(min, 80);
  assert.equal(max, 136);
  assert.equal(audio.getMusicPacingMs(), 120, "starts at the configured default");

  assert.equal(audio.setMusicPacingMs(100), 100);
  assert.equal(audio.getMusicPacingMs(), 100);
  assert.equal(audio.setMusicPacingMs(9999), max, "clamps above MAX");
  assert.equal(audio.setMusicPacingMs(1), min, "clamps below MIN");
  assert.deepEqual(changes, [100, 136, 80], "onChange fires once per real change");

  const before = changes.length;
  audio.setMusicPacingMs(80);                 // already 80 → no-op
  assert.equal(changes.length, before, "no onChange when the value is unchanged");
});

test("a mid-track setMusicPacingMs takes effect on the next frame", async () => {
  const bridge = makeBridge();
  const sleeps = [];
  let audio;
  // Flip the pace from the first frame's sleep; the remaining frames must use the new value.
  const spawn = () => fakeChild([[1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0]]);  // 3 frames
  audio = createAudioOut({
    bridge, tts: {}, spawn, refGen, chunkSamples: 2, musicPacingMs: 120,
    sleep: async (ms) => { sleeps.push(ms); if (sleeps.length === 1) audio.setMusicPacingMs(90); },
  });
  await audio.playUrl("http://example.com/a.mp3");
  assert.equal(sleeps[0], 120, "first frame used the old pace");
  assert.ok(sleeps.slice(1).every((s) => s === 90), `later frames pick up the change live, saw ${sleeps}`);
});

test("voice (streamPcm) paces at ttsPacingMs, unaffected by musicPacingMs", async () => {
  const bridge = makeBridge();
  const sleeps = [];
  const audio = createAudioOut({
    bridge, tts: {}, refGen, chunkSamples: 2,
    ttsPacingMs: 96, musicPacingMs: 137,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  await audio.streamPcm(Int16Array.from([1, 2, 3, 4]));   // 2 frames ⇒ 1 inter-frame sleep
  assert.deepEqual(sleeps, [96], "voice uses ttsPacingMs; the music knob does not touch it");
});

test("setTtsPacingMs changes the live voice pace, clamps to bounds, and fires onChange", async () => {
  const bridge = makeBridge();
  const changes = [];
  const audio = createAudioOut({
    bridge, tts: {}, refGen, chunkSamples: 2, ttsPacingMs: 80,
    onTtsPacingChange: (ms) => changes.push(ms),
  });
  const { min, max } = audio.ttsPacingBounds();
  assert.equal(min, 64);
  assert.equal(max, 128);
  assert.equal(audio.getTtsPacingMs(), 80, "starts at the configured default");

  assert.equal(audio.setTtsPacingMs(100), 100);
  assert.equal(audio.getTtsPacingMs(), 100);
  assert.equal(audio.setTtsPacingMs(9999), max, "clamps above MAX");
  assert.equal(audio.setTtsPacingMs(1), min, "clamps below MIN");
  assert.deepEqual(changes, [100, 128, 64], "onChange fires once per real change");

  const before = changes.length;
  audio.setTtsPacingMs(64);                   // already 64 → no-op
  assert.equal(changes.length, before, "no onChange when the value is unchanged");
});

test("a setTtsPacingMs change takes effect on the next voice frame, and is independent of music pace", async () => {
  const bridge = makeBridge();
  const sleeps = [];
  let audio;
  audio = createAudioOut({
    bridge, tts: {}, refGen, chunkSamples: 2, ttsPacingMs: 80, musicPacingMs: 128,
    sleep: async (ms) => { sleeps.push(ms); if (sleeps.length === 1) audio.setTtsPacingMs(110); },
  });
  await audio.streamPcm(Int16Array.from([1, 2, 3, 4, 5, 6]));   // 3 frames ⇒ 2 inter-frame sleeps
  assert.equal(sleeps[0], 80, "first frame used the old voice pace");
  assert.ok(sleeps.slice(1).every((s) => s === 110), `later frames pick up the change live, saw ${sleeps}`);
});

test("isPlaying/isPlayingOrTail go false while muted (mic gate opens) and recover on unmute", async () => {
  const bridge = makeBridge();
  const holder = {};
  let n = 0;
  const states = [];
  const audio = createAudioOut({
    bridge, tts: {}, refGen, chunkSamples: 2,
    sleep: async () => {
      n += 1;
      if (n === 1) { states.push(holder.audio.isPlaying()); holder.audio.mute(); states.push(holder.audio.isPlaying(), holder.audio.isPlayingOrTail()); }
      if (n === 2) { holder.audio.unmute(); states.push(holder.audio.isPlaying()); }
    },
  });
  holder.audio = audio;
  await audio.streamPcm(Int16Array.from([1, 2, 3, 4, 5, 6, 7, 8]));
  assert.deepEqual(states, [true, false, false, true]);
});

test("mute excludes dropped frames from the echo-tail estimate (sentSamples)", async () => {
  const bridge = makeBridge();
  let now = 0;
  const clock = () => now;
  const audio = createAudioOut({ bridge, tts: {}, sleep: noSleep, refGen, chunkSamples: 2, clock, tailMs: 0 });
  audio.mute();
  await audio.streamPcm(new Int16Array(32)); // 16 frames, ALL dropped
  // Nothing transmitted ⇒ no buffered tail ⇒ the gate must not be held closed.
  audio.unmute();
  assert.equal(audio.isPlayingOrTail(), false);
});

test("a prior stop() must not kill the NEXT lead-in track (stale userStopped)", async () => {
  // Regression: stop()/hardStop() set music.userStopped, which was only cleared
  // inside withPlayback — but the lead-in path reads it BEFORE withPlayback runs,
  // so a fresh "play X" after any earlier stop was killed pre-frame and reported
  // {reason:"stopped", frames:0}, ending the jukebox session before a single frame.
  const bridge = makeBridge();
  const spawn = (cmd) => (cmd === "yt-dlp" ? fakeChild([]) : fakeChild([[1, 0, 2, 0], [3, 0, 4, 0]]));
  const audio = createAudioOut({ bridge, tts: {}, spawn, sleep: noSleep, refGen, chunkSamples: 2 });
  audio.stop();                                  // an earlier session was stopped
  const r = await audio.playYoutubeTrack("https://youtu.be/x", { leadIn: true });
  assert.equal(r.reason, "ended", "a new playback request supersedes the old stop");
  assert.equal(r.frames, 2);
});

test("hardStop() then a lead-in playYoutube still claims the device (stale userStopped)", async () => {
  const bridge = makeBridge();
  const spawn = (cmd) => (cmd === "yt-dlp" ? fakeChild([]) : fakeChild([[1, 0, 2, 0]]));
  const audio = createAudioOut({ bridge, tts: {}, spawn, sleep: noSleep, refGen, chunkSamples: 2 });
  audio.hardStop();
  await audio.playYoutube("https://youtu.be/x", { leadIn: true });
  assert.equal(bridge.bins.length, 1, "the fresh pipeline streamed (not killed by the stale stop)");
});

test("mute() mid-reply resets the tail accounting — flushed audio adds no phantom tail", async () => {
  // Regression: mute() flushes the device ring (stop_audio) but left
  // sentSamples/playStartedAt untouched, so transmitted-then-flushed audio still
  // inflated bufferedMs → after unmute, isPlayingOrTail() over-held the mic gate
  // for audio that never sounded.
  const bridge = makeBridge();
  let nowMs = 0;
  const holder = {};
  let mutedOnce = false;
  const audio = createAudioOut({
    bridge, tts: {}, refGen, chunkSamples: 1600,   // 100 ms/frame
    clock: () => nowMs,
    sleep: async () => { nowMs += 10; if (!mutedOnce) { mutedOnce = true; holder.audio.mute(); } },
    tailMs: 0,
  });
  holder.audio = audio;
  // 5 frames (500 ms of audio): frame 1 transmits (then flushed by mute), rest drop.
  await audio.streamPcm(new Int16Array(8000));
  audio.unmute();
  assert.equal(audio.isPlaying(), false);
  assert.equal(audio.isPlayingOrTail(), false, "flushed audio must not hold the mic gate");
});

test("offline discovered at re-arm aborts the stream (one start attempt, no frame drain)", async () => {
  // Regression: when arm() failed inside sendFrame (device offline mid-stream, e.g.
  // after a mute/unmute disarm), the loop kept retrying play_audio_start every frame
  // and drained the whole pipeline against a dead bridge — frames > 0 defeated the
  // jukebox's frames===0 offline bail.
  const bridge = makeBridge();
  const holder = {};
  let n = 0;
  const audio = createAudioOut({
    bridge, tts: {}, refGen, chunkSamples: 2,
    sleep: async () => {
      n += 1;
      if (n === 1) { holder.audio.mute(); holder.audio.unmute(); bridge.online = false; }
    },
  });
  holder.audio = audio;
  const frames = await audio.streamPcm(new Int16Array(40));   // would be 20 frames
  assert.ok(frames < 20, `offline must abort the stream, but it drained ${frames}/20 frames`);
  // initial arm + exactly ONE failed re-arm attempt after going offline
  assert.equal(bridge.cmds("play_audio_start").length, 2);
});

// ---- voice over music: focus handoff + rejoin live ----

test("her reply over music: music drains silently (dropped, realtime-throttled) and is NOT superseded", async () => {
  const bridge = makeBridge();
  const stdout = new PassThrough();
  const proc = fakeChildFromStream(stdout);   // reuses the buffered-drain fake (emits close on end/kill)
  // tts body kept open so her reply is verifiably IN FLIGHT while the music frame lands.
  const ttsBody = new PassThrough();
  const audio = createAudioOut({
    bridge, tts: { stream: async () => ttsBody },
    spawn: () => proc, refGen, chunkSamples: 2, sleep: noSleep,
    prebufferMs: 0, prebufferTimeoutMs: 1,
  });
  const musicP = audio.playUrl("http://radio");
  stdout.write(Buffer.from([5, 0, 6, 0]));        // music frame 1 → transmits
  await flush(10);
  const musicBinsBefore = bridge.bins.length;
  assert.ok(musicBinsBefore >= 1, "music transmitted before her reply");

  const speakP = audio.speak("hi");                // voice takes focus
  await flush(10);
  ttsBody.write(Buffer.from([1, 0, 2, 0]));       // her first audio bytes
  await flush(10);
  assert.equal(audio.isPlaying(), true, "her reply is in flight");
  stdout.write(Buffer.from([7, 0, 8, 0]));        // music frame DURING her reply → dropped
  await flush(10);
  ttsBody.end();                                   // her reply finishes
  await speakP;                                    // voice playback complete

  stdout.write(Buffer.from([9, 0, 10, 0]));       // music transmits again (rejoined)
  await flush(10);
  stdout.end();
  await musicP;                                    // resolves normally — never superseded/aborted

  // The dropped middle frame ([7,0,8,0]) must not appear in the transmitted bins.
  const payloads = bridge.bins.map((b) => [...b.subarray(1)].join(","));
  assert.ok(!payloads.includes("7,0,8,0"), "music frame leaked through while voice had focus");
  assert.ok(payloads.includes("9,0,10,0"), "music rejoined after her reply");
  assert.ok(bridge.cmds("stop_audio").length >= 1, "voice flushed music's buffered tail when taking the device");
  assert.ok(bridge.cmds("play_audio_start").length >= 3, "music start + voice start + music re-arm");
});

test("playYoutubeTrack is no longer superseded by a voice playback (cross-channel)", async () => {
  const bridge = makeBridge();
  const holder = {};
  let fired = false;
  const spawn = (cmd) => (cmd === "yt-dlp" ? fakeChild([]) : fakeChild([[1, 0, 2, 0], [3, 0, 4, 0]]));
  const audio = createAudioOut({
    bridge, tts: {}, spawn, refGen, chunkSamples: 2,
    sleep: async () => { if (!fired) { fired = true; holder.vP = holder.audio.streamPcm(Int16Array.from([9, 9])); } },
  });
  holder.audio = audio;
  const r = await audio.playYoutubeTrack("https://youtu.be/x");
  await holder.vP;
  assert.equal(r.reason, "ended", "a voice playback must not supersede a music track");
  assert.equal(r.frames, 2, "the track ran to completion (silent-while-unfocused frames still count)");
});

test("isPlayingOrTail is false while music is paused (gate open to speak over parked media)", async () => {
  const bridge = makeBridge();
  const holder = {};
  const spawn = () => fakeChild([[1, 0, 2, 0], [3, 0, 4, 0]]);
  const audio = createAudioOut({ bridge, tts: {}, spawn, refGen, chunkSamples: 2, sleep: pauseAfterFirstFrame(holder), tailMs: 500, prebufferMs: 0 });
  holder.audio = audio;
  const p = audio.playUrl("http://x");
  await flush();
  assert.equal(audio.isPaused(), true);
  assert.equal(audio.isPlayingOrTail(), false, "music (parked or not) never closes the her-voice echo gate");
  audio.resume();
  await p;
});

// ---- ducking: music mixes under her voice at duckPercent ----

const i16buf = (...vals) => { const b = Buffer.alloc(vals.length * 2); vals.forEach((v, i) => b.writeInt16LE(v, i * 2)); return b; };

// Shared scaffold: music (playUrl via PassThrough) + her reply (speak via PassThrough
// tts body), chunkSamples 2. Returns the moving parts.
function duckRig({ duckPercent, pttDuckPercent } = {}) {
  const bridge = makeBridge();
  const stdout = new PassThrough();
  const proc = fakeChildFromStream(stdout);
  const ttsBody = new PassThrough();
  const audio = createAudioOut({
    bridge, tts: { stream: async () => ttsBody },
    spawn: () => proc, refGen, chunkSamples: 2, sleep: noSleep,
    prebufferMs: 0, prebufferTimeoutMs: 1,
    ...(duckPercent !== undefined ? { duckPercent } : {}),
    ...(pttDuckPercent !== undefined ? { pttDuckPercent } : {}),
  });
  const payloads = () => bridge.bins.map((b) => {
    const out = [];
    for (let i = 1; i + 1 < b.length; i += 2) out.push(b.readInt16LE(i));
    return out;
  });
  return { bridge, stdout, ttsBody, audio, payloads };
}

test("music ducks under her voice: dropped music frames mix into voice frames at duckPercent", async () => {
  const { audio, stdout, ttsBody, payloads } = duckRig();   // default duckPercent 20
  const musicP = audio.playUrl("http://radio");
  stdout.write(i16buf(5, 6));                    // music focused → transmits
  await flush(10);
  const speakP = audio.speak("hi");              // voice takes focus
  await flush(10);
  stdout.write(i16buf(1000, -1000));             // music frame DURING her reply → banked for the bed
  await flush(10);
  ttsBody.write(i16buf(100, -50));               // her audio frame → mixes the bed in
  await flush(10);
  ttsBody.end(); await speakP;
  stdout.end(); await musicP;
  // Convex blend: round(100×0.8 + 1000×0.2) = 280; round(-50×0.8 + -1000×0.2) = -240.
  assert.ok(payloads().some((p) => p[0] === 280 && p[1] === -240),
    `expected a mixed voice frame, got ${JSON.stringify(payloads())}`);
});

test("the duck mix can't clip: a convex blend stays within the voice's own peak", async () => {
  const { audio, stdout, ttsBody, payloads } = duckRig();
  const musicP = audio.playUrl("http://radio");
  stdout.write(i16buf(5, 6)); await flush(10);
  const speakP = audio.speak("hi"); await flush(10);
  stdout.write(i16buf(30000, -30000)); await flush(10);     // hot bed
  ttsBody.write(i16buf(32000, -32000)); await flush(10);    // hot voice
  ttsBody.end(); await speakP; stdout.end(); await musicP;
  // Old additive mix (voice + bed×0.2) summed to ±38000 and hard-clipped to the rails,
  // garbling her voice. The convex blend round(32000×0.8 + 30000×0.2) = 31600 stays
  // BELOW the rail — the bed introduces no clipping her own voice didn't already have.
  assert.ok(payloads().some((p) => p[0] === 31600 && p[1] === -31600),
    `expected an unclipped convex blend, got ${JSON.stringify(payloads())}`);
  assert.ok(!payloads().some((p) => p[0] === 32767 || p[1] === -32768),
    `the bed must not push the mix to the rails, got ${JSON.stringify(payloads())}`);
});

test("mute() clears the duck queue and muted music frames are never banked", async () => {
  // pttDuckPercent 0: this test exercises the FULL-mute banking behavior — with
  // the PTT duck on, the muted music frame would (correctly) transmit ducked.
  const { audio, stdout, ttsBody, payloads } = duckRig({ pttDuckPercent: 0 });
  const musicP = audio.playUrl("http://radio");
  stdout.write(i16buf(5, 6)); await flush(10);
  const speakP = audio.speak("hi"); await flush(10);
  stdout.write(i16buf(1000, 1000)); await flush(10);  // banked…
  audio.mute();                                        // …then PTT: queue cleared
  stdout.write(i16buf(2000, 2000)); await flush(10);  // dropped while muted: NOT banked
  audio.unmute();
  ttsBody.write(i16buf(100, -50)); await flush(10);
  ttsBody.end(); await speakP; stdout.end(); await musicP;
  assert.ok(payloads().some((p) => p[0] === 100 && p[1] === -50),
    `expected a pure voice frame after mute cleared the bed, got ${JSON.stringify(payloads())}`);
  assert.ok(!payloads().some((p) => p[0] === 280 || p[0] === 480),
    "stale bed leaked through the mute");
});

test("the duck queue does not leak across voice playbacks", async () => {
  const bridge = makeBridge();
  const stdout = new PassThrough();
  const proc = fakeChildFromStream(stdout);
  const bodies = [new PassThrough(), new PassThrough()];
  let bi = 0;
  const audio = createAudioOut({
    bridge, tts: { stream: async () => bodies[bi++] },
    spawn: () => proc, refGen, chunkSamples: 2, sleep: noSleep,
    prebufferMs: 0, prebufferTimeoutMs: 1,
  });
  const musicP = audio.playUrl("http://radio");
  stdout.write(i16buf(5, 6)); await flush(10);
  const speak1 = audio.speak("one"); await flush(10);
  stdout.write(i16buf(1000, 1000)); await flush(10);  // banked under reply #1…
  bodies[0].end(); await speak1;                       // …which ends without playing it
  const speak2 = audio.speak("two"); await flush(10);
  bodies[1].write(i16buf(100, -50)); await flush(10);
  bodies[1].end(); await speak2;
  stdout.end(); await musicP;
  const payloads = bridge.bins.map((b) => [b.readInt16LE(1), b.readInt16LE(3)]);
  assert.ok(payloads.some(([a, b]) => a === 100 && b === -50), "reply #2 should be pure voice");
  assert.ok(!payloads.some(([a]) => a === 280), "reply #1's unplayed bed leaked into reply #2");
});

test("duckPercent: 0 restores the silent-drop behavior", async () => {
  const { audio, stdout, ttsBody, payloads } = duckRig({ duckPercent: 0 });
  const musicP = audio.playUrl("http://radio");
  stdout.write(i16buf(5, 6)); await flush(10);
  const speakP = audio.speak("hi"); await flush(10);
  stdout.write(i16buf(1000, -1000)); await flush(10);
  ttsBody.write(i16buf(100, -50)); await flush(10);
  ttsBody.end(); await speakP; stdout.end(); await musicP;
  assert.ok(payloads().some((p) => p[0] === 100 && p[1] === -50), "voice frame must be pure");
  assert.ok(!payloads().some((p) => p[0] === 300), "nothing may mix at duckPercent 0");
  assert.ok(!payloads().some((p) => p[0] === 1000), "dropped music frame leaked");
});

test("a duck-queue shortfall mixes silence for the missing samples", async () => {
  const { audio, stdout, ttsBody, payloads } = duckRig();
  const musicP = audio.playUrl("http://radio");
  stdout.write(i16buf(5, 6)); await flush(10);
  const speakP = audio.speak("hi"); await flush(10);
  stdout.write(i16buf(1000));                    // ONE music sample (the final leftover)…
  stdout.end();                                  // …then the music source ends mid-reply
  await flush(10);
  await musicP;
  ttsBody.write(i16buf(100, -50)); await flush(10);   // 2-sample voice frame: bed covers only sample 1
  ttsBody.end(); await speakP;
  // sample 0: round(100×0.8 + 1000×0.2) = 280; sample 1: no bed → pure voice -50.
  assert.ok(payloads().some((p) => p[0] === 280 && p[1] === -50),
    `expected partial mix [280,-50], got ${JSON.stringify(payloads())}`);
});

// chunkSamples 2 ⇒ frameBytes 4; duckMaxBytes = 4*8 = 32 bytes = 8 two-sample frames.
// Bank MORE than 8 music frames while voice is in flight; the oldest must be evicted.
// Frame k carries samples (s, s) with s = 2000+k*10; the convex blend at voice = 100 is
// round(100*0.8 + s*0.2) = round(80 + s*0.2).
//   k=0: round(80+400)=480 (evicted)   k=1: round(80+402)=482 (evicted)   k=9: round(80+418)=498 (kept)
// Because the cap is 8 frames (indices 2–9 survive; 0–1 evicted), the values for
// k=0,1 (480, 482) must NOT appear; the value for k=9 (498) must appear. Non-overlapping
// source values keep an evicted mix from coinciding with a pure-voice frame (also 100).
test("eviction at the duck-queue cap: oldest frames are dropped, newest survive", async () => {
  const bridge = makeBridge();
  const stdout = new PassThrough();
  const proc = fakeChildFromStream(stdout);
  const ttsBody = new PassThrough();
  // chunkSamples 2 ⇒ frameBytes 4 ⇒ duckMaxBytes = 32 bytes = 8 frames
  const audio = createAudioOut({
    bridge, tts: { stream: async () => ttsBody },
    spawn: () => proc, refGen, chunkSamples: 2, sleep: noSleep,
    prebufferMs: 0, prebufferTimeoutMs: 1,
  });
  const payloads = () => bridge.bins.map((b) => {
    const out = [];
    for (let i = 1; i + 1 < b.length; i += 2) out.push(b.readInt16LE(i));
    return out;
  });

  const musicP = audio.playUrl("http://radio");
  stdout.write(i16buf(5, 6)); await flush(10);     // music transmits (focused before voice)
  const speakP = audio.speak("hi"); await flush(10); // voice takes focus

  // Bank 10 frames while voice is in flight. Cap is 8, so frames 0 and 1 are evicted.
  // Frame k: samples (2000+k*10, 2000+k*10). Blend = round(100*0.8 + (2000+k*10)*0.2).
  //   k=0: round(80+400)=480 (evicted)   k=1: round(80+402)=482 (evicted)   k=9: round(80+418)=498 (kept)
  for (let k = 0; k < 10; k++) {
    const s = 2000 + k * 10;
    stdout.write(i16buf(s, s));
    await flush(4);   // process each frame individually before writing the next
  }

  // Voice frame: [100, 100]. Drains the queue front-to-back.
  // With 8 surviving frames (k=2..9), the first voice frame mixes frame k=2:
  //   round(100*0.8 + 2020*0.2) = round(80 + 404) = 484 (k=2)
  // Subsequent voice frames mix k=3..9 then silence.
  for (let i = 0; i < 9; i++) {
    ttsBody.write(i16buf(100, 100));
    await flush(4);
  }
  ttsBody.end(); await speakP;
  stdout.end(); await musicP;

  const allPayloads = payloads();
  const flatSamples = allPayloads.flat();

  // Evicted frames (k=0: 480, k=1: 482) must not appear as a voice-frame first sample.
  assert.ok(!flatSamples.includes(480),
    `evicted frame k=0 (mixed value 480) leaked into output: ${JSON.stringify(allPayloads)}`);
  assert.ok(!flatSamples.includes(482),
    `evicted frame k=1 (mixed value 482) leaked into output: ${JSON.stringify(allPayloads)}`);

  // A surviving frame near the tail (k=9: 498) must appear.
  assert.ok(flatSamples.includes(498),
    `surviving frame k=9 (mixed value 498) not found in output: ${JSON.stringify(allPayloads)}`);
});

// ---- PTT duck: music keeps playing quietly (pttDuckPercent) while muted ----
// A PTT press no longer silences music outright: mute() still flushes the device
// (instant cut of the full-volume backlog) and still drops every VOICE frame, but
// MUSIC frames keep transmitting scaled to pttDuckPercent, so the music continues
// as a quiet bed while the user talks. pttDuckPercent 0 restores the old full mute.

test("while muted, music transmits scaled to pttDuckPercent (after the mute flush + re-arm)", async () => {
  const bridge = makeBridge();
  const stdout = new PassThrough();
  const proc = fakeChildFromStream(stdout);
  const audio = createAudioOut({
    bridge, tts: {}, spawn: () => proc, refGen, chunkSamples: 2, sleep: noSleep,
    prebufferMs: 0, prebufferTimeoutMs: 1, pttDuckPercent: 50,
  });
  const musicP = audio.playUrl("http://radio");
  stdout.write(i16buf(1000, -1000)); await flush(10);     // full volume before the press
  assert.deepEqual([bridge.bins.at(-1).readInt16LE(1), bridge.bins.at(-1).readInt16LE(3)], [1000, -1000]);

  audio.mute();                                            // PTT press
  assert.equal(bridge.cmds("stop_audio").length, 1, "mute still flushes the device backlog");
  stdout.write(i16buf(1000, -1000)); await flush(10);     // music during the hold → ducked
  assert.deepEqual([bridge.bins.at(-1).readInt16LE(1), bridge.bins.at(-1).readInt16LE(3)], [500, -500],
    "music frame must transmit at 50% while muted");
  assert.equal(bridge.cmds("play_audio_start").length, 2, "initial arm + re-arm after the mute flush");

  audio.unmute();                                          // PTT release/finalize
  stdout.write(i16buf(1000, -1000)); await flush(10);     // back to full volume
  assert.deepEqual([bridge.bins.at(-1).readInt16LE(1), bridge.bins.at(-1).readInt16LE(3)], [1000, -1000]);
  stdout.end(); await musicP;
});

test("voice frames stay fully dropped while muted even with pttDuckPercent > 0", async () => {
  const bridge = makeBridge();
  const audio = createAudioOut({ bridge, tts: {}, sleep: noSleep, refGen, chunkSamples: 2, pttDuckPercent: 50 });
  audio.mute();
  const frames = await audio.streamPcm(Int16Array.from([1, 2, 3, 4]));
  assert.equal(frames, 2);                                 // ran silently
  assert.equal(bridge.bins.length, 0, "her voice must never transmit while muted");
});

test("pttDuckPercent 0 restores the old full mute (music drops silently)", async () => {
  const bridge = makeBridge();
  const stdout = new PassThrough();
  const proc = fakeChildFromStream(stdout);
  const audio = createAudioOut({
    bridge, tts: {}, spawn: () => proc, refGen, chunkSamples: 2, sleep: noSleep,
    prebufferMs: 0, prebufferTimeoutMs: 1, pttDuckPercent: 0,
  });
  const musicP = audio.playUrl("http://radio");
  stdout.write(i16buf(1000, -1000)); await flush(10);
  const before = bridge.bins.length;
  audio.mute();
  stdout.write(i16buf(1000, -1000)); await flush(10);
  assert.equal(bridge.bins.length, before, "no music frame may transmit while muted at 0%");
  audio.unmute();
  stdout.end(); await musicP;
});

test("the her-voice echo predicates stay false while muted with ducked music playing", async () => {
  const bridge = makeBridge();
  const stdout = new PassThrough();
  const proc = fakeChildFromStream(stdout);
  const ttsBody = new PassThrough();
  const audio = createAudioOut({
    bridge, tts: { stream: async () => ttsBody }, spawn: () => proc, refGen, chunkSamples: 2,
    sleep: noSleep, prebufferMs: 0, prebufferTimeoutMs: 1, pttDuckPercent: 50,
  });
  const musicP = audio.playUrl("http://radio");
  stdout.write(i16buf(5, 6)); await flush(10);
  const speakP = audio.speak("hi"); await flush(10);       // her reply in flight
  audio.mute();                                            // PTT press mid-reply
  stdout.write(i16buf(1000, 1000)); await flush(10);      // ducked music transmits
  assert.equal(audio.isPlaying(), false, "muted reply is inaudible — mic gate must open");
  assert.equal(audio.isPlayingOrTail(), false, "ducked music must not close the her-voice gate");
  audio.unmute();
  ttsBody.end(); await speakP;
  stdout.end(); await musicP;
});

test("the master volume composes with the PTT duck gain", async () => {
  const bridge = makeBridge();
  const stdout = new PassThrough();
  const proc = fakeChildFromStream(stdout);
  const volume = createVolume({ initialPercent: 200 });
  const audio = createAudioOut({
    bridge, tts: {}, volume, spawn: () => proc, refGen, chunkSamples: 2, sleep: noSleep,
    prebufferMs: 0, prebufferTimeoutMs: 1, pttDuckPercent: 50,
  });
  const musicP = audio.playUrl("http://radio");
  stdout.write(i16buf(100, -100)); await flush(10);
  audio.mute();
  stdout.write(i16buf(100, -100)); await flush(10);
  // duck 0.5 × master 2.0 = 1.0 ⇒ unchanged samples
  assert.deepEqual([bridge.bins.at(-1).readInt16LE(1), bridge.bins.at(-1).readInt16LE(3)], [100, -100]);
  audio.unmute();
  stdout.end(); await musicP;
});

// The partial-head branch (duckQueue[0] = head.subarray(n)) fires when a voice frame
// is smaller than the banked buffer head. Setup: bank two 2-sample music frames and
// send a 3-sample voice buffer — voice frame 1 (2 samples) fully consumes the first
// banked frame; the leftover (1 sample) partially consumes the second, leaving
// head.subarray(2) in the queue.
//
// Arithmetic (duckGain 0.2):
//   voice frame 1 [100, -50]  + bed head [1000, 2000]  → [100+200, -50+400] = [300, 350]
//   voice leftover [70]        + bed head [5000, 6000]:
//     n = min(2, 4) & ~1 = 2  (1 voice sample × 2 bytes matches 1 bed sample × 2 bytes)
//     mixed sample: 70 + round(5000×0.2) = 70 + 1000 = 1070
//     remaining head: [6000] stays in queue (head.subarray(2) — the branch under test)
test("partial-head consumption: a voice leftover partially drains a larger banked buffer", async () => {
  const bridge = makeBridge();
  const stdout = new PassThrough();
  const proc = fakeChildFromStream(stdout);
  const ttsBody = new PassThrough();
  const audio = createAudioOut({
    bridge, tts: { stream: async () => ttsBody },
    spawn: () => proc, refGen, chunkSamples: 2, sleep: noSleep,
    prebufferMs: 0, prebufferTimeoutMs: 1,
  });
  const payloads = () => bridge.bins.map((b) => {
    const out = [];
    for (let i = 1; i + 1 < b.length; i += 2) out.push(b.readInt16LE(i));
    return out;
  });

  const musicP = audio.playUrl("http://radio");
  stdout.write(i16buf(5, 6)); await flush(10);      // music transmits (focused)
  const speakP = audio.speak("hi"); await flush(10); // voice takes focus

  // Bank two 2-sample music frames: [1000,2000] and [5000,6000]
  stdout.write(i16buf(1000, 2000)); await flush(10);
  stdout.write(i16buf(5000, 6000)); await flush(10);

  // Voice: 3 samples total. streamStdoutBuffered/streamBytes splits this as:
  //   frame 1: [100, -50]  (bytes 0..3, a full 2-sample frame)
  //   leftover: [70]        (byte 4, 1-sample leftover → sent via the leftover path)
  ttsBody.write(i16buf(100, -50, 70));
  await flush(10);
  ttsBody.end(); await speakP;
  stdout.end(); await musicP;

  const allPayloads = payloads();
  // Frame 1: convex blend of voice [100,-50] and bed [1000,2000]:
  //   round(100×0.8 + 1000×0.2) = 280; round(-50×0.8 + 2000×0.2) = 360.
  assert.ok(allPayloads.some((p) => p[0] === 280 && p[1] === 360),
    `expected mixed frame [280, 360], got ${JSON.stringify(allPayloads)}`);
  // Leftover: voice [70] blended with partial bed [5000,…]: round(70×0.8 + 5000×0.2) = 1056.
  assert.ok(allPayloads.some((p) => p[0] === 1056),
    `expected partial-head mix [1056], got ${JSON.stringify(allPayloads)}`);
});
