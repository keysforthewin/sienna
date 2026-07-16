// MongoDB connection for the Sienna agent's persistence (personality + memory).
//
// Lazy, idempotent connect that degrades gracefully: if the server can't reach
// Mongo, connect() resolves false and ready() stays false rather than throwing,
// so the agent simply reports unavailable and the rest of the dashboard keeps
// working (mirrors the 503-degrade of the tts/enhance features). The driver is
// the only hard dependency added; injection of clientFactory keeps it testable.

import { MongoClient } from "mongodb";

export function createDb({ uri, dbName, clientFactory = (u) => new MongoClient(u) }) {
  if (!uri) throw new Error("createDb: uri is required");

  let client = null;
  let db = null;
  let connectPromise = null;
  let connected = false;

  // Idempotent: concurrent/repeat callers share the one in-flight attempt.
  function connect() {
    if (connectPromise) return connectPromise;
    connectPromise = (async () => {
      try {
        client = clientFactory(uri);
        await client.connect();
        db = client.db(dbName); // undefined dbName ⇒ driver uses the URI's db
        connected = true;
        return true;
      } catch (e) {
        console.warn(`[sienna] mongo connect failed: ${e.message} — agent disabled`);
        connected = false;
        connectPromise = null; // allow a later retry
        return false;
      }
    })();
    return connectPromise;
  }

  function collection(name) {
    if (!connected || !db) throw new Error("db not connected");
    return db.collection(name);
  }

  // Text indexes power keyword recall (Mongo $text). Safe to call repeatedly.
  async function ensureIndexes() {
    if (!connected) return;
    await collection("messages").createIndex({ content: "text" });
    await collection("messages").createIndex({ ts: -1 });
    await collection("memories").createIndex({ text: "text" });
    await collection("memories").createIndex({ tags: 1 });
    await collection("memories").createIndex({ ts: -1 });
    await collection("personality_history").createIndex({ version: -1 });
    // tool_calls: the auditable history of every tool the agent invoked. Newest-first
    // card reads + time-bucketed aggregation both lean on ts.
    await collection("tool_calls").createIndex({ ts: -1 });
    await collection("tool_calls").createIndex({ name: 1, ts: -1 });
    // usage: one doc per LLM call (token counts + cost). The Usage view reads the
    // newest N by ts and buckets them by time.
    await collection("usage").createIndex({ ts: -1 });
    // images: one doc per camera snapshot (filename + source); bytes live on disk.
    // Newest-first card reads + pruning both lean on ts.
    await collection("images").createIndex({ ts: -1 });
  }

  async function close() {
    if (client) { try { await client.close(); } catch { /* already closed */ } }
    client = null; db = null; connected = false; connectPromise = null;
  }

  return { connect, collection, ensureIndexes, close, ready: () => connected };
}
