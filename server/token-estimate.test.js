import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens } from "./token-estimate.js";

test("estimateTokens is ceil(chars/4)", () => {
  assert.equal(estimateTokens("abcd"), 1);     // 4/4
  assert.equal(estimateTokens("abcde"), 2);    // ceil(5/4)
  assert.equal(estimateTokens("a".repeat(400)), 100);
});

test("estimateTokens treats empty/nullish as 0", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens(undefined), 0);
});
