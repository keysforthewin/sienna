#include "ldr.h"

#include <Arduino.h>
#include "pins.h"

namespace ldr {

static std::function<void(int)> gCallback;
static uint32_t gIntervalMs = 200;
static uint32_t gLastPushMs = 0;

void begin() {
  pinMode(pins::LDR, INPUT);
  analogSetPinAttenuation(pins::LDR, ADC_11db);
}

int readNow() {
  return analogRead(pins::LDR);
}

void setPushHz(float hz) {
  if (hz <= 0.0f) {
    gIntervalMs = 0;
    return;
  }
  gIntervalMs = (uint32_t)(1000.0f / hz);
  if (gIntervalMs < 20) gIntervalMs = 20;
}

void onPush(std::function<void(int)> cb) {
  gCallback = std::move(cb);
}

void tick() {
  if (gIntervalMs == 0 || !gCallback) return;
  uint32_t now = millis();
  if (now - gLastPushMs < gIntervalMs) return;
  gLastPushMs = now;
  gCallback(readNow());
}

}  // namespace ldr
