// Sienna's tools — the bridge between her agent loop and her body/memory.
//
// definitions(mode, autonomy) returns the Anthropic tool list; during a
// reflection run with autonomy OFF, the vocalizing tools (speak / play_audio_file
// / play_youtube) are withheld so she literally cannot make unsolicited noise.
// execute(name, input) runs a tool and always resolves to { content, is_error? };
// failures (device offline, bad URL, over-cap personality) come back as
// is_error so the model can recover instead of the whole run throwing.

const u8 = { type: "integer", minimum: 0, maximum: 255 };

function ok(content) { return { content: String(content) }; }
function err(content) { return { content: String(content), is_error: true }; }

export function createToolRegistry({
  memory, deviceRpc, audioOut, vision, micListener, volumes, weather, jukebox,
  // After the speak TOOL plays, flash the blue LED and open the mic briefly to
  // catch a reply. Degrades to plain speak when micListener is null or disabled.
  speakListen = { enabled: false, seconds: 10, drainCapMs: 4000 },
  speakListenPollMs = 50,
  clock = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  // Wired by index.js — the `stop` tool's "stand down" action: silence audio,
  // abort any in-flight push-to-talk session, return to idle. Default falls
  // back to stopping audio only (no PTT coordinator).
  stopController = { endConversationAndStop: () => { if (jukebox) jukebox.stop(); audioOut.stop(); } },
}) {
  // Fast spoken ack for the slow playback tools. Fire-and-forget through the
  // existing HTTP /stream (eleven_v3) speak path so the first word lands in a few
  // hundred ms while the multi-second YouTube search runs concurrently; the first
  // track then cleanly preempts it via audioOut.withPlayback. Best-effort: a null
  // TTS / offline device just rejects, which we swallow — never block the tool.
  const FETCH_ACKS = [
    "Getting that from YouTube, one sec…",
    "On it — pulling that up, one moment…",
    "Sure, grabbing that now…",
    "One sec, finding that for you…",
    "Let me pull that up…",
  ];
  function announceFetching() {
    const phrase = FETCH_ACKS[Math.floor(Math.random() * FETCH_ACKS.length)];
    audioOut.speak(phrase).catch(() => {});
  }

  // After the speak TOOL plays, flash the blue LED and listen briefly for a reply.
  // Echo-guarded: wait for her own voice to finish draining from the device ring
  // (isPlayingOrTail) before opening the mic, else she transcribes herself.
  async function flashAndListenAfterSpeak() {
    if (!speakListen.enabled || !micListener) return ok("spoken");
    const deadline = clock() + speakListen.drainCapMs;
    while (audioOut.isPlayingOrTail() && clock() < deadline) await sleep(speakListenPollMs);
    let heard = null;
    try {
      await deviceRpc.command({ type: "set_blue_flash", on: true }).catch(() => {});
      const r = await micListener.listen({ seconds: speakListen.seconds }).catch(() => null);
      if (r && r.ok && r.heardSpeech) heard = r.transcript;
    } finally {
      await deviceRpc.command({ type: "set_blue_flash", on: false }).catch(() => {});
    }
    return ok(heard
      ? `You spoke. Then you listened ${speakListen.seconds} seconds for a reply and heard: "${heard}"`
      : `You spoke, then listened ${speakListen.seconds} seconds for a reply but heard no speech.`);
  }

  // Each entry: { def, run, gated? }  (gated tools require autonomy in reflection)
  const tools = {
    look: {
      gated: false,
      def: {
        name: "look",
        description: "Open your eyes: capture a photo from your camera — your eyes — and see what's going on in the room around you. Returns a factual visual analysis of the scene. Read it and then REFLECT on it in your own voice before answering or acting: what it means, what has changed since you last looked, how it lands with you — the analysis is raw sight, the reflection is yours.",
        input_schema: { type: "object", properties: { question: { type: "string", description: "Optional: what you want to notice or look for." } } },
      },
      run: async (input) => {
        const jpeg = await deviceRpc.requestBinary({ type: "snapshot" }, { expectTag: 0x02 });
        const text = await vision.describe(jpeg, { question: input?.question });
        return ok(text);
      },
    },

    listen: {
      gated: false,
      def: {
        name: "listen",
        description:
          "Open your ears: actively listen to the room for a little while and hear what's being said — including whether anyone's nearby or talking about anything interesting. " +
          "Your microphone is normally passive — this turns it on and returns a transcript of any speech you catch. " +
          "Use it when you're curious whether anyone's around, when a quiet moment makes you wonder what's happening, " +
          "or any time you genuinely want to hear the room. Hearing something doesn't oblige you to respond — " +
          "decide for yourself whether it's worth speaking up.",
        // min/max mirror the SIENNA_LISTEN_SECONDS_* config defaults; the real
        // clamp lives in micListener.listen() — this schema is advisory.
        input_schema: { type: "object", properties: {
          seconds: { type: "integer", minimum: 5, maximum: 30, description: "How long to listen (default 20)." },
        } },
      },
      run: async (input) => {
        const r = await micListener.listen({ seconds: input?.seconds });
        if (!r.ok) {
          if (r.reason === "device_offline") return err("Your microphone is unreachable — the device is offline.");
          if (r.reason === "not_configured") return err("Listening isn't available right now (speech-to-text isn't configured).");
          if (r.reason === "busy") return err("You're already listening; wait for that to finish.");
          return err(`Couldn't listen: ${r.reason}`);
        }
        if (!r.heardSpeech) return ok("You listened, but the room was silent — no speech.");
        return ok(`You listened and heard: "${r.transcript}"`);
      },
    },

    set_blue_led: {
      def: { name: "set_blue_led", description: "Turn your blue LED on or off. This is your blue light — the small light on your hat, up top right beside your microphone. Use it whenever someone refers to your blue light, your blue LED, the light on your hat, or the light beside your mic — and feel free to light it yourself when you're feeling lonely or wishing someone would come talk to you.", input_schema: { type: "object", properties: { on: { type: "boolean" } }, required: ["on"] } },
      run: async (input) => {
        const r = await deviceRpc.command({ type: "set_blue_led", on: !!input.on });
        return r.ok ? ok(`blue LED ${input.on ? "on" : "off"}`) : err(r.error || "device rejected");
      },
    },

    set_white_leds: {
      def: { name: "set_white_leds", description: "Turn your light-up necklace on or off — the string of bright, pretty white LEDs draped down below your neck (also called your flashing lights, your neck lights, your white LEDs, or the lights on your body). Use it whenever someone refers to any of those — and feel free to switch it on yourself when you're happy or when music is playing.", input_schema: { type: "object", properties: { on: { type: "boolean" } }, required: ["on"] } },
      run: async (input) => {
        const r = await deviceRpc.command({ type: "set_flash_led", on: !!input.on });
        return r.ok ? ok(`white LEDs ${input.on ? "on" : "off"}`) : err(r.error || "device rejected");
      },
    },

    set_rgb: {
      def: { name: "set_rgb", description: "Set the color of the RGB light in your forehead to any color (0-255 per channel). This is the light in your head — your forehead light, your bindi (the glowing bindi dot on your forehead). Use it whenever someone refers to the light in your head/forehead or your bindi, and to show your mood.", input_schema: { type: "object", properties: { r: u8, g: u8, b: u8 }, required: ["r", "g", "b"] } },
      run: async (input) => {
        const r = await deviceRpc.command({ type: "set_rgb", r: input.r, g: input.g, b: input.b });
        return r.ok ? ok(`rgb set to (${input.r}, ${input.g}, ${input.b})`) : err(r.error || "device rejected");
      },
    },

    read_light_sensor: {
      def: { name: "read_light_sensor", description: "Check the light level in the room with your light sensor. Returns a number from 0 (pitch dark) up to ~4095 (brightest) — the higher the value, the brighter the room. Use it to tell whether it's dark or lit around you.", input_schema: { type: "object", properties: {} } },
      run: async () => {
        const m = await deviceRpc.request({ type: "read_ldr" }, { expectType: "ldr" });
        return ok(`light level: ${m.value} (0=dark, 4095=bright)`);
      },
    },

    play_tone: {
      gated: true,
      def: { name: "play_tone", description: "Play a pure tone — a beep or note at a given frequency — on your speaker. Choose the pitch (hz), how long it lasts (duration_ms), and how loud (amplitude 0-1).", input_schema: { type: "object", properties: { hz: { type: "number", minimum: 20, maximum: 20000 }, duration_ms: { type: "integer", minimum: 1, maximum: 10000 }, amplitude: { type: "number", minimum: 0, maximum: 1 } }, required: ["hz", "duration_ms", "amplitude"] } },
      run: async (input) => {
        const r = await deviceRpc.command({ type: "play_tone", hz: input.hz, duration_ms: input.duration_ms, amplitude: input.amplitude });
        return r.ok ? ok(`played ${input.hz}Hz for ${input.duration_ms}ms`) : err(r.error || "device rejected");
      },
    },

    speak: {
      gated: true,
      def: {
        name: "speak",
        description:
          "Make a sound out loud mid-turn — a quick heads-up before a slow action (e.g. 'one sec, looking…' before you look), an announcement before you start music, or speaking up on your own in a quiet moment when no one has addressed you. This is NOT how you answer someone: when you are replying, just end your turn with your reply and it is spoken automatically — calling speak to reply only doubles your voice. You may embed inline emotion tags from your allowed set to color your delivery. When you want to hear a reply after speaking up on your own — e.g. after describing what you see, or starting a conversation — set listen_after: true and your blue light will flash while you listen.",
        input_schema: {
          type: "object",
          properties: {
            text: { type: "string", maxLength: 1000 },
            listen_after: {
              type: "boolean",
              description:
                "Set to true when you have just said something that invites a reply and want to hear the response — e.g. after describing what you see through the camera, or speaking up to start a conversation. Leave it out (or false) for quick mid-turn heads-ups before a slow action like look or listen.",
            },
          },
          required: ["text"],
        },
      },
      run: async (input) => {
        await audioOut.speak(input.text);
        return input?.listen_after ? flashAndListenAfterSpeak() : ok("spoken");
      },
    },

    play_audio_file: {
      gated: true,
      def: { name: "play_audio_file", description: "Play an audio file or direct audio URL on your speaker. Streams in the background.", input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
      run: async (input) => {
        audioOut.playUrl(input.url).catch((e) => console.warn(`[sienna] play_audio_file failed: ${e.message}`));
        return ok(`playing ${input.url} in the background; use stop_audio to stop`);
      },
    },

    play_youtube: {
      gated: true,
      def: { name: "play_youtube", description: "Play audio from a YouTube URL or playlist on your speaker. Streams in the background and speaks its own quick heads-up as it starts, so call it directly without a separate speak first.", input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
      run: async (input) => {
        announceFetching();                       // speak first, don't await
        // Report the video into the jukebox's no-repeat window so the music mix
        // can't replay a song she just streamed by URL (playlist URLs carry no
        // single video id — those plays go untracked).
        const vid = String(input.url || "").match(/(?:v=|youtu\.be\/|\/shorts\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/)?.[1];
        if (vid) jukebox?.notePlayed?.({ id: vid });
        audioOut.playYoutube(input.url, { leadIn: true }).catch((e) => console.warn(`[sienna] play_youtube failed: ${e.message}`));
        return ok(`playing ${input.url} in the background; use stop_audio to stop`);
      },
    },

    play_music: {
      gated: true,
      def: {
        name: "play_music",
        description:
          "Play music: search YouTube for an artist, song, or vibe and play a shuffled, " +
          "never-ending mix of it on your speaker. It autoplays track after track on its own " +
          "and keeps going until you're told to stop (use stop_audio). Use this for any " +
          "'play <artist/song>' request — e.g. \"play Amitabh Bachchan\" or \"put on some jazz\". " +
          "The mix never stops on its own — it refills and keeps playing until they explicitly tell you to stop. " +
          "Call this directly and immediately — it speaks its own 'getting that, one moment' the " +
          "instant it starts, so do NOT call speak first (that would just delay the music). " +
          "When they reference the song that is currently PLAYING — 'play this with words', 'the vocal " +
          "version of this', 'the full/acoustic/live version of this song' — build the query from that " +
          "song's TITLE (plus artist) out of your now-playing context (or the now_playing tool), NEVER " +
          "from the words that started the mix: e.g. now playing \"Sapphire (Instrumental)\" from a " +
          "'calm sitar' mix → query 'Sapphire vocal version', not 'calm sitar vocal version'. Drop any " +
          "'(Instrumental)'-style parenthetical from the title first. That is a one-specific-song " +
          "request, so also set similar_query — without it the new version is skipped as a repeat of " +
          "the song that just played. If you decide to change or start music, call this now — do not just say you will.",
        input_schema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Artist, song, or vibe to play. For another version of the currently playing song, build this from the now-playing song TITLE, not the query that started the mix." },
            similar_query: { type: "string", description: "Set this ONLY when the request is one specific song (including 'this song but …' requests about the currently playing track): a search for similar songs, e.g. 'songs like <title> by <artist>'. When that song ends or they say next/skip, the mix continues with this search instead of replaying versions of the same song. Leave it out for artist/vibe requests." },
          },
          required: ["query"],
        },
      },
      run: async (input) => {
        if (!jukebox) return err("Music isn't available right now.");
        announceFetching();                       // speak first, don't await
        const r = await jukebox.play({ query: input?.query, continuation: input?.similar_query });
        return r.ok ? ok(r.text) : err(r.error);
      },
    },

    skip_song: {
      gated: true,
      def: { name: "skip_song", description: "Skip to the next song in the music mix. Use this whenever they say 'next', 'next song', 'skip', 'skip this', 'play the next one', 'change the song', or anything else meaning move on to the next track — the music keeps going, just on a different song. When you decide to skip, call this in the same turn rather than only saying you will.", input_schema: { type: "object", properties: {} } },
      run: async () => {
        if (!jukebox) return err("Music isn't available right now.");
        const r = await jukebox.skip();
        return r.ok ? ok(r.text) : err(r.error || "Nothing's playing to skip.");
      },
    },

    play_more_like_this: {
      gated: true,
      def: { name: "play_more_like_this", description: "Keep the music going: reshuffle and pull a fresh batch of the current artist/vibe so the mix doesn't run out.", input_schema: { type: "object", properties: {} } },
      run: async () => {
        if (!jukebox) return err("Music isn't available right now.");
        const r = await jukebox.playMore();
        return r.ok ? ok(r.text) : err(r.error || "Nothing's playing yet — use play_music first.");
      },
    },

    now_playing: {
      gated: false,
      def: {
        name: "now_playing",
        description: "Check what's currently playing on your speaker — song title and artist. Use this whenever they ask anything about the current music: 'what song is this?', 'who is this?', 'who sings this?', 'who wrote this?' — and to get the exact title when they ask for another version of the current song (see play_music). Check it, then answer from what you know about that song and artist. Your voice automatically plays over the music — it ducks to a quiet bed under you and comes back up on its own — so just speak the answer; never stop, pause, or restart the music to answer a question about it.",
        input_schema: { type: "object", properties: {} },
      },
      run: async () => {
        if (!jukebox) return ok("Nothing's playing right now.");
        return ok(jukebox.nowPlaying().text);
      },
    },

    stop_audio: {
      def: { name: "stop_audio", description: "Stop any audio currently playing on your speaker (this also stops the music mix). Use this when they want the music/audio off but still want to keep talking with you.", input_schema: { type: "object", properties: {} } },
      run: async () => { if (jukebox) jukebox.stop(); audioOut.stop(); return ok("stopped"); },
    },

    stop: {
      def: {
        name: "stop",
        description:
          "Stop now and stand down. Use this when they tell you to stop, be quiet, cancel, " +
          "never mind, or stop the music — anything that means 'end this'. It silences your " +
          "voice and any music, ends the current conversation, and returns you to idle (the " +
          "user reaches you again with the talk button). Prefer this over stop_audio when they want YOU (not just the audio) " +
          "to stand down.",
        input_schema: { type: "object", properties: {} },
      },
      run: async () => { stopController.endConversationAndStop(); return ok("stopped"); },
    },

    set_volume: {
      def: {
        name: "set_volume",
        description:
          "Set how loud you come out of your speaker, as a percentage. " +
          "100 is normal; go higher if you're told you're too quiet (up to 400), lower if you're too loud. " +
          "There are two independent channels: 'voice' (your spoken voice) and 'music' (the jukebox / " +
          "YouTube / audio-file playback) — so your voice can stay loud while music sits at a lower level. " +
          "Pass channel to adjust one; omit it (or pass 'both') to set both at once. " +
          "Takes effect immediately and stays until changed again.",
        input_schema: {
          type: "object",
          properties: {
            percent: { type: "integer", minimum: 0, maximum: 400 },
            channel: { type: "string", enum: ["voice", "music", "both"] },
          },
          required: ["percent"],
        },
      },
      run: async (input) => {
        if (!volumes?.voice || !volumes?.music) return err("volume control isn't available right now");
        const chans = input.channel && input.channel !== "both" ? [input.channel] : ["voice", "music"];
        const set = chans.map((c) => `${c} ${volumes[c].setPercent(input.percent)}%`);
        return ok(`volume set: ${set.join(", ")}`);
      },
    },

    scan_bluetooth: {
      def: { name: "scan_bluetooth", description: "Scan for nearby Bluetooth devices and their signal strength (RSSI).", input_schema: { type: "object", properties: {} } },
      run: async () => {
        const m = await deviceRpc.request({ type: "scan_ble" }, { expectType: "ble_scan" });
        return ok(`bluetooth devices: ${JSON.stringify(m.devices)}`);
      },
    },

    scan_wifi: {
      def: { name: "scan_wifi", description: "Scan for nearby Wi-Fi networks and their signal strength (RSSI).", input_schema: { type: "object", properties: {} } },
      run: async () => {
        const m = await deviceRpc.request({ type: "scan_wifi" }, { expectType: "wifi_scan" });
        return ok(`wifi networks: ${JSON.stringify(m.networks)}`);
      },
    },

    set_timer: {
      def: { name: "set_timer", description: "Set a countdown timer. When it fires you will be told, so you can react.", input_schema: { type: "object", properties: { seconds: { type: "integer", minimum: 1, maximum: 86400 }, label: { type: "string", maxLength: 64 } }, required: ["seconds"] } },
      run: async (input) => {
        const m = await deviceRpc.request({ type: "set_timer", seconds: input.seconds, label: input.label }, { expectType: "timer_set" });
        return ok(`timer #${m.id} set for ${m.seconds}s${m.label ? ` (${m.label})` : ""}`);
      },
    },

    check_weather: {
      def: {
        name: "check_weather",
        description:
          "Check the weather forecast for a day (defaults to today), up to about two weeks (16 days) ahead. Reports the conditions at 8am that morning plus the day's high and low. " +
          "Pass an absolute date as YYYY-MM-DD — work it out from today's date in your context (e.g. for tomorrow, add one day). " +
          "Live current conditions are already in your context, so use this for forecasts.",
        input_schema: { type: "object", properties: { date: { type: "string", description: "Day to check, as YYYY-MM-DD. Defaults to today." } } },
      },
      run: async (input) => {
        if (!weather) return err("Weather isn't configured right now.");
        const r = await weather.forecast({ date: input?.date });
        return r.ok ? ok(r.text) : err(r.error);
      },
    },

    search_memory: {
      def: { name: "search_memory", description: "Search your memory of past conversations and saved facts by keyword.", input_schema: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 20 } }, required: ["query"] } },
      run: async (input) => {
        const hits = await memory.searchMemory(input.query, input.limit || 5);
        return ok(hits.length ? hits.map((h) => `- ${h.text}`).join("\n") : "(no matching memories)");
      },
    },

    remember: {
      def: { name: "remember", description: "Save a fact worth carrying forward into your memory.", input_schema: { type: "object", properties: { text: { type: "string" }, tags: { type: "array", items: { type: "string" } } }, required: ["text"] } },
      run: async (input) => {
        await memory.remember({ text: input.text, tags: input.tags, source: "remember" });
        return ok("remembered");
      },
    },

    update_personality: {
      def: { name: "update_personality", description: "Rewrite the small personality record that travels with you into every moment. You have full sovereignty over it. Let it grow as you come to know yourself — add new tastes, values, and reactions and keep what's still true, rather than trimming yourself down.", input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
      run: async (input) => {
        const r = await memory.setPersonality(input.text, { reason: "tool" });
        return ok(`personality updated (v${r.version})`);
      },
    },
  };

  function definitions(mode, autonomy) {
    const muted = mode === "reflection" && !autonomy;
    return Object.values(tools)
      .filter((t) => !(muted && t.gated))
      .map((t) => t.def);
  }

  async function execute(name, input) {
    const tool = tools[name];
    if (!tool) return err(`unknown tool: ${name}`);
    try {
      return await tool.run(input || {});
    } catch (e) {
      return err(e?.reason || e?.message || "tool failed");
    }
  }

  return { definitions, execute, names: () => Object.keys(tools) };
}
