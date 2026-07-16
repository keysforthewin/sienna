import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { Bridge } from "./bridge.js";
import { attachBrowserWs } from "./ws-browser.js";
import { Recorder } from "./recordings.js";
import { createMicStream } from "./micStream.js";
import { createVolume } from "./volume.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const TOKEN = "tok-87654321";

function makeTranscriberSpy() {
  return {
    calls: [],
    start() { this.calls.push("start"); },
    stop() { this.calls.push("stop"); },
    feedPcm() {}, handleDeviceDisconnect() {}, isActive: () => false,
  };
}

function makeAgentSpy() {
  return {
    runs: [], autonomy: null,
    run(input, opts) { this.runs.push({ input, opts }); return Promise.resolve({}); },
    setAutonomy(v) { this.autonomy = v; },
    getAutonomy() { return this.autonomy; },
    busy: () => false,
  };
}

async function withServer(fn, opts = {}) {
  const bridge = new Bridge();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wb-"));
  const recorder = new Recorder({ dir, keep: 5 });
  const transcriber = makeTranscriberSpy();
  const micStream = createMicStream({ bridge });
  const agent = opts.agent === undefined ? makeAgentSpy() : opts.agent;
  const volume = opts.volume !== undefined
    ? opts.volume
    : createVolume({ initialPercent: 100, onChange: (percent) => bridge.broadcastToBrowsers({ type: "volume", percent }) });
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, sock, head) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname !== "/ws/browser") { sock.destroy(); return; }
    wss.handleUpgrade(req, sock, head, (ws) => wss.emit("connection", ws, req));
  });
  const audioOut = opts.audioOut === undefined ? null : opts.audioOut;
  attachBrowserWs(wss, bridge, TOKEN, recorder, transcriber, micStream, agent, volume, audioOut, opts.getNowPlaying ?? null);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  try {
    await fn({ port, bridge, recorder, transcriber, micStream, agent, volume });
  } finally {
    wss.close();
    // Force-close lingering sockets so a test that asserts before ws.close()
    // fails cleanly instead of hanging server.close().
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function connect(port, token) {
  return new WebSocket(`ws://127.0.0.1:${port}/ws/browser?token=${encodeURIComponent(token)}`);
}

function waitOpen(ws) {
  return new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
}

function waitClose(ws) {
  return new Promise((res) => ws.once("close", (code) => res(code)));
}

// Parse a text WS frame to JSON; return null for anything non-JSON (e.g. binary).
function safeJson(m) {
  try { return JSON.parse(m.toString()); } catch { return null; }
}

test("browser with right token connects and gets device_disconnected initially", async () => {
  await withServer(async ({ port }) => {
    const ws = connect(port, TOKEN);
    // Register BEFORE the handshake resolves: on fast loopback (WSL2) the
    // connect-time frames can arrive in the same I/O tick as 'open', i.e.
    // before an await-open continuation could attach a listener.
    const first = new Promise((r) => ws.once("message", (m) => r(JSON.parse(m.toString()))));
    await waitOpen(ws);
    assert.equal((await first).type, "device_disconnected");
    ws.close();
  });
});

test("browser with wrong token closes 4001", async () => {
  await withServer(async ({ port }) => {
    const ws = connect(port, "nope");
    const code = await waitClose(ws);
    assert.equal(code, 4001);
  });
});

test("browser command forwards to device with attached ref", async () => {
  await withServer(async ({ port, bridge }) => {
    const deviceSpy = {
      sent: [], send(p) { this.sent.push(p); }, on() {}, close() {},
    };
    bridge.attachDevice(deviceSpy);
    const ws = connect(port, TOKEN);
    await waitOpen(ws);
    ws.send(JSON.stringify({ type: "set_rgb", ref: "browser-1", r: 10, g: 20, b: 30 }));
    await new Promise((r) => setTimeout(r, 30));
    const last = JSON.parse(deviceSpy.sent.at(-1));
    assert.equal(last.type, "set_rgb");
    assert.equal(last.r, 10);
    assert.ok(last.ref); // server reattached its own ref
    ws.close();
  });
});

test("browser command with no device returns command_error", async () => {
  await withServer(async ({ port }) => {
    const ws = connect(port, TOKEN);
    await waitOpen(ws);
    const messages = [];
    ws.on("message", (m) => messages.push(JSON.parse(m.toString())));
    ws.send(JSON.stringify({ type: "set_rgb", ref: "b1", r: 1, g: 2, b: 3 }));
    await new Promise((r) => setTimeout(r, 30));
    const err = messages.find((m) => m.type === "command_error");
    assert.ok(err);
    assert.equal(err.reason, "device_offline");
    assert.equal(err.ref, "b1");
    ws.close();
  });
});

test("browser binary frame (playback PCM) forwards to device", async () => {
  await withServer(async ({ port, bridge }) => {
    const deviceBin = [];
    const deviceSpy = {
      sent: [], send(p) { if (Buffer.isBuffer(p)) deviceBin.push(p); else this.sent.push(p); },
      on() {}, close() {},
    };
    bridge.attachDevice(deviceSpy);
    const ws = connect(port, TOKEN);
    await waitOpen(ws);
    // Browser sends raw PCM (no tag); server tags it 0x03 before forwarding
    ws.send(Buffer.alloc(256, 9));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(deviceBin.length, 1);
    assert.equal(deviceBin[0][0], 0x03);
    assert.equal(deviceBin[0].length, 257);
    ws.close();
  });
});

test("browser speaker PCM is dropped while the transmit gate is muted", async () => {
  // Muted: the frame never reaches the device AND the drop is silent (no
  // command_error — the stream keeps flowing).
  await withServer(async ({ port, bridge }) => {
    const deviceBin = [];
    const deviceSpy = {
      sent: [], send(p) { if (Buffer.isBuffer(p)) deviceBin.push(p); else this.sent.push(p); },
      on() {}, close() {},
    };
    bridge.attachDevice(deviceSpy);
    const ws = connect(port, TOKEN);
    await waitOpen(ws);
    const errors = [];
    ws.on("message", (m) => {
      const msg = safeJson(m);
      if (msg && msg.type === "command_error") errors.push(msg);
    });
    ws.send(Buffer.alloc(256, 9));
    await new Promise((r) => setTimeout(r, 30));
    ws.close(); // close BEFORE asserting: an open ws hangs server.close on failure
    assert.equal(deviceBin.length, 0);
    assert.equal(errors.length, 0);
  }, { audioOut: { isMuted: () => true } });

  // Inverse guard: unmuted, the same frame IS forwarded — proving it's the
  // gate, not a broken pipe.
  await withServer(async ({ port, bridge }) => {
    const deviceBin = [];
    const deviceSpy = {
      sent: [], send(p) { if (Buffer.isBuffer(p)) deviceBin.push(p); else this.sent.push(p); },
      on() {}, close() {},
    };
    bridge.attachDevice(deviceSpy);
    const ws = connect(port, TOKEN);
    await waitOpen(ws);
    ws.send(Buffer.alloc(256, 9));
    await new Promise((r) => setTimeout(r, 30));
    ws.close(); // close BEFORE asserting: an open ws hangs server.close on failure
    assert.equal(deviceBin.length, 1);
    assert.equal(deviceBin[0][0], 0x03);
  }, { audioOut: { isMuted: () => false } });
});

test("agent_input runs the agent (not the device) and acks locally", async () => {
  await withServer(async ({ port, bridge, agent }) => {
    const deviceSpy = { sent: [], send(p) { this.sent.push(p); }, on() {}, close() {} };
    bridge.attachDevice(deviceSpy);
    const ws = connect(port, TOKEN);
    await waitOpen(ws);
    const messages = [];
    ws.on("message", (m) => messages.push(JSON.parse(m.toString())));
    ws.send(JSON.stringify({ type: "agent_input", ref: "a1", text: "hello sienna" }));
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(agent.runs[0], { input: "hello sienna", opts: { source: "text" } });
    assert.ok(!deviceSpy.sent.some((p) => /agent_input/.test(p)));
    assert.ok(messages.some((m) => m.type === "ack" && m.ref === "a1"));
    ws.close();
  });
});

test("set_autonomy toggles the agent and broadcasts autonomy_state", async () => {
  await withServer(async ({ port, agent }) => {
    const ws = connect(port, TOKEN);
    await waitOpen(ws);
    const messages = [];
    ws.on("message", (m) => messages.push(JSON.parse(m.toString())));
    ws.send(JSON.stringify({ type: "set_autonomy", ref: "s1", enabled: true }));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(agent.autonomy, true);
    assert.ok(messages.some((m) => m.type === "autonomy_state" && m.enabled === true));
    ws.close();
  });
});

test("a connecting browser is told the agent's current autonomy state", async () => {
  // The agent is already autonomous (an earlier browser turned it on); a
  // freshly-connecting browser must learn this on connect so its toggle survives
  // a page reload instead of defaulting back to off.
  const agent = makeAgentSpy();
  agent.autonomy = true;
  await withServer(async ({ port }) => {
    const ws = connect(port, TOKEN);
    const messages = [];
    ws.on("message", (m) => messages.push(JSON.parse(m.toString()))); // before open: connect-time frames race the open continuation
    await waitOpen(ws);
    await new Promise((r) => setTimeout(r, 30));
    const st = messages.find((m) => m.type === "autonomy_state");
    assert.ok(st, "expected an autonomy_state on connect");
    assert.equal(st.enabled, true);
    ws.close();
  }, { agent });
});

test("agent commands degrade to agent_unavailable when no agent is configured", async () => {
  await withServer(async ({ port }) => {
    const ws = connect(port, TOKEN);
    await waitOpen(ws);
    const messages = [];
    ws.on("message", (m) => messages.push(JSON.parse(m.toString())));
    ws.send(JSON.stringify({ type: "agent_input", ref: "a1", text: "hi" }));
    await new Promise((r) => setTimeout(r, 30));
    const err = messages.find((m) => m.type === "command_error");
    assert.ok(err, "expected a command_error");
    assert.equal(err.reason, "agent_unavailable");
    ws.close();
  }, { agent: null });   // <- opts for withServer, not for test()
});

test("start_recording then stop_recording emits recording_ready", async () => {
  await withServer(async ({ port, bridge, recorder }) => {
    // A device must be attached so the arbiter's start_recording acquire
    // succeeds; the recorder is then fed PCM directly to stand in for frames.
    const deviceSpy = { sent: [], send(p) { this.sent.push(p); }, on() {}, close() {} };
    bridge.attachDevice(deviceSpy);
    const ws = connect(port, TOKEN);
    await waitOpen(ws);
    const messages = [];
    ws.on("message", (m) => messages.push(JSON.parse(m.toString())));
    ws.send(JSON.stringify({ type: "start_recording", ref: "rec-1" }));
    await new Promise((r) => setTimeout(r, 30));
    recorder.appendPcm(Buffer.alloc(2048, 1));
    ws.send(JSON.stringify({ type: "stop_recording", ref: "rec-2" }));
    await new Promise((r) => setTimeout(r, 400));
    const ready = messages.find((m) => m.type === "recording_ready");
    assert.ok(ready);
    assert.match(ready.filename, /\.wav$/);
    ws.close();
  });
});

test("start_recording is consumed server-side and not forwarded to the device", async () => {
  await withServer(async ({ port, bridge }) => {
    const deviceSpy = { sent: [], send(p) { this.sent.push(p); }, on() {}, close() {} };
    bridge.attachDevice(deviceSpy);
    const ws = connect(port, TOKEN);
    await waitOpen(ws);
    ws.send(JSON.stringify({ type: "start_recording", ref: "rec-1" }));
    await new Promise((r) => setTimeout(r, 30));
    const types = deviceSpy.sent.map((p) => JSON.parse(p).type);
    // The arbiter sends start_recording to the device exactly once; the browser
    // command itself is not separately forwarded.
    assert.equal(types.filter((t) => t === "start_recording").length, 1);
    ws.close();
  });
});

test("start_listening then stop_listening drives the shared mic stream", async () => {
  await withServer(async ({ port, bridge, micStream }) => {
    const deviceSpy = { sent: [], send(p) { this.sent.push(p); }, on() {}, close() {} };
    bridge.attachDevice(deviceSpy);
    const ws = connect(port, TOKEN);
    await waitOpen(ws);
    ws.send(JSON.stringify({ type: "start_listening", ref: "l1" }));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(micStream.isOn(), true);
    ws.send(JSON.stringify({ type: "stop_listening", ref: "l2" }));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(micStream.isOn(), false);
    ws.close();
  });
});

test("closing a listening browser releases its mic-stream token", async () => {
  await withServer(async ({ port, bridge, micStream }) => {
    const deviceSpy = { sent: [], send(p) { this.sent.push(p); }, on() {}, close() {} };
    bridge.attachDevice(deviceSpy);
    const ws = connect(port, TOKEN);
    await waitOpen(ws);
    ws.send(JSON.stringify({ type: "start_listening", ref: "l1" }));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(micStream.isOn(), true);
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(micStream.isOn(), false);
  });
});

test("set_volume updates the master gain, acks, and is not forwarded to the device", async () => {
  await withServer(async ({ port, bridge, volume }) => {
    const deviceSpy = { sent: [], send(p) { this.sent.push(p); }, on() {}, close() {} };
    bridge.attachDevice(deviceSpy);
    const ws = connect(port, TOKEN);
    await waitOpen(ws);
    const messages = [];
    ws.on("message", (m) => messages.push(safeJson(m)));
    ws.send(JSON.stringify({ type: "set_volume", ref: "v1", percent: 250 }));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(volume.getPercent(), 250);
    assert.ok(messages.some((m) => m && m.type === "ack" && m.ref === "v1"));
    assert.ok(!deviceSpy.sent.some((p) => /set_volume/.test(p)), "never forwarded to the device");
    ws.close();
  });
});

test("browser binary frames are scaled by the master volume", async () => {
  await withServer(async ({ port, bridge }) => {
    const deviceBin = [];
    const deviceSpy = {
      sent: [], send(p) { if (Buffer.isBuffer(p)) deviceBin.push(p); else this.sent.push(p); },
      on() {}, close() {},
    };
    bridge.attachDevice(deviceSpy);
    const ws = connect(port, TOKEN);
    await waitOpen(ws);
    ws.send(JSON.stringify({ type: "set_volume", ref: "v1", percent: 200 }));
    await new Promise((r) => setTimeout(r, 30));
    // Two int16-LE samples [1000, -2000] → at 200% → [2000, -4000].
    const pcm = Buffer.alloc(4);
    pcm.writeInt16LE(1000, 0); pcm.writeInt16LE(-2000, 2);
    ws.send(pcm);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(deviceBin.length, 1);
    assert.equal(deviceBin[0][0], 0x03);
    assert.equal(deviceBin[0].readInt16LE(1), 2000);
    assert.equal(deviceBin[0].readInt16LE(3), -4000);
    ws.close();
  });
});

test("a connecting browser is told the current master volume", async () => {
  const volume = createVolume({ initialPercent: 175, maxPercent: 400 });
  await withServer(async ({ port }) => {
    const ws = connect(port, TOKEN);
    const messages = [];
    ws.on("message", (m) => messages.push(safeJson(m))); // before open: connect-time frames race the open continuation
    await waitOpen(ws);
    await new Promise((r) => setTimeout(r, 30));
    const vol = messages.find((m) => m && m.type === "volume");
    assert.ok(vol, "expected a volume snapshot on connect");
    assert.equal(vol.percent, 175);
    assert.equal(vol.max, 400);
    ws.close();
  }, { volume });
});

test("set_music_pacing updates the live pace via audioOut, acks, and is not forwarded to the device", async () => {
  let pace = 120;
  const audioOut = {
    setMusicPacingMs: (ms) => { pace = ms; return ms; },
    getMusicPacingMs: () => pace,
    musicPacingBounds: () => ({ min: 80, max: 136 }),
  };
  await withServer(async ({ port, bridge }) => {
    const deviceSpy = { sent: [], send(p) { this.sent.push(p); }, on() {}, close() {} };
    bridge.attachDevice(deviceSpy);
    const ws = connect(port, TOKEN);
    await waitOpen(ws);
    const messages = [];
    ws.on("message", (m) => messages.push(safeJson(m)));
    ws.send(JSON.stringify({ type: "set_music_pacing", ref: "p1", ms: 128 }));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(pace, 128);
    assert.ok(messages.some((m) => m && m.type === "ack" && m.ref === "p1"));
    assert.ok(!deviceSpy.sent.some((p) => /music_pacing|set_music/.test(p)), "never forwarded to the device");
    ws.close();
  }, { audioOut });
});

test("a connecting browser is told the current music pacing + bounds", async () => {
  const audioOut = {
    setMusicPacingMs: (ms) => ms,
    getMusicPacingMs: () => 110,
    musicPacingBounds: () => ({ min: 80, max: 136 }),
  };
  await withServer(async ({ port }) => {
    const ws = connect(port, TOKEN);
    const messages = [];
    ws.on("message", (m) => messages.push(safeJson(m)));
    await waitOpen(ws);
    await new Promise((r) => setTimeout(r, 30));
    const m = messages.find((x) => x && x.type === "music_pacing");
    assert.ok(m, "expected a music_pacing snapshot on connect");
    assert.equal(m.ms, 110);
    assert.equal(m.min, 80);
    assert.equal(m.max, 136);
    ws.close();
  }, { audioOut });
});

test("set_tts_pacing updates the live voice pace via audioOut, acks, and is not forwarded to the device", async () => {
  let pace = 80;
  const audioOut = {
    setTtsPacingMs: (ms) => { pace = ms; return ms; },
    getTtsPacingMs: () => pace,
    ttsPacingBounds: () => ({ min: 64, max: 128 }),
  };
  await withServer(async ({ port, bridge }) => {
    const deviceSpy = { sent: [], send(p) { this.sent.push(p); }, on() {}, close() {} };
    bridge.attachDevice(deviceSpy);
    const ws = connect(port, TOKEN);
    await waitOpen(ws);
    const messages = [];
    ws.on("message", (m) => messages.push(safeJson(m)));
    ws.send(JSON.stringify({ type: "set_tts_pacing", ref: "t1", ms: 110 }));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(pace, 110);
    assert.ok(messages.some((m) => m && m.type === "ack" && m.ref === "t1"));
    assert.ok(!deviceSpy.sent.some((p) => /tts_pacing|set_tts/.test(p)), "never forwarded to the device");
    ws.close();
  }, { audioOut });
});

test("a connecting browser is told the current voice (TTS) pacing + bounds", async () => {
  const audioOut = {
    setTtsPacingMs: (ms) => ms,
    getTtsPacingMs: () => 96,
    ttsPacingBounds: () => ({ min: 64, max: 128 }),
  };
  await withServer(async ({ port }) => {
    const ws = connect(port, TOKEN);
    const messages = [];
    ws.on("message", (m) => messages.push(safeJson(m)));
    await waitOpen(ws);
    await new Promise((r) => setTimeout(r, 30));
    const m = messages.find((x) => x && x.type === "tts_pacing");
    assert.ok(m, "expected a tts_pacing snapshot on connect");
    assert.equal(m.ms, 96);
    assert.equal(m.min, 64);
    assert.equal(m.max, 128);
    ws.close();
  }, { audioOut });
});

test("set_volume broadcasts the new value to every browser", async () => {
  await withServer(async ({ port }) => {
    const a = connect(port, TOKEN); await waitOpen(a);
    const b = connect(port, TOKEN); await waitOpen(b);
    const bMsgs = [];
    b.on("message", (m) => bMsgs.push(safeJson(m)));
    await new Promise((r) => setTimeout(r, 20));
    a.send(JSON.stringify({ type: "set_volume", ref: "v1", percent: 250 }));
    await new Promise((r) => setTimeout(r, 40));
    assert.ok(bMsgs.some((m) => m && m.type === "volume" && m.percent === 250),
      "the other browser should receive the volume broadcast");
    a.close(); b.close();
  });
});

test("connect-time now_playing frame reflects the live jukebox state", async () => {
  const np = { type: "now_playing", active: true, paused: false, title: "A", artist: "X", query: "jazz" };
  await withServer(async ({ port }) => {
    const ws = connect(port, TOKEN);
    const frames = [];
    ws.on("message", (m) => { const j = safeJson(m); if (j) frames.push(j); });
    await waitOpen(ws);
    await new Promise((r) => setTimeout(r, 50));
    const got = frames.find((f) => f.type === "now_playing");
    assert.deepEqual(got, np);
    ws.close();
  }, { getNowPlaying: () => np });
});
