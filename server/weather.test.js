import { test } from "node:test";
import assert from "node:assert/strict";
import { createWeather } from "./weather.js";

// A fetch double routed by Open-Meteo query shape: the ambient request carries
// `current=`, the forecast request carries `daily=`. Each route is a descriptor:
//   { json }              → 200 with that JSON body
//   { fail, status, body } → non-ok response with that status + text body
function makeFetch({ current, forecast } = {}) {
  const calls = [];
  const respond = (desc) => {
    if (!desc) return { ok: true, status: 200, text: async () => "{}", json: async () => ({}) };
    if (desc.fail) {
      return { ok: false, status: desc.status ?? 500, text: async () => desc.body ?? "", json: async () => ({}) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(desc.json), json: async () => desc.json };
  };
  const fetchImpl = async (url) => {
    calls.push(url);
    return respond(url.includes("current=") ? current : forecast);
  };
  return { fetchImpl, calls };
}

function makeScheduler() {
  const calls = [];
  const scheduler = (fn, ms) => { const h = { fn, ms }; calls.push(h); return h; };
  let cleared = 0;
  const clear = () => { cleared++; };
  return { scheduler, clear, calls, clearedCount: () => cleared };
}

// Open-Meteo current block (code 3 = "Overcast").
const CURRENT = {
  json: { current: { temperature_2m: 18.4, relative_humidity_2m: 64, apparent_temperature: 17.2, weather_code: 3, wind_speed_10m: 12.3 } },
};

// Pinned "now": 2026-06-06T12:00:00Z is 08:00 EDT, so Toronto "today" is 2026-06-06.
const CLOCK = () => Date.parse("2026-06-06T12:00:00Z");

// Build an Open-Meteo forecast response over the given dates. Defaults: code 80
// ("Slight rain showers"), 21.4/11.2 high/low, 60% rain, and an 08:00 hour at 14.3°C
// code 51 ("Light drizzle"). `daily`/`hourly` override the defaults wholesale.
function forecastResp({ dates, daily = {}, hourly = null } = {}) {
  const fill = (v) => dates.map(() => v);
  return { json: {
    daily: {
      time: dates,
      weather_code: fill(80),
      temperature_2m_max: fill(21.4),
      temperature_2m_min: fill(11.2),
      precipitation_probability_max: fill(60),
      ...daily,
    },
    hourly: hourly ?? {
      time: dates.flatMap((d) => [`${d}T07:00`, `${d}T08:00`]),
      temperature_2m: dates.flatMap(() => [13.0, 14.3]),
      weather_code: dates.flatMap(() => [3, 51]),
    },
  } };
}

test("no API key is needed — constructs fine without one", () => {
  assert.doesNotThrow(() => createWeather({}));
});

test("current() is null before any refresh", () => {
  const { fetchImpl } = makeFetch({ current: CURRENT });
  const w = createWeather({ fetchImpl });
  assert.equal(w.current(), null);
});

test("refresh() caches the formatted ambient line (codes named, temps rounded)", async () => {
  const { fetchImpl } = makeFetch({ current: CURRENT });
  const w = createWeather({ fetchImpl });
  await w.refresh();
  assert.equal(w.current(), "Overcast, 18°C (feels 17°C), wind 12 km/h, humidity 64%");
});

test("a failed refresh keeps the previous value", async () => {
  const logs = [];
  const { fetchImpl } = makeFetch({ current: CURRENT });
  const w = createWeather({ fetchImpl, log: (m) => logs.push(m) });
  await w.refresh();
  assert.ok(w.current());

  // A 500 with no prior value → stays null and logs the provider+status.
  const fail = makeFetch({ current: { fail: true, status: 500, body: "service down" } });
  const w2 = createWeather({ fetchImpl: fail.fetchImpl, log: (m) => logs.push(m) });
  await w2.refresh();
  assert.equal(w2.current(), null);
  assert.match(logs.join("\n"), /open-meteo 500/);
});

test("forecast() defaults to today and reports 8am, high/low, rain %, and the date", async () => {
  const { fetchImpl, calls } = makeFetch({ forecast: forecastResp({ dates: ["2026-06-06"] }) });
  const w = createWeather({ fetchImpl, clock: CLOCK });
  const r = await w.forecast({});
  assert.equal(r.ok, true);
  assert.match(r.text, /June 6, 2026/);
  assert.match(r.text, /Slight rain showers\./);
  assert.match(r.text, /At 8am: 14°C, Light drizzle\./);
  assert.match(r.text, /High 21°C, low 11°C\./);
  assert.match(r.text, /Chance of rain 60%\./);
  assert.match(calls[0], /forecast_days=1/); // offset 0 → 1 day
});

test("forecast({date}) for tomorrow requests the right window and selects by date", async () => {
  const { fetchImpl, calls } = makeFetch({ forecast: forecastResp({ dates: ["2026-06-06", "2026-06-07"] }) });
  const w = createWeather({ fetchImpl, clock: CLOCK });
  const r = await w.forecast({ date: "2026-06-07" });
  assert.equal(r.ok, true);
  assert.match(r.text, /June 7, 2026/);
  assert.match(calls[0], /forecast_days=2/); // offset 1 → 2 days
});

test("forecast() for a day 5 out (the old 3-day failure) now works", async () => {
  const dates = ["2026-06-06", "2026-06-07", "2026-06-08", "2026-06-09", "2026-06-10", "2026-06-11"];
  const { fetchImpl, calls } = makeFetch({ forecast: forecastResp({ dates }) });
  const w = createWeather({ fetchImpl, clock: CLOCK });
  const r = await w.forecast({ date: "2026-06-11" }); // offset 5
  assert.equal(r.ok, true);
  assert.match(r.text, /June 11, 2026/);
  assert.match(calls[0], /forecast_days=6/);
});

test("forecast() beyond the ~16-day horizon is a graceful non-error message (no fetch)", async () => {
  const { fetchImpl, calls } = makeFetch({});
  const w = createWeather({ fetchImpl, clock: CLOCK });
  const r = await w.forecast({ date: "2026-07-30" }); // far out
  assert.equal(r.ok, false);
  assert.match(r.error, /horizon|days out/);
  assert.equal(calls.length, 0); // rejected before hitting the API
});

test("forecast() for a date the API didn't return is a graceful non-error (truncation-safe)", async () => {
  const { fetchImpl } = makeFetch({ forecast: forecastResp({ dates: ["2026-06-06"] }) });
  const w = createWeather({ fetchImpl, clock: CLOCK });
  const r = await w.forecast({ date: "2026-06-08" });
  assert.equal(r.ok, false);
  assert.match(r.error, /horizon|days out/);
});

test("forecast() with a missing 8am hour still returns high/low, no 8am clause", async () => {
  const hourly = { time: ["2026-06-06T09:00"], temperature_2m: [15], weather_code: [0] };
  const { fetchImpl } = makeFetch({ forecast: forecastResp({ dates: ["2026-06-06"], hourly }) });
  const w = createWeather({ fetchImpl, clock: CLOCK });
  const r = await w.forecast({});
  assert.equal(r.ok, true);
  assert.doesNotMatch(r.text, /8am/);
  assert.match(r.text, /High 21°C, low 11°C\./);
});

test("forecast() renders 0% rain as a real value, not n/a", async () => {
  const { fetchImpl } = makeFetch({ forecast: forecastResp({ dates: ["2026-06-06"], daily: { precipitation_probability_max: [0] } }) });
  const w = createWeather({ fetchImpl, clock: CLOCK });
  const r = await w.forecast({});
  assert.match(r.text, /Chance of rain 0%\./);
});

test("forecast() rejects a malformed date", async () => {
  const { fetchImpl } = makeFetch({});
  const w = createWeather({ fetchImpl, clock: CLOCK });
  const r = await w.forecast({ date: "next friday" });
  assert.equal(r.ok, false);
  assert.match(r.error, /YYYY-MM-DD/);
});

test("forecast() rejects a past date", async () => {
  const { fetchImpl } = makeFetch({});
  const w = createWeather({ fetchImpl, clock: CLOCK });
  const r = await w.forecast({ date: "2026-06-01" });
  assert.equal(r.ok, false);
  assert.match(r.error, /past/);
});

test("forecast() surfaces a network failure gracefully", async () => {
  const { fetchImpl } = makeFetch({ forecast: { fail: true, status: 500, body: "boom" } });
  const w = createWeather({ fetchImpl, clock: CLOCK });
  const r = await w.forecast({});
  assert.equal(r.ok, false);
  assert.match(r.error, /weather service/);
});

test("start() refreshes immediately and schedules; firing reschedules; stop() clears", () => {
  const { fetchImpl, calls } = makeFetch({ current: CURRENT });
  const s = makeScheduler();
  const w = createWeather({ fetchImpl, scheduler: s.scheduler, clear: s.clear });
  w.start();
  assert.equal(calls.length, 1);     // immediate refresh fired synchronously
  assert.equal(s.calls.length, 1);   // and one timer scheduled
  assert.equal(s.calls[0].ms, 1800000);
  s.calls[0].fn();                   // simulate the 30-min tick
  assert.equal(calls.length, 2);     // refreshed again
  assert.equal(s.calls.length, 2);   // and rescheduled (clearing the prior handle)
  w.stop();
  assert.equal(s.clearedCount(), 2); // one clear on reschedule, one on stop
});

test("start() is idempotent", () => {
  const { fetchImpl } = makeFetch({ current: CURRENT });
  const s = makeScheduler();
  const w = createWeather({ fetchImpl, scheduler: s.scheduler, clear: s.clear });
  w.start();
  w.start();
  assert.equal(s.calls.length, 1);
});
