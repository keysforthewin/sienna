#pragma once
#include <Arduino.h>
#include <functional>

namespace ble_provisioning {

// UUIDs (random v4, dashboard's Web Bluetooth filter must match)
constexpr const char* SVC_UUID    = "7a3f4e80-2b1f-4ad6-9c1d-d6e0a1b2c3d4";
constexpr const char* CH_SSID     = "7a3f4e81-2b1f-4ad6-9c1d-d6e0a1b2c3d4";
constexpr const char* CH_PASS     = "7a3f4e82-2b1f-4ad6-9c1d-d6e0a1b2c3d4";
constexpr const char* CH_URL      = "7a3f4e83-2b1f-4ad6-9c1d-d6e0a1b2c3d4";
constexpr const char* CH_TOKEN    = "7a3f4e84-2b1f-4ad6-9c1d-d6e0a1b2c3d4";
constexpr const char* CH_COMMIT   = "7a3f4e85-2b1f-4ad6-9c1d-d6e0a1b2c3d4";
constexpr const char* CH_STATUS   = "7a3f4e86-2b1f-4ad6-9c1d-d6e0a1b2c3d4";
constexpr const char* CH_SCAN     = "7a3f4e87-2b1f-4ad6-9c1d-d6e0a1b2c3d4";

// Called when the user writes 0x01 to Commit. Args are the staged values.
using CommitCb = std::function<void(const String& ssid, const String& pass,
                                    const String& url,  const String& token)>;

void begin(const CommitCb& cb);
void start();   // start advertising
void stop();    // stop advertising and tear down
bool running();
bool takeScanRequest();  // true once if the client asked for a Wi-Fi scan, then clears the flag
void publishStatus(const char* json);  // notify Status characteristic
void publishScanResult(const char* json);

}  // namespace ble_provisioning
