// Live mic loopback (browser mic → device speaker). The "Hold to talk" button
// lives in the audio panel (built by initAudioPanel); this just wires its
// press/release to mic capture, so it must run after the audio panel inits.
import { createPacedSender } from "/js/panels/paced-sender.js";

export function initLoopback(client) {
  const btn = document.getElementById("ptt");
  const status = document.getElementById("ptt-status");
  if (!btn || !status) return;
  let active = false;
  let audioCtx = null, mediaStream = null, sourceNode = null, workletNode = null, sender = null;

  async function startTalking() {
    if (active) return;
    active = true;
    status.textContent = "requesting mic…";
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, sampleRate: 48000, echoCancellation: true },
      });
      audioCtx = new AudioContext();
      await audioCtx.audioWorklet.addModule("/js/panels/audio-worklet.js");
      sourceNode  = audioCtx.createMediaStreamSource(mediaStream);
      workletNode = new AudioWorkletNode(audioCtx, "downsampler");
      // Pace + bound the worklet's frames: the device drains ~16 frames/s, so a
      // steady one-frame-per-tick send (not the worklet's bursty onmessage) keeps
      // it from flooding, and dropping old frames when behind bounds the latency
      // so release stops the audio almost immediately.
      sender = createPacedSender({ send: (buf) => client.sendBinary(buf) });
      sender.start();
      workletNode.port.onmessage = (ev) => { sender.enqueue(ev.data); };
      sourceNode.connect(workletNode);
      client.send({ type: "play_audio_start", sample_rate: 16000, bits: 16, channels: 1 });
      status.textContent = "streaming…";
    } catch (e) {
      status.textContent = `error: ${e.message}`;
      active = false;
    }
  }

  function stopTalking() {
    if (!active) return;
    active = false;
    status.textContent = "";
    try { sender?.stop(); } catch {}
    // Abort + flush the device DMA (not the graceful play_audio_end) so the live
    // stream cuts off promptly on release instead of draining a buffered tail.
    client.send({ type: "stop_audio" });
    try { workletNode?.disconnect(); } catch {}
    try { sourceNode?.disconnect(); } catch {}
    try { mediaStream?.getTracks().forEach(t => t.stop()); } catch {}
    try { audioCtx?.close(); } catch {}
    audioCtx = null; mediaStream = null; sourceNode = null; workletNode = null; sender = null;
  }

  btn.addEventListener("pointerdown", startTalking);
  btn.addEventListener("pointerup",   stopTalking);
  btn.addEventListener("pointerleave",stopTalking);
}
