// Shared browser→device audio helpers, used by the WAV-upload panel (audio.js)
// and the Speak panel (tts.js). Single source of truth for the device's
// playback protocol and the resample-to-16k-mono step.

// Stream a 16 kHz mono Int16Array to the device using the playback protocol the
// firmware expects: play_audio_start → 1024-sample binary chunks → play_audio_end.
//
// The device drains ~16 WS frames/s, so frames must be large (1024 samples ≈
// 64 ms) and paced (~50–60 ms apart); sending faster floods the device and
// kills the socket. The slice MUST be copied with its byteOffset — `slice.buffer`
// alone is the whole backing ArrayBuffer, which would blast the entire clip in
// one frame.
export async function streamPcm(client, int16, { chunk = 1024, pacingMs = 60 } = {}) {
  client.send({ type: "play_audio_start", sample_rate: 16000, bits: 16, channels: 1 });
  for (let i = 0; i < int16.length; i += chunk) {
    const slice = int16.subarray(i, Math.min(i + chunk, int16.length));
    client.sendBinary(slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength));
    await new Promise((r) => setTimeout(r, pacingMs));
  }
  client.send({ type: "play_audio_end" });
}

// Decode a WebAudio AudioBuffer down to a mono Int16Array at targetRate, via
// linear interpolation. Handles any input sample rate / channel count.
export function downmixAndResample(buffer, targetRate) {
  const channels = buffer.numberOfChannels;
  const inLen = buffer.length;
  const inRate = buffer.sampleRate;
  const ratio = inRate / targetRate;
  const outLen = Math.floor(inLen / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const idx = i * ratio;
    const i0 = Math.floor(idx);
    const i1 = Math.min(inLen - 1, i0 + 1);
    const frac = idx - i0;
    let sample = 0;
    for (let c = 0; c < channels; c++) {
      const data = buffer.getChannelData(c);
      sample += data[i0] * (1 - frac) + data[i1] * frac;
    }
    sample /= channels;
    if (sample > 1) sample = 1; if (sample < -1) sample = -1;
    out[i] = (sample * 32767) | 0;
  }
  return out;
}
