import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Bridge } from "./bridge.js";
import { Recorder } from "./recordings.js";
import { attachDeviceWs } from "./ws-device.js";

const TOKEN = "tok-12345678";

function makeTranscriberSpy() {
  return {
    fed: [],
    feedPcm(buf) { this.fed.push(Buffer.from(buf)); },
    start() {}, stop() {}, handleDeviceDisconnect() {}, isActive: () => false,
  };
}

function makeMicListenerSpy() {
  return {
    fed: [],
    feedPcm(buf) { this.fed.push(Buffer.from(buf)); },
    isActive: () => false, handleDeviceDisconnect() {},
  };
}

async function withServer(fn, { heartbeatMs } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sh-"));
  const bridge = new Bridge();
  const recorder = new Recorder({ dir, keep: 5 });
  const transcriber = makeTranscriberSpy();
  const micListener = makeMicListenerSpy();
  const server = http.createServer();
  const wss = new WebSocketServer({ server, path: "/ws/device" });
  attachDeviceWs(wss, bridge, recorder, transcriber, TOKEN, false, heartbeatMs, micListener);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  try {
    await fn({ port, bridge, recorder, transcriber, micListener });
  } finally {
    wss.close();
    // Force-close lingering sockets so a test that asserts before ws.close()
    // fails cleanly instead of hanging server.close().
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function connect(port) {
  return new WebSocket(`ws://127.0.0.1:${port}/ws/device`);
}

function waitOpen(ws) {
  return new Promise((res, rej) => {
    ws.once("open", res);
    ws.once("error", rej);
  });
}

function waitClose(ws) {
  return new Promise((res) => ws.once("close", (code, reason) => res({ code, reason: reason.toString() })));
}

test("device connects, hello with right token attaches", async () => {
  await withServer(async ({ port, bridge }) => {
    const ws = connect(port);
    await waitOpen(ws);
    ws.send(JSON.stringify({ type: "hello", token: TOKEN, fw_version: "0.1.0" }));
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(bridge.device);
    ws.close();
  });
});

test("device hello with wrong token closes 4001", async () => {
  await withServer(async ({ port }) => {
    const ws = connect(port);
    await waitOpen(ws);
    ws.send(JSON.stringify({ type: "hello", token: "wrong" }));
    const { code } = await waitClose(ws);
    assert.equal(code, 4001);
  });
});

test("device that never sends hello times out 4001", async () => {
  await withServer(async ({ port }) => {
    const ws = connect(port);
    await waitOpen(ws);
    const { code } = await waitClose(ws);
    assert.equal(code, 4001);
  });
}, { timeout: 4000 });

test("device state message is broadcast to browsers", async () => {
  await withServer(async ({ port, bridge }) => {
    const browserSpy = { sent: [], send(p) { this.sent.push(p); }, on() {}, close() {} };
    bridge.attachBrowser(browserSpy);
    const ws = connect(port);
    await waitOpen(ws);
    ws.send(JSON.stringify({ type: "hello", token: TOKEN }));
    await new Promise((r) => setTimeout(r, 30));
    ws.send(JSON.stringify({ type: "state", state: "ONLINE", ip: "1.2.3.4" }));
    await new Promise((r) => setTimeout(r, 30));
    const last = browserSpy.sent.map(p => JSON.parse(p)).find(m => m.type === "state");
    assert.equal(last.state, "ONLINE");
    ws.close();
  });
});

test("device net_stats telemetry is broadcast to browsers", async () => {
  await withServer(async ({ port, bridge }) => {
    const browserSpy = { sent: [], send(p) { this.sent.push(p); }, on() {}, close() {} };
    bridge.attachBrowser(browserSpy);
    const ws = connect(port);
    await waitOpen(ws);
    ws.send(JSON.stringify({ type: "hello", token: TOKEN }));
    await new Promise((r) => setTimeout(r, 30));
    ws.send(JSON.stringify({
      type: "net_stats", rssi: -63, heap: 111111, min_heap: 99999,
      disc_reason: 200, disc_count: 2, ts_ms: 4242,
    }));
    await new Promise((r) => setTimeout(r, 30));
    const m = browserSpy.sent.map(p => JSON.parse(p)).find(x => x.type === "net_stats");
    assert.equal(m.rssi, -63);
    assert.equal(m.disc_reason, 200);
    ws.close();
  });
});

test("recorded PCM (binary tag 0x01) appends to recorder while recording", async () => {
  await withServer(async ({ port, bridge, recorder }) => {
    const ws = connect(port);
    await waitOpen(ws);
    ws.send(JSON.stringify({ type: "hello", token: TOKEN }));
    await new Promise((r) => setTimeout(r, 30));
    recorder.start();
    const frame = Buffer.concat([Buffer.from([0x01]), Buffer.alloc(2048, 7)]);
    ws.send(frame);
    await new Promise((r) => setTimeout(r, 30));
    const result = await recorder.stop();
    assert.ok(result);
    assert.equal(result.sizeBytes, 44 + 2048);
    ws.close();
  });
});

test("recorded PCM is also fed to the transcriber (the live tap)", async () => {
  await withServer(async ({ port, transcriber }) => {
    const ws = connect(port);
    await waitOpen(ws);
    ws.send(JSON.stringify({ type: "hello", token: TOKEN }));
    await new Promise((r) => setTimeout(r, 30));
    const frame = Buffer.concat([Buffer.from([0x01]), Buffer.alloc(2048, 7)]);
    ws.send(frame);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(transcriber.fed.length, 1);
    assert.equal(transcriber.fed[0].length, 2048);
    ws.close();
  });
});

test("recorded PCM is also fed to the listen session", async () => {
  await withServer(async ({ port, micListener }) => {
    const ws = connect(port);
    await waitOpen(ws);
    ws.send(JSON.stringify({ type: "hello", token: TOKEN }));
    await new Promise((r) => setTimeout(r, 30));
    const frame = Buffer.concat([Buffer.from([0x01]), Buffer.alloc(2048, 7)]);
    ws.send(frame);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(micListener.fed.length, 1);
    assert.equal(micListener.fed[0].length, 2048);
    ws.close();
  });
});

test("device text frames are tapped via bridge.onDeviceMessage (for device-rpc)", async () => {
  await withServer(async ({ port, bridge }) => {
    const tapped = [];
    bridge.onDeviceMessage((m) => tapped.push(m));
    const ws = connect(port);
    await waitOpen(ws);
    ws.send(JSON.stringify({ type: "hello", token: TOKEN }));
    await new Promise((r) => setTimeout(r, 30));
    ws.send(JSON.stringify({ type: "wifi_scan", ref: "r1", networks: [{ ssid: "home", rssi: -42 }] }));
    ws.send(JSON.stringify({ type: "timer_fired", id: 2, label: "tea" }));
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(tapped.some((m) => m.type === "wifi_scan"));
    assert.ok(tapped.some((m) => m.type === "timer_fired" && m.label === "tea"));
    ws.close();
  });
});

test("JPEG binary is tapped via bridge.onDeviceBinary (for snapshot device-rpc)", async () => {
  await withServer(async ({ port, bridge }) => {
    const tags = [];
    bridge.onDeviceBinary((tag) => tags.push(tag));
    const ws = connect(port);
    await waitOpen(ws);
    ws.send(JSON.stringify({ type: "hello", token: TOKEN }));
    await new Promise((r) => setTimeout(r, 30));
    ws.send(Buffer.concat([Buffer.from([0x02]), Buffer.from([0xff, 0xd8])]));
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(tags, [0x02]);
    ws.close();
  });
});

test("JPEG (binary tag 0x02) is broadcast verbatim to browsers", async () => {
  await withServer(async ({ port, bridge }) => {
    const browserBin = [];
    const browserSpy = {
      sent: [], send(p) { if (Buffer.isBuffer(p)) browserBin.push(p); else this.sent.push(p); },
      on() {}, close() {},
    };
    bridge.attachBrowser(browserSpy);
    const ws = connect(port);
    await waitOpen(ws);
    ws.send(JSON.stringify({ type: "hello", token: TOKEN }));
    await new Promise((r) => setTimeout(r, 30));
    const jpeg = Buffer.concat([Buffer.from([0x02]), Buffer.from([0xff, 0xd8, 0xff, 0xe0])]);
    ws.send(jpeg);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(browserBin.length, 1);
    assert.deepEqual(browserBin[0], jpeg);
    ws.close();
  });
});

// An abrupt disconnect (power loss / Wi-Fi drop) sends no WS close frame, so the
// device socket stays half-open and 'close' never fires until the OS TCP
// keepalive (~2 h). The heartbeat probes with pings and terminates a socket that
// misses an interval — which fires 'close' so the bridge tells browsers the
// device went offline. We simulate "abrupt" by pausing the client's underlying
// socket: it stops reading, so it never auto-pongs (and sends nothing else).
test("device that stops responding to heartbeats is terminated → browsers told", async () => {
  await withServer(async ({ port, bridge }) => {
    const events = [];
    const browserSpy = {
      send(p) { if (typeof p === "string") { try { events.push(JSON.parse(p).type); } catch {} } },
      on() {}, close() {},
    };
    const ws = connect(port);
    await waitOpen(ws);
    ws.send(JSON.stringify({ type: "hello", token: TOKEN }));
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(bridge.device, "device attached after hello");
    // Attach the browser AFTER the device so the initial status it gets is
    // device_connected — then the death below is the only device_disconnected.
    bridge.attachBrowser(browserSpy);
    assert.deepEqual(events, ["device_connected"]);
    // Go silent: pause the read side so the client never pongs our pings.
    ws._socket.pause();
    await new Promise((r) => setTimeout(r, 300));
    // Capture, then always tear the client down before asserting — a paused,
    // lingering socket otherwise blocks server.close() and hangs the test.
    const stillAttached = bridge.device;
    const lastEvent = events.at(-1);
    ws.terminate();
    assert.equal(stillAttached, null, "device detached after missed heartbeats");
    assert.equal(lastEvent, "device_disconnected", "browsers told device went offline");
  }, { heartbeatMs: 40 });
});

test("responsive device is not terminated by the heartbeat", async () => {
  await withServer(async ({ port, bridge }) => {
    const ws = connect(port);
    await waitOpen(ws);
    ws.send(JSON.stringify({ type: "hello", token: TOKEN }));
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(bridge.device, "device attached");
    // Let several heartbeat intervals pass; the ws client auto-pongs, so it must
    // stay attached (no false-positive disconnect).
    await new Promise((r) => setTimeout(r, 300));
    const stillAttached = bridge.device;
    ws.close();
    assert.ok(stillAttached, "responsive device stays attached across heartbeats");
  }, { heartbeatMs: 40 });
});
