// "Listen" — live monitor of the device microphone. Toggling on tells the
// server to keep the device mic stream up (start_listening → the mic-stream
// arbiter) and plays the broadcast PCM frames (binary tag 0x01, 16 kHz mono
// Int16) through Web Audio. Playback is local to this browser; the device
// stream is shared/ref-counted server-side. Mirrors initLoopback: the
// `#listen-btn` lives in the Audio panel (beside Record), so this runs after
// initAudioPanel and just binds to it by id.

const SAMPLE_RATE = 16000;
const JITTER_LEAD_S = 0.2; // ~200 ms buffer to smooth irregular WS frame arrival

export function initListenPanel(client) {
  const btn = document.getElementById("listen-btn");
  const status = document.getElementById("listen-status");
  if (!btn || !status) return;

  let active = false;
  let audioCtx = null;
  let nextTime = 0;
  let onBin = null;

  const setStatus = (s) => { status.textContent = s; };

  function syncButton() {
    // Offline blocks starting, but stays clickable while active so you can stop.
    btn.disabled = !client.deviceConnected && !active;
    btn.textContent = active ? "■ Stop listening" : "🎧 Listen";
    btn.classList.toggle("danger", active);
    btn.classList.toggle("primary", !active);
  }

  // One PCM frame: Int16 LE @ 16 kHz mono → scheduled AudioBuffer.
  function playFrame(payload) {
    if (!active || !audioCtx) return;
    // The frame arrives as a Uint8Array view at byteOffset 1 (the 0x01 tag was
    // stripped via subarray). Int16Array needs a 2-byte-aligned offset, so copy
    // into a fresh, offset-0 buffer before reinterpreting as Int16.
    const bytes = payload.slice();
    const pcm = new Int16Array(bytes.buffer, 0, bytes.byteLength >> 1);
    if (pcm.length === 0) return;
    const buffer = audioCtx.createBuffer(1, pcm.length, SAMPLE_RATE);
    const ch = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
    const src = audioCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(audioCtx.destination);
    // Resync the cursor if we've fallen behind (underrun) — brief gap, no crash.
    const now = audioCtx.currentTime;
    if (nextTime < now + JITTER_LEAD_S) nextTime = now + JITTER_LEAD_S;
    src.start(nextTime);
    nextTime += buffer.duration;
  }

  async function startListening() {
    if (active) return;
    if (!client.deviceConnected) { setStatus("device offline"); return; }
    active = true;
    syncButton();
    setStatus("listening…");
    audioCtx = new AudioContext();
    try { await audioCtx.resume(); } catch {}
    nextTime = 0;  // first frame resyncs the cursor to currentTime + lead
    onBin = (ev) => playFrame(ev.detail);   // ev.detail is the Uint8Array payload
    client.addEventListener("bin:1", onBin);
    client.send({ type: "start_listening" });
  }

  function stopListening() {
    if (!active) return;
    active = false;
    client.send({ type: "stop_listening" });
    if (onBin) { client.removeEventListener("bin:1", onBin); onBin = null; }
    try { audioCtx?.close(); } catch {}
    audioCtx = null;
    setStatus("");
    syncButton();
  }

  btn.addEventListener("click", () => { active ? stopListening() : startListening(); });
  client.addEventListener("msg:device_connected", syncButton);
  client.addEventListener("msg:device_disconnected", () => { if (active) stopListening(); syncButton(); });
  syncButton();
}
