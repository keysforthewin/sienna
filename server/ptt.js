// Push-to-talk conversation coordinator.
//
// The device has a physical PTT button (GPIO 45) and emits
// {type:"button", id:"ptt", pressed} edges. This coordinator turns a hold into
// one agent turn:
//   - press  → MUTE the speaker transmit gate (audio-out.js): nothing is stopped
//     or paused — her reply and any music keep playing SILENTLY (frames dropped
//     server-side at realtime) and whatever is still going is audible again on
//     unmute. Then open the shared Scribe transcriber (which acquires the device
//     mic via the arbiter);
//   - hold   → committed transcripts accumulate (ElevenLabs VAD may finalize
//     mid-hold pauses as separate commits — they're joined, not routed);
//   - release→ after a short grace (lets the trailing mic frames land in
//     Scribe), force-commit the buffered tail (transcriber.commitNow), wait for
//     the resulting commit (or time out), then stop the transcriber and route
//     the JOINED text to the agent as ONE source:"ptt" turn.
//
// There is deliberately NO continuation window: every utterance needs the
// button. When she initiates a conversation on her own (reflection/autonomy),
// you still answer by pressing the button.
//
// Guards that earn their keep:
//   B1 — ownership is reconciled to the transcriber's REAL state on every press
//        (the session can die underneath us: Scribe onError/onClose, or a manual
//        Speech-panel Stop). A manual Speech-panel session is never hijacked.
//   B2 — the stuck-button cap (maxHoldMs): a lost release event (Wi-Fi blip,
//        device reset mid-hold) must not pin the mic open forever.
//
// Unowned path: defensive — if a transcriber session we didn't start is ever
// active (no UI starts one today; voice input is PTT-only), its commits route
// per-utterance verbatim as source:"ptt", except while her own TTS is audible
// (echo).

export function createPttCoordinator({
  transcriber,                       // start/stop/isActive/commitNow
  runAgent = () => Promise.resolve(),// (text, source) => Promise — runs the agent turn
  mute = () => {},                   // () => audioOut.mute() — speaker transmit gate ON
  unmute = () => {},                 // () => audioOut.unmute() — gate off (at finalize, NOT raw
                                     // release: the speaker must stay silent through the release
                                     // grace + forced commit so music never lands in the transcript)
  isSpeakerAudible = () => false,    // () => audioOut.isPlayingOrTail() — unowned echo guard
  onListenStart = () => {},          // () => the listen beep ("I'm listening") — fired when a
                                     // fresh press actually opens the mic; NOT on a re-press
                                     // resume or when the transcriber can't start
  onRouted = () => {},               // () => the commit beep ("I heard you")
  maxHoldMs = 60000,                 // stuck button / lost release safety cap
  releaseGraceMs = 300,              // wait for trailing device frames before the forced commit
  commitTimeoutMs = 2000,            // give up waiting for the forced commit's transcript
  scheduler = setTimeout,
  clear = clearTimeout,
  log = () => {},
}) {
  let state = "idle";   // idle | held | finalizing
  let owns = false;     // we started the transcriber session (vs a manual Speech one)
  let parts = [];       // commits accumulated during the current hold
  let commitRequested = false;  // the release's forced commit is in flight
  let holdTimer = null, graceTimer = null, commitTimer = null;

  function arm(fn, ms) {
    const h = scheduler(fn, ms);
    if (h && typeof h.unref === "function") h.unref();
    return h;
  }
  function clearAll() {
    if (holdTimer) { clear(holdTimer); holdTimer = null; }
    if (graceTimer) { clear(graceTimer); graceTimer = null; }
    if (commitTimer) { clear(commitTimer); commitTimer = null; }
  }

  function onButton(pressed) { if (pressed) press(); else release(); }

  function press() {
    // Transmit-mute FIRST, in every state: while the button is down, no speaker
    // PCM reaches the device (mute() is idempotent; the device beeps still work —
    // play_tone is synthesized on-device, not PCM).
    try { mute(); } catch { /* isolate */ }
    if (state === "finalizing") {
      // Re-press while the previous release is still finalizing: cancel the
      // finalization and resume the hold on the SAME session (natural
      // double-click behavior; the accumulated parts carry over).
      clearAll();
      commitRequested = false;
      state = "held";
      holdTimer = arm(onMaxHold, maxHoldMs);
      log("re-press — resumed hold");
      return;
    }
    if (state === "held") { log("duplicate press ignored"); return; }
    // idle.
    if (owns && !transcriber.isActive()) owns = false;   // B1: reconcile stale ownership
    if (transcriber.isActive() && !owns) { log("press ignored — a manual Speech session owns the mic"); return; }
    // Cue IMMEDIATELY on the press edge — before transcriber.start(). scribe.js
    // buffers and flushes anything spoken before the mic/Scribe actually open,
    // so the "I'm listening" beep no longer needs to wait for (or depend on) the
    // session coming up; it fires even when Scribe is offline/unconfigured. The
    // cue now means "you pressed", not "mic ready".
    try { onListenStart(); } catch { /* a beep must not break listening */ }
    transcriber.start();
    if (!transcriber.isActive()) { log("press — transcriber didn't start (offline / not_configured)"); return; }
    owns = true;
    parts = [];
    state = "held";
    holdTimer = arm(onMaxHold, maxHoldMs);
    log("press — mic open");
  }

  function release() {
    if (state !== "held") {
      // Ignored edge. Unmute only when truly idle (e.g. the press never opened a
      // hold) — while "finalizing" the imminent finalize() owns the unmute on
      // EVERY path (commit observed / commit timeout / commitNow failed), so a
      // late physical release after the max-hold auto-finalize must NOT re-arm
      // the speaker while trailing mic frames are still being committed.
      if (state === "idle") {
        try { unmute(); } catch { /* isolate */ }
        log("release ignored (state=idle) — unmuted");
      } else {
        log(`release ignored (state=${state}) — finalize will unmute`);
      }
      return;
    }
    state = "finalizing";
    if (holdTimer) { clear(holdTimer); holdTimer = null; }
    graceTimer = arm(() => {
      graceTimer = null;
      // Flag BEFORE the send: the commit's answer can arrive synchronously
      // (in-process tests) or fast enough to beat the timer arm below.
      commitRequested = true;
      const sent = transcriber.commitNow ? transcriber.commitNow() : false;
      if (!sent) { finalize(); return; }                 // session died / inactive — go with what we have
      if (state !== "finalizing") return;                // the answer already finalized us
      commitTimer = arm(() => {
        commitTimer = null;
        log("forced commit timed out — finalizing with accumulated parts");
        finalize();
      }, commitTimeoutMs);
    }, releaseGraceMs);
    log("release — finalizing");
  }

  function onMaxHold() {
    holdTimer = null;
    if (state !== "held") return;
    log(`held past the ${maxHoldMs} ms cap (stuck button / lost release?) — auto-finalizing`);
    release();
  }

  // Stop the session, then route the joined hold as ONE agent turn.
  function finalize() {
    try { unmute(); } catch { /* isolate */ }
    clearAll();
    commitRequested = false;
    const text = parts.join(" ").trim();
    parts = [];
    state = "idle";
    if (owns) { owns = false; transcriber.stop(); }
    if (!text) { log("finalized with no speech — nothing routed"); return; }
    try { onRouted(); } catch { /* a beep must not break routing */ }
    log(`routed → agent (ptt) len=${text.length}`);
    Promise.resolve(runAgent(text, "ptt")).catch(() => {});
  }

  // A committed transcript arrived (non-empty; transcriber filters blanks).
  function onUtterance(text) {
    if (state === "held" || state === "finalizing") {
      parts.push(text);
      log(`utterance accumulated (${parts.length}) len=${text.length}`);
      return;       // finalize() runs from onCommitObserved / timers, never here
    }
    // Unowned: a manual Speech-panel session — route verbatim per commit, but
    // drop her own echo while her TTS is actually audible (playing or its tail).
    if (isSpeakerAudible()) { log(`utterance DROPPED (unowned, speaker audible) len=${text.length}`); return; }
    try { onRouted(); } catch { /* isolate */ }
    log(`utterance → agent (ptt, unowned) len=${text.length}`);
    Promise.resolve(runAgent(text, "ptt")).catch(() => {});
  }

  // EVERY commit (including empty ones, which never reach onUtterance) lands
  // here AFTER onUtterance. Once the forced commit is in flight, the next
  // observed commit — empty or not — is its answer: finalize immediately
  // instead of waiting out commitTimeoutMs.
  function onCommitObserved() {
    if (state === "finalizing" && commitRequested) finalize();
  }

  // Explicit stand-down (the `stop` tool): abort any session, route nothing.
  function endNow() {
    try { unmute(); } catch { /* isolate */ }
    clearAll();
    commitRequested = false;
    parts = [];
    state = "idle";
    if (owns) { owns = false; transcriber.stop(); }
  }

  // Device disconnect. index.js already tears the transcriber down
  // (handleDeviceDisconnect + micStream.reset), so deliberately do NOT call
  // transcriber.stop() — that would double-release the "transcription" token.
  function cancel() {
    try { unmute(); } catch { /* isolate */ }
    clearAll();
    commitRequested = false;
    parts = [];
    state = "idle";
    owns = false;
  }

  return { onButton, onUtterance, onCommitObserved, endNow, cancel, isHeld: () => state === "held" };
}
