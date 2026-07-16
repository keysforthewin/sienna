class DownsamplerProcessor extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    this.targetRate = 16000;
    this.inputRate  = sampleRate;
    this.ratio = this.inputRate / this.targetRate;
    this.acc = 0;
    // Coalesce decimated samples into 1024-sample (~64 ms) frames before
    // posting. Emitting one frame per 128-sample render quantum is ~375
    // frames/s — far more than the device's WebSocketsClient can drain (it is
    // serviced only ~16x/s by the cooperative main loop), which floods the
    // device, kills the socket (1006), and yields no audio. 1024-sample frames
    // (~16 frames/s) match the working WAV-upload path (see audio.js).
    this.FRAME = 1024;
    this.frame = new Int16Array(this.FRAME);
    this.filled = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch0 = input[0];
    let inIdx = this.acc;
    while (inIdx < ch0.length) {
      // Box-average the input samples spanning this output step (a cheap
      // anti-alias low-pass) rather than picking every Nth sample — naive
      // decimation folds the mic's wideband content down as audible grit.
      const start = Math.floor(inIdx);
      let end = Math.floor(inIdx + this.ratio);
      if (end > ch0.length) end = ch0.length;
      let sum = 0, n = 0;
      for (let j = start; j < end; j++) { sum += ch0[j]; n++; }
      let s = n ? sum / n : ch0[start];
      if (s >  1) s =  1; else if (s < -1) s = -1;
      this.frame[this.filled++] = (s * 32767) | 0;
      if (this.filled === this.FRAME) {
        const out = this.frame.slice(0);   // copy; transfer the copy, keep our buffer
        this.port.postMessage(out.buffer, [out.buffer]);
        this.filled = 0;
      }
      inIdx += this.ratio;
    }
    this.acc = inIdx - ch0.length;
    return true;
  }
}
registerProcessor("downsampler", DownsamplerProcessor);
