import express from "express";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { toCard, mergeActivity } from "./sienna-cards.js";
import { summarize, totals } from "./usage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function requireBearer(token) {
  return (req, res, next) => {
    const auth = req.get("authorization") || "";
    if (auth !== `Bearer ${token}`) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}

// Like requireBearer but also accepts the token as a ?token= query param, the
// same mechanism the WS uses. Needed for <img src> (which can't send an
// Authorization header) — the image thumbnails point at the JPEG endpoint.
function requireBearerOrQuery(token) {
  return (req, res, next) => {
    const auth = req.get("authorization") || "";
    if (auth === `Bearer ${token}` || req.query.token === token) { next(); return; }
    res.status(401).json({ error: "unauthorized" });
  };
}

const MAX_TTS_CHARS = 1000;

// Cards default to a recent window; callers may narrow it. Capped so a hostile
// ?limit can't ask Mongo for an unbounded scan.
const DEFAULT_CARD_LIMIT = 100;
const DEFAULT_ACTIVITY_LIMIT = 200;
const MAX_CARD_LIMIT = 500;
// Usage aggregation reads many more raw records than the card lists (it buckets a
// long window), so it has its own, larger ceiling.
const DEFAULT_USAGE_LIMIT = 5000;
const MAX_USAGE_LIMIT = 50000;
const USAGE_GRANULARITIES = ["hour", "day", "week", "month"];

function clampLimit(raw, fallback) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, MAX_CARD_LIMIT);
}

function clampUsageLimit(raw) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_USAGE_LIMIT;
  return Math.min(n, MAX_USAGE_LIMIT);
}

export function createApp({ token, recorder, imageStore, tts, audioOut, bridge, enhancer, memory }) {
  const app = express();
  app.disable("x-powered-by");

  // The Sienna card endpoints share one availability gate: the agent (and so its
  // Mongo-backed memory) must be configured AND connected. Mirrors the WS
  // "agent_unavailable" reason the dashboard panel already special-cases.
  const requireMemory = (_req, res, next) => {
    if (!memory || !memory.ready()) {
      res.status(503).json({ error: "agent_unavailable" });
      return;
    }
    next();
  };

  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  app.get("/api/token", (_req, res) => res.json({ token }));

  // ---- "Speak" widget: text-to-speech (ElevenLabs) ----
  // Synthesizes SERVER-SIDE and streams to the device speaker (audioOut.speak →
  // HTTP /stream, eleven_v3, paced PCM), so the browser just sends text. Fire-and-
  // forget: a long clip would otherwise hold this request open for the whole
  // playback, so we return as soon as it's kicked off (a device-presence pre-check
  // gives a clean device_offline). requireBearer runs before express.json so
  // unauthenticated callers are rejected before we parse a body.
  app.post("/api/tts", requireBearer(token), express.json({ limit: "16kb" }), async (req, res) => {
    if (!tts || !audioOut) {
      res.status(503).json({ error: "tts_not_configured" });
      return;
    }
    const text = (req.body?.text ?? "").trim();
    if (!text) {
      res.status(400).json({ error: "text required" });
      return;
    }
    if (text.length > MAX_TTS_CHARS) {
      res.status(400).json({ error: `text too long (max ${MAX_TTS_CHARS} chars)` });
      return;
    }
    if (bridge && !bridge.hasDevice()) {
      res.status(503).json({ error: "device_offline" });
      return;
    }
    // Background: synthesize + pace to the device. Errors are logged (the client
    // already has its 200 — there's no audio to deliver back over HTTP).
    Promise.resolve(audioOut.speak(text)).catch((e) => console.warn(`[tts] speak failed: ${e?.message}`));
    res.json({ ok: true });
  });

  // ---- "Enhance" button: insert v3 audio tags (Gemini) ----
  app.post("/api/enhance", requireBearer(token), express.json({ limit: "16kb" }), async (req, res) => {
    if (!enhancer) {
      res.status(503).json({ error: "enhance_not_configured" });
      return;
    }
    const text = (req.body?.text ?? "").trim();
    if (!text) {
      res.status(400).json({ error: "text required" });
      return;
    }
    if (text.length > MAX_TTS_CHARS) {
      res.status(400).json({ error: `text too long (max ${MAX_TTS_CHARS} chars)` });
      return;
    }
    try {
      const enhanced = await enhancer.enhance(text);
      res.json({ text: enhanced });
    } catch (e) {
      res.status(502).json({ error: "enhance_failed", detail: e.message });
    }
  });

  app.get("/api/recordings", requireBearer(token), async (_req, res) => {
    try {
      const recordings = await recorder.list();
      res.json({ recordings });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/recordings/:filename", requireBearer(token), async (req, res) => {
    const { filename } = req.params;
    if (!/^[A-Za-z0-9_.-]+\.wav$/.test(filename)) {
      res.status(400).json({ error: "bad filename" });
      return;
    }
    try {
      const existed = await recorder.delete(filename);
      if (existed) res.json({ ok: true });
      else res.status(404).json({ error: "not found" });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/recordings/:filename", requireBearer(token), async (req, res) => {
    const { filename } = req.params;
    if (!/^[A-Za-z0-9_.-]+\.wav$/.test(filename)) {
      res.status(400).json({ error: "bad filename" });
      return;
    }
    const filepath = path.join(recorder.dir, filename);
    try {
      const data = await fs.readFile(filepath);
      res.set("content-type", "audio/wav");
      res.set("content-length", String(data.length));
      res.send(data);
    } catch (e) {
      if (e.code === "ENOENT") res.status(404).json({ error: "not found" });
      else res.status(500).json({ error: e.message });
    }
  });

  // ---- Sienna dashboard card data (Activity / Messages / Memories / Personality) ----
  app.get("/api/sienna/messages", requireBearer(token), requireMemory, async (req, res) => {
    try {
      const docs = await memory.listRecentMessages(clampLimit(req.query.limit, DEFAULT_CARD_LIMIT));
      res.json(docs.map((d) => toCard("message", d)));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/sienna/memories", requireBearer(token), requireMemory, async (req, res) => {
    try {
      const docs = await memory.recentMemories(clampLimit(req.query.limit, DEFAULT_CARD_LIMIT));
      res.json(docs.map((d) => toCard("memory", d)));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/sienna/personality", requireBearer(token), requireMemory, async (req, res) => {
    try {
      const docs = await memory.listPersonalityVersions(clampLimit(req.query.limit, DEFAULT_CARD_LIMIT));
      res.json(docs.map((d) => toCard("personality", d)));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/sienna/tools", requireBearer(token), requireMemory, async (req, res) => {
    try {
      const docs = await memory.recentToolCalls(clampLimit(req.query.limit, DEFAULT_CARD_LIMIT));
      res.json(docs.map((d) => toCard("tool", d)));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/sienna/images", requireBearer(token), requireMemory, async (req, res) => {
    try {
      const docs = await memory.recentImages(clampLimit(req.query.limit, DEFAULT_CARD_LIMIT));
      res.json(docs.map((d) => toCard("image", d)));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // The JPEG bytes for an image card. Token via header OR ?token= (so an <img src>
  // works). Filename-sanitised + served straight off disk, like /api/recordings/:filename.
  app.get("/api/sienna/images/:filename", requireBearerOrQuery(token), async (req, res) => {
    const { filename } = req.params;
    if (!/^[A-Za-z0-9_.-]+\.jpg$/.test(filename)) {
      res.status(400).json({ error: "bad filename" });
      return;
    }
    const filepath = path.join(imageStore.dir, filename);
    try {
      const data = await fs.readFile(filepath);
      res.set("content-type", "image/jpeg");
      res.set("content-length", String(data.length));
      res.send(data);
    } catch (e) {
      if (e.code === "ENOENT") res.status(404).json({ error: "not found" });
      else res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/sienna/activity", requireBearer(token), requireMemory, async (req, res) => {
    const limit = clampLimit(req.query.limit, DEFAULT_ACTIVITY_LIMIT);
    try {
      const [messages, memories, personality, tools, images] = await Promise.all([
        memory.listRecentMessages(limit),
        memory.recentMemories(limit),
        memory.listPersonalityVersions(limit),
        memory.recentToolCalls(limit),
        memory.recentImages(limit),
      ]);
      res.json(mergeActivity([
        messages.map((d) => toCard("message", d)),
        memories.map((d) => toCard("memory", d)),
        personality.map((d) => toCard("personality", d)),
        tools.map((d) => toCard("tool", d)),
        images.map((d) => toCard("image", d)),
      ], limit));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- Token usage + cost (the Usage view) ----
  // Returns grand totals + per-bucket rows at the requested granularity
  // (hour/day/week/month). Bucketing is done in JS over the newest N raw records.
  app.get("/api/usage", requireBearer(token), requireMemory, async (req, res) => {
    const granularity = USAGE_GRANULARITIES.includes(req.query.granularity) ? req.query.granularity : "day";
    try {
      const records = await memory.recentUsage(clampUsageLimit(req.query.limit));
      res.json({ granularity, totals: totals(records), buckets: summarize(records, { granularity }) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

  return app;
}
