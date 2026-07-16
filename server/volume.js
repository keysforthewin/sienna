// The speaker's master volume — one server-owned gain applied to every PCM frame
// the server forwards to the device speaker. The firmware plays PCM verbatim (no
// device-side gain), so this is the only volume knob. Two server paths send
// speaker PCM and both apply this gain:
//   - audio-out.js  — her speak / play_audio_file / play_youtube
//   - ws-browser.js — browser-originated audio (Voice-panel Speak, Hold-to-talk)
//
// Settable live by Sienna's set_volume tool and the Voice-panel slider; an
// onChange broadcast keeps every open slider in sync (including when SHE changes
// it). The value itself lives in RAM, but index.js's onChange write-throughs it
// to the Mongo settings store and restores it at boot (when memory exists), so
// a restart keeps the last set volume; without Mongo it falls back to the
// configured default (SIENNA_VOLUME).

const HARD_MAX_PERCENT = 400; // past ~4× the int16 clipping turns the voice to mush

function clampInt(v, lo, hi, fallback) {
  v = Math.round(Number(v));
  if (!Number.isFinite(v)) return fallback;
  return v < lo ? lo : v > hi ? hi : v;
}

export function createVolume({ initialPercent = 100, maxPercent = HARD_MAX_PERCENT, onChange = null } = {}) {
  const max = clampInt(maxPercent, 100, HARD_MAX_PERCENT, HARD_MAX_PERCENT);
  let percent = clampInt(initialPercent, 0, max, 100);

  function setPercent(p) {
    const next = clampInt(p, 0, max, percent);
    if (next !== percent) {
      percent = next;
      if (onChange) onChange(percent);
    }
    return percent;
  }

  // Scale an int16-LE PCM Buffer by the current gain, hard-clipping at the rails.
  // At 100% (unity) the input is returned untouched — the common path allocates
  // and copies nothing.
  function applyGain(pcm) {
    if (percent === 100 || pcm.length < 2) return pcm;
    const gain = percent / 100;
    const n = pcm.length - (pcm.length & 1); // whole int16 samples only
    const out = Buffer.allocUnsafe(pcm.length);
    for (let i = 0; i < n; i += 2) {
      let v = Math.round(pcm.readInt16LE(i) * gain);
      if (v > 32767) v = 32767;
      else if (v < -32768) v = -32768;
      out.writeInt16LE(v, i);
    }
    if (n !== pcm.length) out[n] = pcm[n]; // defensive: carry a stray trailing byte
    return out;
  }

  return {
    applyGain,
    setPercent,
    getPercent: () => percent,
    maxPercent: () => max,
  };
}
