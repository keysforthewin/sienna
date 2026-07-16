import { test } from "node:test";
import assert from "node:assert/strict";
import { createSentenceChunker } from "./sentence-chunker.js";

// Drain a sequence of deltas through the chunker, returning every emitted chunk
// (push results then the end() flush) in order.
function run(chunker, deltas) {
  const out = [];
  for (const d of deltas) out.push(...chunker.push(d));
  out.push(...chunker.end());
  return out;
}

test("a sentence under firstChars is not emitted until end()", () => {
  const c = createSentenceChunker({ firstChars: 60, targetChars: 200 });
  assert.deepEqual(c.push("Hello there."), []);
  assert.deepEqual(c.end(), ["Hello there."]);
});

test("emits a small first chunk at the first boundary at/past firstChars", () => {
  const c = createSentenceChunker({ firstChars: 60, targetChars: 200 });
  const first = c.push(
    "This is the first sentence and it is reasonably long enough now. More text follows here.",
  );
  assert.deepEqual(first, ["This is the first sentence and it is reasonably long enough now."]);
  assert.deepEqual(c.end(), ["More text follows here."]);
});

test("coalesces short sentences toward the threshold (first chunk uses firstChars)", () => {
  const c = createSentenceChunker({ firstChars: 10, targetChars: 20 });
  // "Hi. Bye. Yo." reaches 10 chars at the "Yo." boundary → first chunk.
  assert.deepEqual(c.push("Hi. Bye. Yo. Sup. Hey."), ["Hi. Bye. Yo."]);
  assert.deepEqual(c.end(), ["Sup. Hey."]);
});

test("first chunk uses firstChars, later chunks use targetChars", () => {
  const c = createSentenceChunker({ firstChars: 5, targetChars: 30 });
  // First boundary past 5 chars is "Cd." → first chunk "Ab. Cd.". The remainder
  // never reaches targetChars (30), so it coalesces and flushes on end().
  assert.deepEqual(c.push("Ab. Cd. Ef. Gh. Ij. Kl. Mn. Op."), ["Ab. Cd."]);
  assert.deepEqual(c.end(), ["Ef. Gh. Ij. Kl. Mn. Op."]);
});

test("does not split a decimal number", () => {
  const c = createSentenceChunker({ firstChars: 1, targetChars: 1 });
  assert.deepEqual(c.push("It cost 3.14 dollars. Yes."), ["It cost 3.14 dollars."]);
  assert.deepEqual(c.end(), ["Yes."]);
});

test("does not split on lone initials", () => {
  const c = createSentenceChunker({ firstChars: 1, targetChars: 1 });
  assert.deepEqual(c.push("J. R. R. Tolkien wrote books. Yes."), ["J. R. R. Tolkien wrote books."]);
  assert.deepEqual(c.end(), ["Yes."]);
});

test("? and ! are sentence boundaries", () => {
  const c = createSentenceChunker({ firstChars: 1, targetChars: 1 });
  assert.deepEqual(c.push("Really? Yes! Done."), ["Really?", "Yes!"]);
  assert.deepEqual(c.end(), ["Done."]);
});

test("a newline forces a boundary even with no terminating punctuation", () => {
  const c = createSentenceChunker({ firstChars: 1, targetChars: 1 });
  assert.deepEqual(c.push("Line one\nLine two."), ["Line one"]);
  assert.deepEqual(c.end(), ["Line two."]);
});

test("end() flushes a trailing fragment that has no terminator", () => {
  const c = createSentenceChunker({ firstChars: 60, targetChars: 200 });
  assert.deepEqual(c.push("No terminator here"), []);
  assert.deepEqual(c.end(), ["No terminator here"]);
});

test("end() on empty/whitespace-only input returns nothing", () => {
  const c = createSentenceChunker({ firstChars: 60, targetChars: 200 });
  assert.deepEqual(c.push("   "), []);
  assert.deepEqual(c.end(), []);
  const c2 = createSentenceChunker();
  assert.deepEqual(c2.end(), []);
});

test("reassembles words split across deltas", () => {
  const c = createSentenceChunker({ firstChars: 1, targetChars: 100 });
  const chunks = run(c, ["Hel", "lo wor", "ld. Next on", "e here."]);
  assert.deepEqual(chunks, ["Hello world.", "Next one here."]);
});

test("a terminator at the very end of the buffer is held until the next char confirms it", () => {
  const c = createSentenceChunker({ firstChars: 1, targetChars: 1 });
  // The period is the last char so far — not yet confirmed as a boundary.
  assert.deepEqual(c.push("Wait."), []);
  // The following space confirms it; the next sentence starts accumulating.
  assert.deepEqual(c.push(" Go."), ["Wait."]);
  assert.deepEqual(c.end(), ["Go."]);
});
