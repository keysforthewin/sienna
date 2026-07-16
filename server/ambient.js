// Shared scheduler for Sienna's once-a-day ambient autonomy (eavesdrop + camera
// glance). A periodic tick polls whether it's time to act; the real gating is a
// daily rate-limit plus an active-hours window, so the tick cadence only bounds
// how soon after the window opens she acts.
//
// On each tick (every checkMs): reschedule first (steady cadence), then bail
// unless — not already running, the active-hours window is open (withinHours),
// the situation is clear (gate: autonomy on, no conversation in flight), and at
// least minIntervalMs has passed since the last completed action. When all hold,
// run() performs the action; if it returns truthy (it actually acted — e.g. the
// device was online) the daily clock resets. A falsy or throwing run() doesn't
// burn the day, so a brief outage just retries on the next tick.

export function createAmbientTrigger({
  checkMs,                    // poll cadence; 0 disables
  minIntervalMs = 0,          // minimum gap between completed actions
  withinHours = () => true,   // (nowMs) => bool
  gate = () => true,          // () => bool : autonomy on, no conversation in flight
  run,                        // async () => boolean (true = acted; resets the daily clock)
  clock = () => Date.now(),
  scheduler = setTimeout,
  clear = clearTimeout,
  log = () => {},
}) {
  let handle = null;
  let started = false;
  let inFlight = false;
  let lastAt = -Infinity;

  function schedule() {
    if (handle) { clear(handle); handle = null; }
    if (!checkMs) return;                       // 0 ⇒ disabled
    handle = scheduler(onTick, checkMs);
    if (handle && typeof handle.unref === "function") handle.unref();
  }

  async function onTick() {
    schedule();                                 // steady cadence, regardless of outcome
    if (inFlight) return;                        // re-entrancy guard
    if (!withinHours(clock())) return;           // outside waking hours
    if (!gate()) return;                         // autonomy off / conversation in flight
    if (clock() - lastAt < minIntervalMs) return;// already acted today
    inFlight = true;
    try {
      if (await run()) lastAt = clock();         // only a real action burns the daily clock
    } catch (e) {
      log(`ambient run failed: ${e?.message || e}`);
    } finally {
      inFlight = false;
    }
  }

  function start() { if (!started) { started = true; schedule(); } }
  function stop() { if (handle) { clear(handle); handle = null; } started = false; }

  return { start, stop, onTick };
}
