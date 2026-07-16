// Transcription controller for the "Speech" dashboard widget.
//
// Drives the outbound Scribe session. On start() it acquires the shared
// mic-stream arbiter (as its "transcription" holder) and opens a Scribe session;
// feedPcm() forwards each device PCM frame while active; partial/committed
// transcripts are broadcast to browsers. The WAV recorder is a separate arbiter
// holder, so transcription and recording can now run concurrently.

export function createTranscriber({ bridge, scribeFactory, micStream, onFinalTranscript = null, onCommitObserved = null, shouldFeed = () => true }) {
  let active = false;
  let session = null;
  let commitNext = false;   // latch: force-commit the next frame (endpointer-driven)

  const broadcast = (msg) => bridge.broadcastToBrowsers(msg);

  // Tear down the session + device stream without re-sending stop to the device
  // when it's already gone (sendStop=false on disconnect).
  function cleanup(sendStop) {
    active = false;
    if (session) { try { session.close(); } catch { /* already closed */ } }
    session = null;
    if (sendStop) micStream.release("transcription");
    broadcast({ type: "transcription_state", active: false });
  }

  function start() {
    if (active) return;
    // Acquire the shared device mic stream first; pointless to open Scribe with no audio.
    if (!micStream.acquire("transcription")) {
      broadcast({ type: "transcription_error", error: "device_offline" });
      return;
    }
    active = true;
    try {
      session = scribeFactory({
        callbacks: {
          onPartial: (text) => { if (active) broadcast({ type: "transcript", final: false, text }); },
          onCommitted: (text) => {
            if (!active) return;
            broadcast({ type: "transcript", final: true, text });
            // Route finalized speech into the Sienna agent (push-to-talk → input),
            // independent of any browser UI. A bad consumer must not break STT.
            if (onFinalTranscript && text && text.trim()) {
              console.log(`[transcriber] commit → agent: "${text.slice(0, 60)}"${text.length > 60 ? "…" : ""}`);
              try { onFinalTranscript(text); } catch { /* isolate */ }
            }
            // EVERY commit — including empty ones the guard above filters —
            // is observable, AFTER routing, so the PTT coordinator can treat
            // an empty forced-commit answer as "done" without a timeout.
            if (onCommitObserved) { try { onCommitObserved(text); } catch { /* isolate */ } }
          },
          onError: (kind) => {
            if (!active) return;
            broadcast({ type: "transcription_error", error: kind });
            cleanup(true);
          },
          onClose: () => { if (active) cleanup(true); },
        },
      });
    } catch {
      broadcast({ type: "transcription_error", error: "scribe_init_failed" });
      cleanup(true);
      return;
    }
    broadcast({ type: "transcription_state", active: true });
  }

  function stop() {
    if (!active) return;
    cleanup(true);
  }

  function feedPcm(buf) {
    if (!active || !session || !shouldFeed()) return;   // echo gate: drop mic while she speaks
    const commit = commitNext;
    commitNext = false;
    if (commit) console.log("[transcriber] sent commit:true to scribe — awaiting committed_transcript");
    session.sendPcm(buf, { commit });
  }

  // The endpointer detected end-of-speech: force-commit the buffered utterance by
  // latching the flag onto the next mic frame (the device streams continuously, so
  // the next frame is ~50 ms away). No-op if we're not actively transcribing.
  function commitNextChunk() {
    if (active && session) commitNext = true;
  }

  // Force-commit the buffered utterance NOW. Unlike commitNextChunk this can't
  // wait for "the next mic frame" — on a PTT release the device stream is about
  // to stop, so no further frame is guaranteed. Scribe has no frame-less commit
  // (the flag must ride an input_audio_chunk), so we send 50 ms of synthetic
  // silence carrying commit:true, deliberately bypassing the feedPcm echo gate.
  function commitNow() {
    if (!active || !session) return false;
    console.log("[transcriber] commitNow — forced commit via synthetic silence frame");
    try { session.sendPcm(Buffer.alloc(1600), { commit: true }); } catch { return false; }
    return true;
  }

  // Device vanished mid-session: drop everything but don't try to message the
  // (now absent) device. The composition root will call micStream.reset() globally.
  function handleDeviceDisconnect() {
    if (!active) return;
    cleanup(false);
    broadcast({ type: "transcription_error", error: "device_disconnected" });
  }

  return { start, stop, feedPcm, commitNextChunk, commitNow, handleDeviceDisconnect, isActive: () => active };
}

// Used when no ELEVENLABS_API_KEY is configured: every start request reports
// not_configured; everything else is a no-op so callers never branch.
export function createDisabledTranscriber({ bridge }) {
  return {
    start() {
      bridge.broadcastToBrowsers({ type: "transcription_error", error: "not_configured" });
      bridge.broadcastToBrowsers({ type: "transcription_state", active: false });
    },
    stop() {},
    feedPcm() {},
    commitNextChunk() {},
    commitNow() { return false; },
    handleDeviceDisconnect() {},
    isActive: () => false,
  };
}
