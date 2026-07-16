// Sienna's persistence layer — the only thing the agent touches for memory.
//
// A thin repository over db.js so the agent/tools can be tested with an in-memory
// fake. Three concerns:
//   - personality: a single small, self-authored record prepended to every prompt
//     (capped; prior versions snapshotted to personality_history for recovery).
//   - messages: every conversation turn (full memory), keyword-searchable.
//   - memories: distilled facts Sienna chose to keep (via the `remember` tool).
// Recall is keyword/text search (Mongo $text); recallRelevant() is kept separate
// from searchMemory() so automatic recall and the explicit tool can diverge (and
// so a future embedding path can slot in behind recallRelevant without churn).

import { estimateTokens } from "./token-estimate.js";

export class PersonalityTooLargeError extends Error {
  constructor(tokens, cap) {
    super(`personality is ~${tokens} tokens; cap is ${cap}. Trim it and try again.`);
    this.name = "PersonalityTooLargeError";
    this.tokens = tokens;
    this.cap = cap;
  }
}

export function createMemory({ db, personalityTokenCap = 2000, now = () => new Date(), onChange = () => {} }) {
  const coll = (n) => db.collection(n);

  function ready() { return db.ready(); }

  async function getPersonality() {
    const doc = await coll("personality").findOne({ _id: "current" });
    return doc ? { text: doc.text, version: doc.version, updated_at: doc.updated_at } : null;
  }

  async function setPersonality(text, { reason = "tool" } = {}) {
    if (typeof text !== "string") throw new PersonalityTooLargeError(0, personalityTokenCap);
    const tokens = estimateTokens(text);
    if (tokens > personalityTokenCap) throw new PersonalityTooLargeError(tokens, personalityTokenCap);
    const prev = await coll("personality").findOne({ _id: "current" });
    const version = (prev?.version || 0) + 1;
    if (prev) {
      await coll("personality_history").insertOne({
        version: prev.version, text: prev.text, replaced_at: now(), reason,
      });
    }
    const doc = { _id: "current", text, version, updated_at: now(), char_count: text.length };
    await coll("personality").replaceOne({ _id: "current" }, doc, { upsert: true });
    onChange({ kind: "personality", doc });
    return { version };
  }

  // NB: appendMessage deliberately does NOT fire onChange — message cards are
  // emitted from the agent (1:1 with a turn) so we don't double-render the text
  // the agent already streams, nor card each intermediate per-tool-round persist.
  async function appendMessage(turn) {
    const res = await coll("messages").insertOne({ ts: now(), ...turn });
    return { id: res.insertedId };
  }

  // Newest n turns, returned in chronological order for the prompt transcript.
  async function recentMessages(n = 12) {
    const docs = await coll("messages").find({}).sort({ ts: -1 }).limit(n).toArray();
    return docs.reverse();
  }

  // Newest-first raw docs for the dashboard card views (distinct from
  // recentMessages, which returns ascending for the prompt transcript).
  async function listRecentMessages(n = 100) {
    return coll("messages").find({}).sort({ ts: -1 }).limit(n).toArray();
  }

  // Her recent reflection conclusions: newest-first assistant turns from past
  // reflection ticks. Feeds the reflection prompt a "you already reflected on
  // these" list so she reaches for something new instead of repeating herself.
  async function recentReflections(n = 5) {
    return coll("messages")
      .find({ role: "assistant", source: "reflection" })
      .sort({ ts: -1 }).limit(n).toArray();
  }

  // Tool-call audit log. appendToolCall records one completed invocation (name +
  // input + result summary + error flag), keyed by the agent's tool-use id so the
  // dashboard's live ephemeral card and this persisted record share a card id (no
  // double-render across the live/REST seam). Like appendMessage it does NOT fire
  // onChange — the live card comes from the agent's agent_tool/agent_tool_result.
  async function appendToolCall(call) {
    const res = await coll("tool_calls").insertOne({ ts: now(), ...call });
    return { id: res.insertedId };
  }

  // Newest-first tool calls for the dashboard's Tool Calls tab + Activity merge.
  async function recentToolCalls(n = 100) {
    return coll("tool_calls").find({}).sort({ ts: -1 }).limit(n).toArray();
  }

  // Camera image index. One doc per JPEG the device sent (look tool OR manual
  // snapshot); the bytes live on disk (images.js) — this records the filename +
  // capture time + source so the dashboard's Images tab + Activity merge can list
  // them newest-first. Like appendMessage/appendToolCall it does NOT fire onChange:
  // the capture site (index.js) broadcasts the sienna_entry itself.
  async function appendImage(img) {
    const res = await coll("images").insertOne({ ts: now(), ...img });
    return { id: res.insertedId };
  }

  async function recentImages(n = 100) {
    return coll("images").find({}).sort({ ts: -1 }).limit(n).toArray();
  }

  // Bound on-disk growth: drop image docs beyond the newest `keep` and return the
  // evicted filenames so the caller (index.js) can unlink the files. Mongo is the
  // source of truth for what's kept; the files follow.
  async function pruneImages(keep) {
    const stale = await coll("images").find({}).sort({ ts: -1 }).skip(Math.max(0, keep)).toArray();
    for (const doc of stale) await coll("images").deleteOne({ _id: doc._id });
    return stale.map((d) => d.filename).filter(Boolean);
  }

  // Token-usage audit log: one doc per LLM call (token counts + the cost computed
  // at the rate in effect then). The Usage view buckets these by time client-side.
  async function recordUsage(doc) {
    const res = await coll("usage").insertOne({ ts: now(), ...doc });
    return { id: res.insertedId };
  }

  // Newest-first usage records for the Usage view's time-bucket aggregation. The
  // limit (capped by the caller) bounds the scan; the ts:-1 index keeps it cheap.
  async function recentUsage(n = 5000) {
    return coll("usage").find({}).sort({ ts: -1 }).limit(n).toArray();
  }

  async function recentMemories(n = 100) {
    return coll("memories").find({}).sort({ ts: -1 }).limit(n).toArray();
  }

  // The current personality (if any) followed by prior versions, newest first.
  async function listPersonalityVersions(n = 100) {
    const current = await coll("personality").findOne({ _id: "current" });
    const history = await coll("personality_history").find({}).sort({ version: -1 }).limit(n).toArray();
    return current ? [current, ...history] : history;
  }

  async function searchMemory(query, limit = 5) {
    if (!query || !String(query).trim()) return [];
    const docs = await coll("memories")
      .find({ $text: { $search: String(query) } }, { projection: { score: { $meta: "textScore" } } })
      .sort({ score: { $meta: "textScore" } })
      .limit(limit)
      .toArray();
    return docs.map((d) => ({ text: d.text, tags: d.tags || [], ts: d.ts, score: d.score }));
  }

  // Auto-recall for prompt context. Keyword for now; intentionally a distinct
  // entry point so it can grow its own ranking later.
  async function recallRelevant(inputText, limit = 3) {
    if (!inputText || !String(inputText).trim()) return [];
    return searchMemory(inputText, limit);
  }

  // Small key/value settings store for server-side UI state that must survive a
  // restart (e.g. the autonomy toggle, the master volume). Singleton docs keyed
  // by `_id`, mirroring the personality `_id:"current"` pattern. Generic on
  // purpose; "autonomy" and "volume" use it today.
  async function getSetting(key, fallback = undefined) {
    const doc = await coll("settings").findOne({ _id: key });
    return doc ? doc.value : fallback;
  }

  async function setSetting(key, value) {
    await coll("settings").replaceOne(
      { _id: key }, { _id: key, value, updated_at: now() }, { upsert: true },
    );
  }

  // Music search-result cache (jukebox warm start). Singleton docs keyed by a
  // normalized query (`_id`), mirroring the settings/personality `_id` pattern.
  // The jukebox stores a search's ~50 results so a repeat "play X" can start from
  // a stored track instantly instead of waiting on a fresh YouTube search.
  async function getMusicCache(key) {
    const doc = await coll("music_cache").findOne({ _id: key });
    return doc && Array.isArray(doc.tracks) ? doc.tracks : null;
  }

  async function setMusicCache(key, tracks) {
    await coll("music_cache").replaceOne(
      { _id: key },
      { _id: key, tracks: Array.isArray(tracks) ? tracks : [], updated_at: now() },
      { upsert: true },
    );
  }

  // Jukebox play history (the no-repeat window): a single capped list of the most
  // recently played tracks, singleton doc keyed `_id:"played"` like settings/
  // personality. The jukebox owns the capping/dedupe; this is dumb storage.
  async function getMusicHistory() {
    const doc = await coll("music_history").findOne({ _id: "played" });
    return doc && Array.isArray(doc.tracks) ? doc.tracks : null;
  }

  async function setMusicHistory(tracks) {
    await coll("music_history").replaceOne(
      { _id: "played" },
      { _id: "played", tracks: Array.isArray(tracks) ? tracks : [], updated_at: now() },
      { upsert: true },
    );
  }

  // Jukebox live-session checkpoint (restart resume): the query + full queue +
  // position of the mix that's playing right now, singleton doc keyed
  // `_id:"current"` like the play history. Written on every track start, cleared
  // (session:null) when the music stops; jukebox.restoreSession reads it at boot.
  async function getMusicSession() {
    const doc = await coll("music_session").findOne({ _id: "current" });
    return doc?.session ?? null;
  }

  async function setMusicSession(session) {
    await coll("music_session").replaceOne(
      { _id: "current" },
      { _id: "current", session: session ?? null, updated_at: now() },
      { upsert: true },
    );
  }

  async function remember(fact) {
    const doc = {
      text: fact.text,
      tags: Array.isArray(fact.tags) ? fact.tags : [],
      ts: now(),
      source: fact.source || "remember",
    };
    const res = await coll("memories").insertOne(doc);
    onChange({ kind: "memory", doc: { ...doc, _id: res.insertedId } });
    return { id: res.insertedId };
  }

  return {
    ready, getPersonality, setPersonality, appendMessage,
    recentMessages, listRecentMessages, recentReflections, recentMemories, listPersonalityVersions,
    appendToolCall, recentToolCalls,
    appendImage, recentImages, pruneImages,
    recordUsage, recentUsage,
    searchMemory, recallRelevant, remember,
    getSetting, setSetting,
    getMusicCache, setMusicCache,
    getMusicHistory, setMusicHistory,
    getMusicSession, setMusicSession,
  };
}
