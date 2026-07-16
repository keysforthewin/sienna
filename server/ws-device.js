import { parseDeviceMessage } from "./protocol.js";
import { BinTag } from "./protocol.js";

const HELLO_TIMEOUT_MS = 2000;

export function attachDeviceWs(wss, bridge, recorder, transcriber, token, debug = false, heartbeatMs = 10000, micListener = { feedPcm() {} }) {
  wss.on("connection", (ws, req) => {
    const ip = req?.socket?.remoteAddress || "?";
    console.log(`[device-ws] connection from ${ip} — awaiting hello`);

    let helloTimer = setTimeout(() => {
      console.warn(`[device-ws] ✗ ${ip} sent no hello within ${HELLO_TIMEOUT_MS}ms — closing`);
      try { ws.close(4001, "no_hello"); } catch {}
    }, HELLO_TIMEOUT_MS);

    let attached = false;

    // ---- Liveness heartbeat ----
    // An abrupt device disconnect (power loss, Wi-Fi drop — the usual way the
    // ESP32 "goes away") sends no WS close frame, so `ws` won't fire 'close'
    // until the OS TCP keepalive expires (~2 h). Until then the bridge believes
    // the device is online and the dashboard stays green. So we actively probe:
    // ping on an interval, count any inbound frame/ping/pong as proof of life,
    // and terminate a socket that misses a whole interval. terminate() fires
    // 'close', which makes the bridge broadcast device_disconnected — so the
    // dashboard flips to offline within ~1–2 intervals. (heartbeatMs 0 disables.)
    let heartbeat = null;
    let alive = true;
    // Server→device→server round-trip, measured on our own heartbeat pings.
    // This is the "ping to the Sienna server" over the actual WS/TCP path —
    // logged with each net_stats line so latency spikes line up with RSSI dips.
    let pingSentAt = 0;
    let lastRttMs = null;
    let lastNet = null;  // most recent net_stats — stamped onto the disconnect log
    // Loss proxy: heartbeat pings whose pong never came back before the next
    // interval. The WS rides TCP (real packet loss is invisible up here), but
    // a lost/very-late pong is exactly what loss on the device link produces.
    let pongsMissed = 0;
    // Throughput over the device socket, sampled between net_stats lines.
    // req.socket is the underlying net.Socket post-upgrade; its byte counters
    // give actual achieved tx/rx rates, and ws.bufferedAmount is backpressure
    // (bytes accepted by send() but not yet on the wire — a rising value means
    // the link can't sustain the offered rate, e.g. music at ~34 KB/s).
    const sock = req?.socket;
    let lastBytes = null;
    const markAlive = () => { alive = true; };
    ws.on("pong", () => {
      markAlive();
      if (pingSentAt) {
        lastRttMs = Date.now() - pingSentAt;
        pingSentAt = 0;
      }
    });
    ws.on("ping", markAlive);   // the device's own heartbeat ping (fw pings ~every 15 s)
    function startHeartbeat() {
      if (!heartbeatMs || heartbeat) return;
      heartbeat = setInterval(() => {
        if (!alive) {
          // Self-clear: a socket replaced via bridge.attachDevice() has its
          // 'close' listener stripped, so the handler below may never run for it
          // — clearing here keeps a replaced socket's timer from leaking.
          clearInterval(heartbeat);
          heartbeat = null;
          console.warn(`[device-ws] ✗ ${ip} missed heartbeat — terminating`);
          try { ws.terminate(); } catch {}
          return;
        }
        alive = false;
        if (pingSentAt) pongsMissed++;  // previous ping never got its pong
        try { ws.ping(); pingSentAt = Date.now(); }
        catch { clearInterval(heartbeat); heartbeat = null; }
      }, heartbeatMs);
    }

    // Per-connection traffic logger (verbose, throttled). High-frequency
    // streams (mic_rms ~20 Hz, ldr ~5 Hz, recorded PCM) are rate-limited so
    // the console stays readable; everything else logs as it arrives.
    const lastLog = new Map();
    const THROTTLE_MS = { mic_rms: 1000, ldr: 1000, recorded_pcm: 1000 };
    const logRx = (key, line) => {
      if (!debug) return;
      const gap = THROTTLE_MS[key] || 0;
      if (gap) {
        const now = Date.now();
        if (now - (lastLog.get(key) || 0) < gap) return;
        lastLog.set(key, now);
      }
      console.log(`[device-ws] rx ${line}`);
    };

    ws.on("message", (data, isBinary) => {
      markAlive();  // any inbound frame proves the device is still there
      if (!attached) {
        // Expect a hello frame first
        if (isBinary) {
          ws.close(4001, "binary_before_hello");
          return;
        }
        let msg;
        try {
          msg = parseDeviceMessage(data.toString("utf8"));
        } catch {
          console.warn(`[device-ws] ✗ ${ip} bad hello JSON — closing`);
          ws.close(4001, "bad_hello");
          return;
        }
        if (msg.type !== "hello") {
          console.warn(`[device-ws] ✗ ${ip} first frame was '${msg.type}', not hello — closing`);
          ws.close(4001, "missing_hello");
          return;
        }
        if (msg.token !== token) {
          console.warn(`[device-ws] ✗ ${ip} bad token — closing`);
          ws.close(4001, "bad_token");
          return;
        }
        clearTimeout(helloTimer);
        attached = true;
        bridge.attachDevice(ws);
        startHeartbeat();
        console.log(`[device-ws] ✓ Sienna attached — fw ${msg.fw_version ?? "?"} (${ip})`);
        return;
      }

      if (isBinary) {
        const buf = Buffer.from(data);
        if (buf.length < 1) return;
        const tag = buf[0];
        const payload = buf.subarray(1);
        if (tag === BinTag.RECORDED_PCM) {
          logRx("recorded_pcm", `binary recorded_pcm ${payload.length} B`);
          recorder.appendPcm(payload);
          transcriber.feedPcm(payload);   // no-op unless transcription is active
          micListener.feedPcm(payload);   // no-op unless a listen() is in flight
          // Also forward to browsers (so they can render live waveform during recording)
          bridge.broadcastBinaryToBrowsers(buf);
        } else if (tag === BinTag.JPEG) {
          logRx("jpeg", `binary jpeg ${payload.length} B`);
          bridge.emitDeviceBinary(tag, payload, buf);  // tap for device-rpc (snapshot)
          bridge.broadcastBinaryToBrowsers(buf);
        } else {
          logRx("bin", `binary tag=0x${tag.toString(16)} ${payload.length} B`);
        }
        return;
      }

      // Text after hello: device event/ack/state — forward to browsers.
      // A repeated hello is a protocol error; close it rather than leaking the
      // token through to browsers.
      let msg;
      try { msg = parseDeviceMessage(data.toString("utf8")); }
      catch { return; }
      if (msg.type === "hello") {
        console.warn(`[device-ws] ✗ ${ip} sent hello again after attach — closing`);
        ws.close(4001, "hello_after_attach");
        return;
      }
      if (msg.type === "net_stats") {
        // Always logged (not debug-gated): this is the disconnect-diagnosis
        // trail — Wi-Fi RSSI + heap from the device, WS ping RTT from our
        // heartbeat. One line per ~5 s, next to the audio-stats lines.
        const heapK = msg.heap != null ? `${Math.round(msg.heap / 1024)}K` : "?";
        const minHeapK = msg.min_heap != null ? `${Math.round(msg.min_heap / 1024)}K` : "?";
        const drops = msg.disc_count ?? 0;
        const reason = msg.disc_reason ? ` lastReason=${msg.disc_reason}` : "";
        // Throughput since the previous net_stats line (device sends every ~5 s).
        let rate = "";
        if (sock) {
          const nowMs = Date.now();
          if (lastBytes) {
            const dt = (nowMs - lastBytes.at) / 1000;
            if (dt > 0) {
              const tx = (sock.bytesWritten - lastBytes.w) / 1024 / dt;
              const rx = (sock.bytesRead - lastBytes.r) / 1024 / dt;
              rate = ` tx=${tx.toFixed(1)}KB/s rx=${rx.toFixed(1)}KB/s buf=${Math.round(ws.bufferedAmount / 1024)}K`;
            }
          }
          lastBytes = { r: sock.bytesRead, w: sock.bytesWritten, at: nowMs };
        }
        console.log(`[device-ws] net rssi=${msg.rssi}dBm rtt=${lastRttMs != null ? lastRttMs + "ms" : "?"}${rate} missedPongs=${pongsMissed} heap=${heapK} minHeap=${minHeapK} wifiDrops=${drops}${reason}`);
        lastNet = { rssi: msg.rssi, rtt: lastRttMs, buf: ws.bufferedAmount, missedPongs: pongsMissed, at: Date.now() };
      }
      else if (msg.type === "mic_rms") logRx("mic_rms", `mic_rms rms=${msg.rms} peak=${msg.peak}`);
      else if (msg.type === "ldr") logRx("ldr", `ldr value=${msg.value}`);
      else                         logRx(msg.type, `${msg.type} ${JSON.stringify(msg)}`);
      bridge.emitDeviceMessage(msg);  // tap for device-rpc (acks, reads, scans, timers)
      bridge.broadcastToBrowsers(msg);
    });

    ws.on("close", (code, reason) => {
      clearTimeout(helloTimer);
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
      if (attached) {
        const r = reason && reason.length ? ` ${reason.toString()}` : "";
        const net = lastNet
          ? ` | lastNet ${Math.round((Date.now() - lastNet.at) / 1000)}s ago: rssi=${lastNet.rssi}dBm rtt=${lastNet.rtt != null ? lastNet.rtt + "ms" : "?"} buf=${Math.round((lastNet.buf ?? 0) / 1024)}K missedPongs=${lastNet.missedPongs ?? 0}`
          : "";
        console.log(`[device-ws] Sienna disconnected (code=${code}${r}) (${ip})${net}`);
      }
    });
    ws.on("error", (err) => {
      clearTimeout(helloTimer);
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
      console.warn(`[device-ws] socket error (${ip}): ${err.message}`);
    });
  });
}
