import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemory, PersonalityTooLargeError } from "./memory.js";

// In-memory fake of the db.js surface (collection() returning a minimal Mongo
// collection). Supports the exact operations memory.js uses.
function makeFakeDb({ connected = true } = {}) {
  const store = new Map();
  const docs = (n) => { if (!store.has(n)) store.set(n, []); return store.get(n); };

  function makeCursor(list) {
    let arr = list.slice();
    return {
      sort(spec) {
        const key = Object.keys(spec)[0];
        const dir = key === "score" ? -1 : spec[key];
        arr.sort((a, b) => {
          const av = key === "score" ? a.score || 0 : a[key];
          const bv = key === "score" ? b.score || 0 : b[key];
          if (av < bv) return dir === 1 ? -1 : 1;
          if (av > bv) return dir === 1 ? 1 : -1;
          return 0;
        });
        return this;
      },
      skip(n) { arr = arr.slice(Math.max(0, n)); return this; },
      limit(n) { arr = arr.slice(0, n); return this; },
      async toArray() { return arr; },
    };
  }

  const collection = (name) => ({
    async findOne(filter) {
      return docs(name).find((d) => d._id === filter._id) || null;
    },
    async insertOne(doc) {
      const _id = doc._id ?? `id${docs(name).length + 1}`;
      docs(name).push({ ...doc, _id });
      return { insertedId: _id };
    },
    async replaceOne(filter, doc) {
      const list = docs(name);
      const i = list.findIndex((d) => d._id === filter._id);
      if (i >= 0) list[i] = doc; else list.push(doc);
      return { acknowledged: true };
    },
    async deleteOne(filter) {
      const list = docs(name);
      const i = list.findIndex((d) => d._id === filter._id);
      if (i >= 0) { list.splice(i, 1); return { deletedCount: 1 }; }
      return { deletedCount: 0 };
    },
    find(filter, options) {
      let list = docs(name);
      if (filter && filter.$text) {
        const terms = String(filter.$text.$search).toLowerCase().split(/\s+/).filter(Boolean);
        list = list
          .map((d) => {
            const hay = String(d.text || "").toLowerCase();
            const score = terms.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0);
            return { ...d, score };
          })
          .filter((d) => d.score > 0);
      } else if (filter) {
        // Plain equality match on top-level fields (e.g. {role, source}).
        const keys = Object.keys(filter);
        if (keys.length) list = list.filter((d) => keys.every((k) => d[k] === filter[k]));
      }
      return makeCursor(list);
    },
  });

  return { collection, ready: () => connected, _store: store };
}

test("ready() reflects the db", () => {
  assert.equal(createMemory({ db: makeFakeDb({ connected: false }) }).ready(), false);
  assert.equal(createMemory({ db: makeFakeDb({ connected: true }) }).ready(), true);
});

test("getPersonality returns null before any is written", async () => {
  const m = createMemory({ db: makeFakeDb() });
  assert.equal(await m.getPersonality(), null);
});

test("music cache: set then get round-trips; missing key is null", async () => {
  const m = createMemory({ db: makeFakeDb() });
  assert.equal(await m.getMusicCache("indian music"), null);
  const tracks = [{ id: "a", title: "A", url: "u" }, { id: "b", title: "B", url: "v" }];
  await m.setMusicCache("indian music", tracks);
  assert.deepEqual(await m.getMusicCache("indian music"), tracks);
});

test("music cache: setMusicCache upserts (overwrites) and coerces non-arrays to []", async () => {
  const m = createMemory({ db: makeFakeDb() });
  await m.setMusicCache("k", [{ id: "a" }]);
  await m.setMusicCache("k", [{ id: "b" }, { id: "c" }]);
  assert.deepEqual((await m.getMusicCache("k")).map((t) => t.id), ["b", "c"]);
  await m.setMusicCache("k2", null);
  assert.deepEqual(await m.getMusicCache("k2"), []); // stored as an array, never null/garbage
});

test("music history: set then get round-trips; empty store is null", async () => {
  const m = createMemory({ db: makeFakeDb() });
  assert.equal(await m.getMusicHistory(), null);
  const tracks = [{ id: "a", title: "A", artist: null, ts: 1 }, { id: "b", title: "B", artist: "X", ts: 2 }];
  await m.setMusicHistory(tracks);
  assert.deepEqual(await m.getMusicHistory(), tracks);
});

test("music history: setMusicHistory overwrites and coerces non-arrays to []", async () => {
  const m = createMemory({ db: makeFakeDb() });
  await m.setMusicHistory([{ id: "a" }]);
  await m.setMusicHistory([{ id: "b" }]);
  assert.deepEqual((await m.getMusicHistory()).map((t) => t.id), ["b"]);
  await m.setMusicHistory(null);
  assert.deepEqual(await m.getMusicHistory(), []);
});

test("setPersonality versions, caps history, and bumps version", async () => {
  const db = makeFakeDb();
  const m = createMemory({ db, personalityTokenCap: 100, now: () => new Date("2026-01-01") });
  const r1 = await m.setPersonality("v1 text", { reason: "tool" });
  assert.equal(r1.version, 1);
  const r2 = await m.setPersonality("v2 text", { reason: "reflection" });
  assert.equal(r2.version, 2);
  const cur = await m.getPersonality();
  assert.deepEqual(cur, { text: "v2 text", version: 2, updated_at: new Date("2026-01-01") });
  // prior version snapshotted to history
  assert.equal(db._store.get("personality_history").length, 1);
  assert.equal(db._store.get("personality_history")[0].text, "v1 text");
});

test("setPersonality rejects over-cap text by TOKEN estimate (no silent truncation)", async () => {
  // cap = 10 tokens ≈ 40 chars; 44 chars → 11 tokens → over.
  const m = createMemory({ db: makeFakeDb(), personalityTokenCap: 10 });
  await assert.rejects(() => m.setPersonality("x".repeat(44)), (e) => {
    assert.ok(e instanceof PersonalityTooLargeError);
    assert.equal(e.tokens, 11);
    assert.equal(e.cap, 10);
    return true;
  });
});

test("setPersonality accepts text at/under the token cap", async () => {
  const m = createMemory({ db: makeFakeDb(), personalityTokenCap: 10 });
  const r = await m.setPersonality("x".repeat(40)); // 40/4 = 10 tokens, not over
  assert.equal(r.version, 1);
});

test("getPersonality returns text, version, and updated_at", async () => {
  const m = createMemory({ db: makeFakeDb(), personalityTokenCap: 100, now: () => new Date("2026-01-01") });
  await m.setPersonality("v1 text", { reason: "tool" });
  assert.deepEqual(await m.getPersonality(), { text: "v1 text", version: 1, updated_at: new Date("2026-01-01") });
});

test("appendMessage + recentMessages returns newest n in chronological order", async () => {
  const db = makeFakeDb();
  let t = 0;
  const m = createMemory({ db, now: () => t });
  for (const c of ["a", "b", "c", "d"]) { t += 1; await m.appendMessage({ role: "user", content: c, source: "text" }); }
  const recent = await m.recentMessages(2);
  assert.deepEqual(recent.map((x) => x.content), ["c", "d"]);
});

test("appendMessage returns the inserted id", async () => {
  const m = createMemory({ db: makeFakeDb() });
  const r = await m.appendMessage({ role: "user", content: "hi", source: "text" });
  assert.ok(r && r.id);
});

test("appendMessage does NOT fire onChange (messages emit from the agent, not here)", async () => {
  let calls = 0;
  const m = createMemory({ db: makeFakeDb(), onChange: () => { calls += 1; } });
  await m.appendMessage({ role: "user", content: "hi", source: "text" });
  assert.equal(calls, 0);
});

test("listRecentMessages returns newest n FIRST (descending)", async () => {
  const db = makeFakeDb();
  let t = 0;
  const m = createMemory({ db, now: () => t });
  for (const c of ["a", "b", "c", "d"]) { t += 1; await m.appendMessage({ role: "user", content: c, source: "text" }); }
  const recent = await m.listRecentMessages(2);
  assert.deepEqual(recent.map((x) => x.content), ["d", "c"]);
});

test("recentMemories returns newest n FIRST (descending)", async () => {
  const db = makeFakeDb();
  let t = 0;
  const m = createMemory({ db, now: () => t });
  for (const c of ["one", "two", "three"]) { t += 1; await m.remember({ text: c }); }
  const recent = await m.recentMemories(2);
  assert.deepEqual(recent.map((x) => x.text), ["three", "two"]);
});

test("appendToolCall + recentToolCalls returns newest n FIRST, stamps ts, no onChange", async () => {
  const events = [];
  const db = makeFakeDb();
  let t = 0;
  const m = createMemory({ db, now: () => t, onChange: (e) => events.push(e) });
  for (const n of ["look", "set_rgb", "speak"]) {
    t += 1;
    await m.appendToolCall({ tool_id: `tu_${n}`, name: n, input: {}, source: "ptt", summary: "ok", is_error: false });
  }
  const recent = await m.recentToolCalls(2);
  assert.deepEqual(recent.map((x) => x.name), ["speak", "set_rgb"]);
  assert.equal(recent[0].ts, 3);               // ts stamped from the injected clock
  assert.equal(events.length, 0);              // like appendMessage, never fires onChange
});

test("recordUsage + recentUsage returns newest n FIRST, stamps ts", async () => {
  const db = makeFakeDb();
  let t = 0;
  const m = createMemory({ db, now: () => t });
  for (const n of [10, 20, 30]) {
    t += 1;
    await m.recordUsage({ model: "gemini-2.5-flash", input_total: n, output: 1, total: n + 1, cost: 0.001 * n });
  }
  const recent = await m.recentUsage(2);
  assert.deepEqual(recent.map((x) => x.input_total), [30, 20]);
  assert.equal(recent[0].ts, 3);
});

test("remember fires onChange once with kind:memory and the full doc", async () => {
  const events = [];
  const m = createMemory({ db: makeFakeDb(), onChange: (e) => events.push(e) });
  await m.remember({ text: "steve likes coffee", tags: ["coffee"], source: "remember" });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "memory");
  assert.equal(events[0].doc.text, "steve likes coffee");
  assert.ok(events[0].doc._id, "doc carries the inserted id");
  assert.deepEqual(events[0].doc.tags, ["coffee"]);
});

test("listPersonalityVersions returns current then history, newest version first", async () => {
  const db = makeFakeDb();
  const m = createMemory({ db, personalityTokenCap: 100, now: () => new Date("2026-01-01") });
  await m.setPersonality("v1 text", { reason: "tool" });
  await m.setPersonality("v2 text", { reason: "reflection" });
  await m.setPersonality("v3 text", { reason: "tool" });
  const versions = await m.listPersonalityVersions(10);
  assert.deepEqual(versions.map((v) => v.version), [3, 2, 1]);
  // current is the _id:"current" doc; the rest are history snapshots
  assert.equal(versions[0]._id, "current");
  assert.equal(versions[0].text, "v3 text");
  assert.equal(versions[1].text, "v2 text");
  // a history entry's `reason` is why it was SUPERSEDED: v2 was replaced by the
  // v3 "tool" call; the v1 snapshot was replaced by the v2 "reflection" call.
  assert.equal(versions[1].reason, "tool");
  assert.equal(versions[2].reason, "reflection");
});

test("listPersonalityVersions returns [] when none set", async () => {
  const m = createMemory({ db: makeFakeDb() });
  assert.deepEqual(await m.listPersonalityVersions(10), []);
});

test("setPersonality fires onChange once with kind:personality and the new doc", async () => {
  const events = [];
  const m = createMemory({ db: makeFakeDb(), personalityTokenCap: 100, now: () => new Date("2026-02-02"), onChange: (e) => events.push(e) });
  await m.setPersonality("hello", { reason: "tool" });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "personality");
  assert.equal(events[0].doc.version, 1);
  assert.equal(events[0].doc.text, "hello");
  assert.equal(events[0].doc._id, "current");
});

test("searchMemory runs a $text query sorted by textScore", async () => {
  const db = makeFakeDb();
  const m = createMemory({ db });
  await m.remember({ text: "steve likes coffee in the morning" });
  await m.remember({ text: "bharati enjoys long walks" });
  await m.remember({ text: "the coffee machine is broken" });
  const hits = await m.searchMemory("coffee", 5);
  assert.equal(hits.length, 2);
  assert.ok(hits.every((h) => h.text.includes("coffee")));
});

test("recallRelevant returns [] for empty input", async () => {
  const m = createMemory({ db: makeFakeDb() });
  assert.deepEqual(await m.recallRelevant("   "), []);
});

test("remember stores tags + source and returns an id", async () => {
  const db = makeFakeDb();
  const m = createMemory({ db });
  const r = await m.remember({ text: "fact", tags: ["x"], source: "reflection" });
  assert.ok(r.id);
  const stored = db._store.get("memories")[0];
  assert.deepEqual(stored.tags, ["x"]);
  assert.equal(stored.source, "reflection");
});

test("getSetting returns the fallback when the key was never set", async () => {
  const m = createMemory({ db: makeFakeDb() });
  assert.equal(await m.getSetting("autonomy", false), false);
  assert.equal(await m.getSetting("autonomy", true), true);
});

test("setSetting then getSetting round-trips the value (ignoring the fallback)", async () => {
  const m = createMemory({ db: makeFakeDb() });
  await m.setSetting("autonomy", true);
  assert.equal(await m.getSetting("autonomy", false), true);
});

test("setSetting overwrites an existing value", async () => {
  const db = makeFakeDb();
  const m = createMemory({ db });
  await m.setSetting("autonomy", true);
  await m.setSetting("autonomy", false);
  assert.equal(await m.getSetting("autonomy", true), false);
  // stored as a single keyed singleton, not appended
  assert.equal(db._store.get("settings").length, 1);
});

test("images: appendImage stores a doc; recentImages returns newest-first", async () => {
  let t = 1000;
  const m = createMemory({ db: makeFakeDb(), now: () => t });
  t = 1000; await m.appendImage({ filename: "a.jpg", source: "camera" });
  t = 2000; await m.appendImage({ filename: "b.jpg", source: "camera" });
  t = 3000; await m.appendImage({ filename: "c.jpg", source: "camera" });
  const recent = await m.recentImages(10);
  assert.deepEqual(recent.map((d) => d.filename), ["c.jpg", "b.jpg", "a.jpg"]);
});

test("images: pruneImages keeps newest N and returns evicted filenames", async () => {
  let t = 0;
  const m = createMemory({ db: makeFakeDb(), now: () => t });
  for (const f of ["a.jpg", "b.jpg", "c.jpg", "d.jpg"]) { t += 1000; await m.appendImage({ filename: f }); }
  const evicted = await m.pruneImages(2);
  assert.deepEqual(evicted.sort(), ["a.jpg", "b.jpg"]); // oldest two dropped
  const left = await m.recentImages(10);
  assert.deepEqual(left.map((d) => d.filename), ["d.jpg", "c.jpg"]);
});

test("images: pruneImages is a no-op when under the cap", async () => {
  const m = createMemory({ db: makeFakeDb() });
  await m.appendImage({ filename: "only.jpg" });
  assert.deepEqual(await m.pruneImages(200), []);
  assert.equal((await m.recentImages(10)).length, 1);
});

test("recentReflections returns only assistant reflection turns, newest-first, capped", async () => {
  let t = 0;
  const m = createMemory({ db: makeFakeDb(), now: () => ++t });
  await m.appendMessage({ role: "user", content: "hi", source: "text" });
  await m.appendMessage({ role: "assistant", content: "first reflection", source: "reflection" });
  await m.appendMessage({ role: "assistant", content: "a spoken reply", source: "ptt" });
  await m.appendMessage({ role: "user", content: "reflection-ish input", source: "reflection" });
  await m.appendMessage({ role: "assistant", content: "second reflection", source: "reflection" });

  const out = await m.recentReflections(5);
  assert.deepEqual(out.map((d) => d.content), ["second reflection", "first reflection"]);

  const capped = await m.recentReflections(1);
  assert.deepEqual(capped.map((d) => d.content), ["second reflection"]);
});

test("music session: set/get round-trips; null clears; empty store is null", async () => {
  const m = createMemory({ db: makeFakeDb() });
  assert.equal(await m.getMusicSession(), null);
  const session = { query: "jazz", continuation: null, queue: [{ id: "a", title: "A" }], index: 0, ts: 5 };
  await m.setMusicSession(session);
  assert.deepEqual(await m.getMusicSession(), session);
  await m.setMusicSession(null);
  assert.equal(await m.getMusicSession(), null);
});
