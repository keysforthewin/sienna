#include "agent_tools.h"
#include <ArduinoJson.h>
#include <NimBLEDevice.h>
#include "ws_client.h"
#include "protocol.h"
#include "log.h"

namespace agent_tools {

// ---- Countdown timers ----
static const int kMaxTimers = 8;
struct Timer { bool active; uint32_t id; uint32_t expiryMs; String label; };
static Timer gTimers[kMaxTimers];
static uint32_t gNextTimerId = 1;

void begin() {
  for (int i = 0; i < kMaxTimers; i++) gTimers[i].active = false;
}

uint32_t setTimer(uint32_t seconds, const String& label) {
  for (int i = 0; i < kMaxTimers; i++) {
    if (!gTimers[i].active) {
      gTimers[i].active = true;
      gTimers[i].id = gNextTimerId++;
      gTimers[i].expiryMs = millis() + seconds * 1000UL;
      gTimers[i].label = label;
      LOGI("timer: set #%u for %us (%s)", gTimers[i].id, seconds, label.c_str());
      return gTimers[i].id;
    }
  }
  return 0;  // table full
}

bool cancelTimer(uint32_t id) {
  for (int i = 0; i < kMaxTimers; i++) {
    if (gTimers[i].active && gTimers[i].id == id) { gTimers[i].active = false; return true; }
  }
  return false;
}

static void tickTimers() {
  uint32_t nowMs = millis();
  for (int i = 0; i < kMaxTimers; i++) {
    // signed difference handles millis() wraparound
    if (gTimers[i].active && (int32_t)(nowMs - gTimers[i].expiryMs) >= 0) {
      gTimers[i].active = false;
      LOGI("timer: #%u fired (%s)", gTimers[i].id, gTimers[i].label.c_str());
      ws_client::sendText(protocol::buildTimerFired(gTimers[i].id, gTimers[i].label.c_str()));
    }
  }
}

// ---- Non-blocking BLE scan ----
// NimBLE is deinitialized after Wi-Fi provisioning, so we re-init on demand. We
// don't deinit afterwards (it coexists with Wi-Fi); a later re-provision's
// NimBLEDevice::init() is a no-op when already initialized.
static const uint32_t kScanMs = 3000;
static const int kMaxDevices = 24;
static bool gScanPending = false;
static String gBleRef;
static uint32_t gScanStartMs = 0;

bool beginBleScan(const String& ref) {
  if (gScanPending) return false;
  if (!NimBLEDevice::isInitialized()) NimBLEDevice::init("Sienna");
  NimBLEScan* scan = NimBLEDevice::getScan();
  scan->setActiveScan(true);
  scan->clearResults();
  scan->start(kScanMs, false /* non-blocking */);
  gBleRef = ref;
  gScanPending = true;
  gScanStartMs = millis();
  LOGI("ble: scan started (ref %s)", ref.c_str());
  return true;
}

static void sendBleResults() {
  NimBLEScan* scan = NimBLEDevice::getScan();
  NimBLEScanResults results = scan->getResults();
  JsonDocument doc;
  JsonArray arr = doc.to<JsonArray>();
  int count = results.getCount();
  for (int i = 0; i < count && i < kMaxDevices; i++) {
    const NimBLEAdvertisedDevice* d = results.getDevice(i);
    JsonObject o = arr.add<JsonObject>();
    String name = String(d->getName().c_str());
    o["name"] = name.length() ? name : String("(unknown)");
    o["rssi"] = d->getRSSI();
    o["addr"] = String(d->getAddress().toString().c_str());
    if (measureJson(doc) > 1200) { arr.remove(arr.size() - 1); break; }
  }
  String json;
  serializeJson(doc, json);
  ws_client::sendText(protocol::buildBleScan(gBleRef.c_str(), json));
  scan->clearResults();
  LOGI("ble: scan -> %d devices", (int)arr.size());
}

static void tickBleScan() {
  if (!gScanPending) return;
  NimBLEScan* scan = NimBLEDevice::getScan();
  // Finished normally, or a safety timeout in case isScanning() never clears.
  if (!scan->isScanning() || (int32_t)(millis() - (gScanStartMs + kScanMs + 2000)) >= 0) {
    if (scan->isScanning()) scan->stop();
    gScanPending = false;
    sendBleResults();
  }
}

void tick() {
  tickTimers();
  tickBleScan();
}

}  // namespace agent_tools
