// Device-RPC: send a command to the ESP32 and await its correlated response.
//
// The bridge only fans device traffic out to browsers; this module taps it
// (bridge.onDeviceMessage / onDeviceBinary) to resolve a specific request:
//   - command()       resolves on the matching ack.ref  (LEDs/RGB/tone/audio)
//   - request()       resolves on the next message of `expectType`, preferring an
//                     exact ref match when the firmware echoes it (scan_*/timer),
//                     falling back to next-of-type for ref-less legacy reads (ldr)
//   - requestBinary() resolves on the next binary of `expectTag` (snapshot → JPEG)
// Every pending request has a timeout; a device disconnect rejects them all. The
// agent serializes runs, so each request type is single-flight (no races).

import { buildServerCommand } from "./protocol.js";
import { randomUUID } from "node:crypto";

function rpcError(reason) {
  const e = new Error(`device_rpc: ${reason}`);
  e.reason = reason;
  return e;
}

export function createDeviceRpc({
  bridge,
  buildCommand = buildServerCommand,
  refGen = randomUUID,
  defaultTimeoutMs = 5000,
}) {
  const pendingAcks = new Map();   // ref -> { resolve, reject, timer }
  const pendingTypes = [];         // { type, ref, resolve, reject, timer }
  const pendingBinaries = [];      // { tag, resolve, reject, timer }

  bridge.onDeviceMessage((msg) => {
    if (msg.type === "ack" && pendingAcks.has(msg.ref)) {
      const p = pendingAcks.get(msg.ref);
      clearTimeout(p.timer);
      pendingAcks.delete(msg.ref);
      p.resolve({ ok: msg.ok, error: msg.error });
      return;
    }
    for (let i = 0; i < pendingTypes.length; i++) {
      const p = pendingTypes[i];
      if (p.type !== msg.type) continue;
      // If both sides have a ref, they must match; if the response omits a ref
      // (legacy), accept the next message of this type.
      if (p.ref && msg.ref && msg.ref !== p.ref) continue;
      clearTimeout(p.timer);
      pendingTypes.splice(i, 1);
      p.resolve(msg);
      return;
    }
  });

  bridge.onDeviceBinary((tag, payload) => {
    for (let i = 0; i < pendingBinaries.length; i++) {
      const p = pendingBinaries[i];
      if (p.tag !== tag) continue;
      clearTimeout(p.timer);
      pendingBinaries.splice(i, 1);
      p.resolve(Buffer.from(payload));
      return;
    }
  });

  bridge.onDeviceDisconnected(() => rejectAll("device_offline"));

  function rejectAll(reason) {
    for (const p of pendingAcks.values()) { clearTimeout(p.timer); p.reject(rpcError(reason)); }
    pendingAcks.clear();
    for (const p of pendingTypes.splice(0)) { clearTimeout(p.timer); p.reject(rpcError(reason)); }
    for (const p of pendingBinaries.splice(0)) { clearTimeout(p.timer); p.reject(rpcError(reason)); }
  }

  function send(cmd, ref) {
    const payload = buildCommand({ ...cmd }, ref);
    return bridge.sendToDevice(payload);
  }

  function command(cmd, { timeoutMs = defaultTimeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      const ref = refGen();
      if (!send(cmd, ref)) { reject(rpcError("device_offline")); return; }
      const timer = setTimeout(() => {
        pendingAcks.delete(ref);
        reject(rpcError("device_timeout"));
      }, timeoutMs);
      pendingAcks.set(ref, { resolve, reject, timer });
    });
  }

  function request(cmd, { expectType, timeoutMs = defaultTimeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      const ref = refGen();
      if (!send(cmd, ref)) { reject(rpcError("device_offline")); return; }
      const entry = { type: expectType, ref, resolve, reject, timer: null };
      entry.timer = setTimeout(() => {
        const i = pendingTypes.indexOf(entry);
        if (i >= 0) pendingTypes.splice(i, 1);
        reject(rpcError("device_timeout"));
      }, timeoutMs);
      pendingTypes.push(entry);
    });
  }

  function requestBinary(cmd, { expectTag, timeoutMs = defaultTimeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      const ref = refGen();
      if (!send(cmd, ref)) { reject(rpcError("device_offline")); return; }
      const entry = { tag: expectTag, resolve, reject, timer: null };
      entry.timer = setTimeout(() => {
        const i = pendingBinaries.indexOf(entry);
        if (i >= 0) pendingBinaries.splice(i, 1);
        reject(rpcError("device_timeout"));
      }, timeoutMs);
      pendingBinaries.push(entry);
    });
  }

  return { command, request, requestBinary };
}
