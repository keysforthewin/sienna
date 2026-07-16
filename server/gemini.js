// Gemini provider for the Sienna agent — the LLM client. It's an adapter that
// speaks the Anthropic-shaped message subset agent.js / vision.js / enhance.js use
// as their internal format, translating it to/from Gemini's contents/functionCall
// API. Built in index.js when GEMINI_API_KEY (the Gemini Developer API / Google AI
// Studio key) OR GEMINI_VERTEX_PROJECT + GEMINI_VERTEX_LOCATION (Vertex AI, auth via
// Application Default Credentials) are set; the API key takes precedence.
//
// Gemini 2.5 Flash, non-thinking (thinkingBudget: 0). Internally it streams
// (generateContentStream). `messages.create` accumulates one full turn into an
// Anthropic-shaped { content, stop_reason }; `messages.stream` does the same but
// also fires an onTextDelta callback per text chunk so agent.js can pipe tokens
// into the gapless TTS path as they arrive. The loop carries text + tool_use +
// tool_result; it ALSO translates image blocks (vision.js → inlineData) so the
// `look` vision tool runs on Gemini too.

import { randomUUID } from "node:crypto";

const DEFAULT_MODEL = "gemini-2.5-flash";

// Anthropic `system` (string | array of {type:"text",text} blocks) → one string.
export function systemToInstruction(system) {
  if (!system) return undefined;
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    const text = system.map((b) => (typeof b === "string" ? b : b?.text || "")).filter(Boolean).join("\n\n");
    return text || undefined;
  }
  return undefined;
}

// Anthropic tools [{name, description, input_schema}] → Gemini functionDeclarations.
export function toolsToGemini(tools) {
  if (!tools || !tools.length) return undefined;
  return [{
    functionDeclarations: tools.map((t) => ({
      name: t.name,
      description: t.description,
      parametersJsonSchema: t.input_schema || { type: "object", properties: {} },
    })),
  }];
}

// Gemini usageMetadata → our flat token record. Prompt tokens are split into
// image vs text via promptTokensDetails (the per-modality breakdown); output folds
// in thinking tokens (billed as output). Returns null when no metadata is present
// (so callers can skip metering a call that didn't report usage).
export function normalizeUsage(u) {
  if (!u) return null;
  const details = Array.isArray(u.promptTokensDetails) ? u.promptTokensDetails : [];
  const sum = (pred) => details.filter(pred).reduce((s, d) => s + (d.tokenCount || 0), 0);
  const isImage = (d) => String(d.modality || "").toUpperCase() === "IMAGE";
  const input_total = u.promptTokenCount || 0;
  const input_image = sum(isImage);
  // Text = the non-image prompt modalities when a breakdown exists, else the
  // remainder after image (which is 0 without a breakdown → text == total).
  const input_text = details.length ? sum((d) => !isImage(d)) : Math.max(0, input_total - input_image);
  const output = (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0);
  const total = u.totalTokenCount || input_total + output;
  const cached = u.cachedContentTokenCount || 0;
  return { input_total, input_text, input_image, output, total, cached };
}

// Coerce an Anthropic tool_result `content` (string | array of text blocks) to text.
function resultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => c?.text || "").join("");
  return String(content ?? "");
}

// Anthropic messages → Gemini contents. tool_result parts need the *function name*
// (Gemini), not the tool_use id (Anthropic), so first map id→name from the
// assistant tool_use blocks, then resolve each tool_result against it.
export function messagesToContents(messages = []) {
  const idToName = new Map();
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const b of m.content) if (b && b.type === "tool_use") idToName.set(b.id, b.name);
    }
  }

  const contents = [];
  for (const m of messages) {
    if (m.role === "user") {
      if (typeof m.content === "string") {
        if (m.content) contents.push({ role: "user", parts: [{ text: m.content }] });
        continue;
      }
      if (Array.isArray(m.content)) {
        const parts = [];
        for (const b of m.content) {
          if (b.type === "tool_result") {
            const name = idToName.get(b.tool_use_id) || "tool";
            const text = resultText(b.content);
            parts.push({ functionResponse: { name, response: b.is_error ? { error: text } : { output: text } } });
          } else if (b.type === "image" && b.source?.type === "base64") {
            // vision.js sends Anthropic-shaped image blocks; Gemini wants inlineData.
            // This is what lets the `look` vision tool run on Gemini.
            parts.push({ inlineData: { mimeType: b.source.media_type, data: b.source.data } });
          } else if (b.type === "text" && b.text) {
            parts.push({ text: b.text });
          }
        }
        if (parts.length) contents.push({ role: "user", parts });
      }
    } else if (m.role === "assistant" && Array.isArray(m.content)) {
      const parts = [];
      for (const b of m.content) {
        // Gemini 3.x: a thoughtSignature captured off a part must be echoed back
        // on the same part — the API 400s a function-call turn without it.
        const sig = b.thought_signature ? { thoughtSignature: b.thought_signature } : {};
        if (b.type === "text" && b.text) parts.push({ text: b.text, ...sig });
        else if (b.type === "tool_use") parts.push({ functionCall: { name: b.name, args: b.input || {} }, ...sig });
      }
      if (parts.length) contents.push({ role: "model", parts });
    }
  }
  return contents;
}

export function createGeminiClient({
  apiKey = null,          // Gemini Developer API key; takes precedence over Vertex
  project,
  location,
  model = DEFAULT_MODEL,
  maxTokens = 1024,
  genai = null,           // inject a GoogleGenAI-like { models.generateContentStream } for tests
  genaiCtor = null,       // inject a GoogleGenAI constructor for tests (asserts api-key vs vertex)
  refGen = randomUUID,
  onUsage = () => {},     // (usage) => void — fired after every call with normalized
                          // token counts (incl. text/image split), for the cost meter
  log = () => {},
} = {}) {
  let ai = genai;
  async function getAi() {
    if (ai) return ai;
    const GoogleGenAI = genaiCtor || (await import("@google/genai")).GoogleGenAI;  // lazy: keeps the dep out of unit tests
    ai = apiKey
      ? new GoogleGenAI({ apiKey })                          // Gemini Developer API / AI Studio
      : new GoogleGenAI({ vertexai: true, project, location });
    log(`client constructed (${apiKey ? "developer-api" : "vertex"}) model=${model}`);
    return ai;
  }

  // Shared stream consumer. Builds the Gemini request, accumulates one turn into an
  // Anthropic-shaped { content, stop_reason }, and (optionally) fires onTextDelta
  // per text chunk so the caller can stream tokens out as they arrive.
  async function runStream(params = {}, onTextDelta = null) {
    const client = await getAi();
    const config = {
      thinkingConfig: { thinkingBudget: 0 },                 // non-thinking
      maxOutputTokens: params.max_tokens || maxTokens,
    };
    const sys = systemToInstruction(params.system);
    if (sys) config.systemInstruction = sys;
    const tools = toolsToGemini(params.tools);
    if (tools) config.tools = tools;

    const contents = messagesToContents(params.messages);
    const toolCount = tools?.[0]?.functionDeclarations?.length || 0;
    log(`request model=${model} contents=${contents.length} tools=${toolCount} stream=${onTextDelta ? "yes" : "no"}`);

    let stream;
    try {
      stream = await client.models.generateContentStream({ model, contents, config });
    } catch (e) {
      log(`request error: ${e?.message}`);
      throw e;
    }

    let text = "";
    let textSig = null;                                        // Gemini 3: signature on the final text part
    const calls = [];
    let firstToken = false;
    let usageMeta = null;                                      // last chunk's usage wins
    try {
      for await (const chunk of stream) {
        if (chunk?.usageMetadata) usageMeta = chunk.usageMetadata; // arrives on the final chunk(s)
        const parts = chunk?.candidates?.[0]?.content?.parts || [];
        for (const p of parts) {
          if (typeof p.text === "string") {
            // A thought part is internal reasoning — capture its signature but
            // never let its text reach the reply (it would be spoken aloud).
            if (p.thoughtSignature) textSig = p.thoughtSignature;
            if (p.thought === true) continue;
            if (!firstToken) { firstToken = true; log("first token"); }
            text += p.text;
            if (onTextDelta && p.text) { try { onTextDelta(p.text); } catch { /* a TTS push must not break reasoning */ } }
          } else if (p.functionCall) {
            log(`functionCall ${p.functionCall.name}`);
            calls.push({ name: p.functionCall.name, args: p.functionCall.args || {}, thoughtSignature: p.thoughtSignature });
          }
        }
      }
    } catch (e) {
      log(`stream error: ${e?.message}`);
      throw e;
    }
    const usage = normalizeUsage(usageMeta);
    log(`complete textLen=${text.length} calls=${calls.length}${usage ? ` in=${usage.input_total} out=${usage.output}` : ""}`);
    if (usage) { try { onUsage(usage); } catch { /* metering must never break reasoning */ } }

    const content = [];
    if (text) content.push({ type: "text", text, ...(textSig ? { thought_signature: textSig } : {}) });
    for (const c of calls) content.push({ type: "tool_use", id: refGen(), name: c.name, input: c.args, ...(c.thoughtSignature ? { thought_signature: c.thoughtSignature } : {}) });

    const stop_reason = calls.length ? "tool_use" : "end_turn";
    return { content, stop_reason, usage };
  }

  // Anthropic-shaped, non-streaming: used for reflection, wrap-up, tool rounds,
  // vision, and Enhance. Accumulates the full turn before returning.
  const create = (params = {}) => runStream(params, null);

  // Same accumulated result, but surfaces token deltas live (gapless TTS path).
  const stream = (params = {}, { onTextDelta = null } = {}) => runStream(params, onTextDelta);

  // supportsTokenStream lets agent.js feature-detect this client's token-delta
  // .stream (the gapless-TTS path) vs a plain non-streaming client.
  return { messages: { create, stream }, supportsTokenStream: true };
}
