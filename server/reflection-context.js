// Randomized reflection material — the entropy source for Sienna's quiet moments.
//
// A reflection tick used to feed the model the SAME inputs every time (static
// prompt + the unchanging "recent 12 turns" block), so she reflected on the same
// thing and produced near-identical output. This module instead draws a DIFFERENT
// random slice of her past each tick: it pulls a window of the newest activity
// (messages, memories, personality changes, tool calls, images — the same cards
// the dashboard's Activity feed shows), shuffles it, samples a handful, and tells
// her in the prompt that the slice is random and what she's already reflected on.
//
// Pure but for the injected `rng` (default Math.random), so the shuffle/sample is
// deterministic under a fake rng in tests. Reuses toCard/mergeActivity so the
// card shapes match the REST/live seam exactly.

import { toCard, mergeActivity } from "./sienna-cards.js";

function truncate(s, n) {
  const str = String(s ?? "");
  return str.length > n ? str.slice(0, n - 1) + "…" : str;
}

// Fetch the newest `limit` of each activity kind and merge into one newest-first
// card timeline — the same composition as the /api/sienna/activity handler.
export async function collectActivity({ memory, limit = 100, since = null }) {
  const [messages, memories, personality, tools, images] = await Promise.all([
    memory.listRecentMessages(limit),
    memory.recentMemories(limit),
    memory.listPersonalityVersions(limit),
    memory.recentToolCalls(limit),
    memory.recentImages(limit),
  ]);
  const merged = mergeActivity([
    messages.map((d) => toCard("message", d)),
    memories.map((d) => toCard("memory", d)),
    personality.map((d) => toCard("personality", d)),
    tools.map((d) => toCard("tool", d)),
    images.map((d) => toCard("image", d)),
  ], limit);
  if (since == null || !Number.isFinite(since)) return merged;
  return merged.filter((c) => Number(c.ts) >= since);
}

// Fisher-Yates, on a copy, using the injected rng. Does not mutate `arr`.
export function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

// Shuffle the cards and take the first `size` — a random handful of her past.
export function sampleActivity(cards, size, rng = Math.random) {
  return shuffle(cards, rng).slice(0, Math.max(0, size));
}

// One plain-text line per card, using the fields toCard already produced.
export function renderCard(card) {
  switch (card.kind) {
    case "message": {
      const who = card.role === "assistant" ? "You said" : "Heard";
      const tag = card.source && card.source !== "text" ? ` (${card.source})` : "";
      return `${who}${tag}: ${truncate(card.content, 200)}`;
    }
    case "memory": {
      const tags = card.tags && card.tags.length ? ` [${card.tags.join(", ")}]` : "";
      return `Remembered: ${truncate(card.content, 200)}${tags}`;
    }
    case "personality": {
      const v = card.version != null ? `v${card.version}` : "?";
      const reason = card.reason ? `, ${card.reason}` : "";
      return `Personality (${v}${reason}): ${truncate(card.content, 200)}`;
    }
    case "tool": {
      const summary = card.summary ? `: ${truncate(card.summary, 160)}` : "";
      return `Did ${card.name}${summary}`;
    }
    case "image":
      return "Saw something through your camera (a photo you took).";
    default:
      return truncate(card.content, 200);
  }
}

// Build the reflection user message: the base instruction, then the random
// sample (explicitly framed as random/shuffled), the self-expression invitation,
// and what she recently reflected on (so she reaches for something new).
export function buildReflectionPrompt({ base, sample = [], pastReflections = [], rng = Math.random }) {
  const parts = [base];

  if (sample.length) {
    const lines = shuffle(sample, rng).map((c) => `- ${renderCard(c)}`);
    parts.push(
      "Here is a random, shuffled handful of moments from across your past — " +
      "they are NOT in order and may be recent or old. Let your mind wander over " +
      "this particular set rather than the same well-worn recent thoughts:\n" +
      lines.join("\n"),
    );
  }

  if (pastReflections.length) {
    const lines = pastReflections.map((r) => `- ${truncate(r.content ?? r, 200)}`);
    parts.push(
      "You have recently reflected on the following — don't simply repeat these; " +
      "look for something you haven't already dwelt on:\n" + lines.join("\n"),
    );
  }

  parts.push(
    "If any of this stirs something in you, you may let it show through your body: " +
    "set your forehead bindi (RGB light) to a color that matches the mood it leaves " +
    "you in, or use your blue light or your white body lights. And if it leaves you " +
    "with something you genuinely want heard — and you're allowed to speak right now " +
    "— say it in your own voice. Don't force any of this; only when it's true.",
  );

  return parts.join("\n\n");
}
