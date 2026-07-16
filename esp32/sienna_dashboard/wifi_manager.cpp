#include "wifi_manager.h"
#include <WiFi.h>
#include <ArduinoJson.h>
#include "log.h"

namespace wifi_manager {

static String gSsid, gPass;
static bool gConnecting = false;
static uint32_t gAttemptStartedMs = 0;
static uint32_t gNextRetryMs = 0;
static const uint32_t kAttemptTimeoutMs = 20000;
static const uint32_t kRetryGapMs = 5000;

static std::function<void()> gOnConn;
static std::function<void(const char*)> gOnDisc;
static bool gWasConnected = false;

// Disconnect diagnostics — written from the WiFi event task, read from loop().
static volatile int      gLastDiscReason = 0;
static volatile uint32_t gDiscCount = 0;

const char* disconnectReasonName(int reason) {
  switch (reason) {
    case 1:   return "UNSPECIFIED";
    case 2:   return "AUTH_EXPIRE";
    case 3:   return "AUTH_LEAVE";
    case 4:   return "ASSOC_EXPIRE";
    case 5:   return "ASSOC_TOOMANY";
    case 8:   return "ASSOC_LEAVE";
    case 15:  return "4WAY_HANDSHAKE_TIMEOUT";
    case 200: return "BEACON_TIMEOUT";
    case 201: return "NO_AP_FOUND";
    case 202: return "AUTH_FAIL";
    case 203: return "ASSOC_FAIL";
    case 204: return "HANDSHAKE_TIMEOUT";
    case 205: return "CONNECTION_FAIL";
    default:  return "?";
  }
}

int      lastDisconnectReason() { return gLastDiscReason; }
uint32_t disconnectCount()      { return gDiscCount; }

void begin() {
  WiFi.mode(WIFI_STA);
  // Capture WHY every Wi-Fi drop happened (the status()-based tick() below only
  // sees THAT it dropped). Runs on the WiFi event task — keep it to stores + a
  // log line.
  WiFi.onEvent([](WiFiEvent_t, WiFiEventInfo_t info) {
    int reason = info.wifi_sta_disconnected.reason;
    gLastDiscReason = reason;
    gDiscCount = gDiscCount + 1;
    LOGW("wifi: STA_DISCONNECTED reason=%d (%s) count=%u",
         reason, disconnectReasonName(reason), (unsigned)gDiscCount);
  }, ARDUINO_EVENT_WIFI_STA_DISCONNECTED);
}

void onConnected(std::function<void()> cb)              { gOnConn = std::move(cb); }
void onDisconnected(std::function<void(const char*)> cb){ gOnDisc = std::move(cb); }

void connect(const String& ssid, const String& pass) {
  gSsid = ssid; gPass = pass;
  WiFi.disconnect();
  delay(50);
  LOGI("wifi: connecting to %s", ssid.c_str());
  WiFi.begin(ssid.c_str(), pass.c_str());
  // Disable Wi-Fi modem sleep (default WIFI_PS_MIN_MODEM). With it on, the radio
  // sleeps between DTIM beacons and delivers buffered packets in bursts (~100-300 ms
  // gaps), which underruns the ~448 ms playback ring during music → choppy audio.
  // Streaming at 256 kbit/s is nowhere near the link's bandwidth, so the only cost
  // here is ~20-30 mA more draw (irrelevant on USB/mains). Set after begin() so it
  // lands on the live interface, robust across reconnects.
  WiFi.setSleep(false);
  gConnecting = true;
  gAttemptStartedMs = millis();
}

void disconnect() {
  gConnecting = false;
  WiFi.disconnect();
}

bool isConnected() { return WiFi.status() == WL_CONNECTED; }
String ip()        { return WiFi.localIP().toString(); }
int    rssi()      { return WiFi.RSSI(); }

void scan(std::function<void(const String&)> cb) {
  int n = WiFi.scanNetworks();

  // A blocking scan fails (WIFI_SCAN_FAILED, -2) while a connect attempt is in
  // flight — which is exactly the state the WIFI_TRYING BLE backchannel is used
  // from (re-provisioning a device whose saved network is gone). Abort the
  // attempt, scan with the radio idle, and let tick()'s retry path resume the
  // connect afterwards.
  if (n < 0 && gConnecting) {
    LOGW("wifi: scan blocked by in-flight connect (%d) — pausing connect to scan", n);
    gConnecting = false;
    WiFi.disconnect();
    delay(100);
    gNextRetryMs = millis() + kRetryGapMs;  // tick() re-arms the connect attempt
    n = WiFi.scanNetworks();
  }
  if (n < 0) {
    // Surface the failure instead of publishing an empty list the page can't
    // distinguish from "no networks nearby".
    LOGW("wifi: scan failed (%d)", n);
    String err = String("{\"error\":\"scan_failed\",\"code\":") + n + "}";
    cb(err);
    return;
  }

  // Order by RSSI, strongest first (scanNetworks() returns no guaranteed order).
  static const int kMaxScan = 64;
  int order[kMaxScan];
  int m = n < kMaxScan ? n : kMaxScan;
  for (int i = 0; i < m; i++) order[i] = i;
  for (int i = 0; i < m; i++)
    for (int j = i + 1; j < m; j++)
      if (WiFi.RSSI(order[j]) > WiFi.RSSI(order[i])) {
        int t = order[i]; order[i] = order[j]; order[j] = t;
      }

  // Emit strongest-first, de-duping repeated SSIDs (multi-AP networks) and
  // skipping hidden ones, until the JSON would overflow a single BLE
  // notification (payload must fit ~MTU-3; ~220 B is safe for Chrome's MTU).
  static const size_t kBudget = 220;
  JsonDocument doc;
  JsonArray arr = doc.to<JsonArray>();
  String seen;
  for (int k = 0; k < m; k++) {
    String ssid = WiFi.SSID(order[k]);
    if (ssid.isEmpty()) continue;             // hidden network
    String key = "|" + ssid + "|";
    if (seen.indexOf(key) >= 0) continue;     // duplicate SSID (multi-AP)
    JsonObject o = arr.add<JsonObject>();
    o["ssid"]    = ssid;
    o["rssi"]    = WiFi.RSSI(order[k]);
    o["secured"] = WiFi.encryptionType(order[k]) != WIFI_AUTH_OPEN;
    if (measureJson(doc) > kBudget) { arr.remove(arr.size() - 1); break; }
    seen += key;
  }
  WiFi.scanDelete();  // free the scan result buffer

  String s; serializeJson(doc, s);
  LOGI("wifi: scan -> %d found, %d sent, %u B", n, (int)arr.size(), (unsigned)s.length());
  cb(s);
}

// ---- Non-blocking scan (agent device-RPC over WS) ----
static bool gAsyncScanRunning = false;

bool beginScanAsync() {
  if (gAsyncScanRunning) return false;        // one at a time
  WiFi.scanNetworks(true /*async*/, false /*show_hidden*/);
  gAsyncScanRunning = true;
  return true;
}

bool pollScanAsync(String& outJson) {
  if (!gAsyncScanRunning) return false;
  int n = WiFi.scanComplete();
  if (n == WIFI_SCAN_RUNNING || n < 0) return false;   // still running / not started

  // Order by RSSI, strongest first.
  static const int kMaxScan = 64;
  int order[kMaxScan];
  int m = n < kMaxScan ? n : kMaxScan;
  for (int i = 0; i < m; i++) order[i] = i;
  for (int i = 0; i < m; i++)
    for (int j = i + 1; j < m; j++)
      if (WiFi.RSSI(order[j]) > WiFi.RSSI(order[i])) {
        int t = order[i]; order[i] = order[j]; order[j] = t;
      }

  // WS frames are far roomier than a BLE notification — allow more networks.
  static const size_t kBudget = 1200;
  JsonDocument doc;
  JsonArray arr = doc.to<JsonArray>();
  String seen;
  for (int k = 0; k < m; k++) {
    String ssid = WiFi.SSID(order[k]);
    if (ssid.isEmpty()) continue;
    String key = "|" + ssid + "|";
    if (seen.indexOf(key) >= 0) continue;
    JsonObject o = arr.add<JsonObject>();
    o["ssid"]    = ssid;
    o["rssi"]    = WiFi.RSSI(order[k]);
    o["secured"] = WiFi.encryptionType(order[k]) != WIFI_AUTH_OPEN;
    if (measureJson(doc) > kBudget) { arr.remove(arr.size() - 1); break; }
    seen += key;
  }
  WiFi.scanDelete();
  gAsyncScanRunning = false;
  serializeJson(doc, outJson);
  LOGI("wifi: async scan -> %d found, %d sent", n, (int)arr.size());
  return true;
}

void tick() {
  bool connected = isConnected();
  if (connected && !gWasConnected) {
    gWasConnected = true;
    gConnecting = false;
    LOGI("wifi: connected, ip=%s rssi=%d", ip().c_str(), rssi());
    if (gOnConn) gOnConn();
  } else if (!connected && gWasConnected) {
    gWasConnected = false;
    LOGI("wifi: lost");
    if (gOnDisc) gOnDisc("lost");
  }

  if (!connected && gConnecting) {
    if (millis() - gAttemptStartedMs > kAttemptTimeoutMs) {
      LOGW("wifi: attempt timeout");
      gConnecting = false;
      gNextRetryMs = millis() + kRetryGapMs;
      WiFi.disconnect();
      if (gOnDisc) gOnDisc("attempt_timeout");
    }
  } else if (!connected && !gConnecting && gSsid.length() && millis() >= gNextRetryMs && gNextRetryMs != 0) {
    connect(gSsid, gPass);
  }
}

}  // namespace wifi_manager
