// Pure helpers for the Sienna card strips — kept DOM-free so the fiddly bits
// (auto-scroll "stick" math + per-kind card display) are unit-tested in isolation
// (mirrors paced-sender.js). The DOM glue lives in sienna.js.

// All strips put newest on the RIGHT and auto-scroll right on a new entry — but
// only when the user is already at the right edge (so we don't yank them back
// while they're browsing history). Horizontal analog of the old feed's atBottom().
export function shouldStick({ scrollLeft, scrollWidth, clientWidth }, threshold = 40) {
  return scrollWidth - scrollLeft - clientWidth < threshold;
}

// Coarse relative time ("now" / "5m" / "2h" / "3d"); empty for a missing ts.
export function relTime(ts, now) {
  if (ts == null) return "";
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// The dashboard renders every wall-clock time in the user's zone (Eastern),
// matching the agent's own sense of time (prompt.js). Hard-coded rather than read
// from the browser, so the dashboard viewed from a phone or laptop in another
// zone still shows Sienna's local time, not the viewer's.
export const DISPLAY_TZ = "America/Toronto";

// Explicit absolute timestamp for a card ("Jun 7, 2:45 PM"); empty for a missing
// ts. Shown alongside relTime so every log line carries a real date/time.
export function absTime(ts) {
  if (ts == null) return "";
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
      timeZone: DISPLAY_TZ,
    });
  } catch {
    return new Date(ts).toLocaleString();
  }
}

// Tools that drive one of Sienna's OUTPUT devices — her speaker (voice, tones,
// music, volume) or her LEDs. Cards for these get a special graphic so an
// at-a-glance scan of the tool history shows when she physically acted on the
// world vs. just thought/looked/recalled.
const AUDIO_TOOLS = new Set([
  "speak", "play_tone", "play_audio_file", "play_youtube", "play_music",
  "skip_song", "play_more_like_this", "stop_audio", "stop", "set_volume",
]);
const LIGHT_TOOLS = new Set(["set_blue_led", "set_white_leds", "set_rgb"]);

// The output-device graphic for a tool name: a speaker for audio, a bulb for
// LEDs, empty for everything else (look, recall, scans, timers, weather…).
export function toolIcon(name) {
  if (AUDIO_TOOLS.has(name)) return "🔊";
  if (LIGHT_TOOLS.has(name)) return "💡";
  return "";
}
export function isOutputTool(name) {
  return AUDIO_TOOLS.has(name) || LIGHT_TOOLS.has(name);
}

// Turn a card object (toCard output, or a client-built tool card) into the flat
// display strings the renderer needs. No DOM, no time (relTime is applied at
// render so the value can refresh).
export function cardModel(card) {
  const body = card.content || "";
  if (card.kind === "message") {
    const bits = [];
    if (card.source) bits.push(card.source);
    if (card.role === "assistant" && card.spoken) bits.push("🔊");
    return { kind: "message", role: card.role, label: card.role === "user" ? "you" : "sienna", meta: bits.join(" · "), body, tags: [], title: body };
  }
  if (card.kind === "memory") {
    return { kind: "memory", role: null, label: "memory", meta: card.source || "", body, tags: Array.isArray(card.tags) ? card.tags : [], title: body };
  }
  if (card.kind === "personality") {
    const label = card.current ? `personality v${card.version} · current` : `personality v${card.version}`;
    return { kind: "personality", role: null, label, meta: card.reason || "", body, tags: [], title: body };
  }
  if (card.kind === "tool") {
    // Body = the call's input, plus the result summary once it's known (the live
    // path appends "← …" in the DOM; a backfilled card already carries summary).
    const toolBody = card.summary ? `${body ? body + "\n" : ""}← ${card.summary}`.trim() : body;
    const icon = toolIcon(card.name);
    return { kind: "tool", role: null, label: `→ ${card.name}`, meta: card.is_error ? "error" : "", body: toolBody, tags: [], title: toolBody, icon, output: !!icon };
  }
  if (card.kind === "image") {
    // Body is rendered as an inline <img> by sienna.js (from card.filename), not
    // text — so body stays empty here; the head just labels it.
    return { kind: "image", role: null, label: "📷 snapshot", meta: card.source || "", body: "", tags: [], title: "camera snapshot", icon: "", output: false };
  }
  return { kind: card.kind || "", role: null, label: "", meta: "", body, tags: [], title: body, icon: "", output: false };
}
