import { test } from "node:test";
import assert from "node:assert/strict";
import { createVolume } from "./volume.js";

// Build an int16-LE PCM buffer from sample values.
function pcm(...samples) {
  const b = Buffer.allocUnsafe(samples.length * 2);
  samples.forEach((s, i) => b.writeInt16LE(s, i * 2));
  return b;
}
function samples(buf) {
  const out = [];
  for (let i = 0; i + 1 < buf.length; i += 2) out.push(buf.readInt16LE(i));
  return out;
}

test("defaults to 100% unity gain and passes PCM through untouched (no copy)", () => {
  const v = createVolume();
  assert.equal(v.getPercent(), 100);
  const input = pcm(100, -200, 300);
  const out = v.applyGain(input);
  assert.equal(out, input, "unity returns the same Buffer reference");
});

test("applyGain scales int16 samples by the percentage", () => {
  const v = createVolume({ initialPercent: 200 });
  assert.deepEqual(samples(v.applyGain(pcm(100, -200, 0, 50))), [200, -400, 0, 100]);
});

test("applyGain hard-clips at the int16 rails instead of wrapping", () => {
  const v = createVolume({ initialPercent: 400 });
  // 20000*4 and -20000*4 would overflow int16; must clamp, not wrap.
  assert.deepEqual(samples(v.applyGain(pcm(20000, -20000, 8191))), [32767, -32768, 32764]);
});

test("setPercent clamps to [0, max] and rounds", () => {
  const v = createVolume({ maxPercent: 400 });
  assert.equal(v.setPercent(250), 250);
  assert.equal(v.setPercent(-10), 0);
  assert.equal(v.setPercent(99999), 400);
  assert.equal(v.setPercent(150.6), 151);
});

test("maxPercent caps the configurable ceiling and the initial value", () => {
  const v = createVolume({ initialPercent: 999, maxPercent: 250 });
  assert.equal(v.maxPercent(), 250);
  assert.equal(v.getPercent(), 250);
  assert.equal(v.setPercent(300), 250); // can't exceed the configured max
});

test("onChange fires only on an actual change, with the new value", () => {
  const seen = [];
  const v = createVolume({ initialPercent: 100, onChange: (p) => seen.push(p) });
  v.setPercent(150);
  v.setPercent(150); // no-op — must not re-fire
  v.setPercent(80);
  assert.deepEqual(seen, [150, 80]);
});

test("0% mutes (all samples become silence)", () => {
  const v = createVolume({ initialPercent: 0 });
  assert.deepEqual(samples(v.applyGain(pcm(12345, -6789, 100))), [0, 0, 0]);
});

test("a non-finite percent is ignored (keeps the current value)", () => {
  const v = createVolume({ initialPercent: 120 });
  assert.equal(v.setPercent("nonsense"), 120);
  assert.equal(v.setPercent(NaN), 120);
});
