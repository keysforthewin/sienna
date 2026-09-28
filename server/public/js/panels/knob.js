// Reusable rotary knob (hardware-dial styling): a 270° tick ring, an accent
// value arc, and a machined cap with a pointer notch. All geometry is SVG;
// the skin lives in css/app.css (.knob*). Extracted from the volume knobs so
// other server-owned scalars (jukebox crossfade, …) get the same dial.
//
// createKnob(mount, opts) appends a div.knob-wrap to `mount` and returns
// { el, wrap, setValue(v), setBounds(min, max), value, dragging }.
//   opts: { key, label, hint, min, max, step, bigStep, dragStep, resetValue, value,
//           format(v) → string, ariaText(v) → string, onInput(v),
//           size: "sm" | undefined, className }
//   step     — wheel / arrow-key increment (and the quantum for server values)
//   dragStep — drag quantum (defaults to step; the volume knobs drag at 1% but
//              nudge by 5%)
//
// Values are quantised to `step` and clamped to [min, max] (never rounded to
// integers — a 0.5 s step stays 0.5). `onInput(v)` fires ONLY for user-driven
// changes (drag / wheel / keys / double-click); the exported setValue is the
// server → knob sync path and never echoes back.
//
// Interaction: drag up/down (pointer capture; the full range travels ~200 px),
// mouse wheel ±step, arrow keys ±step / PageUp-Down ±bigStep / Home-End,
// double-click resets to `resetValue`.

const SWEEP_DEG = 270;              // -135° … +135°
const START_DEG = -135;
const R = 34;                       // value-arc radius in the 100×100 viewBox
const DRAG_PX_RANGE = 200;          // full min→max travel in ~200 px

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

function escapeAttr(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export function createKnob(mount, opts = {}) {
  const {
    key = "knob",
    label = "",
    hint = "",
    step = 1,
    bigStep = step * 5,
    dragStep = step,
    format = (v) => String(v),
    ariaText = (v) => String(v),
    onInput = () => {},
    size,
    className,
  } = opts;
  let min = typeof opts.min === "number" ? opts.min : 0;
  let max = typeof opts.max === "number" ? opts.max : 100;
  const resetValue = typeof opts.resetValue === "number" ? opts.resetValue : min;

  const wrap = document.createElement("div");
  wrap.className = "knob-wrap";
  const extra = [size ? `knob-${size}` : "", className || ""].filter(Boolean).join(" ");
  wrap.innerHTML = `
    <div class="knob${extra ? " " + extra : ""}" tabindex="0" role="slider" aria-label="${escapeAttr(label)}"
         aria-valuemin="${min}" aria-valuemax="${max}" aria-valuenow="${min}"${hint ? ` title="${escapeAttr(hint)}"` : ""}>
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <defs>
          <!-- Machined-face gradient; stop colors come from CSS so the skin
               stays on the design tokens. Offset centre = top catch-light. -->
          <radialGradient id="knob-face-${key}" cx="50%" cy="34%" r="78%">
            <stop class="knob-face-hi" offset="0%"/>
            <stop class="knob-face-mid" offset="55%"/>
            <stop class="knob-face-lo" offset="100%"/>
          </radialGradient>
        </defs>
        ${buildTicks()}
        <path class="knob-track" d="${arcPath(START_DEG, START_DEG + SWEEP_DEG, R)}"/>
        <path class="knob-arc" d=""/>
        <circle class="knob-cap" cx="50" cy="50" r="27"/>
        <circle class="knob-cap-inner" cx="50" cy="50" r="22" fill="url(#knob-face-${key})"/>
        <g class="knob-rotor">
          <line class="knob-pointer" x1="50" y1="33" x2="50" y2="42"/>
        </g>
      </svg>
    </div>
    <span class="knob-label">${escapeAttr(label)}</span>
    <span class="knob-value"></span>
  `;
  mount.append(wrap);

  const el = wrap.querySelector(".knob");
  const arc = wrap.querySelector(".knob-arc");
  const rotor = wrap.querySelector(".knob-rotor");
  const valueEl = wrap.querySelector(".knob-value");

  let value = min;
  let dragging = false;

  function quantise(v, s = step) {
    if (!Number.isFinite(v)) return value;
    v = Math.min(max, Math.max(min, v));
    const q = Math.round((v - min) / s) * s + min;
    return Number(Math.min(max, Math.max(min, q)).toFixed(6));
  }

  function render() {
    const span = max - min;
    const frac = span > 0 ? (value - min) / span : 0;
    const deg = START_DEG + SWEEP_DEG * frac;
    // A zero-length arc draws nothing (clean, not a dot).
    arc.setAttribute("d", frac > 0 ? arcPath(START_DEG, deg, R) : "");
    rotor.setAttribute("transform", `rotate(${deg.toFixed(1)} 50 50)`);
    valueEl.textContent = format(value);
    el.setAttribute("aria-valuemin", String(min));
    el.setAttribute("aria-valuemax", String(max));
    el.setAttribute("aria-valuenow", String(value));
    el.setAttribute("aria-valuetext", ariaText(value));
  }

  function set(v, { send = false, quantum = step } = {}) {
    v = quantise(v, quantum);
    if (v === value) return;
    value = v;
    render();
    if (send) onInput(value);
  }

  // Vertical drag, pointer-captured so the hold survives leaving the knob.
  let startY = 0, startValue = 0;
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    dragging = true;
    startY = e.clientY;
    startValue = value;
    el.classList.add("dragging");
    try { el.setPointerCapture(e.pointerId); } catch { /* best-effort */ }
  });
  el.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    set(startValue + ((startY - e.clientY) / DRAG_PX_RANGE) * (max - min), { send: true, quantum: dragStep });
  });
  const endDrag = () => { dragging = false; el.classList.remove("dragging"); };
  el.addEventListener("pointerup", endDrag);
  el.addEventListener("pointercancel", endDrag);

  el.addEventListener("wheel", (e) => {
    e.preventDefault();
    set(value + (e.deltaY < 0 ? step : -step), { send: true });
  }, { passive: false });

  el.addEventListener("dblclick", () => set(resetValue, { send: true }));

  el.addEventListener("keydown", (e) => {
    const delta = {
      ArrowUp: step, ArrowRight: step, ArrowDown: -step, ArrowLeft: -step,
      PageUp: bigStep, PageDown: -bigStep,
    }[e.key];
    if (delta !== undefined) { e.preventDefault(); set(value + delta, { send: true }); return; }
    if (e.key === "Home") { e.preventDefault(); set(min, { send: true }); }
    if (e.key === "End") { e.preventDefault(); set(max, { send: true }); }
  });

  // Initial value (defaults to min); never echoed to onInput.
  if (typeof opts.value === "number") value = quantise(opts.value);
  render();

  return {
    el,
    wrap,
    // Server → knob sync: re-renders, never calls onInput.
    setValue(v) { set(v, { send: false }); },
    setBounds(newMin, newMax) {
      if (typeof newMin === "number") min = newMin;
      if (typeof newMax === "number") max = newMax;
      value = quantise(value);
      render();
    },
    get value() { return value; },
    get dragging() { return dragging; },
  };
}
