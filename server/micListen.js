// On-demand listening for the Sienna agent — her `listen` tool's engine.
//
// Unlike transcriber.js (a persistent Speech-panel toggle that routes finished
// transcripts into a NEW agent.run as push-to-talk), this is a one-shot capture
// the agent calls mid-thought: it opens its OWN time-boxed Scribe session, waits
// a few seconds, and RETURNS what it heard inline so she can react within the
// same run. (Routing through onFinalTranscript would deadlock — the agent loop is
// single-flight, so a queued ptt run would just stack behind the in-flight one.)
//
// It shares the ref-counted micStream arbiter (its own "listen:<uuid>" token) so
// it coexists with the recorder/transcriber without stomping start/stop_recording.

import { randomUUID } from "node:crypto";

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export function createMicListener({
  micStream,
  scribeFactory,                       // null when ELEVENLABS_API_KEY is unset
  defaultSeconds = 20,
  minSeconds = 5,
  maxSeconds = 30,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  uuid = randomUUID,
}) {
  let session = null;   // active Scribe session, or null
  let token = null;     // "listen:<uuid>" while a window is open, or null

  async function listen({ seconds, maxSeconds: maxOverride } = {}) {
    if (!scribeFactory) return { ok: false, reason: "not_configured" };
    if (token) return { ok: false, reason: "busy" };

    // The `listen` tool caps at maxSeconds (it runs inside an agent turn bounded by
    // SIENNA_RUN_TIMEOUT_MS); out-of-band callers like eavesdrop pass maxOverride to
    // open a longer window without raising the tool's ceiling.
    const secs = clamp(seconds ?? defaultSeconds, minSeconds, maxOverride ?? maxSeconds);
    const myToken = `listen:${uuid()}`;
    // Acquire before opening Scribe — pointless to pay for a socket with no audio.
    // acquire() returns false when the device is offline.
    if (!micStream.acquire(myToken)) return { ok: false, reason: "device_offline" };
    token = myToken;

    const committed = [];
    let lastPartial = "";
    let sttError = null;

    try {
      session = scribeFactory({
        callbacks: {
          onPartial: (t) => { if (t) lastPartial = t; },
          onCommitted: (t) => { if (t && t.trim()) committed.push(t.trim()); },
          // Record but don't tear down — the deadline drives teardown so a
          // mid-window hiccup still returns whatever we managed to capture.
          onError: (kind) => { sttError = kind; },
          onClose: () => {},
        },
      });
    } catch {
      micStream.release(token);
      token = null;
      return { ok: false, reason: "scribe_init_failed" };
    }

    try {
      await sleep(secs * 1000);
    } finally {
      try { session?.close(); } catch { /* already closed */ }
      session = null;
      // Always release — even after handleDeviceDisconnect/micStream.reset(),
      // where release() is a safe no-op (the token is no longer a holder).
      micStream.release(token);
      token = null;
    }

    const transcript = committed.length ? committed.join(" ") : lastPartial.trim();
    return { ok: true, transcript, heardSpeech: transcript.length > 0, ...(sttError ? { sttError } : {}) };
  }

  function feedPcm(buf) {
    if (session) session.sendPcm(buf);   // no-op unless a window is open
  }

  // Device vanished mid-listen: close the session so feedPcm stops forwarding,
  // but DON'T release the token here. The composition root calls micStream.reset()
  // globally, and the in-flight listen()'s own finally still runs release() at the
  // deadline (a no-op against the reset arbiter). Keeping the token set also blocks
  // a second listen() until the current window's deadline passes.
  function handleDeviceDisconnect() {
    if (!token) return;
    try { session?.close(); } catch { /* already closed */ }
    session = null;
  }

  return {
    listen,
    feedPcm,
    isActive: () => token !== null,
    handleDeviceDisconnect,
  };
}
