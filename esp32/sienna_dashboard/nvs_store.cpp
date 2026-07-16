#include "nvs_store.h"
#include <Preferences.h>
#include "log.h"

namespace nvs_store {

static const char* NS = "sienna";
static Preferences prefs;

void begin() {
  // Preferences::begin() opens NVS lazily; nothing to do globally.
}

Creds load() {
  Creds c{};
  prefs.begin(NS, true);  // read-only
  c.ssid       = prefs.getString("ssid",       "");
  c.pass       = prefs.getString("pass",       "");
  c.serverUrl  = prefs.getString("server_url", "");
  c.authToken  = prefs.getString("auth_token", "");
  c.version    = prefs.getUChar ("prov_v",     0);
  prefs.end();
  c.valid = c.ssid.length() && c.pass.length() && c.serverUrl.length() && c.authToken.length();
  return c;
}

void save(const String& ssid, const String& pass,
          const String& serverUrl, const String& authToken) {
  prefs.begin(NS, false);  // read-write
  prefs.putString("ssid",       ssid);
  prefs.putString("pass",       pass);
  prefs.putString("server_url", serverUrl);
  prefs.putString("auth_token", authToken);
  uint8_t v = prefs.getUChar("prov_v", 0) + 1;
  prefs.putUChar("prov_v", v);
  prefs.end();
  LOGI("nvs_store: saved (v=%u, ssid=%s)", v, ssid.c_str());
}

void erase() {
  prefs.begin(NS, false);
  prefs.clear();
  prefs.end();
  LOGI("nvs_store: erased");
}

}  // namespace nvs_store
