import { test } from "node:test";
import assert from "node:assert/strict";
import { createDb } from "./db.js";

function makeFakeMongo({ failConnect = false } = {}) {
  const indexes = [];
  const collections = new Map();
  const coll = (name) => {
    if (!collections.has(name)) {
      collections.set(name, {
        name,
        createIndex: async (spec) => { indexes.push({ name, spec }); },
      });
    }
    return collections.get(name);
  };
  let closed = false;
  let dbArg;
  const client = {
    connected: false,
    async connect() {
      if (failConnect) throw new Error("ECONNREFUSED");
      this.connected = true;
    },
    db(name) { dbArg = name; return { collection: coll }; },
    async close() { closed = true; },
  };
  return {
    factory: () => client,
    client,
    indexes,
    wasClosed: () => closed,
    dbArg: () => dbArg,
  };
}

test("connect resolves true and ready() flips on success", async () => {
  const m = makeFakeMongo();
  const db = createDb({ uri: "mongodb://x/sienna", dbName: "sienna", clientFactory: m.factory });
  assert.equal(db.ready(), false);
  assert.equal(await db.connect(), true);
  assert.equal(db.ready(), true);
  assert.equal(m.dbArg(), "sienna");
});

test("connect is idempotent — one underlying connect for concurrent callers", async () => {
  let calls = 0;
  const m = makeFakeMongo();
  const orig = m.client.connect.bind(m.client);
  m.client.connect = async function () { calls += 1; return orig(); };
  const db = createDb({ uri: "mongodb://x/sienna", clientFactory: m.factory });
  await Promise.all([db.connect(), db.connect(), db.connect()]);
  assert.equal(calls, 1);
});

test("connect failure degrades: resolves false, ready() stays false, no throw", async () => {
  const m = makeFakeMongo({ failConnect: true });
  const db = createDb({ uri: "mongodb://x/sienna", clientFactory: m.factory });
  assert.equal(await db.connect(), false);
  assert.equal(db.ready(), false);
  assert.throws(() => db.collection("messages"), /not connected/);
});

test("ensureIndexes creates text + supporting indexes", async () => {
  const m = makeFakeMongo();
  const db = createDb({ uri: "mongodb://x/sienna", clientFactory: m.factory });
  await db.connect();
  await db.ensureIndexes();
  const has = (name, spec) =>
    m.indexes.some((i) => i.name === name && JSON.stringify(i.spec) === JSON.stringify(spec));
  assert.ok(has("messages", { content: "text" }));
  assert.ok(has("memories", { text: "text" }));
  assert.ok(has("personality_history", { version: -1 }));
});

test("ensureIndexes is a no-op when not connected", async () => {
  const m = makeFakeMongo({ failConnect: true });
  const db = createDb({ uri: "mongodb://x/sienna", clientFactory: m.factory });
  await db.connect();
  await db.ensureIndexes(); // must not throw
  assert.equal(m.indexes.length, 0);
});

test("close tears down and resets state", async () => {
  const m = makeFakeMongo();
  const db = createDb({ uri: "mongodb://x/sienna", clientFactory: m.factory });
  await db.connect();
  await db.close();
  assert.equal(m.wasClosed(), true);
  assert.equal(db.ready(), false);
});
