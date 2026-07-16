// Is a given instant within a daily active-hours window, in a given timezone?
//
// The window is [startHour, endHour) on a 24-hour clock, local to `tz` (default
// America/Toronto, which tracks EST/EDT automatically — so "7am–10pm Eastern"
// stays correct year-round and regardless of where the server runs). Used to keep
// the eavesdrop + camera glance to waking hours. endHour is exclusive (22 ⇒ stops
// at 10 pm). A window where startHour > endHour wraps past midnight (e.g. 22–6).

export function tzHour(date, tz = "America/Toronto") {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour: "2-digit", hour12: false,
  }).formatToParts(date);
  const hp = parts.find((p) => p.type === "hour");
  let h = hp ? parseInt(hp.value, 10) : 0;
  if (h === 24) h = 0; // some ICU builds render midnight as "24"
  return h;
}

export function isWithinActiveHours(date, { startHour = 7, endHour = 22, tz = "America/Toronto" } = {}) {
  const h = tzHour(date, tz);
  if (startHour <= endHour) return h >= startHour && h < endHour;
  return h >= startHour || h < endHour; // overnight wrap-around
}
