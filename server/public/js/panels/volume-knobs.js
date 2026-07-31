// Volume knobs (Interact page): two rotary dials — Speech (her voice / TTS /
// browser Speak) and Music (jukebox / YouTube / audio files) — driving the
// server's independent channel gains. Styled like hardware volume dials: a
// 270° tick ring, an accent value arc, and a machined cap with a pointer notch.
//
// The values are server-owned (Sienna's set_volume tool shares them, and other
// browsers' knobs do too), so the server is the source of truth: we send
// {type:"set_volume", channel, percent} on input and reflect the per-channel
// {type:"volume"} broadcasts + the on-connect snapshot. The knobs are plain
// divs (role="slider"), so disableAllControls never greys them — like the old
// slider they stay usable while the device is offline (the gain is applied
// server-side regardless).
//
// Interaction: drag up/down (pointer capture; fine-grained — ~2%/px), mouse
// wheel ±5, arrow keys ±5 / PageUp-Down ±25 / Home-End, double-click resets
// to 100%.

const SWEEP_DEG = 270;              // -135° … +135°
const START_DEG = -135;
const R = 34;                       // value-arc radius in the 100×100 viewBox

const CHANNELS = [
  { key: "voice", label: "Speech", hint: "Sienna's voice (speech / TTS)" },
  { key: "music", label: "Music",  hint: "Jukebox, YouTube and audio files" },
];

function polar(deg, r) {
  const rad = ((deg - 90) * Math.PI) / 180;   // 0° = up
  return [50 + r * Math.cos(rad), 50 + r * Math.sin(rad)];
}

// SVG arc path from a1° to a2° (clockwise, ≤ 270° so large-arc math is simple).
function arcPath(a1, a2, r) {
  const [x1, y1] = polar(a1, r);
  const [x2, y2] = polar(a2, r);
  const large = a2 - a1 > 180 ? 1 : 0;
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

function buildTicks() {
  // 11 ticks across the sweep; the major ones (ends + centre) reach deeper.
  let out = "";
  for (let i = 0; i <= 10; i++) {
    const deg = START_DEG + (SWEEP_DEG * i) / 10;
    const major = i % 5 === 0;
    const [x1, y1] = polar(deg, 46);
    const [x2, y2] = polar(deg, major ? 40.5 : 43);
    out += `<line class="knob-tick${major ? " major" : ""}" x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}"/>`;
  }
  return out;
}

export function initVolumeKnobs(client) {
  const mount = document.getElementById("sienna-knobs");
  if (!mount) return;

  const knobs = {};
  for (const ch of CHANNELS) {
    const wrap = document.createElement("div");
    wrap.className = "knob-wrap";
    wrap.innerHTML = `
      <div class="knob" tabindex="0" role="slider" aria-label="${ch.label} volume"
           aria-valuemin="0" aria-valuemax="400" aria-valuenow="200" title="${ch.hint}">
        <svg viewBox="0 0 100 100" aria-hidden="true">
          <defs>
            <!-- Machined-face gradient; stop colors come from CSS so the skin
                 stays on the design tokens. Offset centre = top catch-light. -->
            <radialGradient id="knob-face-${ch.key}" cx="50%" cy="34%" r="78%">
              <stop class="knob-face-hi" offset="0%"/>
              <stop class="knob-face-mid" offset="55%"/>
              <stop class="knob-face-lo" offset="100%"/>
            </radialGradient>
          </defs>
          ${buildTicks()}
          <path class="knob-track" d="${arcPath(START_DEG, START_DEG + SWEEP_DEG, R)}"/>
          <path class="knob-arc" d=""/>
          <circle class="knob-cap" cx="50" cy="50" r="27"/>
          <circle class="knob-cap-inner" cx="50" cy="50" r="22" fill="url(#knob-face-${ch.key})"/>
          <g class="knob-rotor">
            <line class="knob-pointer" x1="50" y1="33" x2="50" y2="42"/>
          </g>
        </svg>
      </div>
      <span class="knob-label">${ch.label}</span>
      <span class="knob-value">200%</span>
    `;
    mount.append(wrap);

    const knob = {
      channel: ch.key,
      el: wrap.querySelector(".knob"),
      arc: wrap.querySelector(".knob-arc"),
      rotor: wrap.querySelector(".knob-rotor"),
      valueEl: wrap.querySelector(".knob-value"),
      percent: 200,
      max: 400,
      dragging: false,
    };
    knobs[ch.key] = knob;
    render(knob);
    wire(knob);
  }

  function render(k) {
    const frac = k.max > 0 ? k.percent / k.max : 0;
    const deg = START_DEG + SWEEP_DEG * frac;
    // A zero-length arc draws nothing (clean, not a dot).
    k.arc.setAttribute("d", frac > 0 ? arcPath(START_DEG, deg, R) : "");
    k.rotor.setAttribute("transform", `rotate(${deg.toFixed(1)} 50 50)`);
    k.valueEl.textContent = `${k.percent}%`;
    k.el.setAttribute("aria-valuenow", String(k.percent));
    k.el.setAttribute("aria-valuemax", String(k.max));
    k.el.setAttribute("aria-valuetext", `${k.percent} percent`);
  }

  function set(k, percent, { send = true } = {}) {
    percent = Math.round(Math.min(k.max, Math.max(0, percent)));
    if (percent === k.percent) return;
    k.percent = percent;
    render(k);
    if (send) client.send({ type: "set_volume", channel: k.channel, percent });
  }

  function wire(k) {
    // Vertical drag, pointer-captured so the hold survives leaving the knob.
    let startY = 0, startPercent = 0;
    k.el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      k.dragging = true;
      startY = e.clientY;
      startPercent = k.percent;
      k.el.classList.add("dragging");
      try { k.el.setPointerCapture(e.pointerId); } catch { /* best-effort */ }
    });
    k.el.addEventListener("pointermove", (e) => {
      if (!k.dragging) return;
      const pxRange = 200;                              // full 0→max travel in ~200px
      set(k, startPercent + ((startY - e.clientY) / pxRange) * k.max);
    });
    const endDrag = () => { k.dragging = false; k.el.classList.remove("dragging"); };
    k.el.addEventListener("pointerup", endDrag);
    k.el.addEventListener("pointercancel", endDrag);

    k.el.addEventListener("wheel", (e) => {
      e.preventDefault();
      set(k, k.percent + (e.deltaY < 0 ? 5 : -5));
    }, { passive: false });

    k.el.addEventListener("dblclick", () => set(k, 100));

    k.el.addEventListener("keydown", (e) => {
      const step = { ArrowUp: 5, ArrowRight: 5, ArrowDown: -5, ArrowLeft: -5, PageUp: 25, PageDown: -25 }[e.key];
      if (step !== undefined) { e.preventDefault(); set(k, k.percent + step); return; }
      if (e.key === "Home") { e.preventDefault(); set(k, 0); }
      if (e.key === "End") { e.preventDefault(); set(k, k.max); }
    });
  }

  // Server → knob sync (other browsers, Sienna's tool, the connect snapshot).
  // A channel-less broadcast (legacy master) applies to both. Skip a knob
  // that's mid-drag — its own sends are in flight and would fight the echo.
  client.addEventListener("msg:volume", (ev) => {
    const m = ev.detail || {};
    const targets = m.channel ? [knobs[m.channel]] : Object.values(knobs);
    for (const k of targets) {
      if (!k || k.dragging) continue;
      if (typeof m.max === "number") k.max = m.max;
      if (typeof m.percent === "number") k.percent = Math.min(m.percent, k.max);
      render(k);
    }
  });
}
