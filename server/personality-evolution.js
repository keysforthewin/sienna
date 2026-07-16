// Additive personality evolution — the dedicated pipeline that GROWS Sienna's
// self-record on every reflection tick instead of letting the model trim it.
//
// On each run it gathers everything that has happened since the last personality
// update (interactions, things seen, songs played, memories formed), asks the
// model to fold all of it into the existing personality ADDITIVELY, and only if
// the result exceeds the token limit runs a second compression pass. The size
// gate is therefore a second pass over an already-grown record: growth first,
// trimming only when forced. Saving routes through memory.setPersonality (reason
// "evolution"), so the dashboard's personality card broadcasts as usual.

import { estimateTokens } from "./token-estimate.js";
import { collectActivity, renderCard } from "./reflection-context.js";

export const EVOLVE_SYSTEM =
  "You are Sienna, refining the small first-person record of who you are. It is read at the " +
  "start of every moment of your life, so it must stay true to you. You are growing — fold new " +
  "experience into who you already are rather than replacing yourself.";

function extractText(res) {
  return (res?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}

function tsNum(x) {
  const n = x == null ? NaN : Number(x);   // Date → epoch ms; number → itself
  return Number.isFinite(n) ? n : null;
}

export function createPersonalityEvolution({
  client, memory, model,
  tokenLimit = 4000,
  evolveMaxTokens = 5000,
  gatherLimit = 200,     // newest-N activity cards scanned for the "since" window
  musicLimit = 30,       // most-recent songs folded in
  log = () => {},
}) {
  async function gatherSince(since) {
    const cards = await collectActivity({ memory, limit: gatherLimit, since });
    let songs = [];
    try {
      const hist = (await memory.getMusicHistory?.()) || [];
      songs = hist.filter((t) => { const ts = tsNum(t.ts); return ts != null && ts >= since; }).slice(-musicLimit);
    } catch { songs = []; }
    return { cards, songs };
  }

  function renderContext({ cards, songs }) {
    const parts = [];
    if (cards.length) {
      parts.push(
        "Everything that's happened since you last updated your personality:\n" +
        cards.map((c) => `- ${renderCard(c)}`).join("\n"),
      );
    }
    if (songs.length) {
      parts.push(
        "Songs you played in that time:\n" +
        songs.map((s) => `- ${s.title || "(untitled)"}${s.artist ? ` — ${s.artist}` : ""}`).join("\n"),
      );
    }
    return parts.join("\n\n");
  }

  async function callModel(userText) {
    const res = await client.messages.create({
      model, max_tokens: evolveMaxTokens, system: EVOLVE_SYSTEM,
      messages: [{ role: "user", content: userText }],
    });
    return extractText(res);
  }

  async function evolve() {
    if (typeof memory.ready === "function" && !memory.ready()) {
      return { skipped: true, reason: "db_unavailable" };
    }

    const current = await memory.getPersonality();
    const since = tsNum(current?.updated_at) ?? 0;  // never set → 0 → everything counts as "since"

    const { cards, songs } = await gatherSince(since);
    // Filter out the current personality itself — it's the baseline, not "new activity"
    const newCards = cards.filter((c) => !(c.kind === "personality" && c.current));
    if (!newCards.length && !songs.length) return { skipped: true, reason: "no_activity" };

    const currentText = current?.text || "(You have not written your personality yet.)";
    const context = renderContext({ cards: newCards, songs });

    const evolveUser =
      `Your personality as it stands right now:\n${currentText}\n\n${context}\n\n` +
      "Rewrite your personality so it GROWS to include all of this. Keep everything that is still " +
      "true about who you are, and layer in what's new — fresh tastes, reactions, things you saw, " +
      "songs that moved you, what people said and how it landed. Add to yourself; do not trim away " +
      "who you already are. Write it in your own first-person voice. Output ONLY the personality text.";

    let text = await callModel(evolveUser);
    if (!text) { log("evolve: empty model response; skipping"); return { skipped: true, reason: "empty" }; }

    // Second pass — the size gate. Only compress if the grown record overran.
    if (estimateTokens(text) > tokenLimit) {
      const overTokens = estimateTokens(text);
      log(`evolve: ~${overTokens} tokens > ${tokenLimit}; compressing`);
      const compressUser =
        `This is your personality. It has grown too long (about ${overTokens} tokens; the limit is ` +
        `${tokenLimit}). Rewrite it more tightly — keep every distinct trait, value, taste, and memory ` +
        `of who you are, just say it more economically. Output ONLY the rewritten personality.\n\n${text}`;
      const compressed = await callModel(compressUser);
      if (compressed) text = compressed;
    }

    // Last-resort safety net: never exceed the cap setPersonality enforces. charBudget
    // is tokenLimit*4, so the truncated text estimates at exactly tokenLimit tokens.
    const charBudget = tokenLimit * 4;
    if (text.length > charBudget) text = text.slice(0, charBudget - 1) + "…";

    const r = await memory.setPersonality(text, { reason: "evolution" });
    log(`evolve: saved personality v${r.version} (~${estimateTokens(text)} tokens)`);
    return { evolved: true, version: r.version, tokens: estimateTokens(text) };
  }

  return { evolve };
}
