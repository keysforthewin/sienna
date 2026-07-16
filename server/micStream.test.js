import { test } from "node:test";
import assert from "node:assert/strict";
import { createMicStream } from "./micStream.js";

function makeBridge(deviceOnline = true) {
  return {
    deviceSent: [],
    deviceOnline,
    sendToDevice(p) {
      this.deviceSent.push(typeof p === "string" ? JSON.parse(p) : p);
      return this.deviceOnline;
    },
    cmds(type) { return this.deviceSent.filter((c) => c.type === type); },
  };
}

test("first acquire sends start_recording; second acquire does not", () => {
  const bridge = makeBridge(true);
  const mic = createMicStream({ bridge, refGen: () => "R" });
  assert.equal(mic.acquire("record"), true);
  assert.equal(mic.acquire("transcription"), true);
  assert.equal(bridge.cmds("start_recording").length, 1);
  assert.equal(bridge.deviceSent[0].ref, "R");
  assert.equal(mic.activeCount(), 2);
  assert.equal(mic.isOn(), true);
});

test("only the last release sends stop_recording", () => {
  const bridge = makeBridge(true);
  const mic = createMicStream({ bridge, refGen: () => "R" });
  mic.acquire("record");
  mic.acquire("listen:1");
  mic.release("record");
  assert.equal(bridge.cmds("stop_recording").length, 0);
  mic.release("listen:1");
  assert.equal(bridge.cmds("stop_recording").length, 1);
  assert.equal(mic.isOn(), false);
});

test("re-acquiring a held token is idempotent (no duplicate start)", () => {
  const bridge = makeBridge(true);
  const mic = createMicStream({ bridge });
  mic.acquire("record");
  mic.acquire("record");
  assert.equal(bridge.cmds("start_recording").length, 1);
  assert.equal(mic.activeCount(), 1);
});

test("releasing an absent token is a no-op", () => {
  const bridge = makeBridge(true);
  const mic = createMicStream({ bridge });
  mic.release("never-held");
  assert.equal(bridge.cmds("stop_recording").length, 0);
});

test("reset clears holders and sends nothing", () => {
  const bridge = makeBridge(true);
  const mic = createMicStream({ bridge });
  mic.acquire("record");
  mic.acquire("listen:1");
  mic.reset();
  assert.equal(mic.isOn(), false);
  assert.equal(mic.activeCount(), 0);
  assert.equal(bridge.cmds("stop_recording").length, 0);
});

test("acquire after reset starts the stream again (reconnect path)", () => {
  const bridge = makeBridge(true);
  const mic = createMicStream({ bridge, refGen: () => "R" });
  mic.acquire("record");
  mic.reset();
  assert.equal(mic.acquire("record"), true);
  // start_recording sent twice: once before reset, once after.
  assert.equal(bridge.cmds("start_recording").length, 2);
  assert.equal(mic.isOn(), true);
});

test("acquire returns false and holds no token when the device is offline", () => {
  const bridge = makeBridge(false);
  const mic = createMicStream({ bridge });
  assert.equal(mic.acquire("record"), false);
  assert.equal(mic.isOn(), false);
  assert.equal(mic.activeCount(), 0);
});
