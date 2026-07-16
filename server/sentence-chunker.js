// Pure, streaming sentence chunker for the gapless TTS reply path. Feed it the
// LLM's text deltas; it returns sentence-ish chunks to synthesize as they form.
//
// Goal: a SMALL first chunk (fast first audio) then coalesce toward a larger
// target size (eleven_v3 is prosodically shaky on tiny fragments). Boundaries are
// `.` `!` `?` and newline. A `.`/`!`/`?` counts only when followed by whitespace —
// so it can't fire on the last char of a delta (we wait for the next char to
// confirm) and a decimal like `3.14` (dot followed by a digit) never splits. One
// extra guard keeps lone initials (`J.`) from splitting. No NLP, no dictionary.

const isSpace = (ch) => ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v";
const isUpper = (ch) => ch >= "A" && ch <= "Z";

export function createSentenceChunker({ firstChars = 60, targetChars = 200 } = {}) {
  let buf = "";
  let firstEmitted = false;

  // End index (exclusive) of the first confirmed boundary at/past `threshold`, or
  // null if none yet (coalesce + wait for more text).
  function findCut(threshold) {
    for (let i = 0; i < buf.length; i++) {
      const ch = buf[i];
      let boundary = false;
      if (ch === "\n") {
        boundary = true; // a newline always breaks (even as the last char)
      } else if ((ch === "." || ch === "!" || ch === "?") && isSpace(buf[i + 1])) {
        boundary = true;
        // Lone initial: <start|space> <UPPER> "." — don't split "J. R. R.".
        if (ch === "." && isUpper(buf[i - 1]) && (i === 1 || isSpace(buf[i - 2]))) boundary = false;
      }
      if (boundary && i + 1 >= threshold) return i + 1;
    }
    return null;
  }

  function push(delta) {
    buf += delta;
    const out = [];
    for (;;) {
      const cut = findCut(firstEmitted ? targetChars : firstChars);
      if (cut == null) break;
      const chunk = buf.slice(0, cut).trim();
      buf = buf.slice(cut).replace(/^\s+/, "");
      if (chunk) { out.push(chunk); firstEmitted = true; }
    }
    return out;
  }

  function end() {
    const rest = buf.trim();
    buf = "";
    firstEmitted = false;
    return rest ? [rest] : [];
  }

  return { push, end };
}
