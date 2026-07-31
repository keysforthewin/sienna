// Server-side speaker pipeline for the Sienna agent.
//
// Replicates the browser's audio-stream.js pacing on the server so the agent can
// make sound without a browser driving it: send play_audio_start, then 2048-sample
// (≈128 ms) PCM frames tagged 0x03, then play_audio_end.
//
// Frame SIZE, not send rate, is the lever. The device's cooperative loop() blocks
// ~64 ms/iteration on the mic read, so it services the WebSocket only ~15×/s and
// pulls roughly one frame per service. At 1024 samples that's ~15k samples/s — just
// UNDER the 16 kHz playback rate, so the device-side ring underran constantly (clicks).
// 2048-sample frames double the samples delivered per pull (~30k samples/s) so the
// ring stays full, while the frame COUNT stays low (~12/s, under the ~15/s ceiling —
// flooding the device with many small frames is the failure mode the frame-rate cap
// guards against). pacingMs sends VOICE ~1.6× realtime so the ring fills fast (her reply
// is short — it banks on-device and a network blip still completes from the buffer); MUSIC
// uses musicPacingMs (exact realtime) instead, because over-delivering a long track pins the
// device ring full and overflows it (dropped frames / choppy) — the device's backpressure
// gates on its SOCKET, not its playback ring, so the server must pace music to the DAC rate.
// The device's deep playback ring (~2.56 s) absorbs Wi-Fi jitter in both directions, so
// realtime music pacing rides out a slow delivery burst without underrunning.
//   - speak(text)      ElevenLabs pcm_16000 → stream (emotion tags come inline
//                      from Sienna's own text; not re-enhanced)
//   - playUrl(url)     ffmpeg-decoded file/URL → 16 kHz mono → stream
//   - playYoutube(url) yt-dlp | ffmpeg → 16 kHz mono → stream
//   - stop()           abort + kill procs (BOTH channels)
//   - pause()/resume() freeze/continue the MUSIC playback on a frame boundary
//                      (the jukebox pause tool)
//   - mute()/unmute()  PTT transmit gate: voice frames drop server-side, music
//                      ducks to pttDuckPercent (0 ⇒ drops too); nothing stops
// Two channels (voice/music) share the device; voice outranks music (music
// ducks to a quiet bed mixed under her voice — duckPercent — or drops silently
// at 0), muted outranks both (voice silent, music at pttDuckPercent). All playback
// is paced and length-capped; stop() can preempt at any time.

import { buildServerCommand, BinTag } from "./protocol.js";
import { createSentenceChunker } from "./sentence-chunker.js";
import { spawn as childSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const SAMPLE_RATE = 16000;

export function createAudioOut({
  bridge,
  tts,
  volumes = null,       // per-channel speaker gains {voice, music} (volume.js
                        // instances); null ⇒ unity passthrough. voice covers her
                        // speech/TTS paths, music the jukebox/file/YouTube paths.
  duckPercent = 20,     // music bed level under her voice (percent of full); 0 ⇒ duck off
                        // (music drops silently under voice, the pre-duck behavior)
  pttDuckPercent = 0,   // music level while the PTT button is held (percent of full).
                        // 0 (default) = full mute: music drops silently and rejoins
                        // live at finalize. >0 keeps streaming a ducked bed — but the
                        // firmware's raw-GPIO instant mute discards ALL frames while
                        // the button is physically down ("audio must stop on press"),
                        // so a bed is only audible in the release→finalize gap. >0
                        // also needs the firmware that lifts the half-duplex mic gate
                        // while PTT is held, or the device drops every mic frame.
  ffmpegPath = "ffmpeg",
  ytDlpPath = "yt-dlp",
  playerClients = "",   // yt-dlp youtube:player_client extractor-arg (comma list); "" ⇒ omit
  musicFilter = "",     // ffmpeg -af chain on the MUSIC decode (playUrl/playYoutube*) —
                        // loudness cap so wildly-hot tracks don't blast (her TTS voice
                        // never passes through ffmpeg, so it's untouched); "" ⇒ omit
  spawn = childSpawn,
  refGen = randomUUID,
  chunkSamples = 2048,   // samples/frame — big enough that ~15 frames/s ≥ realtime (see header)
  pacingMs = 80,         // generic poll interval for the backpressure / lead-in waits (NOT
                         // the voice delivery rate — that's ttsPacingMs below). Kept distinct
                         // so retuning voice delivery doesn't change those poll cadences.
  ttsPacingMs = 80,      // VOICE sent-frame pacing (streamBytes / speakStream). ~12.5 frames/s
                         // × 2048 ≈ 1.6× realtime; under the device's ~15/s ceiling. Fast
                         // delivery banks her short reply on-device so a mid-reply network blip
                         // still completes from the buffer. Live-tunable via the dashboard
                         // slider (see TTS_PACE_MIN/MAX). DELIVERY rate, not speech speed.
  musicPacingMs = 128,   // MUSIC sent-frame pacing (streamStdoutBuffered). 128 ms = EXACT
                         // realtime (frame audio = 128 ms): the 1.6× voice rate would overrun
                         // the device's fixed-rate DAC on a long track, pinning its playback
                         // ring full so every burst overflows → DROPPED frames (choppy). The
                         // device gates backpressure on its SOCKET, not the ring, so it can't
                         // stop this; we must not over-deliver. At realtime net ring fill ≈ 0,
                         // and the device's deep ring (~2.56 s) absorbs jitter both ways, so it
                         // neither overflows nor underruns. Lower toward 120 only if you still
                         // hear gaps (accepting slow overflow on long tracks).
  maxSeconds = 600,
  firstChars = 60,      // sentence-chunker: small first chunk → fast first audio
  targetChars = 200,    // …then coalesce toward this (protects eleven_v3 prosody)
  prebufferMs = 2000,         // buffered spawn paths: cushion of audio before the
                              // first frame so a stall can't underrun the device
  prebufferTimeoutMs = 5000,  // …but start anyway after this if the source is slow
  maxBufferMs = 8000,         // queue high-water mark → backpressure to ffmpeg/yt-dlp
  leadInTimeoutMs = 4000,     // lead-in: max wait for an in-flight announcement to finish
  tailMs = 0,                 // post-speech echo-tail MARGIN: isPlayingOrTail() stays true this
                              // long PAST the device finishing the audio we sent (the drain
                              // already extends the hold-off by the buffered-but-unplayed audio;
                              // tailMs is the extra room-reverb/Scribe-latency cushion). 0 ⇒ margin
                              // off (still waits out the device buffer).
  audioStatsMs = 0,           // music streaming-health diagnostics. The per-track
                              // summary (deviceBuf peak, backpressure pauses, queue
                              // underruns, max inter-frame gap) is always logged; >0
                              // ALSO emits a live "audio-stats" sampler line every
                              // ~this-many ms during playback (for watching a stutter
                              // happen). 0 ⇒ summary only.
  onMusicPacingChange = null, // fired when setMusicPacingMs changes the live value, so
                              // index.js can broadcast it to dashboards + persist it
                              // (mirrors volume.js's onChange). Boot restore sets the
                              // value BEFORE any listener cares, so a null is fine then.
  onTtsPacingChange = null,   // same, for setTtsPacingMs (voice delivery pacing).
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  clock = () => Date.now(),
  log = () => {},
}) {
  const frameBytes = chunkSamples * 2;
  // Byte budgets for the buffered drain (16-bit mono ⇒ 2 bytes/sample). The max
  // buffer is clamped to at least 2× the prebuffer so a misconfig can't park the
  // producer on backpressure before the prebuffer is ever reached.
  const prebufferBytesDefault = Math.ceil((prebufferMs / 1000) * SAMPLE_RATE * 2);
  const prebufferTimeoutMsDefault = prebufferTimeoutMs;
  const maxBufferBytesDefault = Math.max(
    Math.ceil((maxBufferMs / 1000) * SAMPLE_RATE * 2),
    prebufferBytesDefault * 2,
  );
  // ---- per-channel playback state ----
  // Two logical channels share the one device speaker: `voice` (her replies /
  // speak / streamPcm / browser TTS) and `music` (jukebox / play_audio_file /
  // play_youtube). A playback only preempts ITS OWN channel; the transmit gate
  // below decides who actually reaches the device.
  function makeChannel(name) {
    return {
      name,
      playing: false,
      abort: false,
      generation: 0,             // bumped by withPlayback; lets a track detect it was superseded
      procs: [],
      userStopped: false,        // set ONLY by the public stop()/hardStop()
      currentStreamSession: null,
      currentDrainSignals: null,
      paused: false,             // music only (jukebox pause tool)
      recentlyPlayedUntil: 0,    // clock() deadline of the post-speech echo-tail hold-off
      playStartedAt: null,       // clock() of the first TRANSMITTED frame
      sentSamples: 0,            // TRANSMITTED samples only (dropped frames excluded)
      flushed: false,
      resumeGate: null,
      releaseResume: null,
      armed: false,              // the device's playback stream is currently ours
    };
  }
  const voice = makeChannel("voice");
  const music = makeChannel("music");

  // ---- transmit gate ----
  // muted (PTT held) outranks voice; voice outranks music. Unmuted, a frame is
  // transmitted iff focused() === ch. Muted, VOICE frames always drop (her reply
  // must be silent under the user's speech) but MUSIC keeps transmitting scaled
  // to pttDuckGain (the PTT duck — 0 restores the old full mute). Dropped frames
  // are throttled at realtime (frameMs) so silent playback advances at the rate
  // it would have played — unmute / focus return rejoins live.
  let muted = false;
  const frameMs = Math.max(1, Math.round((chunkSamples / SAMPLE_RATE) * 1000));

  // ---- live music pacing ----
  // The music drain reads `musicPace` every frame, so setMusicPacingMs takes effect on
  // the very next frame — even mid-track. Bounds bracket the useful range for the default
  // 2048-sample (128 ms realtime) frame: below MIN the server over-delivers and overflows
  // the device ring (dropped frames / choppy); above MAX it under-delivers and the ring
  // underruns (gaps). The dashboard slider spans exactly this range.
  const MUSIC_PACE_MIN = 80;                  // ~1.6× realtime — the old over-deliver floor
  const MUSIC_PACE_MAX = 136;                 // a hair past 128 ms realtime; slower starves
  const clampPace = (ms) => {
    ms = Math.round(Number(ms));
    if (!Number.isFinite(ms)) return musicPace;
    return ms < MUSIC_PACE_MIN ? MUSIC_PACE_MIN : ms > MUSIC_PACE_MAX ? MUSIC_PACE_MAX : ms;
  };
  let musicPace = clampPace(musicPacingMs);
  function setMusicPacingMs(ms) {
    const next = clampPace(ms);
    if (next !== musicPace) { musicPace = next; if (onMusicPacingChange) onMusicPacingChange(next); }
    return musicPace;
  }

  // ---- live TTS (voice) pacing ----
  // Mirror of music pacing for HER VOICE. The voice drains (streamBytes / speakStream)
  // read `ttsPace` every frame, so setTtsPacingMs takes effect on the next frame. NOTE:
  // this is the DELIVERY rate into the device ring, NOT speech speed — the device plays
  // every sample at 16 kHz regardless, so the slider never changes how fast she talks or
  // her pitch. The useful range for the 2048-sample (128 ms realtime) voice frame: 128 ms
  // is exact realtime (no bank-ahead — leans on the deep device ring); faster banks her
  // short reply on-device so a mid-reply network blip still completes from the buffer.
  // Below MIN over-delivers hard (the ring fills and the device drops frames on long
  // replies); above realtime under-delivers and the ring eventually drains (gaps).
  const TTS_PACE_MIN = 64;                    // ~2× realtime — aggressive bank-ahead
  const TTS_PACE_MAX = 128;                   // exact realtime — slower than this starves voice
  const clampTtsPace = (ms) => {
    ms = Math.round(Number(ms));
    if (!Number.isFinite(ms)) return ttsPace;
    return ms < TTS_PACE_MIN ? TTS_PACE_MIN : ms > TTS_PACE_MAX ? TTS_PACE_MAX : ms;
  };
  let ttsPace = clampTtsPace(ttsPacingMs);
  function setTtsPacingMs(ms) {
    const next = clampTtsPace(ms);
    if (next !== ttsPace) { ttsPace = next; if (onTtsPacingChange) onTtsPacingChange(next); }
    return ttsPace;
  }

  const focused = () => (voice.playing ? voice : music);
  const pttDuckGain = Math.min(100, Math.max(0, pttDuckPercent)) / 100;
  const canTransmit = (ch) =>
    muted ? (ch === music && pttDuckGain > 0) : focused() === ch;

  // Scale a PCM frame into a copy (gain ≤ 1 here, but clamp anyway — cheap).
  function scalePcm(bytes, gain) {
    const out = Buffer.from(bytes);
    for (let i = 0; i + 1 < out.length; i += 2) {
      let v = Math.round(out.readInt16LE(i) * gain);
      if (v > 32767) v = 32767;
      else if (v < -32768) v = -32768;
      out.writeInt16LE(v, i);
    }
    return out;
  }

  // ---- ducking ----
  // Music frames dropped because VOICE has focus (not muted) are banked here and
  // mixed — scaled to duckGain — into her transmitted voice frames, so the music
  // audibly continues as a quiet bed under her voice instead of going silent. The
  // queue is small and lossy (oldest dropped) because the music side produces at
  // realtime while the voice side may briefly outpace it; a shortfall mixes as
  // silence. Cleared on voice playback start/end and on mute() (whose device
  // flush discards the audio these frames would have aligned with).
  const duckGain = Math.min(100, Math.max(0, duckPercent)) / 100;
  let duckQueue = [];        // Buffer[] of music PCM awaiting the bed mix
  let duckQueueBytes = 0;
  const duckMaxBytes = frameBytes * 8;   // ≥ the backpressure burst window (HIGH−LOW ≈ 6
                                         // frames), so the bed survives a full drain cycle
  const clearDuck = () => { duckQueue = []; duckQueueBytes = 0; };

  function bankDuckFrame(bytes) {
    duckQueue.push(Buffer.from(bytes));   // copy: the caller's buffer moves on
    duckQueueBytes += bytes.length;
    while (duckQueueBytes > duckMaxBytes && duckQueue.length) {
      duckQueueBytes -= duckQueue.shift().length;
    }
  }

  // Blend the queued bed into a COPY of the voice frame, sample-wise. We use a
  // CONVEX combination — voice·(1−duckGain) + bed·duckGain — NOT an additive sum.
  // The old `voice + bed·gain` pushed samples that were already near the int16 rail
  // over it; the subsequent ×SIENNA_VOLUME (200% default) then hard-clipped the
  // overflow, garbling her voice ONLY when a music bed was present. A convex blend
  // can never exceed max(|voice|,|bed|), so the bed introduces no clipping her own
  // voice didn't already have — it's a sidechain duck (her level dips ~duckGain
  // where the bed plays). Consumes the queue front; a short queue leaves the tail of
  // the frame pure voice (the bed dips out — no glitch). The clamp stays as defense.
  // The bed is mixed INTO voice frames, so it later receives the VOICE channel
  // gain — with independent channel volumes a quiet music setting would be
  // ignored during ducking. Compensate: scale the bed term toward
  // duckGain·(music/voice), never ABOVE duckGain (staying ≤ duckGain keeps the
  // convex blend's no-new-clipping bound — when music is set louder than voice
  // the bed simply stays at the classic duck level).
  function bedGain() {
    if (!volumes?.voice || !volumes?.music) return duckGain;
    const v = volumes.voice.getPercent();
    const m = volumes.music.getPercent();
    if (v <= 0 || m >= v) return duckGain;
    return duckGain * (m / v);
  }

  function mixDuck(bytes, bed = duckGain) {
    const out = Buffer.from(bytes);
    let off = 0;
    while (off + 1 < out.length && duckQueue.length) {
      const head = duckQueue[0];
      if (head.length < 2) { duckQueueBytes -= head.length; duckQueue.shift(); continue; }
      const n = Math.min(out.length - off, head.length) & ~1;   // whole int16 samples
      for (let i = 0; i < n; i += 2) {
        let v = Math.round(out.readInt16LE(off + i) * (1 - duckGain) + head.readInt16LE(i) * bed);
        if (v > 32767) v = 32767;
        else if (v < -32768) v = -32768;
        out.writeInt16LE(v, off + i);
      }
      off += n;
      duckQueueBytes -= n;
      if (n >= head.length) duckQueue.shift();
      else duckQueue[0] = head.subarray(n);
    }
    return out;
  }

  const sendCmd = (cmd) => bridge.sendToDevice(buildServerCommand(cmd, refGen()));

  function mute() {
    if (muted) return;
    muted = true;
    voice.armed = false;
    music.armed = false;
    // The flush below drops any transmitted-but-unplayed audio on the device, so
    // the echo-tail accounting restarts here: counters go to zero and sendFrame
    // re-stamps playStartedAt on the first post-unmute transmitted frame. (NOT
    // ch.flushed — that would also zero a REAL post-unmute tail at playback end.)
    for (const ch of [voice, music]) { ch.sentSamples = 0; ch.playStartedAt = null; }
    clearDuck();
    // stop_audio also cuts any in-flight on-device play_tone beep — harmless today
    // because PTT mutes BEFORE its listen beep; future callers should likewise
    // mute first, beep after.
    // With pttDuckPercent > 0 the flush still runs: it discards the FULL-volume
    // backlog (device ring + in-flight socket frames) so the duck-down is
    // instant; the music re-arms lazily on its next (now ducked) frame.
    sendCmd({ type: "stop_audio" });   // instant silence: device flushes ring + DMA
    log("transmit gate: MUTED (flushed device)");
  }
  function unmute() {
    if (!muted) return;
    muted = false;                     // focused channel re-arms lazily on its next frame
    log("transmit gate: unmuted");
  }

  // Lazy device arming. The winner of a focus handoff flushes the loser's
  // buffered tail (stop_audio) before its own play_audio_start.
  function arm(ch) {
    if (ch.armed) return true;
    const other = ch === voice ? music : voice;
    if (other.armed) { other.armed = false; sendCmd({ type: "stop_audio" }); }
    ch.armed = sendCmd({ type: "play_audio_start", sample_rate: SAMPLE_RATE, bits: 16, channels: 1 });
    return ch.armed;
  }
  function disarm(ch) {
    if (!ch.armed) return;
    ch.armed = false;
    sendCmd({ type: "play_audio_end" });
  }

  // Gated, per-channel frame transmit. Returns whether the frame was transmitted
  // (a dropped frame's caller throttles at frameMs instead of pacingMs).
  const sendFrame = (ch, bytes) => {
    if (!canTransmit(ch)) {
      // Voice owns the device and we're the music: bank this frame for the duck
      // bed. Muted (PTT) frames are discarded — mute outranks everything.
      if (ch === music && !muted && duckGain > 0) bankDuckFrame(bytes);
      return false;   // dropped: caller throttles at frameMs
    }
    if (!arm(ch)) {
      // Device offline discovered mid-stream (e.g. at a re-arm after mute/unmute):
      // tear this playback down — matches the upfront-probe semantics — instead of
      // retrying play_audio_start every frame against a dead bridge.
      ch.abort = true;
      return false;
    }
    if (ch.playStartedAt === null) ch.playStartedAt = clock();
    ch.sentSamples += bytes.length >> 1;  // 16-bit mono ⇒ 2 bytes/sample
    let mixed = ch === voice && duckGain > 0 && duckQueueBytes > 0 ? mixDuck(bytes, bedGain()) : bytes;
    if (muted && ch === music) mixed = scalePcm(mixed, pttDuckGain);   // the PTT duck
    const vol = volumes ? (ch === music ? volumes.music : volumes.voice) : null;
    const scaled = vol ? vol.applyGain(mixed) : mixed;
    const buf = Buffer.allocUnsafe(1 + scaled.length);
    buf[0] = BinTag.PLAYBACK_PCM;
    scaled.copy(buf, 1);
    bridge.sendBinaryToDevice(buf);
    return true;
  };

  // Every paced loop calls this once per frame — AFTER its abort/generation check
  // and BEFORE sendFrame — so a pause freezes on a frame boundary (never a torn
  // frame). While paused it parks the loop on resumeGate; abortPlayback()/stop() and
  // a new withPlayback all clear `paused`/release the gate, so a parked loop wakes,
  // re-checks abort/generation, and exits instead of resuming.
  async function awaitResume(ch) {
    while (ch.paused && !ch.abort) {
      if (!ch.resumeGate) ch.resumeGate = new Promise((r) => { ch.releaseResume = r; });
      await ch.resumeGate;
    }
  }

  // Drop a pause freeze: clear the flag and wake any loop parked on the gate.
  function clearPause(ch) {
    ch.paused = false;
    if (ch.releaseResume) { ch.releaseResume(); ch.releaseResume = null; }
    ch.resumeGate = null;
  }

  // Device-driven backpressure. The device drains playback at its true hardware
  // rate (ring buffer + I2S clock); when it falls behind, unsent frames pile up in
  // the device socket's send buffer (bufferedAmount). Without gating, the paced
  // loops keep dumping frames into Node regardless, so they reach the device bursty
  // → choppy. Here we pause sending once the socket is backed up and resume once it
  // drains, so the server tracks the device's real consumption rate. (Guarded so a
  // mock bridge without the accessor — e.g. tests — is a no-op.)
  const deviceBuffered = () =>
    typeof bridge.deviceBufferedAmount === "function" ? bridge.deviceBufferedAmount() : 0;
  const BACKPRESSURE_HIGH = frameBytes * 8;  // ~8 frames (~512 ms) queued ⇒ pause
  const BACKPRESSURE_LOW = frameBytes * 2;   // …resume once it drains to ~2 frames
  // `stats` (optional, music drain only) accumulates the diagnostic counters: the
  // peak socket backlog seen, and how often / how long we paused for the device to
  // drain — the direct "the device's Wi-Fi link can't keep up" signal. Voice passes
  // none (its summary isn't logged).
  async function awaitDeviceDrain(ch, stats = null) {
    if (!canTransmit(ch)) return;   // dropped frames see no backpressure
    const cur = deviceBuffered();
    if (stats && cur > stats.deviceBufPeak) stats.deviceBufPeak = cur;
    if (cur < BACKPRESSURE_HIGH) return;
    if (stats) stats.pauses += 1;
    const pauseStart = clock();
    while (!ch.abort && deviceBuffered() > BACKPRESSURE_LOW) {
      await sleep(pacingMs);
      const b = deviceBuffered();
      if (stats && b > stats.deviceBufPeak) stats.deviceBufPeak = b;
    }
    if (stats) stats.pausedMs += clock() - pauseStart;
  }

  // Stream a complete Buffer of raw int16-LE PCM, paced. Returns frames consumed
  // (dropped-while-muted frames count — the playback "ran", just silently).
  async function streamBytes(ch, pcm) {
    const myGen = ch.generation;
    if (canTransmit(ch) && !arm(ch)) return 0;   // device offline (silent drains proceed)
    let frames = 0;
    try {
      for (let off = 0; off < pcm.length; off += frameBytes) {
        if (ch.abort || ch.generation !== myGen) break;
        await awaitResume(ch); if (ch.abort || ch.generation !== myGen) break;
        await awaitDeviceDrain(ch); if (ch.abort || ch.generation !== myGen) break;
        const sent = sendFrame(ch, pcm.subarray(off, off + frameBytes));
        frames += 1;
        if (off + frameBytes < pcm.length) await sleep(sent ? ttsPace : frameMs);   // voice: live-tunable
      }
    } finally {
      if (ch.generation === myGen) disarm(ch);
    }
    return frames;
  }

  // DECOUPLES reading the source from pacing to the device: a one-loop reader would
  // let a stall in the source (yt-dlp over
  // a jittery network) directly stall the paced send → the device's tiny buffer
  // underruns → choppy audio. Here a producer task drains `stdout` into an in-memory
  // PCM queue (bounded by maxBufferBytes — backpressure flows down to ffmpeg → yt-dlp
  // via the pipe) while a separate drain paces frames out. A pre-buffer
  // (prebufferBytes) builds a lead before the FIRST frame so transient source stalls
  // are absorbed by the queue instead of the device. Returns the integer frame
  // count consumed by the paced drain (frames dropped while gated still count —
  // the playback "ran", just silently). Local sources (a WAV file) fill the
  // prebuffer almost instantly, so they're unaffected beyond a tiny startup delay.
  async function streamStdoutBuffered(ch, stdout, {
    prebufferBytes = prebufferBytesDefault,
    maxBufferBytes = maxBufferBytesDefault,
    prebufferTimeoutMs = prebufferTimeoutMsDefault,
    label = "buffered",   // for timing logs: which path is draining
  } = {}) {
    const myGen = ch.generation;
    const t0 = clock();          // ~spawn time (caller spawns just before calling us)
    let firstByteAt = null;      // first PCM byte out of ffmpeg (≈ yt-dlp extract + decode start)
    let firstFrameLogged = false;
    const queue = [];           // Buffer[] of raw int16-LE PCM, in arrival order
    let queuedBytes = 0;
    let sourceDone = false;
    let frames = 0;
    let leftover = Buffer.alloc(0);
    const maxFrames = Math.ceil((maxSeconds * SAMPLE_RATE) / chunkSamples);
    const lowWater = Math.floor(maxBufferBytes / 2);

    // ---- streaming-health stats (per-track summary; opt-in live sampler) ----
    // deviceBufPeak/pauses/pausedMs come from awaitDeviceDrain (device link
    // saturation); queueMin/underruns track the in-memory PCM queue (source
    // starvation); maxGapMs is the longest silence between transmitted frames
    // (the audible-stutter magnitude, whichever buffer caused it).
    const stats = { deviceBufPeak: 0, pauses: 0, pausedMs: 0, queueMin: Infinity, underruns: 0, maxGapMs: 0 };
    let lastFrameAt = null;     // clock() of the previous TRANSMITTED frame
    let lastStatAt = t0;        // clock() of the previous live-sampler line

    let drainWaiter = null;     // drain parked on more-audio / sourceDone / abort
    const wake = () => { if (drainWaiter) { const w = drainWaiter; drainWaiter = null; w(); } };
    let roomWaiter = null;      // producer parked on backpressure (queue full)
    const signalRoom = () => { if (roomWaiter) { const r = roomWaiter; roomWaiter = null; r(); } };
    let prerollWaiter = null;   // pre-roll parked until prebuffer / sourceDone / timeout / abort
    const wakePreroll = () => { if (prerollWaiter) { const p = prerollWaiter; prerollWaiter = null; p(); } };

    // So abortPlayback() (preempt / stop) can release a parked producer/drain/pre-roll
    // immediately, mirroring how it tears down currentStreamSession.
    const signals = { wake, signalRoom, wakePreroll };
    ch.currentDrainSignals = signals;
    const clearSignals = () => { if (ch.currentDrainSignals === signals) ch.currentDrainSignals = null; };

    // Producer: pull from the source as fast as it arrives, pausing (backpressure)
    // once the queue is full. A destroyed/killed stdout throws out of `for await` —
    // treat that as EOF.
    const producer = (async () => {
      try {
        for await (const chunk of stdout) {
          if (ch.abort || ch.generation !== myGen) break;
          const buf = Buffer.from(chunk);
          if (firstByteAt === null) { firstByteAt = clock(); log(`${label}: first source byte +${firstByteAt - t0}ms`); }
          queue.push(buf); queuedBytes += buf.length;
          wake();
          if (queuedBytes >= prebufferBytes) wakePreroll();
          if (queuedBytes >= maxBufferBytes) {
            await new Promise((r) => { roomWaiter = r; });
            if (ch.abort || ch.generation !== myGen) break;
          }
        }
      } catch { /* stdout ended/destroyed mid-read → EOF */ }
      sourceDone = true; wake(); wakePreroll();
    })();

    // Pre-roll: hold the device start until we have a cushion (or the source is
    // already done, or we've waited long enough, or we were aborted). Resolved by
    // the producer (prebuffer reached / sourceDone), the timeout, or abortPlayback.
    if (queuedBytes < prebufferBytes && !sourceDone && !ch.abort && ch.generation === myGen) {
      let to = null;
      await new Promise((resolve) => {
        prerollWaiter = resolve;
        to = setTimeout(() => { prerollWaiter = null; resolve(); }, prebufferTimeoutMs);
      });
      if (to) clearTimeout(to);
    }

    // Aborted / superseded before we ever started the device: send nothing.
    if (ch.abort || ch.generation !== myGen) {
      signalRoom(); await producer; clearSignals();
      return 0;
    }
    log(`${label}: prebuffer ${queuedBytes >= prebufferBytes ? "reached" : (sourceDone ? "source-done" : "timed-out")} +${clock() - t0}ms (${queuedBytes} bytes buffered)`);
    if (canTransmit(ch) && !arm(ch)) {
      ch.abort = true; signalRoom(); wake(); await producer; clearSignals();
      return 0; // device offline (a gated/silent drain proceeds without arming)
    }
    try {
      while (!ch.abort && ch.generation === myGen) {
        if (queue.length === 0) {
          if (sourceDone) break;                         // the only clean exit
          stats.underruns += 1;                          // drain caught the producer ⇒ source starvation
          await new Promise((r) => { drainWaiter = r; }); // underrun: park, never send torn frames
          continue;
        }
        const chunk = queue.shift();
        queuedBytes -= chunk.length;
        if (queuedBytes < stats.queueMin) stats.queueMin = queuedBytes;
        if (queuedBytes < lowWater) signalRoom();        // let the producer pull more
        let data = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
        let off = 0;
        while (data.length - off >= frameBytes) {
          if (ch.abort || ch.generation !== myGen) break;
          await awaitResume(ch); if (ch.abort || ch.generation !== myGen) break;
          await awaitDeviceDrain(ch, stats); if (ch.abort || ch.generation !== myGen) break;
          const sent = sendFrame(ch, data.subarray(off, off + frameBytes));
          if (!firstFrameLogged && sent) { firstFrameLogged = true; log(`${label}: FIRST FRAME to device +${clock() - t0}ms (source byte→frame ${firstByteAt === null ? "?" : clock() - firstByteAt}ms)`); }
          if (sent) {
            const now = clock();
            if (lastFrameAt !== null && now - lastFrameAt > stats.maxGapMs) stats.maxGapMs = now - lastFrameAt;
            lastFrameAt = now;
          }
          if (audioStatsMs > 0 && clock() - lastStatAt >= audioStatsMs) {
            lastStatAt = clock();
            log(`audio-stats ${ch.name} t=${clock() - t0}ms: deviceBuf=${deviceBuffered()}/${stats.deviceBufPeak} queue=${queuedBytes} pauses=${stats.pauses} underruns=${stats.underruns} maxGap=${stats.maxGapMs}ms`);
          }
          off += frameBytes; frames += 1;
          if (frames >= maxFrames) { ch.abort = true; break; }
          await sleep(sent ? musicPace : frameMs);   // live-tunable (dashboard slider)
        }
        leftover = Buffer.from(data.subarray(off));
      }
      if (!ch.abort && ch.generation === myGen && leftover.length) { sendFrame(ch, leftover); frames += 1; }
    } finally {
      disarm(ch);
      signalRoom(); wake(); await producer; clearSignals();
    }
    log(`${label}: drain done frames=${frames} in ${clock() - t0}ms`
      + ` | deviceBuf peak=${stats.deviceBufPeak} (HIGH=${BACKPRESSURE_HIGH}) pauses=${stats.pauses} pausedMs=${stats.pausedMs}`
      + ` | queue min=${stats.queueMin === Infinity ? 0 : stats.queueMin}/${maxBufferBytes} underruns=${stats.underruns}`
      + ` | maxGap=${stats.maxGapMs}ms`);
    return frames;
  }

  async function withPlayback(ch, fn) {
    if (ch.playing) abortPlayback(ch);  // preempt OUR OWN channel only (NOT a user stop)
    ch.generation += 1;
    const myGen = ch.generation;
    ch.playing = true;
    ch.abort = false;
    ch.userStopped = false;
    ch.flushed = false;
    ch.playStartedAt = null;
    ch.sentSamples = 0;
    clearPause(ch);
    if (ch === voice) clearDuck();
    ch.procs = [];
    try { return await fn(); }
    finally {
      // Only the CURRENT playback closes out — a superseded one (preempted; generation
      // bumped) must not clobber `playing`/the hold-off the new playback owns.
      if (ch.generation === myGen) {
        ch.playing = false;
        if (ch === voice) clearDuck();
        // Echo-tail hold-off (voice only matters, harmless for music): sentSamples
        // counts TRANSMITTED audio only — dropped frames never inflate it, and
        // mute() resets the counters because its device flush discards whatever
        // had been transmitted but not yet played.
        const sentMs = (ch.sentSamples / SAMPLE_RATE) * 1000;
        const playedMs = ch.playStartedAt !== null ? clock() - ch.playStartedAt : 0;
        const bufferedMs = ch.flushed ? 0 : Math.max(0, sentMs - playedMs);
        ch.recentlyPlayedUntil = clock() + bufferedMs + tailMs;
      }
    }
  }

  // Public primitive: stream an Int16Array (used by the browser-parity path/tests).
  async function streamPcm(int16) {
    const bytes = Buffer.from(int16.buffer, int16.byteOffset, int16.length * 2);
    return withPlayback(voice, () => streamBytes(voice, bytes));
  }

  // Speak a fixed piece of text. Unified onto the SAME gapless streaming path the
  // agent's spoken reply uses (speakStream) — there is one text→speech path. The text
  // is sentence-chunked and synthesized over ElevenLabs /stream (eleven_v3): first
  // words out in a few hundred ms, audio delivered per sentence (which also keeps the
  // device fed steadily instead of one whole-clip burst). Falls back to a single
  // buffered render only when no streaming TTS is configured.
  async function speak(text) {
    const c = await speakStream();   // not deferred → speaks as soon as the first chunk renders
    if (c) {
      c.push(text);
      c.begin();
      return (await c.end()).frames;
    }
    const pcm = await tts.synthesizePcm16(text);
    return withPlayback(voice, () => streamBytes(voice, pcm));
  }

  // Gapless streamed speech, sentence-chunked over HTTP /stream (eleven_v3). Push
  // text as the LLM generates it; a chunker splits it into sentence-ish chunks and
  // a worker synthesizes each via tts.stream IN ORDER, pre-buffering ahead of the
  // paced drain. With deferDeviceStart, device playback (play_audio_start +
  // draining) waits for begin() — so the agent can synthesize a FINAL answer DURING
  // token generation but only start the speaker once the turn is confirmed spoken
  // (not a tool round, whose preamble must never reach the device; abort() cancels
  // the in-flight v3 render). The controller resolves as soon as the worker/drain
  // exist; `done` resolves when the device finishes (so isPlaying() stays true
  // through the whole drain — the echo gate depends on it).
  //   controller: { push(text), begin(), end()→{frames}, abort(), done→{frames} }
  // Returns null when no streaming TTS is configured.
  async function speakStream({ deferDeviceStart = false } = {}) {
    if (!tts || typeof tts.stream !== "function") return null;
    let resolveReady;
    const ready = new Promise((r) => { resolveReady = r; });

    const playbackDone = withPlayback(voice, async () => {
      const myGen = voice.generation;
      let frames = 0;
      let leftover = Buffer.alloc(0);
      const pcmQueue = [];
      let waiter = null;      // drain parked on more-audio / synthDone / abort
      let jobWaiter = null;   // worker parked on more-jobs / ended / abort
      const wake = () => { if (waiter) { const w = waiter; waiter = null; w(); } };
      const wakeJobs = () => { if (jobWaiter) { const w = jobWaiter; jobWaiter = null; w(); } };

      const chunker = createSentenceChunker({ firstChars, targetChars });
      const ac = new AbortController();   // cancels the in-flight fetch on abort/preempt
      const jobs = [];                    // ordered chunk texts awaiting synthesis
      let ended = false;                  // end() called → no more push()
      let synthDone = false;              // worker finished all jobs (or bailed)

      // abortPlayback() (preempt / stop) reaches us through this shim — mirrors the
      // old WS session so currentStreamSession teardown is unchanged.
      const session = { abort: () => { ac.abort(); voice.abort = true; wake(); wakeJobs(); } };
      voice.currentStreamSession = session;
      log("speakStream start");

      // Synthesis worker: one chunk at a time, in order, running AHEAD of the paced
      // drain. It enqueues a chunk's ENTIRE body before advancing, so synthDone ⇒
      // every byte is already in pcmQueue (the closed-race invariant the drain relies on).
      const worker = (async () => {
        let i = 0;
        while (!voice.abort && voice.generation === myGen) {
          if (i >= jobs.length) {
            if (ended) break;
            await new Promise((r) => { jobWaiter = r; });
            continue;
          }
          const text = jobs[i];
          let body;
          try {
            // v3 only: NO previous_text/next_text — eleven_v3 400s on them, which would
            // kill every chunk after the first. Each sentence is synthesized standalone.
            body = await tts.stream(text, { signal: ac.signal });
          } catch (e) {
            if (ac.signal.aborted) break;                 // playback torn down → stop entirely
            log(`speakStream synth error (skipping chunk): ${e?.message}`);
            i += 1; continue;                             // one bad chunk must NOT drop the rest of her reply
          }
          try {
            for await (const buf of body) {
              if (voice.abort || voice.generation !== myGen) break;
              pcmQueue.push(Buffer.from(buf)); wake();
            }
          } catch (e) {
            if (ac.signal.aborted) break;                 // aborted mid-body
            log(`speakStream stream error (skipping chunk): ${e?.message}`);
            i += 1; continue;                             // keep going with the next sentence
          }
          i += 1;
        }
        synthDone = true; wake();
      })();

      let started = !deferDeviceStart;
      let beginResolve = null;
      const beganP = started ? Promise.resolve() : new Promise((r) => { beginResolve = r; });
      const releaseBegin = () => { if (beginResolve) { beginResolve(); beginResolve = null; } };
      const maxFrames = Math.ceil((maxSeconds * SAMPLE_RATE) / chunkSamples);

      const drain = (async () => {
        await beganP;
        if (voice.abort || voice.generation !== myGen) return;
        if (canTransmit(voice) && !arm(voice)) {
          log("speakStream device offline — 0 frames");
          ac.abort(); voice.abort = true; wakeJobs();
          return;
        }
        try {
          while (!voice.abort && voice.generation === myGen) {
            if (pcmQueue.length === 0) {
              if (synthDone) break;                          // the only clean exit
              await new Promise((r) => { waiter = r; });      // park until more audio / synthDone / abort
              continue;
            }
            const chunk = pcmQueue.shift();
            let data = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
            let off = 0;
            while (data.length - off >= frameBytes) {
              if (voice.abort || voice.generation !== myGen) break;
              await awaitResume(voice); if (voice.abort || voice.generation !== myGen) break;
              await awaitDeviceDrain(voice); if (voice.abort || voice.generation !== myGen) break;
              const sent = sendFrame(voice, data.subarray(off, off + frameBytes));
              off += frameBytes; frames += 1;
              if (frames >= maxFrames) { voice.abort = true; break; }
              await sleep(sent ? ttsPace : frameMs);   // voice: live-tunable (dashboard slider)
            }
            leftover = Buffer.from(data.subarray(off));
          }
          if (!voice.abort && voice.generation === myGen && leftover.length) { sendFrame(voice, leftover); frames += 1; }
        } finally {
          disarm(voice);
        }
      })();

      resolveReady({
        push: (text) => { for (const c of chunker.push(text)) jobs.push(c); wakeJobs(); },
        begin: () => { started = true; releaseBegin(); },
        end: async () => {
          for (const c of chunker.end()) jobs.push(c);
          ended = true; wakeJobs();
          await worker; await drain; return { frames };
        },
        abort: () => { ac.abort(); voice.abort = true; releaseBegin(); wake(); wakeJobs(); },
      });

      await drain;
      // The worker may still be parked (preempt/abort before end()); unwind it.
      ended = true; ac.abort(); wakeJobs();
      await worker;
      if (voice.currentStreamSession === session) voice.currentStreamSession = null;
      log(`speakStream done frames=${frames}`);
      return { frames };
    });

    return ready.then((c) => ({ ...c, done: playbackDone }));
  }

  function ffmpegArgs(input) {
    const af = musicFilter ? ["-af", musicFilter] : [];
    return [...input, ...af, "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le", "-loglevel", "error", "pipe:1"];
  }

  // yt-dlp args to stream bestaudio to stdout. `target` is a URL or a search
  // (a "ytsearch:" expression or the jukebox's music.youtube.com/search URL) —
  // yt-dlp accepts both, so a single process can search AND stream (the fused
  // cold start). A search resolves like a playlist, so it's pinned to the top
  // result with -I 1 — without it the music-search URL would stream the whole
  // songs shelf back-to-back. Plain watch URLs are left untouched.
  function ytDlpAudioArgs(target) {
    const ea = playerClients ? ["--extractor-args", `youtube:player_client=${playerClients}`] : [];
    const first = /^ytsearch|:\/\/music\.youtube\.com\/search/.test(target) ? ["-I", "1"] : [];
    return ["-f", "bestaudio", ...ea, ...first, "-o", "-", "--quiet", target];
  }

  async function playUrl(url) {
    return withPlayback(music, async () => {
      const ff = spawn(ffmpegPath, ffmpegArgs(["-i", url]));
      music.procs.push(ff);
      const errChunks = [];
      ff.stderr?.on("data", (d) => errChunks.push(d));
      let exitErr = null;
      const exited = new Promise((resolve) => {
        ff.on("error", (e) => { exitErr = e; resolve(); });
        ff.on("close", (code) => { if (code && code !== 0 && !music.abort) exitErr = new Error(`ffmpeg exited ${code}: ${Buffer.concat(errChunks).toString().slice(0, 200)}`); resolve(); });
      });
      await streamStdoutBuffered(music, ff.stdout, { label: "playUrl" });
      await exited;
      if (exitErr && !music.abort) throw exitErr;
    });
  }

  // Spawn the yt-dlp | ffmpeg extraction pipeline (does NOT claim the device). The
  // procs run immediately so a lead-in can let an in-flight announcement keep playing
  // while yt-dlp resolves the stream (the slow part) in the background.
  function spawnYoutube(url, label) {
    log(`${label}: spawning yt-dlp (bestaudio) + ffmpeg for ${url}`);
    const yt = spawn(ytDlpPath, ytDlpAudioArgs(url));
    const ff = spawn(ffmpegPath, ffmpegArgs(["-i", "pipe:0"]));
    yt.stdout?.on("error", () => {});   // swallow EPIPE when one side dies first
    ff.stdin?.on("error", () => {});
    const errRef = { spawnErr: false };
    yt.on("error", () => { errRef.spawnErr = true; });   // pre-claim: never touches `abort`
    ff.on("error", () => { errRef.spawnErr = true; });   // (that's the announcement's flag)
    const ytClosed = new Promise((res) => yt.on("close", (c) => res(c)));
    const ffClosed = new Promise((res) => ff.on("close", (c) => res(c)));
    if (yt.stdout && ff.stdin) yt.stdout.pipe(ff.stdin);
    return { yt, ff, ytClosed, ffClosed, errRef };
  }

  // Lead-in: let whatever is on the speaker now (a "getting that…" announcement)
  // finish on its own — do NOT preempt it — so the music takes over right as the
  // heads-up ends instead of cutting it off. The extraction warms meanwhile. Capped
  // so a long/stuck speech can't hold the music forever; bails early on abort.
  async function waitForSpeakerIdle(timeoutMs) {
    let waited = 0;
    while (voice.playing && !music.userStopped && waited < timeoutMs) { await sleep(pacingMs); waited += pacingMs; }
  }

  async function playYoutube(url, { leadIn = false } = {}) {
    const handle = spawnYoutube(url, `playYoutube${leadIn ? " (lead-in)" : ""}`);
    if (leadIn) {
      // A new playback request supersedes an old stop: clear the stale flag so a
      // stop that landed BEFORE this request can't kill the fresh pipeline. A stop
      // landing DURING the wait below still sets it and is still honored.
      music.userStopped = false;
      const startGen = music.generation;
      await waitForSpeakerIdle(leadInTimeoutMs);
      if (music.userStopped || music.generation !== startGen) {   // stop/preempt landed during the lead-in
        for (const p of [handle.yt, handle.ff]) { try { p.kill("SIGKILL"); } catch { /* gone */ } }
        return;
      }
    }
    return withPlayback(music, async () => {
      music.procs.push(handle.yt, handle.ff);
      handle.yt.on("error", () => { music.abort = true; });
      handle.ff.on("error", () => { music.abort = true; });
      await streamStdoutBuffered(music, handle.ff.stdout, { label: "playYoutube" });
    });
  }

  // Like playYoutube, but AWAITED to completion and reporting WHY it ended, so an
  // autoplay queue (jukebox.js) knows whether to advance, stop, or resume:
  //   "ended"      natural EOF or the maxSeconds cap   → play the next track
  //   "stopped"    the user called stop()              → end the session
  //   "superseded" another playback preempted us (her  → wait for the speaker, then
  //                auto-spoken reply / speak tool)        resume the mix
  //   "error"      yt-dlp/ffmpeg failed for this track → skip to the next
  // Returns { reason, frames } (frames === 0 ⇒ device was offline ⇒ caller should bail).
  async function playYoutubeTrack(url, { leadIn = false } = {}) {
    const handle = spawnYoutube(url, `playYoutubeTrack${leadIn ? " (lead-in)" : ""}`);
    if (leadIn) {
      // A new playback request supersedes an old stop: clear the stale flag so a
      // stop that landed BEFORE this request can't kill the fresh pipeline. A stop
      // landing DURING the wait below still sets it and is still honored.
      music.userStopped = false;
      const startGen = music.generation;
      await waitForSpeakerIdle(leadInTimeoutMs);
      if (music.userStopped || music.generation !== startGen) {   // stop/preempt landed during the lead-in
        for (const p of [handle.yt, handle.ff]) { try { p.kill("SIGKILL"); } catch { /* gone */ } }
        await Promise.all([handle.ytClosed, handle.ffClosed]);
        return { reason: music.userStopped ? "stopped" : "superseded", frames: 0 };
      }
    }
    return withPlayback(music, async () => {
      const myGen = music.generation;
      const { yt, ff, ytClosed, ffClosed, errRef } = handle;
      music.procs.push(yt, ff);
      yt.on("error", () => { music.abort = true; });   // post-claim: now `abort` is ours
      ff.on("error", () => { music.abort = true; });
      const frames = await streamStdoutBuffered(music, ff.stdout, { label: "playYoutubeTrack" });
      // The cap path (and device-offline early return) stop reading but leave the
      // children running — force the still-alive ones down so their close events
      // fire. EOF / preempt / user-stop have already ended them.
      for (const p of [yt, ff]) {
        if (p.exitCode === null && !p.killed) { try { p.kill("SIGKILL"); } catch { /* already gone */ } }
      }
      const [, ffCode] = await Promise.all([ytClosed, ffClosed]);
      let reason;
      if (music.userStopped) reason = "stopped";
      else if (music.generation !== myGen) reason = "superseded";
      else if (errRef.spawnErr || (ffCode && ffCode !== 0)) reason = "error";
      else reason = "ended";
      return { reason, frames };
    });
  }

  // Internal abort: kill the pipeline without flagging a user stop (used by the
  // withPlayback preempt, so the preempted track classifies as "superseded").
  function abortPlayback(ch) {
    ch.abort = true;
    for (const p of ch.procs) { try { p.kill("SIGKILL"); } catch { /* already dead */ } }
    ch.procs = [];
    if (ch.currentStreamSession) { try { ch.currentStreamSession.abort(); } catch { /* already */ } ch.currentStreamSession = null; }
    // Release any buffered-drain waiters so a parked producer/drain/pre-roll observes
    // `abort` now instead of waiting for stdout EOF (the drain clears its own ref).
    if (ch.currentDrainSignals) {
      try { ch.currentDrainSignals.wakePreroll(); ch.currentDrainSignals.wake(); ch.currentDrainSignals.signalRoom(); } catch { /* already */ }
    }
    // Wake a loop frozen on a pause gate so it observes `abort` and unwinds.
    clearPause(ch);
    disarm(ch);   // play_audio_end only if this channel actually owned the device
  }

  // The `stop` tool means STOP EVERYTHING — both channels.
  function stop() {
    for (const ch of [voice, music]) { ch.userStopped = true; abortPlayback(ch); }
  }

  // Hard cut: abort both pipelines AND tell the device to FLUSH (drop its ring +
  // clear the DMA) so the speaker goes silent within a frame and the half-duplex
  // mic re-engages immediately. NOT used by withPlayback's preempt, so it never
  // glitches a playback handoff.
  function hardStop() {
    for (const ch of [voice, music]) { ch.userStopped = true; ch.flushed = true; abortPlayback(ch); }
    sendCmd({ type: "stop_audio" });   // decisive device flush
  }

  // pause/resume: MUSIC only (the jukebox is the only caller; her reply is
  // aborted/superseded, never paused). Freezes on a frame boundary, keeping the
  // un-drained audio so resume() continues from exactly where it stopped.
  function pause() {
    if (!music.playing || music.paused) return false;
    music.paused = true;
    if (!music.resumeGate) music.resumeGate = new Promise((r) => { music.releaseResume = r; });
    disarm(music);   // device drains its tail and goes quiet
    return true;
  }

  function resume() {
    if (!music.paused) return false;
    clearPause(music);   // re-arms lazily on the next frame
    return true;
  }

  return {
    streamPcm, speak, speakStream, playUrl, playYoutube, playYoutubeTrack,
    stop, hardStop, pause, resume,
    mute, unmute,
    isMuted: () => muted,
    // Her-voice echo predicates (transcriber gate): voice channel only, and
    // FALSE while muted — a muted reply is inaudible, so the mic must stay
    // open for PTT speech.
    isPlaying: () => voice.playing && !muted,
    isPlayingOrTail: () => !muted && (voice.playing || clock() < voice.recentlyPlayedUntil),
    // Speaker-occupancy predicate for the jukebox's resume-wait (NOT an echo
    // gate — ignores mute; a muted playback still owns the speaker).
    isBusy: () => voice.playing || music.playing,
    isPaused: () => music.paused,
    // Live music pacing (dashboard slider): takes effect on the next frame, mid-track.
    setMusicPacingMs,
    getMusicPacingMs: () => musicPace,
    musicPacingBounds: () => ({ min: MUSIC_PACE_MIN, max: MUSIC_PACE_MAX }),
    // Live voice (TTS) pacing (dashboard slider): takes effect on the next frame.
    setTtsPacingMs,
    getTtsPacingMs: () => ttsPace,
    ttsPacingBounds: () => ({ min: TTS_PACE_MIN, max: TTS_PACE_MAX }),
  };
}
