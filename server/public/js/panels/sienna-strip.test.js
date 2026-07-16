import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldStick, relTime, absTime, cardModel } from "./sienna-strip.js";

// shouldStick: are we at (or near) the RIGHT edge of a horizontal scroller?
test("shouldStick is true at the right edge", () => {
  assert.equal(shouldStick({ scrollLeft: 700, scrollWidth: 1000, clientWidth: 300 }), true);
});

test("shouldStick is true within the threshold of the right edge", () => {
  assert.equal(shouldStick({ scrollLeft: 680, scrollWidth: 1000, clientWidth: 300 }), true);
});

test("shouldStick is false when the user has scrolled away from the right edge", () => {
  assert.equal(shouldStick({ scrollLeft: 100, scrollWidth: 1000, clientWidth: 300 }), false);
});

test("relTime renders empty for a missing timestamp", () => {
  assert.equal(relTime(null, 1000), "");
});

test("relTime renders coarse buckets", () => {
  const now = 10_000_000_000;
  assert.equal(relTime(now, now), "now");
  assert.equal(relTime(now - 5 * 60_000, now), "5m");
  assert.equal(relTime(now - 2 * 3_600_000, now), "2h");
  assert.equal(relTime(now - 3 * 86_400_000, now), "3d");
});

test("cardModel(message,user) labels 'you'", () => {
  const m = cardModel({ kind: "message", role: "user", content: "hello", source: "text" });
  assert.equal(m.kind, "message");
  assert.equal(m.role, "user");
  assert.equal(m.label, "you");
  assert.equal(m.body, "hello");
});

test("cardModel(message,assistant) labels 'sienna' and shows a speaker icon when spoken", () => {
  const m = cardModel({ kind: "message", role: "assistant", content: "hi", source: "ptt", spoken: true });
  assert.equal(m.label, "sienna");
  assert.match(m.meta, /🔊/);
  assert.match(m.meta, /ptt/);
});

test("cardModel(memory) carries tags", () => {
  const m = cardModel({ kind: "memory", content: "coffee", tags: ["a", "b"], source: "remember" });
  assert.equal(m.label, "memory");
  assert.deepEqual(m.tags, ["a", "b"]);
});

test("cardModel(personality) marks the current version and shows reason on history", () => {
  const cur = cardModel({ kind: "personality", content: "x", version: 3, current: true });
  assert.match(cur.label, /v3/);
  assert.match(cur.label, /current/);
  const hist = cardModel({ kind: "personality", content: "y", version: 2, current: false, reason: "reflection" });
  assert.match(hist.meta, /reflection/);
});

test("cardModel(tool) renders an arrow label", () => {
  const m = cardModel({ kind: "tool", name: "look", content: "saw a desk" });
  assert.equal(m.label, "→ look");
  assert.equal(m.body, "saw a desk");
});

test("absTime renders empty for a missing timestamp", () => {
  assert.equal(absTime(null), "");
});

test("absTime renders a non-empty absolute string for a real ts", () => {
  const s = absTime(Date.parse("2026-06-07T14:45:00Z"));
  assert.equal(typeof s, "string");
  assert.ok(s.length > 0);
});

test("absTime renders the user's Eastern time regardless of the host zone", () => {
  // 2026-06-07T14:45:00Z is 10:45 in the Eastern zone (EDT, UTC-4). Pretend the
  // dashboard is being viewed from a machine in a very different zone — absTime
  // must still show Eastern wall-clock, matching the agent prompt (prompt.js).
  const saved = process.env.TZ;
  process.env.TZ = "Asia/Kolkata"; // UTC+5:30 → a naive local render would read 8:15 PM
  try {
    const s = absTime(Date.parse("2026-06-07T14:45:00Z"));
    assert.ok(s.includes("10:45"), `expected Eastern 10:45 in ${JSON.stringify(s)}`);
  } finally {
    if (saved == null) delete process.env.TZ; else process.env.TZ = saved;
  }
});

test("cardModel(image) labels a snapshot, empty body (img rendered separately), no output icon", () => {
  const m = cardModel({ kind: "image", filename: "x.jpg", source: "camera" });
  assert.equal(m.kind, "image");
  assert.equal(m.label, "📷 snapshot");
  assert.equal(m.meta, "camera");
  assert.equal(m.body, "");
  assert.equal(m.output, false);
});
