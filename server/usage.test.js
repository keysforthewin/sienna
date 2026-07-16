import { test } from "node:test";
import assert from "node:assert/strict";
import { costOf, bucketKey, summarize, totals } from "./usage.js";

const RATES = { inputPer1M: 0.3, outputPer1M: 2.5, imagePer1M: 0.3 };

test("costOf bills text+image input and output at their per-1M rates", () => {
  // 1M text input @0.3 + 0.5M image @0.3 + 1M output @2.5 = 0.3 + 0.15 + 2.5
  const c = costOf({ input_text: 1_000_000, input_image: 500_000, output: 1_000_000 }, RATES);
  assert.ok(Math.abs(c - 2.95) < 1e-9);
});

test("costOf is 0 with no rates / no tokens", () => {
  assert.equal(costOf({ input_text: 1000, output: 1000 }), 0);
  assert.equal(costOf({}, RATES), 0);
});

test("bucketKey: hour/day/month are exact in the given tz", () => {
  const ms = Date.parse("2026-06-07T10:45:00Z");
  assert.equal(bucketKey(ms, "hour", "UTC"), "2026-06-07 10:00");
  assert.equal(bucketKey(ms, "day", "UTC"), "2026-06-07");
  assert.equal(bucketKey(ms, "month", "UTC"), "2026-06");
});

test("bucketKey: day is timezone-aware (Toronto vs UTC can differ)", () => {
  // 03:30Z in June (EDT, UTC-4) is 23:30 the PREVIOUS day in Toronto.
  const ms = Date.parse("2026-06-07T03:30:00Z");
  assert.equal(bucketKey(ms, "day", "UTC"), "2026-06-07");
  assert.equal(bucketKey(ms, "day", "America/Toronto"), "2026-06-06");
});

test("bucketKey: week collapses a Mon–Sun span to one Monday key", () => {
  const mon = bucketKey(Date.parse("2026-06-01T12:00:00Z"), "week", "UTC");
  const sun = bucketKey(Date.parse("2026-06-07T12:00:00Z"), "week", "UTC");
  const nextMon = bucketKey(Date.parse("2026-06-08T12:00:00Z"), "week", "UTC");
  assert.match(mon, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(mon, sun);           // same week → same key
  assert.notEqual(mon, nextMon);    // next week → different key
});

const RECS = [
  { ts: Date.parse("2026-06-07T10:15:00Z"), input_text: 100, input_image: 0, input_total: 100, output: 50, total: 150, cost: 0.01 },
  { ts: Date.parse("2026-06-07T10:45:00Z"), input_text: 200, input_image: 10, input_total: 210, output: 60, total: 270, cost: 0.02 },
  { ts: Date.parse("2026-06-07T11:05:00Z"), input_text: 5, input_image: 0, input_total: 5, output: 5, total: 10, cost: 0.001 },
];

test("summarize(hour) groups by hour, sums fields, newest-first", () => {
  const out = summarize(RECS, { granularity: "hour", tz: "UTC" });
  assert.deepEqual(out.map((b) => b.key), ["2026-06-07 11:00", "2026-06-07 10:00"]);
  const ten = out[1];
  assert.equal(ten.calls, 2);
  assert.equal(ten.input_text, 300);
  assert.equal(ten.input_image, 10);
  assert.equal(ten.output, 110);
  assert.ok(Math.abs(ten.cost - 0.03) < 1e-9);
});

test("summarize(day) collapses all three into one bucket", () => {
  const out = summarize(RECS, { granularity: "day", tz: "UTC" });
  assert.equal(out.length, 1);
  assert.equal(out[0].key, "2026-06-07");
  assert.equal(out[0].calls, 3);
  assert.equal(out[0].total, 430);
});

test("summarize tolerates Date ts and skips null ts", () => {
  const recs = [{ ts: new Date("2026-06-07T10:00:00Z"), total: 10 }, { ts: null, total: 999 }];
  const out = summarize(recs, { granularity: "day", tz: "UTC" });
  assert.equal(out.length, 1);
  assert.equal(out[0].total, 10);   // the null-ts record is dropped
});

test("totals sums across all records regardless of time", () => {
  const t = totals(RECS);
  assert.equal(t.calls, 3);
  assert.equal(t.input_text, 305);
  assert.equal(t.input_image, 10);
  assert.equal(t.output, 115);
  assert.equal(t.total, 430);
  assert.ok(Math.abs(t.cost - 0.031) < 1e-9);
});
