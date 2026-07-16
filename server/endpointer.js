// Server-side end-of-speech detection for the realtime transcriber.
//
// ElevenLabs VAD-commit is unreliable with the device's continuously-streaming,
// high-gain INMP441: the mic sends a noisy floor with no real silence gap, so
// `committed_transcript` often never fires and nothing reaches the agent. Instead
// we endpoint here from the device's `mic_rms` stream (~20 Hz). An EMA noise floor
// adapts to the room; a frame counts as speech when rms > floor * speechFactor.
// Once we've heard >= minSpeechMs of speech and then silenceMs of quiet, we fire
// onEndpoint — the transcriber latches a force-commit onto its next frame, so the
// utterance commits promptly and routes to Sienna.
//
// Uses an adaptive-baseline (EMA noise floor) approach so it tolerates the
// unknown absolute RMS scale. Firing is gated to while transcription is live and
// she isn't speaking (her own TTS is picked up by the mic — we must not
// endpoint on it).

export function createSpeechEndpointer({
  onEndpoint = () => {},
  isActive = () => true,     // only endpoint while transcription is live
  isSpeaking = () => false,  // ignore her own TTS echoed back through the mic
  alpha = 0.1,               // EMA factor for the ambient noise floor
  speechFactor = 2.5,        // rms > floor * speechFactor ⇒ speech
  silenceMs = 800,           // quiet held this long after speech ⇒ end of utterance
  minSpeechMs = 200,         // require this much speech before a valid endpoint
  clock = () => Date.now(),
  log = () => {},            // diagnostic hook (per-utterance transitions; throttled state)
} = {}) {
  let floor = null;
  let inSpeech = false;
  let speechStartAt = 0;
  let lastVoiceAt = 0;
  let fired = false;          // already endpointed this utterance (fire once)
  let lastLogAt = 0;          // throttle the "still going" diagnostic to ~1/s

  function reset() {
    floor = null;
    inSpeech = false;
    speechStartAt = 0;
    lastVoiceAt = 0;
    fired = false;
    lastLogAt = 0;
  }

  function feed(rms) {
    if (typeof rms !== "number" || Number.isNaN(rms)) return;
    if (isSpeaking()) return;                       // her TTS: ignore entirely
    if (floor === null) { floor = rms; return; }    // seed the baseline

    const now = clock();
    const isVoice = rms > floor * speechFactor;
    if (!isVoice) floor += alpha * (rms - floor);   // adapt the floor while quiet

    if (!isActive()) { inSpeech = false; return; }  // not transcribing: never fire

    const thresh = floor * speechFactor;
    if (isVoice) {
      if (!inSpeech) {
        inSpeech = true; speechStartAt = now; fired = false;
        log(`speech started (rms=${rms.toFixed(0)} floor=${floor.toFixed(0)} thresh=${thresh.toFixed(0)})`);
      } else if (now - lastLogAt >= 1000) {
        // Still hearing "voice" — if this keeps printing while you're silent, the
        // floor/threshold is too low for this mic (silence reads as speech) and the
        // endpoint never fires (so commit falls back to ElevenLabs' slow timeout).
        lastLogAt = now;
        log(`voice held ${now - speechStartAt}ms (rms=${rms.toFixed(0)} thresh=${thresh.toFixed(0)}) — no silence yet`);
      }
      lastVoiceAt = now;
    } else if (inSpeech && !fired) {
      const silence = now - lastVoiceAt;
      const spoke = lastVoiceAt - speechStartAt;
      if (silence >= silenceMs && spoke >= minSpeechMs) {
        fired = true;
        inSpeech = false;
        log(`end-of-speech → commit (spoke ${spoke}ms, silence ${silence}ms)`);
        onEndpoint();
      } else if (now - lastLogAt >= 1000) {
        lastLogAt = now;
        log(`waiting (rms=${rms.toFixed(0)} thresh=${thresh.toFixed(0)} silence=${silence}/${silenceMs}ms spoke=${spoke}ms)`);
      }
    }
  }

  return { feed, reset };
}
