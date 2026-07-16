// Speech monitor widget. Voice input is the device's physical push-to-talk
// button only — this panel just SHOWS it happening: a live indicator while the
// button is held (driven by the broadcast {type:"button",id:"ptt",pressed}
// device events), interim words as they arrive (greyed), and each finalized
// phrase prepended as a timestamped row to a scrollable log. Nothing here sends
// audio or starts transcription — the server's PTT coordinator collects the
// hold's transcripts and routes them to Sienna when the button is released.
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
      <button class="speech-clear">Clear</button>
    </div>
  `;

  const dotEl = container.querySelector(".ptt-dot");
  const labelEl = container.querySelector(".ptt-label");
  const statusEl = container.querySelector(".speech-status");
  const interimEl = container.querySelector(".speech-interim");
  const logEl = container.querySelector(".speech-log");
  const listEl = container.querySelector(".speech-log-list");
  const clearBtn = container.querySelector(".speech-clear");

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

  clearBtn.addEventListener("click", () => {
    listEl.replaceChildren();
    interimEl.textContent = "";
  });

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
