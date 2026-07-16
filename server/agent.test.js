import { test } from "node:test";
import assert from "node:assert/strict";
import { createSiennaAgent, errorSpokenText } from "./agent.js";

function makeMemory({ ready = true } = {}) {
  const appended = [];
  return {
    appended,
    ready: () => ready,
    getPersonality: async () => null,
    recallRelevant: async () => [],
    recentMessages: async () => [],
    // Reflection-path readers (collectActivity + recentReflections); default empty.
    listRecentMessages: async () => [],
    recentMemories: async () => [],
    listPersonalityVersions: async () => [],
    recentToolCalls: async () => [],
    recentImages: async () => [],
    recentReflections: async () => [],
    appendMessage: async (t) => { appended.push(t); return { id: `id${appended.length}` }; },
  };
}

function makeTools(execImpl) {
  const defCalls = [];
  const execCalls = [];
  return {
    defCalls, execCalls,
    definitions: (mode, autonomy) => { defCalls.push({ mode, autonomy }); return []; },
    execute: async (name, input) => { execCalls.push({ name, input }); return execImpl ? execImpl(name, input) : { content: "ok" }; },
    names: () => [],
  };
}

function makeClient(responses) {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (args) => {
        // snapshot the messages array — the agent mutates it across calls
        calls.push({ ...args, messages: args.messages.slice() });
        const r = responses.shift();
        if (typeof r === "function") return r();
        return r;
      },
    },
  };
}

const collectEmit = () => { const ev = []; const fn = (e) => ev.push(e); fn.ev = ev; return fn; };

// A streaming-capable fake client: messages.stream fires onTextDelta per text block,
// then returns the same {content, stop_reason}. supportsTokenStream marks it as OUR
// token-delta provider (Gemini), so agent.js takes the gapless path.
function makeStreamClient(responses) {
  const calls = [];
  return {
    calls,
    supportsTokenStream: true,
    messages: {
      stream: async (args, { onTextDelta } = {}) => {
        calls.push({ ...args, messages: args.messages.slice(), streamed: true });
        const r = responses.shift();
        const res = typeof r === "function" ? r() : r;
        for (const b of res.content || []) if (b.type === "text" && b.text && onTextDelta) onTextDelta(b.text);
        return res;
      },
      create: async (args) => { calls.push({ ...args, messages: args.messages.slice(), streamed: false }); const r = responses.shift(); return typeof r === "function" ? r() : r; },
    },
  };
}

// A fake audioOut whose speakStream records the controller lifecycle.
function makeAudioOut() {
  const streams = [];
  return {
    streams,
    speakStream: async () => {
      const s = { pushed: [], began: false, ended: false, aborted: false,
        push(t) { this.pushed.push(t); },
        begin() { this.began = true; },
        end: async () => { s.ended = true; return { frames: 1 }; },
        abort() { this.aborted = true; },
      };
      streams.push(s);
      return s;
    },
  };
}

test("full loop: tool_use then final text — executes tool, feeds result, persists, emits", async () => {
  const memory = makeMemory();
  const tools = makeTools(() => ({ content: "rgb set to (255, 0, 0)" }));
  const client = makeClient([
    { content: [{ type: "text", text: "Let me glow red." }, { type: "tool_use", id: "t1", name: "set_rgb", input: { r: 255, g: 0, b: 0 } }], stop_reason: "tool_use" },
    { content: [{ type: "text", text: "There — I'm red now." }], stop_reason: "end_turn" },
  ]);
  const emit = collectEmit();
  const agent = createSiennaAgent({ client, memory, tools, model: "m", emit });

  const out = await agent.run("turn red", { source: "text" });
  assert.equal(out.text, "There — I'm red now.");
  assert.equal(tools.execCalls[0].name, "set_rgb");
  // 2nd model call carries the tool_result
  const second = client.calls[1].messages;
  const toolResultMsg = second[second.length - 1];
  assert.equal(toolResultMsg.content[0].type, "tool_result");
  assert.equal(toolResultMsg.content[0].tool_use_id, "t1");
  // emitted a message + tool events + idle
  assert.ok(emit.ev.some((e) => e.type === "agent_message" && e.text.includes("red now")));
  assert.ok(emit.ev.some((e) => e.type === "agent_tool" && e.name === "set_rgb"));
  assert.ok(emit.ev.some((e) => e.type === "agent_status" && e.state === "idle"));
  // persisted: user input + assistant preamble + final assistant text
  assert.ok(memory.appended.some((t) => t.role === "user" && t.content === "turn red"));
  assert.ok(memory.appended.some((t) => t.role === "assistant" && t.content.includes("red now")));
});

test("reaching the iteration cap wraps up gracefully (closing turn, no error)", async () => {
  const memory = makeMemory();
  const tools = makeTools(); // tools succeed (content "ok")
  const toolResp = () => ({ content: [{ type: "tool_use", id: "x", name: "look", input: {} }], stop_reason: "tool_use" });
  const client = makeClient([
    toolResp(), toolResp(), toolResp(),                                  // 3 tool rounds (cap=3)
    { content: [{ type: "text", text: "I'll stop here." }], stop_reason: "end_turn" }, // wrap-up
  ]);
  const emit = collectEmit();
  const agent = createSiennaAgent({ client, memory, tools, model: "m", maxIterations: 3, emit });
  const out = await agent.run("loop", { source: "text" });
  assert.equal(client.calls.length, 4);              // 3 tool calls + 1 wrap-up
  assert.equal(client.calls[3].tools, undefined);    // wrap-up offered NO tools
  assert.equal(out.text, "I'll stop here.");
  assert.equal(out.stopReason, "end_turn");
  assert.ok(!emit.ev.some((e) => e.type === "agent_error")); // no error for legit work
});

test("runaway guard stops a stuck tool loop (same call erroring repeatedly)", async () => {
  const memory = makeMemory();
  const tools = makeTools(() => ({ content: "device_offline", is_error: true }));
  const toolResp = () => ({ content: [{ type: "tool_use", id: "x", name: "look", input: {} }], stop_reason: "tool_use" });
  const client = makeClient([
    toolResp(), toolResp(), toolResp(),                                  // 3 identical failing rounds (repeat=3)
    { content: [{ type: "text", text: "Something is wrong with my body." }], stop_reason: "end_turn" },
  ]);
  const emit = collectEmit();
  const agent = createSiennaAgent({ client, memory, tools, model: "m", maxIterations: 12, emit });
  const out = await agent.run("loop", { source: "text" });
  assert.equal(client.calls.length, 4);              // 3 failing rounds + wrap-up
  assert.equal(out.stopReason, "tool_stuck");
  assert.ok(emit.ev.some((e) => e.type === "agent_error" && e.reason === "tool_stuck"));
});

test("varied successful tool use is not flagged as stuck and ends naturally", async () => {
  const memory = makeMemory();
  const tools = makeTools(); // succeed
  const client = makeClient([
    { content: [{ type: "tool_use", id: "a", name: "look", input: {} }], stop_reason: "tool_use" },
    { content: [{ type: "tool_use", id: "b", name: "read_light_sensor", input: {} }], stop_reason: "tool_use" },
    { content: [{ type: "text", text: "All good." }], stop_reason: "end_turn" },
  ]);
  const emit = collectEmit();
  const agent = createSiennaAgent({ client, memory, tools, model: "m", maxIterations: 12, emit });
  const out = await agent.run("look around", { source: "text" });
  assert.equal(out.stopReason, "end_turn");
  assert.equal(out.text, "All good.");
  assert.ok(!emit.ev.some((e) => e.type === "agent_error"));
});

test("db unavailable returns early without calling the model", async () => {
  const memory = makeMemory({ ready: false });
  const tools = makeTools();
  const client = makeClient([]);
  const emit = collectEmit();
  const agent = createSiennaAgent({ client, memory, tools, model: "m", emit });
  const out = await agent.run("hi", { source: "text" });
  assert.equal(out.stopReason, "db_unavailable");
  assert.equal(client.calls.length, 0);
  assert.ok(emit.ev.some((e) => e.type === "agent_error" && e.reason === "db_unavailable"));
});

test("model error is reported and ends the run cleanly", async () => {
  const memory = makeMemory();
  const tools = makeTools();
  const client = { messages: { create: async () => { throw new Error("boom"); } } };
  const emit = collectEmit();
  const agent = createSiennaAgent({ client, memory, tools, model: "m", emit });
  const out = await agent.run("hi", { source: "text" });
  assert.equal(out.stopReason, "model_error");
  assert.ok(emit.ev.some((e) => e.type === "agent_error" && e.reason === "model_error"));
});

test("runs are serialized (never interleaved)", async () => {
  const memory = makeMemory();
  const tools = makeTools();
  let concurrent = 0, maxConcurrent = 0;
  const client = {
    messages: {
      create: async () => {
        concurrent += 1; maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 5));
        concurrent -= 1;
        return { content: [{ type: "text", text: "x" }], stop_reason: "end_turn" };
      },
    },
  };
  const agent = createSiennaAgent({ client, memory, tools, model: "m" });
  await Promise.all([agent.run("a", { source: "text" }), agent.run("b", { source: "text" })]);
  assert.equal(maxConcurrent, 1);
});

test("reflection run skips when already busy", async () => {
  const memory = makeMemory();
  const tools = makeTools();
  const client = {
    messages: { create: async () => { await new Promise((r) => setTimeout(r, 10)); return { content: [{ type: "text", text: "x" }], stop_reason: "end_turn" }; } },
  };
  const agent = createSiennaAgent({ client, memory, tools, model: "m" });
  const p1 = agent.run("first", { source: "text" });           // occupies the agent
  const r2 = await agent.run("reflect", { source: "reflection" }); // should skip
  assert.equal(r2.skipped, true);
  await p1;
});

test("reflection gates tools by autonomy; timer fire runs interactive (may speak)", async () => {
  const memory = makeMemory();
  const tools = makeTools();
  const client = makeClient([
    { content: [{ type: "text", text: "quiet" }], stop_reason: "end_turn" },
    { content: [{ type: "text", text: "timer!" }], stop_reason: "end_turn" },
  ]);
  const agent = createSiennaAgent({ client, memory, tools, model: "m" });
  agent.setAutonomy(false);
  await agent.run("ref", { source: "reflection" });
  await agent.onTimerFire({ label: "tea" });
  assert.deepEqual(tools.defCalls[0], { mode: "reflection", autonomy: false });
  assert.equal(tools.defCalls[1].mode, "interactive");
});

test("onActivity fires with the run's source for interactive turns, never for reflection", async () => {
  const memory = makeMemory();
  const tools = makeTools();
  const client = makeClient([
    { content: [{ type: "text", text: "a" }], stop_reason: "end_turn" },
    { content: [{ type: "text", text: "b" }], stop_reason: "end_turn" },
    { content: [{ type: "text", text: "c" }], stop_reason: "end_turn" },
  ]);
  const sources = [];
  const agent = createSiennaAgent({ client, memory, tools, model: "m", onActivity: (s) => sources.push(s) });
  await agent.run("hi", { source: "ptt" });
  await agent.run("yo", { source: "eavesdrop" });
  await agent.run("ref", { source: "reflection" });
  assert.deepEqual(sources, ["ptt", "eavesdrop"]); // source is forwarded; reflection never notifies
});

test("addressed turn she didn't voice is auto-spoken (voice-in → voice-out)", async () => {
  const memory = makeMemory();
  const tools = makeTools();
  const client = makeClient([{ content: [{ type: "text", text: "Hi there." }], stop_reason: "end_turn" }]);
  const agent = createSiennaAgent({ client, memory, tools, model: "m" });
  await agent.run("hello", { source: "ptt" });
  const spoke = tools.execCalls.find((c) => c.name === "speak");
  assert.ok(spoke, "auto-speak should fire for an addressed turn");
  assert.equal(spoke.input.text, "Hi there.");
});

test("a mid-turn speak heads-up does NOT suppress the spoken final reply", async () => {
  // speak is an announcement/heads-up ("one sec, looking…"), not her answer. After
  // it, the turn's final reply is still her voice and must auto-speak (voice-in →
  // voice-out), layered after the heads-up — not cancelled by it.
  const memory = makeMemory();
  const tools = makeTools();
  const client = makeClient([
    { content: [{ type: "tool_use", id: "s1", name: "speak", input: { text: "one sec…" } }], stop_reason: "tool_use" },
    { content: [{ type: "text", text: "ok done" }], stop_reason: "end_turn" },
  ]);
  const agent = createSiennaAgent({ client, memory, tools, model: "m" });
  await agent.run("hello", { source: "text" });
  const spoke = tools.execCalls.filter((c) => c.name === "speak");
  assert.equal(spoke.length, 2, "her heads-up plus the auto-spoken final reply");
  assert.equal(spoke[1].input.text, "ok done", "the final reply is voiced");
});

test("a music tool ends the turn: no extra model round, no reply, no auto-speak", async () => {
  for (const name of ["play_music", "play_youtube", "play_more_like_this", "skip_song"]) {
    const memory = makeMemory();
    const tools = makeTools(() => ({ content: "playing in the background" }));
    const client = makeClient([
      { content: [{ type: "tool_use", id: "p1", name, input: { query: "jazz", url: "u" } }], stop_reason: "tool_use" },
      { content: [{ type: "text", text: "Coming right up." }], stop_reason: "end_turn" }, // must NOT be consumed
    ]);
    const agent = createSiennaAgent({ client, memory, tools, model: "m" });
    const r = await agent.run("play jazz", { source: "ptt" });
    // The tool spoke its own heads-up (or is a control action); the turn ends right
    // there — the model is called exactly once and the closing line never runs.
    assert.equal(client.calls.length, 1, `${name}: exactly one model round`);
    assert.equal(tools.execCalls.filter((c) => c.name === "speak").length, 0,
      `${name}: no auto-speak fallback`);
    assert.equal(tools.execCalls.filter((c) => c.name === name).length, 1, `${name}: ran once`);
    assert.equal(r.stopReason, "ended_after_tool", `${name}: turn ended after the tool`);
  }
});

test("a stop tool ends the turn silently — never a spoken confirmation", async () => {
  for (const name of ["stop_audio", "stop"]) {
    const memory = makeMemory();
    const tools = makeTools(() => ({ content: "stopped" }));
    const client = makeClient([
      { content: [{ type: "text", text: "Okay." }, { type: "tool_use", id: "s1", name, input: {} }], stop_reason: "tool_use" },
      { content: [{ type: "text", text: "All stopped!" }], stop_reason: "end_turn" }, // must NOT be consumed
    ]);
    const agent = createSiennaAgent({ client, memory, tools, model: "m" });
    await agent.run("stop", { source: "ptt" });
    assert.equal(client.calls.length, 1, `${name}: one model round`);
    assert.equal(tools.execCalls.filter((c) => c.name === "speak").length, 0,
      `${name}: a stop is acknowledged by silence, never spoken`);
  }
});

test("an errored turn-ending music tool does NOT end the turn (error surfaces to model)", async () => {
  // Bug: turn-ending tools (e.g. skip_song) used to end the turn even when they
  // returned is_error — the error was silently discarded and she never reacted.
  // After the fix: an errored turn-ending tool falls through to the next model
  // round so she can respond to the failure (e.g. "nothing was playing").
  const memory = makeMemory();
  const tools = makeTools(() => ({ content: "Nothing's playing to skip.", is_error: true }));
  const client = makeClient([
    { content: [{ type: "tool_use", id: "tu1", name: "skip_song", input: {} }], stop_reason: "tool_use" },
    { content: [{ type: "text", text: "Hmm, nothing was playing — want me to start something?" }], stop_reason: "end_turn" },
  ]);
  const agent = createSiennaAgent({ client, memory, tools, model: "m" });
  await agent.run("next song", { source: "ptt" });
  assert.equal(client.calls.length, 2, "a SECOND model round must happen so she can react to the error");
});

test("a successful turn-ending music tool still ends the turn early (no closing round)", async () => {
  // Sanity: the optimistic / success path must be unchanged — no extra round.
  const memory = makeMemory();
  const tools = makeTools(() => ({ content: "Skipped to the next track." }));
  const client = makeClient([
    { content: [{ type: "tool_use", id: "tu1", name: "skip_song", input: {} }], stop_reason: "tool_use" },
    { content: [{ type: "text", text: "Done!" }], stop_reason: "end_turn" }, // must NOT be consumed
  ]);
  const agent = createSiennaAgent({ client, memory, tools, model: "m" });
  const r = await agent.run("next song", { source: "ptt" });
  assert.equal(client.calls.length, 1, "successful turn-ending tool: no closing model round");
  assert.equal(r.stopReason, "ended_after_tool");
});

test("errored play_music falls through to a second model round and voices her reaction", async () => {
  // Bug: play_music/play_youtube unconditionally set spokeThisRun=true BEFORE
  // tools.execute ran, so an errored tool (no results) silenced her follow-up
  // reply — user heard "getting that…" then nothing.
  // Fix: only mark spoke on SUCCESS (post-execute, !is_error guard).
  const memory = makeMemory();
  const tools = makeTools(() => ({ content: "I couldn't find anything for that.", is_error: true }));
  const client = makeClient([
    { content: [{ type: "tool_use", id: "p1", name: "play_music", input: { query: "zzznoresults" } }], stop_reason: "tool_use" },
    { content: [{ type: "text", text: "Sorry, I couldn't find that — want me to try something else?" }], stop_reason: "end_turn" },
  ]);
  const agent = createSiennaAgent({ client, memory, tools, model: "m" });
  await agent.run("play zzznoresults", { source: "ptt" });
  // A second model round must have happened so she can react to the error
  assert.equal(client.calls.length, 2, "a second model round must happen after an errored play_music");
  // Her closing reply must be voiced via auto-speak (spokeThisRun false after the error)
  const spoke = tools.execCalls.find((c) => c.name === "speak");
  assert.ok(spoke, "auto-speak must fire so her error reaction is voiced");
  assert.ok(spoke.input.text.includes("couldn't find"), "the voiced text is her reaction to the error");
});

test("successful play_music still ends turn early and does NOT double-voice (regression guard)", async () => {
  // Sanity: a successful play_music must still mark spokeThisRun (via the
  // post-execute success guard) so the auto-speak fallback does NOT fire over the
  // music; the turn must still end after the tool (endTurnEarly path).
  const memory = makeMemory();
  const tools = makeTools(() => ({ content: "Playing jazz — I'll keep it going until you tell me to stop." }));
  const client = makeClient([
    { content: [{ type: "tool_use", id: "p1", name: "play_music", input: { query: "jazz" } }], stop_reason: "tool_use" },
    { content: [{ type: "text", text: "Enjoy the music!" }], stop_reason: "end_turn" }, // must NOT be consumed
  ]);
  const agent = createSiennaAgent({ client, memory, tools, model: "m" });
  const r = await agent.run("play some jazz", { source: "ptt" });
  assert.equal(client.calls.length, 1, "successful play_music: exactly one model round (turn ends after tool)");
  assert.equal(r.stopReason, "ended_after_tool");
  assert.equal(tools.execCalls.filter((c) => c.name === "speak").length, 0,
    "no auto-speak after successful play_music — music is already playing");
});

test("reflection never auto-speaks (silence by default)", async () => {
  const memory = makeMemory();
  const tools = makeTools();
  const client = makeClient([{ content: [{ type: "text", text: "a private thought" }], stop_reason: "end_turn" }]);
  const agent = createSiennaAgent({ client, memory, tools, model: "m" });
  await agent.run("ref", { source: "reflection" });
  assert.equal(tools.execCalls.filter((c) => c.name === "speak").length, 0);
});

test("reflection input prompt is not persisted, but her reply is", async () => {
  const memory = makeMemory();
  const tools = makeTools();
  const client = makeClient([{ content: [{ type: "text", text: "a thought" }], stop_reason: "end_turn" }]);
  const agent = createSiennaAgent({ client, memory, tools, model: "m" });
  await agent.run("REFLECT BOILERPLATE", { source: "reflection" });
  assert.ok(!memory.appended.some((t) => t.role === "user"));
  assert.ok(memory.appended.some((t) => t.role === "assistant" && t.content === "a thought"));
});

test("interactive runs mark activity; reflection runs do not", async () => {
  const memory = makeMemory();
  const tools = makeTools();
  const client = makeClient([
    { content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" },
    { content: [{ type: "text", text: "reflecting" }], stop_reason: "end_turn" },
  ]);
  const emit = collectEmit();
  let activityCount = 0;
  const agent = createSiennaAgent({ client, memory, tools, model: "m", emit, onActivity: () => { activityCount++; } });
  await agent.run("hello", { source: "text" });
  assert.equal(activityCount, 1);
  await agent.run("reflect now", { source: "reflection" });
  assert.equal(activityCount, 1); // unchanged for reflection
});

test("emits one user + one terminal-assistant sienna_entry; no card for a preamble tool round", async () => {
  const memory = makeMemory();
  const tools = makeTools(() => ({ content: "rgb set" }));
  const client = makeClient([
    { content: [{ type: "text", text: "Let me glow red." }, { type: "tool_use", id: "t1", name: "set_rgb", input: { r: 255, g: 0, b: 0 } }], stop_reason: "tool_use" },
    { content: [{ type: "text", text: "There — I'm red now." }], stop_reason: "end_turn" },
  ]);
  const emit = collectEmit();
  const agent = createSiennaAgent({ client, memory, tools, model: "m", emit });
  await agent.run("turn red", { source: "text" });

  const cards = emit.ev.filter((e) => e.type === "sienna_entry");
  assert.equal(cards.length, 2, "exactly one user card + one terminal assistant card");
  const user = cards.find((c) => c.entry.role === "user");
  const asst = cards.find((c) => c.entry.role === "assistant");
  assert.equal(user.entry.kind, "message");
  assert.equal(user.entry.content, "turn red");
  assert.equal(asst.entry.content, "There — I'm red now.");
  assert.ok(asst.entry.id, "assistant card carries the persisted id");
  // the per-tool-round preamble text must NOT become its own card
  assert.ok(!cards.some((c) => c.entry.content === "Let me glow red."));
});

test("reflection emits an assistant sienna_entry but no user card", async () => {
  const memory = makeMemory();
  const tools = makeTools();
  const client = makeClient([{ content: [{ type: "text", text: "a quiet thought" }], stop_reason: "end_turn" }]);
  const emit = collectEmit();
  const agent = createSiennaAgent({ client, memory, tools, model: "m", emit });
  await agent.run("REFLECT BOILERPLATE", { source: "reflection" });

  const cards = emit.ev.filter((e) => e.type === "sienna_entry");
  assert.equal(cards.length, 1);
  assert.equal(cards[0].entry.role, "assistant");
  assert.equal(cards[0].entry.content, "a quiet thought");
});

test("streaming: a final text turn is spoken via the gapless stream (push→begin→end), no auto-speak", async () => {
  const memory = makeMemory();
  const tools = makeTools();
  const client = makeStreamClient([{ content: [{ type: "text", text: "Hi there." }], stop_reason: "end_turn" }]);
  const audioOut = makeAudioOut();
  const agent = createSiennaAgent({ client, memory, tools, model: "m", audioOut });
  await agent.run("hello", { source: "ptt" });
  assert.equal(client.calls[0].streamed, true, "used the streaming model call");
  assert.equal(audioOut.streams.length, 1);
  const s = audioOut.streams[0];
  assert.deepEqual(s.pushed, ["Hi there."]);
  assert.equal(s.began, true);
  assert.equal(s.ended, true);
  assert.equal(s.aborted, false);
  // spoken via the stream → the speak-tool auto-speak fallback must NOT fire
  assert.equal(tools.execCalls.filter((c) => c.name === "speak").length, 0);
});

test("streaming: a tool-round preamble is aborted and never reaches the device", async () => {
  const memory = makeMemory();
  const tools = makeTools(() => ({ content: "rgb set" }));
  const client = makeStreamClient([
    { content: [{ type: "text", text: "Let me glow red." }, { type: "tool_use", id: "t1", name: "set_rgb", input: { r: 255, g: 0, b: 0 } }], stop_reason: "tool_use" },
    { content: [{ type: "text", text: "There — red now." }], stop_reason: "end_turn" },
  ]);
  const audioOut = makeAudioOut();
  const agent = createSiennaAgent({ client, memory, tools, model: "m", audioOut });
  await agent.run("turn red", { source: "ptt" });
  // two streams opened (one per text iteration); the preamble's is aborted, the final spoken
  const [preamble, final] = audioOut.streams;
  assert.deepEqual(preamble.pushed, ["Let me glow red."]);
  assert.equal(preamble.began, false, "tool-round preamble never starts the device");
  assert.equal(preamble.aborted, true);
  assert.deepEqual(final.pushed, ["There — red now."]);
  assert.equal(final.began, true);
  assert.equal(final.ended, true);
});

test("streaming: a play_music round ends the turn — no second round, no streamed reply", async () => {
  // "play jazz and tell me a joke": play_music self-announces and the music starts;
  // a trailing reply would talk over it and isn't heard until the song ends, so the
  // turn ends right after the tool. The would-be joke round is never consumed and no
  // stream is ever opened (the preamble-less tool round opens none either).
  const memory = makeMemory();
  const tools = makeTools(() => ({ content: "Playing a mix of jazz." }));
  const client = makeStreamClient([
    { content: [{ type: "tool_use", id: "p1", name: "play_music", input: { query: "jazz" } }], stop_reason: "tool_use" },
    { content: [{ type: "text", text: "Here's a joke for you." }], stop_reason: "end_turn" }, // must NOT run
  ]);
  const audioOut = makeAudioOut();
  const agent = createSiennaAgent({ client, memory, tools, model: "m", audioOut });
  await agent.run("play jazz and tell me a joke", { source: "ptt" });
  assert.equal(client.calls.length, 1, "exactly one model round — the joke round never ran");
  assert.equal(audioOut.streams.length, 0, "no streamed reply over the music");
  assert.equal(tools.execCalls.filter((c) => c.name === "speak").length, 0);
});

test("streaming: a pure tool round (no text) opens no stream", async () => {
  const memory = makeMemory();
  const tools = makeTools();
  const client = makeStreamClient([
    { content: [{ type: "tool_use", id: "a", name: "look", input: {} }], stop_reason: "tool_use" },
    { content: [{ type: "text", text: "I see you." }], stop_reason: "end_turn" },
  ]);
  const audioOut = makeAudioOut();
  const agent = createSiennaAgent({ client, memory, tools, model: "m", audioOut });
  await agent.run("what do you see", { source: "ptt" });
  assert.equal(audioOut.streams.length, 1, "only the final text turn opened a stream");
  assert.equal(audioOut.streams[0].began, true);
});

test("streaming: a mid-turn speak heads-up does NOT suppress the gapless final reply", async () => {
  // speak is a heads-up, not her answer (no longer in SELF_SPEAKING_TOOLS), so the
  // loop continues to a closing text round. On the gapless stream path that closing
  // reply IS her voice — it must begin (be voiced), layered after the heads-up, not
  // aborted. (Mirrors the non-streaming test above.)
  const memory = makeMemory();
  const tools = makeTools(() => ({ content: "spoken" }));
  const client = makeStreamClient([
    { content: [{ type: "tool_use", id: "s1", name: "speak", input: { text: "one sec…" } }], stop_reason: "tool_use" },
    { content: [{ type: "text", text: "ok done" }], stop_reason: "end_turn" },
  ]);
  const audioOut = makeAudioOut();
  const agent = createSiennaAgent({ client, memory, tools, model: "m", audioOut });
  await agent.run("say hi", { source: "ptt" });
  // Her explicit heads-up utterance is voiced…
  assert.equal(tools.execCalls.filter((c) => c.name === "speak").length, 1);
  // …and the closing reply streams and begins (voiced), not aborted.
  assert.equal(audioOut.streams.length, 1, "one stream opened for the trailing reply");
  const reply = audioOut.streams[0];
  assert.deepEqual(reply.pushed, ["ok done"]);
  assert.equal(reply.began, true, "the final reply is her voice — it must start the device");
  assert.equal(reply.aborted, false, "the final reply is voiced, not aborted");
  assert.ok(memory.appended.some((t) => t.role === "assistant" && t.content === "ok done"),
    "the closing reply is persisted");
});

test("streaming: reflection never streams (no audioOut.speakStream call)", async () => {
  const memory = makeMemory();
  const tools = makeTools();
  const client = makeStreamClient([{ content: [{ type: "text", text: "a quiet thought" }], stop_reason: "end_turn" }]);
  const audioOut = makeAudioOut();
  const agent = createSiennaAgent({ client, memory, tools, model: "m", audioOut });
  await agent.run("REFLECT", { source: "reflection" });
  assert.equal(audioOut.streams.length, 0);
  assert.equal(client.calls[0].streamed, false, "reflection uses the non-streaming call");
});

test("a failing wrap-up call still ends the run cleanly (never stranded)", async () => {
  const memory = makeMemory();
  const tools = makeTools(); // tools succeed
  const toolResp = () => ({ content: [{ type: "tool_use", id: "x", name: "look", input: {} }], stop_reason: "tool_use" });
  const client = makeClient([
    toolResp(), toolResp(), toolResp(),       // 3 tool rounds (cap=3) → cap reached
    () => { throw new Error("api boom"); },    // the wrap-up call itself fails
  ]);
  const emit = collectEmit();
  const agent = createSiennaAgent({ client, memory, tools, model: "m", maxIterations: 3, emit });
  const out = await agent.run("loop", { source: "text" });
  assert.equal(out.stopReason, "end_turn");  // resolves cleanly even if the wrap-up throws
  assert.ok(emit.ev.some((e) => e.type === "agent_status" && e.state === "idle")); // not left mid-thought
});

// --- autonomy persistence (survives a server restart) ---

function makeSettingsMemory(initial = {}) {
  const settings = { ...initial };
  const setCalls = [];
  return {
    settings, setCalls,
    ready: () => true,
    getPersonality: async () => null,
    recallRelevant: async () => [],
    recentMessages: async () => [],
    appendMessage: async () => ({ id: "x" }),
    getSetting: async (k, fallback) => (k in settings ? settings[k] : fallback),
    setSetting: async (k, v) => { settings[k] = v; setCalls.push({ k, v }); },
  };
}

test("setAutonomy persists the value through memory.setSetting", async () => {
  const memory = makeSettingsMemory();
  const agent = createSiennaAgent({ client: makeClient([]), memory, tools: makeTools(), model: "m" });
  agent.setAutonomy(true);
  await Promise.resolve(); // let the fire-and-forget persist settle
  assert.deepEqual(memory.setCalls.at(-1), { k: "autonomy", v: true });
  assert.equal(memory.settings.autonomy, true);
});

test("restoreAutonomy loads the persisted value into getAutonomy", async () => {
  const memory = makeSettingsMemory({ autonomy: true });
  const agent = createSiennaAgent({ client: makeClient([]), memory, tools: makeTools(), model: "m" });
  assert.equal(agent.getAutonomy(), false); // defaults off before restore
  await agent.restoreAutonomy();
  assert.equal(agent.getAutonomy(), true);
});

test("restoreAutonomy defaults to false when nothing is persisted", async () => {
  const memory = makeSettingsMemory(); // empty store
  const agent = createSiennaAgent({ client: makeClient([]), memory, tools: makeTools(), model: "m" });
  await agent.restoreAutonomy();
  assert.equal(agent.getAutonomy(), false);
});

test("setAutonomy and restoreAutonomy tolerate a memory without a settings store", async () => {
  const memory = makeMemory(); // no getSetting/setSetting
  const agent = createSiennaAgent({ client: makeClient([]), memory, tools: makeTools(), model: "m" });
  agent.setAutonomy(true);            // must not throw
  await agent.restoreAutonomy();      // must not throw
  assert.equal(agent.getAutonomy(), false); // restore couldn't read → stays default off
});

test("reflection injects a random activity sample + past reflections into the user message", async () => {
  const memory = makeMemory();
  // A rich activity pool + past reflections for the reflection path to draw on.
  memory.listRecentMessages = async () => [{ _id: "m1", ts: 100, role: "user", content: "what time is it" }];
  memory.recentMemories = async () => [{ _id: "mem1", ts: 90, text: "I enjoyed the thunderstorm" }];
  memory.listPersonalityVersions = async () => [{ _id: "current", updated_at: 80, version: 3, text: "curious" }];
  memory.recentToolCalls = async () => [{ _id: "t1", tool_id: "tu1", ts: 70, name: "look", summary: "an empty desk" }];
  memory.recentImages = async () => [{ _id: "i1", ts: 60, filename: "a.jpg" }];
  memory.recentReflections = async () => [{ role: "assistant", source: "reflection", content: "earlier I mused about quiet" }];

  const tools = makeTools();
  const client = makeClient([{ content: [{ type: "text", text: "a fresh thought" }], stop_reason: "end_turn" }]);
  const agent = createSiennaAgent({ client, memory, tools, model: "m", rng: () => 0.42 });
  await agent.run("BASE REFLECTION INSTRUCTION", { source: "reflection" });

  const userMsg = client.calls[0].messages[0].content;
  assert.match(userMsg, /BASE REFLECTION INSTRUCTION/);     // base instruction preserved
  assert.match(userMsg, /random, shuffled/i);               // framed as random
  assert.match(userMsg, /thunderstorm|empty desk|what time is it|curious|camera/); // sample content
  assert.match(userMsg, /earlier I mused about quiet/);     // past reflection listed
  assert.match(userMsg, /bindi|blue light|white body lights/i); // self-expression invite
});

test("reflection suppresses the chronological recent-turns block; interactive keeps it", async () => {
  const memory = makeMemory();
  memory.recentMessages = async () => [{ role: "user", content: "earlier chatter", ts: 1, source: "text" }];
  memory.listRecentMessages = async () => [{ _id: "m1", ts: 1, role: "user", content: "earlier chatter" }];

  const tools = makeTools();
  const client = makeClient([
    { content: [{ type: "text", text: "thinking" }], stop_reason: "end_turn" },
    { content: [{ type: "text", text: "replying" }], stop_reason: "end_turn" },
  ]);
  const agent = createSiennaAgent({ client, memory, tools, model: "m", rng: () => 0 });

  await agent.run("ref", { source: "reflection" });
  const reflSystem = JSON.stringify(client.calls[0].system);
  assert.doesNotMatch(reflSystem, /Recent moments/);        // chronological block omitted

  await agent.run("hi", { source: "text" });
  const interactiveSystem = JSON.stringify(client.calls[1].system);
  assert.match(interactiveSystem, /Recent moments/);        // still present for interactive
});

// ---- spoken model errors -------------------------------------------------
// When the model call itself fails (rate limit, auth, outage) she can't compose
// a reply — speak the provider's literal error message instead, in every mode.

const GENAI_429 = '{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details.","status":"RESOURCE_EXHAUSTED"}}';

test("errorSpokenText pulls the human message out of provider error shapes", () => {
  // @google/genai ApiError: e.message IS the JSON error body
  assert.equal(errorSpokenText(new Error(GENAI_429)),
    "You exceeded your current quota, please check your plan and billing details.");
  // Anthropic SDK: status code prefixed before similar JSON
  assert.equal(errorSpokenText(new Error('429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limited."}}')),
    "Rate limited.");
  // the genai stream path DOUBLE-nests: outer error.message is the inner JSON
  // body as a string, whose own message carries quota detail lines after the
  // human sentence (real shape captured from a live 429)
  const inner = JSON.stringify({ error: { code: 429, message: "You exceeded your current quota, please check your plan and billing details.\n* Quota exceeded for metric: generate_requests_per_model_per_day, limit: 10000\nPlease retry in 9h44m.", status: "RESOURCE_EXHAUSTED" } });
  const outer = JSON.stringify({ error: { message: inner, code: 429, status: "Too Many Requests" } });
  assert.equal(errorSpokenText(new Error(outer)),
    "You exceeded your current quota, please check your plan and billing details.");
  // plain errors speak verbatim
  assert.equal(errorSpokenText(new Error("fetch failed")), "fetch failed");
  // junk falls back to something speakable
  assert.equal(errorSpokenText(null), "model error");
});

test("a model error is spoken out loud via audioOut", async () => {
  const memory = makeMemory();
  const tools = makeTools();
  const client = { messages: { create: async () => { throw new Error(GENAI_429); } } };
  const spoken = [];
  const audioOut = { ...makeAudioOut(), speak: async (t) => { spoken.push(t); } };
  const agent = createSiennaAgent({ client, memory, tools, model: "m", audioOut });
  const out = await agent.run("hi", { source: "text" });
  assert.equal(out.stopReason, "model_error");
  assert.deepEqual(spoken, ["You exceeded your current quota, please check your plan and billing details."]);
});

test("a model error during reflection is ALSO spoken (bypasses autonomy gating)", async () => {
  const memory = makeMemory();
  const tools = makeTools();
  const client = { messages: { create: async () => { throw new Error(GENAI_429); } } };
  const spoken = [];
  const audioOut = { ...makeAudioOut(), speak: async (t) => { spoken.push(t); } };
  const agent = createSiennaAgent({ client, memory, tools, model: "m", audioOut });
  const out = await agent.run("quiet moment", { source: "reflection" });
  assert.equal(out.stopReason, "model_error");
  assert.equal(spoken.length, 1);
});

test("a wrap-up model error is spoken too", async () => {
  const memory = makeMemory();
  const tools = makeTools(() => ({ content: "device_offline", is_error: true }));
  const toolResp = () => ({ content: [{ type: "tool_use", id: "x", name: "look", input: {} }], stop_reason: "tool_use" });
  const client = makeClient([
    toolResp(), toolResp(), toolResp(),
    () => { throw new Error(GENAI_429); },        // the wrap-up call fails
  ]);
  const spoken = [];
  const audioOut = { ...makeAudioOut(), speak: async (t) => { spoken.push(t); } };
  const agent = createSiennaAgent({ client, memory, tools, model: "m", audioOut });
  await agent.run("loop", { source: "text" });
  assert.equal(spoken.length, 1);
});

test("a failing speaker never masks the model error", async () => {
  const memory = makeMemory();
  const tools = makeTools();
  const client = { messages: { create: async () => { throw new Error("boom"); } } };
  const audioOut = { ...makeAudioOut(), speak: async () => { throw new Error("tts down"); } };
  const agent = createSiennaAgent({ client, memory, tools, model: "m", audioOut });
  const out = await agent.run("hi", { source: "text" });
  assert.equal(out.stopReason, "model_error");
});

test("getLights / getNowPlaying feed the system prompt's volatile context", async () => {
  const memory = makeMemory();
  const tools = makeTools();
  const client = makeClient([
    { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" },
  ]);
  let seen = null;
  const buildSystem = (args) => { seen = args; return [{ type: "text", text: "sys" }]; };
  const agent = createSiennaAgent({
    client, memory, tools, model: "m", buildSystem,
    getLights: () => "necklace on, blue hat light off, bindi glowing (1, 2, 3)",
    getNowPlaying: () => 'Now playing: "Song" by Artist.',
  });
  await agent.run("hi", { source: "text" });
  assert.equal(seen.lights, "necklace on, blue hat light off, bindi glowing (1, 2, 3)");
  assert.equal(seen.nowPlaying, 'Now playing: "Song" by Artist.');
});

test("getLights / getNowPlaying default to null (lines omitted)", async () => {
  const memory = makeMemory();
  const tools = makeTools();
  const client = makeClient([
    { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" },
  ]);
  let seen = null;
  const buildSystem = (args) => { seen = args; return [{ type: "text", text: "sys" }]; };
  const agent = createSiennaAgent({ client, memory, tools, model: "m", buildSystem });
  await agent.run("hi", { source: "text" });
  assert.equal(seen.lights, null);
  assert.equal(seen.nowPlaying, null);
});

test("evolvePersonality is a no-op when no evolve fn is injected", async () => {
  const agent = createSiennaAgent({ client: makeClient([]), memory: makeMemory(), tools: makeTools(), model: "m" });
  assert.deepEqual(await agent.evolvePersonality(), { skipped: true, reason: "not_configured" });
});

test("evolvePersonality runs the injected evolve and reports busy while in flight", async () => {
  const order = [];
  let resolveEvolve;
  const evolve = () => {
    order.push("evolve-start");
    return new Promise((res) => {
      resolveEvolve = () => { order.push("evolve-end"); res({ evolved: true }); };
    });
  };
  const agent = createSiennaAgent({ client: makeClient([]), memory: makeMemory(), tools: makeTools(), model: "m", evolve });
  const p = agent.evolvePersonality();
  // Give the promise a moment to queue and start executing
  await new Promise((r) => setImmediate(r));
  assert.equal(agent.busy(), true);          // active incremented
  resolveEvolve();
  assert.deepEqual(await p, { evolved: true });
  assert.equal(agent.busy(), false);
  assert.deepEqual(order, ["evolve-start", "evolve-end"]);
});

test("evolvePersonality serializes behind an in-flight run", async () => {
  const order = [];
  const client = makeClient([{ content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" }]);
  const evolve = async () => { order.push("evolve"); return { evolved: true }; };
  const agent = createSiennaAgent({ client, memory: makeMemory(), tools: makeTools(), model: "m", evolve });
  const runP = agent.run("hello", { source: "text" }).then(() => order.push("run-done"));
  const evoP = agent.evolvePersonality();
  await Promise.all([runP, evoP]);
  assert.deepEqual(order, ["run-done", "evolve"]); // evolve waited for the run's turn on the queue
});
