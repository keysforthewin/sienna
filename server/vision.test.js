import { test } from "node:test";
import assert from "node:assert/strict";
import { createVision } from "./vision.js";

// Each create() call consumes the next queued response; records every args.
function makeClient(...textOuts) {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (args) => {
        calls.push(args);
        const t = textOuts.shift();
        return { content: t == null ? [] : [{ type: "text", text: t }] };
      },
    },
  };
}

test("describe builds a base64 image block and runs the analysis prompt", async () => {
  const client = makeClient("a warm room with afternoon light");
  const vision = createVision({ client, model: "gemini-x" });

  const out = await vision.describe(Buffer.from("JPEGDATA"), { question: "what do you see?" });
  assert.equal(out, "a warm room with afternoon light");

  const args = client.calls[0];
  assert.equal(args.model, "gemini-x");
  const img = args.messages[0].content[0];
  assert.equal(img.type, "image");
  assert.equal(img.source.media_type, "image/jpeg");
  assert.equal(img.source.data, Buffer.from("JPEGDATA").toString("base64"));
  assert.equal(args.messages[0].content[1].text, "what do you see?");
  // system is the dedicated factual-analysis prompt, NOT her persona — the
  // reflection happens in the main agent loop where her identity lives.
  assert.match(args.system[0].text, /FACTUAL analysis/);
  assert.ok(!/Bharati/.test(args.system[0].text), "persona must not leak into the analysis call");
});

test("describe uses a default analysis prompt when no question is given", async () => {
  const client = makeClient("something");
  const vision = createVision({ client, model: "m" });
  await vision.describe(Buffer.from("x"));
  assert.match(client.calls[0].messages[0].content[1].text, /Analyze what the camera sees/);
});

test("an empty first response is retried once and the retry's text returned", async () => {
  const client = makeClient(null, "second time lucky");
  const vision = createVision({ client, model: "m" });
  const out = await vision.describe(Buffer.from("x"));
  assert.equal(out, "second time lucky");
  assert.equal(client.calls.length, 2);
});

test("describe throws when the model returns no text twice", async () => {
  const client = makeClient(null, null);
  const vision = createVision({ client, model: "m" });
  await assert.rejects(() => vision.describe(Buffer.from("x")), /no text/);
  assert.equal(client.calls.length, 2);
});
