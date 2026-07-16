import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { startServer } from "./index.js";

test("end-to-end: device connects, browser sees it, command flows through", async () => {
  const { stop, port } = await startServer({
    DASHBOARD_TOKEN: "smoke-token-123456",
    PORT: 0,
    RECORDINGS_DIR: "./.smoke-recordings",
    RECORDINGS_KEEP: 2,
    LOCALHOST_ONLY: "1",
    // Keep the smoke test hermetic — no real WAN probes/downloads.
    SIENNA_NETPROBE_MS: "0",
    SIENNA_NETPROBE_BANDWIDTH_MS: "0",
  });

  const TOKEN = "smoke-token-123456";
  const dev = new WebSocket(`ws://127.0.0.1:${port}/ws/device`);
  const br = new WebSocket(`ws://127.0.0.1:${port}/ws/browser?token=${TOKEN}`);
  // Buffer messages from creation so we never miss the server's immediate
  // attach-status frame to a listener registered after `open` (the old race).
  const brMessages = [];
  const devMessages = [];
  br.on("message", (m) => { try { brMessages.push(JSON.parse(m.toString())); } catch {} });
  dev.on("message", (m) => { try { devMessages.push(JSON.parse(m.toString())); } catch {} });

  const waitFor = async (buf, pred, ms = 8000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (buf.some(pred)) return true;
      await new Promise((r) => setTimeout(r, 20));
    }
    return false;
  };

  // Always tear down — even on assertion failure — so a flake fails cleanly
  // instead of leaving the server + sockets open and hanging the test process.
  try {
    await new Promise((r) => dev.once("open", r));
    dev.send(JSON.stringify({ type: "hello", token: TOKEN, fw_version: "test" }));
    await new Promise((r) => br.once("open", r));

    // Browser eventually sees the device is connected.
    assert.equal(await waitFor(brMessages, (m) => m.type === "device_connected"), true);

    // A browser command flows through to the device.
    br.send(JSON.stringify({ type: "set_blue_led", ref: "smoke-1", on: true }));
    assert.equal(await waitFor(devMessages, (m) => m.type === "set_blue_led" && m.on === true), true);
  } finally {
    try { dev.close(); } catch {}
    try { br.close(); } catch {}
    await stop();
  }
});
