import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { createJukebox, musicSearchUrl } from "./jukebox.js";

// --- doubles ---

// yt-dlp search double: each call emits the next batch of JSON lines on stdout.
// linesByCall is an array of entry-arrays; entry = { id, title }.
function makeSearch(linesByCall) {
  const argsLog = [];
  let call = 0;
  const spawn = (cmd, args) => {
    argsLog.push({ cmd, args });
    const batch = linesByCall[Math.min(call, linesByCall.length - 1)] || [];
    call++;
    const lines = batch.map((e) => (typeof e === "string" ? e : JSON.stringify(e)));
    const ee = new EventEmitter();
    ee.stdout = Readable.from([Buffer.from(lines.join("\n"))]);
    ee.stdout.on("end", () => process.nextTick(() => ee.emit("close", 0)));
    return ee;
  };
  return { spawn, argsLog };
}

// audioOut double: scripted playYoutubeTrack reasons + controllable isPlaying,
// now with the pause/resume primitives the jukebox drives for interjections.
function makeAudio({ reasons = [], playing = false } = {}) {
  const tracks = [];
  const trackOpts = [];
  let stops = 0, pauses = 0, resumes = 0;
  let i = 0;
  let isPlayingVal = playing;
  let pausedVal = false;
  return {
    tracks,
    trackOpts,
    get stops() { return stops; },
    get pauses() { return pauses; },
    get resumes() { return resumes; },
    setPlaying: (v) => { isPlayingVal = v; },
    setPaused: (v) => { pausedVal = v; },
    isPlaying: () => isPlayingVal && !pausedVal,
    isBusy: () => isPlayingVal && !pausedVal,   // default: mirror isPlaying (overridden where they diverge)
    isPaused: () => pausedVal,
    stop: () => { stops++; isPlayingVal = false; pausedVal = false; },
    pause: () => { pauses++; pausedVal = true; return true; },
    resume: () => { resumes++; pausedVal = false; return true; },
    playYoutubeTrack: async (url, opts = {}) => {
      tracks.push(url);
      trackOpts.push(opts);
      const r = reasons[i] || { reason: "ended", frames: 1 };
      i++;
      return typeof r === "function" ? r() : r;
    },
  };
}

const url = (id) => `https://www.youtube.com/watch?v=${id}`;
const id = (shuffle = (a) => a) => shuffle; // identity shuffle by default

// Wait for the fire-and-forget loop to settle (active → false). Everything in the
// doubles resolves on microtasks, so this converges fast.
async function waitInactive(jb, max = 2000) {
  for (let n = 0; n < max; n++) {
    if (!jb.isActive()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error("jukebox loop did not settle");
}

// --- tests ---

test("play searches, shuffles, and starts on the first track", async () => {
  const { spawn, argsLog } = makeSearch([[{ id: "a", title: "A" }, { id: "b", title: "B" }]]);
  const audio = makeAudio({ reasons: [() => new Promise(() => {})] }); // first track hangs
  const jb = createJukebox({ audioOut: audio, spawn, shuffle: (x) => x, searchLimit: 7, sleep: async () => {} });
  const r = await jb.play({ query: "Fleetwood Mac" });
  assert.ok(r.ok);
  assert.match(r.text, /Fleetwood Mac/);
  assert.deepEqual(audio.tracks, [url("a")]);
  assert.deepEqual(argsLog[0].args, ["--flat-playlist", "--dump-json", "--quiet", "--no-warnings", "--playlist-end", "7", musicSearchUrl("Fleetwood Mac")]);
  const s = jb.status();
  assert.equal(s.active, true);
  assert.equal(s.query, "Fleetwood Mac");
  assert.equal(s.current.title, "A");
});

test("autoplay advances through the queue in order", async () => {
  const { spawn } = makeSearch([
    [{ id: "a", title: "A" }, { id: "b", title: "B" }, { id: "c", title: "C" }],
  ]);
  // After exhaustion the refill re-searches and the mix keeps going — only an
  // explicit stop ends it.
  const audio = makeAudio({ reasons: [
    { reason: "ended", frames: 1 }, { reason: "ended", frames: 1 }, { reason: "ended", frames: 1 },
    { reason: "stopped" },
  ] });
  const jb = createJukebox({ audioOut: audio, spawn, shuffle: (x) => x, sleep: async () => {} });
  await jb.play({ query: "x" });
  await waitInactive(jb);
  assert.deepEqual(audio.tracks, [url("a"), url("b"), url("c"), url("a")]);
});

test("refills and reshuffles when the queue is exhausted", async () => {
  const { spawn, argsLog } = makeSearch([
    [{ id: "a", title: "A" }, { id: "b", title: "B" }],
    [{ id: "c", title: "C" }, { id: "d", title: "D" }],
  ]);
  const audio = makeAudio({ reasons: [
    { reason: "ended", frames: 1 }, { reason: "ended", frames: 1 }, // a, b
    { reason: "ended", frames: 1 }, { reason: "stopped" },           // c, d
  ] });
  const jb = createJukebox({ audioOut: audio, spawn, shuffle: (x) => x, sleep: async () => {} });
  await jb.play({ query: "x" });
  await waitInactive(jb);
  assert.deepEqual(audio.tracks, [url("a"), url("b"), url("c"), url("d")]);
  assert.equal(argsLog.length, 2); // a second search happened (the refill)
});

test("a failed track is skipped, not fatal", async () => {
  const { spawn } = makeSearch([[{ id: "a", title: "A" }, { id: "b", title: "B" }, { id: "c", title: "C" }]]);
  const audio = makeAudio({ reasons: [{ reason: "error" }, { reason: "ended", frames: 1 }, { reason: "stopped" }] });
  const jb = createJukebox({ audioOut: audio, spawn, shuffle: (x) => x, sleep: async () => {} });
  await jb.play({ query: "x" });
  await waitInactive(jb);
  assert.deepEqual(audio.tracks, [url("a"), url("b"), url("c")]);
});

test("consecutive errors trigger a backoff + live re-search, not death", async () => {
  const { spawn, argsLog } = makeSearch([
    [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }],
    [{ id: "x", title: "X" }],                            // the recovery re-search
  ]);
  const audio = makeAudio({ reasons: [
    { reason: "error" }, { reason: "error" }, { reason: "error" }, // burst hits the cap
    { reason: "ended", frames: 1 }, { reason: "stopped" },          // x plays, then stop
  ] });
  const sleeps = [];
  const jb = createJukebox({ audioOut: audio, spawn, shuffle: (x) => x, maxConsecutiveErrors: 3, sleep: async (ms) => { sleeps.push(ms); } });
  await jb.play({ query: "x" });
  await waitInactive(jb);
  // a,b,c errored → backoff → fresh search → x plays → refill → x again → stopped
  assert.deepEqual(audio.tracks, [url("a"), url("b"), url("c"), url("x"), url("x")]);
  assert.ok(argsLog.length >= 2, "the error burst did not trigger a re-search");
  assert.equal(sleeps[0], 5000); // default retryBaseMs backoff before the re-search
});

test("a 'stopped' reason ends the session", async () => {
  const { spawn } = makeSearch([[{ id: "a" }, { id: "b" }]]);
  const audio = makeAudio({ reasons: [{ reason: "stopped" }] });
  const jb = createJukebox({ audioOut: audio, spawn, shuffle: (x) => x, sleep: async () => {} });
  await jb.play({ query: "x" });
  await waitInactive(jb);
  assert.equal(audio.tracks.length, 1);
  assert.equal(jb.isActive(), false);
});

test("a track with zero frames (device offline) stops the mix", async () => {
  const { spawn } = makeSearch([[{ id: "a" }, { id: "b" }]]);
  const audio = makeAudio({ reasons: [{ reason: "ended", frames: 0 }] });
  const jb = createJukebox({ audioOut: audio, spawn, shuffle: (x) => x, sleep: async () => {} });
  await jb.play({ query: "x" });
  await waitInactive(jb);
  assert.equal(audio.tracks.length, 1);
  assert.equal(jb.isActive(), false);
});

test("supersede → wait for idle → replay the same track", async () => {
  const { spawn } = makeSearch([[{ id: "a", title: "A" }, { id: "b", title: "B" }]]);
  const audio = makeAudio({ reasons: [{ reason: "superseded" }, { reason: "ended", frames: 1 }, { reason: "stopped" }], playing: false });
  const jb = createJukebox({ audioOut: audio, spawn, shuffle: (x) => x, sleep: async () => {} });
  await jb.play({ query: "x" });
  await waitInactive(jb);
  // a played, got superseded (her speech), speaker idle → a replayed, then b
  assert.deepEqual(audio.tracks, [url("a"), url("a"), url("b")]);
});

test("superseded loop waits on isBusy, not isPlaying (file-tool playback owns the speaker)", async () => {
  // The new reality during a play_audio_file / play_youtube tool playback: the
  // superseding playback holds the MUSIC channel, so the her-voice echo predicate
  // isPlaying() is ALWAYS false — but the speaker is still occupied (isBusy).
  const { spawn } = makeSearch([[{ id: "a", title: "A" }, { id: "b", title: "B" }]]);
  const audio = makeAudio({ reasons: [{ reason: "superseded" }, { reason: "ended", frames: 1 }, { reason: "stopped" }] });
  audio.isPlaying = () => false;
  let busyPolls = 3;
  audio.isBusy = () => busyPolls > 0;
  const sleep = async () => { if (busyPolls > 0) busyPolls--; };
  const busyAtTrackStart = [];
  const origPlay = audio.playYoutubeTrack;
  audio.playYoutubeTrack = (u, o) => { busyAtTrackStart.push(audio.isBusy()); return origPlay(u, o); };
  const jb = createJukebox({ audioOut: audio, spawn, shuffle: (x) => x, sleep });
  await jb.play({ query: "x" });
  await waitInactive(jb);
  // the loop must wait out every busy poll, THEN replay the same track
  assert.equal(busyPolls, 0, "did not poll the speaker-occupancy down to idle before replaying");
  assert.deepEqual(audio.tracks, [url("a"), url("a"), url("b")]);
  assert.equal(busyAtTrackStart[1], false, "replayed while the superseding playback still owned the speaker");
});

test("a stop during the resume wait prevents resuming", async () => {
  const { spawn } = makeSearch([[{ id: "a" }, { id: "b" }]]);
  const audio = makeAudio({ reasons: [{ reason: "superseded" }], playing: true });
  let jb;
  // While waiting for idle, the user stops → loop must not resume.
  const sleep = async () => { jb.stop(); };
  jb = createJukebox({ audioOut: audio, spawn, shuffle: (x) => x, sleep });
  await jb.play({ query: "x" });
  await waitInactive(jb);
  assert.deepEqual(audio.tracks, [url("a")]);
  assert.equal(jb.isActive(), false);
});

test("resume wait outlasts the timeout window and replays once idle", async () => {
  const { spawn } = makeSearch([[{ id: "a" }, { id: "b" }]]);
  const audio = makeAudio({ reasons: [{ reason: "superseded" }, { reason: "ended", frames: 1 }, { reason: "stopped" }] });
  // The speaker stays busy well past resumeTimeoutMs (every clock() call jumps 2s
  // against a 1s window) — the loop must keep waiting instead of giving up.
  let busyChecks = 3;
  audio.isBusy = () => busyChecks-- > 0;
  let t = 0;
  const clock = () => { t += 2000; return t; };
  const jb = createJukebox({ audioOut: audio, spawn, shuffle: (x) => x, resumeTimeoutMs: 1000, clock, sleep: async () => {} });
  await jb.play({ query: "x" });
  await waitInactive(jb);
  assert.deepEqual(audio.tracks, [url("a"), url("a"), url("b")]); // waited it out, then replayed
});

test("pause freezes the track in place; resume continues it (no replay)", async () => {
  const { spawn } = makeSearch([[{ id: "a", title: "A" }, { id: "b", title: "B" }]]);
  const audio = makeAudio({ reasons: [() => new Promise(() => {}), () => new Promise(() => {})] }); // tracks hang
  const jb = createJukebox({ audioOut: audio, spawn, shuffle: (x) => x, sleep: async () => {} });
  await jb.play({ query: "x" });
  assert.deepEqual(audio.tracks, [url("a")]);
  const p = jb.pause();
  assert.ok(p.ok);
  assert.equal(audio.pauses, 1);
  assert.equal(audio.stops, 0);              // in-place freeze, NOT a stop
  let s = jb.status();
  assert.equal(s.active, true);
  assert.equal(s.paused, true);
  assert.equal(s.current.title, "A");
  assert.equal(s.index, 0);
  const r = jb.resume();
  assert.ok(r.ok);
  assert.equal(audio.resumes, 1);
  assert.deepEqual(audio.tracks, [url("a")]); // SAME track continued — no replay
  assert.equal(jb.status().paused, false);
});

test("resume restarts the current track when her speech took the pipeline", async () => {
  const { spawn } = makeSearch([[{ id: "a", title: "A" }, { id: "b", title: "B" }]]);
  const audio = makeAudio({ reasons: [() => new Promise(() => {}), () => new Promise(() => {})] });
  const jb = createJukebox({ audioOut: audio, spawn, shuffle: (x) => x, sleep: async () => {} });
  await jb.play({ query: "x" });
  jb.pause();
  // Her speech (withPlayback) would clear audioOut's pause — simulate that.
  audio.setPaused(false);
  const r = jb.resume();
  assert.ok(r.ok);
  // audioOut not paused → resume restarts the loop → replays the current track.
  assert.deepEqual(audio.tracks, [url("a"), url("a")]);
  assert.equal(audio.resumes, 0);            // didn't continue in place; restarted instead
  assert.equal(jb.status().paused, false);
});

test("skip advances to the next track", async () => {
  const { spawn } = makeSearch([[{ id: "a" }, { id: "b" }, { id: "c" }]]);
  const audio = makeAudio({ reasons: [() => new Promise(() => {}), () => new Promise(() => {}), () => new Promise(() => {})] });
  const jb = createJukebox({ audioOut: audio, spawn, shuffle: (x) => x, sleep: async () => {} });
  await jb.play({ query: "x" });
  jb.skip();
  jb.skip();
  assert.deepEqual(audio.tracks, [url("a"), url("b"), url("c")]);
});

test("a stale loop can't advance after a newer one takes over", async () => {
  const { spawn } = makeSearch([[{ id: "a" }, { id: "b" }, { id: "c" }]]);
  let resolveA;
  const aPromise = new Promise((r) => { resolveA = r; });
  let i = 0;
  const audio = {
    tracks: [],
    isPlaying: () => false,
    stop: () => {},
    playYoutubeTrack: async (u) => {
      audio.tracks.push(u);
      if (i++ === 0) return aPromise;          // track a stays pending
      return { reason: "stopped" };            // track b stops the new loop
    },
  };
  const jb = createJukebox({ audioOut: audio, spawn, shuffle: (x) => x, sleep: async () => {} });
  await jb.play({ query: "x" });               // starts a (pending)
  jb.skip();                                   // new loop → b → stopped
  await waitInactive(jb);
  assert.deepEqual(audio.tracks, [url("a"), url("b")]);
  // Now the OLD track a finally finishes — it must NOT advance to c.
  resolveA({ reason: "ended", frames: 1 });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(audio.tracks, [url("a"), url("b")]);
  assert.equal(jb.isActive(), false);
});

test("playMore re-searches the same query and keeps playing", async () => {
  const { spawn, argsLog } = makeSearch([
    [{ id: "a", title: "A" }],
    [{ id: "b", title: "B" }],
  ]);
  const audio = makeAudio({ reasons: [() => new Promise(() => {}), () => new Promise(() => {})] });
  const jb = createJukebox({ audioOut: audio, spawn, shuffle: (x) => x, sleep: async () => {} });
  await jb.play({ query: "Adele" });
  const r = await jb.playMore();
  assert.ok(r.ok);
  assert.equal(argsLog.length, 2);
  assert.equal(argsLog[1].args.at(-1), musicSearchUrl("Adele"));
  assert.deepEqual(audio.tracks, [url("a"), url("b")]);
});

test("play with no results is a clean error", async () => {
  const { spawn } = makeSearch([[]]);
  const audio = makeAudio();
  const jb = createJukebox({ audioOut: audio, spawn, shuffle: (x) => x, sleep: async () => {} });
  const r = await jb.play({ query: "asdkjfhakjsdhf" });
  assert.equal(r.ok, false);
  assert.match(r.error, /couldn't find/i);
  assert.equal(audio.tracks.length, 0);
});

test("empty/blank query is rejected", async () => {
  const { spawn } = makeSearch([[]]);
  const jb = createJukebox({ audioOut: makeAudio(), spawn, shuffle: (x) => x, sleep: async () => {} });
  const r = await jb.play({ query: "   " });
  assert.equal(r.ok, false);
});

test("malformed JSON lines are tolerated", async () => {
  const { spawn } = makeSearch([[
    JSON.stringify({ id: "a", title: "A" }),
    "not json at all",
    "",
    JSON.stringify({ title: "no id" }),     // dropped (no id)
    JSON.stringify({ id: "b", title: "B" }),
  ]]);
  const audio = makeAudio({ reasons: [{ reason: "ended", frames: 1 }, { reason: "stopped" }] });
  const jb = createJukebox({ audioOut: audio, spawn, shuffle: (x) => x, sleep: async () => {} });
  await jb.play({ query: "x" });
  await waitInactive(jb);
  assert.deepEqual(audio.tracks, [url("a"), url("b")]);
});

test("stop clears state and silences the speaker", async () => {
  const { spawn } = makeSearch([[{ id: "a" }, { id: "b" }]]);
  const audio = makeAudio({ reasons: [() => new Promise(() => {})] });
  const jb = createJukebox({ audioOut: audio, spawn, shuffle: (x) => x, sleep: async () => {} });
  await jb.play({ query: "x" });
  const r = jb.stop();
  assert.ok(r.ok);
  assert.equal(audio.stops, 1);
  assert.equal(jb.isActive(), false);
  assert.equal(jb.status().current, null);
  assert.match(jb.nowPlaying().text, /Nothing/i);
});

test("nowPlaying / skip / playMore guard when nothing is playing", async () => {
  const { spawn } = makeSearch([[]]);
  const jb = createJukebox({ audioOut: makeAudio(), spawn, shuffle: (x) => x, sleep: async () => {} });
  assert.match(jb.nowPlaying().text, /Nothing/i);
  assert.equal(jb.skip().ok, false);
  assert.equal((await jb.playMore()).ok, false);
  assert.equal(jb.pause().ok, false);
  assert.equal(jb.resume().ok, false);
});

// --- never-stop recovery (the mix only ends on an explicit stop) ---

test("empty refill retries with exponential backoff until the search recovers", async () => {
  const { spawn } = makeSearch([
    [{ id: "a" }],
    [], [],                  // two empty refills (transient search failure)
    [{ id: "b" }],           // then it recovers
  ]);
  const audio = makeAudio({ reasons: [{ reason: "ended", frames: 1 }, { reason: "ended", frames: 1 }, { reason: "stopped" }] });
  const sleeps = [];
  const jb = createJukebox({ audioOut: audio, spawn, shuffle: (x) => x, sleep: async (ms) => { sleeps.push(ms); } });
  await jb.play({ query: "x" });
  await waitInactive(jb);
  assert.deepEqual(sleeps, [5000, 10000]);                  // retryBaseMs, then doubled
  assert.deepEqual(audio.tracks, [url("a"), url("b"), url("b")]); // playback continued
});

test("stop() during a retry backoff kills the loop instantly", async () => {
  const { spawn, argsLog } = makeSearch([[{ id: "a" }], []]); // refills stay empty
  const audio = makeAudio({ reasons: [{ reason: "ended", frames: 1 }] });
  let jb;
  const sleep = async () => { jb.stop(); };     // user stops mid-backoff
  jb = createJukebox({ audioOut: audio, spawn, shuffle: (x) => x, sleep });
  await jb.play({ query: "x" });
  await waitInactive(jb);
  assert.deepEqual(audio.tracks, [url("a")]);
  assert.equal(jb.isActive(), false);
  assert.equal(argsLog.length, 2);              // the initial search + ONE refill attempt
});

test("recovery backoff caps at retryMaxMs", async () => {
  const { spawn } = makeSearch([[{ id: "a" }], []]);
  const audio = makeAudio({ reasons: [{ reason: "ended", frames: 1 }] });
  const sleeps = [];
  let jb;
  const sleep = async (ms) => { sleeps.push(ms); if (sleeps.length >= 5) jb.stop(); };
  jb = createJukebox({ audioOut: audio, spawn, shuffle: (x) => x, retryBaseMs: 5, retryMaxMs: 20, sleep });
  await jb.play({ query: "x" });
  await waitInactive(jb);
  assert.deepEqual(sleeps, [5, 10, 20, 20, 20]);
});

test("recovery backoff resets after a track actually plays", async () => {
  const { spawn } = makeSearch([
    [{ id: "a" }],
    [], [{ id: "b" }],       // one empty refill, then b plays (resets the backoff)
    [], [{ id: "c" }],       // fail again → must start back at retryBaseMs
  ]);
  const audio = makeAudio({ reasons: [
    { reason: "ended", frames: 1 }, { reason: "ended", frames: 1 }, { reason: "stopped" },
  ] });
  const sleeps = [];
  const jb = createJukebox({ audioOut: audio, spawn, shuffle: (x) => x, sleep: async (ms) => { sleeps.push(ms); } });
  await jb.play({ query: "x" });
  await waitInactive(jb);
  assert.deepEqual(sleeps, [5000, 5000]);       // NOT [5000, 10000]
  assert.deepEqual(audio.tracks, [url("a"), url("b"), url("c")]);
});

test("skip() during a retry backoff hands the loop off cleanly", async () => {
  const { spawn } = makeSearch([[{ id: "a" }], [], [{ id: "b" }]]);
  const audio = makeAudio({ reasons: [{ reason: "ended", frames: 1 }, { reason: "stopped" }] });
  let jb;
  let first = true;
  const sleep = async () => { if (first) { first = false; jb.skip(); } };
  jb = createJukebox({ audioOut: audio, spawn, shuffle: (x) => x, sleep });
  await jb.play({ query: "x" });
  await waitInactive(jb);
  assert.deepEqual(audio.tracks, [url("a"), url("b")]); // the skip's loop took over
  assert.equal(jb.isActive(), false);
});

// --- single-song sessions graduate to a similar-songs mix ---

test("a single-song session graduates to its similar-songs search when the song ends", async () => {
  const { spawn, argsLog } = makeSearch([
    [{ id: "s", title: "Song" }],                 // the requested song
    [{ id: "a", title: "A" }, { id: "b", title: "B" }],  // the similar-songs mix
  ]);
  const audio = makeAudio({ reasons: [
    { reason: "ended", frames: 1 }, { reason: "ended", frames: 1 }, { reason: "stopped" },
  ] });
  const jb = createJukebox({ audioOut: audio, spawn, shuffle: (x) => x, sleep: async () => {} });
  await jb.play({ query: "wonderwall oasis", continuation: "songs like wonderwall by oasis" });
  await waitInactive(jb);
  // The song played once, then the mix continued with SIMILAR songs — not more
  // versions of the same song.
  assert.deepEqual(audio.tracks, [url("s"), url("a"), url("b")]);
  assert.equal(argsLog[1].args.at(-1), musicSearchUrl("songs like wonderwall by oasis"));
});

test("skip on a single-song session jumps straight to similar songs", async () => {
  const { spawn, argsLog } = makeSearch([
    [{ id: "s", title: "Song" }],
    [{ id: "a", title: "A" }],
  ]);
  const audio = makeAudio({ reasons: [() => new Promise(() => {}), { reason: "stopped" }] }); // the song hangs until skipped
  const jb = createJukebox({ audioOut: audio, spawn, shuffle: (x) => x, sleep: async () => {} });
  await jb.play({ query: "wonderwall oasis", continuation: "songs like wonderwall by oasis" });
  jb.skip();
  await waitInactive(jb);
  assert.deepEqual(audio.tracks, [url("s"), url("a")]);
  assert.equal(argsLog[1].args.at(-1), musicSearchUrl("songs like wonderwall by oasis"));
});

// --- warm search-result cache (memory-backed) ---

// Minimal memory.js fake: a real key→tracks store so background refresh + refill
// round-trip the way production does. setCalls records writes for assertions.
function makeMemoryFake({ ready = true, seed = {}, session = null } = {}) {
  const store = new Map(Object.entries(seed));
  const setCalls = [];
  let sess = session;
  const sessionWrites = [];
  return {
    setCalls, _store: store, sessionWrites,
    getSession: () => sess,
    ready: () => ready,
    getMusicCache: async (key) => (store.has(key) ? store.get(key) : null),
    setMusicCache: async (key, tracks) => { store.set(key, tracks); setCalls.push({ key, tracks }); },
    getMusicSession: async () => sess,
    setMusicSession: async (s) => { sess = s ?? null; sessionWrites.push(sess); },
  };
}

async function waitFor(cond, max = 2000) {
  for (let n = 0; n < max; n++) { if (cond()) return; await new Promise((r) => setImmediate(r)); }
  throw new Error("condition not met");
}

test("cache HIT: starts instantly from a stored track, normalizing the key", async () => {
  // Background refresh search returns nothing → the seed cache is what plays.
  const { spawn } = makeSearch([[]]);
  const audio = makeAudio({ reasons: [() => new Promise(() => {})] }); // first track hangs
  const memory = makeMemoryFake({ seed: { "indian music": [{ id: "a", title: "A", url: url("a") }, { id: "b", title: "B", url: url("b") }] } });
  const jb = createJukebox({ audioOut: audio, memory, spawn, shuffle: (x) => x, sleep: async () => {} });
  const r = await jb.play({ query: "  Indian   Music " });   // normalizes → "indian music"
  assert.ok(r.ok);
  assert.deepEqual(audio.tracks, [url("a")]);                // came from cache, not a search
  assert.equal(jb.status().current.title, "A");
});

test("cache MISS: fused music-search start (one process searches+streams), then warms the full cache", async () => {
  // The jukebox's own search() now runs ONLY for the background refresh — the cold
  // seed's search is fused into playback (the search expr is the track url, handed
  // to audioOut.playYoutubeTrack, which in this double just records it).
  const { spawn, argsLog } = makeSearch([
    [{ id: "a", title: "A" }, { id: "b", title: "B" }, { id: "c", title: "C" }], // call 0: full-limit refresh
  ]);
  const audio = makeAudio({ reasons: [() => new Promise(() => {})] }); // first track hangs
  const memory = makeMemoryFake();
  const jb = createJukebox({ audioOut: audio, memory, spawn, shuffle: (x) => x, searchLimit: 50, sleep: async () => {} });
  const r = await jb.play({ query: "jazz" });
  assert.ok(r.ok);
  assert.deepEqual(audio.tracks, [musicSearchUrl("jazz")]);    // fused: the search URL is the playback target
  assert.equal(jb.status().current.title, "Loading…");        // placeholder until the refresh lands
  await waitFor(() => memory.setCalls.length === 1);           // background refresh persisted
  assert.equal(memory.setCalls[0].key, "jazz");
  assert.deepEqual(memory.setCalls[0].tracks.map((t) => t.id), ["a", "b", "c"]);
  assert.equal(argsLog[0].args.at(-1), musicSearchUrl("jazz")); // the only search was the full refresh
  // The refresh searches DEEP (3× searchLimit) so the warm pool outlasts the
  // no-repeat window instead of recycling the same top results.
  assert.deepEqual(argsLog[0].args.slice(4, 6), ["--playlist-end", "150"]);
});

test("fused cold start fills in the placeholder title once the background search lands", async () => {
  const { spawn } = makeSearch([[{ id: "a", title: "Real Title", url: url("a") }]]);
  const audio = makeAudio({ reasons: [() => new Promise(() => {})] }); // seed hangs → stays current
  const memory = makeMemoryFake();
  const jb = createJukebox({ audioOut: audio, memory, spawn, shuffle: (x) => x, sleep: async () => {} });
  await jb.play({ query: "jazz" });
  assert.equal(jb.status().current.title, "Loading…");
  await waitFor(() => jb.status().current.title === "Real Title");
});

test("play() leads the first track in behind the heads-up; continuations and playMore do not", async () => {
  const { spawn } = makeSearch([
    [{ id: "a", title: "A" }, { id: "b", title: "B" }],   // play's background refresh / playMore source
    [{ id: "c", title: "C" }],
  ]);
  // Seed a warm cache so play() takes the (non-fused) cache-hit path → real queue we
  // can advance through, exercising first-track vs continuation lead-in.
  const audio = makeAudio({ reasons: [{ reason: "ended", frames: 1 }, () => new Promise(() => {})] });
  const memory = makeMemoryFake({ seed: { jazz: [{ id: "a", title: "A", url: url("a") }, { id: "b", title: "B", url: url("b") }] } });
  const jb = createJukebox({ audioOut: audio, memory, spawn, shuffle: (x) => x, sleep: async () => {} });
  await jb.play({ query: "jazz" });
  await waitFor(() => audio.tracks.length === 2);
  assert.equal(audio.trackOpts[0].leadIn, true, "first track leads in behind the announcement");
  assert.equal(audio.trackOpts[1].leadIn, false, "the next track does NOT (no announcement, would cut gaplessness)");
});

test("player_client extractor-args are threaded into searches when configured", async () => {
  const { spawn, argsLog } = makeSearch([[{ id: "a", title: "A" }]]);
  const memory = makeMemoryFake();
  const jb = createJukebox({ audioOut: makeAudio({ reasons: [() => new Promise(() => {})] }), memory, spawn, shuffle: (x) => x, playerClients: "default,android", sleep: async () => {} });
  await jb.play({ query: "jazz" });                            // background refresh runs a search
  await waitFor(() => argsLog.length >= 1);
  assert.ok(argsLog[0].args.includes("--extractor-args"));
  assert.ok(argsLog[0].args.includes("youtube:player_client=default,android"));
});

test("refill reads the warm cache instead of searching while the cache still has fresh tracks", async () => {
  // The background refresh (the only live search) lands c,d into the cache while
  // a,b play — so the refill can pull FRESH tracks from the cache without its own
  // live search.
  const { spawn, argsLog } = makeSearch([[
    { id: "a", title: "A" }, { id: "b", title: "B" }, { id: "c", title: "C" }, { id: "d", title: "D" },
  ]]);
  const memory = makeMemoryFake({ seed: { jazz: [{ id: "a", title: "A", url: url("a") }, { id: "b", title: "B", url: url("b") }] } });
  const audio = makeAudio({ reasons: [
    { reason: "ended", frames: 1 },
    // hold track b until the background refresh has written the richer cache,
    // so the refill that follows it sees c,d.
    () => waitFor(() => memory.setCalls.length === 1).then(() => ({ reason: "ended", frames: 1 })),
    { reason: "stopped" },                                          // c (from the refreshed cache) → stop
  ] });
  const jb = createJukebox({ audioOut: audio, memory, spawn, shuffle: (x) => x, sleep: async () => {} });
  await jb.play({ query: "jazz" });
  await waitInactive(jb);
  assert.deepEqual(audio.tracks, [url("a"), url("b"), url("c")]); // refilled from cache
  assert.equal(argsLog.length, 1); // only the background refresh ran a search — refill did NOT
});

test("refill escalates to a deeper live search before allowing repeats", async () => {
  // The pool of known tracks is exhausted (everything played) — the refill must
  // NOT fall straight back to repeats: it re-searches LIVE and DEEP first.
  const { spawn, argsLog } = makeSearch([
    [{ id: "a", title: "A" }],                          // initial eager search
    [{ id: "a", title: "A" }, { id: "x", title: "X" }], // refill's deep search: one new track
  ]);
  const audio = makeAudio({ reasons: [{ reason: "ended", frames: 1 }, { reason: "ended", frames: 1 }, { reason: "stopped" }] });
  const jb = createJukebox({ audioOut: audio, memory: makeHistoryMemoryFake(), spawn, shuffle: (x) => x, sleep: async () => {} });
  await jb.play({ query: "x" });
  await waitInactive(jb);
  // x (the deep search's fresh find) played instead of an immediate repeat of a.
  assert.ok(audio.tracks.slice(0, 2).every((u, i) => u === [url("a"), url("x")][i]), `expected a then x, got ${audio.tracks}`);
  assert.deepEqual(argsLog[1].args.slice(4, 6), ["--playlist-end", "150"]); // deep: 3× the default 50
});

test("refill tries mutated queries when even the deep re-search is stale", async () => {
  const { spawn, argsLog } = makeSearch([
    [{ id: "a", title: "A" }],   // initial eager search
    [{ id: "a", title: "A" }],   // refill's deep search — nothing new
    [{ id: "y", title: "Y" }],   // first query variant ("x songs") — fresh
  ]);
  const audio = makeAudio({ reasons: [{ reason: "ended", frames: 1 }, { reason: "ended", frames: 1 }, { reason: "stopped" }] });
  const jb = createJukebox({ audioOut: audio, memory: makeHistoryMemoryFake(), spawn, shuffle: (x) => x, sleep: async () => {} });
  await jb.play({ query: "x" });
  await waitInactive(jb);
  assert.equal(argsLog[2].args.at(-1), musicSearchUrl("x songs")); // the altered query
  assert.deepEqual(audio.tracks.slice(0, 2), [url("a"), url("y")]); // its fresh find played
});

test("a truly dry pool clears the play history and restarts the rotation", async () => {
  // b played longest ago, a more recently. Everything findable is in the window:
  // the seed starts on the OLDEST (b), and each dry refill thereafter WIPES the
  // window (re-recording only the just-played track) — so the rotation alternates
  // forever instead of starving or replaying the same song back-to-back.
  const memory = makeHistoryMemoryFake({ seedHistory: [
    { id: "b", title: "B", artist: null, ts: 1 },
    { id: "a", title: "A", artist: null, ts: 2 },
  ] });
  const { spawn } = makeSearch([[{ id: "a", title: "A" }, { id: "b", title: "B" }]]);
  const audio = makeAudio({ reasons: [
    { reason: "ended", frames: 1 }, { reason: "ended", frames: 1 },
    { reason: "ended", frames: 1 }, { reason: "stopped" },
  ] });
  const jb = createJukebox({ audioOut: audio, memory, spawn, shuffle: (x) => x, sleep: async () => {} });
  await jb.play({ query: "x" });
  await waitInactive(jb);
  assert.deepEqual(audio.tracks, [url("b"), url("a"), url("b"), url("a")]);
  // The wipe is persisted: after each clear the write-through window holds ONLY
  // the just-played track.
  assert.ok(memory.historySets.some((s) => s.length === 1), "no persisted 1-track window found (history was never cleared)");
});

test("the dry-pool query generator may be async and its variants are tried in shuffled order", async () => {
  const variantCalls = [];
  const queryVariants = async (q) => { variantCalls.push(q); return ["v1", "v2"]; };
  const { spawn, argsLog } = makeSearch([
    [{ id: "a", title: "A" }],   // initial eager search
    [{ id: "a", title: "A" }],   // refill's deep search — stale
    [{ id: "y", title: "Y" }],   // first TRIED variant — fresh
  ]);
  const audio = makeAudio({ reasons: [{ reason: "ended", frames: 1 }, { reason: "stopped" }] });
  // Reversing "shuffle": proves the variant list is randomized, not taken in order.
  const jb = createJukebox({ audioOut: audio, memory: makeHistoryMemoryFake(), spawn, queryVariants, shuffle: (x) => x.slice().reverse(), sleep: async () => {} });
  await jb.play({ query: "x" });
  await waitInactive(jb);
  assert.deepEqual(variantCalls, ["x"]);
  assert.equal(argsLog[2].args.at(-1), musicSearchUrl("v2")); // reversed order → v2 first
  assert.deepEqual(audio.tracks, [url("a"), url("y")]);
});

test("a failing variant generator falls back to the static suffix queries", async () => {
  const { spawn, argsLog } = makeSearch([
    [{ id: "a", title: "A" }],   // initial eager search
    [{ id: "a", title: "A" }],   // refill's deep search — stale
    [{ id: "y", title: "Y" }],   // first static variant ("x songs") — fresh
  ]);
  const audio = makeAudio({ reasons: [{ reason: "ended", frames: 1 }, { reason: "stopped" }] });
  const jb = createJukebox({
    audioOut: audio, memory: makeHistoryMemoryFake(), spawn,
    queryVariants: async () => { throw new Error("model down"); },
    shuffle: (x) => x, sleep: async () => {},
  });
  await jb.play({ query: "x" });
  await waitInactive(jb);
  assert.equal(argsLog[2].args.at(-1), musicSearchUrl("x songs"));
  assert.deepEqual(audio.tracks, [url("a"), url("y")]);
});

test("play() with a fully played warm cache starts on the LRU track, then refill finds fresh", async () => {
  const store = new Map([["jazz", [{ id: "a", title: "A", url: url("a") }, { id: "b", title: "B", url: url("b") }]]]);
  const memory = {
    ready: () => true,
    getMusicCache: async (key) => (store.has(key) ? store.get(key) : null),
    setMusicCache: async (key, tracks) => { store.set(key, tracks); },
    getMusicHistory: async () => [
      { id: "a", title: "A", artist: null, ts: 1 },   // a played longest ago
      { id: "b", title: "B", artist: null, ts: 2 },
    ],
    setMusicHistory: async () => {},
  };
  const { spawn } = makeSearch([
    [],                                                  // play()'s background refresh: nothing (keeps cache)
    [{ id: "a", title: "A" }, { id: "c", title: "C" }],  // refill's deep search: c is new
  ]);
  const audio = makeAudio({ reasons: [{ reason: "ended", frames: 1 }, { reason: "stopped" }] });
  const jb = createJukebox({ audioOut: audio, memory, spawn, shuffle: (x) => x, sleep: async () => {} });
  await jb.play({ query: "jazz" });
  await waitInactive(jb);
  // Instant start on the least-recently-played repeat (a), NOT a shuffle of all
  // 50 stale tracks — then the very next refill escalates and finds c.
  assert.deepEqual(audio.tracks, [url("a"), url("c")]);
});

test("two uploads of the same title in one batch only play once", async () => {
  const { spawn } = makeSearch([[
    { id: "i1", title: "Song" }, { id: "m", title: "Mid" }, { id: "i2", title: "Song" },
  ]]);
  const audio = makeAudio({ reasons: [
    { reason: "ended", frames: 1 }, { reason: "ended", frames: 1 }, { reason: "stopped" },
  ] });
  const jb = createJukebox({ audioOut: audio, memory: makeHistoryMemoryFake(), spawn, shuffle: (x) => x, sleep: async () => {} });
  await jb.play({ query: "x" });
  await waitInactive(jb);
  // i2 (a second upload of "Song") never plays — the batch deduped at build time.
  assert.ok(!audio.tracks.includes(url("i2")), `i2 played: ${audio.tracks}`);
  assert.deepEqual(audio.tracks.slice(0, 2), [url("i1"), url("m")]);
});

test("a track that entered the history after the queue was built is skipped at play time", async () => {
  const { spawn } = makeSearch([[{ id: "a", title: "A" }, { id: "b", title: "B" }, { id: "c", title: "C" }]]);
  let resolveA;
  const audio = makeAudio({ reasons: [
    () => new Promise((r) => { resolveA = r; }),  // a holds while we inject b
    () => new Promise(() => {}),                   // next track hangs (so we can inspect)
  ] });
  const jb = createJukebox({ audioOut: audio, memory: makeHistoryMemoryFake(), spawn, shuffle: (x) => x, sleep: async () => {} });
  await jb.play({ query: "x" });
  jb.notePlayed({ id: "b", title: "B" });          // b played elsewhere (e.g. the play_youtube tool)
  await settle();
  resolveA({ reason: "ended", frames: 1 });
  await waitFor(() => audio.tracks.length === 2);
  assert.deepEqual(audio.tracks, [url("a"), url("c")]); // b skipped at play time
  jb.stop();
});

test("a parenthetical variant of a played title counts as the same song", async () => {
  const memory = makeHistoryMemoryFake({ seedHistory: [{ id: "h", title: "Sunrise", artist: null, ts: 1 }] });
  const { spawn } = makeSearch([[{ id: "v2", title: "Sunrise (Instrumental Mix)" }, { id: "b", title: "Other" }]]);
  const audio = makeAudio({ reasons: [() => new Promise(() => {})] });
  const jb = createJukebox({ audioOut: audio, memory, spawn, shuffle: (x) => x, sleep: async () => {} });
  await jb.play({ query: "x" });
  assert.deepEqual(audio.tracks, [url("b")]); // the (Instrumental Mix) re-upload was filtered
});

test("a superseded track that already recorded as played still replays", async () => {
  // The superseded track put frames on the wire (→ recorded into the history);
  // the deliberate same-track replay must not be eaten by the play-time check.
  const { spawn } = makeSearch([[{ id: "a", title: "A" }, { id: "b", title: "B" }]]);
  const audio = makeAudio({ reasons: [
    { reason: "superseded", frames: 1 }, { reason: "ended", frames: 1 }, { reason: "stopped" },
  ] });
  const jb = createJukebox({ audioOut: audio, memory: makeHistoryMemoryFake(), spawn, shuffle: (x) => x, sleep: async () => {} });
  await jb.play({ query: "x" });
  await waitInactive(jb);
  assert.deepEqual(audio.tracks, [url("a"), url("a"), url("b")]);
});

test("the persisted history loads late when memory only becomes ready after the first play", async () => {
  let ready = false;
  let stored = [{ id: "a", title: "A", artist: null, ts: 1 }];
  const memory = {
    ready: () => ready,
    getMusicHistory: async () => stored,
    setMusicHistory: async (tracks) => { stored = tracks; },
  };
  const { spawn } = makeSearch([[{ id: "a", title: "A" }, { id: "b", title: "B" }]]);
  const audio = makeAudio({ reasons: [() => new Promise(() => {}), () => new Promise(() => {})] });
  const jb = createJukebox({ audioOut: audio, memory, spawn, shuffle: (x) => x, sleep: async () => {} });
  await jb.play({ query: "x" });
  assert.deepEqual(audio.tracks, [url("a")]);   // history not loaded yet (memory not ready) → a plays
  jb.stop();
  ready = true;                                  // Mongo came up — the next play must load it
  await jb.play({ query: "x" });
  assert.deepEqual(audio.tracks, [url("a"), url("b")]); // a now filtered by the persisted history
});

test("notePlayed records an id-only external play into the window", async () => {
  const memory = makeHistoryMemoryFake();
  const { spawn } = makeSearch([[{ id: "z", title: "Z" }, { id: "b", title: "B" }]]);
  const audio = makeAudio({ reasons: [() => new Promise(() => {})] });
  const jb = createJukebox({ audioOut: audio, memory, spawn, shuffle: (x) => x, sleep: async () => {} });
  jb.notePlayed({ id: "z" });                    // e.g. the play_youtube tool played watch?v=z
  await settle();
  await jb.play({ query: "x" });
  assert.deepEqual(audio.tracks, [url("b")]);    // z filtered by its id alone
});

test("playMore re-searches AND refreshes the warm cache", async () => {
  const { spawn } = makeSearch([
    [{ id: "a", title: "A" }],                                  // call 0: play's background refresh (cold seed is fused)
    [{ id: "x", title: "X" }, { id: "y", title: "Y" }],         // call 1: playMore's fresh search
  ]);
  const audio = makeAudio({ reasons: [() => new Promise(() => {}), () => new Promise(() => {})] });
  const memory = makeMemoryFake();
  const jb = createJukebox({ audioOut: audio, memory, spawn, shuffle: (x) => x, sleep: async () => {} });
  await jb.play({ query: "jazz" });
  await waitFor(() => memory.setCalls.length === 1);            // play's background refresh landed
  const r = await jb.playMore();
  assert.ok(r.ok);
  await waitFor(() => memory.setCalls.length === 2);            // playMore persisted fresh results
  assert.deepEqual(memory.setCalls[1].tracks.map((t) => t.id), ["x", "y"]);
});

test("an error burst bypasses the (stale) warm cache and repairs it with the live result", async () => {
  // The cached batch is dead video ids: every play errors. Recovery must search
  // LIVE (despite the cache hit) and write the fresh batch back to the cache.
  const { spawn, argsLog } = makeSearch([
    [],                                  // play()'s background refresh fails → old cache kept
    [{ id: "x", title: "X" }],           // the burst's forced live re-search
  ]);
  const audio = makeAudio({ reasons: [
    { reason: "error" }, { reason: "error" },                   // the dead cached batch
    { reason: "ended", frames: 1 }, { reason: "stopped" },      // the live result plays
  ] });
  const memory = makeMemoryFake({ seed: { jazz: [{ id: "d1", title: "D1", url: url("d1") }, { id: "d2", title: "D2", url: url("d2") }] } });
  const jb = createJukebox({ audioOut: audio, memory, spawn, shuffle: (x) => x, maxConsecutiveErrors: 2, sleep: async () => {} });
  await jb.play({ query: "jazz" });
  await waitInactive(jb);
  assert.deepEqual(audio.tracks, [url("d1"), url("d2"), url("x"), url("x")]);
  // call 0 = the background refresh, call 1 = the burst's forced live (deep) search.
  // Calls 2+ are the LAST refill exhausting its escalation (x is the only track
  // anywhere) before falling back to a repeat of x.
  assert.equal(argsLog[1].args.at(-1), musicSearchUrl("jazz"));
  assert.equal(memory.setCalls[0].key, "jazz");                 // cache repaired by the live search
  assert.deepEqual(memory.setCalls[0].tracks.map((t) => t.id), ["x"]);
});

// --- device-loss suspend/resume (seamless reconnect) ---

const settle = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

test("suspend freezes the playing track in place; resumeFromSuspend continues it (no replay)", async () => {
  const { spawn } = makeSearch([[{ id: "a", title: "A" }, { id: "b", title: "B" }]]);
  const audio = makeAudio({ reasons: [() => new Promise(() => {})] }); // track hangs (parked on the pause gate)
  const jb = createJukebox({ audioOut: audio, spawn, shuffle: (x) => x, sleep: async () => {} });
  await jb.play({ query: "x" });
  assert.equal(jb.suspend(), true);
  assert.equal(audio.pauses, 1);              // in-place freeze…
  assert.equal(audio.stops, 0);               // …NOT a stop
  assert.equal(jb.isActive(), true);          // the session survives the disconnect
  assert.equal(jb.resumeFromSuspend(), true);
  assert.equal(audio.resumes, 1);
  assert.deepEqual(audio.tracks, [url("a")]); // SAME track continued — no replay
});

test("suspend parks the loop between tracks; resumeFromSuspend starts the next track", async () => {
  const { spawn } = makeSearch([[{ id: "a", title: "A" }, { id: "b", title: "B" }]]);
  let resolveA;
  const audio = makeAudio({ reasons: [
    () => new Promise((r) => { resolveA = r; }),
    () => new Promise(() => {}),
  ] });
  const jb = createJukebox({ audioOut: audio, spawn, shuffle: (x) => x, sleep: async () => {} });
  await jb.play({ query: "x" });
  jb.suspend();                                // device dropped mid-track…
  resolveA({ reason: "ended", frames: 1 });    // …and the track unwinds anyway
  await settle();
  assert.deepEqual(audio.tracks, [url("a")]);  // did NOT start the next track into the void
  assert.equal(jb.isActive(), true);
  jb.resumeFromSuspend();
  await waitFor(() => audio.tracks.length === 2);
  assert.deepEqual(audio.tracks, [url("a"), url("b")]);
});

test("a frames=0 track end while suspended does not end the mix", async () => {
  const { spawn } = makeSearch([[{ id: "a", title: "A" }, { id: "b", title: "B" }]]);
  let resolveA;
  const audio = makeAudio({ reasons: [
    () => new Promise((r) => { resolveA = r; }),
    { reason: "stopped" },
  ] });
  const jb = createJukebox({ audioOut: audio, spawn, shuffle: (x) => x, sleep: async () => {} });
  await jb.play({ query: "x" });
  jb.suspend();
  resolveA({ reason: "ended", frames: 0 });    // drain unwound with nothing sent (device gone)
  await settle();
  assert.equal(jb.isActive(), true);           // pre-fix this killed the session
  jb.resumeFromSuspend();
  await waitInactive(jb);
  assert.deepEqual(audio.tracks, [url("a"), url("a")]); // replayed the SAME track on reconnect
});

test("resumeFromSuspend never releases a user pause", async () => {
  const { spawn } = makeSearch([[{ id: "a", title: "A" }, { id: "b", title: "B" }]]);
  const audio = makeAudio({ reasons: [() => new Promise(() => {})] });
  const jb = createJukebox({ audioOut: audio, spawn, shuffle: (x) => x, sleep: async () => {} });
  await jb.play({ query: "x" });
  jb.pause();                                  // user pause first…
  assert.equal(audio.pauses, 1);
  jb.suspend();                                // …then the device drops
  assert.equal(audio.pauses, 1);               // no double-freeze
  jb.resumeFromSuspend();                      // device returns
  assert.equal(audio.resumes, 0);              // the USER pause stays intact
  assert.equal(jb.status().paused, true);
  assert.deepEqual(audio.tracks, [url("a")]);
});

test("stop while suspended (parked at the gate) ends the session immediately", async () => {
  const { spawn } = makeSearch([[{ id: "a", title: "A" }, { id: "b", title: "B" }]]);
  let resolveA;
  const audio = makeAudio({ reasons: [() => new Promise((r) => { resolveA = r; })] });
  const jb = createJukebox({ audioOut: audio, spawn, shuffle: (x) => x, sleep: async () => {} });
  await jb.play({ query: "x" });
  jb.suspend();
  resolveA({ reason: "ended", frames: 1 });    // loop parks at the suspend gate
  await settle();
  const r = jb.stop();
  assert.ok(r.ok);
  await waitInactive(jb);
  assert.deepEqual(audio.tracks, [url("a")]);  // the parked loop unwound without playing more
  assert.equal(jb.isActive(), false);
  assert.equal(audio.stops, 1);
});

test("suspend / resumeFromSuspend are no-ops without a session", async () => {
  const { spawn } = makeSearch([[]]);
  const jb = createJukebox({ audioOut: makeAudio(), spawn, shuffle: (x) => x, sleep: async () => {} });
  assert.equal(jb.suspend(), false);
  assert.equal(jb.resumeFromSuspend(), false);
});

test("musicSearchUrl targets the songs shelf and URL-encodes the term", () => {
  assert.equal(musicSearchUrl("norah jones"), "https://music.youtube.com/search?q=norah%20jones#songs");
  assert.equal(musicSearchUrl("AC/DC & friends #1"), "https://music.youtube.com/search?q=AC%2FDC%20%26%20friends%20%231#songs");
});

// ---- artist metadata (now_playing answers) ----

test("search extracts artist (uploader wins) and nowPlaying names it", async () => {
  const { spawn } = makeSearch([[
    { id: "a", title: "Song A", uploader: "Artist X" },
    { id: "b", title: "Song B", channel: "Channel Y" },
    { id: "c", title: "Song C", artists: ["P", "Q"] },
    { id: "d", title: "Song D" },
  ]]);
  // First track never finishes, so the session stays on it.
  const audio = makeAudio({ reasons: [() => new Promise(() => {})] });
  const jb = createJukebox({ audioOut: audio, spawn, shuffle: id(), sleep: async () => {} });
  const r = await jb.play({ query: "test mix" });
  assert.equal(r.ok, true);
  await new Promise((res) => setImmediate(res));
  assert.equal(jb.nowPlaying().text, 'Now playing: "Song A" by Artist X — from your "test mix" mix.');
  // (channel/artists[] precedence is asserted via the cache-write test below)
  jb.stop();
});

test("nowPlaying without an artist omits the 'by' clause", async () => {
  const { spawn } = makeSearch([[{ id: "d", title: "Song D" }]]);
  const audio = makeAudio({ reasons: [() => new Promise(() => {})] });
  const jb = createJukebox({ audioOut: audio, spawn, shuffle: id(), sleep: async () => {} });
  await jb.play({ query: "test mix" });
  await new Promise((res) => setImmediate(res));
  assert.equal(jb.nowPlaying().text, 'Now playing: "Song D" — from your "test mix" mix.');
  jb.stop();
});

test("the warm cache round-trips artist", async () => {
  const { spawn } = makeSearch([[
    { id: "a", title: "Song A", uploader: "Artist X" },
    { id: "b", title: "Song B", channel: "Channel Y" },
    { id: "c", title: "Song C", artists: ["P", "Q"] },
  ]]);
  const store = new Map();
  const setCalls = [];
  const memory = {
    ready: () => true,
    getMusicCache: async (key) => (store.has(key) ? store.get(key) : null),
    setMusicCache: async (key, tracks) => { store.set(key, tracks); setCalls.push({ key, tracks }); },
  };
  const audio = makeAudio({ reasons: [() => new Promise(() => {})] });
  const jb = createJukebox({ audioOut: audio, memory, spawn, shuffle: id(), sleep: async () => {} });
  await jb.play({ query: "test mix" });
  // refreshCache is fire-and-forget — wait for the write to land.
  await waitFor(() => setCalls.length >= 1);
  assert.ok(setCalls.length >= 1, "cache write landed");
  assert.deepEqual(setCalls[0].tracks.map((t) => t.artist), ["Artist X", "Channel Y", "P, Q"]);
  jb.stop();
});

// ---- play history (the no-repeat window) ----

// History-only memory fake: NO music-cache functions, so play() takes the eager
// search path (a warm/fused cache would obscure what the filter does).
function makeHistoryMemoryFake({ seedHistory = null, ready = true } = {}) {
  let stored = seedHistory;
  const historySets = [];
  return {
    historySets,
    ready: () => ready,
    getMusicHistory: async () => stored,
    setMusicHistory: async (tracks) => { stored = tracks; historySets.push(tracks.slice()); },
  };
}

test("played tracks are excluded from the next refill", async () => {
  const { spawn } = makeSearch([
    [{ id: "a", title: "A" }, { id: "b", title: "B" }],                       // initial search
    [{ id: "a", title: "A" }, { id: "b", title: "B" }, { id: "c", title: "C" }], // refill: a,b already played
  ]);
  const audio = makeAudio({ reasons: [
    { reason: "ended", frames: 1 }, { reason: "ended", frames: 1 },  // a, b play
    { reason: "stopped" },                                            // the refill's first track → stop
  ] });
  const jb = createJukebox({ audioOut: audio, memory: makeHistoryMemoryFake(), spawn, shuffle: (x) => x, sleep: async () => {} });
  await jb.play({ query: "x" });
  await waitInactive(jb);
  // The refill batch contained a,b,c — only the unplayed c survived the filter.
  assert.deepEqual(audio.tracks, [url("a"), url("b"), url("c")]);
});

test("a batch that is entirely in the history plays anyway (repeats beat silence)", async () => {
  const { spawn } = makeSearch([[{ id: "a", title: "A" }]]);
  const audio = makeAudio({ reasons: [{ reason: "ended", frames: 1 }, { reason: "stopped" }] });
  const jb = createJukebox({ audioOut: audio, memory: makeHistoryMemoryFake(), spawn, shuffle: (x) => x, sleep: async () => {} });
  await jb.play({ query: "x" });
  await waitInactive(jb);
  // a played, the refill's only result is a again — repeat rather than die.
  assert.deepEqual(audio.tracks, [url("a"), url("a")]);
});

test("a by-name single-song request plays even when the song is in the history", async () => {
  const memory = makeHistoryMemoryFake({ seedHistory: [{ id: "s", title: "Song", artist: null, ts: 1 }] });
  const { spawn } = makeSearch([[{ id: "s", title: "Song" }], [{ id: "a", title: "A" }]]);
  const audio = makeAudio({ reasons: [{ reason: "ended", frames: 1 }, { reason: "stopped" }] });
  const jb = createJukebox({ audioOut: audio, memory, spawn, shuffle: (x) => x, sleep: async () => {} });
  await jb.play({ query: "song by artist", continuation: "songs like song by artist" });
  await waitInactive(jb);
  assert.equal(audio.tracks[0], url("s"));   // requested by name → exempt from the window
});

test("a mix (no continuation) skips songs loaded from the persisted history", async () => {
  const memory = makeHistoryMemoryFake({ seedHistory: [{ id: "a", title: "A", artist: null, ts: 1 }] });
  const { spawn } = makeSearch([[{ id: "a", title: "A" }, { id: "b", title: "B" }]]);
  const audio = makeAudio({ reasons: [() => new Promise(() => {})] });
  const jb = createJukebox({ audioOut: audio, memory, spawn, shuffle: (x) => x, sleep: async () => {} });
  await jb.play({ query: "x" });
  assert.deepEqual(audio.tracks, [url("b")]); // a came back from the restart-surviving history → filtered
});

test("played tracks are persisted, capped at historyLimit, newest last", async () => {
  const memory = makeHistoryMemoryFake();
  const { spawn } = makeSearch([[{ id: "a", title: "A" }, { id: "b", title: "B" }, { id: "c", title: "C" }]]);
  const audio = makeAudio({ reasons: [
    { reason: "ended", frames: 1 }, { reason: "ended", frames: 1 }, { reason: "ended", frames: 1 },
    { reason: "stopped" },
  ] });
  const jb = createJukebox({ audioOut: audio, memory, spawn, shuffle: (x) => x, historyLimit: 2, sleep: async () => {} });
  await jb.play({ query: "x" });
  await waitInactive(jb);
  assert.equal(memory.historySets.length, 3);                       // one write-through per played track
  assert.deepEqual(memory.historySets.at(-1).map((t) => t.id), ["b", "c"]); // capped at 2, oldest dropped
});

test("a track that put zero frames on the wire is NOT recorded as played", async () => {
  const memory = makeHistoryMemoryFake();
  const { spawn } = makeSearch([[{ id: "a", title: "A" }]]);
  const audio = makeAudio({ reasons: [{ reason: "ended", frames: 0 }] });   // device offline
  const jb = createJukebox({ audioOut: audio, memory, spawn, shuffle: (x) => x, sleep: async () => {} });
  await jb.play({ query: "x" });
  await waitInactive(jb);
  assert.equal(memory.historySets.length, 0);
});

test("historyLimit 0 disables tracking and filtering entirely", async () => {
  const memory = makeHistoryMemoryFake({ seedHistory: [{ id: "a", title: "A", artist: null, ts: 1 }] });
  const { spawn } = makeSearch([[{ id: "a", title: "A" }, { id: "b", title: "B" }]]);
  const audio = makeAudio({ reasons: [{ reason: "ended", frames: 1 }, { reason: "stopped" }] });
  const jb = createJukebox({ audioOut: audio, memory, spawn, shuffle: (x) => x, historyLimit: 0, sleep: async () => {} });
  await jb.play({ query: "x" });
  await waitInactive(jb);
  assert.equal(audio.tracks[0], url("a"));   // no filtering
  assert.equal(memory.historySets.length, 0); // no recording
});

test("history filters the warm-cache start of a mix", async () => {
  const store = new Map([["jazz", [{ id: "a", title: "A", url: url("a") }, { id: "b", title: "B", url: url("b") }]]]);
  const memory = {
    ready: () => true,
    getMusicCache: async (key) => (store.has(key) ? store.get(key) : null),
    setMusicCache: async (key, tracks) => { store.set(key, tracks); },
    getMusicHistory: async () => [{ id: "a", title: "A", artist: null, ts: 1 }],
    setMusicHistory: async () => {},
  };
  const { spawn } = makeSearch([[]]);
  const audio = makeAudio({ reasons: [() => new Promise(() => {})] });
  const jb = createJukebox({ audioOut: audio, memory, spawn, shuffle: (x) => x, sleep: async () => {} });
  await jb.play({ query: "jazz" });
  assert.deepEqual(audio.tracks, [url("b")]); // the recently played a was filtered from the cached batch
});

test("playMore filters recently played tracks from the fresh batch", async () => {
  const memory = makeHistoryMemoryFake({ seedHistory: [{ id: "a", title: "A", artist: null, ts: 1 }] });
  const { spawn } = makeSearch([
    [{ id: "b", title: "B" }],                          // initial search (a already filtered by history)
    [{ id: "a", title: "A" }, { id: "c", title: "C" }], // playMore's fresh batch
  ]);
  const audio = makeAudio({ reasons: [() => new Promise(() => {}), () => new Promise(() => {})] });
  const jb = createJukebox({ audioOut: audio, memory, spawn, shuffle: (x) => x, sleep: async () => {} });
  await jb.play({ query: "x" });
  await jb.playMore();
  assert.deepEqual(audio.tracks, [url("b"), url("c")]); // a stayed filtered in the playMore batch too
});

test("a played title is filtered even when it reappears under a different video id", async () => {
  // The same song is often uploaded many times — id alone must not let it repeat.
  const memory = makeHistoryMemoryFake({ seedHistory: [{ id: "a1", title: "Sunrise", artist: null, ts: 1 }] });
  const { spawn } = makeSearch([[{ id: "a2", title: "SUNRISE" }, { id: "b", title: "B" }]]);
  const audio = makeAudio({ reasons: [() => new Promise(() => {})] });
  const jb = createJukebox({ audioOut: audio, memory, spawn, shuffle: (x) => x, sleep: async () => {} });
  await jb.play({ query: "x" });
  assert.deepEqual(audio.tracks, [url("b")]); // a2 carries a played TITLE (case-insensitive) → filtered
});

test("a title-only history entry (no id) blocks an id-bearing copy of the same song", async () => {
  const memory = makeHistoryMemoryFake({ seedHistory: [{ id: null, title: "Sunrise", artist: null, ts: 1 }] });
  const { spawn } = makeSearch([[{ id: "x", title: "Sunrise" }, { id: "b", title: "B" }]]);
  const audio = makeAudio({ reasons: [() => new Promise(() => {})] });
  const jb = createJukebox({ audioOut: audio, memory, spawn, shuffle: (x) => x, sleep: async () => {} });
  await jb.play({ query: "x" });
  assert.deepEqual(audio.tracks, [url("b")]);
});

test("replaying a title under a new id replaces its history entry instead of duplicating", async () => {
  const memory = makeHistoryMemoryFake();
  const { spawn } = makeSearch([
    [{ id: "a1", title: "S" }],   // initial search
    [{ id: "a2", title: "S" }],   // refill: same song, different upload (all-in-window → plays anyway)
  ]);
  const audio = makeAudio({ reasons: [
    { reason: "ended", frames: 1 }, { reason: "ended", frames: 1 },
    { reason: "stopped" },
  ] });
  const jb = createJukebox({ audioOut: audio, memory, spawn, shuffle: (x) => x, sleep: async () => {} });
  await jb.play({ query: "x" });
  await waitInactive(jb);
  // One history entry for the song, keyed to the most recent id — not two.
  assert.deepEqual(memory.historySets.at(-1).map((t) => t.id), ["a2"]);
});

test("fused cold-start backfill fills artist along with title/id", async () => {
  const { spawn } = makeSearch([[{ id: "a", title: "Real Title", uploader: "Real Artist" }]]);
  const store = new Map();
  const memory = {
    ready: () => true,
    getMusicCache: async () => null,   // cold: forces the fused start
    setMusicCache: async (key, tracks) => { store.set(key, tracks); },
  };
  const audio = makeAudio({ reasons: [() => new Promise(() => {})] });
  const jb = createJukebox({ audioOut: audio, memory, spawn, shuffle: id(), sleep: async () => {} });
  await jb.play({ query: "test mix" });
  // Wait for the background search to land and backfill the Loading… seed.
  await waitFor(() => /Real Title/.test(jb.nowPlaying().text));
  assert.equal(jb.nowPlaying().text, 'Now playing: "Real Title" by Real Artist — from your "test mix" mix.');
  jb.stop();
});

// ---- Task 4: first-track outcome confirmation (fused cache-miss path) ----

// Memory stub that MISSES the cache but reports a cache backend present, so
// play() takes the fused cold-start branch (seed = search URL handed to the player).
function missMemory() {
  return {
    ready: () => true,
    getMusicCache: async () => null,    // cache MISS
    setMusicCache: async () => {},
    getMusicHistory: async () => [],
    setMusicHistory: async () => {},
  };
}

test("fused cache-miss: first track plays → play() returns ok", async () => {
  // Spawn supplies one real track so the loop can refill and terminate cleanly.
  const { spawn } = makeSearch([[{ id: "x", title: "Track X" }]]);
  const audio = makeAudio({ reasons: [
    { reason: "ended", frames: 1000 },   // fused seed plays OK → settles "started"
    { reason: "stopped" },                // refill track ends the loop
  ]});
  const jb = createJukebox({
    audioOut: audio, memory: missMemory(), spawn,
    startConfirmMs: 8000, sleep: async () => {}, shuffle: (x) => x,
  });
  const r = await jb.play({ query: "lo-fi beats" });
  assert.equal(r.ok, true);
  await waitInactive(jb);
});

test("fused cache-miss: no audio + empty refill → play() returns error", async () => {
  const { spawn } = makeSearch([[]]); // all searches return empty
  const audio = makeAudio({ reasons: [{ reason: "ended", frames: 0 }] });
  const jb = createJukebox({
    audioOut: audio, memory: missMemory(), spawn,
    startConfirmMs: 8000, sleep: async () => {}, shuffle: (x) => x,
  });
  const r = await jb.play({ query: "asdkfjqweoiru no such music" });
  assert.equal(r.ok, false);
  assert.match(r.error, /couldn't find/i);
  await waitInactive(jb);
});

test("fused cache-miss: outcome never resolves → play() returns ok at timeout", async () => {
  const { spawn } = makeSearch([[]]);
  // playYoutubeTrack hangs forever — the timeout leg of waitFirstOutcome must win.
  const audio = makeAudio({ reasons: [() => new Promise(() => {})] });
  const jb = createJukebox({
    audioOut: audio, memory: missMemory(), spawn,
    startConfirmMs: 8000, sleep: async () => {}, shuffle: (x) => x,
  });
  const r = await jb.play({ query: "slow search" });
  assert.equal(r.ok, true);  // optimistic at timeout, did not hang
  // No waitInactive: the hanging track means the loop never terminates naturally.
});

test("cache-HIT path unchanged: returns ok without awaiting outcome", async () => {
  const { spawn } = makeSearch([[]]);
  const audio = makeAudio({ reasons: [() => new Promise(() => {})] }); // hangs
  const memory = {
    ...missMemory(),
    getMusicCache: async () => [{ id: "v1", title: "Song", url: url("v1") }],
  };
  const jb = createJukebox({
    audioOut: audio, memory, spawn,
    sleep: async () => {}, shuffle: (x) => x,
  });
  const r = await jb.play({ query: "cached thing" });
  assert.equal(r.ok, true);
  // No waitInactive: the hanging track means the loop never terminates naturally.
});

// --- now-playing change notifications (onStateChange) ---

test("onStateChange fires on track start and on stop", async () => {
  const { spawn } = makeSearch([[]]);
  const audio = makeAudio({ reasons: [() => new Promise(() => {})] }); // first track hangs
  const memory = makeMemoryFake({ seed: { jazz: [{ id: "a", title: "A", artist: "X", url: url("a") }] } });
  const events = [];
  const jb = createJukebox({
    audioOut: audio, memory, spawn, shuffle: (x) => x, sleep: async () => {},
    onStateChange: (s) => events.push(s),
  });
  await jb.play({ query: "jazz" });
  await waitFor(() => events.length >= 1);
  assert.equal(events[0].active, true);
  assert.equal(events[0].current.title, "A");
  assert.equal(events[0].current.artist, "X");
  jb.stop();
  const last = events[events.length - 1];
  assert.equal(last.active, false);
  assert.equal(last.current, null);
});

test("a listener that throws never breaks the loop", async () => {
  const { spawn } = makeSearch([[]]);
  const audio = makeAudio({ reasons: [{ reason: "ended", frames: 1 }, { reason: "stopped" }] });
  const memory = makeMemoryFake({ seed: { jazz: [{ id: "a", title: "A", url: url("a") }, { id: "b", title: "B", url: url("b") }] } });
  const jb = createJukebox({
    audioOut: audio, memory, spawn, shuffle: (x) => x, sleep: async () => {},
    onStateChange: () => { throw new Error("listener bug"); },
  });
  await jb.play({ query: "jazz" });
  await waitInactive(jb);
  assert.deepEqual(audio.tracks, [url("a"), url("b")]);
});

// --- restart-resume session checkpointing ---

test("a live mix is checkpointed on track start and cleared on stop", async () => {
  const { spawn } = makeSearch([[]]);
  const audio = makeAudio({ reasons: [() => new Promise(() => {})] });
  const memory = makeMemoryFake({ seed: { jazz: [{ id: "a", title: "A", url: url("a") }, { id: "b", title: "B", url: url("b") }] } });
  const jb = createJukebox({ audioOut: audio, memory, spawn, shuffle: (x) => x, sleep: async () => {}, clock: () => 1234 });
  await jb.play({ query: "jazz" });
  await waitFor(() => memory.sessionWrites.length >= 1);
  const saved = memory.getSession();
  assert.equal(saved.query, "jazz");
  assert.deepEqual(saved.queue.map((t) => t.id), ["a", "b"]);
  assert.equal(saved.index, 0);
  assert.equal(saved.ts, 1234);
  jb.stop();
  await waitFor(() => memory.getSession() === null);
});

test("restoreSession parks until the device connects, then resumes at the saved track", async () => {
  const { spawn } = makeSearch([[]]);
  const audio = makeAudio({ reasons: [() => new Promise(() => {})] });
  const memory = makeMemoryFake({ session: {
    query: "jazz", continuation: null,
    queue: [{ id: "a", title: "A", url: url("a") }, { id: "b", title: "B", url: url("b") }],
    index: 1, exempt: false, allowRepeats: false, ts: 1000,
  } });
  const jb = createJukebox({ audioOut: audio, memory, spawn, shuffle: (x) => x, sleep: async () => {}, clock: () => 2000 });
  assert.equal(await jb.restoreSession(), true);
  assert.equal(jb.isActive(), true);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(audio.tracks, []);            // parked: nothing plays without a device
  assert.equal(jb.resumeFromSuspend(), true);    // the device (re)connects
  await waitFor(() => audio.tracks.length === 1);
  assert.deepEqual(audio.tracks, [url("b")]);    // resumed at the saved position
  assert.equal(jb.status().query, "jazz");
});

test("restoreSession discards (and clears) a checkpoint older than resumeMaxAgeMs", async () => {
  const { spawn } = makeSearch([[]]);
  const audio = makeAudio();
  const memory = makeMemoryFake({ session: {
    query: "jazz", queue: [{ id: "a", title: "A", url: url("a") }], index: 0, ts: 1000,
  } });
  const jb = createJukebox({
    audioOut: audio, memory, spawn, shuffle: (x) => x, sleep: async () => {},
    clock: () => 1000 + 3600001, resumeMaxAgeMs: 3600000,
  });
  assert.equal(await jb.restoreSession(), false);
  assert.equal(jb.isActive(), false);
  await waitFor(() => memory.getSession() === null);  // stale checkpoint wiped
});

test("restoreSession is a no-op with nothing saved", async () => {
  const { spawn } = makeSearch([[]]);
  const jb = createJukebox({ audioOut: makeAudio(), memory: makeMemoryFake(), spawn, sleep: async () => {} });
  assert.equal(await jb.restoreSession(), false);
  assert.equal(jb.isActive(), false);
});
