// End-to-end over real sockets: a fake device presses the PTT button and streams
// PCM, the server forwards it to a fake ElevenLabs Scribe endpoint, the resulting
// transcript lands on the browser, and the release routes the joined hold to the
// agent — exercising attachDeviceWs + attachBrowserWs + transcriber + scribe +
// the PTT coordinator together. The only fake is the ElevenLabs endpoint.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { WebSocketServer, WebSocket } from "ws";
import { Bridge } from "./bridge.js";
import { Recorder } from "./recordings.js";
import { attachDeviceWs } from "./ws-device.js";
import { attachBrowserWs } from "./ws-browser.js";
import { createTranscriber } from "./transcriber.js";
import { createMicStream } from "./micStream.js";
import { createScribeSession } from "./scribe.js";
import { createPttCoordinator } from "./ptt.js";

const TOKEN = "tok-integration-99";

function waitFor(ws, predicate, timeout = 1500) {
  return new Promise((resolve) => {
    const onMsg = (data, isBinary) => {
      if (isBinary) return;
      let m; try { m = JSON.parse(data.toString()); } catch { return; }
      if (predicate(m)) { ws.off("message", onMsg); resolve(m); }
    };
    ws.on("message", onMsg);
    setTimeout(() => { ws.off("message", onMsg); resolve(null); }, timeout);
  });
}

test("PTT press → device PCM → fake Scribe → browser transcript; release routes to agent", async () => {
  // 1. Fake ElevenLabs Scribe endpoint: replies with partial + committed after
  //    it receives the first audio chunk; captures the auth header.
  let capturedApiKey = null;
  const fakeEl = new WebSocketServer({ port: 0 });
  fakeEl.on("connection", (ws, req) => {
    capturedApiKey = req.headers["xi-api-key"];
    let chunks = 0;
    ws.on("message", (data) => {
      let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.message_type !== "input_audio_chunk") return;
      if (++chunks === 1) {
        ws.send(JSON.stringify({ message_type: "partial_transcript", text: "hello" }));
        ws.send(JSON.stringify({ message_type: "committed_transcript", text: "hello world" }));
      }
      // The PTT release's forced commit: answer with an (empty) committed
      // transcript so the coordinator finalizes without waiting out its timeout.
      if (msg.commit) ws.send(JSON.stringify({ message_type: "committed_transcript", text: "" }));
    });
  });
  await new Promise((r) => fakeEl.once("listening", r));
  const fakeUrl = `ws://127.0.0.1:${fakeEl.address().port}`;

  // 2. The dashboard server, wired exactly like index.js but pointed at the fake.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tx-"));
  const bridge = new Bridge();
  const recorder = new Recorder({ dir, keep: 5 });
  const scribeFactory = ({ callbacks }) =>
    createScribeSession({ apiKey: "k", endpoint: fakeUrl, callbacks });
  const micStream = createMicStream({ bridge });
  let ptt;  // lazy, as in index.js
  const transcriber = createTranscriber({
    bridge, scribeFactory, micStream,
    onFinalTranscript: (t) => ptt.onUtterance(t),
    onCommitObserved: () => ptt.onCommitObserved(),
  });
  const agentRuns = [];
  ptt = createPttCoordinator({
    transcriber,
    runAgent: (text, source) => { agentRuns.push({ text, source }); return Promise.resolve(); },
    releaseGraceMs: 50, commitTimeoutMs: 500,
  });
  bridge.onDeviceMessage((m) => { if (m.type === "button" && m.id === "ptt") ptt.onButton(m.pressed); });
  bridge.onDeviceDisconnected(() => {
    ptt.cancel();
    transcriber.handleDeviceDisconnect();
    micStream.reset();
  });

  const server = http.createServer();
  const wssDevice = new WebSocketServer({ noServer: true });
  const wssBrowser = new WebSocketServer({ noServer: true });
  attachDeviceWs(wssDevice, bridge, recorder, transcriber, TOKEN);
  attachBrowserWs(wssBrowser, bridge, TOKEN, recorder, transcriber, micStream);
  server.on("upgrade", (req, sock, head) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/ws/device") wssDevice.handleUpgrade(req, sock, head, (ws) => wssDevice.emit("connection", ws, req));
    else if (url.pathname === "/ws/browser") wssBrowser.handleUpgrade(req, sock, head, (ws) => wssBrowser.emit("connection", ws, req));
    else sock.destroy();
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  try {
    // 3. Fake device: says hello, then streams 0x01 PCM frames while "recording".
    const dev = new WebSocket(`ws://127.0.0.1:${port}/ws/device`);
    await new Promise((r) => dev.once("open", r));
    dev.send(JSON.stringify({ type: "hello", token: TOKEN, fw_version: "test" }));
    let pcmTimer = null;
    dev.on("message", (data, isBinary) => {
      if (isBinary) return;
      let m; try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.type === "start_recording") {
        pcmTimer = setInterval(() => {
          dev.send(Buffer.concat([Buffer.from([0x01]), Buffer.alloc(2048, 3)]));
        }, 30);
      } else if (m.type === "stop_recording") {
        clearInterval(pcmTimer); pcmTimer = null;
      }
    });

    // 4. Browser connects; the device presses the PTT button.
    const br = new WebSocket(`ws://127.0.0.1:${port}/ws/browser?token=${TOKEN}`);
    await new Promise((r) => br.once("open", r));
    await waitFor(br, (m) => m.type === "device_connected");

    dev.send(JSON.stringify({ type: "button", id: "ptt", pressed: true, ts_ms: 1 }));

    const stateOn = await waitFor(br, (m) => m.type === "transcription_state" && m.active === true);
    assert.ok(stateOn, "browser saw transcription_state active:true");

    const final = await waitFor(br, (m) => m.type === "transcript" && m.final === true);
    assert.ok(final, "browser received a committed transcript");
    assert.equal(final.text, "hello world");

    assert.equal(capturedApiKey, "k", "auth header reached the Scribe endpoint");

    // 5. Release: the hold finalizes — the joined text routes to the agent as
    //    one ptt turn, the device gets stop_recording, browser sees state false.
    dev.send(JSON.stringify({ type: "button", id: "ptt", pressed: false, ts_ms: 2 }));
    const stateOff = await waitFor(br, (m) => m.type === "transcription_state" && m.active === false);
    assert.ok(stateOff, "browser saw transcription_state active:false");
    assert.deepEqual(agentRuns, [{ text: "hello world", source: "ptt" }]);

    if (pcmTimer) clearInterval(pcmTimer);
    dev.close();
    br.close();
  } finally {
    wssDevice.close();
    wssBrowser.close();
    await new Promise((r) => server.close(r));
    fakeEl.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
