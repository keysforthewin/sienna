#pragma once
#include <Arduino.h>
#include <functional>

namespace state {

enum class S {
  BOOTING,
  BLE_PROVISIONING,
  WIFI_TRYING,
  WS_OPENING,
  ONLINE,
  RECOVERING,
};

const char* name(S s);
S           current();
void        set(S s, const char* lastError = nullptr);

// Optional cached metadata (set by wifi_manager / ws_client)
void setIp(const String& ip);
void setRssi(int rssi);
String currentIp();
int    currentRssi();
const char* currentError();

void onChange(std::function<void(S)> cb);

}  // namespace state
