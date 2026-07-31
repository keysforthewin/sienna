// Speech monitor widget. Voice input is push-to-talk: the device's physical
// button, or this panel's on-screen "Push to talk" button — hold it and the
// server drives the SAME coordinator (the mic that opens is the DEVICE mic, so
// you still talk to Sienna herself). The panel shows it happening: a live
// indicator while either button is held (driven by the broadcast
// {type:"button",id:"ptt",pressed} events), interim words as they arrive
// (greyed), and each finalized phrase prepended as a timestamped row to a
// scrollable log. Each press marks the log for clearing — the old text stays
// visible until the NEW hold's first words arrive, then the log resets to just
// them. Nothing here sends audio — the server's PTT coordinator collects the
// hold's transcripts and routes them to Sienna on release.
// Uses local element refs (no global ids) so it can be mounted more than once.

import { DISPLAY_TZ } from "./sienna-strip.js";

export function mountSpeech(client, container, opts = {}) {
  if (!container) return;
  const heading = opts.heading ? `<h2>${opts.heading}</h2>` : "";

  container.innerHTML = `
    ${heading}
    <div class="speech-controls">
      <span class="ptt-dot dot bad" title="push-to-talk"></span>
      <span class="ptt-label">Push-to-talk</span>
      <span class="speech-status"></span>
    </div>
    <div class="speech-interim"></div>
    <div class="speech-log"><div class="speech-log-list"></div></div>
    <div class="speech-actions">
      <button class="speech-ptt" title="Hold to talk to Sienna (uses her device mic)">🎙 Push to talk</button>
    </div>
  `;

  const dotEl = container.querySelector(".ptt-dot");
  const labelEl = container.querySelector(".ptt-label");
  const statusEl = container.querySelector(".speech-status");
  const interimEl = container.querySelector(".speech-interim");
  const logEl = container.querySelector(".speech-log");
  const listEl = container.querySelector(".speech-log-list");
  const pttBtn = container.querySelector(".speech-ptt");

  const setStatus = (s) => { statusEl.textContent = s; };

  // A finalized phrase becomes a new row at the TOP of the log — a running history
  // of everything heard while the page's been open. Mirror the Sienna feed's
  // scroll-hold (sienna.js prependLive): if the reader has scrolled down into older
  // entries, nudge them down by the new row's height so their view stays put; if
  // they're at the top, the newest is simply revealed.
  const appendFinal = (text) => {
    const row = document.createElement("div");
    row.className = "speech-log-item";
    const time = document.createElement("span");
    time.className = "speech-log-time";
    time.textContent = new Date().toLocaleTimeString(undefined, { timeZone: DISPLAY_TZ });
    const body = document.createElement("span");
    body.className = "speech-log-text";
    body.textContent = text;
    row.append(time, body);
    const atTop = logEl.scrollTop <= 4;
    listEl.prepend(row);
    if (!atTop) logEl.scrollTop += row.offsetHeight;
  };

  // ---- on-screen push-to-talk ----
  // Hold-to-talk semantics, mirroring the physical button: press edge sends
  // {type:"ptt", pressed:true}, release sends false, and the server drives the
  // same coordinator (mute → listen beep → transcribe → route on release).
  // Every press marks the log to clear as soon as this hold's first words
  // arrive (final or interim) — replacing the old dedicated Clear button.
  let pendingClear = false;
  let held = false;
  const sendEdge = (pressed) => {
    if (pressed === held) return;                 // dedupe (pointer + key combos)
    held = pressed;
    pttBtn.classList.toggle("holding", pressed);
    if (pressed) pendingClear = true;
    client.send({ type: "ptt", pressed });
  };
  pttBtn.addEventListener("pointerdown", (e) => {
    if (pttBtn.disabled) return;
    e.preventDefault();
    try { pttBtn.setPointerCapture(e.pointerId); } catch { /* capture is best-effort */ }
    sendEdge(true);
  });
  pttBtn.addEventListener("pointerup", () => sendEdge(false));
  pttBtn.addEventListener("pointercancel", () => sendEdge(false));
  pttBtn.addEventListener("contextmenu", (e) => e.preventDefault()); // touch long-press
  // Keyboard hold: Space/Enter down = press, up = release (suppress the native
  // click-on-space so it can't double-fire).
  pttBtn.addEventListener("keydown", (e) => {
    if (e.key !== " " && e.key !== "Enter") return;
    e.preventDefault();
    if (!e.repeat) sendEdge(true);
  });
  pttBtn.addEventListener("keyup", (e) => {
    if (e.key === " " || e.key === "Enter") { e.preventDefault(); sendEdge(false); }
  });
  pttBtn.addEventListener("blur", () => sendEdge(false));

  // ---- PTT held indicator ----
  // Driven by the forwarded device button events. A safety timer (just past the
  // server's 60 s max-hold cap) self-heals if the release event is ever missed.
  let heldTimer = null;
  const setHeld = (held) => {
    clearTimeout(heldTimer); heldTimer = null;
    dotEl.classList.toggle("good", held);
    dotEl.classList.toggle("bad", !held);
    dotEl.classList.toggle("ptt-live", held);
    labelEl.textContent = held ? "Listening — release to send" : "Push-to-talk";
    if (held) heldTimer = setTimeout(() => setHeld(false), 65000);
  };

  client.addEventListener("msg:button", (ev) => {
    if (ev.detail.id !== "ptt") return;
    setHeld(Boolean(ev.detail.pressed));
  });

  // The server-side session state (the mic actually opened / closed). Secondary
  // to the button indicator, but it also reflects her `listen` tool and surfaces
  // errors like not_configured.
  client.addEventListener("msg:transcription_state", (ev) => {
    if (ev.detail.active) {
      delete statusEl.dataset.error;
      setStatus("transcribing…");
    } else {
      if (!statusEl.dataset.error) setStatus("");
      interimEl.textContent = "";
    }
  });

  client.addEventListener("msg:transcript", (ev) => {
    const { final, text } = ev.detail;
    if (!text) return;
    // The first words after a Push-to-talk press replace the previous hold's
    // text — the log clears exactly when new text arrives, never sooner.
    if (pendingClear) {
      pendingClear = false;
      listEl.replaceChildren();
      interimEl.textContent = "";
    }
    if (final) {
      appendFinal(text);
      interimEl.textContent = "";
    } else {
      interimEl.textContent = text;
    }
  });

  client.addEventListener("msg:transcription_error", (ev) => {
    statusEl.dataset.error = "1";
    setStatus(`error: ${ev.detail.error}`);
  });

  client.addEventListener("msg:device_disconnected", () => setHeld(false));
}
