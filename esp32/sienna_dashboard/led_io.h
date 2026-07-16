#pragma once
#include <stdint.h>

namespace led_io {

void begin();

// Direct user controls
void setBlue(bool on);
void setFlash(bool on);
void setRgb(uint8_t r, uint8_t g, uint8_t b);  // takes over the LED until the next set or reboot

// Push-to-talk "mic is hot" indicator: while flashing, the blue LED toggles at
// 3 Hz (tick()-driven, non-blocking) and setBlue() only updates the restore
// target; leaving flash restores the last commanded state.
void setBlueFlash(bool flashing);

// Status overlay from the state machine. important=true surfaces a connection
// problem/boot step even over an explicit color; important=false (steady online)
// yields to an explicit color.
void setStatusColor(uint8_t r, uint8_t g, uint8_t b, bool important);

void tick();  // call from loop() — drives the PTT blue-LED flash

}  // namespace led_io
