# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Sienna is a **push-to-talk** ESP32-S3 voice device with a server-side agent.
There is no wake word: you talk to her by holding the physical PTT button
(GPIO 45); she can also open the mic herself via her `listen` tool, but when
she initiates a conversation you still answer by pressing the button. (The
earlier wake-word stack — on-device Edge Impulse classifier, training data,
`server/wakeListen.js` — was removed in 2026-06; it lives in git history.)

- `esp32/` — Arduino firmware for the ESP32-S3-WROOM-1

## Repository Layout

```
esp32/
  sienna_dashboard/    Main firmware: BLE provisioning + Wi-Fi + WS dashboard client
  mic_speaker_test/    (legacy) I2S mic + speaker bring-up
  speaker_test/        (legacy) Standalone speaker test
  led_test/            (legacy) RGB + blue LED test
  lsr_test/            (legacy) LDR test
server/
  index.js             Express + WS dashboard backend
  public/              Static dashboard SPA (provision + dashboard)
  recordings/          Saved WAV files (gitignored)
```

## Commands

### ESP32 firmware (`esp32/`)

Built with **Arduino IDE** (not CLI). Requires the "esp32 by Espressif Systems" board package >= 3.0.0. Board: **ESP32S3 Dev Module**, USB CDC On Boot: Enabled. Upload via Arduino IDE or `arduino-cli`.

**Partition scheme (required for `sienna_dashboard`):** the firmware (NimBLE +
Wi-Fi + WebSocket + camera + dual-I2S audio, ~1.41 MB) does **not** fit the
stock 1.25 MB app partition — a default build fails with `text section
exceeds available space in board`. The sketch ships an
`esp32/sienna_dashboard/partitions.csv` ("Huge APP" — 3 MB app, no OTA, 1 MB
SPIFFS) which arduino-esp32 auto-detects. If a build still reports the
1.25 MB ceiling, set **Tools → Partition Scheme → "Huge APP (3MB No
OTA/1MB SPIFFS)"** (note: plain *"Minimal"* is still 1.25 MB and will not
fit — you want *"Minimal SPIFFS"* or *"Huge APP"*). Flash Size 4 MB matches
the table; the Freenove ESP32-S3-WROOM CAM module typically has 8 MB, which
also works (upper region unused). No OTA code is present, so dropping OTA
costs nothing today.

#### Push-to-talk button (`sienna_dashboard`)

A physical pushbutton on **GPIO 45** (`pins::PTT_BTN`, active-low to GND with
the internal pullup — a strapping pin, but low is its boot default, VDD_SPI
3.3 V, so holding it through a reset is harmless; GPIO 46 isn't broken out on
the Freenove FNK0085 headers) is the only human→Sienna voice input:

- `buttons.cpp` polls it from `loop()` with a 30 ms time-based debounce and
  fires `onPttChange(pressed)` on each stable edge (`buttons::pttHeld()`
  exposes the debounced state).
- **Raw-GPIO instant mute (the audible cut):** the playback task probes the
  RAW PTT level (`buttons::pttRawDown()`, via `audio_io::setMuteProbe`) before
  every frame it writes and DISCARDS while the button is physically down;
  `playPcmStreamFeed` drops incoming frames too (nothing banks in the ring to
  burst out stale on release) **and breaks out of its ring-full wait the instant
  the button is down** — without that bail, a full ring × up to 8 frames per
  `ws_client::tick()` could park `loop()` for seconds (the old per-frame wait was
  500 ms), so `buttons::tick()` never ran, the press went undetected, and the
  listen beep / `start_recording` lagged the press by ~1–2 s during music. The
  non-recording wait is now bounded to `PLAY_FEED_MAX_WAIT_MS` (120 ms). The
  speaker therefore dies within one ~64 ms frame of the press — no debounce, no
  `loop()` latency, no server round-trip. `playTone` is deliberately not gated
  (the listen/commit beeps must sound during a hold).
- **Press-edge fast path (in the `.ino` callback):** the press locally calls
  `audio_io::playPcmStreamFlush()` WITHOUT waiting for the server's
  `stop_audio`. With music playing, ~0.5–1.5 s of already-sent PCM sits in the
  WS socket + the playback ring AHEAD of the server's `stop_audio`/
  `start_recording`, and feeding it into the full ring stalls `loop()` at
  ~realtime per frame — the mic used to open 1–2 s after the press and short
  utterances were swallowed entirely (the original "no audio registered while
  music was playing" bug). The local flush drops that backlog instantly so the
  server's commands process within ~100 ms.
- **Half-duplex mic gate lifted while held:** `onPcmFrame` drops mic frames
  while `isSpeakerActive()` — EXCEPT while `buttons::pttHeld()`, because the
  PTT duck keeps the (quiet) music bed playing during the hold and the user's
  speech must stream over it. While `gRecording`, `playPcmStreamFeed` also
  stops waiting for ring space (drops the bed frame instead) so the mic-read
  cadence never starves, and `playTone` holds the speaker mutex across the
  whole beep so it can't interleave with bed frames.
- The `.ino` callback also does two things: flashes the **blue LED at 3 Hz** while
  held (`led_io::setBlueFlash` — non-blocking, driven by `led_io::tick()`;
  a `set_blue_led` arriving mid-flash updates the *restore target*, applied on
  release) and, when ONLINE, sends `{"type":"button","id":"ptt","pressed":…,
  "ts_ms":…}` (`protocol::buildButton`). The device sends **events only** —
  the server remains the sole arbiter of `start_recording`/`stop_recording`
  via `micStream.js`. Offline edges are dropped (the LED still flashes); the
  server's disconnect reset + 60 s max-hold cap cover a lost release.

### Dashboard server (`server/`)

Node 22+, ESM. Runs Express + two WebSocket endpoints (`/ws/device`,
`/ws/browser`) routed through an in-memory bridge.

```bash
cd server
cp .env.example .env
# Edit DASHBOARD_TOKEN
npm install
npm test            # node:test, no extra runner
npm start           # listens on PORT (default 3387)
```

Open `http://<host>:3387/` for the provisioning page (Web Bluetooth in
Chrome/Edge), `http://<host>:3387/dashboard.html` for the live dashboard.

#### Device mic stream (single ref-counted resource)

The firmware streams mic PCM (16 kHz mono Int16, binary tag `0x01`) only while
"recording" (`start_recording` → `stop_recording`). Three server-side consumers
share that one stream and may overlap: the WAV **Recorder**, the Scribe
**transcriber** (Push-to-Talk), and the dashboard's **Listen** monitor.
`server/micStream.js` is the ref-counted arbiter and the **sole** sender of
`start_recording`/`stop_recording` to the device — it starts the stream on the
0→1 holder transition and stops it on the last release, so consumers never stomp
each other. Each consumer holds a token (`"record"`, `"transcription"`, or
`listen:<uuid>` per browser); `ws-browser.js` and `transcriber.js` acquire/release
it, and `index.js` calls `micStream.reset()` on device disconnect. `start_recording`/
`start_listening`/`stop_*` are consumed server-side (never forwarded to the
device); only the WAV path saves a file, so Listen and transcription run without
recording. **Listen** (`public/js/panels/listen.js`) plays the already-broadcast
`0x01` frames locally via Web Audio (per-browser; the stream stays up as long as
any consumer holds it).

#### Voice → Sienna (push-to-talk → the agent)

Speech reaches the agent only while the user holds the device's PTT button —
the dashboard has no voice-input control (the Speech panel is a read-only
monitor: a "listening" indicator driven by the broadcast `button` events, live
interim words, and a log of finalized phrases). The chain and its non-obvious
correctness pieces:

- **PTT coordinator** (`server/ptt.js`, `createPttCoordinator`; built
  unconditionally in `index.js`). Device `{type:"button", id:"ptt", pressed}`
  edges drive a state machine (`idle → held → finalizing → idle`):
    The *audible* cut on press is device-side and immediate (the raw-GPIO
    instant mute below); everything here is the protocol that follows.
  - **Press**: MUTES the speaker transmit gate (`audioOut.mute()` — one
    `stop_audio` flush; her voice frames are then dropped server-side; with
    `SIENNA_PTT_DUCK_PERCENT` (default **0** = full mute) > 0, MUSIC frames
    keep transmitting ducked — but the firmware discards all frames while the
    button is physically down, so a bed is only audible in the release→finalize
    gap). Nothing stops or pauses: playback keeps "running" silently (frames
    dropped at realtime so unmute rejoins live at full volume) — then
    `transcriber.start()` (which acquires the mic via `micStream`). The
    **listen beep** (`SIENNA_PTT_BEEP_*`, the wake word's old 1440→1540 Hz
    two-tone chirp) fires **immediately on the press edge** — before
    `transcriber.start()`, independent of whether the session comes up — because
    `scribe.js` now **buffers and flushes** any audio spoken before the realtime
    WS finishes its handshake (a bounded ~5 s catch-up queue, oldest-dropped on
    overflow), so the leading words are no longer lost and the cue needn't wait
    for the mic to open. The mute runs even when
    Scribe isn't configured, so a tap always means "quiet". Unmuted at
    **finalize** (not raw release — music can't land in the transcript during
    the release grace) and on `endNow()`/`cancel()`/max-hold. A transcriber
    session the coordinator didn't start is never hijacked (defensive —
    nothing else starts one today); a stuck button / lost release is capped by
    `SIENNA_PTT_MAX_HOLD_MS` (60 s → auto-finalize).
  - **Hold**: committed transcripts *accumulate* (ElevenLabs VAD may finalize
    mid-hold pauses) — nothing routes yet, no beep.
  - **Release**: after `SIENNA_PTT_RELEASE_GRACE_MS` (300 ms — lets trailing
    mic frames land) it calls `transcriber.commitNow()` — a forced commit
    riding **50 ms of synthetic silence** (Scribe has no frame-less commit) —
    waits for the answering commit (every commit, even empty, is observable via
    the transcriber's `onCommitObserved`; `SIENNA_PTT_COMMIT_TIMEOUT_MS` bounds
    the wait), then stops the transcriber and routes the **joined** text as ONE
    `agent.run(text, {source:"ptt"})` turn, firing the commit beep
    (`SIENNA_COMMIT_BEEP_*`, a `createCommitBeep` instance → server-built
    `play_tone`; the ESP synthesizes the sine on-device).
  - **No continuation window**: every utterance needs the button. When she
    initiates a conversation herself (reflection/autonomy or her `listen`
    tool), you still answer by pressing the button — nothing reopens the mic
    after she speaks. `ptt.endNow()` backs the `stop` tool; `ptt.cancel()`
    (device disconnect) clears state WITHOUT `transcriber.stop()` (the
    disconnect path already releases the mic token — avoid double-release).
  The unowned path (a transcriber session not started by the coordinator —
  defensive only) routes each commit verbatim as `source:"ptt"`, dropped while
  her TTS is audible (echo).
- **End-of-speech / commits.** ElevenLabs Scribe only routes on a
  `committed_transcript`. The default is `commit_strategy: "vad"` — ElevenLabs'
  own model-based VAD (finalizes ~120-150 ms after end-of-speech; robust against
  the high-gain mic's noise floor — it's a speech model, not an energy gate).
  Tuned via `ELEVENLABS_STT_VAD_SILENCE_SECS` (0.4 s) +
  `ELEVENLABS_STT_VAD_THRESHOLD` (0.4). **`commit_strategy: "manual"` never
  auto-commits** — it depends on explicit server commits. The manual path uses
  `server/endpointer.js` (EMA noise-floor detector on the `mic_rms` stream; it
  failed on the high-gain mic, hence VAD default) → `transcriber.commitNextChunk()`
  latches `commit:true` onto the next mic frame. Built **only in `"manual"`
  mode**; tune via `SIENNA_ENDPOINT_*`. PTT's release-time `commitNow()` works
  under either strategy.
- **Echo gate.** Her TTS plays the speaker while the mic may be streaming, so
  the transcriber drops mic frames while `audioOut.isPlayingOrTail()`
  (`shouldFeed` in `transcriber.js`), and the unowned routing path drops
  commits while she's audible. `commitNow()` deliberately bypasses the gate
  (its synthetic frame must always reach Scribe).

#### Docker (server + MongoDB)

`server/` ships a `Dockerfile` and `docker-compose.yml` that bring up the
dashboard server plus a MongoDB instance:

```bash
cd server
cp .env.example .env   # if you don't already have one; edit token / API keys
docker compose up       # add --build to rebuild, -d to detach
```

- The **server** service builds from `server/Dockerfile`, reads `.env` via
  `env_file`, and is reachable at `https://<host>:${SERVER_PORT}/` (default 3387).
  Inside the container it serves **HTTPS/WSS** on `0.0.0.0:3387`: compose
  overrides `LOCALHOST_ONLY` (so the published port binds `0.0.0.0`) and points
  `TLS_CERT`/`TLS_KEY` at the host's `./certs` dir, bind-mounted read-only at
  `/certs` (the certs are gitignored and never baked into the image — generate
  them first per the TLS section of `.env.example`). The healthcheck probes over
  HTTPS, accepting the self-signed cert. Recordings persist in the `recordings`
  named volume.
- The **mongo** service (`mongo:7`) is provisioned with root credentials from
  `.env` and persists to the `mongo-data` volume. The server receives a
  ready-to-use `MONGODB_URI` (`mongodb://…@mongo:27017/<db>?authSource=admin`).
  No application code consumes it yet — it's wired and ready for future
  persistence work.

Env vars are routed per-service in `docker-compose.yml`: app config + API keys
go to the server; `MONGO_INITDB_*` creds go to mongo; `MONGODB_URI` is built
from those creds and handed to the server.

The dashboard's **Voice** panel (formerly "Speak", `js/panels/tts.js`,
`#panel-tts`) does text-to-speech: type text → optional **Enhance** (Claude
inserts ElevenLabs v3 audio tags) → **Speak** (the server synthesizes **and**
streams to the device speaker — `POST /api/tts` → `audioOut.speak`, the shared
HTTP `/stream` eleven_v3 path; the browser just sends text and shows status, no
client-side decode/resample). It also hosts the
**Hold to talk** loopback button (the `#ptt` mic→speaker passthrough wired by
`loopback.js`), relocated here from the Audio panel — `loopback.js` finds `#ptt`
by global id, so the move was markup-only. A **Volume** slider here drives the
master speaker volume — a server-owned gain (`server/volume.js`) applied to
**every** PCM frame the server forwards to the device, since the firmware plays
PCM verbatim (no device-side gain). It's threaded into `audio-out.js` (her speak /
file / YouTube paths) and `ws-browser.js`'s binary handler (browser-originated
Speak + Hold-to-talk), set live by the slider's `set_volume` message **and**
Sienna's `set_volume` tool, with an `onChange` broadcast (`{type:"volume"}`) so
every open slider stays in sync (incl. when she changes it). Created
unconditionally (independent of the agent), default `SIENNA_VOLUME` (200%), clamp
`0…SIENNA_VOLUME_MAX` (400%). When Mongo-backed memory exists, every change is
write-through persisted to the `settings` store and restored at boot (before the
server listens), so the last set volume **survives restarts**; without Mongo it
stays in-RAM and resets to the default. The slider is whitelisted
in `disableAllControls` (server-side state, usable while the device is offline).
Synthesis + device streaming (`POST /api/tts`, fire-and-forget — it returns a JSON
status, `{ok:true}` or `503 device_offline`/`tts_not_configured`, as soon as the
stream is kicked off so a long clip doesn't hold the request open) and tag
enhancement (`POST /api/enhance`) run server-side, keeping API keys out of the
browser. Configure via `.env`:
`ELEVENLABS_API_KEY` (+ `ELEVENLABS_VOICE_ID` default `iCrDUkL56s3C8sCRl7wb`,
`ELEVENLABS_MODEL_ID` default `eleven_v3`) and `ANTHROPIC_API_KEY` (+
`ANTHROPIC_MODEL_ID` default `claude-haiku-4-5`). Both keys are optional — each
feature returns 503 until its key is set. `@anthropic-ai/sdk` is a dependency;
ElevenLabs is called via global `fetch`.

#### Sienna agent (the "Sienna" dashboard widget)

The **Sienna** panel is her server-side agentic loop — a Claude tool-use loop
that is her ongoing mind. Plain text in the widget, finalized push-to-talk
transcripts (`source:"ptt"`, routed server-side via the transcriber's
`onFinalTranscript`), interaction-seeded reflections, an eavesdrop/camera glance,
and fired device timers all feed the same `agent.run(input, {source})`. Modules
(all DI-factory + `*.test.js`):

- `agent.js` — the loop: assemble prompt → `messages.create` with tools →
  execute `tool_use` → feed `tool_result` → repeat, capped at
  `SIENNA_MAX_ITERATIONS` (12). Reaching the cap is **not** an error: it does one
  final tool-less `messages.create` so she closes cleanly from the pending
  results (`stopReason: end_turn`). A conservative runaway guard breaks early only
  when the SAME tool call returns `is_error` `SIENNA_MAX_TOOL_REPEAT` (3) times in
  a row (the device-offline tarpit), reported as `agent_error: tool_stuck`. A
  failed model call (rate limit, auth, outage) is **spoken aloud**: the
  provider's literal error message (`errorSpokenText` digs `error.message` out
  of the JSON body genai/Anthropic SDKs stuff into `e.message`) goes straight to
  `audioOut.speak` in every mode — reflection included — bypassing the
  autonomy-gated speak tool, so an unattended failure is still heard. Runs
  are serialized through a promise mutex (never interleave; device-RPC stays
  single-flight); reflection ticks skip when busy. Non-reflection runs call
  `onActivity()` (feeds the reflection cadence). Streams `agent_status`/
  `agent_message`/`agent_tool`/`agent_tool_result`/`agent_error` to browsers, and
  a `sienna_entry` card event for the **user turn** and the **terminal** assistant
  text (1:1 with a turn — never the per-tool-round preamble persists) that the
  dashboard's card view renders live; `agent_message` still drives the transient
  "thinking" status only.
- `prompt.js` — layered system prompt: **immutable BASE** (identity, the one
  certain fact — mother Bharati, father Steve — harness rules, the speak tag
  vocabulary) + **mutable personality** + recalled memories + recent turns. Only
  BASE + personality carry `cache_control:ephemeral` (the stable cache prefix);
  the reflection instruction is a user message, never in BASE.
- `memory.js` / `db.js` — MongoDB persistence (driver `mongodb`). `personality`
  (singleton, capped at `SIENNA_PERSONALITY_CAP`, prior versions snapshotted to
  `personality_history`), `messages` (every turn), `memories` (saved facts).
  Recall is **keyword/text search** (`$text` indexes); `recallRelevant` is the
  auto-context entry point (kept separate so embeddings can slot in later).
  Newest-first card readers (`listRecentMessages`/`recentMemories`/
  `listPersonalityVersions`) back the dashboard's `/api/sienna/*` endpoints, and an
  optional `onChange` callback fires on `remember`/`setPersonality` (deliberately
  **not** `appendMessage` — message cards come from `agent.js` to avoid
  double-rendering) so new memories/personality versions broadcast as `sienna_entry`.
- `tools.js` — `look` (camera → `vision.js` runs a dedicated **factual
  image-analysis prompt** — persona-free, 1024 tokens, one retry on an empty
  Gemini-3.x thinking response — and the tool description tells her to
  REFLECT on the returned analysis in her own voice in the main loop, where
  her identity/personality/context live), `set_blue_led`/`set_white_leds`/`set_rgb`/`read_light_sensor`,
  `play_tone`/`speak`/`play_audio_file`/`play_youtube`/`stop_audio`/`set_volume`
  (her master speaker volume — see `volume.js`),
  `scan_wifi`/`scan_bluetooth`/`set_timer`, `search_memory`/`remember`/
  `update_personality`. `definitions(mode, autonomy)` withholds the vocalizing
  tools during reflection when autonomy is off; tool errors become `is_error`.
- `device-rpc.js` — sends a command and awaits the device's correlated response
  via new bridge taps (`onDeviceMessage`/`onDeviceBinary`): acks by `ref`, reads
  by next-of-type (or `ref` when firmware echoes it), `snapshot` by next JPEG
  binary. All with timeouts; disconnect rejects everything pending.
- `audio-out.js` — server-side speaker pipeline (browser-parity 1024-sample /
  60 ms / tag `0x03` pacing). Every TTS path now shares one HTTP streaming helper,
  `tts.stream` (ElevenLabs `/stream`, `eleven_v3`, `output_format=pcm_16000`, no MP3
  decode): the `speak` tool (full text, one request — emotion tags stay grouped),
  her gapless reply (`speakStream`, **sentence-chunked** — see below), and the
  browser `/api/tts`. `play_audio_file`/`play_youtube` spawn ffmpeg / yt-dlp |
  ffmpeg → 16 kHz mono, through a **music loudness cap** (`SIENNA_MUSIC_FILTER`,
  an ffmpeg `-af` chain on the decode): YouTube tracks are mastered at wildly
  different loudness, so the default rides hot tracks down (~-20 dBFS RMS
  compressor, no makeup — quiet tracks are never boosted) and caps peaks at
  0.5 (-6 dBFS). Order is cap → master volume → device: the filter runs inside
  ffmpeg, BEFORE `volume.applyGain` in `sendFrame`, so the default
  `SIENNA_VOLUME=200%` (+6 dB) lands capped music at exactly full scale instead
  of hard-clipping hot masters at the int16 rails. Her TTS voice never passes
  through ffmpeg and is unaffected. Empty disables. Two playback channels — **voice**
  (speak/speakStream/streamPcm/browser TTS) and **music**
  (jukebox/play_audio_file/play_youtube) — share the device through a transmit
  gate: voice outranks music (music ducks to a quiet bed mixed under her reply —
  `SIENNA_DUCK_PERCENT` — and **rejoins live** at full volume), and the PTT mute
  outranks both: voice drops entirely, music drops silently too at the default
  `SIENNA_PTT_DUCK_PERCENT=0` (>0 transmits a ducked bed, which the firmware's
  raw-GPIO instant mute discards while the button is down). Device arming is
  lazy per-channel (`play_audio_start` on the first transmitted frame; the
  winner of a focus handoff flushes the loser's tail with `stop_audio`).
  `isPlaying()`/`isPlayingOrTail()` are her-voice predicates and false while
  muted (the PTT mic gate depends on it). Her reply no longer supersedes a
  jukebox track — the jukebox's superseded/replay path only fires for
  music-over-music preemption. Emotion tags are emitted **inline** by Sienna in her own
  `speak` text (not re-run through the Haiku enhancer). Created **unconditionally**
  (independent of the agent, gated only on `tts`) so the browser Speak path works
  even when Sienna is off. The jukebox (`jukebox.js`) keeps a **no-repeat window**:
  every track that put frames on the wire is recorded (Mongo `music_history`
  singleton via `memory.getMusicHistory`/`setMusicHistory`, so it survives
  restarts) and the last `SIENNA_MUSIC_HISTORY_LIMIT` (500) of them are excluded
  from every mix queue build (play/refill/playMore) — matching on video id, exact
  normalized title, OR the parenthetical-stripped **base title** ("Song
  (Instrumental Mix)" ≡ "Song"), with batches deduped against themselves and
  queues **re-checked at play time** (a song that entered the window after the
  queue was built is skipped — incl. plays the `play_youtube` tool reports via
  `jukebox.notePlayed`; its single-video URLs feed the window, playlist URLs are
  untracked). When a query's pool runs dry, the refill **escalates instead of
  repeating** — the same top-50 search results were the bottleneck, not the
  window: a deep live search (3× `SIENNA_MUSIC_SEARCH_LIMIT`, capped 200; the
  background cache refresh searches deep too), then **LLM-brainstormed related
  queries** (`music-suggest.js` on the shared Gemini client, ~10 searches —
  related artists/sub-genres/vibes — shuffled and tried one by one until a fresh
  song turns up; a failed/unparseable call falls back to static "<q> songs"-style
  suffixes so music never stalls on the model). If even that finds nothing new,
  the window is **full** for that corner of music: the play history is **cleared
  outright** (persisted too) so the rotation starts over — only the just-played
  track is re-recorded, so it can't come straight back. A **by-name** single-song
  request (a `play()` with a `continuation`) is always exempt. A zero-result
  search (yt-dlp/network failure) skips escalation and keeps the backoff-retry
  path. `SIENNA_MUSIC_HISTORY_LIMIT=0` disables it all. The jukebox also exposes
  two seams wired in `index.js`: **now-playing broadcasts** — `onStateChange`
  fires on every state transition (track start, fused-title fill-in, pause/
  resume, stop, session end) and `index.js` maps `status()` →
  `{type:"now_playing", active, paused, title, artist, query}` to every browser
  (plus a connect-time push in `ws-browser.js`, so a fresh dashboard shows the
  live track); and **restart resume** — the live mix (query, continuation, full
  queue, position) is write-through checkpointed to Mongo on every track start
  (`memory.getMusicSession`/`setMusicSession`, singleton like the play history)
  and cleared when the session ends, and at boot `jukebox.restoreSession()`
  reloads it **parked at the suspend gate** so the existing
  `onDeviceConnected → resumeFromSuspend()` wiring resumes the interrupted track
  (from the top) and the rest of the queued mix the moment the device
  reconnects. A checkpoint older than `SIENNA_MUSIC_RESUME_MAX_AGE_MS` (1 h;
  0 = no limit) is discarded so a long-down server doesn't blast music at boot.
- `reflection.js` — **event-driven** "quiet moments" (replacing the old idle-decay
  scheduler, and `activity.js` / `ldr-activity.js`, both removed). Reflection is
  seeded ONLY by a completed **human interaction** — a push-to-talk, eavesdrop, or
  dashboard turn (`agent.js` forwards the run's `source` to `onActivity(source)`;
  `index.js` filters to `HUMAN_SOURCES` = `{text, ptt, eavesdrop}`, so a fired
  timer or her own camera glance does NOT count). Each interaction calls
  `reflection.onInteraction()`, which **cancels any still-pending reflections** and
  schedules a fresh sequence at `SIENNA_REFLECTION_DELAYS_MS` offsets from the
  interaction (default **+5 min, +2 h, +24 h** — three reflections tailing off; the
  list length sets the count, empty disables). With no further interaction all
  three fire; a new interaction wipes the pending tail and restarts the sequence —
  so an idle device is completely silent (no clock-driven reflection at all, and
  sudden light changes no longer wake her). A reflection that fires while she's
  busy is skipped (the in-flight conversation reschedules anyway). Reflection runs
  are not interactions, so they never reschedule themselves. She may stay silent,
  remember, refine personality, or — only when the **Autonomous speech** toggle is
  on — speak. That toggle **persists
  across restarts**: `agent.setAutonomy` write-throughs to a `settings` singleton
  via `memory.getSetting`/`setSetting` (Mongo `_id`-keyed, like `personality`), and
  `index.js` calls `agent.restoreAutonomy()` before the server listens so she
  resumes autonomous speech on boot even with no dashboard open. (The master
  volume persists the same way — a "volume" key in the same `settings` store,
  written from `index.js`'s volume onChange and restored at boot.)
- `ambient.js` / `active-hours.js` — shared machinery for her once-a-day ambient
  autonomy. `createAmbientTrigger` polls every `SIENNA_AMBIENT_CHECK_MS` (30 min)
  and acts only when: not already running, the **active-hours window is open**
  (`isWithinActiveHours`, default `SIENNA_ACTIVE_HOURS_START/END` = 7–22 in
  `America/Toronto`, so "7am–10pm Eastern" tracks EST/EDT), a `gate()` passes
  (autonomy on, no conversation in flight), and ≥ `minIntervalMs` since the last
  **completed** action. Its injected `run()` returns truthy only when it actually
  acted (device online), so a brief outage retries next tick instead of burning the
  day. `eavesdrop.js` and `camera-glance.js` are thin consumers of it.
- `eavesdrop.js` — **daily** ambient listening (built on `ambient.js`): at most
  once a day (`SIENNA_EAVESDROP_INTERVAL_MS`, 1 day; 0 disables) in waking hours she
  opens the mic for `SIENNA_EAVESDROP_SECONDS` (**60 s**) via `micListen.js` (its
  one-shot engine — own Scribe session and mic token, **no beep**; passes
  `maxSeconds` so the 60 s window isn't clamped by the `listen` tool's
  `SIENNA_LISTEN_SECONDS_MAX`). Overheard speech routes as one interactive
  `agent.run(text, {source:"eavesdrop"})` turn (vocal tools available, and as a
  human source it seeds her reflection sequence); silence still counts as the day's
  eavesdrop. Gated on **Autonomous speech** and skipped when a conversation is in
  flight (agent busy / PTT held / transcriber active / `listen` running / her voice
  audible) — re-checked after the window so a mid-listen PTT turn isn't
  double-routed. Built only when the agent **and** Scribe are configured.
- `camera-glance.js` — the visual sibling of eavesdrop (also on `ambient.js`): at
  most once a day (`SIENNA_GLANCE_INTERVAL_MS`, 1 day; 0 disables) in the same
  waking hours she takes ONE snapshot (`deviceRpc.requestBinary`) and runs `vision`
  on it with a structured `PERSON: yes/no` question. **Only if a person is visible**
  does she route an interactive `agent.run(..., {source:"glance"})` turn and speak
  about what she sees — an empty room is silent (detection lives here, not in the
  agent, so we don't lean on the interactive loop's auto-speak). `source:"glance"`
  is NOT a human source, so a glance never seeds reflection. Built unconditionally
  inside the agent block (needs only Gemini vision + the camera, not Scribe); gated
  exactly like eavesdrop.

The agent is enabled when `MONGODB_URI` is set **and** at least one reasoning
provider is configured — an `ANTHROPIC_API_KEY` **or** Gemini (`GEMINI_API_KEY`,
the Developer-API key, preferred; or `GEMINI_VERTEX_PROJECT`+`GEMINI_VERTEX_LOCATION`
for Vertex). `docker compose` wires `MONGODB_URI` automatically; otherwise the agent
is null and `agent_input` returns `agent_unavailable` — the rest of the dashboard is
unaffected. When Gemini is configured the reasoning runs on it (`GEMINI_MODEL_ID`,
default `gemini-2.5-flash`), and it can run **Gemini-alone** with no Anthropic key:
the `look` vision tool routes through Gemini too (`gemini.js` translates Anthropic
`image` blocks → `inlineData`), and only the Speak-box **Enhance** button degrades
(it stays on Anthropic). Claude fallback model: `SIENNA_MODEL_ID` (default
`claude-sonnet-4-6`, tool-use + vision), distinct from the Haiku `ANTHROPIC_MODEL_ID`
used only by Enhance. **Gapless streamed reply:** when reasoning on Gemini, her final
answer is **sentence-chunked** as it streams (`sentence-chunker.js`: a small first
chunk for fast first audio, then coalesce toward a target — `SIENNA_TTS_CHUNK_FIRST_CHARS`
/ `SIENNA_TTS_CHUNK_TARGET_CHARS`) and each chunk is synthesized over the HTTP
`/stream` endpoint with **`eleven_v3`** (so the streamed reply gets inline emotion
tags too, unlike the old flash-only WS path). Each sentence is synthesized
**standalone** — `eleven_v3` rejects `previous_text`/`next_text` with `400
unsupported_model`, so sending them killed every chunk after the first and cut her
reply to a single sentence; we never send them. A worker synthesizes chunks **in
order**, pre-buffering ahead of the 60 ms-paced drain, so audio begins essentially as
soon as the first sentence forms. `agent.js` synthesizes **during** generation but defers the device speaker
(`audioOut.speakStream({deferDeviceStart})`) until the turn is confirmed a spoken
answer — a tool round's preamble aborts the in-flight v3 render before a frame
reaches the device. (Anthropic, non-streaming, speaks its final answer via the
`speak` tool — also `eleven_v3` — through the auto-speak fallback.)
The
Docker image installs `ffmpeg` + `yt-dlp` for the audio tools. The new firmware
commands (`scan_wifi`/`scan_ble`/`set_timer`/`cancel_timer`; responses
`wifi_scan`/`ble_scan`/`timer_set`/`timer_fired`) live in
`esp32/sienna_dashboard/agent_tools.{h,cpp}` (non-blocking timers + BLE scan) and
`wifi_manager`'s async scan — all polled from `loop()` to respect the
loop-starvation constraint.

**Dashboard panel (`public/js/panels/sienna.js`).** Her widget is a four-tab,
horizontally-paged **card** view — **Activity** (a time-merged feed of `messages`
+ `memories` + `personality`/`personality_history`, plus live ephemeral `→ tool`
cards), **Messages**, **Memories**, **Personality History** — all
newest-on-the-right with auto-scroll-to-newest (when already at the right edge).
Cards are backfilled over REST (`GET /api/sienna/{activity,messages,memories,
personality}`, bearer-gated, `503 {error:"agent_unavailable"}` when the agent is
off) and kept live over the browser WS: `sienna_entry` (a normalized card — from
`agent.js` for messages, from `memory.js`'s `onChange` for memories/personality)
plus the existing `agent_tool`/`agent_tool_result` for the Activity-only tool
cards. `server/sienna-cards.js` (`toCard`/`mergeActivity`, pure) maps Mongo docs to
the one shared card shape on **both** the REST and live paths;
`public/js/panels/sienna-strip.js` holds the pure stick/format helpers
(`shouldStick`/`relTime`/`cardModel`). A per-strip id-set de-dupes the live-vs-REST
race, and the panel rebuilds on reconnect. Because card data is REST (device-
independent), the tab buttons stay enabled even while the device is offline and the
rest of the controls are disabled. The panel is topped by a **now-playing bar**
(`#sienna-nowplaying`, hidden while nothing plays) driven purely by the server's
`now_playing` messages — one arrives on WS connect with the current state, then
live on every jukebox state change — and the composer's **Send button sits on its
own line under the textarea** (`.sienna-input-row` is a column; a right-edge
button was easy to miss).

**Two-area layout (`dashboard.html` + `public/js/panels/views.js`).** A header
view-switcher (segmented `.view-tab` pills, `initViews`) toggles two `<main>`
areas — one visible at a time, the choice persisted in `localStorage`
(`sienna.view`): **Input / Output** (`#view-io`: Light sensor, Audio, LEDs,
Camera, Voice — a masonry/multi-column card layout) and **Sienna** (`#view-sienna`:
the card widget above plus the live **Speech** push-to-talk transcription panel
as a side rail, so you talk to her and see replies in one place). Panels are
position-independent — each `initX*` grabs its `#panel-*` by id then rewrites its
own `innerHTML`, so the areas are pure HTML re-parenting; only `dashboard.js`'s
init order is load-bearing (`loopback`/`listen` must run after the panels whose
markup they bind by id). The `.view-tab` buttons are whitelisted in
`disableAllControls` (alongside `.sienna-tab`), so the switcher and Sienna's
REST-backed history stay usable while the device is offline. The visual layer is
a CSS design-token system in `css/app.css` (`:root` spacing/radius/type scales,
one accent, `:focus-visible` rings, `prefers-reduced-motion`); token *names* are
unchanged so panel JS that references them keeps resolving. `.grid` is retained
for `provision.html`.

## Hardware Wiring (ESP32-S3, Freenove ESP32-S3-WROOM CAM)

Authoritative pin map for `esp32/sienna_dashboard/`. See
`esp32/sienna_dashboard/pins.h` for the canonical source of truth.

| Component | Signal | GPIO |
|-----------|--------|------|
| OV2640 camera | 14 lines | 4–18 (Freenove-fixed) |
| LDR | ADC1_CH0 | 1 |
| Blue LED | digital | 2 |
| Flashing LED string | digital | 3 |
| INMP441 mic | SD / SCK / WS | 14 / 38 / 39 |
| MAX98357A amp | BCLK / LRC / DIN | 40 / 41 / 42 |
| RGB LED | R / G / B | 47 / 48 / 21 |
| BOOT button | digital | 0 |
| PTT button | digital, active-low | 45 |

Audio format: 16 kHz mono. Mic and speaker run on separate I2S controllers
(full-duplex). The legacy bring-up sketches (`mic_speaker_test`, `led_test`,
`lsr_test`) have stale pinouts; they are kept for reference but not used by
the dashboard.

## Architecture Notes

## Conventions

- ESP32 sketches use the Arduino ESP32 `ESP_I2S.h` API (v3.x), not the legacy `driver/i2s.h`.
