// Ref-counted arbiter for the single device microphone stream.
//
// The firmware streams mic PCM only while "recording" (start_recording →
// stop_recording). Three server-side consumers want that stream — the WAV
// Recorder, the Scribe transcriber, and each listening browser — and they can
// overlap. This arbiter is the SOLE sender of start_recording/stop_recording:
// it tells the device to start on the 0→1 holder transition and to stop on the
// last release, so consumers never stomp each other.

import { randomUUID } from "node:crypto";
import { buildServerCommand } from "./protocol.js";

export function createMicStream({ bridge, refGen = randomUUID }) {
  const holders = new Set();

  const sendDevice = (type) =>
    bridge.sendToDevice(buildServerCommand({ type }, refGen()));

  // Returns true if the stream is on after this call, false if the device is
  // offline (so the caller can surface device_offline and abort).
  function acquire(token) {
    if (holders.has(token)) return true; // already a holder → stream is on
    if (holders.size === 0) {
      if (!sendDevice("start_recording")) return false; // device offline; hold nothing
    }
    holders.add(token);
    return true;
  }

  function release(token) {
    if (!holders.delete(token)) return;
    if (holders.size === 0) sendDevice("stop_recording");
  }

  // Device vanished: drop every holder without messaging the absent device.
  function reset() {
    holders.clear();
  }

  return {
    acquire,
    release,
    reset,
    isOn: () => holders.size > 0,
    activeCount: () => holders.size,
  };
}
