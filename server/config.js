import { z } from "zod";

const envSchema = z.object({
  DASHBOARD_TOKEN: z.string().min(8, "DASHBOARD_TOKEN must be at least 8 chars"),
  PORT: z.coerce.number().int().nonnegative().default(3387),
  LOCALHOST_ONLY: z
    .string()
    .optional()
    .transform((v) => v === "1" || v === "true"),
  RECORDINGS_DIR: z.string().default("./recordings"),
  RECORDINGS_KEEP: z.coerce.number().int().nonnegative().default(20),
  // Camera snapshots: JPEG bytes on disk (IMAGES_DIR), metadata in Mongo. Keep the
  // newest N (oldest pruned, files + docs together) so the Images tab doesn't grow
  // without bound.
  IMAGES_DIR: z.string().default("./images"),
  SIENNA_IMAGE_KEEP: z.coerce.number().int().nonnegative().default(200),
  DEBUG_DEVICE_WS: z
    .string()
    .optional()
    .transform((v) => v === "1" || v === "true"),
  // Server→device WebSocket liveness probe (ms). An abrupt device disconnect
  // (power loss / Wi-Fi drop) sends no WS close frame, so without this the
  // dashboard shows the device online until the OS TCP keepalive (~2 h). The
  // server pings on this interval and drops a device that misses one, which
  // broadcasts device_disconnected. Detection takes ~1–2 intervals. 0 disables.
  DEVICE_HEARTBEAT_MS: z.coerce.number().int().nonnegative().default(10000),
  // WAN health probe (net-probe.js) — the ISP leg of the disconnect diagnosis.
  // Every NETPROBE_MS a burst of TCP connects to each TARGETS anchor logs WAN
  // RTT + loss; every NETPROBE_BANDWIDTH_MS a small download logs achieved
  // Mbps. Correlate the [net-probe] lines against [device-ws] net lines:
  // WAN bad + device link clean → ISP; reverse → Wi-Fi/LAN. 0 disables either.
  SIENNA_NETPROBE_MS: z.coerce.number().int().nonnegative().default(30000),
  SIENNA_NETPROBE_TARGETS: z
    .string()
    .default("1.1.1.1:443,8.8.8.8:53")
    .transform((s) =>
      s.split(",").map((t) => {
        const [host, port] = t.trim().split(":");
        return { host, port: parseInt(port, 10) || 443 };
      }).filter((t) => t.host)),
  SIENNA_NETPROBE_BANDWIDTH_MS: z.coerce.number().int().nonnegative().default(300000),
  SIENNA_NETPROBE_BANDWIDTH_URL: z.string().default("https://speed.cloudflare.com/__down?bytes=2000000"),
  TLS_CERT: z.string().optional(),
  TLS_KEY: z.string().optional(),
  // Text-to-speech (the "Speak" dashboard widget). Both API keys are optional;
  // each feature returns 503 until its key is set.
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_VOICE_ID: z.string().default("iCrDUkL56s3C8sCRl7wb"),
  ELEVENLABS_MODEL_ID: z.string().default("eleven_v3"),
  // Her gapless streamed reply is sentence-chunked over the HTTP /stream endpoint
  // (eleven_v3 — so it gets inline emotion tags too, unlike the old WS path). As the
  // LLM streams, the reply is split into sentence-ish chunks and synthesized in
  // order: a SMALL first chunk for fast first audio, then coalesce toward the target
  // (v3 is prosodically shaky on tiny fragments). pcm_16000 is the device-native
  // 16 kHz mono int16 format.
  SIENNA_TTS_CHUNK_FIRST_CHARS: z.coerce.number().int().positive().default(60),
  SIENNA_TTS_CHUNK_TARGET_CHARS: z.coerce.number().int().positive().default(200),
  ELEVENLABS_STREAM_OUTPUT_FORMAT: z.string().default("pcm_16000"),
  // "Speech" widget — ElevenLabs Scribe realtime speech-to-text. Reuses
  // ELEVENLABS_API_KEY; with no key, transcription is disabled.
  ELEVENLABS_STT_MODEL_ID: z.string().default("scribe_v2_realtime"),
  ELEVENLABS_STT_LANGUAGE: z.string().optional(),
  // When to commit (finalize) a transcript. "vad" (default) → ElevenLabs' own
  // model-based voice-activity detection commits on end-of-speech. Verified
  // against the live API: it finalizes ~120-150 ms after you stop and is robust
  // even when the mic's noise-floor RMS exceeds the speech RMS — VAD is a
  // speech/non-speech *model*, not an energy gate, so the high-gain floor does
  // NOT defeat it (the original reason this defaulted to "manual"). "manual" →
  // the server endpoints from the device's mic_rms stream and force-commits;
  // it's the energy-based fallback. The VAD_* knobs apply only in "vad" mode,
  // and the server endpointer runs only in "manual" mode (index.js), so the two
  // can never double-commit.
  ELEVENLABS_STT_COMMIT_STRATEGY: z.enum(["manual", "vad"]).default("vad"),
  // Silence held this long (seconds) ends an utterance. 0.4 s is snappy yet safe
  // (matches the old endpointer's 400 ms). API range 0.3-3; raise if she cuts you
  // off mid-sentence, lower toward 0.3 for the fastest possible final.
  ELEVENLABS_STT_VAD_SILENCE_SECS: z.coerce.number().positive().default(0.4),
  // Speech-probability gate (API range 0.1-0.9). 0.4 stayed fast + robust against
  // a loud noise floor in testing; a *lower* value is worse (treats noise as
  // speech, delaying the silence call).
  ELEVENLABS_STT_VAD_THRESHOLD: z.coerce.number().min(0).max(1).default(0.4),
  // MongoDB connection string. Supplied by docker-compose as a ready-to-use URI;
  // optional otherwise. The Sienna agent persists personality + memory here; with
  // no URI (or no Gemini config) the agent is disabled and agent_input returns
  // agent_unavailable — the rest of the dashboard keeps working.
  MONGODB_URI: z.string().optional(),
  // ---- Gemini — the agent's reasoning, vision, and Enhance model ----
  // Everything LLM runs on Gemini (gemini-2.5-flash, non-thinking, streaming):
  // the agent loop, the `look` vision tool, and the Speak-box Enhance feature.
  // Configure via EITHER:
  //   - GEMINI_API_KEY (the Gemini Developer API / Google AI Studio key), OR
  //   - GEMINI_VERTEX_PROJECT + GEMINI_VERTEX_LOCATION (Vertex AI; auth via
  //     Application Default Credentials — point GOOGLE_APPLICATION_CREDENTIALS at
  //     the service-account JSON).
  // GEMINI_API_KEY takes precedence when both are present. The agent needs
  // MONGODB_URI + one of these; without them it's disabled.
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_VERTEX_PROJECT: z.string().optional(),
  GEMINI_VERTEX_LOCATION: z.string().optional(),
  GEMINI_MODEL_ID: z.string().default("gemini-2.5-flash"),
  // Gemini token pricing for the dashboard's Usage meter, in $ per 1,000,000
  // tokens. Defaults are Gemini 2.5 Flash list prices — VERIFY at
  // ai.google.dev/pricing and override to match your actual plan; they change.
  // Image input is metered as input tokens, so IMAGE defaults to the input rate.
  // Each call's cost is computed + stored at the rate in effect then (so changing
  // these later won't rewrite past history).
  GEMINI_PRICE_INPUT_PER_1M: z.coerce.number().nonnegative().default(0.3),
  GEMINI_PRICE_OUTPUT_PER_1M: z.coerce.number().nonnegative().default(2.5),
  GEMINI_PRICE_IMAGE_PER_1M: z.coerce.number().nonnegative().default(0.3),
  // Personality record is prepended to every prompt (cached prefix), and grows
  // additively on each reflection tick. Cap is in ESTIMATED TOKENS; the evolution
  // pipeline compresses only when a grown record exceeds it.
  SIENNA_PERSONALITY_TOKEN_CAP: z.coerce.number().int().positive().default(4000),
  // Output budget for the additive-evolve model call (Pass 1, before the gate).
  SIENNA_PERSONALITY_EVOLVE_MAX_TOKENS: z.coerce.number().int().positive().default(5000),
  // Recent conversation turns + auto-recalled memories included per run.
  SIENNA_HISTORY_TURNS: z.coerce.number().int().nonnegative().default(12),
  SIENNA_RECALL_LIMIT: z.coerce.number().int().nonnegative().default(3),
  SIENNA_RUN_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  // Reflection is event-driven, not timed: each HUMAN interaction (a completed
  // push-to-talk / eavesdrop / dashboard turn) cancels any pending reflections and
  // schedules a fresh sequence at these offsets from the interaction. Default
  // 5 min, 2 h, 24 h — she mulls things over shortly after you talk, again later,
  // and once more a day on, then goes quiet until the next interaction. The list
  // length sets how many reflections per interaction; empty disables reflection.
  SIENNA_REFLECTION_DELAYS_MS: z
    .string()
    .default("300000,7200000,86400000")
    .transform((s) => s.split(",").map((x) => parseInt(x.trim(), 10)).filter((n) => Number.isFinite(n) && n >= 0)),
  // Reflection entropy: each tick reflects on a random SAMPLE_SIZE slice shuffled
  // out of the newest POOL activity items (messages/memories/personality/tools/
  // images), and is shown the last HISTORY reflections so she doesn't repeat them.
  SIENNA_REFLECTION_SAMPLE_SIZE: z.coerce.number().int().positive().default(20),
  SIENNA_REFLECTION_POOL: z.coerce.number().int().positive().default(100),
  SIENNA_REFLECTION_HISTORY: z.coerce.number().int().nonnegative().default(5),
  // Push-to-talk (the device's GPIO 45 button). MAX_HOLD_MS caps a single hold —
  // a stuck button or a lost release event must not pin the mic open forever.
  // RELEASE_GRACE_MS waits for the trailing device mic frames (~50 ms apart) to
  // land in Scribe before the forced commit; COMMIT_TIMEOUT_MS bounds the wait
  // for that commit's transcript before routing whatever was accumulated.
  SIENNA_PTT_MAX_HOLD_MS: z.coerce.number().int().positive().default(60000),
  SIENNA_PTT_RELEASE_GRACE_MS: z.coerce.number().int().nonnegative().default(300),
  SIENNA_PTT_COMMIT_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
  // Listen beep: the "I'm listening" cue the moment a PTT press opens the mic
  // (the same rising two-tone chirp the wake word used to play, pitched just
  // below the commit beep). HZ2=0 plays a single tone. ENABLED=0 silences it.
  SIENNA_PTT_BEEP_ENABLED: z
    .string()
    .optional()
    .transform((v) => v == null ? true : !(v === "0" || v === "false")),
  SIENNA_PTT_BEEP_HZ: z.coerce.number().min(20).max(20000).default(1440),
  SIENNA_PTT_BEEP_HZ2: z.coerce.number().min(0).max(20000).default(1540),
  SIENNA_PTT_BEEP_MS: z.coerce.number().int().min(1).max(10000).default(50),
  SIENNA_PTT_BEEP_AMPLITUDE: z.coerce.number().min(0).max(1).default(0.25),
  // Server-side end-of-speech detection (drives "manual" commits). An EMA noise
  // floor adapts to the room; rms > floor*FACTOR is speech; SILENCE_MS of quiet
  // after >= MIN_SPEECH_MS of speech commits the utterance. 0 disables (rely on
  // ELEVENLABS commit_strategy instead).
  SIENNA_ENDPOINT_ENABLED: z
    .string()
    .optional()
    .transform((v) => v == null ? true : !(v === "0" || v === "false")),
  // SILENCE_MS is the dominant responsiveness knob: lower = she finalizes sooner
  // (snappier replies) but risks committing on a mid-sentence pause. 400 ms is a
  // snappy-but-safe default; raise it toward 800 if she cuts you off, drop toward
  // 300 if she still feels laggy.
  SIENNA_ENDPOINT_SILENCE_MS: z.coerce.number().int().positive().default(400),
  SIENNA_ENDPOINT_MIN_SPEECH_MS: z.coerce.number().int().positive().default(150),
  SIENNA_ENDPOINT_SPEECH_FACTOR: z.coerce.number().positive().default(2.5),
  SIENNA_ENDPOINT_ALPHA: z.coerce.number().min(0).max(1).default(0.1),
  // Commit beep: the "I heard you, I'm processing" cue the moment a finalized
  // transcript routes to the agent — so you know to stop talking. Now a short
  // rising two-tone chirp (HZ then HZ2, each MS long); HZ2=0 plays a single tone.
  // The amplitude is scaled by the master volume (SIENNA_VOLUME) and clamped to 1
  // before sending. ENABLED=0 silences it.
  SIENNA_COMMIT_BEEP_ENABLED: z
    .string()
    .optional()
    .transform((v) => v == null ? true : !(v === "0" || v === "false")),
  SIENNA_COMMIT_BEEP_HZ: z.coerce.number().min(20).max(20000).default(1540),
  SIENNA_COMMIT_BEEP_HZ2: z.coerce.number().min(0).max(20000).default(1640),
  SIENNA_COMMIT_BEEP_MS: z.coerce.number().int().min(1).max(10000).default(50),
  SIENNA_COMMIT_BEEP_AMPLITUDE: z.coerce.number().min(0).max(1).default(0.25),
  // Her `listen` tool: how long (seconds) she opens the mic when she chooses to
  // actively hear the room. Default 20 leaves margin under SIENNA_RUN_TIMEOUT_MS
  // for the follow-up think→speak; min/max clamp her requested duration.
  SIENNA_LISTEN_SECONDS_DEFAULT: z.coerce.number().int().positive().default(20),
  SIENNA_LISTEN_SECONDS_MIN: z.coerce.number().int().positive().default(5),
  SIENNA_LISTEN_SECONDS_MAX: z.coerce.number().int().positive().default(30),
  // After the speak TOOL plays, flash the blue LED and open the mic this long to
  // catch a reply, then stop. Degrades to plain speak when STT (micListener) is off.
  SIENNA_SPEAK_LISTEN: z
    .string()
    .optional()
    .transform((v) => v == null ? true : !(v === "0" || v === "false")),
  SIENNA_SPEAK_LISTEN_SECONDS: z.coerce.number().int().positive().default(10),
  SIENNA_SPEAK_LISTEN_DRAIN_CAP_MS: z.coerce.number().int().nonnegative().default(4000),
  // Ambient autonomy — eavesdrop (mic) and the camera glance each run at most once
  // a day, only between ACTIVE_HOURS (local Eastern; default 7 am–10 pm), gated on
  // the Autonomous-speech toggle and skipped mid-conversation. CHECK_MS is how
  // often each polls to see if it's time; the window + once-a-day rate-limit do the
  // real gating. ACTIVE_HOURS_END is exclusive (22 = stop at 10 pm).
  SIENNA_ACTIVE_HOURS_START: z.coerce.number().int().min(0).max(23).default(7),
  SIENNA_ACTIVE_HOURS_END: z.coerce.number().int().min(1).max(24).default(22),
  SIENNA_AMBIENT_CHECK_MS: z.coerce.number().int().positive().default(1800000),
  // Eavesdrop: open the mic for SECONDS and route overheard speech as a turn she
  // may join; silence is ignored. INTERVAL_MS is the minimum gap between eavesdrops
  // (default 1 day; 0 disables).
  SIENNA_EAVESDROP_INTERVAL_MS: z.coerce.number().int().nonnegative().default(86400000),
  SIENNA_EAVESDROP_SECONDS: z.coerce.number().int().positive().default(60),
  // Camera glance: snap one frame, analyze it, and remark on it ONLY if she sees a
  // person (silent otherwise). INTERVAL_MS is the minimum gap between glances
  // (default 1 day; 0 disables).
  SIENNA_GLANCE_INTERVAL_MS: z.coerce.number().int().nonnegative().default(86400000),
  // Tool-use loop iteration cap (backstop) + runaway guard: how many times the
  // SAME tool call may return an error in a row before she's deemed stuck.
  SIENNA_MAX_ITERATIONS: z.coerce.number().int().positive().default(12),
  SIENNA_MAX_TOOL_REPEAT: z.coerce.number().int().positive().default(3),
  // Locations of the media binaries for play_audio_file / play_youtube / play_music.
  FFMPEG_PATH: z.string().default("ffmpeg"),
  YT_DLP_PATH: z.string().default("yt-dlp"),
  // yt-dlp `youtube:player_client` extractor-arg (a comma list) applied to every
  // yt-dlp call (search + audio extraction). Lighter clients skip the slow JS
  // signature decryption and shave seconds off extraction. It's YouTube-version-
  // sensitive — a client can break/recover as Google changes things — so it's a
  // tunable knob: set "" to drop the flag entirely and use yt-dlp's own default.
  YT_DLP_PLAYER_CLIENTS: z.string().default("default,android"),
  // Loudness cap on the music decode — an ffmpeg -af filter chain applied to every
  // playUrl/playYoutube* pipeline (play_audio_file / play_youtube / play_music; her
  // TTS voice never passes through ffmpeg). YouTube tracks vary wildly in mastered
  // loudness; the default rides hot tracks DOWN to a ceiling and never boosts quiet
  // ones (acompressor's makeup defaults to 1): a slow RMS compressor levels sustained
  // loudness above ~-20 dBFS, then a lookahead peak limiter caps peaks at 0.5
  // (-6 dBFS) — exactly the headroom the default SIENNA_VOLUME=200% (+6 dB) consumes,
  // so hot masters no longer hard-clip at the int16 rails after the master gain.
  // alimiter's level=false is load-bearing: auto-level defaults ON and would amplify
  // the limited signal right back up. Streaming-safe (no lookbehind beyond alimiter's
  // few-ms lookahead). Tune by ear; set empty to disable (raw decode, old behavior).
  SIENNA_MUSIC_FILTER: z.string().default(
    "acompressor=threshold=0.1:ratio=12:attack=200:release=1000,alimiter=limit=0.5:level=false",
  ),
  // Music jukebox (play_music): how many YouTube results to pull per query — they're
  // shuffled into a never-ending mix (more = more variety, slower first search) — and
  // how long the mix waits for the speaker to free up (after her voice preempts a
  // track) before resuming.
  SIENNA_MUSIC_SEARCH_LIMIT: z.coerce.number().int().positive().max(200).default(50),
  SIENNA_MUSIC_RESUME_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  // Max time play() waits to confirm the fused cache-miss search produced audio
  // before returning optimistically (so a no-results query surfaces as an error).
  SIENNA_MUSIC_START_CONFIRM_MS: z.coerce.number().int().positive().default(8000),
  // No-repeat window: the last N tracks that actually played are excluded from every
  // mix (a by-name single-song request is exempt; when even the escalated searches
  // find nothing outside the window, the window is cleared and the rotation starts
  // over). Persisted in Mongo when available. 0 disables history tracking entirely.
  SIENNA_MUSIC_HISTORY_LIMIT: z.coerce.number().int().nonnegative().default(500),
  // Restart resume: a live mix is checkpointed to Mongo on every track start, and at
  // boot the saved session (current track + remaining queue) resumes when the device
  // reconnects — but only if the checkpoint is younger than this (a server that was
  // down overnight shouldn't blast music at boot). 0 = no age limit (always resume).
  SIENNA_MUSIC_RESUME_MAX_AGE_MS: z.coerce.number().int().nonnegative().default(3600000),
  // Buffered playback drain (play_audio_file / play_youtube / play_music). yt-dlp's
  // network delivery stalls, so the producer (reading ffmpeg stdout) is decoupled
  // from the paced device sender via an in-memory PCM queue. PREBUFFER_MS builds a
  // lead before the first frame so a network hiccup can't underrun the device's tiny
  // buffer; if the source ends or stalls first, playback starts after
  // PREBUFFER_TIMEOUT_MS anyway. MAX_BUFFER_MS bounds memory and propagates
  // backpressure down through ffmpeg → yt-dlp. (Her voice paths never stall and are
  // unaffected.) 0 prebuffer ⇒ start immediately (old behavior).
  SIENNA_PLAYBACK_PREBUFFER_MS: z.coerce.number().int().nonnegative().default(2000),
  SIENNA_PLAYBACK_PREBUFFER_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  SIENNA_PLAYBACK_MAX_BUFFER_MS: z.coerce.number().int().positive().default(8000),
  // Music streaming-health diagnostics. The per-track summary line (deviceBuf peak,
  // backpressure pauses, queue underruns, max inter-frame gap) is ALWAYS logged. Set
  // this to a millisecond interval (e.g. 2000) to ALSO emit a live "audio-stats"
  // sampler that often while a track plays — for watching a stutter happen live.
  // Reading it: deviceBuf riding near its HIGH mark with many pauses ⇒ the device's
  // Wi-Fi link is saturated; queue hitting 0 with underruns while deviceBuf stays
  // low ⇒ upstream yt-dlp/ffmpeg starvation (not the device link). 0 ⇒ summary only.
  SIENNA_AUDIO_STATS_MS: z.coerce.number().int().nonnegative().default(0),
  // Per-frame pacing for MUSIC playback (ms between 2048-sample frames). Frame audio is
  // 128 ms, so the default 128 is EXACT realtime: net ring fill ≈ 0, so a long track
  // neither overflows the device ring (the old 120 over-delivered ~7% and slowly filled
  // it → DROPPED frames) nor systematically drains it. Her VOICE streams ~1.6× realtime
  // (80 ms) to bank the short reply on-device; music tracks are long, so they must track
  // the DAC rate. The device's deep ring (≈2.56 s) absorbs Wi-Fi jitter in BOTH directions,
  // so realtime pacing no longer underruns on a slow burst. Lower toward 120 only if you
  // hear underrun gaps (and accept slow overflow on long tracks); raising past 128 will
  // under-deliver and eventually drain the ring.
  SIENNA_MUSIC_PACING_MS: z.coerce.number().int().positive().default(128),
  // Per-frame pacing for HER VOICE (ms between 2048-sample frames). This is the DELIVERY
  // rate into the device ring, NOT speech speed — the device plays at 16 kHz regardless,
  // so it never changes how fast she talks. 80 ms ≈ 1.6× realtime banks her short reply
  // on-device so a mid-reply network blip still completes from the buffer; 128 ms = exact
  // realtime (no bank-ahead, leans on the deep device ring). Live-tunable via the dashboard
  // TTS-pace slider and persisted across restarts (like volume / music pacing).
  SIENNA_TTS_PACING_MS: z.coerce.number().int().positive().default(80),
  // Lead-in: when a "play X" tool fires its spoken heads-up ("getting that…"), the
  // music's yt-dlp extraction starts immediately but the speaker is NOT claimed until
  // the heads-up finishes — so the announcement is heard and the extraction overlaps
  // it. This caps how long the music waits for that heads-up before taking over anyway.
  SIENNA_PLAYBACK_LEADIN_TIMEOUT_MS: z.coerce.number().int().positive().default(4000),
  // Half-duplex echo-tail MARGIN (ms). The server sends audio ~1.6x realtime, so when a
  // clip's drain ends the device still has unplayed audio BUFFERED (for a short reply,
  // almost the whole thing). The echo gate (transcriber + PTT coordinator) automatically
  // stays closed until that buffered audio would finish playing (computed from samples sent
  // vs. elapsed) — this knob is the EXTRA cushion on top, for room reverb + Scribe latency.
  // Too small ⇒ her last word leaks back in as a phantom user utterance. 0 ⇒ no margin (still
  // waits out the device buffer). Default 500 ≈ reverb decay + first-frame startup slop;
  // raise it (600-800) if her last word still leaks, lower it if the mic feels slow to re-engage.
  SIENNA_ECHO_TAIL_MS: z.coerce.number().int().nonnegative().default(500),
  // Master speaker volume (percent). Applied server-side as a gain on every PCM
  // frame sent to the device — the firmware plays PCM verbatim, so this is the
  // only volume knob. 100 = unity; the small amp/speaker run quiet, so the
  // default boosts. Settable live by Sienna's set_volume tool and the Voice-panel
  // slider (0 … SIENNA_VOLUME_MAX); resets to this default on restart.
  SIENNA_VOLUME: z.coerce.number().int().min(0).max(400).default(200),
  SIENNA_VOLUME_MAX: z.coerce.number().int().min(100).max(400).default(400),
  // Music bed level under her voice (percent of full volume): when she speaks
  // over music, the music keeps playing mixed under her at this level and
  // returns to full when she finishes. 0 disables ducking (music goes silent
  // under her voice, the old behavior).
  SIENNA_DUCK_PERCENT: z.coerce.number().int().min(0).max(100).default(20),
  // Music level while the PTT button is held (percent of full volume).
  // 0 (default) = full mute: a press silences music instantly (the firmware
  // also hard-gates the speaker on the raw button level) and it rejoins live
  // at finalize. >0 streams a quiet ducked bed instead — but the firmware
  // discards all frames while the button is physically down, so the bed is
  // only audible between release and finalize; >0 also requires the firmware
  // that lifts the half-duplex mic gate while PTT is held.
  SIENNA_PTT_DUCK_PERCENT: z.coerce.number().int().min(0).max(100).default(0),
  // Weather (Open-Meteo — free, no API key). The agent gets ambient current
  // conditions refreshed every WEATHER_REFRESH_MS into her "Right now" context and
  // a check_weather forecast tool that reaches ~16 days out. Location defaults to
  // Kanata, Ontario. Only active when the agent is enabled (MONGODB_URI + Gemini).
  WEATHER_LAT: z.coerce.number().default(45.3333),
  WEATHER_LON: z.coerce.number().default(-75.9),
  WEATHER_REFRESH_MS: z.coerce.number().int().positive().default(1800000),
});

export function loadConfig(env = process.env) {
  return Object.freeze(envSchema.parse(env));
}
