import { test } from "node:test";
import assert from "node:assert/strict";
import { createGeminiClient, systemToInstruction, toolsToGemini, messagesToContents, normalizeUsage } from "./gemini.js";

// A fake GoogleGenAI: captures the params it was called with and yields the given
// chunks (each chunk shaped like a real GenerateContentResponse chunk).
function makeGenai(chunks, capture = {}) {
  return {
    models: {
      async generateContentStream(params) {
        capture.params = params;
        return (async function* () { for (const c of chunks) yield c; })();
      },
    },
  };
}
const textChunk = (t) => ({ candidates: [{ content: { parts: [{ text: t }] } }] });
const callChunk = (name, args) => ({ candidates: [{ content: { parts: [{ functionCall: { name, args } }] } }] });
const usageChunk = (u) => ({ usageMetadata: u });

test("systemToInstruction flattens an Anthropic block array to one string", () => {
  const out = systemToInstruction([{ type: "text", text: "A" }, { type: "text", text: "B" }]);
  assert.equal(out, "A\n\nB");
  assert.equal(systemToInstruction("hi"), "hi");
  assert.equal(systemToInstruction(undefined), undefined);
});

test("toolsToGemini maps input_schema → parametersJsonSchema under functionDeclarations", () => {
  const out = toolsToGemini([{ name: "speak", description: "say", input_schema: { type: "object", properties: { text: { type: "string" } } } }]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].functionDeclarations[0], {
    name: "speak", description: "say", parametersJsonSchema: { type: "object", properties: { text: { type: "string" } } },
  });
  assert.equal(toolsToGemini([]), undefined);
});

test("messagesToContents maps a tool_use/tool_result round-trip to functionCall/functionResponse by name", () => {
  const messages = [
    { role: "user", content: "turn on the light" },
    { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "set_blue_led", input: { on: true } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok: led on" }] },
  ];
  const contents = messagesToContents(messages);
  assert.deepEqual(contents[0], { role: "user", parts: [{ text: "turn on the light" }] });
  assert.deepEqual(contents[1], { role: "model", parts: [{ functionCall: { name: "set_blue_led", args: { on: true } } }] });
  // tool_result resolves to the function NAME (not the tool_use id) — Gemini's requirement.
  assert.deepEqual(contents[2], { role: "user", parts: [{ functionResponse: { name: "set_blue_led", response: { output: "ok: led on" } } }] });
});

test("messagesToContents marks an errored tool_result as an error response", () => {
  const messages = [
    { role: "assistant", content: [{ type: "tool_use", id: "x", name: "look", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "device offline", is_error: true }] },
  ];
  const contents = messagesToContents(messages);
  assert.deepEqual(contents[1].parts[0].functionResponse.response, { error: "device offline" });
});

test("create returns a plain text turn as an Anthropic-shaped end_turn response", async () => {
  const capture = {};
  const genai = makeGenai([textChunk("Hello "), textChunk("there.")], capture);
  const client = createGeminiClient({ genai, model: "gemini-2.5-flash", maxTokens: 512 });
  const res = await client.messages.create({
    system: [{ type: "text", text: "You are Sienna." }],
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 256,
  });
  assert.deepEqual(res.content, [{ type: "text", text: "Hello there." }]);
  assert.equal(res.stop_reason, "end_turn");
  // streaming chunks were accumulated; config is non-thinking with the right budget
  assert.equal(capture.params.model, "gemini-2.5-flash");
  assert.equal(capture.params.config.thinkingConfig.thinkingBudget, 0);
  assert.equal(capture.params.config.maxOutputTokens, 256);
  assert.equal(capture.params.config.systemInstruction, "You are Sienna.");
});

test("create surfaces a function call as a tool_use block with stop_reason tool_use", async () => {
  const genai = makeGenai([textChunk("let me see "), callChunk("look", { question: "who's there" })]);
  const client = createGeminiClient({ genai, refGen: () => "ID" });
  const res = await client.messages.create({
    tools: [{ name: "look", description: "see", input_schema: { type: "object", properties: {} } }],
    messages: [{ role: "user", content: "what do you see" }],
  });
  assert.deepEqual(res.content, [
    { type: "text", text: "let me see " },
    { type: "tool_use", id: "ID", name: "look", input: { question: "who's there" } },
  ]);
  assert.equal(res.stop_reason, "tool_use");
});

test("stream fires onTextDelta per chunk and returns the same accumulated turn as create", async () => {
  const deltas = [];
  const genai = makeGenai([textChunk("Hello "), textChunk("there.")]);
  const client = createGeminiClient({ genai });
  assert.equal(client.supportsTokenStream, true);
  const res = await client.messages.stream(
    { messages: [{ role: "user", content: "hi" }] },
    { onTextDelta: (d) => deltas.push(d) },
  );
  assert.deepEqual(deltas, ["Hello ", "there."]);          // in order, one per text chunk
  assert.deepEqual(res.content, [{ type: "text", text: "Hello there." }]); // same shape as create
  assert.equal(res.stop_reason, "end_turn");
});

test("stream does not fire onTextDelta for a function-call chunk", async () => {
  const deltas = [];
  const genai = makeGenai([callChunk("look", {})]);
  const client = createGeminiClient({ genai, refGen: () => "ID" });
  const res = await client.messages.stream(
    { tools: [{ name: "look", description: "see", input_schema: { type: "object", properties: {} } }], messages: [{ role: "user", content: "see" }] },
    { onTextDelta: (d) => deltas.push(d) },
  );
  assert.deepEqual(deltas, []);
  assert.equal(res.stop_reason, "tool_use");
});

test("messagesToContents translates an Anthropic image block to Gemini inlineData", () => {
  const contents = messagesToContents([{
    role: "user",
    content: [
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } },
      { type: "text", text: "what's this" },
    ],
  }]);
  assert.deepEqual(contents[0], {
    role: "user",
    parts: [{ inlineData: { mimeType: "image/jpeg", data: "QUJD" } }, { text: "what's this" }],
  });
});

test("normalizeUsage splits image/text, folds thinking into output; null in → null out", () => {
  const u = normalizeUsage({
    promptTokenCount: 130, candidatesTokenCount: 20, thoughtsTokenCount: 5, totalTokenCount: 155,
    promptTokensDetails: [{ modality: "TEXT", tokenCount: 100 }, { modality: "IMAGE", tokenCount: 30 }],
  });
  assert.deepEqual(u, { input_total: 130, input_text: 100, input_image: 30, output: 25, total: 155, cached: 0 });
  assert.equal(normalizeUsage(null), null);
});

test("normalizeUsage falls back to total-minus-image when no modality breakdown", () => {
  const u = normalizeUsage({ promptTokenCount: 80, candidatesTokenCount: 40, totalTokenCount: 120 });
  assert.deepEqual(u, { input_total: 80, input_text: 80, input_image: 0, output: 40, total: 120, cached: 0 });
});

test("a call captures usageMetadata, returns it, and fires onUsage once", async () => {
  const seen = [];
  const genai = makeGenai([
    textChunk("hi"),
    usageChunk({ promptTokenCount: 130, candidatesTokenCount: 20, totalTokenCount: 150,
      promptTokensDetails: [{ modality: "TEXT", tokenCount: 100 }, { modality: "IMAGE", tokenCount: 30 }] }),
  ]);
  const client = createGeminiClient({ genai, onUsage: (u) => seen.push(u) });
  const res = await client.messages.create({ messages: [{ role: "user", content: "hi" }] });
  assert.deepEqual(res.usage, { input_total: 130, input_text: 100, input_image: 30, output: 20, total: 150, cached: 0 });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], res.usage);
});

test("usage is null and onUsage does not fire when no metadata arrives", async () => {
  let fired = 0;
  const genai = makeGenai([textChunk("hi")]);
  const client = createGeminiClient({ genai, onUsage: () => fired++ });
  const res = await client.messages.create({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.usage, null);
  assert.equal(fired, 0);
});

test("constructs the Developer-API client with an apiKey, else Vertex", async () => {
  const built = [];
  function FakeCtor(opts) { built.push(opts); this.models = { async generateContentStream() { return (async function* () { yield textChunk("ok"); })(); } }; }
  const byKey = createGeminiClient({ apiKey: "K", genaiCtor: FakeCtor });
  await byKey.messages.create({ messages: [{ role: "user", content: "hi" }] });
  assert.deepEqual(built[0], { apiKey: "K" });
  const byVertex = createGeminiClient({ project: "p", location: "l", genaiCtor: FakeCtor });
  await byVertex.messages.create({ messages: [{ role: "user", content: "hi" }] });
  assert.deepEqual(built[1], { vertexai: true, project: "p", location: "l" });
});

// ---- Gemini 3 thought signatures -----------------------------------------
// Gemini 3.x models attach a thoughtSignature to functionCall (and final text)
// parts and REJECT a follow-up turn (400 INVALID_ARGUMENT) unless the signature
// is echoed back on the same part. The adapter carries it through the
// Anthropic-shaped blocks as `thought_signature`.

test("stream captures thoughtSignature from functionCall and text parts onto blocks", async () => {
  const genai = makeGenai([
    { candidates: [{ content: { parts: [{ text: "on it ", thoughtSignature: "sigT" }] } }] },
    { candidates: [{ content: { parts: [{ functionCall: { name: "set_rgb", args: { r: 255 } }, thoughtSignature: "sigF" }] } }] },
  ]);
  const client = createGeminiClient({ genai, refGen: () => "ID" });
  const res = await client.messages.create({ messages: [{ role: "user", content: "red" }] });
  assert.deepEqual(res.content, [
    { type: "text", text: "on it ", thought_signature: "sigT" },
    { type: "tool_use", id: "ID", name: "set_rgb", input: { r: 255 }, thought_signature: "sigF" },
  ]);
});

test("messagesToContents echoes thought_signature back onto the Gemini parts", () => {
  const messages = [
    { role: "user", content: "red" },
    { role: "assistant", content: [
      { type: "text", text: "on it ", thought_signature: "sigT" },
      { type: "tool_use", id: "tu_1", name: "set_rgb", input: { r: 255 }, thought_signature: "sigF" },
    ] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }] },
  ];
  const contents = messagesToContents(messages);
  assert.deepEqual(contents[1].parts, [
    { text: "on it ", thoughtSignature: "sigT" },
    { functionCall: { name: "set_rgb", args: { r: 255 } }, thoughtSignature: "sigF" },
  ]);
});

test("blocks without signatures stay clean (2.5-era shape unchanged)", () => {
  const contents = messagesToContents([
    { role: "assistant", content: [{ type: "tool_use", id: "x", name: "look", input: {} }] },
  ]);
  assert.deepEqual(contents[0].parts, [{ functionCall: { name: "look", args: {} } }]);
});

test("thought parts (p.thought) never leak into the spoken text", async () => {
  const deltas = [];
  const genai = makeGenai([
    { candidates: [{ content: { parts: [{ text: "internal musing", thought: true, thoughtSignature: "sigT" }] } }] },
    textChunk("Hello."),
  ]);
  const client = createGeminiClient({ genai });
  const res = await client.messages.stream(
    { messages: [{ role: "user", content: "hi" }] },
    { onTextDelta: (d) => deltas.push(d) },
  );
  assert.deepEqual(deltas, ["Hello."]);
  assert.equal(res.content[0].text, "Hello.");
});
