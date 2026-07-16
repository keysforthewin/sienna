// Related-query brainstorming for the jukebox's dry-pool escalation: when every
// track findable for a query is already in the no-repeat window, the mix needs
// NEW searches, not the same one again. This asks the LLM (the shared Gemini
// client from gemini.js — Anthropic-shaped messages.create, same as enhance.js)
// for ~10 alternative YouTube Music queries in the same spirit: related artists,
// sub-genres, adjacent vibes. The jukebox shuffles them and tries each until one
// surfaces a song it hasn't played; if this call fails or returns garbage, the
// jukebox falls back to its static "<q> songs"-style suffixes, so music never
// stalls on a model hiccup.

const promptFor = (count) => `You suggest alternative YouTube Music search queries.

Given a music request, produce ${count} DIFFERENT search queries that would surface related music the listener would also enjoy: related artists, sub-genres, adjacent vibes and moods, notable albums or eras. Stay close to the spirit of the original request — these queries feed the same listening session.

Rules:
- Each query must be short (2–6 words) and work well as a YouTube Music search.
- No two queries may be near-duplicates of each other or of the original request.
- Return ONLY a JSON array of ${count} strings. No prose, no explanation, no markdown fence.`;

// Tolerant extraction: the model is told "JSON array only", but strip fences and
// surrounding prose anyway. Returns [] when nothing parseable is found.
export function parseQueries(text, { count, exclude = "" } = {}) {
  const s = String(text || "");
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  let arr;
  try { arr = JSON.parse(s.slice(start, end + 1)); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const norm = (q) => String(q).replace(/\s+/g, " ").trim().toLowerCase();
  const seen = new Set([norm(exclude)]);
  const out = [];
  for (const q of arr) {
    if (typeof q !== "string") continue;
    const trimmed = q.replace(/\s+/g, " ").trim();
    if (!trimmed || seen.has(norm(trimmed))) continue;
    seen.add(norm(trimmed));
    out.push(trimmed);
    if (count && out.length >= count) break;
  }
  return out;
}

// Returns an async (query) => string[] suitable as the jukebox's `queryVariants`.
// Client/network errors propagate (the jukebox catches and falls back); an
// unparseable reply returns [] (same fallback).
export function createMusicSuggester({ client, count = 10, log = () => {} }) {
  if (!client) throw new Error("createMusicSuggester: client is required");
  return async function relatedQueries(query) {
    const res = await client.messages.create({
      max_tokens: 1024,
      system: promptFor(count),
      messages: [{ role: "user", content: String(query) }],
    });
    const block = (res.content || []).find((b) => b.type === "text");
    const queries = parseQueries(block?.text, { count, exclude: query });
    log(`related queries for "${query}" → ${queries.length ? queries.join(" | ") : "(unparseable reply)"}`);
    return queries;
  };
}
