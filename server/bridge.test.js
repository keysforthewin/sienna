import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Bridge } from "./bridge.js";

class FakeSession extends EventEmitter {
  constructor() { super(); this.sent = []; this.closed = false; }
  send(payload) { this.sent.push(payload); }
  close(code, reason) { this.closed = { code, reason }; this.emit("close"); }
}

test("attachBrowser sends device_disconnected when no device", () => {
  const bridge = new Bridge();
  const browser = new FakeSession();
  bridge.attachBrowser(browser);
  assert.deepEqual(JSON.parse(browser.sent[0]), { type: "device_disconnected" });
});

test("attachDevice notifies all browsers", () => {
  const bridge = new Bridge();
  const b1 = new FakeSession();
  const b2 = new FakeSession();
  bridge.attachBrowser(b1);
  bridge.attachBrowser(b2);
  const device = new FakeSession();
  bridge.attachDevice(device);
  assert.deepEqual(JSON.parse(b1.sent.at(-1)), { type: "device_connected" });
  assert.deepEqual(JSON.parse(b2.sent.at(-1)), { type: "device_connected" });
});

test("device close fans out device_disconnected", () => {
  const bridge = new Bridge();
  const browser = new FakeSession();
  bridge.attachBrowser(browser);
  const device = new FakeSession();
  bridge.attachDevice(device);
  device.emit("close");
  assert.deepEqual(JSON.parse(browser.sent.at(-1)), { type: "device_disconnected" });
});

test("second device replaces first", () => {
  const bridge = new Bridge();
  const d1 = new FakeSession();
  bridge.attachDevice(d1);
  const d2 = new FakeSession();
  bridge.attachDevice(d2);
  assert.ok(d1.closed);
  assert.equal(bridge.device, d2);
});

test("sendToDevice forwards JSON when device present", () => {
  const bridge = new Bridge();
  const device = new FakeSession();
  bridge.attachDevice(device);
  const ok = bridge.sendToDevice({ type: "snapshot", ref: "r1" });
  assert.equal(ok, true);
  assert.deepEqual(JSON.parse(device.sent[0]), { type: "snapshot", ref: "r1" });
});

test("sendToDevice returns false when no device", () => {
  const bridge = new Bridge();
  const ok = bridge.sendToDevice({ type: "snapshot", ref: "r1" });
  assert.equal(ok, false);
});

test("broadcastToBrowsers fans out", () => {
  const bridge = new Bridge();
  const b1 = new FakeSession();
  const b2 = new FakeSession();
  bridge.attachBrowser(b1);
  bridge.attachBrowser(b2);
  bridge.broadcastToBrowsers({ type: "ldr", value: 100, ts_ms: 1 });
  assert.deepEqual(JSON.parse(b1.sent.at(-1)), { type: "ldr", value: 100, ts_ms: 1 });
  assert.deepEqual(JSON.parse(b2.sent.at(-1)), { type: "ldr", value: 100, ts_ms: 1 });
});

test("broadcastBinaryToBrowsers passes Buffer through", () => {
  const bridge = new Bridge();
  const browser = new FakeSession();
  bridge.attachBrowser(browser);
  const buf = Buffer.from([0x01, 0x02, 0x03]);
  bridge.broadcastBinaryToBrowsers(buf);
  assert.equal(browser.sent.at(-1), buf);
});

test("browser close removes from set", () => {
  const bridge = new Bridge();
  const browser = new FakeSession();
  bridge.attachBrowser(browser);
  assert.equal(bridge.browsers.size, 1);
  browser.emit("close");
  assert.equal(bridge.browsers.size, 0);
});

const parsed = (s) => s.sent.map((p) => JSON.parse(p));

test("a browser attaching AFTER the device reports state gets the last state replayed", () => {
  const bridge = new Bridge();
  bridge.attachDevice(new FakeSession());
  // Device went ONLINE and reported it before any browser was listening.
  bridge.broadcastToBrowsers({ type: "state", state: "ONLINE", ip: "10.0.0.5", wifi_rssi: -55 });

  const browser = new FakeSession();
  bridge.attachBrowser(browser);

  const msgs = parsed(browser);
  assert.deepEqual(msgs[0], { type: "device_connected" });
  const state = msgs.find((m) => m.type === "state");
  assert.ok(state, "late-joining browser should receive the cached device state");
  assert.equal(state.state, "ONLINE");
  assert.equal(state.ip, "10.0.0.5");
  assert.equal(state.wifi_rssi, -55);
});

test("no state is replayed when the device never reported one", () => {
  const bridge = new Bridge();
  bridge.attachDevice(new FakeSession());
  const browser = new FakeSession();
  bridge.attachBrowser(browser);
  assert.deepEqual(parsed(browser), [{ type: "device_connected" }]);
});

test("stale state is not replayed after the device disconnects", () => {
  const bridge = new Bridge();
  const device = new FakeSession();
  bridge.attachDevice(device);
  bridge.broadcastToBrowsers({ type: "state", state: "ONLINE", ip: "10.0.0.5", wifi_rssi: -55 });
  device.emit("close");  // device drops

  const browser = new FakeSession();
  bridge.attachBrowser(browser);
  assert.deepEqual(parsed(browser), [{ type: "device_disconnected" }]);
});

test("a fresh device session clears the previous device's cached state", () => {
  const bridge = new Bridge();
  bridge.attachDevice(new FakeSession());
  bridge.broadcastToBrowsers({ type: "state", state: "ONLINE", ip: "10.0.0.5", wifi_rssi: -55 });
  bridge.attachDevice(new FakeSession());  // device reconnects, hasn't reported state yet

  const browser = new FakeSession();
  bridge.attachBrowser(browser);
  assert.deepEqual(parsed(browser), [{ type: "device_connected" }]);
});

test("onDeviceConnected fires on attachDevice, supports unsubscribe, isolates a throwing callback", () => {
  const bridge = new Bridge();
  let aCalls = 0, bCalls = 0;
  const offA = bridge.onDeviceConnected(() => { aCalls++; throw new Error("boom"); });
  bridge.onDeviceConnected(() => { bCalls++; });
  bridge.attachDevice(new FakeSession());
  assert.equal(aCalls, 1);
  assert.equal(bCalls, 1);          // the throwing callback didn't break the rest
  offA();
  bridge.attachDevice(new FakeSession());
  assert.equal(aCalls, 1);          // unsubscribed
  assert.equal(bCalls, 2);
});

test("onDeviceCommand taps object sends with the object itself", () => {
  const bridge = new Bridge();
  bridge.attachDevice(new FakeSession());
  const seen = [];
  bridge.onDeviceCommand((m) => seen.push(m));
  bridge.sendToDevice({ type: "set_rgb", r: 1, g: 2, b: 3 });
  assert.deepEqual(seen, [{ type: "set_rgb", r: 1, g: 2, b: 3 }]);
});

test("onDeviceCommand parses string payloads and skips malformed ones", () => {
  const bridge = new Bridge();
  bridge.attachDevice(new FakeSession());
  const seen = [];
  bridge.onDeviceCommand((m) => seen.push(m));
  bridge.sendToDevice(JSON.stringify({ type: "set_blue_led", on: true }));
  bridge.sendToDevice("{not json");
  assert.deepEqual(seen, [{ type: "set_blue_led", on: true }]);
});

test("onDeviceCommand does not fire when no device is attached (send refused)", () => {
  const bridge = new Bridge();
  const seen = [];
  bridge.onDeviceCommand((m) => seen.push(m));
  assert.equal(bridge.sendToDevice({ type: "set_blue_led", on: true }), false);
  assert.equal(seen.length, 0);
});

test("a throwing onDeviceCommand listener doesn't break the send", () => {
  const bridge = new Bridge();
  const device = new FakeSession();
  bridge.attachDevice(device);
  bridge.onDeviceCommand(() => { throw new Error("boom"); });
  assert.equal(bridge.sendToDevice({ type: "set_rgb", r: 9, g: 9, b: 9 }), true);
  assert.equal(device.sent.length, 1);
});

test("onDeviceCommand returns an unsubscribe function", () => {
  const bridge = new Bridge();
  bridge.attachDevice(new FakeSession());
  const seen = [];
  const off = bridge.onDeviceCommand((m) => seen.push(m));
  off();
  bridge.sendToDevice({ type: "set_blue_led", on: true });
  assert.equal(seen.length, 0);
});
