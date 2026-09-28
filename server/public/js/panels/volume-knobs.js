// Volume knobs (Interact page): two rotary dials — Speech (her voice / TTS /
// browser Speak) and Music (jukebox / YouTube / audio files) — driving the
// server's independent channel gains. The dial itself (SVG geometry + drag /
// wheel / keyboard interaction) is the shared factory in panels/knob.js.
//
// The values are server-owned (Sienna's set_volume tool shares them, and other
// browsers' knobs do too), so the server is the source of truth: we send
// {type:"set_volume", channel, percent} on input and reflect the per-channel
// {type:"volume"} broadcasts + the on-connect snapshot. The knobs are plain
// divs (role="slider"), so disableAllControls never greys them — like the old
// slider they stay usable while the device is offline (the gain is applied
// server-side regardless).
//
// Interaction: drag up/down (pointer capture; full range over ~200 px, 1%
// resolution), mouse wheel ±5, arrow keys ±5 / PageUp-Down ±25 / Home-End,
// double-click resets to 100%.

import { createKnob } from "/js/panels/knob.js";

const CHANNELS = [
  { key: "voice", label: "Speech", hint: "Sienna's voice (speech / TTS)" },
  { key: "music", label: "Music",  hint: "Jukebox, YouTube and audio files" },
];

export function initVolumeKnobs(client) {
  const mount = document.getElementById("sienna-knobs");
  if (!mount) return;

  const knobs = {};
  for (const ch of CHANNELS) {
    knobs[ch.key] = createKnob(mount, {
      key: ch.key,
      label: ch.label,
      hint: ch.hint,
      min: 0,
      max: 400,
      step: 5,
      bigStep: 25,
      dragStep: 1,
      resetValue: 100,
      value: 200,
      format: (v) => `${v}%`,
      ariaText: (v) => `${v} percent`,
      onInput: (v) => client.send({ type: "set_volume", channel: ch.key, percent: v }),
    });
    knobs[ch.key].el.setAttribute("aria-label", `${ch.label} volume`);
  }

  // Server → knob sync (other browsers, Sienna's tool, the connect snapshot).
  // A channel-less broadcast (legacy master) applies to both. Skip a knob
  // that's mid-drag — its own sends are in flight and would fight the echo.
  client.addEventListener("msg:volume", (ev) => {
    const m = ev.detail || {};
    const targets = m.channel ? [knobs[m.channel]] : Object.values(knobs);
    for (const k of targets) {
      if (!k || k.dragging) continue;
      if (typeof m.max === "number") k.setBounds(0, m.max);
      if (typeof m.percent === "number") k.setValue(m.percent);
    }
  });
}
