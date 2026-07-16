// Normalizers that turn raw Mongo docs into the flat "card" shape the dashboard's
// Sienna tabs render. Pure (no deps) so it's shared by the REST endpoints
// (http.js) and the live broadcast seam (index.js / agent.js) and unit-tested in
// isolation.

// Coerce any timestamp representation to epoch-ms (a number) or null.
function toMs(v) {
  if (v == null) return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") { const n = Date.parse(v); return Number.isFinite(n) ? n : null; }
  return null;
}

// kind: "message" | "memory" | "personality". For personality, _id === "current"
// is the live record (ts from updated_at); anything else is a history snapshot
// (ts from replaced_at, carrying the reason it was superseded).
export function toCard(kind, doc) {
  const id = String(doc._id ?? "");
  if (kind === "message") {
    return {
      kind, id, ts: toMs(doc.ts),
      role: doc.role,
      content: doc.content ?? "",
      source: doc.source ?? null,
      spoken: doc.spoken ?? null,
    };
  }
  if (kind === "memory") {
    return {
      kind, id, ts: toMs(doc.ts),
      content: doc.text ?? "",
      tags: Array.isArray(doc.tags) ? doc.tags : [],
      source: doc.source ?? null,
    };
  }
  if (kind === "personality") {
    const current = doc._id === "current";
    return {
      kind, id, ts: toMs(current ? doc.updated_at : doc.replaced_at),
      content: doc.text ?? "",
      version: doc.version ?? null,
      reason: doc.reason ?? null,
      char_count: doc.char_count ?? null,
      current,
    };
  }
  if (kind === "tool") {
    // Card id is keyed on the agent's tool-use id (not the Mongo _id) so this
    // persisted card and the live ephemeral one (sienna.js builds `tool-<id>`)
    // dedupe across the live/REST seam. Input is rendered compactly, like the
    // live path (full JSON); the full result summary rides alongside.
    const input = doc.input;
    const content = input && typeof input === "object" && Object.keys(input).length
      ? JSON.stringify(input)
      : "";
    return {
      kind, id: `tool-${doc.tool_id ?? doc._id ?? ""}`,
      ts: toMs(doc.ts),
      name: doc.name ?? "",
      content,
      summary: doc.summary ?? "",
      is_error: !!doc.is_error,
      source: doc.source ?? null,
    };
  }
  if (kind === "image") {
    // Bytes live on disk; the card carries the filename so the browser builds the
    // JPEG URL (/api/sienna/images/<filename>?token=…) for an inline <img>.
    return {
      kind, id, ts: toMs(doc.ts),
      filename: doc.filename ?? null,
      source: doc.source ?? null,
    };
  }
  return { kind, id, ts: toMs(doc.ts), content: doc.content ?? "" };
}

// Merge per-kind card arrays into one newest-first timeline. Ties on ts are
// broken by id descending so ordering is stable across re-fetches (and so the
// fake-db insertion order in tests is deterministic). null ts sorts last.
export function mergeActivity(cardArrays, limit = Infinity) {
  const all = cardArrays.flat();
  all.sort((a, b) => {
    const at = a.ts ?? -Infinity, bt = b.ts ?? -Infinity;
    if (at !== bt) return bt - at;
    if (a.id < b.id) return 1;
    if (a.id > b.id) return -1;
    return 0;
  });
  return Number.isFinite(limit) ? all.slice(0, limit) : all;
}
