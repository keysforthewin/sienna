#include "ws_client.h"
#include <WebSocketsClient.h>
#include "log.h"
#include "protocol.h"

namespace ws_client {

static WebSocketsClient gWs;
static String gToken;
static String gFwVersion;
static bool gConnected = false;

static std::function<void()>                       gOnConn;
static std::function<void()>                       gOnDisc;
static std::function<void(const String&)>          gOnText;
static std::function<void(const uint8_t*, size_t)> gOnBin;

static void onEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED: {
      LOGI("ws: connected");
      String hello = protocol::buildHello(gToken.c_str(), gFwVersion.c_str());
      gWs.sendTXT(hello.c_str(), hello.length());
      gConnected = true;
      if (gOnConn) gOnConn();
      break;
    }
    case WStype_DISCONNECTED:
      if (gConnected) LOGI("ws: disconnected");
      gConnected = false;
      if (gOnDisc) gOnDisc();
      break;
    case WStype_TEXT:
      if (gOnText) {
        String s; s.reserve(length); for (size_t i = 0; i < length; i++) s += (char)payload[i];
        gOnText(s);
      }
      break;
    case WStype_BIN:
      if (gOnBin) gOnBin(payload, length);
      break;
    default: break;
  }
}

void begin() {
  gWs.setReconnectInterval(2000);
  gWs.enableHeartbeat(15000, 3000, 2);
}

void connect(const String& url, const String& token, const char* fwVersion) {
  gToken = token;
  gFwVersion = fwVersion ? fwVersion : "0.1.0";
  // Parse url: ws://host:port/path  or  wss://host:port/path
  String u = url;
  String scheme = "ws", host; int port = 80; String path = "/";
  int schemeEnd = u.indexOf("://");
  if (schemeEnd > 0) { scheme = u.substring(0, schemeEnd); u = u.substring(schemeEnd + 3); }
  bool secure = (scheme == "wss" || scheme == "https");
  int slash = u.indexOf('/');
  String hostPort = slash >= 0 ? u.substring(0, slash) : u;
  if (slash >= 0) path = u.substring(slash);
  int colon = hostPort.indexOf(':');
  if (colon > 0) { host = hostPort.substring(0, colon); port = hostPort.substring(colon + 1).toInt(); }
  else           { host = hostPort; port = secure ? 443 : 80; }
  LOGI("ws: connecting %s://%s:%d%s", secure ? "wss" : "ws", host.c_str(), port, path.c_str());
  gWs.onEvent(onEvent);
  // beginSSL() with no CA cert / empty fingerprint calls setInsecure() on
  // ESP32, so the dashboard's self-signed cert is accepted without validation.
  if (secure) gWs.beginSSL(host.c_str(), port, path.c_str());
  else        gWs.begin(host.c_str(), port, path.c_str());
}

void disconnect()        { gWs.disconnect(); gConnected = false; }
bool isConnected()       { return gConnected; }
void sendText(const String& s) { gWs.sendTXT(s.c_str(), s.length()); }
void sendBinary(const uint8_t* buf, size_t len) { gWs.sendBIN(buf, len); }

void onConnect    (std::function<void()> cb)                       { gOnConn  = std::move(cb); }
void onDisconnect (std::function<void()> cb)                       { gOnDisc  = std::move(cb); }
void onText       (std::function<void(const String&)> cb)          { gOnText  = std::move(cb); }
void onBinary     (std::function<void(const uint8_t*, size_t)> cb) { gOnBin   = std::move(cb); }

void tick() {
  // Drain several WS reads per loop() pass. The cooperative loop runs only ~15x/s
  // (the 64 ms mic read dominates the period) and each gWs.loop() consumes roughly
  // one TCP segment (~2 KB), so a single call per pass capped WS receive at ~30 KB/s
  // — right at the 32 KB/s audio playback rate, which starved the playback ring and
  // produced constant underrun clicks. Pulling multiple segments per pass lifts the
  // receive ceiling well above realtime so the ring fills and audio stays smooth.
  // Idle calls are cheap (client.available()==0 returns immediately).
  for (int i = 0; i < 8; i++) gWs.loop();
}

}  // namespace ws_client
