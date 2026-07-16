// Commit beep: a short tone on the device speaker the moment a finalized
// transcript routes to the agent ("I heard you, I'm processing") — so you know to
// stop talking. Wired in index.js into the transcriber's onFinalTranscript, which
// only fires for non-empty committed text, so the beep can never fire on an empty
// commit (and a pure tone re-heard by the mic commits as empty → no re-beep loop).
//
// `playTone({hz, durationMs, amplitude})` is injected: the composition root builds
// a ref-bearing, validated play_tone command (the firmware drops ref-less ones)
// and sends it fire-and-forget. The amplitude is scaled by the master speaker
// volume and clamped to [0,1] here — the firmware has no device-side gain, and an
// amplitude > 1 would fail the PlayToneCmd schema. DI-factory + injected clock so
// the cooldown/gating is unit-tested in isolation.

export function createCommitBeep({
  playTone,
  isSpeaking = () => false,   // skip while her TTS plays — don't land a tone in it
  volume = null,              // master volume; amplitude is scaled by getPercent()/100
  hz = 880,
  hz2 = 0,                    // optional second tone played right after the first (a
                              // rising/falling chirp); 0/null = single tone. Sent as a
                              // second fire-and-forget play_tone the firmware plays in order.
  durationMs = 200,
  amplitude = 0.5,
  cooldownMs = 600,           // debounce: a rapid double-commit beeps once
  enabled = true,
  clock = () => Date.now(),
} = {}) {
  let lastAt = -Infinity;

  function trigger() {
    if (!enabled) return;
    if (isSpeaking()) return;           // barge-in: stay out of her own speech
    const now = clock();
    if (now - lastAt < cooldownMs) return;
    lastAt = now;                       // debounce regardless of send outcome

    const scale = volume ? volume.getPercent() / 100 : 1;
    let amp = amplitude * scale;
    if (amp < 0) amp = 0;
    else if (amp > 1) amp = 1;

    try {
      playTone({ hz, durationMs, amplitude: amp });
      if (hz2 > 0) playTone({ hz: hz2, durationMs, amplitude: amp });
    } catch {
      /* a beep send failure must never break speech routing — isolate it */
    }
  }

  return { trigger };
}
