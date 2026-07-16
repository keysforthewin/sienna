// ElevenLabs Scribe realtime speech-to-text for the "Speech" dashboard widget.
//
// Opens an outbound WebSocket from the server to ElevenLabs and streams the
// device's raw 16 kHz mono int16 PCM (base64-encoded) up as input_audio_chunk
// messages. The server's audio is already pcm_16000, so no resampling is
// needed. Interim (partial) and final (committed) transcripts come back as JSON
// and are surfaced via callbacks. The API key never leaves the server and is
// never put in error text. wsCtor is injectable so tests can run without a
// network (mirrors the fetchImpl injection in tts.js).

import { WebSocket } from "ws";

const ENDPOINT = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";

// 16 kHz mono int16 = 32000 bytes/s. The realtime WS takes a few hundred ms to
// a second to handshake (longer under load — e.g. while music is streaming), so
// the leading audio of a push-to-talk utterance can arrive before the socket is
// OPEN. Rather than drop it (the old behavior, which swallowed first words and
// fed Scribe a truncated fragment) we queue it and flush on "open". Bounded to
// 5 s; on overflow the OLDEST frames drop, so the flushed audio stays contiguous
// with the live stream (a missing prefix beats a mid-utterance gap).
const PCM_BYTES_PER_SEC = 16000 * 2;
const PREOPEN_BUFFER_MAX_BYTES = 5 * PCM_BYTES_PER_SEC;

export function createScribeSession({
  apiKey,
  modelId = "scribe_v2_realtime",
  language,
  // "manual" → the server decides when to commit (our mic_rms endpointer drives
  // a force-commit; see endpointer.js). "vad" → ElevenLabs commits on detected
  // silence, which is unreliable with a continuously-streaming, high-gain mic
  // (the noise floor masks end-of-speech), so it's not the default. vad* tune
  // that path when it IS selected.
  commitStrategy = "manual",
  vadSilenceSecs,
  vadThreshold,
  endpoint = ENDPOINT, // override for regional residency endpoints or tests
  callbacks = {},
  wsCtor = WebSocket,
}) {
  if (!apiKey) throw new Error("createScribeSession: apiKey is required");

  const params = new URLSearchParams({
    model_id: modelId,
    audio_format: "pcm_16000",
    commit_strategy: commitStrategy,
  });
  if (language) params.set("language_code", language);
  if (commitStrategy === "vad") {
    if (vadSilenceSecs != null) params.set("vad_silence_threshold_secs", String(vadSilenceSecs));
    if (vadThreshold != null) params.set("vad_threshold", String(vadThreshold));
  }

  const ws = new wsCtor(`${endpoint}?${params.toString()}`, {
    headers: { "xi-api-key": apiKey },
  });

  // Frames captured before the socket opened, flushed in order on "open".
  let preopen = [];
  let preopenBytes = 0;

  function emit(buf, commit) {
    try {
      ws.send(JSON.stringify({
        message_type: "input_audio_chunk",
        audio_base_64: Buffer.from(buf).toString("base64"),
        commit,
      }));
    } catch {
      /* socket racing closed — drop the frame */
    }
  }

  ws.on("open", () => {
    // Flush the catch-up buffer BEFORE any live frame so the utterance stays in
    // order, then signal readiness.
    const queued = preopen;
    preopen = [];
    preopenBytes = 0;
    for (const f of queued) emit(f.buf, f.commit);
    callbacks.onOpen?.();
  });

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(typeof data === "string" ? data : data.toString("utf8"));
    } catch {
      return;
    }
    switch (msg.message_type) {
      case "session_started":
        break; // informational; the "open" event already signals readiness
      case "partial_transcript":
        callbacks.onPartial?.(msg.text || "");
        break;
      case "committed_transcript":
      case "committed_transcript_with_timestamps":
        callbacks.onCommitted?.(msg.text || "");
        break;
      case "error":
      case "auth_error":
      case "quota_exceeded":
      case "commit_throttled":
      case "rate_limited":
      case "queue_overflow":
      case "session_time_limit_exceeded":
        callbacks.onError?.(msg.message_type, msg.error || msg.detail || "");
        break;
      default:
        break;
    }
  });

  ws.on("close", (code, reason) =>
    callbacks.onClose?.(code, reason?.toString?.() || ""));
  ws.on("error", (err) => callbacks.onError?.("ws_error", err?.message || ""));

  // `commit:true` rides a real audio chunk to force ElevenLabs to commit the
  // buffered utterance (the API has no separate flush/commit message, and an
  // empty-payload chunk isn't documented as valid). The endpointer latches a
  // commit onto the next frame at end-of-speech; normal frames send commit:false.
  function sendPcm(buf, { commit = false } = {}) {
    const ready = ws.readyState;
    if (ready === 1 /* OPEN */) { emit(buf, commit); return; }
    if (ready !== 0 /* not CONNECTING */) return; // CLOSING/CLOSED — never opening, drop
    // Still handshaking: queue for the "open" flush instead of dropping the
    // leading audio. Trim the oldest frames past the 5 s cap.
    preopen.push({ buf: Buffer.from(buf), commit });
    preopenBytes += buf.length;
    while (preopenBytes > PREOPEN_BUFFER_MAX_BYTES && preopen.length > 1) {
      preopenBytes -= preopen.shift().buf.length;
    }
  }

  function close() {
    try { ws.close(); } catch { /* already closed */ }
  }

  return { sendPcm, close, readyState: () => ws.readyState };
}
