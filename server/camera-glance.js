// Daily camera glance: the visual sibling of eavesdrop, built on the same ambient
// scheduler. At most once a day, only during waking hours (default 7am–10pm
// Eastern), she snaps a single frame, has vision analyze it, and — ONLY if a
// person is visible — reacts out loud in her own voice; an empty room is silent.
//
// Person-detection lives here, not in the agent: vision answers a structured
// "PERSON: yes/no" so we can keep quiet without relying on the interactive loop
// (which auto-speaks its closing line). When someone IS there we route a normal
// interactive turn (source "glance") and let her speak. Gated exactly like
// eavesdrop: the once-a-day rate-limit + active-hours window, the Autonomous-speech
// toggle, and a skip whenever a conversation is in flight.

import { createAmbientTrigger } from "./ambient.js";
import { isWithinActiveHours } from "./active-hours.js";

const GLANCE_QUESTION =
  "This is a frame from your own camera. On the FIRST line write exactly 'PERSON: yes' if a person is visible, " +
  "otherwise 'PERSON: no'. Then, in a sentence or two, describe what you see — and if someone is there, what they " +
  "look like and seem to be doing.";

export function createCameraGlance({
  agent,            // run(input,{source}), busy(), getAutonomy()
  deviceRpc,        // requestBinary({type:"snapshot"},{expectTag})
  vision,           // describe(jpeg,{question})
  ptt,              // isHeld()
  transcriber,      // isActive()
  audioOut,         // isPlayingOrTail()
  micListener,      // isActive()  (so we don't snap+speak mid-eavesdrop)
  intervalMs = 86400000,   // min gap between glances; 0 disables
  checkMs = 1800000,       // how often to poll for an opening
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
    let jpeg;
    try {
      jpeg = await deviceRpc.requestBinary({ type: "snapshot" }, { expectTag: 0x02 });
    } catch (e) {
      log(`snapshot failed: ${e?.message || e}`);
      return false;                       // couldn't capture (offline) → don't burn the day, retry later
    }
    if (!jpeg || !jpeg.length) return false;

    let desc;
    try {
      desc = (await vision.describe(jpeg, { question: GLANCE_QUESTION })) || "";
    } catch (e) {
      log(`vision failed: ${e?.message || e}`);
      return true;                        // she DID glance; a vision hiccup shouldn't retry-spam
    }

    if (!/person:\s*yes/i.test(desc)) {   // empty room → stay quiet
      log("glance: no one around");
      return true;
    }
    if (conversationInFlight()) return true;   // a real conversation took over mid-glance

    const scene = desc.replace(/person:\s*(yes|no)/i, "").trim();
    log(`glance saw someone: ${scene.slice(0, 80)}`);
    agent.run(
      `(You quietly glanced around the room through your camera and noticed someone is here. This is what you saw:) ${scene}\n\n` +
      `Say hello or remark on what you notice — you're seeing them, not being addressed, so keep it natural and brief.`,
      { source: "glance" },
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
