#pragma once
#include <Arduino.h>

// Device-side helpers for the Sienna dashboard agent: countdown timers and a
// non-blocking Bluetooth scan. Everything here is cooperative — tick() is polled
// from loop() and never blocks (a blocking scan would starve the WS reader; see
// the loop-starvation note in the project memory).

namespace agent_tools {

void begin();
void tick();   // call from loop()

// Countdown timers. setTimer returns a non-zero id, or 0 if the table is full.
// On expiry a timer_fired{id,label} message is sent to the server.
uint32_t setTimer(uint32_t seconds, const String& label);
bool     cancelTimer(uint32_t id);

// Start a non-blocking BLE scan. The ble_scan{ref,devices[]} result is sent when
// the scan finishes (polled in tick()). Returns false if a scan is already
// running.
bool beginBleScan(const String& ref);

}  // namespace agent_tools
