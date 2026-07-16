// "Enhance" — use Gemini to insert ElevenLabs v3 inline audio tags into plain
// text. ElevenLabs has no auto-tagging API, so this is done with the same fast
// model that powers the agent (gemini-2.5-flash). The system prompt is static
// (instructions + the allowed tag list). The API key never leaves the server.

// Keep this list in sync with the client tag palette in
// public/js/panels/tts.js. Only these tags are offered to the model.
// Exported so the Sienna agent's base prompt can teach her the same vocabulary
// for inline tagging in her own `speak` text.
export const ALLOWED_TAGS = [
  // Emotions
  "[excited]", "[happy]", "[sad]", "[angry]", "[nervous]", "[curious]",
  "[sarcastic]", "[calm]", "[tired]",
  // Reactions
  "[laughs]", "[sighs]", "[gasps]", "[whispers]", "[clears throat]",
  // Delivery
  "[whispering]", "[shouting]", "[cheerfully]", "[deadpan]",
  "[dramatic tone]", "[pauses]",
];

const SYSTEM_PROMPT = `You rewrite short text for the ElevenLabs v3 text-to-speech model by inserting inline audio tags that make the spoken delivery more expressive.

Audio tags are written in square brackets inline in the text (for example: "[excited] We did it! [laughs]"). The model performs them as emotion, reaction, or delivery cues.

Rules:
- Insert tags only where they genuinely improve the delivery. Use them sparingly — a few well-placed tags beat many.
- Use ONLY tags from this exact list (copy them verbatim, including the brackets):
${ALLOWED_TAGS.join(" ")}
- Do NOT invent new tags or alter the wording of the original text. You may only add tags around the existing words.
- Preserve the original punctuation and capitalization of the words.
- Return ONLY the tagged text. No preamble, no explanation, no quotes, no markdown.`;

// `client` is the Gemini client (gemini.js) — it exposes the Anthropic-shaped
// messages.create the rest of the agent uses, so Enhance shares the one client.
export function createEnhancer({ client }) {
  if (!client) throw new Error("createEnhancer: client is required");

  async function enhance(text) {
    const res = await client.messages.create({
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: text }],
    });
    const block = (res.content || []).find((b) => b.type === "text");
    const out = block?.text?.trim();
    if (!out) throw new Error("enhance: model returned no text");
    return out;
  }

  return { enhance };
}
