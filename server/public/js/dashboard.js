import { DashboardClient, fetchToken } from "/js/client.js";
import { initLedPanel } from "/js/panels/leds.js";
import { initLdrPanel } from "/js/panels/ldr.js";
import { initAudioPanel } from "/js/panels/audio.js";
import { initTtsPanel } from "/js/panels/tts.js";
import { mountSpeech } from "/js/panels/speech.js";
import { initCameraPanel } from "/js/panels/camera.js";
import { initLoopback } from "/js/panels/loopback.js";
import { initListenPanel } from "/js/panels/listen.js";
import { initSiennaPanel } from "/js/panels/sienna.js";
import { initUsagePanel } from "/js/panels/usage.js";
import { initViews } from "/js/panels/views.js";
import { initAutonomyPanel } from "/js/panels/autonomy.js";
import { initVolumeKnobs } from "/js/panels/volume-knobs.js";

const URL_KEY = "sienna.wsUrl";
const TOKEN_KEY = "sienna.token";

const els = {
  serverDot:  document.getElementById("server-dot"),
  serverText: document.getElementById("server-text"),
  dot:    document.getElementById("state-dot"),
  text:   document.getElementById("state-text"),
  detail: document.getElementById("state-detail"),
  reboot: document.getElementById("reboot-btn"),
};

// Default server WS endpoint, derived from the page so it matches the page's
// protocol (https page → wss, http page → ws). This alone fixes the common
// mixed-content failure of a hardcoded ws:// on an https-served dashboard.
function defaultWsUrl() {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}/ws/browser`;
}

// Accept "host:port", "wss://host", or a full ".../ws/browser" URL.
function normalizeWsUrl(input) {
  let u = (input || "").trim();
  if (!u) return defaultWsUrl();
  if (!/^wss?:\/\//i.test(u)) {
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    u = `${scheme}//${u}`;
  }
  u = u.replace(/\/+$/, "");
  if (!/\/ws\/browser$/.test(u)) u = `${u}/ws/browser`;
  return u;
}

function setServer(connected) {
  els.serverText.textContent = connected ? "online" : "offline";
  els.serverDot.classList.remove("good", "bad");
  els.serverDot.classList.add(connected ? "good" : "bad");
}

function setState(state, ip, rssi) {
  els.text.textContent = state || "OFFLINE";
  els.detail.textContent = ip ? `ip=${ip}  rssi=${rssi ?? "?"}` : "";
  els.dot.classList.remove("good", "warn", "bad");
  if (state === "ONLINE") els.dot.classList.add("good");
  else if (state === "RECOVERING" || state === "WIFI_TRYING" || state === "WS_OPENING") els.dot.classList.add("warn");
  else els.dot.classList.add("bad");
}

function disableAllControls(disabled) {
  document.querySelectorAll("button, input, select").forEach((el) => {
    // Keep reboot + the settings controls usable even when offline — settings
    // is exactly what you need when the server address is misconfigured. The
    // Sienna tab buttons stay enabled too: they switch between views of her
    // stored history (fetched over REST), which is independent of the device.
    if (el.id === "reboot-btn" || el.id === "settings-btn" || el.closest("#settings-dialog")) return;
    // Re-provision is a link to the BLE provisioning page — device-independent,
    // and needed precisely when the device is offline.
    if (el.id === "reprovision-btn") return;
    if (el.classList.contains("sienna-tab") || el.classList.contains("view-tab")) return;
    // The Usage view is REST-backed (token usage/cost), independent of the device,
    // so its granularity buttons stay usable offline — like the Sienna tabs.
    if (el.classList.contains("usage-tab")) return;
    // The autonomy toggle is server-side agent state (persisted in Mongo), so it
    // stays usable offline — like settings — rather than greying out with the
    // device. (The volume knobs are role=slider divs, untouched by this sweep,
    // and server-side too.)
    if (el.id === "sienna-autonomy") return;
    // The music-pacing slider is a server-owned playback knob (shared +
    // persisted), so it stays usable offline too.
    if (el.id === "tts-music-pacing") return;
    // The voice (TTS) pacing slider is the same kind of server-owned knob.
    if (el.id === "tts-voice-pacing") return;
    el.disabled = disabled;
  });
}

function setupSettings(client, currentToken) {
  const dlg = document.getElementById("settings-dialog");
  const urlInput = document.getElementById("settings-url");
  const tokenInput = document.getElementById("settings-token");
  const hint = document.getElementById("settings-hint");

  document.getElementById("settings-btn").addEventListener("click", () => {
    urlInput.value = localStorage.getItem(URL_KEY) || defaultWsUrl();
    tokenInput.value = localStorage.getItem(TOKEN_KEY) || currentToken || "";
    hint.textContent = `Page is ${location.protocol}//${location.host}; default endpoint is ${defaultWsUrl()}`;
    dlg.showModal();
  });

  document.getElementById("settings-cancel").addEventListener("click", () => dlg.close());

  document.getElementById("settings-reset").addEventListener("click", () => {
    localStorage.removeItem(URL_KEY);
    localStorage.removeItem(TOKEN_KEY);
    urlInput.value = defaultWsUrl();
    tokenInput.value = "";
  });

  document.getElementById("settings-save").addEventListener("click", async () => {
    const url = normalizeWsUrl(urlInput.value);
    if (url === defaultWsUrl()) localStorage.removeItem(URL_KEY);
    else localStorage.setItem(URL_KEY, url);

    let token = tokenInput.value.trim();
    if (token) {
      localStorage.setItem(TOKEN_KEY, token);
    } else {
      localStorage.removeItem(TOKEN_KEY);
      try { token = await fetchToken(); } catch { token = ""; }
    }

    client.applyEndpoint({ url, token });
    dlg.close();
  });
}

(async () => {
  const url = localStorage.getItem(URL_KEY) || defaultWsUrl();
  let token = localStorage.getItem(TOKEN_KEY) || "";
  if (!token) { try { token = await fetchToken(); } catch { token = ""; } }

  const client = new DashboardClient({ url, token });

  initViews();              // header view-switcher (Input/Output ↔ Sienna)
  initLedPanel(client);
  initLdrPanel(client);
  initAudioPanel(client);
  initTtsPanel(client);     // builds the Voice panel, incl. the #ptt button…
  initCameraPanel(client);
  initLoopback(client);     // …which initLoopback then wires for mic capture
  initListenPanel(client);
  initSiennaPanel(client);  // Interact composer + the Logs-view feeds…
  initVolumeKnobs(client);  // …then the knobs mount into its #sienna-knobs
  initAutonomyPanel(client);// Autonomous-speech toggle (Diagnostics view)
  initUsagePanel(client);   // the Usage view (Gemini token usage + cost)

  // The speech monitor lives on the Interact tab (shows PTT holds + transcripts,
  // and hosts the on-screen Push to talk button).
  mountSpeech(client, document.getElementById("sienna-speech"), { rows: 3 });

  client.addEventListener("open", () => setServer(true));
  // Losing the server connection makes any prior device state stale: show
  // Sienna OFFLINE until the server (and then the device) report back.
  client.addEventListener("close", () => { setServer(false); setState("OFFLINE", null, null); disableAllControls(true); });

  client.addEventListener("msg:device_connected",    () => { setState("WS_OPENING", null, null); disableAllControls(false); });
  client.addEventListener("msg:device_disconnected", () => { setState("OFFLINE",    null, null); disableAllControls(true); });
  client.addEventListener("msg:state", (ev) => { const m = ev.detail; setState(m.state, m.ip, m.wifi_rssi); });
  client.addEventListener("msg:command_error", (ev) => {
    const t = document.createElement("div");
    t.className = "toast";
    t.textContent = `Error: ${ev.detail.reason}`;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2500);
  });

  els.reboot.addEventListener("click", () => {
    if (!confirm("Reboot Sienna?")) return;
    client.send({ type: "reboot" });
  });

  setupSettings(client, token);

  setServer(false);
  setState("OFFLINE");
  disableAllControls(true);
  client.start();
  window._sienna = client;
})();
