#pragma once
#include <stdint.h>
#include <stddef.h>
#include <functional>

namespace audio_io {

constexpr uint32_t SAMPLE_RATE = 16000;
constexpr size_t   PCM_FRAME_SAMPLES = 1024;          // 64 ms at 16 kHz
constexpr size_t   PCM_FRAME_BYTES   = PCM_FRAME_SAMPLES * sizeof(int16_t);

bool begin();

// RMS pump (always running)
struct MicMetrics { float rms; int16_t peak; };
void onMicMetrics(std::function<void(const MicMetrics&)> cb);

// Recording: when enabled, mic frames also fire onPcmFrame.
void startRecording();
void stopRecording();
void onPcmFrame(std::function<void(const int16_t*, size_t)> cb);

// Playback: synth tone (blocks until done; call sparingly)
void playTone(float hz, uint32_t durationMs, float amplitude);

// Streaming playback: feed 16-bit mono PCM frames into the speaker.
// Stop = graceful (drain the DMA tail); Flush = hard abort (drop + clear DMA).
void playPcmStreamStart();
void playPcmStreamFeed(const int16_t* samples, size_t count);
void playPcmStreamStop();
void playPcmStreamFlush();

// Instant-mute probe: when set and returning true, the playback task DISCARDS
// streamed frames instead of writing them (silence within one ~64 ms frame) and
// playPcmStreamFeed drops incoming frames. Wired to the RAW PTT GPIO level (no
// debounce, no server round-trip) so the speaker dies the moment the button is
// physically down. playTone is deliberately NOT gated — the listen/commit beeps
// must sound during a hold.
void setMuteProbe(std::function<bool()> probe);

// True while STREAMING playback is active (playPcmStream*). NOT playTone — a tone
// blocks tick(), so no mic frame is read during it and it needs no gate here.
// Used by the half-duplex mic gate: suppress recorded-PCM sends while the speaker plays.
bool isSpeakerActive();

void tick();  // call from loop() — drives mic read + RMS

}  // namespace audio_io
