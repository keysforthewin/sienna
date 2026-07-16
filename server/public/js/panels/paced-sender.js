// Bounded, steady-paced FIFO sender for continuous (live) PCM streaming —
// the browser side of "Hold to talk" (mic → device speaker).
//
// Unlike streamPcm (audio-stream.js), which await-paces a FINITE clip, the live
// mic is open-ended. The worklet posts frames in bursts (main-thread jank
// batches its `onmessage` callbacks), and with no latency bound a continuous
// over-supply piles up in the device's kernel TCP buffer — playback lags
// further and further behind (sounds slow) and keeps draining after release.
//
// This sender fixes both: a metronome drains at most ONE frame per tick (the
// non-bursty cadence streamPcm relies on), and the queue drops the OLDEST frame
// when full so end-to-end latency stays bounded — release stops audio almost
// immediately, and live talk favors recent speech over completeness.
//
// Pure + dependency-injected so it unit-tests under `node --test` with a fake
// scheduler and a captured `send` — no WebSocket, no AudioContext, no DOM.
//
//   scheduler(fn, ms) -> handle ; clearScheduler(handle)
// (inject setInterval/clearInterval in production).
export function createPacedSender({
  send,
  scheduler = setInterval,
  clearScheduler = clearInterval,
  intervalMs = 64,   // one tick per worklet frame (1024 / 16000 ≈ 64 ms)
  maxQueue = 3,      // ~192 ms cap; drop-oldest beyond this
} = {}) {
  const queue = [];
  let handle = null;

  function tick() {
    if (!handle) return;          // a stray fire after stop() is a no-op
    if (queue.length) send(queue.shift());
  }

  return {
    // Push one frame. Drops the oldest if the cap is reached; returns false when
    // a drop happened (the caller may surface "lagging" without coupling to the DOM).
    enqueue(frame) {
      let dropped = false;
      while (queue.length >= maxQueue) { queue.shift(); dropped = true; }
      queue.push(frame);
      return !dropped;
    },
    // Arm the metronome. Idempotent. Sends nothing synchronously — the first
    // frame goes out on the first tick.
    start() {
      if (handle) return;
      handle = scheduler(tick, intervalMs);
    },
    // Stop the metronome and discard anything still queued. Idempotent.
    stop() {
      if (handle) { clearScheduler(handle); handle = null; }
      queue.length = 0;
    },
    size() { return queue.length; },
  };
}
