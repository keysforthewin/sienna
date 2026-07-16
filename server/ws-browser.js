import { parseBrowserMessage, buildServerCommand, BinTag } from "./protocol.js";
import { randomUUID } from "node:crypto";

const ACK_TIMEOUT_MS = 5000;

export function attachBrowserWs(wss, bridge, token, recorder, transcriber, micStream, agent = null, volume = null, audioOut = null, getNowPlaying = null) {
  wss.on("connection", (ws, req) => {
    const url = new URL(req.url, "http://x");
    const sentToken = url.searchParams.get("token");
    if (sentToken !== token) {
      try { ws.close(4001, "bad_token"); } catch {}
      return;
    }
    bridge.attachBrowser(ws);

    // Tell this freshly-connected browser the current autonomy state so the
    // toggle survives a page reload. The agent holds it in memory (the source of
    // truth); without this, a reconnecting browser's checkbox defaults to off
    // even though the agent is still autonomous.
    if (agent) {
      try { ws.send(JSON.stringify({ type: "autonomy_state", enabled: agent.getAutonomy() })); } catch {}
    }

    // Tell this browser the current master volume so the Voice-panel slider shows
    // the live value (set by an earlier browser or by Sienna's set_volume tool)
    // rather than its markup default.
    if (volume) {
      try { ws.send(JSON.stringify({ type: "volume", percent: volume.getPercent(), max: volume.maxPercent() })); } catch {}
    }

    // Likewise the live music-pacing slider value + its bounds (server-owned, shared).
    if (audioOut?.getMusicPacingMs) {
      try {
        const b = audioOut.musicPacingBounds();
        ws.send(JSON.stringify({ type: "music_pacing", ms: audioOut.getMusicPacingMs(), min: b.min, max: b.max }));
      } catch {}
    }

    // And the live voice (TTS) pacing slider value + its bounds.
    if (audioOut?.getTtsPacingMs) {
      try {
        const b = audioOut.ttsPacingBounds();
        ws.send(JSON.stringify({ type: "tts_pacing", ms: audioOut.getTtsPacingMs(), min: b.min, max: b.max }));
      } catch {}
    }

    // And the current now-playing state, so a freshly-opened dashboard shows the
    // track that's already on (live changes arrive via the jukebox's broadcast).
    if (getNowPlaying) {
      try {
        const np = getNowPlaying();
        if (np) ws.send(JSON.stringify(np));
      } catch {}
    }

    // Unique token so this browser's listen hold is independent of others'.
    const listenToken = `listen:${randomUUID()}`;

    // Track outstanding refs for ack timeout reporting
    const pendingAcks = new Map(); // ref -> timer

    function startAckTimer(browserRef, serverRef) {
      const t = setTimeout(() => {
        pendingAcks.delete(serverRef);
        try {
          ws.send(JSON.stringify({
            type: "command_error",
            ref: browserRef,
            reason: "ack_timeout",
          }));
        } catch {}
      }, ACK_TIMEOUT_MS);
      pendingAcks.set(serverRef, { browserRef, timer: t });
    }

    // Also listen for acks from the device via the bridge → browsers fanout.
    // We tap by hooking the browser's own send path: the bridge already
    // pushed the ack JSON to us; we just need to clear the timer when we see it.
    const origSend = ws.send.bind(ws);
    ws.send = (payload, ...rest) => {
      if (typeof payload === "string") {
        try {
          const msg = JSON.parse(payload);
          if (msg.type === "ack" && pendingAcks.has(msg.ref)) {
            const { timer } = pendingAcks.get(msg.ref);
            clearTimeout(timer);
            pendingAcks.delete(msg.ref);
          }
        } catch {}
      }
      return origSend(payload, ...rest);
    };

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        // PTT transmit-mute: while the button is held the server sends NO speaker
        // PCM at all — browser-originated audio (Voice-panel Speak, Hold-to-talk)
        // included. Dropped silently (not an error: the stream keeps flowing).
        if (audioOut && audioOut.isMuted && audioOut.isMuted()) return;
        // Browser-originated speaker PCM (Voice-panel Speak, Hold-to-talk). Apply
        // the master volume here so it matches the agent's speak path (audio-out.js).
        const buf = volume ? volume.applyGain(Buffer.from(data)) : Buffer.from(data);
        const tagged = Buffer.concat([Buffer.from([BinTag.PLAYBACK_PCM]), buf]);
        const ok = bridge.sendBinaryToDevice(tagged);
        if (!ok) {
          ws.send(JSON.stringify({ type: "command_error", ref: null, reason: "device_offline" }));
        }
        return;
      }
      let msg;
      try {
        msg = parseBrowserMessage(data.toString("utf8"));
      } catch (e) {
        ws.send(JSON.stringify({ type: "command_error", ref: null, reason: "bad_message", detail: e.message }));
        return;
      }
      const browserRef = msg.ref;
      // Sienna agent commands are consumed server-side (the agent runs here);
      // never forwarded to the device. Without a configured agent they degrade.
      if (msg.type === "agent_input" || msg.type === "set_autonomy") {
        if (!agent) {
          ws.send(JSON.stringify({ type: "command_error", ref: browserRef, reason: "agent_unavailable" }));
          return;
        }
        if (msg.type === "agent_input") {
          agent.run(msg.text, { source: "text" }).catch(() => {});
        } else {
          agent.setAutonomy(msg.enabled);
          bridge.broadcastToBrowsers({ type: "autonomy_state", enabled: msg.enabled });
        }
        ws.send(JSON.stringify({ type: "ack", ref: browserRef, ok: true }));
        return;
      }
      // Master speaker volume: consumed server-side (the gain is applied to
      // outgoing PCM here and in audio-out.js); never forwarded to the device.
      // The volume module's onChange broadcasts the new value to every browser,
      // so all open sliders — including this one — stay in sync.
      if (msg.type === "set_volume") {
        if (volume) volume.setPercent(msg.percent);
        ws.send(JSON.stringify({ type: "ack", ref: browserRef, ok: true }));
        return;
      }
      // Music pacing: server-owned playback knob (ms between frames). audioOut's
      // onMusicPacingChange broadcasts {type:"music_pacing"} to keep sliders in sync.
      if (msg.type === "set_music_pacing") {
        if (audioOut?.setMusicPacingMs) audioOut.setMusicPacingMs(msg.ms);
        ws.send(JSON.stringify({ type: "ack", ref: browserRef, ok: true }));
        return;
      }
      // Voice (TTS) pacing: same as music. onTtsPacingChange broadcasts {type:"tts_pacing"}.
      if (msg.type === "set_tts_pacing") {
        if (audioOut?.setTtsPacingMs) audioOut.setTtsPacingMs(msg.ms);
        ws.send(JSON.stringify({ type: "ack", ref: browserRef, ok: true }));
        return;
      }
      // Listen: pure mic-stream consumer. No device command of its own — the
      // arbiter sends start_recording/stop_recording on the 0→1 / last-release.
      if (msg.type === "start_listening") {
        if (!micStream.acquire(listenToken)) {
          ws.send(JSON.stringify({ type: "command_error", ref: browserRef, reason: "device_offline" }));
          return;
        }
        ws.send(JSON.stringify({ type: "ack", ref: browserRef, ok: true }));
        return;
      }
      if (msg.type === "stop_listening") {
        micStream.release(listenToken);
        ws.send(JSON.stringify({ type: "ack", ref: browserRef, ok: true }));
        return;
      }
      // Record: the WAV recorder is one mic-stream consumer; the arbiter owns the
      // device stream so a concurrent Listen/transcription keeps it alive.
      if (msg.type === "start_recording") {
        // Acquire first: if the device is offline, don't leave the recorder
        // stuck in a recording state with no PCM ever arriving.
        if (!micStream.acquire("record")) {
          ws.send(JSON.stringify({ type: "command_error", ref: browserRef, reason: "device_offline" }));
          return;
        }
        recorder.start();
        ws.send(JSON.stringify({ type: "ack", ref: browserRef, ok: true }));
        return;
      }
      if (msg.type === "stop_recording") {
        micStream.release("record");
        ws.send(JSON.stringify({ type: "ack", ref: browserRef, ok: true }));
        // Wait briefly for the device to flush remaining PCM, then save the WAV.
        setTimeout(async () => {
          try {
            const result = await recorder.stop();
            if (result) {
              bridge.broadcastToBrowsers({
                type: "recording_ready",
                filename: result.filename,
                url: `/api/recordings/${result.filename}`,
                size_bytes: result.sizeBytes,
                duration_ms: result.durationMs,
              });
            }
          } catch (e) {
            bridge.broadcastToBrowsers({
              type: "command_error",
              ref: browserRef,
              reason: "recording_save_failed",
              detail: e.message,
            });
          }
        }, 250);
        return;
      }
      const serverRef = randomUUID();
      let payload;
      try {
        payload = buildServerCommand(msg, serverRef);
      } catch (e) {
        ws.send(JSON.stringify({ type: "command_error", ref: browserRef, reason: "bad_command", detail: e.message }));
        return;
      }
      const ok = bridge.sendToDevice(payload);
      if (!ok) {
        ws.send(JSON.stringify({ type: "command_error", ref: browserRef, reason: "device_offline" }));
        return;
      }
      startAckTimer(browserRef, serverRef);
    });

    ws.on("close", () => {
      micStream.release(listenToken);
      for (const { timer } of pendingAcks.values()) clearTimeout(timer);
      pendingAcks.clear();
    });
  });
}
