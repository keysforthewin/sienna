import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import { WebSocketServer } from "ws";
import { loadConfig } from "./config.js";
import { createApp } from "./http.js";
import { Bridge } from "./bridge.js";
import { Recorder } from "./recordings.js";
import { attachDeviceWs } from "./ws-device.js";
import { attachBrowserWs } from "./ws-browser.js";
import { createElevenLabsTts } from "./tts.js";
import { createEnhancer } from "./enhance.js";
import { createScribeSession } from "./scribe.js";
import { createTranscriber, createDisabledTranscriber } from "./transcriber.js";
import { createMicStream } from "./micStream.js";
import { createMicListener } from "./micListen.js";
import { createDb } from "./db.js";
import { createMemory } from "./memory.js";
import { toCard } from "./sienna-cards.js";
import { createDeviceRpc } from "./device-rpc.js";
import { createAudioOut } from "./audio-out.js";
import { createJukebox } from "./jukebox.js";
import { createMusicSuggester } from "./music-suggest.js";
import { createVolume } from "./volume.js";
import { createVision } from "./vision.js";
import { createToolRegistry } from "./tools.js";
import { createWeather } from "./weather.js";
import { createNetProbe } from "./net-probe.js";
import { createSiennaAgent } from "./agent.js";
import { createPersonalityEvolution } from "./personality-evolution.js";
import { createReflection } from "./reflection.js";
import { createEavesdrop } from "./eavesdrop.js";
import { createCameraGlance } from "./camera-glance.js";
import { createPttCoordinator } from "./ptt.js";
import { createSpeechEndpointer } from "./endpointer.js";
import { createCommitBeep } from "./commitBeep.js";
import { createGeminiClient } from "./gemini.js";
import { costOf } from "./usage.js";
import { buildServerCommand, BinTag } from "./protocol.js";
import { createImageStore } from "./images.js";
import { randomUUID } from "node:crypto";
import { buildSystemPrompt } from "./prompt.js";
import { createLightState } from "./light-state.js";

// The dashboard's now-playing bar payload, derived from the jukebox's live status.
// Shared by the jukebox onStateChange broadcast and the browser connect-time push.
export function nowPlayingMsg(jukebox) {
  const s = jukebox?.status();
  if (!s || !s.active || !s.current) return { type: "now_playing", active: false };
  return {
    type: "now_playing", active: true, paused: !!s.paused,
    title: s.current.title, artist: s.current.artist ?? null, query: s.query,
  };
}

export async function startServer(envOverride) {
  const config = loadConfig({ ...process.env, ...(envOverride || {}) });
  const bridge = new Bridge();

  // Mirror of the last commanded LED state (her tools + dashboard alike), for
  // the prompt's "Right now" block. The firmware boots dark, so a (re)connect
  // resets to all-off — created unconditionally, independent of the agent.
  const lightState = createLightState();
  bridge.onDeviceCommand((msg) => lightState.observe(msg));
  bridge.onDeviceConnected(() => lightState.reset());

  // Speaker volumes (server-owned gains) — TWO independent channels: "voice"
  // (her speech/TTS, browser Speak, Hold-to-talk) and "music" (jukebox /
  // play_audio_file / play_youtube), so speech can run loud while music sits
  // low. Created unconditionally — independent of the agent, so the Interact
  // knobs and the browser Speak path work even when Sienna is disabled. Changes
  // (knob OR her set_volume tool) broadcast with their channel so every open
  // knob stays in sync, and write-through to the Mongo settings store
  // (fire-and-forget, like the autonomy toggle) so a restart restores the last
  // set values instead of SIENNA_VOLUME. `memory` is bound lazily — it exists
  // only when Mongo + a reasoning provider are configured; without it the
  // volumes stay in-RAM as before. onChange can't fire before startup finishes
  // (no browser/agent exists yet), so reading the later-declared `memory` here
  // is safe.
  const channelVolume = (channel) => createVolume({
    initialPercent: config.SIENNA_VOLUME,
    maxPercent: config.SIENNA_VOLUME_MAX,
    onChange: (percent) => {
      bridge.broadcastToBrowsers({ type: "volume", channel, percent });
      if (memory) Promise.resolve(memory.setSetting(`volume_${channel}`, percent)).catch(() => {});
    },
  });
  const volumes = { voice: channelVolume("voice"), music: channelVolume("music") };
  const recorder = new Recorder({ dir: config.RECORDINGS_DIR, keep: config.RECORDINGS_KEEP });
  await recorder.ensureDir();

  // Camera-snapshot store. Created unconditionally so createApp can serve JPEGs;
  // the capture tap (below) only persists when Mongo-backed memory exists.
  const imageStore = createImageStore({ dir: config.IMAGES_DIR });
  await imageStore.ensureDir();

  const tts = config.ELEVENLABS_API_KEY
    ? createElevenLabsTts({
        apiKey: config.ELEVENLABS_API_KEY,
        voiceId: config.ELEVENLABS_VOICE_ID,
        modelId: config.ELEVENLABS_MODEL_ID,
        streamOutputFormat: config.ELEVENLABS_STREAM_OUTPUT_FORMAT,
      })
    : null;
  // The server speaker pipeline. Created unconditionally (independent of the agent)
  // so the browser Voice-panel Speak (/api/tts → audioOut.speak) and the audio
  // tools work whenever the device is online — even with Sienna disabled. speak /
  // speakStream need `tts` (HTTP /stream, eleven_v3, sentence-chunked); the spawn
  // paths (play_audio_file/play_youtube) don't. The transcriber/endpointer/beeps
  // reference it lazily for the echo gate.
  const audioOut = createAudioOut({
    bridge, tts, volumes,
    ffmpegPath: config.FFMPEG_PATH, ytDlpPath: config.YT_DLP_PATH,
    playerClients: config.YT_DLP_PLAYER_CLIENTS,
    musicFilter: config.SIENNA_MUSIC_FILTER,
    firstChars: config.SIENNA_TTS_CHUNK_FIRST_CHARS,
    targetChars: config.SIENNA_TTS_CHUNK_TARGET_CHARS,
    prebufferMs: config.SIENNA_PLAYBACK_PREBUFFER_MS,
    prebufferTimeoutMs: config.SIENNA_PLAYBACK_PREBUFFER_TIMEOUT_MS,
    maxBufferMs: config.SIENNA_PLAYBACK_MAX_BUFFER_MS,
    audioStatsMs: config.SIENNA_AUDIO_STATS_MS,
    musicPacingMs: config.SIENNA_MUSIC_PACING_MS,
    // Live music-pacing slider (dashboard): broadcast the new value so every open
    // slider syncs, and write-through to Mongo so it survives restarts (mirrors volume).
    onMusicPacingChange: (ms) => {
      bridge.broadcastToBrowsers({ type: "music_pacing", ms });
      if (memory) Promise.resolve(memory.setSetting("music_pacing", ms)).catch(() => {});
    },
    ttsPacingMs: config.SIENNA_TTS_PACING_MS,
    // Live voice-pacing slider (dashboard): same broadcast + write-through as music.
    onTtsPacingChange: (ms) => {
      bridge.broadcastToBrowsers({ type: "tts_pacing", ms });
      if (memory) Promise.resolve(memory.setSetting("tts_pacing", ms)).catch(() => {});
    },
    leadInTimeoutMs: config.SIENNA_PLAYBACK_LEADIN_TIMEOUT_MS,
    tailMs: config.SIENNA_ECHO_TAIL_MS,
    duckPercent: config.SIENNA_DUCK_PERCENT,
    pttDuckPercent: config.SIENNA_PTT_DUCK_PERCENT,
    log: (m) => console.log("[audio]", m),
  });
  // ---- Sienna agent ----
  // Her mind runs server-side on Gemini (gemini-2.5-flash, non-thinking, streaming).
  // It needs MongoDB (personality + memory) and Gemini configured — via the Gemini
  // Developer API key (GEMINI_API_KEY, preferred) or Vertex (project + location).
  // Without either the agent is null and agent_input returns agent_unavailable — the
  // rest of the dashboard is unaffected. ElevenLabs is optional (the speak/audio tools
  // and transcription just degrade without it). The @google/genai import is lazy
  // (gemini.js), so building the client is cheap. One Gemini client powers reasoning,
  // the `look` vision tool, AND the Speak-box Enhance feature.
  // Token-usage meter: EVERY Gemini call (reasoning, the `look` vision tool, and
  // Speak-box Enhance) reports its token counts through onUsage. We cost them at the
  // configured rate and persist for the dashboard's Usage view. The recorder is
  // wired once `memory` exists (below) — until then usage is dropped (no Mongo =
  // nowhere to persist, and the agent can't run anyway). Isolated so metering can
  // never break a call.
  const usageRates = {
    inputPer1M: config.GEMINI_PRICE_INPUT_PER_1M,
    outputPer1M: config.GEMINI_PRICE_OUTPUT_PER_1M,
    imagePer1M: config.GEMINI_PRICE_IMAGE_PER_1M,
  };
  let recordUsage = null; // (usage) => void; set once memory is connected
  const onUsage = (usage) => { if (recordUsage) recordUsage(usage); };

  const geminiClient = (config.GEMINI_API_KEY || (config.GEMINI_VERTEX_PROJECT && config.GEMINI_VERTEX_LOCATION))
    ? createGeminiClient({
        apiKey: config.GEMINI_API_KEY || undefined,
        project: config.GEMINI_VERTEX_PROJECT,
        location: config.GEMINI_VERTEX_LOCATION,
        model: config.GEMINI_MODEL_ID,
        onUsage,
        log: (m) => console.log("[gemini]", m),
      })
    : null;
  // "Enhance" (Speak-box): insert ElevenLabs v3 emotion tags into typed text via
  // Gemini. Null (→ /api/enhance returns 503) when Gemini isn't configured.
  const enhancer = geminiClient ? createEnhancer({ client: geminiClient }) : null;
  let agent = null;
  let reflection = null;
  let eavesdrop = null;    // daily ambient listen (hoisted for stop())
  let cameraGlance = null; // daily ambient camera glance (hoisted for stop())
  let weather = null;      // ambient-conditions refresher + check_weather backend (hoisted for stop())
  let jukebox = null;      // music mix on top of audioOut (hoisted for disconnect/stop teardown)
  let endpointer = null;   // server-side end-of-speech detector (drives manual commits)
  let db = null;
  let memory = null;       // hoisted so the REST card endpoints (createApp) can read it

  // "Speech" widget: live transcription via ElevenLabs Scribe realtime. Reuses
  // the ElevenLabs key; without it the transcriber is a stub that reports
  // not_configured. scribeFactory bakes in the config so the transcriber only
  // has to supply per-session callbacks. Final transcripts are also routed into
  // the Sienna agent as push-to-talk input (works even with the panel closed).
  // Constructed before the agent block (it has no dependency on `agent` — the
  // onFinalTranscript closure binds the `agent` variable lazily) so the
  // PTT coordinator below can drive it.
  const scribeFactory = config.ELEVENLABS_API_KEY
    ? ({ callbacks }) =>
        createScribeSession({
          apiKey: config.ELEVENLABS_API_KEY,
          modelId: config.ELEVENLABS_STT_MODEL_ID,
          language: config.ELEVENLABS_STT_LANGUAGE,
          commitStrategy: config.ELEVENLABS_STT_COMMIT_STRATEGY,
          vadSilenceSecs: config.ELEVENLABS_STT_VAD_SILENCE_SECS,
          vadThreshold: config.ELEVENLABS_STT_VAD_THRESHOLD,
          callbacks,
        })
    : null;
  const micStream = createMicStream({ bridge });

  // Server-built play_tone: fire-and-forget, with a ref (the firmware drops
  // ref-less commands) and validated via buildServerCommand. Shared by the two
  // server-side beeps below; amplitude is volume-scaled + clamped inside each.
  const sendPlayTone = ({ hz, durationMs, amplitude }) =>
    bridge.sendToDevice(buildServerCommand(
      { type: "play_tone", hz, duration_ms: durationMs, amplitude }, randomUUID()));

  // Commit beep: a short tone on the device speaker the moment a finalized
  // transcript routes to her, so you know she heard you and can stop talking.
  // Independent of the agent (only the bridge is needed); audioOut is captured
  // lazily so it gates on her TTS once she exists. Skipped when ENABLED=0.
  const commitBeep = createCommitBeep({
    playTone: sendPlayTone,
    isSpeaking: () => !!(audioOut && audioOut.isPlaying()),
    volume: volumes.voice,   // the beeps are speech-side cues
    enabled: config.SIENNA_COMMIT_BEEP_ENABLED,
    hz: config.SIENNA_COMMIT_BEEP_HZ,
    hz2: config.SIENNA_COMMIT_BEEP_HZ2,
    durationMs: config.SIENNA_COMMIT_BEEP_MS,
    amplitude: config.SIENNA_COMMIT_BEEP_AMPLITUDE,
  });

  // Listen beep: the "I'm listening" cue the moment a PTT press opens the mic —
  // the same rising two-tone chirp the wake word used to play, pitched just
  // below the commit beep. A separate createCommitBeep instance with its own
  // cooldown; wired into the coordinator's onListenStart below.
  const pttBeep = createCommitBeep({
    playTone: sendPlayTone,
    isSpeaking: () => !!(audioOut && audioOut.isPlaying()),
    volume: volumes.voice,
    enabled: config.SIENNA_PTT_BEEP_ENABLED,
    hz: config.SIENNA_PTT_BEEP_HZ,
    hz2: config.SIENNA_PTT_BEEP_HZ2,
    durationMs: config.SIENNA_PTT_BEEP_MS,
    amplitude: config.SIENNA_PTT_BEEP_AMPLITUDE,
  });

  const transcriber = scribeFactory
    ? createTranscriber({
        bridge, scribeFactory, micStream,
        // Echo gate: while she's speaking — AND through the post-speech echo tail
        // (device ring/DMA + room reverb) — don't feed her own TTS (the mic picks
        // it up) back into Scribe. isPlayingOrTail() extends the gate past playback
        // end by SIENNA_ECHO_TAIL_MS so her decay isn't transcribed.
        shouldFeed: () => !(audioOut && audioOut.isPlayingOrTail()),
        // Finalized speech → the PTT coordinator (created below; the closure binds
        // it lazily). During a hold it accumulates; unowned (manual Speech-panel)
        // commits route per-utterance. The coordinator owns the commit beep so a
        // mid-hold commit doesn't chirp — only the actual hand-off to the agent.
        onFinalTranscript: (text) => ptt.onUtterance(text),
        // Every commit (even empty) lands here after routing, so a release's
        // forced commit resolves without waiting out the coordinator's timeout.
        onCommitObserved: () => ptt.onCommitObserved(),
      })
    : createDisabledTranscriber({ bridge });

  // End-of-speech detection from the device's mic_rms stream drives the "manual"
  // Scribe commits (see endpointer.js / scribe.js). This is the energy-based
  // FALLBACK path: the default strategy is ElevenLabs' own VAD, which finalizes
  // faster (~120-150 ms) and survives the high-gain mic's noise floor. So the
  // endpointer runs ONLY in "manual" mode — otherwise it would double-commit
  // against the provider's VAD. It only acts while the transcriber is live.
  if (scribeFactory && config.SIENNA_ENDPOINT_ENABLED && config.ELEVENLABS_STT_COMMIT_STRATEGY === "manual") {
    endpointer = createSpeechEndpointer({
      onEndpoint: () => transcriber.commitNextChunk(),
      isActive: () => transcriber.isActive(),
      isSpeaking: () => !!(audioOut && audioOut.isPlayingOrTail()),
      alpha: config.SIENNA_ENDPOINT_ALPHA,
      speechFactor: config.SIENNA_ENDPOINT_SPEECH_FACTOR,
      silenceMs: config.SIENNA_ENDPOINT_SILENCE_MS,
      minSpeechMs: config.SIENNA_ENDPOINT_MIN_SPEECH_MS,
      log: (m) => console.log("[endpoint]", m),
    });
    bridge.onDeviceMessage((msg) => { if (msg.type === "mic_rms") endpointer.feed(msg.rms); });
  }

  // Her `listen` tool's engine: a one-shot, time-boxed Scribe capture that opens
  // its own session and returns the transcript inline (distinct from the
  // transcriber's persistent → push-to-talk path). Built unconditionally — with a
  // null scribeFactory (no ELEVENLABS_API_KEY) it just reports not_configured —
  // so attachDeviceWs and the disconnect handler below can always reference it.
  const micListener = createMicListener({
    micStream, scribeFactory,
    defaultSeconds: config.SIENNA_LISTEN_SECONDS_DEFAULT,
    minSeconds: config.SIENNA_LISTEN_SECONDS_MIN,
    maxSeconds: config.SIENNA_LISTEN_SECONDS_MAX,
  });

  // Push-to-talk coordinator: the device's GPIO 45 button drives the mic.
  // Hold → transcribe; release → force-commit and route ONE agent turn. Created
  // unconditionally — `agent` and `jukebox` are bound lazily, and with Scribe
  // unconfigured a press still mutes the speaker (transmit gate) and then no-ops.
  const ptt = createPttCoordinator({
    transcriber,
    runAgent: (text, source) => {
      if (!agent) { console.warn(`[sienna] ptt transcript DROPPED — agent disabled; text="${text.slice(0, 60)}"`); return Promise.resolve(); }
      return agent.run(text, { source }).catch((e) => console.warn("[sienna] ptt agent.run failed:", e?.message));
    },
    // PTT is a transmit-MUTE, not a stop: while held, audio-out's gate drops every
    // speaker frame server-side — music and any in-flight reply keep playing
    // silently and whatever remains is audible again at finalize (unmute). An
    // explicit stop still goes through the stop tool (endConversationAndStop).
    mute: () => audioOut.mute(),
    unmute: () => audioOut.unmute(),
    // Unowned (manual Speech-panel) echo guard: drop only while her TTS is
    // actually audible — NOT while she merely thinks — so a follow-up isn't lost.
    isSpeakerAudible: () => audioOut.isPlayingOrTail(),
    // The "I'm listening" cue, fired when a fresh press actually opens the mic.
    onListenStart: () => pttBeep.trigger(),
    // The "I heard you" cue, fired once per routed turn (never on mid-hold commits).
    onRouted: () => commitBeep.trigger(),
    maxHoldMs: config.SIENNA_PTT_MAX_HOLD_MS,
    releaseGraceMs: config.SIENNA_PTT_RELEASE_GRACE_MS,
    commitTimeoutMs: config.SIENNA_PTT_COMMIT_TIMEOUT_MS,
    log: (m) => console.log("[ptt]", m),
  });

  // Button edges work even with the agent disabled (barge-in + live transcript on
  // the dashboard). Reflection is seeded by the completed PTT *turn* (agent.run
  // source "ptt"), not the raw press, so nothing else to do here.
  bridge.onDeviceMessage((msg) => {
    if (msg.type === "button" && msg.id === "ptt") {
      ptt.onButton(msg.pressed);
    }
  });

  if (config.MONGODB_URI && geminiClient) {
    db = createDb({ uri: config.MONGODB_URI });
    if (await db.connect()) {
      await db.ensureIndexes();
      memory = createMemory({
        db, personalityTokenCap: config.SIENNA_PERSONALITY_TOKEN_CAP,
        // Live card seam: a new memory / personality version → broadcast a
        // sienna_entry so the dashboard's Activity tab updates without a refetch.
        // (Message cards are emitted by the agent — see agent.js — not here.)
        onChange: ({ kind, doc }) => bridge.broadcastToBrowsers({ type: "sienna_entry", entry: toCard(kind, doc) }),
      });

      // Restore the persisted channel volumes before the server listens (mirrors
      // restoreAutonomy below). setPercent clamps to SIENNA_VOLUME_MAX, so a
      // saved value from a run with a higher cap stays safe; an unset key falls
      // back to the pre-split "volume" master key (seamless upgrade), then to
      // the SIENNA_VOLUME default.
      try {
        const legacyVolume = await memory.getSetting("volume", null);
        for (const channel of ["voice", "music"]) {
          const saved = await memory.getSetting(`volume_${channel}`, null);
          const value = saved ?? legacyVolume;
          if (value != null) volumes[channel].setPercent(value);
        }
      } catch { /* leave the configured default */ }

      // Restore the persisted music-pacing slider value (same pattern as volume).
      try {
        const savedPacing = await memory.getSetting("music_pacing", null);
        if (savedPacing != null) audioOut.setMusicPacingMs(savedPacing);
      } catch { /* leave the SIENNA_MUSIC_PACING_MS default */ }

      // Restore the persisted voice (TTS) pacing slider value.
      try {
        const savedTtsPacing = await memory.getSetting("tts_pacing", null);
        if (savedTtsPacing != null) audioOut.setTtsPacingMs(savedTtsPacing);
      } catch { /* leave the SIENNA_TTS_PACING_MS default */ }

      // Camera image capture. The device fans EVERY JPEG frame (0x02) here —
      // Sienna's `look` and manual Camera-panel snapshots alike — so this single
      // tap stores each one exactly once: bytes to disk, a doc in Mongo, then a
      // sienna_entry broadcast so the Images + Activity tabs prepend it live
      // (REST backfills on reload). Fire-and-forget so it never blocks the binary
      // fan-out; pruning evicts the oldest files + docs together past the cap.
      bridge.onDeviceBinary((tag, payload) => {
        if (tag !== BinTag.JPEG) return;
        (async () => {
          const ts = Date.now();
          const { filename } = await imageStore.save(Buffer.from(payload), { ts });
          const { id } = await memory.appendImage({ filename, source: "camera", ts });
          const stale = await memory.pruneImages(config.SIENNA_IMAGE_KEEP);
          if (stale.length) await imageStore.deleteFiles(stale);
          bridge.broadcastToBrowsers({ type: "sienna_entry", entry: toCard("image", { _id: id, ts, filename, source: "camera" }) });
        })().catch((e) => console.error("image capture failed:", e.message));
      });

      // Now that memory exists, point the Gemini usage meter at it: cost each call
      // at the configured rate (locked at record time) and persist it for the Usage
      // view. Fire-and-forget — a DB hiccup must never break a model call.
      recordUsage = (usage) => {
        Promise.resolve(memory.recordUsage?.({
          model: config.GEMINI_MODEL_ID, ...usage, cost: costOf(usage, usageRates),
        }))
          // Nudge open dashboards to refetch the Usage view live (debounced client-side),
          // AFTER the record is persisted so the refetch includes it — no manual reload.
          .then(() => bridge.broadcastToBrowsers({ type: "usage" }))
          .catch(() => {});
      };
      const deviceRpc = createDeviceRpc({ bridge });
      jukebox = createJukebox({
        audioOut,
        memory,
        ytDlpPath: config.YT_DLP_PATH,
        playerClients: config.YT_DLP_PLAYER_CLIENTS,
        searchLimit: config.SIENNA_MUSIC_SEARCH_LIMIT,
        resumeTimeoutMs: config.SIENNA_MUSIC_RESUME_TIMEOUT_MS,
        startConfirmMs: config.SIENNA_MUSIC_START_CONFIRM_MS,
        historyLimit: config.SIENNA_MUSIC_HISTORY_LIMIT,
        resumeMaxAgeMs: config.SIENNA_MUSIC_RESUME_MAX_AGE_MS,
        // Live now-playing seam: every state change (track start, title fill-in,
        // pause/resume, stop) broadcasts so the dashboard's bar updates in place.
        onStateChange: () => bridge.broadcastToBrowsers(nowPlayingMsg(jukebox)),
        // Dry-pool escalation: LLM-brainstormed related queries (the shared Gemini
        // client). The jukebox shuffles them and falls back to its static suffix
        // variants if this call fails.
        queryVariants: createMusicSuggester({ client: geminiClient, log: (m) => console.log("[music-suggest]", m) }),
        log: (m) => console.log("[jukebox]", m),
      });
      // Resume a mix a restart interrupted: reload the persisted checkpoint parked
      // at the suspend gate — the onDeviceConnected → resumeFromSuspend wiring
      // below thaws it the moment the device reconnects.
      await jukebox.restoreSession();
      // Vision (`look`) runs on Gemini — the adapter translates image blocks →
      // inlineData (gemini.js), so her eyes use the same model as her mind. The
      // call runs a dedicated factual-analysis prompt; her reflection on what
      // she sees happens in the main loop (the look tool result + description).
      const vision = createVision({
        client: geminiClient,
        model: config.GEMINI_MODEL_ID,
      });
      // Weather via Open-Meteo (no API key needed): refresh ambient current
      // conditions (injected into her prompt) and back the check_weather forecast
      // tool, which now reaches ~16 days out.
      weather = createWeather({
        lat: config.WEATHER_LAT,
        lon: config.WEATHER_LON,
        refreshMs: config.WEATHER_REFRESH_MS,
        log: (m) => console.log("[weather]", m),
      });
      // The `stop` tool's "stand down" action: hard-cut audio + music and abort
      // any in-flight PTT session without routing it.
      const stopController = {
        endConversationAndStop: () => { if (jukebox) jukebox.stop(); audioOut.hardStop(); ptt.endNow(); },
      };
      const tools = createToolRegistry({
        memory, deviceRpc, audioOut, vision, micListener, volumes, weather, jukebox, stopController,
        speakListen: {
          enabled: config.SIENNA_SPEAK_LISTEN,
          seconds: config.SIENNA_SPEAK_LISTEN_SECONDS,
          drainCapMs: config.SIENNA_SPEAK_LISTEN_DRAIN_CAP_MS,
        },
      });
      // Reflection is seeded by HUMAN interaction only — a completed push-to-talk,
      // eavesdrop, or dashboard turn (agent.js forwards the run's source here). A
      // fired timer or her own camera glance is not a human interaction and does
      // not schedule reflections. `reflection` is assigned a few lines down; the
      // guard covers the gap between agent and reflection creation (no run can fire
      // in that window).
      const HUMAN_SOURCES = new Set(["text", "ptt", "eavesdrop"]);
      const onActivity = (source) => { if (reflection && HUMAN_SOURCES.has(source)) reflection.onInteraction(); };

      // Additive personality evolution: folds everything since the last update
      // into her personality on each reflection tick (see reflection.fire). Same
      // Gemini client/model as the agent; size-gated by the token cap.
      const personalityEvolution = createPersonalityEvolution({
        client: geminiClient, memory, model: config.GEMINI_MODEL_ID,
        tokenLimit: config.SIENNA_PERSONALITY_TOKEN_CAP,
        evolveMaxTokens: config.SIENNA_PERSONALITY_EVOLVE_MAX_TOKENS,
        log: (m) => console.log("[personality]", m),
      });

      // Reasoning runs on Gemini. The adapter uses its own configured model id;
      // GEMINI_MODEL_ID is passed through only for the agent's log line.
      agent = createSiennaAgent({
        client: geminiClient, memory, tools, model: config.GEMINI_MODEL_ID,
        audioOut,
        evolve: personalityEvolution.evolve,
        buildSystem: buildSystemPrompt,
        maxIterations: config.SIENNA_MAX_ITERATIONS,
        maxToolRepeat: config.SIENNA_MAX_TOOL_REPEAT,
        historyTurns: config.SIENNA_HISTORY_TURNS,
        recallLimit: config.SIENNA_RECALL_LIMIT,
        reflectionSampleSize: config.SIENNA_REFLECTION_SAMPLE_SIZE,
        reflectionPoolSize: config.SIENNA_REFLECTION_POOL,
        reflectionHistory: config.SIENNA_REFLECTION_HISTORY,
        runTimeoutMs: config.SIENNA_RUN_TIMEOUT_MS,
        onActivity,
        getWeather: () => weather?.current() ?? null,
        getLights: () => lightState.describe(),
        // status().current guards the search gap (active but no track yet) and
        // !paused keeps "Now playing" honest while the music is actually silent.
        getNowPlaying: () => {
          const s = jukebox?.status();
          return s && s.active && !s.paused && s.current ? jukebox.nowPlaying().text : null;
        },
        emit: (e) => bridge.broadcastToBrowsers(e),
        log: (m) => console.log("[agent]", m),
      });
      // Restore the autonomy toggle persisted from a prior run, before the server
      // listens (the only `set_autonomy` source is a browser, which can't connect
      // yet). Browsers learn the restored value via the connect-time autonomy_state.
      await agent.restoreAutonomy();

      // A fired timer wakes her; PTT button edges are handled by the unconditional
      // tap above. (Sudden light changes no longer wake her — reflection is purely
      // interaction-driven now, so the LDR stream only feeds the dashboard gauge.)
      bridge.onDeviceMessage((msg) => {
        if (msg.type === "timer_fired") agent.onTimerFire(msg);
      });

      reflection = createReflection({
        agent,
        delaysMs: config.SIENNA_REFLECTION_DELAYS_MS,
        log: (m) => console.log("[reflection]", m),
      });
      reflection.start();
      // Daily eavesdrop: at most once a day in waking hours she opens the mic for
      // ~60 s; overheard speech becomes an interactive turn (she may jump in). Needs
      // Scribe for the mic→text path; gated each tick on the Autonomous-speech toggle.
      if (scribeFactory) {
        eavesdrop = createEavesdrop({
          agent, micListener, transcriber, ptt, audioOut,
          intervalMs: config.SIENNA_EAVESDROP_INTERVAL_MS,
          checkMs: config.SIENNA_AMBIENT_CHECK_MS,
          seconds: config.SIENNA_EAVESDROP_SECONDS,
          startHour: config.SIENNA_ACTIVE_HOURS_START,
          endHour: config.SIENNA_ACTIVE_HOURS_END,
          log: (m) => console.log("[eavesdrop]", m),
        });
        eavesdrop.start();
      }
      // Daily camera glance: at most once a day in waking hours she snaps one frame
      // and remarks ONLY if she sees a person. Uses vision (Gemini) + the device
      // camera; gated like eavesdrop on the Autonomous-speech toggle.
      cameraGlance = createCameraGlance({
        agent, deviceRpc, vision, ptt, transcriber, audioOut, micListener,
        intervalMs: config.SIENNA_GLANCE_INTERVAL_MS,
        checkMs: config.SIENNA_AMBIENT_CHECK_MS,
        startHour: config.SIENNA_ACTIVE_HOURS_START,
        endHour: config.SIENNA_ACTIVE_HOURS_END,
        log: (m) => console.log("[glance]", m),
      });
      cameraGlance.start();
      if (weather) weather.start(); // initial fetch + 30-min refresh of ambient conditions
      const reasoning = `gemini(${config.GEMINI_API_KEY ? "api-key" : "vertex"}) ${config.GEMINI_MODEL_ID}`;
      console.log(`[sienna] agent ENABLED — reasoning=${reasoning} vision=gemini tts=${tts ? "http-stream" : "none"}`);
    } else {
      console.warn("[sienna] agent DISABLED — mongo unavailable (connection failed)");
    }
  } else {
    // The single most common "she shows the transcript but never replies" cause —
    // say exactly which prerequisite is missing.
    console.warn(`[sienna] agent DISABLED — mongo=${!!config.MONGODB_URI} gemini=${!!geminiClient} (needs MONGODB_URI + Gemini: GEMINI_API_KEY or Vertex project+location)`);
  }

  bridge.onDeviceDisconnected(() => {
    transcriber.handleDeviceDisconnect();
    micListener.handleDeviceDisconnect();
    if (jukebox) jukebox.suspend();   // the device vanished — freeze the mix in place (resumed on reconnect)
    // Clear PTT state without touching the transcriber (already torn down above —
    // a transcriber.stop() here would double-release the mic token).
    ptt.cancel();
    if (endpointer) endpointer.reset();
    micStream.reset();
    // Device vanished mid-recording: flush whatever PCM we captured so the WAV
    // isn't silently lost and the recorder doesn't stay stuck in recording.
    if (recorder.isRecording()) {
      recorder.stop().then((result) => {
        if (result) {
          bridge.broadcastToBrowsers({
            type: "recording_ready",
            filename: result.filename,
            url: `/api/recordings/${result.filename}`,
            size_bytes: result.sizeBytes,
            duration_ms: result.durationMs,
          });
        }
      }).catch(() => {});
    }
  });

  // Device came back (it usually reconnects within seconds of a crash/reboot):
  // thaw a music session the disconnect suspended, picking up where it stopped.
  bridge.onDeviceConnected(() => {
    if (jukebox) jukebox.resumeFromSuspend();
  });

  const app = createApp({ token: config.DASHBOARD_TOKEN, recorder, imageStore, tts, audioOut, bridge, enhancer, memory });
  const tlsEnabled = Boolean(config.TLS_CERT && config.TLS_KEY);
  const server = tlsEnabled
    ? https.createServer(
        { cert: readFileSync(config.TLS_CERT), key: readFileSync(config.TLS_KEY) },
        app,
      )
    : http.createServer(app);

  const wssDevice = new WebSocketServer({ noServer: true });
  const wssBrowser = new WebSocketServer({ noServer: true });

  attachDeviceWs(wssDevice, bridge, recorder, transcriber, config.DASHBOARD_TOKEN, config.DEBUG_DEVICE_WS, config.DEVICE_HEARTBEAT_MS, micListener);
  attachBrowserWs(wssBrowser, bridge, config.DASHBOARD_TOKEN, recorder, transcriber, micStream, agent, volumes, audioOut,
    // Connect-time now-playing push (the jukebox may be null when the agent is off).
    () => nowPlayingMsg(jukebox),
    // On-screen PTT button — same coordinator as the physical GPIO 45 button.
    ptt);

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/ws/device") {
      wssDevice.handleUpgrade(req, socket, head, (ws) => wssDevice.emit("connection", ws, req));
    } else if (url.pathname === "/ws/browser") {
      wssBrowser.handleUpgrade(req, socket, head, (ws) => wssBrowser.emit("connection", ws, req));
    } else {
      socket.destroy();
    }
  });

  // WAN health probe: periodic RTT/loss + bandwidth lines in the same console
  // as the [device-ws] net lines, so ISP trouble and Wi-Fi trouble are
  // distinguishable at a glance. Independent of the agent/device.
  const netProbe = createNetProbe({
    intervalMs: config.SIENNA_NETPROBE_MS,
    targets: config.SIENNA_NETPROBE_TARGETS,
    bandwidthIntervalMs: config.SIENNA_NETPROBE_BANDWIDTH_MS,
    bandwidthUrl: config.SIENNA_NETPROBE_BANDWIDTH_URL,
  });
  netProbe.start();

  const host = config.LOCALHOST_ONLY ? "127.0.0.1" : "0.0.0.0";
  await new Promise((r) => server.listen(config.PORT, host, r));
  const port = server.address().port;
  const scheme = tlsEnabled ? "https" : "http";
  console.log(`[sienna-dashboard] listening on ${scheme}://${host}:${port}`);
  if (config.MONGODB_URI) console.log("[sienna-dashboard] MONGODB_URI configured");

  return {
    port,
    bridge,
    recorder,
    transcriber,
    agent,
    async stop() {
      if (reflection) reflection.stop();
      if (eavesdrop) eavesdrop.stop();
      if (cameraGlance) cameraGlance.stop();
      if (weather) weather.stop();
      if (jukebox) jukebox.stop();
      netProbe.stop();
      ptt.cancel();
      wssDevice.close();
      wssBrowser.close();
      if (db) await db.close();
      // Force-close any lingering device/browser sockets so close() can't hang
      // waiting on a still-open WebSocket.
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
