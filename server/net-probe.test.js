import { test } from "node:test";
import assert from "node:assert/strict";
import { createNetProbe } from "./net-probe.js";

function makeProbe(overrides = {}) {
  const logs = [];
  const probe = createNetProbe({
    intervalMs: 0,            // no timers in tests — call probeOnce()/bandwidthOnce() directly
    bandwidthIntervalMs: 0,
    targets: [{ host: "1.1.1.1", port: 443 }],
    probesPerTarget: 4,
    probeTimeoutMs: 100,
    log: (line) => logs.push(line),
    ...overrides,
  });
  return { probe, logs };
}

test("probeOnce logs avg/min-max RTT and zero loss when all probes connect", async () => {
  let calls = 0;
  const rtts = [10, 20, 30, 40];
  const { probe, logs } = makeProbe({
    connectFn: async () => rtts[calls++],
  });
  await probe.probeOnce();
  assert.equal(calls, 4);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^\[net-probe\] wan 1\.1\.1\.1:443 rtt=25ms \(10-40\) loss=0\/4$/);
});

test("probeOnce counts null RTTs (timeout/error) as loss", async () => {
  const results = [15, null, 25, null];
  let i = 0;
  const { probe, logs } = makeProbe({
    connectFn: async () => results[i++],
  });
  await probe.probeOnce();
  assert.match(logs[0], /rtt=20ms \(15-25\) loss=2\/4/);
});

test("probeOnce reports UNREACHABLE when every probe fails", async () => {
  const { probe, logs } = makeProbe({ connectFn: async () => null });
  await probe.probeOnce();
  assert.match(logs[0], /1\.1\.1\.1:443 UNREACHABLE loss=4\/4/);
});

test("probeOnce joins multiple targets on one line", async () => {
  const { probe, logs } = makeProbe({
    targets: [
      { host: "1.1.1.1", port: 443 },
      { host: "8.8.8.8", port: 53 },
    ],
    connectFn: async () => 12,
  });
  await probe.probeOnce();
  assert.equal(logs.length, 1);
  assert.match(logs[0], /1\.1\.1\.1:443 .* \| 8\.8\.8\.8:53 /);
});

test("bandwidthOnce logs Mbps from the downloaded byte count and elapsed time", async () => {
  let t = 1000;
  const { probe, logs } = makeProbe({
    now: () => t,
    fetchFn: async () => {
      t += 500; // 2,000,000 bytes in 500 ms → 32 Mbps
      return { arrayBuffer: async () => new ArrayBuffer(2_000_000) };
    },
  });
  const mbps = await probe.bandwidthOnce();
  assert.equal(mbps, 32);
  assert.match(logs[0], /^\[net-probe\] wan bandwidth 32\.0 Mbps \(2\.0 MB in 500 ms\)$/);
});

test("bandwidthOnce logs a failure instead of throwing", async () => {
  const { probe, logs } = makeProbe({
    fetchFn: async () => { throw new Error("ETIMEDOUT"); },
  });
  const mbps = await probe.bandwidthOnce();
  assert.equal(mbps, null);
  assert.match(logs[0], /bandwidth FAILED: ETIMEDOUT/);
});

test("start() fires immediately and on the interval; stop() halts logging", async () => {
  const logs = [];
  const probe = createNetProbe({
    intervalMs: 20,
    bandwidthIntervalMs: 0,
    targets: [{ host: "1.1.1.1", port: 443 }],
    probesPerTarget: 1,
    connectFn: async () => 5,
    log: (line) => logs.push(line),
  });
  probe.start();
  await new Promise((r) => setTimeout(r, 55));
  probe.stop();
  const count = logs.length;
  assert.ok(count >= 2, `expected >=2 probe lines, got ${count}`);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(logs.length, count, "no lines after stop()");
});
