import { test } from "node:test";
import assert from "node:assert/strict";
import { createToolRegistry } from "./tools.js";
import { PersonalityTooLargeError } from "./memory.js";

function makeDeps(overrides = {}) {
  const calls = [];
  const deviceRpc = {
    command: async (cmd) => { calls.push(["command", cmd]); return { ok: true }; },
    request: async (cmd, opts) => {
      calls.push(["request", cmd, opts]);
      if (opts.expectType === "ldr") return { type: "ldr", value: 1234 };
      if (opts.expectType === "wifi_scan") return { type: "wifi_scan", networks: [{ ssid: "home", rssi: -40 }] };
      if (opts.expectType === "ble_scan") return { type: "ble_scan", devices: [{ name: "buds", rssi: -60 }] };
      if (opts.expectType === "timer_set") return { type: "timer_set", id: 7, seconds: cmd.seconds, label: cmd.label };
      return {};
    },
    requestBinary: async (cmd, opts) => { calls.push(["requestBinary", cmd, opts]); return Buffer.from("JPG"); },
    ...overrides.deviceRpc,
  };
  const audioOut = {
    speak: async (t) => { calls.push(["speak", t]); },
    playUrl: async (u) => { calls.push(["playUrl", u]); },
    playYoutube: async (u) => { calls.push(["playYoutube", u]); },
    stop: () => { calls.push(["stop"]); },
    ...overrides.audioOut,
  };
  const vision = { describe: async (jpeg, o) => { calls.push(["describe", jpeg.toString(), o]); return "I see a desk."; }, ...overrides.vision };
  const micListener = {
    listen: async (i) => { calls.push(["listen", i]); return { ok: true, transcript: "someone said hi", heardSpeech: true }; },
    feedPcm() {}, isActive: () => false, handleDeviceDisconnect() {},
    ...overrides.micListener,
  };
  const memory = {
    searchMemory: async (q, l) => { calls.push(["searchMemory", q, l]); return [{ text: "a fact" }]; },
    remember: async (f) => { calls.push(["remember", f]); return { id: "m1" }; },
    setPersonality: async (t, o) => { calls.push(["setPersonality", t, o]); return { version: 2 }; },
    ...overrides.memory,
  };
  const weather = overrides.weather === null ? null : {
    forecast: async (i) => { calls.push(["forecast", i]); return { ok: true, text: "Forecast for today: Sunny. At 8am: 14°C, Clear. High 22°C, low 9°C. Chance of rain 0%." }; },
    current: () => "Sunny, 20°C (feels 20°C), wind 5 km/h, humidity 40%",
    ...overrides.weather,
  };
  const jukebox = overrides.jukebox === null ? null : {
    play: async (i) => { calls.push(["jukebox.play", i]); return { ok: true, text: "Playing a shuffled mix of X, starting with \"Song\"." }; },
    playMore: async () => { calls.push(["jukebox.playMore"]); return { ok: true, text: "Reshuffled — more X." }; },
    skip: async () => { calls.push(["jukebox.skip"]); return { ok: true, text: "Skipped to the next track." }; },
    stop: () => { calls.push(["jukebox.stop"]); return { ok: true, text: "Stopped the music." }; },
    nowPlaying: () => { calls.push(["jukebox.nowPlaying"]); return { ok: true, text: "Now playing: Song" }; },
    status: () => ({ active: true, paused: false }),
    isActive: () => true,
    ...overrides.jukebox,
  };
  return { calls, deps: { memory, deviceRpc, audioOut, vision, micListener, weather, jukebox } };
}

test("definitions: interactive includes every tool", () => {
  const { deps } = makeDeps();
  const reg = createToolRegistry(deps);
  const names = reg.definitions("interactive", false).map((d) => d.name);
  assert.ok(names.includes("speak"));
  assert.ok(names.includes("look"));
  assert.equal(names.length, reg.names().length);
});

test("definitions: reflection with autonomy OFF withholds the vocalizing tools", () => {
  const { deps } = makeDeps();
  const reg = createToolRegistry(deps);
  const names = reg.definitions("reflection", false).map((d) => d.name);
  for (const muted of ["speak", "play_audio_file", "play_youtube", "play_tone", "play_music", "skip_song", "play_more_like_this"]) {
    assert.ok(!names.includes(muted), `${muted} should be withheld`);
  }
  // non-vocal tools remain (now_playing is a read, not a noise-maker)
  assert.ok(names.includes("update_personality"));
  assert.ok(names.includes("remember"));
  assert.ok(names.includes("look"));
  assert.ok(names.includes("now_playing"));
  // Self-expression during reflection: her lights stay available so she can show
  // a mood (set her bindi / blue / white lights) even without the autonomy toggle.
  for (const light of ["set_blue_led", "set_white_leds", "set_rgb"]) {
    assert.ok(names.includes(light), `${light} should stay available in reflection`);
  }
});

test("definitions: reflection with autonomy ON restores the vocalizing tools", () => {
  const { deps } = makeDeps();
  const reg = createToolRegistry(deps);
  const names = reg.definitions("reflection", true).map((d) => d.name);
  assert.ok(names.includes("speak"));
});

test("look captures a snapshot and describes it through vision", async () => {
  const { calls, deps } = makeDeps();
  const reg = createToolRegistry(deps);
  const r = await reg.execute("look", { question: "what's there?" });
  assert.equal(r.content, "I see a desk.");
  assert.deepEqual(calls[0][0], "requestBinary");
  assert.equal(calls[1][0], "describe");
});

test("listen is ungated — available even in reflection with autonomy OFF (like look)", () => {
  const { deps } = makeDeps();
  const reg = createToolRegistry(deps);
  const names = reg.definitions("reflection", false).map((d) => d.name);
  assert.ok(names.includes("listen"));
});

test("listen returns what she heard", async () => {
  const { calls, deps } = makeDeps();
  const reg = createToolRegistry(deps);
  const r = await reg.execute("listen", { seconds: 15 });
  assert.ok(!r.is_error);
  assert.match(r.content, /someone said hi/);
  assert.deepEqual(calls.find((c) => c[0] === "listen"), ["listen", { seconds: 15 }]);
});

test("listen reports silence as a successful (non-error) observation", async () => {
  const { deps } = makeDeps({ micListener: { listen: async () => ({ ok: true, transcript: "", heardSpeech: false }) } });
  const reg = createToolRegistry(deps);
  const r = await reg.execute("listen", {});
  assert.ok(!r.is_error);
  assert.match(r.content, /silent/i);
});

test("listen surfaces device_offline / not_configured as is_error", async () => {
  const off = createToolRegistry(makeDeps({ micListener: { listen: async () => ({ ok: false, reason: "device_offline" }) } }).deps);
  const ro = await off.execute("listen", {});
  assert.equal(ro.is_error, true);
  assert.match(ro.content, /offline/i);

  const nc = createToolRegistry(makeDeps({ micListener: { listen: async () => ({ ok: false, reason: "not_configured" }) } }).deps);
  const rn = await nc.execute("listen", {});
  assert.equal(rn.is_error, true);
  assert.match(rn.content, /speech-to-text|available/i);
});

test("device tools map to the right rpc calls", async () => {
  const { calls, deps } = makeDeps();
  const reg = createToolRegistry(deps);
  await reg.execute("set_blue_led", { on: true });
  await reg.execute("set_white_leds", { on: false });
  await reg.execute("set_rgb", { r: 10, g: 20, b: 30 });
  await reg.execute("read_light_sensor", {});
  await reg.execute("scan_wifi", {});
  await reg.execute("scan_bluetooth", {});
  const r = await reg.execute("set_timer", { seconds: 60, label: "tea" });
  assert.deepEqual(calls[0][1], { type: "set_blue_led", on: true });
  assert.deepEqual(calls[1][1], { type: "set_flash_led", on: false });
  assert.deepEqual(calls[2][1], { type: "set_rgb", r: 10, g: 20, b: 30 });
  assert.equal(calls[3][1].type, "read_ldr");
  assert.match(r.content, /#7/);
});

test("speak / memory / personality tools call through", async () => {
  const { calls, deps } = makeDeps();
  const reg = createToolRegistry(deps);
  await reg.execute("speak", { text: "[happy] hi" });
  await reg.execute("search_memory", { query: "coffee" });
  await reg.execute("remember", { text: "x", tags: ["t"] });
  const r = await reg.execute("update_personality", { text: "kinder now" });
  assert.deepEqual(calls.find((c) => c[0] === "speak"), ["speak", "[happy] hi"]);
  assert.match(r.content, /v2/);
});

test("play_audio_file / play_youtube return immediately (background) and stop_audio works", async () => {
  const { calls, deps } = makeDeps();
  const reg = createToolRegistry(deps);
  const r = await reg.execute("play_youtube", { url: "https://youtu.be/x" });
  assert.match(r.content, /background/);
  await reg.execute("stop_audio", {});
  assert.ok(calls.some((c) => c[0] === "playYoutube"));
  assert.ok(calls.some((c) => c[0] === "stop"));
  // It speaks its own quick heads-up the instant it starts.
  assert.ok(calls.some((c) => c[0] === "speak"), "play_youtube fires a spoken ack");
});

test("play_youtube reports the video id into the jukebox's no-repeat window", async () => {
  const { calls, deps } = makeDeps({
    jukebox: { notePlayed: (t) => { calls.push(["jukebox.notePlayed", t]); } },
  });
  const reg = createToolRegistry(deps);
  await reg.execute("play_youtube", { url: "https://www.youtube.com/watch?v=abcDEF123-_" });
  assert.deepEqual(calls.find((c) => c[0] === "jukebox.notePlayed"), ["jukebox.notePlayed", { id: "abcDEF123-_" }]);
  // A playlist URL has no single video id → nothing to report (and no crash).
  await reg.execute("play_youtube", { url: "https://www.youtube.com/playlist?list=PLx" });
  assert.equal(calls.filter((c) => c[0] === "jukebox.notePlayed").length, 1);
});

test("stop_audio stops BOTH the jukebox and the audio pipeline", async () => {
  const { calls, deps } = makeDeps();
  const reg = createToolRegistry(deps);
  await reg.execute("stop_audio", {});
  assert.ok(calls.some((c) => c[0] === "jukebox.stop"));
  assert.ok(calls.some((c) => c[0] === "stop")); // audioOut.stop
});

test("stop tool delegates to the injected stopController (stand down)", async () => {
  const { deps } = makeDeps();
  let stood = 0;
  const reg = createToolRegistry({ ...deps, stopController: { endConversationAndStop: () => { stood++; } } });
  const r = await reg.execute("stop", {});
  assert.equal(stood, 1);
  assert.match(r.content, /stopped/);
});

test("stop tool falls back to stopping audio + music when no stopController is wired", async () => {
  const { calls, deps } = makeDeps();
  const reg = createToolRegistry(deps);   // no stopController → default fallback
  await reg.execute("stop", {});
  assert.ok(calls.some((c) => c[0] === "jukebox.stop"));
  assert.ok(calls.some((c) => c[0] === "stop")); // audioOut.stop
});

test("play_music searches + plays through the jukebox", async () => {
  const { calls, deps } = makeDeps();
  const reg = createToolRegistry(deps);
  const r = await reg.execute("play_music", { query: "Amitabh Bachchan" });
  assert.ok(!r.is_error);
  assert.match(r.content, /mix of X/);
  assert.deepEqual(calls.find((c) => c[0] === "jukebox.play"), ["jukebox.play", { query: "Amitabh Bachchan", continuation: undefined }]);
  // It speaks its own quick heads-up so the user isn't met with dead air.
  assert.ok(calls.some((c) => c[0] === "speak"), "play_music fires a spoken ack");
});

test("play_music threads similar_query through as the jukebox continuation", async () => {
  const { calls, deps } = makeDeps();
  const reg = createToolRegistry(deps);
  const r = await reg.execute("play_music", { query: "wonderwall oasis", similar_query: "songs like wonderwall by oasis" });
  assert.ok(!r.is_error);
  assert.deepEqual(
    calls.find((c) => c[0] === "jukebox.play"),
    ["jukebox.play", { query: "wonderwall oasis", continuation: "songs like wonderwall by oasis" }],
  );
});

test("play_music speaks the ack BEFORE the search resolves (overlaps the gap)", async () => {
  let resolvePlay;
  const { calls, deps } = makeDeps({
    jukebox: {
      play: () => new Promise((res) => {
        calls.push(["jukebox.play.start"]);
        resolvePlay = () => res({ ok: true, text: "Playing a shuffled mix of X." });
      }),
    },
  });
  const reg = createToolRegistry(deps);
  const p = reg.execute("play_music", { query: "X" });
  await Promise.resolve();                         // flush the synchronous speak + microtasks
  // The ack is recorded while the search is still pending (not awaited behind it).
  assert.ok(calls.some((c) => c[0] === "speak"), "ack spoken before the search resolves");
  assert.ok(calls.some((c) => c[0] === "jukebox.play.start"), "search was kicked off");
  resolvePlay();
  const r = await p;
  assert.ok(!r.is_error);
});

test("a failed ack does not break play_music (best-effort)", async () => {
  const { deps } = makeDeps({ audioOut: { speak: async () => { throw new Error("no tts"); } } });
  const reg = createToolRegistry(deps);
  const r = await reg.execute("play_music", { query: "X" });
  assert.ok(!r.is_error);
  assert.match(r.content, /mix of X/);
});

test("skip_song / play_more_like_this / now_playing route through the jukebox", async () => {
  const { calls, deps } = makeDeps();
  const reg = createToolRegistry(deps);
  const skip = await reg.execute("skip_song", {});
  const more = await reg.execute("play_more_like_this", {});
  const np = await reg.execute("now_playing", {});
  assert.match(skip.content, /Skipped/);
  assert.match(more.content, /Reshuffled/);
  assert.match(np.content, /Now playing/);
  assert.ok(calls.some((c) => c[0] === "jukebox.skip"));
  assert.ok(calls.some((c) => c[0] === "jukebox.playMore"));
  assert.ok(calls.some((c) => c[0] === "jukebox.nowPlaying"));
});

test("a jukebox 'not ok' result becomes is_error (model can recover)", async () => {
  const { deps } = makeDeps({ jukebox: { play: async () => ({ ok: false, error: "I couldn't find anything on YouTube for \"zzz\"." }) } });
  const reg = createToolRegistry(deps);
  const r = await reg.execute("play_music", { query: "zzz" });
  assert.equal(r.is_error, true);
  assert.match(r.content, /couldn't find/i);
});

test("music tools degrade cleanly when the jukebox is unavailable", async () => {
  const { calls, deps } = makeDeps({ jukebox: null });
  const reg = createToolRegistry(deps);
  const r = await reg.execute("play_music", { query: "x" });
  assert.equal(r.is_error, true);
  assert.match(r.content, /isn't available/i);
  // No jukebox → return the error without speaking a pointless ack.
  assert.ok(!calls.some((c) => c[0] === "speak"), "no ack when music is unavailable");
  const np = await reg.execute("now_playing", {});
  assert.ok(!np.is_error);
  assert.match(np.content, /Nothing/i);
});

test("a device-rpc rejection becomes is_error (model can recover)", async () => {
  const { deps } = makeDeps({ deviceRpc: { command: async () => { const e = new Error("x"); e.reason = "device_offline"; throw e; } } });
  const reg = createToolRegistry(deps);
  const r = await reg.execute("set_blue_led", { on: true });
  assert.equal(r.is_error, true);
  assert.match(r.content, /device_offline/);
});

test("update_personality over cap surfaces as is_error", async () => {
  const { deps } = makeDeps({ memory: { setPersonality: async () => { throw new PersonalityTooLargeError(5000, 4000); } } });
  const reg = createToolRegistry(deps);
  const r = await reg.execute("update_personality", { text: "huge" });
  assert.equal(r.is_error, true);
  assert.match(r.content, /cap/);
});

test("unknown tool is an error, not a throw", async () => {
  const { deps } = makeDeps();
  const reg = createToolRegistry(deps);
  const r = await reg.execute("nope", {});
  assert.equal(r.is_error, true);
});

test("check_weather is ungated — available in reflection with autonomy OFF", () => {
  const { deps } = makeDeps();
  const reg = createToolRegistry(deps);
  const names = reg.definitions("reflection", false).map((d) => d.name);
  assert.ok(names.includes("check_weather"));
});

test("check_weather forwards the date and returns the forecast text", async () => {
  const { calls, deps } = makeDeps();
  const reg = createToolRegistry(deps);
  const r = await reg.execute("check_weather", { date: "2026-06-07" });
  assert.ok(!r.is_error);
  assert.match(r.content, /High 22°C, low 9°C/);
  assert.deepEqual(calls.find((c) => c[0] === "forecast"), ["forecast", { date: "2026-06-07" }]);
});

test("check_weather defaults the date to undefined (the module resolves today)", async () => {
  const { calls, deps } = makeDeps();
  const reg = createToolRegistry(deps);
  await reg.execute("check_weather", {});
  assert.deepEqual(calls.find((c) => c[0] === "forecast"), ["forecast", { date: undefined }]);
});

test("check_weather surfaces a forecast failure as is_error", async () => {
  const { deps } = makeDeps({ weather: { forecast: async () => ({ ok: false, error: "That day is beyond the forecast horizon (about 3 days out)." }) } });
  const reg = createToolRegistry(deps);
  const r = await reg.execute("check_weather", { date: "2026-12-25" });
  assert.equal(r.is_error, true);
  assert.match(r.content, /horizon/);
});

test("check_weather reports not-configured when weather is unavailable", async () => {
  const { deps } = makeDeps({ weather: null });
  const reg = createToolRegistry(deps);
  const r = await reg.execute("check_weather", {});
  assert.equal(r.is_error, true);
  assert.match(r.content, /isn't configured/);
});

test("play_music description steers current-song version requests to the track title", () => {
  const { deps } = makeDeps();
  const reg = createToolRegistry(deps);
  const defs = reg.definitions("interactive", true);
  const play = defs.find((d) => d.name === "play_music");
  // "play this with words / the vocal version of this" must search by the
  // now-playing TITLE, never the query that started the mix, and must set
  // similar_query (the by-name exemption — alternate versions share the
  // just-played track's base title and would be skipped by the no-repeat window).
  assert.match(play.description, /vocal version/i);
  assert.match(play.description, /title/i);
  assert.match(play.description, /now.playing/i);
  assert.match(play.description, /similar_query/);
});

test("light tool descriptions carry her appearance + expressive framing", () => {
  const { deps } = makeDeps();
  const reg = createToolRegistry(deps);
  const defs = reg.definitions("interactive", true);
  const white = defs.find((d) => d.name === "set_white_leds");
  assert.match(white.description, /necklace/);
  assert.match(white.description, /happy/);
  assert.match(white.description, /music/);
  const blue = defs.find((d) => d.name === "set_blue_led");
  assert.match(blue.description, /hat/);
  assert.match(blue.description, /lonely/);
});

// ---------------------------------------------------------------------------
// speak-tool flash-and-listen (Task 4)
// ---------------------------------------------------------------------------

function makeSpeakDeps(overrides = {}) {
  const calls = { flash: [], spoke: [], listened: 0 };
  const audioOut = {
    speak: async (t) => { calls.spoke.push(t); },
    isPlayingOrTail: () => false,           // already drained by default
    stop: () => {},
  };
  const micListener = {
    listen: async ({ seconds }) => { calls.listened = seconds; return { ok: true, heardSpeech: true, transcript: "hello there" }; },
  };
  const deviceRpc = {
    command: async (c) => { if (c.type === "set_blue_flash") calls.flash.push(c.on); return { ok: true }; },
  };
  return { calls, deps: {
    memory: {}, deviceRpc, audioOut, vision: {}, micListener, volume: {}, weather: {}, jukebox: null,
    speakListen: { enabled: true, seconds: 10, drainCapMs: 4000 },
    clock: () => 0, sleep: async () => {},
    ...overrides,
  } };
}

test("speak flashes, listens, unflashes, returns heard reply", async () => {
  const { calls, deps } = makeSpeakDeps();
  const reg = createToolRegistry(deps);
  const r = await reg.execute("speak", { text: "hi", listen_after: true });
  assert.equal(calls.spoke[0], "hi");
  assert.deepEqual(calls.flash, [true, false]);     // on then off
  assert.equal(calls.listened, 10);
  assert.match(r.content, /heard: "hello there"/);
  assert.ok(!r.is_error);
});

test("speak returns no-speech message on silence", async () => {
  const { deps } = makeSpeakDeps({ micListener: { listen: async () => ({ ok: true, heardSpeech: false, transcript: "" }) } });
  const reg = createToolRegistry(deps);
  const r = await reg.execute("speak", { text: "hi", listen_after: true });
  assert.match(r.content, /no speech/);
});

test("speak turns the flash off even when listen throws", async () => {
  const flash = [];
  const { deps } = makeSpeakDeps({
    deviceRpc: { command: async (c) => { if (c.type === "set_blue_flash") flash.push(c.on); return { ok: true }; } },
    micListener: { listen: async () => { throw new Error("boom"); } },
  });
  const reg = createToolRegistry(deps);
  const r = await reg.execute("speak", { text: "hi", listen_after: true });
  assert.deepEqual(flash, [true, false]);           // finally ran
  assert.ok(!r.is_error);                           // turn not derailed
});

test("speak behaves as plain speak when micListener is null", async () => {
  const flash = [];
  const { deps } = makeSpeakDeps({
    micListener: null,
    deviceRpc: { command: async (c) => { if (c.type === "set_blue_flash") flash.push(c.on); return { ok: true }; } },
  });
  const reg = createToolRegistry(deps);
  const r = await reg.execute("speak", { text: "hi", listen_after: true });
  assert.equal(r.content, "spoken");
  assert.deepEqual(flash, []);                       // no flash
});

test("speak does not listen when disabled", async () => {
  const { deps } = makeSpeakDeps({ speakListen: { enabled: false, seconds: 10, drainCapMs: 4000 } });
  const reg = createToolRegistry(deps);
  const r = await reg.execute("speak", { text: "hi", listen_after: true });
  assert.equal(r.content, "spoken");
});

test("speak waits for voice tail to drain before listening (echo guard)", async () => {
  let now = 0;
  const tail = [true, true, false];                  // drains on 3rd poll
  let i = 0;
  let listenedAt = null;
  const { deps } = makeSpeakDeps({
    audioOut: { speak: async () => {}, isPlayingOrTail: () => tail[Math.min(i, tail.length - 1)], stop: () => {} },
    micListener: { listen: async () => { listenedAt = now; return { ok: true, heardSpeech: false, transcript: "" }; } },
    clock: () => now,
    sleep: async () => { now += 50; i += 1; },
  });
  const reg = createToolRegistry(deps);
  await reg.execute("speak", { text: "hi", listen_after: true });
  assert.ok(listenedAt >= 100);                      // waited through two polls
});

test("speak without listen_after returns 'spoken' and does NOT flash or listen", async () => {
  const { calls, deps } = makeSpeakDeps();
  const reg = createToolRegistry(deps);
  const r = await reg.execute("speak", { text: "hi" }); // listen_after omitted
  assert.equal(r.content, "spoken");
  assert.deepEqual(calls.flash, []);   // no flash at all
  assert.equal(calls.listened, 0);    // listen() was never called
});;
