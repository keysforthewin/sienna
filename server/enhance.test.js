import { test } from "node:test";
import assert from "node:assert/strict";
import { createEnhancer } from "./enhance.js";

test("enhance forwards the text and returns the tagged result", async () => {
  let captured = null;
  const fakeClient = {
    messages: {
      create: async (params) => {
        captured = params;
        return { content: [{ type: "text", text: "[excited] we did it!" }] };
      },
    },
  };
  const enhancer = createEnhancer({ client: fakeClient });

  const out = await enhancer.enhance("we did it!");

  assert.equal(out, "[excited] we did it!");
  assert.equal(captured.messages[0].content, "we did it!");
  // System prompt is a plain string (the Gemini adapter flattens it); no Anthropic
  // cache_control / thinking params.
  assert.equal(typeof captured.system, "string");
  assert.ok(captured.system.includes("audio tags"));
  assert.equal(captured.thinking, undefined);
});

test("enhance throws when the model returns no text", async () => {
  const fakeClient = { messages: { create: async () => ({ content: [] }) } };
  const enhancer = createEnhancer({ client: fakeClient });

  await assert.rejects(() => enhancer.enhance("hi"), /no text/);
});

test("createEnhancer requires a client", () => {
  assert.throws(() => createEnhancer({}), /client is required/);
});
