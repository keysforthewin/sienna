import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Recorder } from "./recordings.js";
import { ImageStore } from "./images.js";
import { createApp } from "./http.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const TOKEN = "test-token-1234";

async function withServer(opts, fn) {
  const ownedDir = !opts.recorder;
  const recorder = opts.recorder || new Recorder({ dir: await fs.mkdtemp(path.join(os.tmpdir(), "sh-")), keep: 5 });
  const imageStore = opts.imageStore || new ImageStore({ dir: await fs.mkdtemp(path.join(os.tmpdir(), "sh-img-")) });
  const app = createApp({ token: TOKEN, recorder, imageStore, tts: opts.tts, audioOut: opts.audioOut, bridge: opts.bridge, enhancer: opts.enhancer, memory: opts.memory });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  try {
    await fn({ port, recorder, imageStore });
  } finally {
    // undici (fetch) keeps connections alive; force-close so server.close()
    // can't hang waiting on a pooled keep-alive socket.
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    if (ownedDir) {
      try { await fs.rm(recorder.dir, { recursive: true, force: true }); } catch {}
    }
  }
}

test("GET / serves index.html", async () => {
  await withServer({}, async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /placeholder|Sienna/);
  });
});

test("GET /healthz returns ok", async () => {
  await withServer({}, async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});

test("GET /api/token returns the token", async () => {
  await withServer({}, async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/token`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { token: TOKEN });
  });
});

test("GET /api/recordings without auth returns 401", async () => {
  await withServer({}, async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/recordings`);
    assert.equal(res.status, 401);
  });
});

test("GET /api/recordings with bad token returns 401", async () => {
  await withServer({}, async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/recordings`, {
      headers: { authorization: "Bearer wrong" },
    });
    assert.equal(res.status, 401);
  });
});

test("GET /api/recordings with valid token returns list", async () => {
  await withServer({}, async ({ port, recorder }) => {
    recorder.start();
    recorder.appendPcm(Buffer.alloc(200));
    await recorder.stop();
    const res = await fetch(`http://127.0.0.1:${port}/api/recordings`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.recordings.length, 1);
    assert.match(body.recordings[0].filename, /\.wav$/);
  });
});

test("GET /api/recordings/:filename downloads file", async () => {
  await withServer({}, async ({ port, recorder }) => {
    recorder.start();
    recorder.appendPcm(Buffer.alloc(200));
    const r = await recorder.stop();
    const res = await fetch(`http://127.0.0.1:${port}/api/recordings/${r.filename}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "audio/wav");
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.length, r.sizeBytes);
  });
});

test("DELETE /api/recordings/:filename removes the file", async () => {
  await withServer({}, async ({ port, recorder }) => {
    recorder.start();
    recorder.appendPcm(Buffer.alloc(200));
    const r = await recorder.stop();
    const res = await fetch(`http://127.0.0.1:${port}/api/recordings/${r.filename}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal((await recorder.list()).length, 0);
  });
});

test("DELETE /api/recordings/:filename — missing file 404s, bad name 400s, no auth 401s", async () => {
  await withServer({}, async ({ port }) => {
    const del = (name, auth = true) => fetch(`http://127.0.0.1:${port}/api/recordings/${name}`, {
      method: "DELETE",
      headers: auth ? { authorization: `Bearer ${TOKEN}` } : {},
    });
    assert.equal((await del("nope.wav")).status, 404);
    assert.equal((await del("..%2F..%2Fetc%2Fpasswd")).status, 400);
    assert.equal((await del("a.wav", false)).status, 401);
  });
});

test("GET /api/recordings rejects path traversal", async () => {
  await withServer({}, async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/recordings/..%2F..%2Fetc%2Fpasswd`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 400);
  });
});

// ---- POST /api/tts ----

function postJson(port, path, body, { auth = true } = {}) {
  const headers = { "content-type": "application/json" };
  if (auth) headers.authorization = `Bearer ${TOKEN}`;
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

// /api/tts now synthesizes SERVER-SIDE and streams to the device (audioOut.speak),
// fire-and-forget — so a long clip doesn't hold the request open for the whole
// playback. A device-presence pre-check (bridge.hasDevice) returns device_offline.
const ttsServer = (overrides = {}) => ({
  tts: { stream: async () => null },                 // truthy → "configured"
  audioOut: { calls: [], speak(t) { this.calls.push(t); return Promise.resolve(1); } },
  bridge: { hasDevice: () => true },
  ...overrides,
});

test("POST /api/tts without auth returns 401", async () => {
  await withServer(ttsServer(), async ({ port }) => {
    const res = await postJson(port, "/api/tts", { text: "hi" }, { auth: false });
    assert.equal(res.status, 401);
  });
});

test("POST /api/tts returns 503 when tts not configured", async () => {
  await withServer({}, async ({ port }) => {
    const res = await postJson(port, "/api/tts", { text: "hi" });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, "tts_not_configured");
  });
});

test("POST /api/tts returns 400 for empty text and does not speak", async () => {
  const opts = ttsServer();
  await withServer(opts, async ({ port }) => {
    const res = await postJson(port, "/api/tts", { text: "   " });
    assert.equal(res.status, 400);
    assert.equal(opts.audioOut.calls.length, 0);
  });
});

test("POST /api/tts returns 400 for over-long text", async () => {
  await withServer(ttsServer(), async ({ port }) => {
    const res = await postJson(port, "/api/tts", { text: "a".repeat(1001) });
    assert.equal(res.status, 400);
  });
});

test("POST /api/tts returns 503 device_offline when no device is connected", async () => {
  const opts = ttsServer({ bridge: { hasDevice: () => false } });
  await withServer(opts, async ({ port }) => {
    const res = await postJson(port, "/api/tts", { text: "hi" });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, "device_offline");
    assert.equal(opts.audioOut.calls.length, 0, "does not speak when the device is offline");
  });
});

test("POST /api/tts streams server-side and returns ok with the trimmed text", async () => {
  const opts = ttsServer();
  await withServer(opts, async ({ port }) => {
    const res = await postJson(port, "/api/tts", { text: "  hello  " });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.deepEqual(opts.audioOut.calls, ["hello"]);
  });
});

test("POST /api/tts swallows a background speak failure (still 200)", async () => {
  const opts = ttsServer({ audioOut: { calls: [], speak() { return Promise.reject(new Error("upstream 429")); } } });
  await withServer(opts, async ({ port }) => {
    const res = await postJson(port, "/api/tts", { text: "hi" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});

// ---- POST /api/enhance ----

test("POST /api/enhance without auth returns 401", async () => {
  const fakeEnhancer = { enhance: async () => "x" };
  await withServer({ enhancer: fakeEnhancer }, async ({ port }) => {
    const res = await postJson(port, "/api/enhance", { text: "hi" }, { auth: false });
    assert.equal(res.status, 401);
  });
});

test("POST /api/enhance returns 503 when enhancer not configured", async () => {
  await withServer({}, async ({ port }) => {
    const res = await postJson(port, "/api/enhance", { text: "hi" });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, "enhance_not_configured");
  });
});

test("POST /api/enhance returns 400 for empty text and does not call enhancer", async () => {
  let called = 0;
  const fakeEnhancer = { enhance: async () => { called++; return "x"; } };
  await withServer({ enhancer: fakeEnhancer }, async ({ port }) => {
    const res = await postJson(port, "/api/enhance", {});
    assert.equal(res.status, 400);
    assert.equal(called, 0);
  });
});

test("POST /api/enhance returns tagged text on success", async () => {
  let received = null;
  const fakeEnhancer = { enhance: async (t) => { received = t; return `[excited] ${t}`; } };
  await withServer({ enhancer: fakeEnhancer }, async ({ port }) => {
    const res = await postJson(port, "/api/enhance", { text: "  we did it  " });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { text: "[excited] we did it" });
    assert.equal(received, "we did it");
  });
});

test("POST /api/enhance returns 502 when enhance throws", async () => {
  const fakeEnhancer = { enhance: async () => { throw new Error("enhance failed"); } };
  await withServer({ enhancer: fakeEnhancer }, async ({ port }) => {
    const res = await postJson(port, "/api/enhance", { text: "hi" });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error, "enhance_failed");
  });
});

// ---- GET /api/sienna/* (dashboard card data) ----

function fakeMemory({ ready = true, messages = [], memories = [], personality = [], tools = [], usage = [], images = [] } = {}) {
  return {
    ready: () => ready,
    listRecentMessages: async (n) => messages.slice(0, n),
    recentMemories: async (n) => memories.slice(0, n),
    listPersonalityVersions: async (n) => personality.slice(0, n),
    recentToolCalls: async (n) => tools.slice(0, n),
    recentUsage: async (n) => usage.slice(0, n),
    recentImages: async (n) => images.slice(0, n),
  };
}

function get(port, path, { auth = true } = {}) {
  const headers = {};
  if (auth) headers.authorization = `Bearer ${TOKEN}`;
  return fetch(`http://127.0.0.1:${port}${path}`, { headers });
}

const SIENNA_PATHS = ["messages", "memories", "personality", "tools", "activity"];

for (const p of SIENNA_PATHS) {
  test(`GET /api/sienna/${p} without auth returns 401`, async () => {
    await withServer({ memory: fakeMemory() }, async ({ port }) => {
      assert.equal((await get(port, `/api/sienna/${p}`, { auth: false })).status, 401);
    });
  });

  test(`GET /api/sienna/${p} returns 503 when agent unavailable`, async () => {
    await withServer({}, async ({ port }) => {
      const res = await get(port, `/api/sienna/${p}`);
      assert.equal(res.status, 503);
      assert.equal((await res.json()).error, "agent_unavailable");
    });
  });

  test(`GET /api/sienna/${p} returns 503 when the db is not ready`, async () => {
    await withServer({ memory: fakeMemory({ ready: false }) }, async ({ port }) => {
      assert.equal((await get(port, `/api/sienna/${p}`)).status, 503);
    });
  });
}

test("GET /api/sienna/messages returns newest-first message cards", async () => {
  const memory = fakeMemory({
    messages: [
      { _id: "m2", ts: new Date(200), role: "assistant", content: "second", source: "text", spoken: true },
      { _id: "m1", ts: new Date(100), role: "user", content: "first", source: "text" },
    ],
  });
  await withServer({ memory }, async ({ port }) => {
    const res = await get(port, "/api/sienna/messages");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.map((c) => c.id), ["m2", "m1"]);
    assert.equal(body[0].kind, "message");
    assert.equal(body[0].content, "second");
    assert.equal(body[0].spoken, true);
  });
});

test("GET /api/sienna/memories returns memory cards (text -> content, tags)", async () => {
  const memory = fakeMemory({ memories: [{ _id: "x1", ts: new Date(10), text: "coffee", tags: ["a"] }] });
  await withServer({ memory }, async ({ port }) => {
    const body = await (await get(port, "/api/sienna/memories")).json();
    assert.equal(body[0].kind, "memory");
    assert.equal(body[0].content, "coffee");
    assert.deepEqual(body[0].tags, ["a"]);
  });
});

test("GET /api/sienna/personality marks the current version", async () => {
  const memory = fakeMemory({ personality: [
    { _id: "current", text: "now", version: 2, updated_at: new Date(20) },
    { _id: "h1", text: "before", version: 1, replaced_at: new Date(10), reason: "tool" },
  ] });
  await withServer({ memory }, async ({ port }) => {
    const body = await (await get(port, "/api/sienna/personality")).json();
    assert.equal(body[0].current, true);
    assert.equal(body[0].version, 2);
    assert.equal(body[1].current, false);
    assert.equal(body[1].reason, "tool");
  });
});

test("GET /api/sienna/tools returns tool cards keyed on the tool-use id", async () => {
  const memory = fakeMemory({ tools: [
    { _id: "d1", tool_id: "tu_1", ts: new Date(50), name: "set_rgb", input: { r: 1 }, summary: "ok" },
  ] });
  await withServer({ memory }, async ({ port }) => {
    const body = await (await get(port, "/api/sienna/tools")).json();
    assert.equal(body[0].kind, "tool");
    assert.equal(body[0].id, "tool-tu_1");
    assert.equal(body[0].name, "set_rgb");
  });
});

test("GET /api/usage without auth returns 401", async () => {
  await withServer({ memory: fakeMemory() }, async ({ port }) => {
    assert.equal((await get(port, "/api/usage", { auth: false })).status, 401);
  });
});

test("GET /api/usage returns 503 when agent unavailable", async () => {
  await withServer({}, async ({ port }) => {
    const res = await get(port, "/api/usage");
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, "agent_unavailable");
  });
});

test("GET /api/usage buckets by granularity and returns totals", async () => {
  const memory = fakeMemory({ usage: [
    { ts: new Date("2026-06-07T14:00:00Z"), input_text: 100, input_image: 20, input_total: 120, output: 50, total: 170, cost: 0.01 },
    { ts: new Date("2026-06-07T15:00:00Z"), input_text: 5, input_image: 0, input_total: 5, output: 5, total: 10, cost: 0.001 },
  ] });
  await withServer({ memory }, async ({ port }) => {
    const body = await (await get(port, "/api/usage?granularity=day")).json();
    assert.equal(body.granularity, "day");
    assert.equal(body.totals.calls, 2);
    assert.equal(body.totals.input_image, 20);
    assert.equal(body.buckets.length, 1);   // both land in the same Toronto day
    assert.ok(Math.abs(body.totals.cost - 0.011) < 1e-9);
  });
});

test("GET /api/usage defaults an unknown granularity to day", async () => {
  await withServer({ memory: fakeMemory({ usage: [] }) }, async ({ port }) => {
    const body = await (await get(port, "/api/usage?granularity=bogus")).json();
    assert.equal(body.granularity, "day");
  });
});

test("GET /api/sienna/activity merges all kinds (incl. tools + images) newest-first", async () => {
  const memory = fakeMemory({
    messages: [{ _id: "m", ts: new Date(300), role: "user", content: "msg" }],
    memories: [{ _id: "x", ts: new Date(100), text: "mem" }],
    personality: [{ _id: "current", text: "p", version: 1, updated_at: new Date(200) }],
    tools: [{ _id: "t", tool_id: "tu_9", ts: new Date(250), name: "speak", input: { text: "hi" }, summary: "said" }],
    images: [{ _id: "i", ts: new Date(400), filename: "snap.jpg", source: "camera" }],
  });
  await withServer({ memory }, async ({ port }) => {
    const body = await (await get(port, "/api/sienna/activity")).json();
    assert.deepEqual(body.map((c) => c.kind), ["image", "message", "tool", "personality", "memory"]);
  });
});

test("GET /api/sienna/images returns image cards newest-first", async () => {
  const memory = fakeMemory({
    images: [
      { _id: "i2", ts: new Date(2000), filename: "b.jpg", source: "camera" },
      { _id: "i1", ts: new Date(1000), filename: "a.jpg", source: "camera" },
    ],
  });
  await withServer({ memory }, async ({ port }) => {
    const body = await (await get(port, "/api/sienna/images")).json();
    assert.deepEqual(body.map((c) => c.filename), ["b.jpg", "a.jpg"]);
    assert.equal(body[0].kind, "image");
  });
});

test("GET /api/sienna/images requires auth", async () => {
  await withServer({ memory: fakeMemory() }, async ({ port }) => {
    const res = await get(port, "/api/sienna/images", { auth: false });
    assert.equal(res.status, 401);
  });
});

test("GET /api/sienna/images/:filename serves the JPEG with a query token", async () => {
  await withServer({ memory: fakeMemory() }, async ({ port, imageStore }) => {
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0x42]);
    const { filename } = await imageStore.save(bytes);
    // No Authorization header — auth rides in ?token= (so <img src> works).
    const res = await fetch(`http://127.0.0.1:${port}/api/sienna/images/${filename}?token=${TOKEN}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/jpeg");
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes);
  });
});

test("GET /api/sienna/images/:filename rejects a bad filename and a missing token", async () => {
  await withServer({ memory: fakeMemory() }, async ({ port }) => {
    const bad = await fetch(`http://127.0.0.1:${port}/api/sienna/images/..%2Fsecret.txt?token=${TOKEN}`);
    assert.equal(bad.status, 400);
    const noTok = await fetch(`http://127.0.0.1:${port}/api/sienna/images/whatever.jpg`);
    assert.equal(noTok.status, 401);
    const missing = await fetch(`http://127.0.0.1:${port}/api/sienna/images/nope.jpg?token=${TOKEN}`);
    assert.equal(missing.status, 404);
  });
});
