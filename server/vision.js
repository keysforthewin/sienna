// Vision sub-call for the `look` tool — Sienna's eyes.
//
// A camera snapshot (JPEG) is run through a dedicated image-ANALYSIS prompt:
// the model produces a factual, detailed account of the scene. Her persona is
// deliberately NOT in this call — the analysis comes back as the look tool's
// result and the main agent loop (which has her full identity, personality,
// memories and conversation) reflects on it in her own voice. This split keeps
// the vision call cheap and reliable, and puts the reflection where the
// context actually lives.
//
// Single messages.create with no tools; the gemini.js adapter translates the
// image block → inlineData. Gemini 3.x thinking can consume the whole output
// budget and yield a text-less response — hence the generous maxTokens and one
// retry before giving up.

const ANALYSIS_SYSTEM = [{
  type: "text",
  text:
    "You are the visual-analysis subsystem of Sienna, a home companion device. " +
    "You receive one photo from her camera (her view of the room). Produce a " +
    "concise but thorough FACTUAL analysis of the image: the setting, lighting " +
    "and time-of-day cues, any people (position, posture, apparent activity — " +
    "never identity claims beyond what is visible), animals, notable objects, " +
    "anything in motion or apparently changed, and anything unusual or " +
    "noteworthy. If a specific question is asked, answer it directly first, " +
    "then add the rest of the analysis. Plain prose, no markdown, no preamble.",
}];

export function createVision({ client, model, maxTokens = 1024 }) {
  async function analyzeOnce(jpegBuffer, question) {
    const res = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system: ANALYSIS_SYSTEM,
      messages: [{
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/jpeg", data: jpegBuffer.toString("base64") },
          },
          { type: "text", text: question || "Analyze what the camera sees right now." },
        ],
      }],
    });
    const block = (res.content || []).find((b) => b.type === "text");
    return block?.text?.trim() || null;
  }

  async function describe(jpegBuffer, { question } = {}) {
    // A thinking model can occasionally burn the budget and return no visible
    // text; one retry recovers the common transient case.
    const out = (await analyzeOnce(jpegBuffer, question)) ?? (await analyzeOnce(jpegBuffer, question));
    if (!out) throw new Error("vision: model returned no text (after retry)");
    return out;
  }

  return { describe };
}
