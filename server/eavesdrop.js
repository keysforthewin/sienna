// Daily eavesdrop: ambient mic listening, built on the shared ambient scheduler.
//
// At most once a day, only during waking hours (default 7am–10pm Eastern), she
// quietly opens the mic for `seconds` via micListener and routes overheard speech
// to the agent as an interactive turn (source "eavesdrop") she may join; silence
// is ignored. The once-a-day rate-limit + active-hours window (see ambient.js /
// active-hours.js) do the gating, plus the Autonomous-speech toggle and a skip
// whenever a real conversation is — or becomes — in flight. agent.run() for a
// non-reflection source schedules her reflection sequence itself, so an overheard
// exchange also seeds reflection.

import { createAmbientTrigger } from "./ambient.js";
import { isWithinActiveHours } from "./active-hours.js";

export function createEavesdrop({
  agent,            // run(input,{source}), busy(), getAutonomy()
  micListener,      // listen({seconds,maxSeconds}), isActive()
  transcriber,      // isActive()
  ptt,              // isHeld()
  audioOut,         // isPlayingOrTail()
  intervalMs = 86400000,   // min gap between eavesdrops; 0 disables
  checkMs = 1800000,       // how often to poll for an opening
  seconds = 60,
  startHour = 7,
  endHour = 22,
  tz = "America/Toronto",
  clock = () => Date.now(),
  scheduler = setTimeout,
  clear = clearTimeout,
  log = () => {},
}) {
  function conversationInFlight() {
    return agent.busy() || ptt.isHeld() || transcriber.isActive();
  }

  function gate() {
    if (!agent.getAutonomy()) return false;
    if (conversationInFlight() || micListener.isActive() || audioOut.isPlayingOrTail()) return false;
    return true;
  }

  async function run() {
    // maxSeconds === seconds lets this exceed the `listen` tool's clamp (it runs
    // out-of-band, not inside a SIENNA_RUN_TIMEOUT_MS-bounded agent turn).
    const res = await micListener.listen({ seconds, maxSeconds: seconds });
    if (!res.ok) return false;            // couldn't listen (offline/busy) → don't burn the day, retry later
    const text = (res.heardSpeech ? res.transcript || "" : "").trim();
    if (!text) return true;               // listened, heard nothing → that was today's eavesdrop
    // A real conversation may have started DURING the window — that utterance
    // already routed via PTT; don't double-route it.
    if (conversationInFlight()) return true;
    log(`overheard: ${text}`);
    agent.run(
      `(You overheard someone speaking nearby — they weren't addressing you, but you may join in if you have something to add:) ${text}`,
      { source: "eavesdrop" },
    ).catch(() => {});
    return true;
  }

  const trigger = createAmbientTrigger({
    checkMs: intervalMs ? checkMs : 0,    // intervalMs 0 disables the whole feature
    minIntervalMs: intervalMs,
    withinHours: (nowMs) => isWithinActiveHours(new Date(nowMs), { startHour, endHour, tz }),
    gate, run, clock, scheduler, clear, log,
  });

  return { start: trigger.start, stop: trigger.stop, onTick: trigger.onTick };
}
