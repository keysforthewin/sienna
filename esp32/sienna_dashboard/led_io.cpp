#include "led_io.h"

#include <Arduino.h>
#include "pins.h"

namespace led_io {

static uint8_t  gStatusR = 0, gStatusG = 0, gStatusB = 0;
static uint8_t  gLastAppliedR = 255, gLastAppliedG = 255, gLastAppliedB = 255;
static bool     gOverridden = false;                          // an explicit color owns the LED
static uint8_t  gOverrideR = 0, gOverrideG = 0, gOverrideB = 0;

// LEDC PWM helpers (Arduino ESP32 v3 API: ledcAttach + ledcWrite by pin)
static void writeRgb(uint8_t r, uint8_t g, uint8_t b) {
  // Common-anode LED (per existing led_test.ino convention): invert.
  ledcWrite(pins::RGB_R, 255 - r);
  ledcWrite(pins::RGB_G, 255 - g);
  ledcWrite(pins::RGB_B, 255 - b);
  gLastAppliedR = r; gLastAppliedG = g; gLastAppliedB = b;
}

void begin() {
  pinMode(pins::LED_BLUE, OUTPUT);
  digitalWrite(pins::LED_BLUE, LOW);

  pinMode(pins::LED_FLASH, OUTPUT);
  digitalWrite(pins::LED_FLASH, LOW);

  // 12 kHz, 8-bit
  ledcAttach(pins::RGB_R, 12000, 8);
  ledcAttach(pins::RGB_G, 12000, 8);
  ledcAttach(pins::RGB_B, 12000, 8);
  writeRgb(0, 0, 0);
}

// Blue LED: the commanded state is tracked so the PTT flash can override the
// pin and still restore correctly — a set_blue_led arriving MID-flash updates
// the restore target, not the (flashing) pin.
static bool     gBlueOn = false;          // last commanded state (the restore target)
static bool     gBlueFlashing = false;    // PTT held: 3 Hz override owns the pin
static bool     gBlueFlashLevel = false;
static uint32_t gBlueFlashAt = 0;
static const uint32_t kBlueFlashHalfMs = 167;   // ~3 Hz on/off cycle

void setBlue(bool on) {
  gBlueOn = on;
  if (!gBlueFlashing) digitalWrite(pins::LED_BLUE, on ? HIGH : LOW);
}

void setBlueFlash(bool flashing) {
  if (flashing == gBlueFlashing) return;
  gBlueFlashing = flashing;
  if (flashing) {
    gBlueFlashLevel = true;
    gBlueFlashAt = millis();
    digitalWrite(pins::LED_BLUE, HIGH);   // start visibly ON
  } else {
    digitalWrite(pins::LED_BLUE, gBlueOn ? HIGH : LOW);   // restore commanded state
  }
}

void setFlash(bool on) {
  digitalWrite(pins::LED_FLASH, on ? HIGH : LOW);
}

void setRgb(uint8_t r, uint8_t g, uint8_t b) {
  gOverridden = true;
  gOverrideR = r; gOverrideG = g; gOverrideB = b;
  writeRgb(r, g, b);
}

// important=true  → a connection problem or boot step: show it even over an
//                   explicit color (so an offline device is visible at a glance).
// important=false → the steady "online" look, which must never stomp an explicit
//                   color: restore the set color if there is one, else show it.
void setStatusColor(uint8_t r, uint8_t g, uint8_t b, bool important) {
  gStatusR = r; gStatusG = g; gStatusB = b;
  if (important)        writeRgb(r, g, b);
  else if (gOverridden) writeRgb(gOverrideR, gOverrideG, gOverrideB);  // back online → restore set color
  else                  writeRgb(r, g, b);                             // online, no explicit color yet → green
}

void tick() {
  // RGB needs no periodic work (explicit colors are sticky; status changes
  // apply immediately in setStatusColor()). The blue LED flashes at 3 Hz while
  // the PTT button is held — non-blocking millis() bookkeeping.
  if (gBlueFlashing && (uint32_t)(millis() - gBlueFlashAt) >= kBlueFlashHalfMs) {
    gBlueFlashAt = millis();
    gBlueFlashLevel = !gBlueFlashLevel;
    digitalWrite(pins::LED_BLUE, gBlueFlashLevel ? HIGH : LOW);
  }
}

}  // namespace led_io
