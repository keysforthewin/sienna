#pragma once
#include <Arduino.h>
#include <functional>

namespace wifi_manager {

void begin();
void connect(const String& ssid, const String& pass);
void disconnect();
bool isConnected();
String ip();
int    rssi();

// One JSON line per scan result is delivered via cb (e.g. [{"ssid":"x","rssi":-50,"secured":true}, ...])
void scan(std::function<void(const String& json)> cb);

// Non-blocking scan for the dashboard agent (the synchronous scan() above would
// starve the cooperative loop while ONLINE). beginScanAsync() kicks off a scan;
// pollScanAsync() returns true once when results are ready, filling `outJson`
// with the same [{ssid,rssi,secured}, ...] array (larger budget than BLE).
bool beginScanAsync();
bool pollScanAsync(String& outJson);

// Disconnect diagnostics (from the IDF WIFI_STA_DISCONNECTED event): the raw
// reason code of the most recent drop (0 = none yet), a human-readable name
// for the common codes, and how many drops since boot. The reason code is the
// key datum for "random disconnects" — e.g. 200 BEACON_TIMEOUT (weak signal /
// AP went quiet) vs 8 ASSOC_LEAVE (we left) vs 2 AUTH_EXPIRE (AP kicked us).
int         lastDisconnectReason();
const char* disconnectReasonName(int reason);
uint32_t    disconnectCount();

void onConnected(std::function<void()> cb);
void onDisconnected(std::function<void(const char* reason)> cb);

void tick();   // call from loop()

}  // namespace wifi_manager
