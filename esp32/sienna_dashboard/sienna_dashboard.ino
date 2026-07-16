// sienna_dashboard.ino — full wire-up.
//
// State machine:
//   BOOTING → BLE_PROVISIONING (no creds) | WIFI_TRYING (creds present)
//   WIFI_TRYING → WS_OPENING → ONLINE
//   ONLINE → RECOVERING (on Wi-Fi/WS loss) → ONLINE
//   Long-press BOOT (≥3 s) → erase NVS → reboot → BLE_PROVISIONING.
//
// BLE policy: NimBLE is started ONLY when it's the sole way back in — no saved creds
// (provisioning) or Wi-Fi won't connect (loop()'s WIFI_FALLBACK_MS backchannel). A
// normally-provisioned boot never inits NimBLE, so it never hits the fragile NimBLE
// deinit or competes with mbedTLS for internal DRAM. The deinit (enterWsOpening) and
// the 30 s re-pair fallback only matter once BLE has actually been brought up.

#include <Arduino.h>
#include <ArduinoJson.h>
#include "log.h"
#include "pins.h"
#include "led_io.h"
#include "ldr.h"
#include "audio_io.h"
#include "camera.h"
#include "nvs_store.h"
#include "state.h"
#include "ble_provisioning.h"
#include "wifi_manager.h"
#include "ws_client.h"
#include "buttons.h"
#include "protocol.h"
#include "agent_tools.h"

static const char* FW_VERSION = "0.1.0";
static String gServerUrl;
static String gAuthToken;
static uint32_t gWsOpeningSince = 0;  // millis() we entered WS_OPENING (re-pair fallback)
static uint32_t gWifiTryingSince = 0; // millis() we entered WIFI_TRYING (BLE fallback)
// If Wi-Fi can't connect within this window, bring BLE up as a backchannel so the
// device stays re-provisionable (Wi-Fi keeps retrying underneath).
static const uint32_t WIFI_FALLBACK_MS = 20000;

// Internal-DRAM watermark. The wss/TLS handshake needs a large *internal* block
// (mbedTLS buffers can't live in PSRAM); this is the number that matters, not
// total free heap. Watch the largestInternalBlock value around the BLE stop.
static void logHeap(const char* tag) {
  LOGI("heap[%s]: free=%u largestInternalBlock=%u psramFree=%u",
       tag, ESP.getFreeHeap(), ESP.getMaxAllocHeap(), ESP.getFreePsram());
}

// ---- Status color helper ----
static void applyStatusColor() {
  switch (state::current()) {
    case state::S::BLE_PROVISIONING: led_io::setStatusColor(  0,  0, 200, true);  break;  // blue
    case state::S::WIFI_TRYING:      led_io::setStatusColor(200,180,  0, true);  break;   // yellow
    case state::S::WS_OPENING:       led_io::setStatusColor(  0,200,200, true);  break;   // cyan
    case state::S::ONLINE:           led_io::setStatusColor(  0,180,  0, false); break;   // green — yields to explicit
    case state::S::RECOVERING:       led_io::setStatusColor(200,  0,  0, true);  break;   // red
    default:                         led_io::setStatusColor( 30, 30, 30, true);  break;
  }
}

// ---- BLE status push helper ----
static void publishBleStatus(const char* err = nullptr) {
  String s = protocol::buildState(
    state::name(state::current()),
    state::currentIp().c_str(),
    state::currentRssi(),
    err ? err : state::currentError());
  ble_provisioning::publishStatus(s.c_str());
}

// ---- WS state push helper ----
static void publishWsState(const char* err = nullptr) {
  if (!ws_client::isConnected()) return;
  String s = protocol::buildState(
    state::name(state::current()),
    state::currentIp().c_str(),
    state::currentRssi(),
    err ? err : state::currentError());
  ws_client::sendText(s);
}

// Pending agent Wi-Fi-scan request: the ref we owe a wifi_scan response to once
// the non-blocking scan finishes (polled in loop()).
static String gWifiScanRef;

// ---- Command dispatch from /ws/device → device ----
static void handleCommand(const String& json) {
  protocol::IncomingCommand cmd;
  if (!protocol::parseCommand(json, &cmd)) {
    LOGW("ws: bad command: %s", json.c_str());
    return;
  }
  bool ok = true;
  const char* err = nullptr;

  if      (cmd.type == "set_blue_led")   led_io::setBlue(cmd.on);
  else if (cmd.type == "set_blue_flash") led_io::setBlueFlash(cmd.on);
  else if (cmd.type == "set_flash_led")  led_io::setFlash(cmd.on);
  else if (cmd.type == "set_rgb")       led_io::setRgb(cmd.r, cmd.g, cmd.b);
  else if (cmd.type == "read_ldr") {
    int v = ldr::readNow();
    ws_client::sendText(protocol::buildLdr(v, millis()));
  }
  else if (cmd.type == "set_ldr_rate") ldr::setPushHz(cmd.hz);
  else if (cmd.type == "start_recording") audio_io::startRecording();
  else if (cmd.type == "stop_recording")  audio_io::stopRecording();
  else if (cmd.type == "play_tone")
    audio_io::playTone(cmd.hz, cmd.durationMs, cmd.amplitude);
  else if (cmd.type == "play_audio_start") audio_io::playPcmStreamStart();
  else if (cmd.type == "play_audio_end")   audio_io::playPcmStreamStop();
  else if (cmd.type == "stop_audio")       audio_io::playPcmStreamFlush();
  else if (cmd.type == "snapshot") {
    // On-demand camera: init → warm-up → capture → deinit. Costs ~0.5–1 s per
    // snapshot (well inside the server's 5 s RPC timeout) but guarantees a
    // LIVE frame — an always-on camera's WHEN_EMPTY queue served frames
    // captured at the time of the PREVIOUS snapshot. Blocks loop() for the
    // duration; if music is playing, the ~448 ms playback ring may underrun
    // briefly (a momentary gap, the stream resumes).
    if (!camera::begin()) { ok = false; err = "camera_init_failed"; }
    else {
      camera::Frame f;
      if (camera::capture(&f)) {
        static uint8_t* tagged = nullptr;
        static size_t   taggedCap = 0;
        if (taggedCap < f.len + 1) {
          free(tagged);
          tagged = (uint8_t*)malloc(f.len + 1);
          taggedCap = tagged ? f.len + 1 : 0;
        }
        if (tagged) {
          tagged[0] = protocol::TAG_JPEG;
          memcpy(tagged + 1, f.buf, f.len);
          ws_client::sendBinary(tagged, f.len + 1);
        } else { ok = false; err = "alloc"; }
        camera::returnFrame(&f);  // must precede end() — end() frees the fb
      } else { ok = false; err = "capture_failed"; }
      camera::end();
    }
  }
  // ---- Sienna agent device-RPC ----
  else if (cmd.type == "scan_wifi") {
    // Non-blocking: result (wifi_scan) is sent from loop() when the scan ends.
    if (!wifi_manager::beginScanAsync()) { ok = false; err = "scan_busy"; }
    else gWifiScanRef = cmd.ref;
  }
  else if (cmd.type == "scan_ble") {
    if (!agent_tools::beginBleScan(cmd.ref)) { ok = false; err = "scan_busy"; }
  }
  else if (cmd.type == "set_timer") {
    uint32_t id = agent_tools::setTimer(cmd.seconds, cmd.label);
    if (id == 0) { ok = false; err = "timer_full"; }
    else ws_client::sendText(protocol::buildTimerSet(cmd.ref.c_str(), id, cmd.seconds, cmd.label.c_str()));
  }
  else if (cmd.type == "cancel_timer") {
    agent_tools::cancelTimer(cmd.id);
  }
  else if (cmd.type == "reboot") {
    ws_client::sendText(protocol::buildAck(cmd.ref.c_str(), true, nullptr));
    delay(100);
    ESP.restart();
  }
  else { ok = false; err = "unknown_type"; }

  ws_client::sendText(protocol::buildAck(cmd.ref.c_str(), ok, err));
}

// ---- Binary frame from server (playback PCM) ----
static void handleBinary(const uint8_t* buf, size_t len) {
  if (len < 1) return;
  uint8_t tag = buf[0];
  if (tag == protocol::TAG_PLAYBACK_PCM) {
    audio_io::playPcmStreamFeed((const int16_t*)(buf + 1), (len - 1) / sizeof(int16_t));
  }
}

// ---- State transition logic ----
static void enterBleProvisioning() {
  state::set(state::S::BLE_PROVISIONING);
  if (!ble_provisioning::running()) ble_provisioning::start();
  applyStatusColor();
  publishBleStatus();
}

static void enterWifiTrying() {
  state::set(state::S::WIFI_TRYING);
  gWifiTryingSince = millis();   // arms the BLE backchannel fallback in loop()
  applyStatusColor();
  if (ble_provisioning::running()) publishBleStatus();
  wifi_manager::connect(nvs_store::load().ssid, nvs_store::load().pass);
}

static void enterWsOpening() {
  state::set(state::S::WS_OPENING);
  gWsOpeningSince = millis();
  applyStatusColor();
  if (ble_provisioning::running()) publishBleStatus();  // last status before going dark

  // The wss/TLS handshake needs a large block of *internal* DRAM (mbedTLS
  // buffers — they can't live in PSRAM). NimBLE holds exactly that kind of RAM,
  // and this build (Wi-Fi + camera + dual-I2S + NimBLE) can't fit both
  // during the handshake: the device completes the TCP connect but never gets to
  // send a TLS ClientHello, so it shows up as last_error="ws_unreachable". Drop
  // BLE here to free the heap; loop()'s re-pair fallback brings it back if the
  // link won't come up, so a misconfigured device stays re-provisionable.
  logHeap("ws_opening: before ble stop");
  if (ble_provisioning::running()) ble_provisioning::stop();
  logHeap("ws_opening: after ble stop");

  ws_client::connect(gServerUrl, gAuthToken, FW_VERSION);
}

static void enterOnline() {
  state::set(state::S::ONLINE);
  applyStatusColor();
  // BLE is intentionally down while online — its internal RAM is needed for the
  // wss/TLS link, and status now flows over the ws connection (publishBleStatus
  // would be a no-op here since NimBLE was deinit'd in enterWsOpening).
  publishWsState();
}

static void enterRecovering(const char* why) {
  state::set(state::S::RECOVERING, why);
  gWsOpeningSince = millis();   // re-pair fallback timer also covers RECOVERING
  applyStatusColor();
  // Don't start BLE here: NimBLE's internal RAM would starve the wss/TLS reconnect
  // (same constraint as enterWsOpening). The ws client auto-retries with full heap,
  // and on Wi-Fi loss the reconnect re-enters enterWsOpening; loop()'s 30 s fallback
  // restores BLE only if the link genuinely won't come back.
  if (ble_provisioning::running()) publishBleStatus();
}

void setup() {
  Serial.begin(115200);
  delay(500);
  LOGI("=== Sienna dashboard boot (fw %s) ===", FW_VERSION);

  // I/O modules
  led_io::begin();
  ldr::begin();
  audio_io::begin();
  // camera: deliberately NOT initialized here — it's brought up on demand per
  // snapshot (see the snapshot handler + camera.cpp; an always-on camera's
  // WHEN_EMPTY frame queue serves stale frames, and the idle driver wastes
  // internal DRAM the wss/TLS handshake needs).
  buttons::begin();
  nvs_store::begin();
  agent_tools::begin();

  // Bridge ldr → ws
  ldr::setPushHz(5.0f);
  ldr::onPush([](int v) {
    if (state::current() == state::S::ONLINE)
      ws_client::sendText(protocol::buildLdr(v, millis()));
  });

  // Bridge audio → ws (RMS at 20 Hz; PCM frames during recording)
  audio_io::onMicMetrics([](const audio_io::MicMetrics& m) {
    static uint32_t last = 0;
    if (millis() - last < 50) return;  // ~20 Hz
    last = millis();
    if (state::current() == state::S::ONLINE)
      ws_client::sendText(protocol::buildMicRms(m.rms, m.peak, millis()));
  });
  audio_io::onPcmFrame([](const int16_t* samples, size_t count) {
    if (state::current() != state::S::ONLINE) return;
    // Half-duplex: don't send mic while the speaker plays — EXCEPT while the PTT
    // button is held. During a hold the server ducks the music to a quiet bed
    // (it keeps streaming, so the speaker stays "active") and the user's speech
    // must reach Scribe over it; the server's own echo gate handles her TTS.
    if (audio_io::isSpeakerActive() && !buttons::pttHeld()) return;
    static uint8_t tagged[1 + audio_io::PCM_FRAME_BYTES];
    tagged[0] = protocol::TAG_RECORDED_PCM;
    size_t bytes = count * sizeof(int16_t);
    if (bytes > audio_io::PCM_FRAME_BYTES) bytes = audio_io::PCM_FRAME_BYTES;
    memcpy(tagged + 1, samples, bytes);
    ws_client::sendBinary(tagged, 1 + bytes);
  });

  // Push-to-talk button (GPIO 45): every debounced edge flashes the blue LED
  // locally (3 Hz while held — "mic is hot") and reports the edge to the server,
  // which owns the mic stream (it sends start/stop_recording back). Offline,
  // the event is simply dropped — the server's disconnect reset plus its
  // max-hold cap cover a release that never arrives.
  // Instant mute: the playback task probes the RAW PTT level before every frame
  // it writes (and the feed path drops incoming frames while down), so the
  // speaker dies within one ~64 ms frame of the physical press — no debounce,
  // no loop() latency, no server round-trip. The debounced edge below still
  // flushes the DMA tail and drives the server protocol.
  audio_io::setMuteProbe([] { return buttons::pttRawDown(); });

  buttons::onPttChange([](bool pressed) {
    led_io::setBlueFlash(pressed);
    // Local playback flush on the press edge — do NOT wait for the server's
    // stop_audio. With music playing, ~0.5-1.5 s of already-sent PCM sits in the
    // WS socket + the playback ring AHEAD of the server's stop_audio /
    // start_recording, and feeding it into the full ring stalls loop() ~realtime
    // per frame — so the mic used to open 1-2 s after the press, swallowing
    // short utterances entirely. Flushing here empties the ring and deactivates
    // playback, so the queued stale frames are dropped instantly (no ring-full
    // waits), the server's commands are processed within ~100 ms, and the music
    // cut is immediate. The server re-arms playback (play_audio_start) for the
    // ducked bed right after its stop_audio — the flush never strands it.
    if (pressed) audio_io::playPcmStreamFlush();
    if (state::current() == state::S::ONLINE)
      ws_client::sendText(protocol::buildButton("ptt", pressed, millis()));
  });

  // Wi-Fi
  wifi_manager::begin();
  wifi_manager::onConnected([] {
    state::setIp(wifi_manager::ip());
    state::setRssi(wifi_manager::rssi());
    enterWsOpening();
  });
  wifi_manager::onDisconnected([](const char* reason) {
    if (state::current() == state::S::ONLINE) enterRecovering(reason);
    else if (state::current() == state::S::WIFI_TRYING) {
      // wifi_manager will retry; stay in WIFI_TRYING but bump error
      state::set(state::S::WIFI_TRYING, reason);
      applyStatusColor();
      if (ble_provisioning::running()) publishBleStatus();
    }
  });

  // WS client
  ws_client::begin();
  ws_client::onConnect([] { enterOnline(); });
  ws_client::onDisconnect([] {
    if (state::current() == state::S::ONLINE) enterRecovering("ws_drop");
    else if (state::current() == state::S::WS_OPENING) {
      // Server bad/unreachable. BLE is down here (dropped in enterWsOpening to free
      // heap for TLS), so this publish is a no-op until loop()'s 30 s fallback
      // restores BLE — at which point the provisioning app sees "ws_unreachable".
      // WebSocketsClient keeps retrying every 2 s in the meantime.
      state::set(state::S::WS_OPENING, "ws_unreachable");
      publishBleStatus();
    }
  });
  ws_client::onText  ([](const String& s)              { handleCommand(s); });
  ws_client::onBinary([](const uint8_t* b, size_t l)   { handleBinary(b, l); });

  // BLE provisioning callback
  ble_provisioning::begin([](const String& ssid, const String& pass,
                             const String& url, const String& token) {
    LOGI("commit received: ssid=%s url=%s", ssid.c_str(), url.c_str());
    nvs_store::save(ssid, pass, url, token);
    gServerUrl = url; gAuthToken = token;
    enterWifiTrying();
  });

  // BOOT button long-press → factory reset
  buttons::onBootLongPress([] {
    LOGW("factory reset!");
    nvs_store::erase();
    delay(200);
    ESP.restart();
  });

  // Boot decision. BLE is NOT started here — only when we actually need it. A
  // provisioned device goes straight to Wi-Fi and never inits NimBLE, so the fragile
  // NimBLE deinit (and its TLS-RAM contention) is skipped entirely on the normal
  // path. BLE comes up only when there are no creds (provisioning) or when Wi-Fi
  // can't connect (the loop() Wi-Fi fallback) — i.e. the only times it's the sole
  // way back in.
  auto creds = nvs_store::load();
  if (creds.valid) {
    gServerUrl = creds.serverUrl;
    gAuthToken = creds.authToken;
    enterWifiTrying();
  } else {
    enterBleProvisioning();
  }
}

void loop() {
  led_io::tick();
  ldr::tick();
  audio_io::tick();
  buttons::tick();
  wifi_manager::tick();
  ws_client::tick();
  agent_tools::tick();   // agent timers + non-blocking BLE scan completion

  // Link-health telemetry every 5 s: RSSI + heap + last Wi-Fi disconnect
  // reason, to serial always (visible when tethered even while the WS is down)
  // and to the server while ONLINE (shows up in the compose logs next to the
  // audio stats — the point is correlating 1006 drops with signal/heap dips).
  {
    static uint32_t lastNetStatsMs = 0;
    if ((uint32_t)(millis() - lastNetStatsMs) >= 5000) {
      lastNetStatsMs = millis();
      if (wifi_manager::isConnected()) {
        int r = wifi_manager::rssi();
        int reason = wifi_manager::lastDisconnectReason();
        LOGI("net: rssi=%d dBm heap=%u minHeap=%u wifiDrops=%u lastReason=%d(%s)",
             r, ESP.getFreeHeap(), ESP.getMinFreeHeap(),
             (unsigned)wifi_manager::disconnectCount(), reason,
             wifi_manager::disconnectReasonName(reason));
        if (state::current() == state::S::ONLINE)
          ws_client::sendText(protocol::buildNetStats(
              r, ESP.getFreeHeap(), ESP.getMinFreeHeap(),
              reason, wifi_manager::disconnectCount(), millis()));
      }
    }
  }

  // Agent Wi-Fi scan (non-blocking): emit wifi_scan once results are ready.
  if (gWifiScanRef.length()) {
    String json;
    if (wifi_manager::pollScanAsync(json)) {
      ws_client::sendText(protocol::buildWifiScan(gWifiScanRef.c_str(), json));
      gWifiScanRef = "";
    }
  }

  // BLE "scan" request → blocking Wi-Fi scan → push results back over BLE.
  // Run here (main task), not in the BLE write callback: WiFi.scanNetworks()
  // blocks ~2-4 s and would stall the NimBLE host task and drop the link.
  if (ble_provisioning::running() && ble_provisioning::takeScanRequest()) {
    wifi_manager::scan([](const String& json) {
      ble_provisioning::publishScanResult(json.c_str());
    });
  }

  // Wi-Fi fallback: a provisioned device boots straight to Wi-Fi with BLE off. If it
  // can't connect within WIFI_FALLBACK_MS (wrong password, AP gone, out of range),
  // bring BLE up so it can be re-provisioned — BLE is the only way back in when Wi-Fi
  // is down. Wi-Fi keeps retrying underneath; if it succeeds, enterWsOpening() stops
  // BLE again before the TLS handshake.
  if (state::current() == state::S::WIFI_TRYING &&
      !ble_provisioning::running() &&
      (uint32_t)(millis() - gWifiTryingSince) > WIFI_FALLBACK_MS) {
    LOGW("wifi not up after %us — starting BLE backchannel for re-provisioning",
         (unsigned)(WIFI_FALLBACK_MS / 1000));
    ble_provisioning::start();
    publishBleStatus();
  }

  // Re-pair safety: BLE is dropped while we bring up a wss/TLS link (enterWsOpening
  // and enterRecovering) to free the internal DRAM mbedTLS needs. If the link still
  // hasn't come up after 30 s the server is unreachable/misconfigured (a reachable
  // server connects within a couple of 2 s retries), so restore the BLE backchannel
  // to keep the device re-provisionable. WebSocketsClient keeps retrying in the
  // background; a reboot or a fresh provision re-enters enterWsOpening() with full heap.
  {
    state::S s = state::current();
    if ((s == state::S::WS_OPENING || s == state::S::RECOVERING) &&
        !ble_provisioning::running() &&
        (uint32_t)(millis() - gWsOpeningSince) > 30000) {
      LOGW("wss not up after 30s — restoring BLE backchannel for re-provisioning");
      ble_provisioning::start();
      publishBleStatus();
    }
  }

  delay(1);
}
