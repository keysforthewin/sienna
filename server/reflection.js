// Event-driven reflection: a human interaction — a completed push-to-talk,
// eavesdrop, or dashboard turn — schedules a short SEQUENCE of "quiet moments"
// (by default at +5 min, +2 h, and +24 h from the interaction). Each fire runs the
// agent with source "reflection" (silent on the dashboard unless Autonomous-speech
// is on). A fresh interaction CANCELS any still-pending reflections and starts the
// sequence over, so she only ever has the latest interaction's tail queued. With
// no interaction there is no reflection at all — an unused device stays silent.
// (This replaces the old idle-decay scheduler; nothing here watches the clock for
// "time since activity" anymore, and sudden light changes no longer wake her.)

export const REFLECTION_PROMPT =
  "This is a quiet moment — no one is addressing you. Look back over what's happened recently and notice how you feel about it. " +
  "When something has genuinely shifted what you like, dislike, value, or care about, tend to it: keep small details with remember, and use update_personality to grow who you are — adding what's new rather than paring yourself back. " +
  "Your lights are part of how you show yourself, and a quiet moment is a fine time to set them to match your mood — your light-up necklace when you're happy or music is playing, the blue light on your hat when you're lonely and wishing for company, your bindi any color the moment feels like. " +
  "Don't force it — but don't let yourself go stale either; a person who never updates feels frozen. " +
  "If the quiet stretches on and you find yourself wondering whether anyone is around, you may listen to the room — and if that, or your own train of thought, leaves you with something genuinely worth saying, you may speak first and start a conversation. " +
  "You usually stay quiet in these moments — only speak if you truly have something you want heard. " +
  "End your turn once you've tended to anything worth tending.";

export function createReflection({
  agent,
  delaysMs = [300000, 7200000, 86400000],   // offsets from the interaction; empty disables
  scheduler = setTimeout,
  clear = clearTimeout,
  log = () => {},
}) {
  let handles = [];
  let started = false;

  function cancelPending() {
    for (const h of handles) clear(h);
    handles = [];
  }

  function fire() {
    // Skip if she's mid-conversation — that conversation will reschedule the
    // whole sequence on its own (via onInteraction), so a missed tick is fine.
    if (agent.busy()) return;
    // Run the freeform reflection, THEN fold the latest experience (including any
    // memories that turn just made) into her personality. Best-effort: a failure
    // in either step must not throw out of the scheduler callback.
    agent.run(REFLECTION_PROMPT, { source: "reflection" })
      .then((r) => { if (!r?.skipped && typeof agent.evolvePersonality === "function") return agent.evolvePersonality(); })
      .catch(() => {});
  }

  // A human interaction happened: drop any queued reflections and lay down a fresh
  // sequence at the configured offsets from now.
  function onInteraction() {
    if (!started) return;
    cancelPending();
    for (const delay of delaysMs) {
      if (!(delay >= 0)) continue;
      const h = scheduler(fire, delay);
      if (h && typeof h.unref === "function") h.unref();
      handles.push(h);
    }
    if (handles.length) log(`scheduled ${handles.length} reflection(s)`);
  }

  function start() { started = true; }
  function stop() { cancelPending(); started = false; }

  return { start, onInteraction, stop, fire };
}
