#include "state.h"
#include "log.h"

namespace state {

static S gCurrent = S::BOOTING;
static String gIp;
static int gRssi = INT_MIN;
static String gError;
static std::function<void(S)> gCallback;

const char* name(S s) {
  switch (s) {
    case S::BOOTING:           return "BOOTING";
    case S::BLE_PROVISIONING:  return "BLE_PROVISIONING";
    case S::WIFI_TRYING:       return "WIFI_TRYING";
    case S::WS_OPENING:        return "WS_OPENING";
    case S::ONLINE:            return "ONLINE";
    case S::RECOVERING:        return "RECOVERING";
  }
  return "?";
}

S current() { return gCurrent; }

void set(S s, const char* lastError) {
  if (s == gCurrent && (lastError == nullptr || gError == lastError)) return;
  LOGI("state: %s -> %s%s%s", name(gCurrent), name(s),
       lastError ? " err=" : "", lastError ? lastError : "");
  gCurrent = s;
  if (lastError) gError = lastError; else gError = "";
  if (gCallback) gCallback(s);
}

void setIp(const String& ip)   { gIp = ip; }
void setRssi(int rssi)         { gRssi = rssi; }
String currentIp()              { return gIp; }
int    currentRssi()            { return gRssi; }
const char* currentError()     { return gError.c_str(); }
void onChange(std::function<void(S)> cb) { gCallback = std::move(cb); }

}  // namespace state
