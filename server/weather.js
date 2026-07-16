// Weather for the Sienna agent, via Open-Meteo (https://open-meteo.com).
//
// Open-Meteo is free and needs NO API key, and its forecast horizon is up to 16
// days — so check_weather can answer "this Friday" (and well beyond), unlike the
// old WeatherAPI.com free tier which capped at ~3 days.
//
// Two capabilities:
//   - refresh()/current(): the AMBIENT current conditions. refresh() pulls the
//     `current=` block every refreshMs and caches a one-line string that the agent
//     loop injects into her "Right now" context block (the volatile, never-cached
//     part of the prompt — it changes every 30 min, so it must stay out of the
//     cached prefix). It swallows its own errors and keeps the last good value.
//   - forecast({date}): backs the check_weather tool. It returns the day's 8am
//     snapshot plus the high/low, resolving a default of "today" in the device's
//     timezone and reporting a friendly message when a day is beyond the forecast
//     horizon (~16 days out).
//
// Modeled on reflection.js (injected scheduler/clock, unref'd self-rescheduling
// timer) and tts.js (AbortSignal.timeout, status-only error text). Conditions are
// requested in metric units (°C, km/h) to match the ambient line's formatting.

const TZ = "America/Toronto";
const BASE = "https://api.open-meteo.com/v1/forecast";
const TIMEOUT_MS = 10000;
const MAX_FORECAST_DAYS = 16; // Open-Meteo's free forecast horizon

const r0 = (n) => Math.round(Number(n));

// WMO weather interpretation codes → human text. Open-Meteo reports conditions as
// these numeric codes (https://open-meteo.com/en/docs#weathervariables); we render
// the same kind of short phrase WeatherAPI gave us ("Partly cloudy", "Light rain").
const WMO = {
  0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Depositing rime fog",
  51: "Light drizzle", 53: "Moderate drizzle", 55: "Dense drizzle",
  56: "Light freezing drizzle", 57: "Dense freezing drizzle",
  61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
  66: "Light freezing rain", 67: "Heavy freezing rain",
  71: "Slight snow", 73: "Moderate snow", 75: "Heavy snow", 77: "Snow grains",
  80: "Slight rain showers", 81: "Moderate rain showers", 82: "Violent rain showers",
  85: "Slight snow showers", 86: "Heavy snow showers",
  95: "Thunderstorm", 96: "Thunderstorm with slight hail", 99: "Thunderstorm with heavy hail",
};
const wmoText = (code) => WMO[code] ?? "Unknown conditions";

// "today" in the device's timezone as YYYY-MM-DD. The explicit 2-digit parts (not
// dateStyle) guarantee exactly that shape, which we then do date math on.
function tzToday(now) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

// Whole-day delta between two YYYY-MM-DD strings, UTC-anchored so wall-clock/DST
// never shifts the count.
function dayOffset(todayStr, targetStr) {
  return Math.round(
    (Date.parse(targetStr + "T00:00:00Z") - Date.parse(todayStr + "T00:00:00Z")) / 86400000,
  );
}

// Friendly "Saturday, June 6, 2026" for a YYYY-MM-DD. Anchored at noon UTC so the
// rendered date never flips a day under the timezone offset.
function humanDate(targetStr) {
  return new Intl.DateTimeFormat("en-CA", { dateStyle: "full", timeZone: TZ }).format(
    new Date(targetStr + "T12:00:00Z"),
  );
}

export function createWeather({
  lat = 45.3333,
  lon = -75.9,
  refreshMs = 1800000,
  fetchImpl = fetch,
  clock = () => Date.now(),
  scheduler = setTimeout,
  clear = clearTimeout,
  log = () => {},
} = {}) {
  const where = `latitude=${lat}&longitude=${lon}`;
  const tz = `timezone=${encodeURIComponent(TZ)}`;
  let ambient = null; // cached one-line current-conditions string, or null
  let handle = null;
  let started = false;

  async function getJson(query) {
    const res = await fetchImpl(`${BASE}?${query}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 200);
      } catch {
        /* ignore */
      }
      throw new Error(`open-meteo ${res.status}: ${detail}`);
    }
    return res.json();
  }

  // Pull current conditions and cache the ambient line. Resolves on failure
  // (logs and keeps the previous value) so the scheduled tick never rejects.
  async function refresh() {
    try {
      const data = await getJson(
        `${where}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&${tz}`,
      );
      const c = data.current;
      ambient = `${wmoText(c.weather_code)}, ${r0(c.temperature_2m)}°C (feels ${r0(c.apparent_temperature)}°C), wind ${r0(c.wind_speed_10m)} km/h, humidity ${r0(c.relative_humidity_2m)}%`;
    } catch (e) {
      log(`refresh failed (keeping previous): ${e.message}`);
    }
  }

  const current = () => ambient;

  // Forecast for a single day. Returns { ok:true, text } or { ok:false, error }
  // (the tool-facing result convention, like micListener.listen).
  async function forecast({ date } = {}) {
    const today = tzToday(new Date(clock()));
    const target = date ?? today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(target)) {
      return { ok: false, error: `Bad date "${target}" — use YYYY-MM-DD.` };
    }
    const off = dayOffset(today, target);
    if (off < 0) {
      return { ok: false, error: "I can only forecast today and the days ahead, not the past." };
    }
    if (off >= MAX_FORECAST_DAYS) {
      return { ok: false, error: `That day is beyond the forecast horizon (about ${MAX_FORECAST_DAYS} days out).` };
    }
    let data;
    try {
      const days = Math.min(off + 1, MAX_FORECAST_DAYS);
      data = await getJson(
        `${where}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&hourly=temperature_2m,weather_code&forecast_days=${days}&${tz}`,
      );
    } catch (e) {
      log(`forecast failed: ${e.message}`);
      return { ok: false, error: "Couldn't reach the weather service just now." };
    }
    // Open-Meteo returns parallel arrays keyed by date; select by the date string,
    // never by index, so a short/shifted window can't misattribute a day.
    const days = data.daily || {};
    const i = (days.time || []).indexOf(target);
    if (i < 0) {
      return { ok: false, error: `That day is beyond the forecast horizon (about ${MAX_FORECAST_DAYS} days out).` };
    }
    const condition = wmoText(days.weather_code?.[i]);
    const maxt = days.temperature_2m_max?.[i];
    const mint = days.temperature_2m_min?.[i];
    const rain = days.precipitation_probability_max?.[i] ?? 0;
    // 8am by the local hour string ("YYYY-MM-DDT08:00"), never hour[8]: arrays are
    // local-time and a partial first day could shift the index.
    const hours = data.hourly || {};
    const hi = (hours.time || []).indexOf(`${target}T08:00`);
    const at8 = hi >= 0
      ? ` At 8am: ${r0(hours.temperature_2m[hi])}°C, ${wmoText(hours.weather_code?.[hi])}.`
      : "";
    const text = `Forecast for ${humanDate(target)}: ${condition}.${at8} High ${r0(maxt)}°C, low ${r0(mint)}°C. Chance of rain ${rain}%.`;
    return { ok: true, text };
  }

  function schedule() {
    if (handle) {
      clear(handle);
      handle = null;
    }
    handle = scheduler(() => {
      refresh().catch(() => {});
      schedule();
    }, refreshMs);
    if (handle && typeof handle.unref === "function") handle.unref();
  }

  function start() {
    if (started) return;
    started = true;
    refresh().catch(() => {}); // immediate, non-blocking — a dead API can't delay boot
    schedule();
  }

  function stop() {
    if (handle) {
      clear(handle);
      handle = null;
    }
    started = false;
  }

  return { refresh, current, forecast, start, stop };
}
