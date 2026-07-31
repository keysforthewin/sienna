// "Speak" panel: type text → optionally Enhance with v3 audio tags → Speak it
// on Sienna's speaker. Synthesis (ElevenLabs, eleven_v3) and tag enhancement
// (Gemini) run server-side; the audio is synthesized AND streamed to the device
// entirely on the server (POST /api/tts → audioOut.speak), so the browser just
// sends text and shows status — no client-side decode/resample.

// Keep in sync with ALLOWED_TAGS in server/enhance.js.
const TAG_GROUPS = [
  { label: "Emotions", tags: ["[excited]", "[happy]", "[sad]", "[angry]", "[nervous]", "[curious]", "[sarcastic]", "[calm]", "[tired]"] },
  { label: "Reactions", tags: ["[laughs]", "[sighs]", "[gasps]", "[whispers]", "[clears throat]"] },
  { label: "Delivery", tags: ["[whispering]", "[shouting]", "[cheerfully]", "[deadpan]", "[dramatic tone]", "[pauses]"] },
];

const MAX_CHARS = 1000;

export function initTtsPanel(client) {
  const root = document.getElementById("panel-tts");
  if (!root) return;

  const palette = TAG_GROUPS.map((g) => `
    <div class="tag-group">
      <span class="tag-group-label">${g.label}</span>
      ${g.tags.map((t) => `<button type="button" class="tag-chip" data-tag="${t}">${t}</button>`).join("")}
    </div>`).join("");

  root.innerHTML = `
    <h2>Voice</h2>
    <textarea id="tts-text" maxlength="${MAX_CHARS}" rows="3"
      placeholder="Type something for Sienna to say…"></textarea>
    <div id="tts-palette" class="tag-palette">${palette}</div>
    <div style="margin-top: 8px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
      <button id="tts-enhance">✨ Enhance</button>
      <button id="tts-speak" class="primary">▶ Speak</button>
      <button id="ptt" class="primary">● Hold to talk</button>
      <span id="tts-status" style="color: var(--muted);"></span>
      <span id="ptt-status" style="color: var(--muted);"></span>
    </div>
    <div class="pacing-row" style="margin-top: 10px; display: flex; gap: 8px; align-items: center;">
      <label for="tts-music-pacing" style="color: var(--muted); min-width: 3.5em;">Music pace</label>
      <input id="tts-music-pacing" type="range" min="80" max="136" step="1" value="128"
        title="Delay between music frames (ms). Higher = nearer realtime (fewer dropped frames); lower = more buffer cushion (fewer gaps). Takes effect mid-track."
        style="flex: 1; min-width: 120px;" />
      <span id="tts-music-pacing-val" style="color: var(--muted); width: 3.6em; text-align: right;">128ms</span>
    </div>
    <div class="pacing-row" style="margin-top: 10px; display: flex; gap: 8px; align-items: center;">
      <label for="tts-voice-pacing" style="color: var(--muted); min-width: 3.5em;">Voice pace</label>
      <input id="tts-voice-pacing" type="range" min="64" max="128" step="1" value="80"
        title="Delay between her voice frames (ms). This is the DELIVERY rate into the device buffer, not how fast she talks. Higher = nearer realtime (less bank-ahead); lower = banks her reply on-device faster. Takes effect on her next reply."
        style="flex: 1; min-width: 120px;" />
      <span id="tts-voice-pacing-val" style="color: var(--muted); width: 3.6em; text-align: right;">80ms</span>
    </div>
  `;

  const textEl = root.querySelector("#tts-text");
  const enhanceBtn = root.querySelector("#tts-enhance");
  const speakBtn = root.querySelector("#tts-speak");
  const statusEl = root.querySelector("#tts-status");

  let inFlight = false;
  const setStatus = (s) => { statusEl.textContent = s; };
  const syncButtons = () => {
    const disabled = inFlight || !client.deviceConnected;
    enhanceBtn.disabled = disabled;
    speakBtn.disabled = disabled;
  };

  // Insert a tag at the caret (respecting the char cap).
  function insertTag(tag) {
    const start = textEl.selectionStart ?? textEl.value.length;
    const end = textEl.selectionEnd ?? textEl.value.length;
    const next = textEl.value.slice(0, start) + tag + textEl.value.slice(end);
    if (next.length > MAX_CHARS) return;
    textEl.value = next;
    const pos = start + tag.length;
    textEl.focus();
    textEl.setSelectionRange(pos, pos);
  }
  root.querySelector("#tts-palette").addEventListener("click", (ev) => {
    const chip = ev.target.closest(".tag-chip");
    if (chip) insertTag(chip.dataset.tag);
  });

  async function postJson(url, text) {
    return fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${client.token}`, "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
  }

  enhanceBtn.addEventListener("click", async () => {
    const text = textEl.value.trim();
    if (!text) { setStatus("type something first"); return; }
    inFlight = true; syncButtons(); setStatus("enhancing…");
    try {
      const res = await postJson("/api/enhance", text);
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        setStatus(`error: ${e.error || res.status}`);
        return;
      }
      const data = await res.json();
      textEl.value = data.text;
      setStatus("enhanced — review and Speak");
    } catch (e) {
      setStatus(`error: ${e.message}`);
    } finally {
      inFlight = false; syncButtons();
    }
  });

  speakBtn.addEventListener("click", async () => {
    const text = textEl.value.trim();
    if (!text) { setStatus("type something first"); return; }
    // Audio plays on the device speaker (synthesized + streamed server-side);
    // pointless without a device.
    if (!client.deviceConnected) { setStatus("device offline"); return; }
    inFlight = true; syncButtons(); setStatus("speaking…");
    try {
      const res = await postJson("/api/tts", text);
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        setStatus(`error: ${e.error || res.status}`);
        return;
      }
      // Server streams to the device fire-and-forget — there's no completion signal.
      setStatus("speaking on device…");
    } catch (e) {
      setStatus(`error: ${e.message}`);
    } finally {
      inFlight = false; syncButtons();
    }
  });

  // (The speaker volume moved to the Interact page — two per-channel knobs; see
  // panels/volume-knobs.js.)

  // Music-pacing slider. Server-owned playback knob (ms between music frames), shared
  // across browsers and persisted; like volume it stays usable while the device is
  // offline (whitelisted in disableAllControls). The change applies mid-track.
  const paceEl = root.querySelector("#tts-music-pacing");
  const paceValEl = root.querySelector("#tts-music-pacing-val");
  const renderPace = (ms) => { paceValEl.textContent = `${ms}ms`; };
  paceEl.addEventListener("input", () => {
    const ms = +paceEl.value;
    renderPace(ms);
    client.send({ type: "set_music_pacing", ms });
  });
  client.addEventListener("msg:music_pacing", (ev) => {
    const m = ev.detail || {};
    if (typeof m.min === "number") paceEl.min = String(m.min);
    if (typeof m.max === "number") paceEl.max = String(m.max);
    if (typeof m.ms === "number") {
      paceEl.value = String(m.ms);
      renderPace(m.ms);
    }
  });

  // Voice (TTS) pacing slider — same server-owned/shared/persisted pattern as music.
  // This is the delivery rate into the device buffer, NOT speech speed; it applies on
  // her next reply.
  const vpaceEl = root.querySelector("#tts-voice-pacing");
  const vpaceValEl = root.querySelector("#tts-voice-pacing-val");
  const renderVPace = (ms) => { vpaceValEl.textContent = `${ms}ms`; };
  vpaceEl.addEventListener("input", () => {
    const ms = +vpaceEl.value;
    renderVPace(ms);
    client.send({ type: "set_tts_pacing", ms });
  });
  client.addEventListener("msg:tts_pacing", (ev) => {
    const m = ev.detail || {};
    if (typeof m.min === "number") vpaceEl.min = String(m.min);
    if (typeof m.max === "number") vpaceEl.max = String(m.max);
    if (typeof m.ms === "number") {
      vpaceEl.value = String(m.ms);
      renderVPace(m.ms);
    }
  });

  client.addEventListener("msg:device_connected", syncButtons);
  client.addEventListener("msg:device_disconnected", syncButtons);
  syncButtons();
}
