#include "audio_io.h"

#include <Arduino.h>
#include <ESP_I2S.h>
#include <atomic>
#include <math.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/stream_buffer.h"
#include "freertos/semphr.h"
#include "log.h"
#include "pins.h"

namespace audio_io {

static I2SClass gMic;
static I2SClass gSpk;
static std::function<void(const MicMetrics&)>           gMetricsCb;
static std::function<void(const int16_t*, size_t)>      gPcmCb;
static bool gRecording = false;
static bool gReady = false;
static bool gPlaybackActive = false;
// Instant-mute probe (raw PTT GPIO, wired in the .ino). Read per frame by the
// playback task AND by playPcmStreamFeed; set once in setup() before the
// playback task exists, so no synchronization is needed beyond the GPIO read.
static std::function<bool()> gMuteProbe;
static inline bool instantMuted() { return gMuteProbe && gMuteProbe(); }

// ---- Playback ring buffer + dedicated I2S writer task ----
// The speaker is fed by a dedicated FreeRTOS task draining a ring buffer, NOT
// synchronously from the WS-receive callback on loop(). loop() blocks ~64 ms per
// iteration on gMic.readBytes(), so a synchronous gSpk.write() there starved the
// speaker DMA between mic reads → underruns → choppy playback on every source
// (TTS/WAV/YouTube). The task writes at the true 16 kHz hardware rate (a blocking
// gSpk.write() IS the pacing); the deep ring (≈2.56 s, see PLAY_RING_BYTES) rides out
// the mic block, loop jitter, and Wi-Fi delivery bursts (StreamBuffer + dedicated-task
// pattern).
static StreamBufferHandle_t  gPlayStream  = nullptr;
static SemaphoreHandle_t     gSpkMutex    = nullptr;   // serializes ALL gSpk access
static std::atomic<uint32_t> gPlayDropped{0};          // ring-full drops (overflow, diagnostic)
static std::atomic<uint32_t> gPlayUnderrun{0};         // ring-empty-while-active (underrun, diagnostic)
static std::atomic<uint32_t> gPlayFedBytes{0};         // total bytes enqueued (receive-rate diag)
static std::atomic<bool>     gPlayFlush{false};        // loop → task: discard the ring
// The ring's bulk storage lives in PSRAM, NOT internal DRAM. Internal DRAM is the
// scarce resource on this board — NimBLE + the wss/TLS handshake fight over it (see
// enterWsOpening() in the .ino). A 14 KB internal StreamBuffer at boot starved that
// init and broke Wi-Fi + BLE bring-up. FreeRTOS can't put a *dynamic* stream buffer
// in PSRAM, so we use the Static variant with a PSRAM-allocated storage array and a
// tiny internal control struct. Task stacks must stay in internal DRAM (PSRAM stacks
// aren't allowed), but 4 KB is modest.
static uint8_t*             gPlayRingStorage = nullptr;  // PSRAM-backed (PLAY_RING_BYTES+1)
static StaticStreamBuffer_t gPlayRingStruct;             // internal control block (small)
static int16_t*             gPlayScratch     = nullptr;  // PSRAM task scratch (one frame)

#ifdef ARDUINO_RUNNING_CORE
static const BaseType_t PLAY_TASK_CORE = ARDUINO_RUNNING_CORE;  // app core, off the radio
#else
static const BaseType_t PLAY_TASK_CORE = 1;
#endif
static const uint32_t   PLAY_TASK_STACK = 4096;
static const UBaseType_t PLAY_TASK_PRIO = 2;            // just above loopTask
// Cap on how long playPcmStreamFeed() parks loop() waiting for ring space when NOT
// recording (music / her voice playback). This wait is the BACKPRESSURE mechanism: while
// it parks, loop() stops draining the WS socket, the socket's bufferedAmount climbs, and
// the server's awaitDeviceDrain pauses sending — so a sustained over-delivery (her voice
// streams ~1.6× realtime) is throttled to the device's true play rate instead of
// overflowing. It MUST therefore be longer than the time to free space for one incoming
// frame, or it times out and DROPS instead of backpressuring: incoming audio frames are
// 4096 B (2048 samples = 128 ms), and the playback task frees a 2048 B chunk every ~64 ms,
// so freeing 4096 B takes ~128 ms. The old 120 ms was just UNDER that — so once the ring
// filled (a long reply: her voice over-delivers and fills even the deep ring in a few
// seconds), every following frame dropped → garbled/choppy voice on anything past a few
// seconds. 200 ms clears one frame with margin and lets the socket back up so the server
// paces down. The instant-mute probe below breaks out of this wait the moment PTT goes
// down (raw GPIO), so a longer cap does NOT regress press-to-mute / button-detect latency;
// the only cost is non-PTT loop work lagging up to this long while the ring is pinned full
// (acceptable — that only happens deep into a long uninterrupted clip). The old 500 ms ×
// up to 8 frames/ws-tick that stalled loop() for ~4 s is still well clear.
static const uint32_t   PLAY_FEED_MAX_WAIT_MS = 200;
// Ring capacity ≈ 2.56 s of 16 kHz mono int16 (40 × 1024-sample frames): the jitter
// cushion. It was 768 ms (12 frames), which barely cleared the observed Wi-Fi delivery
// bursts (gapped up to ~560 ms) — so realtime-paced music still underran on a slow
// burst (audible skips). A deeper ring rides those out with wide margin; the server
// now paces music at ~realtime (≈128 ms/frame), so the ring tends toward full and
// neither underruns (jitter dips absorbed here) nor overflows (no sustained
// over-delivery to fill it). The storage is PSRAM-backed (≈80 KB — trivial there),
// so the depth is free; start latency is unchanged (playback begins at triggerLevel=1,
// not when full) and the PTT instant-mute flushes the ring, so the deeper buffer does
// NOT add to press-to-mute latency.
static const size_t PLAY_RING_BYTES = PCM_FRAME_BYTES * 40;  // 81920 B

// Speaker init, split out so playPcmStreamFlush() can re-init it to clear the DMA.
static bool beginSpeaker() {
  // Speaker: 16-bit mono, TX only
  gSpk.setPins(pins::SPK_BCLK, pins::SPK_LRC, /*dout=*/pins::SPK_DIN, /*din=*/-1);
  if (!gSpk.begin(I2S_MODE_STD, SAMPLE_RATE,
                  I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO)) {
    LOGE("audio_io: speaker begin failed");
    return false;
  }
  return true;
}

// All gSpk.write()/re-init access goes through the mutex so the playback task, the
// loop's playTone() beeps, and playPcmStreamFlush()'s re-init never race.
static void spkWriteLocked(const uint8_t* data, size_t bytes) {
  if (gSpkMutex) xSemaphoreTake(gSpkMutex, portMAX_DELAY);
  gSpk.write((uint8_t*)data, bytes);
  if (gSpkMutex) xSemaphoreGive(gSpkMutex);
}

// Dedicated speaker task: drains the ring and writes to I2S. gSpk.write() blocks
// on the TX DMA, so this task self-paces at the hardware sample rate; when the ring
// is empty it blocks on xStreamBufferReceive, yielding the core back to loop().
static void playbackTask(void *) {
  int16_t* buf = gPlayScratch;   // PSRAM scratch, allocated in ensurePlayback()
  uint32_t lastLog = millis();
  uint32_t lastFed = 0;
  for (;;) {
    // Underrun signal: the ring is empty while playback is still active, so the
    // task is about to block with the I2S DMA running dry → an audible gap/click.
    if (gPlaybackActive && xStreamBufferIsEmpty(gPlayStream)) gPlayUnderrun.fetch_add(1);

    size_t got = xStreamBufferReceive(gPlayStream, buf, PCM_FRAME_BYTES, portMAX_DELAY);
    // A flush (hold-to-talk release / hard abort) discards whatever is queued so
    // playback cuts off promptly — drop the just-received chunk and drain the rest.
    if (gPlayFlush.exchange(false)) {
      while (xStreamBufferReceive(gPlayStream, buf, PCM_FRAME_BYTES, 0) > 0) { /* discard */ }
      continue;
    }
    if (got == 0) continue;
    // PTT instant mute: the button is physically down → discard instead of
    // write. The speaker goes silent within one frame (≤64 ms) of the press,
    // independent of debounce, the server round-trip, or the command queue.
    if (instantMuted()) continue;
    spkWriteLocked((uint8_t*)buf, got);

    // Periodic health log during playback: ring fill (near PLAY_RING_BYTES = healthy,
    // near 0 = starving), plus overflow/underrun counters. Diagnoses choppiness cause.
    uint32_t now = millis();
    if (now - lastLog >= 2000) {
      uint32_t fed = gPlayFedBytes.load();
      uint32_t recv = (uint32_t)((uint64_t)(fed - lastFed) * 1000 / (now - lastLog));  // bytes/s
      lastFed = fed;
      lastLog = now;
      // recv is the device's real WS receive throughput. Realtime playback needs
      // 32000 B/s (16 kHz × 2 B). recv well under that = the device can't pull frames
      // fast enough (loop/CPU bound) → the ring starves regardless of frame size.
      LOGI("audio_io: playback ring=%u/%u dropped=%u underrun=%u recv=%uB/s (need 32000)",
           (unsigned)xStreamBufferBytesAvailable(gPlayStream), (unsigned)PLAY_RING_BYTES,
           (unsigned)gPlayDropped.load(), (unsigned)gPlayUnderrun.load(), (unsigned)recv);
    }
  }
}

bool begin() {
  // Mic: 32-bit mono left, RX only
  gMic.setPins(pins::MIC_SCK, pins::MIC_WS, /*dout=*/-1, /*din=*/pins::MIC_SD);
  if (!gMic.begin(I2S_MODE_STD, SAMPLE_RATE,
                  I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_MONO,
                  I2S_STD_SLOT_LEFT)) {
    LOGE("audio_io: mic begin failed");
    return false;
  }

  if (!beginSpeaker()) return false;

  gReady = true;
  LOGI("audio_io: ready");
  return true;
}

// Lazily bring up the playback task + ring buffer on the FIRST clip, NOT at boot.
// At boot the scarce internal DRAM is fully consumed by NimBLE + the wss/TLS
// handshake (see enterWsOpening); holding the 4 KB task stack + scratch through that
// window crashed NimBLE deinit (Guru Meditation in BLE stop at ~13 KB largest free
// block). By the time a clip plays, BLE is down and ~87 KB internal is free, so the
// task's footprint is harmless. The ring storage + scratch live in PSRAM regardless.
static bool ensurePlayback() {
  if (gPlayStream) return true;  // already up
  if (!gSpkMutex) gSpkMutex = xSemaphoreCreateMutex();
  if (psramFound()) {
    if (!gPlayScratch) gPlayScratch = (int16_t*)ps_malloc(PCM_FRAME_BYTES);
    if (!gPlayRingStorage) gPlayRingStorage = (uint8_t*)ps_malloc(PLAY_RING_BYTES + 1);  // +1 per API
    if (gPlayRingStorage) {
      gPlayStream = xStreamBufferCreateStatic(
          PLAY_RING_BYTES, /*triggerLevel=*/1, gPlayRingStorage, &gPlayRingStruct);
    }
  }
  if (!gPlayScratch) gPlayScratch = (int16_t*)malloc(PCM_FRAME_BYTES);   // no-PSRAM fallback
  if (!gPlayStream)  gPlayStream  = xStreamBufferCreate(PLAY_RING_BYTES, /*triggerLevel=*/1);
  if (!gSpkMutex || !gPlayStream || !gPlayScratch) {
    LOGE("audio_io: playback alloc failed");
    return false;
  }
  BaseType_t ok = xTaskCreatePinnedToCore(
      playbackTask, "spk", PLAY_TASK_STACK, nullptr, PLAY_TASK_PRIO, nullptr, PLAY_TASK_CORE);
  if (ok != pdPASS) {
    LOGE("audio_io: playback task create failed");
    return false;
  }
  LOGI("audio_io: playback ready (lazy)");
  return true;
}

void onMicMetrics(std::function<void(const MicMetrics&)> cb) { gMetricsCb = std::move(cb); }
void onPcmFrame(std::function<void(const int16_t*, size_t)> cb) { gPcmCb = std::move(cb); }
void startRecording() { gRecording = true; }
void stopRecording()  { gRecording = false; }

void playTone(float hz, uint32_t durationMs, float amplitude) {
  if (!gReady) return;
  if (amplitude < 0) amplitude = 0;
  if (amplitude > 1) amplitude = 1;
  const int16_t amp = (int16_t)(amplitude * 30000.0f);
  const float phaseInc = 2.0f * (float)M_PI * hz / (float)SAMPLE_RATE;
  static int16_t buf[PCM_FRAME_SAMPLES];
  uint32_t totalSamples = (SAMPLE_RATE * durationMs) / 1000;
  float phase = 0.0f;
  // Hold the speaker mutex across the WHOLE tone: with the PTT duck, streamed
  // music may be playing while a beep fires, and per-frame locking would
  // interleave beep and music frames (garbled). Locking once parks the playback
  // task for the beep's duration; its frames queue in the ring meanwhile.
  if (gSpkMutex) xSemaphoreTake(gSpkMutex, portMAX_DELAY);
  while (totalSamples > 0) {
    size_t n = totalSamples < PCM_FRAME_SAMPLES ? totalSamples : PCM_FRAME_SAMPLES;
    for (size_t i = 0; i < n; i++) {
      buf[i] = (int16_t)(sinf(phase) * amp);
      phase += phaseInc;
      if (phase > 2.0f * (float)M_PI) phase -= 2.0f * (float)M_PI;
    }
    gSpk.write((uint8_t*)buf, n * sizeof(int16_t));
    totalSamples -= n;
  }
  if (gSpkMutex) xSemaphoreGive(gSpkMutex);
}

void playPcmStreamStart() {
  // Bring up the playback task + buffers on first use (kept off the boot/BLE/TLS
  // path — see ensurePlayback). If it can't allocate, stay inactive (silent) rather
  // than feed a null ring.
  if (!ensurePlayback()) { gPlaybackActive = false; return; }
  // Clear any lingering flush request so the new clip's frames are not discarded.
  gPlayFlush.store(false);
  gPlaybackActive = true;
}

// Graceful end: stop accepting frames but let whatever is already in the ring +
// DMA clock out, so a finite clip's tail (WAV/TTS/agent speech) is not chopped.
void playPcmStreamStop() { gPlaybackActive = false; }

// Hard abort: drop queued frames AND flush the DMA so playback cuts off promptly —
// used by Hold-to-talk on release. The task discards the ring on gPlayFlush; the
// gSpk re-init (the portable way to clear the TX DMA) handles samples already
// queued in hardware. Both gSpk accesses are serialized by the mutex.
void playPcmStreamFlush() {
  gPlaybackActive = false;
  gPlayFlush.store(true);
  if (gReady && gSpkMutex) {
    xSemaphoreTake(gSpkMutex, portMAX_DELAY);
    gSpk.end();
    beginSpeaker();
    xSemaphoreGive(gSpkMutex);
  }
}

// Half-duplex mic gate predicate: true while streaming playback is feeding the
// speaker OR its ring still has a tail to drain. gPlaybackActive is read/written on
// the loop task (no race with the onPcmFrame reader); the xStreamBufferIsEmpty query
// is a single-reader check the playbackTask concurrently drains — advisory, with at
// most one-frame slop, which is harmless here.
bool isSpeakerActive() {
  return gPlaybackActive || (gPlayStream && !xStreamBufferIsEmpty(gPlayStream));
}

void setMuteProbe(std::function<bool()> probe) { gMuteProbe = std::move(probe); }

void playPcmStreamFeed(const int16_t* samples, size_t count) {
  // Gate on the active flag so a stray frame arriving after play_audio_end is dropped.
  if (!gReady || !gPlaybackActive || !gPlayStream) return;
  // PTT instant mute: don't bank audio while the button is down — it would sit
  // in the ring and burst out stale on release. The server is muting/ducking
  // these frames moments later anyway; dropping here just beats the round-trip.
  if (instantMuted()) return;
  const size_t bytes = count * sizeof(int16_t);
  // NEVER enqueue a partial frame. xStreamBufferSend() with a timeout can write fewer
  // bytes than asked when the ring is near-full; that leaves a torn byte count in the
  // ring and misaligns every following sample → a blast of static for the rest of the
  // clip (this is what broke fast/bursty TTS while steady WAV stayed fine). Instead wait
  // (bounded) until the WHOLE frame fits, then enqueue it atomically — the wait is the
  // backpressure that throttles the sender to the device's real rate. On a stuck
  // consumer, drop the WHOLE frame (a clean, recoverable gap), never a partial.
  // While RECORDING (PTT hold over the ducked music bed), never park the loop
  // waiting for ring space: loop() must keep up the ~64 ms mic-read cadence or
  // the user's speech arrives choppy at Scribe. Dropping a ducked-bed frame is a
  // subtle background glitch; dropping mic audio garbles the transcript.
  const TickType_t maxWait = gRecording ? 0 : pdMS_TO_TICKS(PLAY_FEED_MAX_WAIT_MS);
  TickType_t start = xTaskGetTickCount();
  while (xStreamBufferSpacesAvailable(gPlayStream) < bytes) {
    // A physical PTT press must NEVER sit behind a ring-full wait. The moment the
    // button is down (raw GPIO, no debounce) the speaker is muting anyway, so
    // stop parking loop() right now — this is what lets buttons::tick() detect
    // the press and the listen beep / start_recording process within one loop
    // pass instead of seconds into a stalled music feed.
    if (instantMuted()) { gPlayDropped.fetch_add(1); return; }
    if ((xTaskGetTickCount() - start) >= maxWait) { gPlayDropped.fetch_add(1); return; }
    vTaskDelay(1);
  }
  xStreamBufferSend(gPlayStream, samples, bytes, 0);  // space ensured → whole frame, never torn
  gPlayFedBytes.fetch_add(bytes);
}

void tick() {
  if (!gReady) return;
  static int32_t raw32[PCM_FRAME_SAMPLES];
  static int16_t pcm16[PCM_FRAME_SAMPLES];

  size_t got_bytes = gMic.readBytes((char*)raw32, sizeof(raw32));
  size_t got = got_bytes / sizeof(int32_t);
  if (got == 0) return;

  int16_t peak = 0;
  double sumsq = 0.0;
  for (size_t i = 0; i < got; i++) {
    // INMP441 24-bit left-justified in int32; shift to keep upper 16 bits
    int32_t s = raw32[i] >> 16;
    if (s > 32767)  s = 32767;
    if (s < -32768) s = -32768;
    pcm16[i] = (int16_t)s;
    int32_t a = s < 0 ? -s : s;
    if (a > peak) peak = a;
    sumsq += (double)s * (double)s;
  }
  double rms = sqrt(sumsq / got);

  if (gMetricsCb) {
    gMetricsCb({ (float)rms, peak });
  }
  if (gRecording && gPcmCb) {
    gPcmCb(pcm16, got);
  }
}

}  // namespace audio_io
