// Token-usage cost + time-bucketing for the dashboard's Usage view. Pure (no deps,
// no DB, no clock) so the money math and the calendar bucketing are unit-tested in
// isolation. The agent reasons on Gemini only; gemini.js reports per-call token
// counts (text/image split), index.js stamps each with a cost (locked at the rate
// in effect then) and persists it, and these helpers aggregate the stored records.

const TZ = "America/Toronto";

// Dollars for one usage record given $/1M-token rates. Image input is billed
// separately (Gemini meters images as input tokens, but a distinct rate lets you
// model it). Cached tokens are counted in input_text but not discounted here.
export function costOf({ input_text = 0, input_image = 0, output = 0 } = {}, rates = {}) {
  const { inputPer1M = 0, outputPer1M = 0, imagePer1M = 0 } = rates;
  return (input_text * inputPer1M + input_image * imagePer1M + output * outputPer1M) / 1_000_000;
}

function toMs(v) {
  if (v == null) return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") { const n = Date.parse(v); return Number.isFinite(n) ? n : null; }
  return null;
}

// Wall-clock parts (year/month/day/hour) for an instant in a timezone.
function tzParts(ms, tz) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false,
  }).formatToParts(new Date(ms))) {
    if (p.type !== "literal") parts[p.type] = p.value;
  }
  if (parts.hour === "24") parts.hour = "00"; // some envs render midnight as 24
  return parts;
}

// The Monday of the week containing a YYYY-MM-DD, as YYYY-MM-DD. Anchored at noon
// UTC so the timezone offset can never flip the day (mirrors weather.js).
function weekStart(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7; // days since Monday (Sun=0 → 6)
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

// The sortable bucket key for an instant at a given granularity, or null.
export function bucketKey(ms, granularity = "day", tz = TZ) {
  if (ms == null) return null;
  const p = tzParts(ms, tz);
  const date = `${p.year}-${p.month}-${p.day}`;
  switch (granularity) {
    case "hour": return `${date} ${p.hour}:00`;
    case "week": return weekStart(date);
    case "month": return `${p.year}-${p.month}`;
    case "day":
    default: return date;
  }
}

// Aggregate usage records into newest-first buckets at the given granularity. Each
// bucket sums calls + token counts (text/image/total split) + cost.
export function summarize(records = [], { granularity = "day", tz = TZ } = {}) {
  const buckets = new Map();
  for (const r of records) {
    const key = bucketKey(toMs(r.ts), granularity, tz);
    if (key == null) continue;
    let b = buckets.get(key);
    if (!b) {
      b = { key, calls: 0, input_text: 0, input_image: 0, input_total: 0, output: 0, total: 0, cost: 0 };
      buckets.set(key, b);
    }
    b.calls += 1;
    b.input_text += r.input_text || 0;
    b.input_image += r.input_image || 0;
    b.input_total += r.input_total || 0;
    b.output += r.output || 0;
    b.total += r.total || 0;
    b.cost += r.cost || 0;
  }
  return [...buckets.values()].sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
}

// Grand totals across all records (the headline numbers above the per-bucket table).
export function totals(records = []) {
  const t = { calls: 0, input_text: 0, input_image: 0, input_total: 0, output: 0, total: 0, cost: 0 };
  for (const r of records) {
    t.calls += 1;
    t.input_text += r.input_text || 0;
    t.input_image += r.input_image || 0;
    t.input_total += r.input_total || 0;
    t.output += r.output || 0;
    t.total += r.total || 0;
    t.cost += r.cost || 0;
  }
  return t;
}
