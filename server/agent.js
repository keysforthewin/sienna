// The Sienna agent — a Gemini tool-use loop that is her ongoing mind.
//
// run(input, {source}) drives one turn: assemble her layered prompt, call the
// model with her tools, execute any tool_use blocks, feed results back, and loop
// until she stops (or hits the iteration/time guard). Every input — dashboard
// text, a push-to-talk transcript, a reflection tick, a fired timer — enters
// here. Runs are serialized through a mutex so they never interleave (and so
// device-RPC stays single-flight); reflection ticks skip rather than queue when
// she's already busy. Progress is streamed to the dashboard via emit().

import { buildSystemPrompt } from "./prompt.js";
import { toCard } from "./sienna-cards.js";
import { collectActivity, sampleActivity, renderCard, buildReflectionPrompt } from "./reflection-context.js";
import { randomUUID } from "node:crypto";

function truncate(s, n) { const str = String(s ?? ""); return str.length > n ? str.slice(0, n - 1) + "…" : str; }

// The human-readable message inside an LLM-provider error, for speaking aloud.
// @google/genai's ApiError stringifies the whole HTTP error body into e.message
// ({"error":{"code":429,"message":"You exceeded your current quota…","status":…}});
// Anthropic's SDK prefixes a status code before similar JSON. Pull error.message
// out of the JSON when present; otherwise speak the raw message verbatim.
// The genai stream path double-nests (the outer error.message is itself the
// inner JSON body as a string), so unwrapping iterates until no JSON remains.
export function errorSpokenText(e, cap = 300) {
  let text = String(e?.message || e || "model error");
  for (let depth = 0; depth < 4; depth++) {
    const start = text.indexOf("{");
    if (start === -1) break;
    let m;
    try {
      const body = JSON.parse(text.slice(start));
      m = body?.error?.message || body?.message;
    } catch { break; /* not JSON — speak it verbatim */ }
    if (typeof m !== "string" || !m || m === text) break;
    text = m;
  }
  // The Gemini 429 packs quota metrics + retry hints after the sentence on
  // separate lines — speak only the human first line.
  text = (text.split("\n")[0] || "").trim() || "model error";
  return truncate(text, cap);
}

// Tools that emit their own spoken output. Marking them spoken suppresses the
// post-loop auto-speak fallback so a final-text turn after a play_music round is
// NOT re-spoken OVER the music the tool just started. (The play tools speak a
// quick "getting that…" heads-up the instant they run — see tools.js.)
//
// `speak` is deliberately NOT here: it's an announcement/heads-up tool (a quick
// "one sec, looking…" before a slow action, or her self-started voice in a quiet
// moment), not how she answers someone. Her answer is the reply she ends the turn
// with, and that reply must still be voiced even after a mid-turn heads-up — so a
// `speak` call no longer cancels the spoken final reply. The play tools stay,
// because their music WOULD be talked over by a trailing reply.
const SELF_SPEAKING_TOOLS = new Set(["play_music", "play_youtube"]);

// Tools that END the turn the instant they run — no further model round, no
// reply, no auto-speak. Music tools speak their own quick heads-up and then the
// music plays; a trailing reply would talk over it and isn't heard until the
// song ends. Stop tools must be silent too: a stop is acknowledged by the
// silence, never a spoken confirmation. The pending tool_result is discarded —
// the turn is simply over.
const TURN_ENDING_TOOLS = new Set([
  "play_music", "play_youtube", "play_more_like_this", "skip_song", "stop_audio", "stop",
]);

export function createSiennaAgent({
  client,
  memory,
  tools,
  model,
  audioOut = null,           // her speaker pipeline; enables gapless streamed replies
  evolve = null,             // personality evolution pipeline
  buildSystem = buildSystemPrompt,
  maxTokens = 1024,
  maxIterations = 12,
  maxToolRepeat = 3,
  onActivity = () => {},
  historyTurns = 12,
  recallLimit = 3,
  reflectionSampleSize = 20,   // random activity cards fed into a reflection
  reflectionPoolSize = 100,    // window of newest activity the sample is drawn from
  reflectionHistory = 5,       // past reflections shown so she doesn't repeat them
  rng = Math.random,           // entropy source for the reflection shuffle (DI for tests)
  runTimeoutMs = 60000,
  emit = () => {},
  log = () => {},
  now = () => new Date(),
  clock = () => Date.now(),
  refGen = randomUUID,
  getWeather = () => null,
  getLights = () => null,      // current LED state line for the "Right now" block
  getNowPlaying = () => null,  // jukebox now-playing line (already prefixed), or null
}) {
  let autonomy = false;
  let active = 0;            // runs in flight or queued
  let queue = Promise.resolve();
  let lastThoughtAt = null;  // clock() ms of the previous run, for "time since last thought"

  // Autonomy persists across restarts: write-through to memory (fire-and-forget;
  // the toggle never blocks on a DB round-trip) so restoreAutonomy() can bring it
  // back on boot. The `?.` keeps test fakes / settings-less memories working —
  // they simply don't persist.
  const setAutonomy = (v) => {
    autonomy = !!v;
    Promise.resolve(memory.setSetting?.("autonomy", autonomy)).catch(() => {});
  };
  const getAutonomy = () => autonomy;
  // Load the persisted autonomy into RAM (called once at startup, before any
  // browser can toggle it). Directly sets the flag — no re-write of what we read.
  const restoreAutonomy = async () => {
    try { autonomy = !!(await memory.getSetting?.("autonomy", false)); } catch { /* leave default */ }
  };
  const busy = () => active > 0;

  // Voice a model failure: when the LLM call itself dies (rate limit, auth,
  // outage) she can't compose a reply, so speak the provider's literal error
  // message through the speaker — in EVERY mode, reflection included (an
  // unattended failure should still be heard), which is why this goes straight
  // to audioOut rather than the autonomy-gated speak tool. Awaited best-effort:
  // TTS trouble must never mask the original error.
  const speakModelError = async (e) => {
    if (typeof audioOut?.speak !== "function") return;
    try { await audioOut.speak(errorSpokenText(e)); }
    catch (se) { log(`error speech failed: ${se?.message}`); }
  };

  async function runInner(input, source) {
    // reflection runs gate speech by the autonomy toggle; everything else
    // (text / ptt / a deliberately-set timer firing) may speak.
    const mode = source === "reflection" ? "reflection" : "interactive";

    if (!memory.ready()) {
      emit({ type: "agent_error", reason: "db_unavailable" });
      return { text: "", stopReason: "db_unavailable" };
    }

    const runId = refGen();
    emit({ type: "agent_status", state: "thinking", source });
    // Gapless streamed reply: only for spoken (interactive) turns, on a client that
    // exposes OUR token-delta stream (Gemini), with a speaker pipeline that streams.
    const streamEligible = mode === "interactive" && client.supportsTokenStream === true && typeof audioOut?.speakStream === "function";
    log(`run source=${source} mode=${mode} model=${model} stream=${streamEligible}`);

    // A persisted message turn → a live card for the dashboard's Activity/Messages
    // tabs. Emitted only for the user turn and the TERMINAL assistant text (never
    // the per-tool-round preamble persists), so cards stay 1:1 with what reads as
    // a "turn" — distinct from agent_message, which only drives the status line.
    const emitMessageCard = (role, content, persisted, spoken) =>
      emit({ type: "sienna_entry", entry: toCard("message", { _id: persisted?.id, ts: now(), role, content, source, spoken }) });

    // Persist a completed tool invocation to the audit log (fire-and-forget; a DB
    // hiccup must never break a run). Keyed by the agent's tool-use id so the live
    // ephemeral dashboard card and this persisted record share one card id. `?.`
    // keeps test fakes / older memories working — they simply don't persist.
    const recordTool = (id, name, input, result) =>
      Promise.resolve(memory.appendToolCall?.({
        tool_id: id, name, input, source,
        summary: String(result.content ?? ""), is_error: !!result.is_error,
      })).catch(() => {});

    const personality = await memory.getPersonality();
    const recent = await memory.recentMessages(historyTurns);

    // The user message and the prompt's recent-turns block both depend on mode.
    // Reflection draws a DIFFERENT random slice of her past each tick (so she
    // stops reflecting on the same well-worn recent thoughts): a shuffled sample
    // of her activity replaces the chronological recent block, and recall runs
    // against that sample so the recalled memories vary with it too.
    let userContent = input;
    let recentForPrompt = recent;
    let recallText = input;
    if (source === "reflection") {
      const pool = await collectActivity({ memory, limit: reflectionPoolSize });
      const sample = sampleActivity(pool, reflectionSampleSize, rng);
      const pastReflections = await memory.recentReflections(reflectionHistory);
      userContent = buildReflectionPrompt({ base: input, sample, pastReflections, rng });
      recentForPrompt = [];                                  // sample replaces the chronological block
      recallText = sample.map(renderCard).join(" ") || input;
    }

    const recalled = await memory.recallRelevant(recallText, recallLimit);
    const nowMs = clock();
    const sinceLastThoughtMs = lastThoughtAt == null ? null : nowMs - lastThoughtAt;
    lastThoughtAt = nowMs;
    const system = buildSystem({
      personality,
      memories: recalled,
      recentTurns: recentForPrompt,
      now: now(),
      sinceLastThoughtMs,
      weather: getWeather(),
      lights: getLights(),
      nowPlaying: getNowPlaying(),
    });

    // The boilerplate reflection prompt isn't worth persisting; her replies are.
    if (source !== "reflection") {
      const persisted = await memory.appendMessage({ role: "user", content: input, source, ref: runId });
      emitMessageCard("user", input, persisted);
    }

    const messages = [{ role: "user", content: userContent }];
    let finalText = "";
    let stopReason = "end_turn";
    let spokeThisRun = false;
    const startedAt = clock();

    let capReached = false;
    let stuck = false;
    let lastSig = null;
    let sameErrorStreak = 0;

    for (let i = 0; i < maxIterations; i++) {
      if (clock() - startedAt > runTimeoutMs) { emit({ type: "agent_error", reason: "timeout" }); stopReason = "timeout"; break; }

      // Per-iteration streamed-TTS state. The stream is opened lazily on the first
      // text delta (so pure tool rounds never open a socket) and synthesizes DURING
      // generation; the device speaker is held (deferDeviceStart) until we know this
      // turn is the spoken final answer — a tool round's preamble must never leak out.
      let streamP = null;           // speakStream() promise, or null if no text streamed
      const onTextDelta = streamEligible
        ? (d) => {
            emit({ type: "agent_token", text: d, source });
            if (!streamP) streamP = audioOut.speakStream({ deferDeviceStart: true });
            streamP.then((s) => { if (s) s.push(d); });   // .then order is FIFO → in order
          }
        : null;

      let res;
      const callStart = clock();
      try {
        const params = {
          model,
          max_tokens: maxTokens,
          system,
          tools: tools.definitions(mode, autonomy),
          messages,
        };
        res = streamEligible
          ? await client.messages.stream(params, { onTextDelta })
          : await client.messages.create(params);
      } catch (e) {
        if (streamP) streamP.then((s) => s && s.abort());   // tear down a half-open stream
        emit({ type: "agent_error", reason: "model_error", detail: e?.message });
        log(`model error: ${e?.stack?.split("\n")[0] || e?.message}`);
        await speakModelError(e);
        stopReason = "model_error";
        break;
      }

      messages.push({ role: "assistant", content: res.content });

      const textJoined = (res.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
      if (textJoined) {
        finalText = textJoined;
        emit({ type: "agent_message", text: textJoined, source });
      }

      const toolUses = (res.content || []).filter((b) => b.type === "tool_use");
      log(`model call #${i} latency=${clock() - callStart}ms stop=${res.stop_reason} textLen=${textJoined.length} tools=${toolUses.length}`);

      // Resolve the streamed-TTS controller (null if no text was streamed / not eligible).
      const stream = streamP ? await streamP : null;

      if (res.stop_reason !== "tool_use" || toolUses.length === 0) {
        stopReason = res.stop_reason || "end_turn";
        // Speak the final answer gaplessly: begin() releases the pre-synthesized audio
        // to the device, then we persist while it drains, then await the tail. BUT if a
        // self-speaking tool (a play tool that started music) already voiced this turn,
        // the closing text would talk OVER that audio — consume it silently (abort the
        // pre-synthesized render so no frame reaches the device) instead. (A mid-turn
        // `speak` heads-up does NOT set this — her final reply is still her voice.)
        // Mirrors the !spokeThisRun guard on the non-streaming auto-speak fallback below.
        // One `willSpeak` value keeps begin()/end() and the persisted `spoken` flag in lock-step.
        const willSpeak = !!(stream && textJoined && !spokeThisRun);
        if (willSpeak) { stream.begin(); spokeThisRun = true; }
        else if (stream) stream.abort();
        if (textJoined) {
          const persisted = await memory.appendMessage({ role: "assistant", content: textJoined, source, spoken: spokeThisRun, ref: runId });
          emitMessageCard("assistant", textJoined, persisted, spokeThisRun);
        }
        if (willSpeak) await stream.end();
        break;
      }

      // Tool round: this turn is NOT the spoken answer — discard any synthesized
      // preamble before a single frame reaches the device.
      if (stream) stream.abort();

      // Persist the assistant's preamble text (if any) for this tool round.
      if (textJoined) await memory.appendMessage({ role: "assistant", content: textJoined, source, spoken: false, ref: runId });

      const toolResults = [];
      let endTurnEarly = false;
      for (const tu of toolUses) {
        emit({ type: "agent_tool", id: tu.id, name: tu.name, input: tu.input });
        const toolStart = clock();
        const result = await tools.execute(tu.name, tu.input);
        log(`tool ${tu.name} latency=${clock() - toolStart}ms -> ${truncate(result.content, 80)}${result.is_error ? " (ERROR)" : ""}`);
        emit({ type: "agent_tool_result", id: tu.id, summary: String(result.content ?? ""), is_error: !!result.is_error });
        recordTool(tu.id, tu.name, tu.input, result);
        toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: result.content, ...(result.is_error ? { is_error: true } : {}) });
        // Music/stop tools end the turn here — see TURN_ENDING_TOOLS — but ONLY on
        // success. An errored music/stop tool (nothing playing, no results) must
        // reach the next model round so she can react instead of failing silently.
        // Mark spoken so the auto-speak fallback never fires for a tool with no reply.
        if (TURN_ENDING_TOOLS.has(tu.name) && !result.is_error) { endTurnEarly = true; spokeThisRun = true; }
        // Self-speaking tools (play_music / play_youtube) announce their own heads-up
        // and then the music plays, so a trailing reply would talk over it — suppress
        // it by marking spoke. But ONLY on success: an errored play tool must leave
        // spokeThisRun false so the follow-up model round's reply is still voiced
        // (e.g. "couldn't find that — want me to try something else?").
        if (SELF_SPEAKING_TOOLS.has(tu.name) && !result.is_error) spokeThisRun = true;
      }
      messages.push({ role: "user", content: toolResults });

      // A music/stop tool ran: the turn is over. Skip the closing model round and
      // any spoken reply entirely.
      if (endTurnEarly) { stopReason = "ended_after_tool"; break; }

      // Conservative runaway guard: only the SAME tool batch failing identically,
      // over and over (e.g. a device that went offline), counts as stuck. Varied
      // or successful calls reset the streak and never trip it.
      const sig = JSON.stringify(toolUses.map((t) => [t.name, t.input]));
      const allErrored = toolResults.every((r) => r.is_error);
      // identical, all-errored tool rounds in a row (this one included);
      // maxToolRepeat in a row ⇒ stuck.
      sameErrorStreak = allErrored ? (sig === lastSig ? sameErrorStreak + 1 : 1) : 0;
      lastSig = sig;
      if (sameErrorStreak >= maxToolRepeat) { stuck = true; break; }

      if (i === maxIterations - 1) { capReached = true; }
    }

    // Graceful wrap-up: if we stopped with a tool round's results still pending
    // (cap reached, or stuck), give her one tool-less turn to close from those
    // results instead of being cut off mid-thought. A legitimate cap-reach is
    // NOT an error; a genuine stuck loop is.
    if (capReached || stuck) {
      try {
        const res = await client.messages.create({
          model,
          max_tokens: maxTokens,
          system,
          messages,
        });
        const textJoined = (res.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
        if (textJoined) {
          finalText = textJoined;
          emit({ type: "agent_message", text: textJoined, source });
          const persisted = await memory.appendMessage({ role: "assistant", content: textJoined, source, spoken: spokeThisRun, ref: runId });
          emitMessageCard("assistant", textJoined, persisted, spokeThisRun);
        }
      } catch (e) {
        emit({ type: "agent_error", reason: "model_error", detail: e?.message });
        await speakModelError(e);
      }
      if (stuck) {
        stopReason = "tool_stuck";
        emit({ type: "agent_error", reason: "tool_stuck", detail: lastSig });
      } else {
        stopReason = "end_turn";
        log(`reached iteration cap (${maxIterations}); wrapped up`);
      }
    }

    // Addressed → answer out loud. If an interactive turn (text / ptt / a fired
    // timer) ended with a reply she didn't voice herself, speak it so being
    // spoken to never gets a silent answer. Best-effort: no-ops without TTS or a
    // device. Reflection stays silent unless she chose to speak.
    if (mode === "interactive" && !spokeThisRun && finalText) {
      const text = finalText.slice(0, 1500);
      const id = `auto-${runId}`;
      emit({ type: "agent_tool", id, name: "speak", input: { text } });
      const r = await tools.execute("speak", { text });
      emit({ type: "agent_tool_result", id, summary: String(r.content ?? ""), is_error: !!r.is_error });
      recordTool(id, "speak", { text }, r);
    }

    log(`run done stop=${stopReason} spoke=${spokeThisRun} textLen=${finalText.length}`);
    emit({ type: "agent_status", state: "idle", source });
    return { text: finalText, stopReason };
  }

  function run(input, { source = "text" } = {}) {
    if (active > 0 && source === "reflection") {
      return Promise.resolve({ skipped: true, text: "" });
    }
    if (source !== "reflection") onActivity(source);
    active += 1;
    const p = queue.then(() => runInner(input, source));
    queue = p.then(() => {}, () => {}); // keep the chain alive past failures
    p.finally(() => { active -= 1; });
    return p;
  }

  // A device timer fired: wake her so she can react (speech allowed — she set it).
  function onTimerFire({ label } = {}) {
    return run(`Your timer "${label || "(unlabeled)"}" just went off.`, { source: "timer" });
  }

  // Fold recent experience into her personality, serialized on the SAME queue as
  // run() so it never interleaves with a turn or device RPC and never races a
  // concurrent update_personality tool call. No-op when no pipeline is wired.
  function evolvePersonality() {
    if (typeof evolve !== "function") return Promise.resolve({ skipped: true, reason: "not_configured" });
    active += 1;
    const p = queue.then(() => evolve());
    queue = p.then(() => {}, () => {});   // keep the chain alive past failures
    p.finally(() => { active -= 1; });
    return p;
  }

  return { run, onTimerFire, evolvePersonality, setAutonomy, getAutonomy, restoreAutonomy, busy };
}
