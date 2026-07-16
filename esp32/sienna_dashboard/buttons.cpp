#include "buttons.h"
#include <Arduino.h>
#include "pins.h"
#include "log.h"

namespace buttons {

static std::function<void()> gOnLong;
static const uint32_t kLongMs = 3000;
static uint32_t gPressedSince = 0;
static bool gFired = false;

// PTT (GPIO 45): time-based debounce. A raw level change starts the clock;
// only a level held kDebounceMs becomes the new stable state and fires the edge.
static std::function<void(bool)> gOnPtt;
static const uint32_t kDebounceMs = 30;
static bool gPttStable = false;       // debounced pressed-state
static bool gPttRaw = false;          // last raw read
static uint32_t gPttChangedAt = 0;    // when the raw level last changed

void begin() {
  pinMode(pins::BOOT_BTN, INPUT_PULLUP);
  pinMode(pins::PTT_BTN, INPUT_PULLUP);   // button to GND, active-low
}

void onBootLongPress(std::function<void()> cb) { gOnLong = std::move(cb); }
void onPttChange(std::function<void(bool)> cb) { gOnPtt = std::move(cb); }
bool pttHeld() { return gPttStable; }
bool pttRawDown() { return digitalRead(pins::PTT_BTN) == LOW; }

void tick() {
  bool pressed = (digitalRead(pins::BOOT_BTN) == LOW);
  if (pressed) {
    if (gPressedSince == 0) gPressedSince = millis();
    if (!gFired && millis() - gPressedSince >= kLongMs) {
      gFired = true;
      LOGI("buttons: BOOT long-press");
      if (gOnLong) gOnLong();
    }
  } else {
    gPressedSince = 0;
    gFired = false;
  }

  bool raw = (digitalRead(pins::PTT_BTN) == LOW);
  if (raw != gPttRaw) {
    gPttRaw = raw;
    gPttChangedAt = millis();
  } else if (raw != gPttStable && millis() - gPttChangedAt >= kDebounceMs) {
    gPttStable = raw;
    LOGI("buttons: PTT %s", raw ? "pressed" : "released");
    if (gOnPtt) gOnPtt(raw);
  }
}

}  // namespace buttons
