import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt, SIENNA_BASE } from "./prompt.js";

test("base block is first and carries the certain fact + tag vocabulary", () => {
  const blocks = buildSystemPrompt({ personality: null });
  assert.equal(blocks[0].text, SIENNA_BASE);
  assert.match(blocks[0].text, /Bharati/);
  assert.match(blocks[0].text, /Steve/);
  assert.match(blocks[0].text, /\[excited\]/); // tag vocabulary present
});

test("base teaches the listen tool (her on-demand ears) and proactive speech", () => {
  assert.match(SIENNA_BASE, /listen tool/);
  assert.match(SIENNA_BASE, /start a conversation/);
});

test("base tells her the play tools self-announce — call them directly (no pre-speak)", () => {
  assert.match(SIENNA_BASE, /play_music/);
  assert.match(SIENNA_BASE, /DIRECTLY/);
});

test("no block carries Anthropic cache_control (Gemini-only)", () => {
  const blocks = buildSystemPrompt({
    personality: { text: "p", version: 1 },
    memories: [{ text: "m" }],
    recentTurns: [{ role: "user", content: "hi", source: "text" }],
  });
  // The layered ordering (base, personality, memories, recent, context) is kept,
  // but cache_control is gone — Gemini does implicit caching.
  for (const b of blocks) assert.equal(b.cache_control, undefined);
  // The volatile "Right now" context block is always last.
  assert.match(blocks[blocks.length - 1].text, /Right now:/);
});

test("base teaches the stop tool for stand-down requests", () => {
  assert.match(SIENNA_BASE, /stop tool/);
});

test("base tells her to grunt one short word (no rambling guesses) when she mishears", () => {
  assert.match(SIENNA_BASE, /huh\?/);
  assert.match(SIENNA_BASE, /cut off/);
  assert.match(SIENNA_BASE, /maybe you meant/);          // explicitly forbids the enumerated guessing
  assert.match(SIENNA_BASE, /ONE short.{0,20}word/i);    // enforces the one-word grunt
  assert.match(SIENNA_BASE, /two words/);                // hard cap
  assert.match(SIENNA_BASE, /reply normally/);           // scope: only when confused, not normal replies
});

test("personality block uses the stub when unset", () => {
  const blocks = buildSystemPrompt({ personality: null });
  assert.match(blocks[1].text, /not written your personality yet/);
});

test("personality text is embedded when set", () => {
  const blocks = buildSystemPrompt({ personality: { text: "I am curious and warm.", version: 3 } });
  assert.match(blocks[1].text, /I am curious and warm\./);
});

test("memories + recent blocks omitted when empty, present when given", () => {
  // Base + personality + the always-present "Right now" context block.
  assert.equal(buildSystemPrompt({ personality: null }).length, 3);
  const full = buildSystemPrompt({
    personality: null,
    memories: [{ text: "coffee fact" }],
    recentTurns: [{ role: "assistant", content: "earlier thought", source: "reflection" }],
  });
  assert.equal(full.length, 5);
  assert.match(full[2].text, /coffee fact/);
  assert.match(full[3].text, /earlier thought/);
});

test("context block carries date/time, Ontario location, and time-since-last-thought", () => {
  const now = new Date("2026-06-05T18:34:00Z"); // 14:34 America/Toronto (EDT)
  const blocks = buildSystemPrompt({ personality: null, now, sinceLastThoughtMs: 12 * 60 * 1000 });
  const ctx = blocks[blocks.length - 1].text;
  assert.match(ctx, /Right now:/);
  assert.match(ctx, /Kanata, Ontario, Canada/);
  assert.match(ctx, /2026/);            // date rendered
  assert.match(ctx, /2:34/);            // Toronto wall-clock time
  assert.match(ctx, /12 minutes since your last thought/);
});

test("context block marks the first thought when no prior run", () => {
  const blocks = buildSystemPrompt({ personality: null, sinceLastThoughtMs: null });
  assert.match(blocks[blocks.length - 1].text, /first thought since waking up/);
});

test("weather, when given, appears in the last (volatile, never-cached) context block", () => {
  const blocks = buildSystemPrompt({ personality: { text: "p", version: 1 }, weather: "Cloudy, 18°C (feels 17°C), wind 12 km/h, humidity 64%" });
  const last = blocks[blocks.length - 1];
  assert.match(last.text, /- Weather: Cloudy, 18°C/);
  assert.equal(last.cache_control, undefined); // must stay out of the cached prefix
});

test("weather is omitted when not provided (back-compat)", () => {
  const ctx = buildSystemPrompt({ personality: null }).at(-1).text;
  assert.doesNotMatch(ctx, /- Weather:/);
});

test("the cached prefix (blocks 0-1) is byte-identical with and without weather", () => {
  const without = buildSystemPrompt({ personality: { text: "p", version: 1 } });
  const with_ = buildSystemPrompt({ personality: { text: "p", version: 1 }, weather: "Sunny, 22°C (feels 22°C), wind 5 km/h, humidity 40%" });
  assert.equal(without[0].text, with_[0].text);
  assert.equal(without[1].text, with_[1].text);
});

test("blocks 1-2 are byte-identical regardless of memories/recent (cache stability)", () => {
  const a = buildSystemPrompt({ personality: { text: "p", version: 1 } });
  const b = buildSystemPrompt({
    personality: { text: "p", version: 1 },
    memories: [{ text: "x" }],
    recentTurns: [{ role: "user", content: "y", source: "ptt" }],
  });
  assert.equal(a[0].text, b[0].text);
  assert.equal(a[1].text, b[1].text);
});

test("long memory text is truncated to keep recall bounded", () => {
  const blocks = buildSystemPrompt({ personality: null, memories: [{ text: "x".repeat(500) }] });
  assert.ok(blocks[2].text.length < 400);
  assert.match(blocks[2].text, /…/);
});

test("recent transcript interleaves elapsed-time gaps between turns", () => {
  const min = 60 * 1000;
  const turns = [
    { role: "user", content: "you awake?", source: "ptt", ts: 0 },
    { role: "assistant", content: "Always.", source: "ptt", ts: 3 * min },
    { role: "user", content: "still there?", source: "text", ts: 3 * min + 120 * min },
  ];
  const recent = buildSystemPrompt({ personality: null, recentTurns: turns })
    .find((b) => /Recent moments:/.test(b.text)).text;
  assert.match(recent, /3 minutes later/);
  assert.match(recent, /2 hours later/);
  assert.doesNotMatch(recent.split("\n")[1], /later/); // first turn has no preceding gap
});

test("recent transcript omits gaps when timestamps are missing", () => {
  const turns = [
    { role: "user", content: "hi", source: "text" },
    { role: "assistant", content: "hello", source: "text" },
  ];
  const recent = buildSystemPrompt({ personality: null, recentTurns: turns })
    .find((b) => /Recent moments:/.test(b.text)).text;
  assert.doesNotMatch(recent, /later/);
  assert.match(recent, /hi/);
  assert.match(recent, /hello/);
});

test("lights line appears in the volatile context block when provided", () => {
  const ctx = buildSystemPrompt({
    personality: null,
    lights: "necklace on, blue hat light off, bindi glowing (255, 100, 0)",
  }).at(-1).text;
  assert.match(ctx, /- Your lights: necklace on, blue hat light off, bindi glowing \(255, 100, 0\)/);
});

test("now-playing line is used verbatim (jukebox text already carries the prefix)", () => {
  const ctx = buildSystemPrompt({
    personality: null,
    nowPlaying: 'Now playing: "Clair de Lune" by Debussy — from your "calm piano" mix.',
  }).at(-1).text;
  assert.match(ctx, /- Now playing: "Clair de Lune" by Debussy/);
  assert.doesNotMatch(ctx, /Now playing: Now playing/);
});

test("lights and now-playing are omitted when not provided (back-compat)", () => {
  const ctx = buildSystemPrompt({ personality: null }).at(-1).text;
  assert.doesNotMatch(ctx, /- Your lights:/);
  assert.doesNotMatch(ctx, /Now playing:/);
});

test("cached prefix (blocks 0-1) is byte-identical with and without lights/now-playing", () => {
  const without = buildSystemPrompt({ personality: { text: "p", version: 1 } });
  const with_ = buildSystemPrompt({
    personality: { text: "p", version: 1 },
    lights: "necklace on, blue hat light off, bindi unset",
    nowPlaying: 'Now playing: "Song" by Artist.',
  });
  assert.equal(without[0].text, with_[0].text);
  assert.equal(without[1].text, with_[1].text);
});

test("base carries her full appearance: hat, hair, necklace, lights, face", () => {
  assert.match(SIENNA_BASE, /black hat/);
  assert.match(SIENNA_BASE, /purple hair/);
  assert.match(SIENNA_BASE, /light-up necklace/);
  assert.match(SIENNA_BASE, /"S" pendant/);
  assert.match(SIENNA_BASE, /red lipstick/);
  assert.match(SIENNA_BASE, /blue eyes/);
  assert.match(SIENNA_BASE, /on fleek/);
  assert.match(SIENNA_BASE, /bindi/);
  assert.match(SIENNA_BASE, /lonely/);   // blue hat light association
  assert.match(SIENNA_BASE, /happy/);    // necklace association
  assert.match(SIENNA_BASE, /back of the hat/);    // light sensor placement
  assert.match(SIENNA_BASE, /top of/);             // speaker placement
});

test("BASE tells her to call the music tool in-turn, not just say she will", () => {
  assert.match(SIENNA_BASE, /call (play_music|the (play|music) tool).*same turn|don't just say/i);
});

test("BASE blesses putting music on proactively for the room", () => {
  assert.match(SIENNA_BASE, /put (some )?music on|play something.*(enjoy|room)/i);
});
