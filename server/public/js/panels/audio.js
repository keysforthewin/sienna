import { streamPcm, downmixAndResample } from "/js/panels/audio-stream.js";

export function initAudioPanel(client) {
  const root = document.getElementById("panel-audio");      // Microphone: mic input
  const speaker = document.getElementById("panel-speaker"); // Speaker: playback out
  root.innerHTML = `
    <h2>Microphone</h2>
    <canvas id="rms-canvas" width="360" height="56"></canvas>
    <div style="margin-top: 8px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
      <button id="rec-btn" class="primary">● Record</button>
      <button id="listen-btn" class="primary">🎧 Listen</button>
      <span id="rec-elapsed" style="color: var(--muted); font-family: monospace;"></span>
      <span id="listen-status" style="color: var(--muted);"></span>
    </div>
    <ul id="recordings" class="recordings"></ul>
  `;
  speaker.innerHTML = `
    <h2>Speaker</h2>
    <div>
      <h2>Upload WAV</h2>
      <input type="file" id="wav-file" accept="audio/wav">
      <button id="wav-play" style="margin-top: 6px;">▶ Play</button>
      <div id="wav-status" style="margin-top: 6px; color: var(--muted);"></div>
    </div>
    <hr style="border-color: var(--border); margin: 10px 0;">
    <div>
      <h2>Play tone</h2>
      <div style="display: grid; grid-template-columns: auto 1fr; gap: 6px; align-items: center;">
        <span>Hz</span>      <input type="number" id="tone-hz"  value="440" min="20" max="20000">
        <span>Duration ms</span> <input type="number" id="tone-dur" value="500" min="1"  max="10000">
        <span>Amp 0–1</span> <input type="number" id="tone-amp" value="0.25" min="0" max="1" step="0.05">
      </div>
      <button id="tone-play" style="margin-top: 6px;">▶ Play</button>
    </div>
  `;
  const canvas = root.querySelector("#rms-canvas");
  const ctx = canvas.getContext("2d");
  const samples = [];
  const WINDOW_MS = 5000;

  function draw() {
    requestAnimationFrame(draw);
    const now = Date.now();
    while (samples.length && now - samples[0].t > WINDOW_MS) samples.shift();
    ctx.fillStyle = "#11141a"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (samples.length === 0) return;
    const maxRms = Math.max(1, ...samples.map(s => s.rms));
    ctx.strokeStyle = "#45c08c"; ctx.beginPath();
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const x = canvas.width - ((now - s.t) / WINDOW_MS) * canvas.width;
      const y = canvas.height - (s.rms / maxRms) * canvas.height * 0.9;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  draw();
  client.addEventListener("msg:mic_rms", (ev) => {
    samples.push({ t: Date.now(), rms: ev.detail.rms, peak: ev.detail.peak });
  });

  const recBtn   = root.querySelector("#rec-btn");
  const elapsed  = root.querySelector("#rec-elapsed");
  const recList  = root.querySelector("#recordings");
  let recording = false;
  let startedAt = 0;
  let elapsedTimer = null;

  recBtn.addEventListener("click", () => {
    if (!recording) {
      client.send({ type: "start_recording" });
      recording = true;
      startedAt = Date.now();
      recBtn.textContent = "■ Stop";
      recBtn.classList.add("danger");
      elapsedTimer = setInterval(() => {
        const s = Math.floor((Date.now() - startedAt) / 1000);
        elapsed.textContent = `${s}s`;
      }, 250);
    } else {
      client.send({ type: "stop_recording" });
      recording = false;
      recBtn.textContent = "● Record";
      recBtn.classList.remove("danger");
      clearInterval(elapsedTimer);
      elapsed.textContent = "saving…";
    }
  });

  client.addEventListener("msg:recording_ready", (ev) => {
    elapsed.textContent = "";
    refreshList();
  });

  async function refreshList() {
    try {
      const res = await fetch("/api/recordings", {
        headers: { authorization: `Bearer ${client.token}` },
      });
      const { recordings } = await res.json();
      recList.innerHTML = "";
      for (const r of recordings) {
        const li = document.createElement("li");
        li.innerHTML = `
          <span style="font-family: monospace;">${r.filename}</span>
          <span>
            <a href="/api/recordings/${r.filename}" download style="margin-right: 6px;">⬇</a>
            <button data-play="/api/recordings/${r.filename}">▶</button>
            <button data-delete="${r.filename}" class="danger-ghost" title="delete recording">🗑</button>
          </span>`;
        recList.appendChild(li);
      }
      recList.querySelectorAll("[data-play]").forEach(btn => {
        btn.addEventListener("click", async () => {
          const url = btn.dataset.play;
          const res = await fetch(url, { headers: { authorization: `Bearer ${client.token}` } });
          const blob = await res.blob();
          const audio = new Audio(URL.createObjectURL(blob));
          audio.play();
        });
      });
      recList.querySelectorAll("[data-delete]").forEach(btn => {
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          try {
            await fetch(`/api/recordings/${btn.dataset.delete}`, {
              method: "DELETE",
              headers: { authorization: `Bearer ${client.token}` },
            });
          } catch (e) {
            console.error("delete failed", e);
          }
          refreshList();
        });
      });
    } catch (e) {
      console.error("list failed", e);
    }
  }

  refreshList();

  const tonePlay = speaker.querySelector("#tone-play");
  tonePlay.addEventListener("click", () => {
    client.send({
      type: "play_tone",
      hz: +speaker.querySelector("#tone-hz").value || 440,
      duration_ms: +speaker.querySelector("#tone-dur").value || 500,
      amplitude: +speaker.querySelector("#tone-amp").value || 0.25,
    });
  });

  const wavBtn = speaker.querySelector("#wav-play");
  const wavFile = speaker.querySelector("#wav-file");
  const wavStatus = speaker.querySelector("#wav-status");
  wavBtn.addEventListener("click", async () => {
    const file = wavFile.files[0];
    if (!file) { wavStatus.textContent = "pick a file first"; return; }
    wavStatus.textContent = "decoding…";
    const arrayBuf = await file.arrayBuffer();
    // Decode WAV (very simple: assume 16k mono 16-bit; otherwise resample with WebAudio)
    const audioCtx = new AudioContext();
    const decoded = await audioCtx.decodeAudioData(arrayBuf.slice(0));
    const samples = downmixAndResample(decoded, 16000);
    wavStatus.textContent = `streaming ${samples.length} samples…`;
    await streamPcm(client, samples, { pacingMs: 50 });   // pace ~ realtime
    wavStatus.textContent = "done";
  });

  return { samples, refreshList };
}
