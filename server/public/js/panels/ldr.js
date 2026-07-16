export function initLdrPanel(client) {
  const root = document.getElementById("panel-ldr");
  root.innerHTML = `
    <h2>Light sensor</h2>
    <div style="display: flex; align-items: baseline; gap: 12px;">
      <span style="font-size: 28px; font-family: monospace;" id="ldr-val">—</span>
      <span style="color: var(--muted);" id="ldr-rate-display">5 Hz</span>
    </div>
    <canvas id="ldr-canvas" width="360" height="80" style="margin-top: 8px;"></canvas>
    <div style="display: flex; gap: 8px; margin-top: 8px; align-items: center;">
      <label style="flex-direction: row; align-items: center; gap: 4px;">Push rate
        <input type="number" id="ldr-rate" value="5" min="0" max="50" style="width: 60px;">
        <span>Hz</span>
      </label>
    </div>
  `;
  const valEl   = root.querySelector("#ldr-val");
  const rateEl  = root.querySelector("#ldr-rate");
  const rateDisp= root.querySelector("#ldr-rate-display");
  const canvas  = root.querySelector("#ldr-canvas");
  const ctx     = canvas.getContext("2d");

  const samples = []; // {t, v}
  const WINDOW_MS = 60000;

  function draw() {
    requestAnimationFrame(draw);
    const now = Date.now();
    while (samples.length && now - samples[0].t > WINDOW_MS) samples.shift();
    ctx.fillStyle = "#11141a";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = "#5da6ff";
    ctx.beginPath();
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const x = canvas.width - ((now - s.t) / WINDOW_MS) * canvas.width;
      const y = canvas.height - (s.v / 4095) * canvas.height;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  draw();

  client.addEventListener("msg:ldr", (ev) => {
    const m = ev.detail;
    valEl.textContent = String(m.value);
    samples.push({ t: Date.now(), v: m.value });
  });

  rateEl.addEventListener("change", () => {
    const hz = Math.max(0, Math.min(50, +rateEl.value || 0));
    rateDisp.textContent = `${hz} Hz`;
    client.send({ type: "set_ldr_rate", hz });
  });
}
