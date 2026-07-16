#include "ble_provisioning.h"
#include <NimBLEDevice.h>
#include "log.h"

namespace ble_provisioning {

static NimBLEServer* gServer = nullptr;
static NimBLEService* gService = nullptr;
static NimBLECharacteristic *gSsid = nullptr, *gPass = nullptr, *gUrl = nullptr,
                            *gToken = nullptr, *gCommit = nullptr, *gStatus = nullptr,
                            *gScan = nullptr;
static String gStagedSsid, gStagedPass, gStagedUrl, gStagedToken;
static CommitCb gCommitCb;
static bool gRunning = false;
static volatile bool gWantScan = false;  // set in BLE host task, read in loop()

class WriteCB : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* ch, NimBLEConnInfo&) override {
    String value = ch->getValue().c_str();
    if (ch == gSsid)        gStagedSsid  = value;
    else if (ch == gPass)   gStagedPass  = value;
    else if (ch == gUrl)    gStagedUrl   = value;
    else if (ch == gToken)  gStagedToken = value;
    else if (ch == gCommit) {
      if (value.length() >= 1 && value[0] == 0x01 && gCommitCb) {
        gCommitCb(gStagedSsid, gStagedPass, gStagedUrl, gStagedToken);
      }
    } else if (ch == gScan) {
      if (value.length() >= 1 && value[0] == 0x01) gWantScan = true;
    }
  }
};

class ServerCB : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer*, NimBLEConnInfo&) override { LOGI("BLE: client connected"); }
  void onDisconnect(NimBLEServer*, NimBLEConnInfo&, int) override {
    LOGI("BLE: client disconnected");
    if (gRunning) NimBLEDevice::startAdvertising();
  }
};

void begin(const CommitCb& cb) {
  gCommitCb = cb;
}

void start() {
  if (gRunning) return;
  NimBLEDevice::init("Sienna");
  gServer = NimBLEDevice::createServer();
  gServer->setCallbacks(new ServerCB());
  gService = gServer->createService(SVC_UUID);
  static WriteCB wcb;
  gSsid   = gService->createCharacteristic(CH_SSID,   NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::WRITE);
  gPass   = gService->createCharacteristic(CH_PASS,                              NIMBLE_PROPERTY::WRITE);
  gUrl    = gService->createCharacteristic(CH_URL,    NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::WRITE);
  gToken  = gService->createCharacteristic(CH_TOKEN,                             NIMBLE_PROPERTY::WRITE);
  gCommit = gService->createCharacteristic(CH_COMMIT,                            NIMBLE_PROPERTY::WRITE);
  gStatus = gService->createCharacteristic(CH_STATUS, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
  gScan   = gService->createCharacteristic(CH_SCAN,   NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::NOTIFY);
  for (auto* c : { gSsid, gPass, gUrl, gToken, gCommit, gScan }) c->setCallbacks(&wcb);
  gService->start();
  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  adv->addServiceUUID(SVC_UUID);
  adv->enableScanResponse(true);
  adv->setName("Sienna");
  NimBLEDevice::startAdvertising();
  gRunning = true;
  LOGI("BLE: advertising as 'Sienna' (svc %s)", SVC_UUID);
}

void stop() {
  if (!gRunning) return;
  // Clear gRunning FIRST so ServerCB::onDisconnect can't re-arm advertising while we
  // tear the stack down (it gates on gRunning). Then let the NimBLE host task on the
  // radio core drain any in-flight advertising/GAP completion before deinit() frees
  // the objects out from under it — otherwise it calls through a freed callback and
  // panics with InstrFetchProhibited (PC=0) mid-deinit. (Intermittent boot crash.)
  gRunning = false;
  if (gServer) gServer->advertiseOnDisconnect(false);
  NimBLEDevice::stopAdvertising();
  delay(100);  // settle: host task processes the advertising-stop before teardown
  NimBLEDevice::deinit(true);
  gServer = nullptr; gService = nullptr;
  gSsid = gPass = gUrl = gToken = gCommit = gStatus = gScan = nullptr;
  LOGI("BLE: stopped");
}

bool running() { return gRunning; }

bool takeScanRequest() {
  if (!gWantScan) return false;
  gWantScan = false;
  return true;
}

void publishStatus(const char* json) {
  if (!gStatus) return;
  gStatus->setValue((uint8_t*)json, strlen(json));
  gStatus->notify();
}

void publishScanResult(const char* json) {
  if (!gScan) return;
  gScan->setValue((uint8_t*)json, strlen(json));
  gScan->notify();
}

}  // namespace ble_provisioning
