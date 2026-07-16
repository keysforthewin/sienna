#pragma once
#include <Arduino.h>

namespace nvs_store {

struct Creds {
  String ssid;
  String pass;
  String serverUrl;
  String authToken;
  uint8_t version;
  bool   valid;  // true iff all four fields are non-empty
};

void  begin();
Creds load();
void  save(const String& ssid, const String& pass,
           const String& serverUrl, const String& authToken);
void  erase();

}  // namespace nvs_store
