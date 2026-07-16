import { test } from "node:test";
import assert from "node:assert/strict";
import { createDeviceRpc } from "./device-rpc.js";

// Controllable fake bridge: captures device-rpc's taps and lets the test drive
// device responses. buildCommand is injected to skip protocol validation.
function makeBridge({ online = true } = {}) {
  let msgCb = null, binCb = null, discCb = null;
  const sent = [];
  return {
    sent,
    onDeviceMessage(cb) { msgCb = cb; return () => { msgCb = null; }; },
    onDeviceBinary(cb) { binCb = cb; return () => { binCb = null; }; },
    onDeviceDisconnected(cb) { discCb = cb; return () => { discCb = null; }; },
    sendToDevice(payload) { sent.push(payload); return online; },
    // test drivers
    emitMsg(m) { msgCb && msgCb(m); },
    emitBin(tag, payload) { binCb && binCb(tag, payload, Buffer.concat([Buffer.from([tag]), Buffer.from(payload)])); },
    disconnect() { discCb && discCb(); },
  };
}

const buildCommand = (cmd, ref) => ({ ...cmd, ref });
let refN = 0;
const refGen = () => `R${++refN}`;

function makeRpc(bridge) {
  refN = 0;
  return createDeviceRpc({ bridge, buildCommand, refGen, defaultTimeoutMs: 50 });
}

test("command resolves on the matching ack.ref", async () => {
  const bridge = makeBridge();
  const rpc = makeRpc(bridge);
  const p = rpc.command({ type: "set_blue_led", on: true });
  assert.equal(bridge.sent[0].ref, "R1");
  bridge.emitMsg({ type: "ack", ref: "R1", ok: true });
  assert.deepEqual(await p, { ok: true, error: undefined });
});

test("command ignores acks for other refs, then times out", async () => {
  const bridge = makeBridge();
  const rpc = makeRpc(bridge);
  const p = rpc.command({ type: "set_rgb", r: 1, g: 2, b: 3 });
  bridge.emitMsg({ type: "ack", ref: "SOMEONE_ELSE", ok: true });
  await assert.rejects(p, (e) => e.reason === "device_timeout");
});

test("request resolves on exact ref match (new firmware)", async () => {
  const bridge = makeBridge();
  const rpc = makeRpc(bridge);
  const p = rpc.request({ type: "scan_wifi" }, { expectType: "wifi_scan" });
  bridge.emitMsg({ type: "wifi_scan", ref: "R1", networks: [{ ssid: "x", rssi: -50 }] });
  const r = await p;
  assert.equal(r.networks[0].ssid, "x");
});

test("request falls back to next-of-type when response omits ref (legacy ldr)", async () => {
  const bridge = makeBridge();
  const rpc = makeRpc(bridge);
  const p = rpc.request({ type: "read_ldr" }, { expectType: "ldr" });
  bridge.emitMsg({ type: "ldr", value: 2048, ts_ms: 1 }); // no ref
  const r = await p;
  assert.equal(r.value, 2048);
});

test("request ignores a mismatched ref when the response carries one", async () => {
  const bridge = makeBridge();
  const rpc = makeRpc(bridge);
  const p = rpc.request({ type: "scan_ble" }, { expectType: "ble_scan" });
  bridge.emitMsg({ type: "ble_scan", ref: "WRONG", devices: [] });
  await assert.rejects(p, (e) => e.reason === "device_timeout");
});

test("requestBinary resolves on the next binary of the expected tag", async () => {
  const bridge = makeBridge();
  const rpc = makeRpc(bridge);
  const p = rpc.requestBinary({ type: "snapshot" }, { expectTag: 0x02 });
  bridge.emitBin(0x02, [1, 2, 3]);
  const buf = await p;
  assert.deepEqual([...buf], [1, 2, 3]);
});

test("no device attached rejects immediately with device_offline", async () => {
  const bridge = makeBridge({ online: false });
  const rpc = makeRpc(bridge);
  await assert.rejects(rpc.command({ type: "set_blue_led", on: false }), (e) => e.reason === "device_offline");
});

test("device disconnect rejects all pending requests", async () => {
  const bridge = makeBridge();
  const rpc = makeRpc(bridge);
  const a = rpc.command({ type: "set_blue_led", on: true });
  const b = rpc.request({ type: "read_ldr" }, { expectType: "ldr" });
  const c = rpc.requestBinary({ type: "snapshot" }, { expectTag: 0x02 });
  bridge.disconnect();
  await assert.rejects(a, (e) => e.reason === "device_offline");
  await assert.rejects(b, (e) => e.reason === "device_offline");
  await assert.rejects(c, (e) => e.reason === "device_offline");
});
