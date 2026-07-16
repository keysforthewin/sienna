#include "protocol.h"
#include <ArduinoJson.h>

namespace protocol {

String buildHello(const char* token, const char* fwVersion) {
  JsonDocument doc;
  doc["type"] = "hello";
  doc["token"] = token;
  doc["fw_version"] = fwVersion;
  String s; serializeJson(doc, s); return s;
}

String buildState(const char* state, const char* ip, int rssi, const char* lastError) {
  JsonDocument doc;
  doc["type"] = "state";
  doc["state"] = state;
  if (ip && ip[0]) doc["ip"] = ip; else doc["ip"] = nullptr;
  if (rssi != INT_MIN) doc["wifi_rssi"] = rssi; else doc["wifi_rssi"] = nullptr;
  if (lastError && lastError[0]) doc["last_error"] = lastError; else doc["last_error"] = nullptr;
  String s; serializeJson(doc, s); return s;
}

String buildMicRms(float rms, int16_t peak, uint32_t tsMs) {
  JsonDocument doc;
  doc["type"] = "mic_rms";
  doc["rms"] = rms;
  doc["peak"] = peak;
  doc["ts_ms"] = tsMs;
  String s; serializeJson(doc, s); return s;
}

String buildLdr(int value, uint32_t tsMs) {
  JsonDocument doc;
  doc["type"] = "ldr";
  doc["value"] = value;
  doc["ts_ms"] = tsMs;
  String s; serializeJson(doc, s); return s;
}

String buildAck(const char* ref, bool ok, const char* error) {
  JsonDocument doc;
  doc["type"] = "ack";
  doc["ref"] = ref;
  doc["ok"] = ok;
  if (error) doc["error"] = error;
  String s; serializeJson(doc, s); return s;
}

String buildEvent(const char* name) {
  JsonDocument doc;
  doc["type"] = "event";
  doc["name"] = name;
  String s; serializeJson(doc, s); return s;
}

String buildButton(const char* id, bool pressed, uint32_t tsMs) {
  JsonDocument doc;
  doc["type"] = "button";
  doc["id"] = id;
  doc["pressed"] = pressed;
  doc["ts_ms"] = tsMs;
  String s; serializeJson(doc, s); return s;
}

String buildNetStats(int rssi, uint32_t freeHeap, uint32_t minFreeHeap,
                     int discReason, uint32_t discCount, uint32_t tsMs) {
  JsonDocument doc;
  doc["type"] = "net_stats";
  doc["rssi"] = rssi;
  doc["heap"] = freeHeap;
  doc["min_heap"] = minFreeHeap;
  doc["disc_reason"] = discReason;
  doc["disc_count"] = discCount;
  doc["ts_ms"] = tsMs;
  String s; serializeJson(doc, s); return s;
}

// networksJson/devicesJson are already-serialized JSON arrays; embed verbatim.
String buildWifiScan(const char* ref, const String& networksJson) {
  String s = "{\"type\":\"wifi_scan\",\"ref\":\"";
  s += ref; s += "\",\"networks\":"; s += networksJson; s += "}";
  return s;
}

String buildBleScan(const char* ref, const String& devicesJson) {
  String s = "{\"type\":\"ble_scan\",\"ref\":\"";
  s += ref; s += "\",\"devices\":"; s += devicesJson; s += "}";
  return s;
}

String buildTimerSet(const char* ref, uint32_t id, uint32_t seconds, const char* label) {
  JsonDocument doc;
  doc["type"] = "timer_set";
  doc["ref"] = ref;
  doc["id"] = id;
  doc["seconds"] = seconds;
  if (label && label[0]) doc["label"] = label;
  String s; serializeJson(doc, s); return s;
}

String buildTimerFired(uint32_t id, const char* label) {
  JsonDocument doc;
  doc["type"] = "timer_fired";
  doc["id"] = id;
  if (label && label[0]) doc["label"] = label;
  String s; serializeJson(doc, s); return s;
}

bool parseCommand(const String& json, IncomingCommand* out) {
  JsonDocument doc;
  if (deserializeJson(doc, json) != DeserializationError::Ok) return false;
  const char* type = doc["type"] | "";
  const char* ref  = doc["ref"]  | "";
  if (!type[0] || !ref[0]) return false;
  out->type = type;
  out->ref  = ref;
  out->on = doc["on"] | false;
  out->r  = doc["r"]  | 0;
  out->g  = doc["g"]  | 0;
  out->b  = doc["b"]  | 0;
  out->hz = doc["hz"] | 0.0f;
  out->durationMs = doc["duration_ms"] | 0u;
  out->amplitude  = doc["amplitude"]   | 0.0f;
  out->sampleRate = doc["sample_rate"] | 16000u;
  out->bits       = doc["bits"]        | 16;
  out->channels   = doc["channels"]    | 1;
  out->seconds    = doc["seconds"]      | 0u;
  out->id         = doc["id"]           | 0u;
  out->label      = doc["label"]        | "";
  return true;
}

}  // namespace protocol
