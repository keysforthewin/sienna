# Dashboard rework — dual volume knobs, Logs view, browser PTT, eavesdrop guard

Date: 2026-07-31. Implemented same-session (explicit spec from Steve; decisions
below were made autonomously and are called out).

## Requirements (as given)

1. Move the volume slider from Diagnostics → Interact; split into TWO
   independent channels — one for music, one for speech — rendered as knobs
   that look like real volume dials.
2. Eavesdrop: if the transcript is empty / whitespace / "no text matched",
   do nothing — no searches, skip the day's eavesdrop.
3. Move the Autonomous speech checkbox from Interact → Diagnostics.
4. New fourth header tab **Logs** (after Usage) holding the Activity /
   Messages / Memories / Personality History / Tool Calls / Images tabs.
5. Interact: replace the Speech panel's Clear button with a **Push to talk**
   button; each press clears the transcript log once new text arrives.

## Design decisions

- **Two `volume.js` instances, not one module rewrite.** `index.js` builds
  `volumes = { voice, music }`; `audio-out.js` picks the gain per channel in
  `sendFrame` (it already had voice/music channel objects). Browser PCM
  (Speak / Hold-to-talk) and the beep amplitudes ride the **voice** gain.
- **Duck-bed compensation.** The ducked music bed is mixed into voice frames
  and then receives the VOICE gain; the bed term is scaled by
  `duckGain·min(1, music/voice)` so a quiet music setting holds through
  ducking. Capped at `duckGain` to preserve the convex-blend no-clipping bound.
- **Protocol.** `set_volume` gains an optional `channel: "voice"|"music"`;
  omitted = set both (legacy master semantics — also the default for Sienna's
  `set_volume` tool, which now takes `channel: voice|music|both`). Broadcasts
  and the connect snapshot are per-channel `{type:"volume", channel, percent,
  max}`.
- **Persistence.** New settings keys `volume_voice` / `volume_music`; the old
  `volume` key seeds a missing channel at boot (seamless upgrade).
- **Browser PTT = the device button, remoted.** New `{type:"ptt", pressed}`
  browser message → `ptt.onButton` (the same coordinator as GPIO 45), plus a
  re-broadcast device-shaped `button` event so every Speech panel's light
  reacts. The mic that opens is the DEVICE mic — press refused with
  `device_offline` when no device; a tab closing mid-hold auto-releases.
  Chosen over a browser-microphone path because it reuses the whole
  mute/beep/transcribe/route chain unchanged.
- **Clear-on-new-text.** The on-screen press sets a `pendingClear` flag; the
  next transcript event (interim or final) with text clears the log first.
  Old text stays visible until the new hold actually produces words.
- **Eavesdrop guard.** The existing trim check already skipped truly-empty
  transcripts; the phantom trigger was Scribe's non-speech commits
  (punctuation-only "...", bracketed sound-tags "(door closes)"). The guard now
  strips `(...)`/`[...]` and requires at least one Unicode letter/digit.
- **Logs view.** `sienna.js` now mounts the composer into `#panel-sienna`
  (Interact) and the tab strip + feeds into `#panel-sienna-logs` (Logs).
  Views hide via the `hidden` attribute, so the feeds' JS stays live while
  Logs isn't showing.
- **Knob component.** `panels/volume-knobs.js`: SVG dials on the existing
  design tokens — 270° tick ring, accent value arc, machined gradient cap,
  pointer notch. Vertical drag (pointer capture), wheel ±5, arrows/PageUp/Home,
  double-click = 100%. `role=slider` divs → untouched by `disableAllControls`
  (server-side state, usable offline), with ARIA value attributes.
- Incidental fix: `.sienna-nowplaying[hidden]` display rule (the flex rule was
  beating the UA hidden style, showing an empty bar), and the speech-log empty
  copy no longer references the long-gone Transcribe toggle.

## Verification

- `npm test` — full suite green (771 tests), including new tests: eavesdrop
  junk-transcript skips, per-channel `set_volume` (ws + tool), music-vs-voice
  gain in audio-out, browser `ptt` routing/broadcast/offline/auto-release.
- Rendered visually via a throwaway server (port 3999) + Chrome: knobs on
  Interact, Agent panel on Diagnostics, Logs tabs, disabled PTT while offline.
