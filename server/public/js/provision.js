import { fetchToken } from "/js/client.js";

// UUIDs must match esp32/sienna_dashboard/ble_provisioning.h
const SVC_UUID  = "7a3f4e80-2b1f-4ad6-9c1d-d6e0a1b2c3d4";
const CH_SSID   = "7a3f4e81-2b1f-4ad6-9c1d-d6e0a1b2c3d4";
const CH_PASS   = "7a3f4e82-2b1f-4ad6-9c1d-d6e0a1b2c3d4";
const CH_URL    = "7a3f4e83-2b1f-4ad6-9c1d-d6e0a1b2c3d4";
const CH_TOKEN  = "7a3f4e84-2b1f-4ad6-9c1d-d6e0a1b2c3d4";
const CH_COMMIT = "7a3f4e85-2b1f-4ad6-9c1d-d6e0a1b2c3d4";
const CH_STATUS = "7a3f4e86-2b1f-4ad6-9c1d-d6e0a1b2c3d4";
const CH_SCAN   = "7a3f4e87-2b1f-4ad6-9c1d-d6e0a1b2c3d4";

const els = {
  pairBtn:    document.getElementById("pair-btn"),
  pairStatus: document.getElementById("pair-status"),
  scanBtn:    document.getElementById("scan-btn"),
  ssidSelect: document.getElementById("ssid-select"),
  ssidInput:  document.getElementById("ssid-input"),
  scanStatus: document.getElementById("scan-status"),
  passInput:  document.getElementById("pass-input"),
  passReveal: document.getElementById("pass-reveal"),
  serverInput:document.getElementById("server-input"),
  tokenInput: document.getElementById("token-input"),
  form:       document.getElementById("prov-form"),
  saveBtn:    document.getElementById("save-btn"),
  connectProgress: document.getElementById("connect-progress"),
  openDashboard:   document.getElementById("open-dashboard"),
  status:     document.getElementById("dev-status"),
};

let gDevice = null;
let gServer = null;
let gService = null;
let gChars = {};
let gStatusChar = null;
let gScanChar = null;

let scanTimeout = null;
const scanLabel = els.scanBtn.textContent;

// Blue (primary) once paired; cleared on disconnect.
function setScanPaired(paired) {
  els.scanBtn.classList.toggle("primary", paired);
}

// Disable + spinner while a scan is in flight; restored when results arrive.
function setScanning(on) {
  els.scanBtn.disabled = on;
  els.scanBtn.classList.toggle("scanning", on);
  els.scanBtn.setAttribute("aria-busy", on ? "true" : "false");
  els.scanBtn.innerHTML = on
    ? '<span class="spinner" aria-hidden="true"></span>Scanning…'
    : scanLabel;
}

let connecting = false;
let lastState = null;
let connectTimeout = null;
const saveLabel = els.saveBtn.textContent;

// Disable Save + spinner while committing / connecting.
function setConnecting(on) {
  connecting = on;
  if (!on) clearTimeout(connectTimeout);
  els.saveBtn.disabled = on;
  els.saveBtn.classList.toggle("scanning", on);
  els.saveBtn.setAttribute("aria-busy", on ? "true" : "false");
  els.saveBtn.innerHTML = on
    ? '<span class="spinner" aria-hidden="true"></span>Connecting…'
    : saveLabel;
}

// Friendly progress line under the Save button. kind: wait | ok | error.
function showProgress(kind, text) {
  const p = els.connectProgress;
  p.hidden = false;
  p.className = "connect-progress " + kind;
  const icon =
    kind === "wait"  ? '<span class="spinner" aria-hidden="true"></span>' :
    kind === "ok"    ? '<span aria-hidden="true">✓</span>' :
    kind === "error" ? '<span aria-hidden="true">⚠</span>' : "";
  p.innerHTML = `${icon}<span>${text}</span>`;
}

// Revealed once Sienna is online; takes the user to the live dashboard.
function showDashboardLink() {
  els.openDashboard.hidden = false;
}

(async () => {
  const wsScheme = location.protocol === "https:" ? "wss" : "ws";
  els.serverInput.value = `${wsScheme}://${location.host}/ws/device`;
  try { els.tokenInput.value = await fetchToken(); } catch {}
})();

if (!navigator.bluetooth) {
  els.pairStatus.textContent = "Web Bluetooth not available — use Chrome/Edge over localhost or HTTPS";
  els.pairBtn.disabled = true;
}

els.pairBtn.addEventListener("click", async () => {
  try {
    els.pairStatus.textContent = "requesting…";
    gDevice = await navigator.bluetooth.requestDevice({
      filters: [{ services: [SVC_UUID] }],
    });
    gDevice.addEventListener("gattserverdisconnected", () => {
      els.pairStatus.textContent = "disconnected";
      clearTimeout(scanTimeout);
      setScanning(false);
      setScanPaired(false);
      // Sienna shuts BLE off the moment she reaches ONLINE, so a drop after
      // Wi-Fi is already up almost always means success — the ONLINE status
      // notification just didn't make it out before the radio went down.
      if (connecting && (lastState === "ONLINE" || lastState === "WS_OPENING")) {
        setConnecting(false);
        showProgress("ok", "Wi-Fi connected — Sienna is reaching the server. Open the dashboard to confirm she's online.");
        showDashboardLink();
      } else if (connecting) {
        setConnecting(false);
        showProgress("error", "Bluetooth dropped before Wi-Fi connected. Move Sienna closer and try again.");
      }
    });
    els.pairStatus.textContent = "connecting…";
    gServer = await gDevice.gatt.connect();
    gService = await gServer.getPrimaryService(SVC_UUID);
    gChars = {
      ssid:   await gService.getCharacteristic(CH_SSID),
      pass:   await gService.getCharacteristic(CH_PASS),
      url:    await gService.getCharacteristic(CH_URL),
      token:  await gService.getCharacteristic(CH_TOKEN),
      commit: await gService.getCharacteristic(CH_COMMIT),
    };
    gStatusChar = await gService.getCharacteristic(CH_STATUS);
    gScanChar   = await gService.getCharacteristic(CH_SCAN);
    await gStatusChar.startNotifications();
    gStatusChar.addEventListener("characteristicvaluechanged", onStatus);
    await gScanChar.startNotifications();
    gScanChar.addEventListener("characteristicvaluechanged", onScanResult);
    els.pairStatus.textContent = `paired with ${gDevice.name || "device"}`;
    setScanPaired(true);
  } catch (e) {
    els.pairStatus.textContent = `error: ${e.message}`;
  }
});

function dec(view) {
  return new TextDecoder().decode(view);
}

function onStatus(ev) {
  const json = dec(ev.target.value);
  els.status.textContent = json;  // raw state, handy for debugging
  let m;
  try { m = JSON.parse(json); } catch { return; }
  lastState = m.state;
  if (connecting) {
    if (m.state === "WIFI_TRYING")     showProgress("wait", "Connecting to Wi-Fi…");
    else if (m.state === "WS_OPENING") showProgress("wait", "Wi-Fi connected — reaching the server…");
    else if (m.state === "RECOVERING") showProgress("error", m.last_error ? `Problem: ${m.last_error} — retrying…` : "Connection problem — retrying…");
  }
  if (m.state === "ONLINE") {
    setConnecting(false);
    showProgress("ok", "Connected to Wi-Fi and the server!");
    showDashboardLink();
  }
}

// One-line status under the network row. kind: ok | error; empty text hides it.
function setScanStatus(kind, text) {
  els.scanStatus.hidden = !text;
  els.scanStatus.textContent = text;
  els.scanStatus.style.color = kind === "error" ? "var(--danger, #c33)" : "var(--muted)";
}

function onScanResult(ev) {
  clearTimeout(scanTimeout);
  setScanning(false);
  const json = dec(ev.target.value);
  let list;
  try {
    list = JSON.parse(json);
  } catch (e) {
    console.warn("scan parse failed", e, json);
    setScanStatus("error", `Scan result unreadable — type the SSID manually.`);
    return;
  }
  // Firmware reports failures as {"error":"scan_failed","code":n} (e.g. a scan
  // attempted while a Wi-Fi connect was in flight, on pre-fix firmware).
  if (!Array.isArray(list)) {
    setScanStatus("error", `Scan failed on the device (${list.error ?? json}${list.code != null ? `, code ${list.code}` : ""}) — type the SSID manually.`);
    return;
  }
  els.ssidSelect.innerHTML = "";
  if (list.length === 0) {
    setScanStatus("error", "Device reported zero networks — try again, or type the SSID manually.");
    return;
  }
  for (const n of list.sort((a, b) => b.rssi - a.rssi)) {
    const opt = document.createElement("option");
    opt.value = n.ssid;
    opt.textContent = `${n.ssid} (${n.rssi} dBm${n.secured ? "" : ", open"})`;
    els.ssidSelect.appendChild(opt);
  }
  setScanStatus("ok", `${list.length} network${list.length === 1 ? "" : "s"} found.`);
}

els.scanBtn.addEventListener("click", async () => {
  if (!gScanChar) { els.pairStatus.textContent = "pair first"; return; }
  setScanning(true);
  setScanStatus("ok", "");
  try {
    await gScanChar.writeValueWithResponse(new Uint8Array([0x01]));
    // Results come back asynchronously via onScanResult; fall back in case
    // the result notification never arrives (lost packet).
    clearTimeout(scanTimeout);
    scanTimeout = setTimeout(() => {
      setScanning(false);
      setScanStatus("error", "No scan response from the device after 8 s — try again, or type the SSID manually.");
    }, 8000);
  } catch (e) {
    setScanning(false);
    setScanStatus("error", `Scan request failed: ${e.message}`);
  }
});

els.ssidSelect.addEventListener("change", () => {
  els.ssidInput.value = els.ssidSelect.value;
});

els.passReveal.addEventListener("click", () => {
  const show = els.passInput.type === "password";
  els.passInput.type = show ? "text" : "password";
  els.passReveal.textContent = show ? "🙈" : "👁";
  const label = show ? "Hide password" : "Show password";
  els.passReveal.setAttribute("aria-label", label);
  els.passReveal.title = label;
});

els.openDashboard.addEventListener("click", () => {
  window.location.href = "/dashboard.html";
});

els.form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (!gChars.commit) { els.pairStatus.textContent = "pair first"; return; }
  const ssid = els.ssidInput.value || els.ssidSelect.value;
  if (!ssid) { alert("SSID required"); return; }
  const pass = els.passInput.value;
  const url  = els.serverInput.value;
  const tok  = els.tokenInput.value;
  const enc = (s) => new TextEncoder().encode(s);

  els.openDashboard.hidden = true;   // reset from any previous attempt
  setConnecting(true);
  showProgress("wait", "Sending Wi-Fi credentials to Sienna…");
  try {
    await gChars.ssid.writeValueWithResponse(enc(ssid));
    await gChars.pass.writeValueWithResponse(enc(pass));
    await gChars.url.writeValueWithResponse(enc(url));
    await gChars.token.writeValueWithResponse(enc(tok));
    await gChars.commit.writeValueWithResponse(new Uint8Array([0x01]));
    showProgress("wait", "Credentials sent — waiting for Sienna to connect…");
    clearTimeout(connectTimeout);
    connectTimeout = setTimeout(() => {
      if (connecting) {
        setConnecting(false);
        showProgress("error", "No response yet — double-check the Wi-Fi password and try again.");
      }
    }, 45000);
  } catch (e) {
    setConnecting(false);
    showProgress("error", `Couldn't send credentials: ${e.message}`);
  }
});
