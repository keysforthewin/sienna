#pragma once
#include <Arduino.h>
#include <stdint.h>
#include <stddef.h>
#include <functional>

namespace ws_client {

void begin();

// url e.g. "ws://192.168.1.5:3387/ws/device" or "wss://..." (TLS; self-signed OK)
void connect(const String& url, const String& token, const char* fwVersion);
void disconnect();
bool isConnected();

void sendText(const String& s);
void sendBinary(const uint8_t* buf, size_t len);

void onConnect(std::function<void()> cb);
void onDisconnect(std::function<void()> cb);
void onText(std::function<void(const String&)> cb);
void onBinary(std::function<void(const uint8_t*, size_t)> cb);

void tick();

}  // namespace ws_client
