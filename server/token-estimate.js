// Cheap, dependency-free token estimate. The personality size gate only needs to
// be roughly right, so the standard ~4-chars-per-token heuristic is enough — no
// provider round-trip. Shared by memory.js (the cap) and personality-evolution.js
// (the gate) so both measure size the same way.
export function estimateTokens(text) {
  return Math.ceil(String(text ?? "").length / 4);
}
