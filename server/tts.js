// ElevenLabs text-to-speech (HTTP). One streaming helper backs every speaker
// path — the agent's gapless reply (sentence-chunked), the `speak` tool, and the
// browser Voice-panel Speak. All use the HTTP `/stream` endpoint with eleven_v3
// and pcm_16000 (the device's native 16 kHz mono int16), so the server paces the
// chunked bytes straight to the device. The API key never leaves the server and
// is never put in error text.

const ENDPOINT = "https://api.elevenlabs.io/v1/text-to-speech";
const PCM_FORMAT = "pcm_16000";
const TIMEOUT_MS = 30000;

export function createElevenLabsTts({ apiKey, voiceId, modelId, streamOutputFormat = PCM_FORMAT, fetchImpl = fetch }) {
  if (!apiKey) throw new Error("createElevenLabsTts: apiKey is required");

  // `stream` hits the `/stream` endpoint, which returns the audio in chunks as
  // it's synthesized (vs the whole render at once) and resolves to the raw body
  // stream, so the device hears the first words within a few hundred ms. The
  // optional body params (voice_settings, …) are only sent when provided so the
  // simple paths keep a minimal body. (We do NOT send previous_text/next_text:
  // eleven_v3 — the only model we use — rejects them with 400 unsupported_model,
  // which would fail every chunk after the first in a sentence-chunked reply.)
  // An external abort `signal` is merged with the request timeout.
  async function request(text, {
    outputFormat, accept, stream = false,
    voiceSettings, applyTextNormalization, languageCode, signal,
  }) {
    const path = `${ENDPOINT}/${encodeURIComponent(voiceId)}${stream ? "/stream" : ""}`;
    const url = `${path}?output_format=${outputFormat}`;
    const body = { text, model_id: modelId };
    if (voiceSettings) body.voice_settings = voiceSettings;
    if (applyTextNormalization) body.apply_text_normalization = applyTextNormalization;
    if (languageCode) body.language_code = languageCode;
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "content-type": "application/json",
        accept,
      },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = await res.text();
      } catch {
        /* ignore */
      }
      throw new Error(`elevenlabs ${res.status}: ${detail.slice(0, 500)}`);
    }
    return res;
  }

  // Streaming raw int16 PCM @ 16 kHz mono — returns the response body (an async
  // iterable of byte chunks). The fixed transport (format/accept/stream) always
  // wins over `opts`, which carries the optional voice settings + an abort signal.
  const stream = async (text, opts = {}) =>
    (await request(text, { ...opts, outputFormat: streamOutputFormat, accept: "audio/pcm", stream: true })).body;

  // Buffered raw int16 PCM — the fallback for `speak()` when streaming isn't available.
  const synthesizePcm16 = async (text) =>
    Buffer.from(await (await request(text, { outputFormat: PCM_FORMAT, accept: "audio/pcm" })).arrayBuffer());

  return { stream, synthesizePcm16 };
}
