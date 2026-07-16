// WAN health probe — is the internet connection itself any good?
//
// The device↔server WebSocket rides the LAN; the WAN only carries the server's
// own upstream traffic (yt-dlp audio, ElevenLabs, Anthropic). This module
// measures that WAN leg from the server host so its lines can be correlated
// against the [device-ws] net lines: WAN bad + device link clean → ISP;
// device link bad + WAN clean → Wi-Fi/LAN.
//
// Two measurements, both logged to the console the compose output shows:
//  - RTT + loss: every intervalMs, a burst of TCP connects to each anchor
//    (default Cloudflare 1.1.1.1:443 and Google DNS 8.8.8.8:53). A connect
//    that errors or exceeds probeTimeoutMs counts as lost. TCP connect time
//    ≈ one round trip, and needs no ICMP privileges (works in Docker).
//  - Bandwidth: every bandwidthIntervalMs, download a small blob (default
//    2 MB from Cloudflare's speed endpoint) and log the achieved Mbps.
import net from "node:net";

export function tcpConnectRtt(host, port, timeoutMs, now = Date.now) {
  return new Promise((resolve) => {
    const t0 = now();
    const sock = net.connect({ host, port });
    let done = false;
    const finish = (rtt) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(rtt);
    };
    sock.setTimeout(timeoutMs, () => finish(null));
    sock.once("connect", () => finish(now() - t0));
    sock.once("error", () => finish(null));
  });
}

export function createNetProbe({
  intervalMs = 30000,
  targets = [
    { host: "1.1.1.1", port: 443 },
    { host: "8.8.8.8", port: 53 },
  ],
  probesPerTarget = 5,
  probeTimeoutMs = 2000,
  bandwidthIntervalMs = 300000,
  bandwidthUrl = "https://speed.cloudflare.com/__down?bytes=2000000",
  bandwidthTimeoutMs = 30000,
  log = (line) => console.log(line),
  connectFn = tcpConnectRtt,
  fetchFn = (...a) => globalThis.fetch(...a),
  now = Date.now,
} = {}) {
  let rttTimer = null;
  let bwTimer = null;
  let stopped = false;

  async function probeOnce() {
    const parts = [];
    for (const t of targets) {
      const rtts = [];
      let lost = 0;
      for (let i = 0; i < probesPerTarget; i++) {
        const rtt = await connectFn(t.host, t.port, probeTimeoutMs, now);
        if (rtt == null) lost++;
        else rtts.push(rtt);
      }
      if (rtts.length === 0) {
        parts.push(`${t.host}:${t.port} UNREACHABLE loss=${lost}/${probesPerTarget}`);
      } else {
        const avg = Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length);
        const min = Math.min(...rtts);
        const max = Math.max(...rtts);
        parts.push(`${t.host}:${t.port} rtt=${avg}ms (${min}-${max}) loss=${lost}/${probesPerTarget}`);
      }
    }
    if (!stopped) log(`[net-probe] wan ${parts.join(" | ")}`);
    return parts;
  }

  async function bandwidthOnce() {
    const ac = new AbortController();
    const kill = setTimeout(() => ac.abort(), bandwidthTimeoutMs);
    try {
      const t0 = now();
      const res = await fetchFn(bandwidthUrl, { signal: ac.signal });
      const body = await res.arrayBuffer();
      const ms = Math.max(1, now() - t0);
      const bytes = body.byteLength;
      const mbps = (bytes * 8) / 1000 / ms; // bits / ms → Mbit/s
      if (!stopped)
        log(`[net-probe] wan bandwidth ${mbps.toFixed(1)} Mbps (${(bytes / 1e6).toFixed(1)} MB in ${ms} ms)`);
      return mbps;
    } catch (e) {
      // A failed download IS the signal a flaky ISP produces — log it.
      if (!stopped) log(`[net-probe] wan bandwidth FAILED: ${e?.message || e}`);
      return null;
    } finally {
      clearTimeout(kill);
    }
  }

  return {
    start() {
      stopped = false;
      if (intervalMs > 0 && !rttTimer) {
        probeOnce();
        rttTimer = setInterval(probeOnce, intervalMs);
        rttTimer.unref?.();
      }
      if (bandwidthIntervalMs > 0 && !bwTimer) {
        bandwidthOnce();
        bwTimer = setInterval(bandwidthOnce, bandwidthIntervalMs);
        bwTimer.unref?.();
      }
    },
    stop() {
      stopped = true;
      if (rttTimer) { clearInterval(rttTimer); rttTimer = null; }
      if (bwTimer) { clearInterval(bwTimer); bwTimer = null; }
    },
    // Exposed for tests / one-off checks.
    probeOnce,
    bandwidthOnce,
  };
}
