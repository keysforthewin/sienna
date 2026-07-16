#pragma once
#include <Arduino.h>
#include <stdint.h>

namespace protocol {

// Binary frame tags (must match server/protocol.js BinTag)
constexpr uint8_t TAG_RECORDED_PCM = 0x01;
constexpr uint8_t TAG_JPEG         = 0x02;
constexpr uint8_t TAG_PLAYBACK_PCM = 0x03;

// Builders (return JSON strings ready to send over WS)
String buildHello(const char* token, const char* fwVersion);
String buildState(const char* state, const char* ip, int rssi, const char* lastError);
String buildMicRms(float rms, int16_t peak, uint32_t tsMs);
String buildLdr(int value, uint32_t tsMs);
String buildAck(const char* ref, bool ok, const char* error);
String buildEvent(const char* name);
// Debounced physical-button edge (id "ptt" = the GPIO 45 push-to-talk button).
String buildButton(const char* id, bool pressed, uint32_t tsMs);
// Periodic link-health telemetry (disconnect diagnostics): Wi-Fi RSSI, free /
// min-ever free heap, last Wi-Fi disconnect reason code + drop count since boot.
String buildNetStats(int rssi, uint32_t freeHeap, uint32_t minFreeHeap,
                     int discReason, uint32_t discCount, uint32_t tsMs);
// Sienna agent device-RPC responses. networksJson / devicesJson are pre-built
// JSON array strings, embedded verbatim into the message.
String buildWifiScan(const char* ref, const String& networksJson);
String buildBleScan(const char* ref, const String& devicesJson);
String buildTimerSet(const char* ref, uint32_t id, uint32_t seconds, const char* label);
String buildTimerFired(uint32_t id, const char* label);

// Parsing dispatch
struct IncomingCommand {
  String type;
  String ref;
  // Payload fields (only those relevant to type are populated)
  bool   on;
  uint8_t r, g, b;
  float   hz;
  uint32_t durationMs;
  float   amplitude;
  uint32_t sampleRate;
  uint8_t  bits;
  uint8_t  channels;
  uint32_t seconds;     // set_timer
  uint32_t id;          // cancel_timer
  String   label;       // set_timer
};

// Returns true on a successfully parsed known command; populates `out`.
bool parseCommand(const String& json, IncomingCommand* out);

}  // namespace protocol
