#pragma once
#include <functional>
#include <stdint.h>

namespace buttons {

void begin();
void onBootLongPress(std::function<void()> cb);   // ≥3 s
// Push-to-talk button (GPIO 45, active-low): fired on every debounced edge —
// true on press, false on release.
void onPttChange(std::function<void(bool pressed)> cb);
// Debounced PTT state — true while the button is held. Used by the mic gate:
// while held, the half-duplex "no mic while the speaker plays" rule is lifted
// so the user's speech streams over the server's ducked music bed.
bool pttHeld();
// RAW PTT level (a direct digitalRead, no debounce): the audio instant-mute
// probe. Called from the playback task per frame; must stay cheap and
// thread-safe (a bare GPIO read is both). Bounce shows up only as ≤30 ms of
// muting jitter on an edge — inaudible at 64 ms playback frames.
bool pttRawDown();
void tick();

}  // namespace buttons
