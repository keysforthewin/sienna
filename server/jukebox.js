// Sienna's music jukebox: search YouTube for an artist / song / vibe, shuffle MANY
// results into a never-ending mix, and autoplay track after track until told to stop.
//
// It drives audioOut.playYoutubeTrack(url), which reports WHY each track ended so the
// loop can decide what to do next:
//   "ended"      natural EOF or the 10-min cap        → play the next track
//   "stopped"    the user called stop()               → end the session
//   "superseded" another playback preempted us (her   → wait for the speaker to go
//                auto-spoken reply / a speak tool)        idle, then resume the mix
//   "error"      yt-dlp/ffmpeg failed for this track  → skip to the next
//
// The mix NEVER stops on its own — only an explicit stop() ("stopped") or a track
// that put zero frames on the wire (device offline) ends a session. Everything else
// recovers: an empty re-search retries forever on an exponential backoff
// (retryBaseMs → retryMaxMs); a burst of maxConsecutiveErrors track failures forces
// a fresh LIVE re-search (bypassing — and repairing — the warm cache, whose batch may
// be stale/dead) on the same shared backoff; a superseded track waits out the speaker
// indefinitely. Every backoff sleep re-checks the generation token, so stop() during
// a retry still kills the loop instantly.
//
// Single-song requests: play({ query, continuation }) — when the request was ONE
// specific song, `continuation` carries a similar-songs search ("songs like <title>
// by <artist>"). The moment we move past that song (it ends, or a skip), the session
// GRADUATES: the continuation becomes the session query and refill pulls that mix —
// so "next" after a single song means "something like it", not another version of it.
//
// Correctness rests on a monotonic `generation` token: every control method bumps it
// before mutating state, and the running loop re-checks `myGen === generation` after
// every await — so a stale loop (e.g. one still unwinding from a preempted track) can
// never fight or corrupt the loop that replaced it. The loop runs OUTSIDE the agent's
// run mutex on purpose: the music must outlive the turn that started it.
//
// ytsearch returns individual videos (not separate "playlist" objects); the "random
// mix of the artist" is delivered by shuffling many video results.
//
// No-repeat window: every track that actually played is recorded (persisted via
// memory.js when available) and the last `historyLimit` (250) of them are excluded
// from every mix queue — matching on video id OR (normalized) title OR the title's
// parenthetical-stripped BASE ("Song (Instrumental Mix)" ≡ "Song"), so the same
// song under a different upload or variant title can't sneak back in. Queues are
// also re-checked at PLAY time (a second upload of a song already played from the
// same batch is skipped), and batches dedupe internally at build.
//
// When a query's pool runs dry (everything the search returns is in the window),
// the refill ESCALATES instead of repeating: a deeper live search (deepSearchLimit,
// 3× the normal 50), then ALTERED queries from `queryVariants` — by default an
// LLM brainstorm (music-suggest.js, ~10 related searches: artists, sub-genres,
// adjacent vibes; wired in index.js), falling back to static "<q> songs"-style
// suffixes when no LLM is configured or the call fails. Variants are shuffled and
// tried one by one until something fresh turns up — the search pool was the
// bottleneck (YouTube returns the same top results forever), not the window.
// If even that finds nothing, the window is FULL for this corner of music: the
// play history is cleared outright (persisted too) so the rotation starts over —
// only the just-played track is re-recorded, so it can't come straight back.
// A by-name request (a single-song play() with a continuation) is always exempt
// from the window.

import { spawn as childSpawn } from "node:child_process";

// Placeholder title for the fused cold start: one yt-dlp process searches AND
// streams the top result, so we have no metadata yet — filled in when the
// background full search lands (it resolves the same #0 result).
const LOADING_TITLE = "Loading…";
// Display fallback for a search result with no title. Neither placeholder is a
// real title, so neither participates in history/dedupe keying (otherwise every
// untitled track would count as the same song).
const UNTITLED = "Unknown";

// Search YouTube MUSIC's songs shelf, not all of YouTube: a plain ytsearch for
// "norah jones" happily returns interviews and documentaries; the #songs
// fragment restricts results to actual tracks. yt-dlp resolves this URL like a
// playlist, so result count is bounded with --playlist-end (search) or -I 1
// (the fused single-track start — see audio-out's ytDlpAudioArgs).
export const musicSearchUrl = (term) => `https://music.youtube.com/search?q=${encodeURIComponent(term)}#songs`;

function fisherYates(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Static fallback for the dry-pool query escalation, used when no `queryVariants`
// generator is wired or the wired one (the LLM) fails/returns nothing.
const STATIC_VARIANTS = (q) => [`${q} songs`, `${q} hits`, `best ${q}`, `${q} mix`];

export function createJukebox({
  audioOut,
  memory = null,           // optional persistence (memory.js) for the warm search-result cache + play history
  historyLimit = 500,      // no-repeat window: tracks that played recently are excluded from mixes (0 disables)
  ytDlpPath = "yt-dlp",
  playerClients = "",      // yt-dlp youtube:player_client extractor-arg (comma list); "" ⇒ omit
  spawn = childSpawn,
  shuffle = fisherYates,
  searchLimit = 50,
  deepSearchLimit = 0,     // dry-pool escalation search depth; 0 ⇒ min(3 × searchLimit, 200)
  queryVariants = STATIC_VARIANTS, // dry-pool query generator, sync or async (index.js wires the LLM one)
  resumeTimeoutMs = 30000,
  pollMs = 150,
  maxConsecutiveErrors = 5,
  retryBaseMs = 5000,      // first recovery backoff (empty refill / error burst)
  retryMaxMs = 60000,      // backoff cap
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  clock = () => Date.now(),
  startConfirmMs = 8000,   // fused cache-miss: how long play() waits to confirm first-track audio
  onStateChange = () => {}, // fired whenever the now-playing state changes (track start/stop/pause/…)
  resumeMaxAgeMs = 3600000, // restoreSession: ignore a saved session older than this (0 = no limit)
  log = () => {},
}) {
  const deepLimit = deepSearchLimit > 0 ? deepSearchLimit : Math.min(searchLimit * 3, 200);
  let queue = [];          // [{ id, title, url }]
  let index = 0;           // position of the CURRENT track
  let queueExempt = false;       // by-name queue: never filtered against the window
  let queueAllowsRepeats = false; // dry-pool fallback queue: deliberate repeats
  let replayCurrent = false;     // next loop iteration replays queue[index] on purpose
  let query = null;        // last search term (for reshuffle / play-more)
  let continuationQuery = null; // single-song sessions: the similar-songs search to graduate to
  let active = false;      // a session exists (playing or paused)
  let paused = false;
  let generation = 0;      // bumped to claim/orphan the loop
  let current = null;      // the entry currently playing
  let pendingLeadIn = false; // the next track should lead-in behind a "getting that…" announcement
  // Device-loss suspension (distinct from the user-facing pause): the disconnect
  // handler freezes the session in place and the reconnect handler thaws it, so a
  // device crash/reboot resumes the music where it stopped instead of killing it.
  let suspended = false;
  let suspendFroze = false;  // suspend() did the audioOut freeze (vs an existing user pause)
  let suspendWaiter = null;  // run loop parked on the suspend gate
  const wakeSuspendGate = () => { if (suspendWaiter) { const w = suspendWaiter; suspendWaiter = null; w(); } };

  // Now-playing change seam: fire on every state transition a listener would care
  // about (track start, title fill-in, pause/resume, stop, session end). Isolated
  // so a listener bug can never break the music loop.
  const notify = () => { try { onStateChange(status()); } catch { /* listener's problem */ } };

  // ---- session persistence (survive a server restart) ----
  // The live mix — query, continuation, the whole queue, and the position — is
  // write-through persisted on every track start and cleared when the session
  // ends (stop / natural death). restoreSession() (called at boot) reloads it
  // parked at the suspend gate, so the mix resumes — same track, same remaining
  // playlist — the moment the device (re)connects.
  const sessionEnabled = () => !!(memory?.ready?.() && typeof memory.setMusicSession === "function");
  function persistSession() {
    if (!sessionEnabled() || !active) return;
    const doc = {
      query, continuation: continuationQuery, queue, index,
      exempt: queueExempt, allowRepeats: queueAllowsRepeats, ts: clock(),
    };
    Promise.resolve(memory.setMusicSession(doc)).catch(() => {});
  }
  function clearSession() {
    if (!sessionEnabled()) return;
    Promise.resolve(memory.setMusicSession(null)).catch(() => {});
  }

  // Fused cache-miss confirmation: startSession arms a one-shot outcome per session;
  // runLoop settles it to "started" | "empty" | "superseded"; play() awaits it (bounded).
  let firstOutcome = null;
  function settleFirst(d, v) { if (d && !d.done) { d.done = true; d.resolve(v); } }
  function makeOutcome() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve, done: false }; }
  async function waitFirstOutcome(ms) {
    if (!firstOutcome) return "started";
    return Promise.race([firstOutcome.promise, sleep(ms).then(() => "timeout")]);
  }

  // Search YouTube via yt-dlp; flat (no per-video extraction), JSON object per line.
  function search(term, limit) {
    const t0 = clock();
    return new Promise((resolve) => {
      const ea = playerClients ? ["--extractor-args", `youtube:player_client=${playerClients}`] : [];
      const args = ["--flat-playlist", "--dump-json", "--quiet", "--no-warnings", "--playlist-end", String(limit), ...ea, musicSearchUrl(term)];
      log(`search "${term}" (music songs, limit ${limit}) — spawning yt-dlp`);
      const proc = spawn(ytDlpPath, args);
      let out = "";
      let done = false;
      const finish = (val) => { if (!done) { done = true; resolve(val); } };
      proc.stdout?.on("data", (d) => { out += d.toString(); });
      proc.stdout?.on("error", () => {});
      proc.on("error", () => { log(`search "${term}" yt-dlp spawn error after ${clock() - t0}ms`); finish([]); });
      proc.on("close", () => {
        const tracks = [];
        for (const line of out.split("\n")) {
          const s = line.trim();
          if (!s) continue;
          try {
            const o = JSON.parse(s);
            if (!o || !o.id) continue;
            const artist = o.uploader || o.channel
              || (Array.isArray(o.artists) && o.artists.length ? o.artists.join(", ") : null)
              || null;
            tracks.push({ id: o.id, title: o.title || UNTITLED, artist, url: `https://www.youtube.com/watch?v=${o.id}` });
          } catch { /* tolerate a malformed line */ }
        }
        log(`search "${term}" (music songs, limit ${limit}) → ${tracks.length} results in ${clock() - t0}ms`);
        finish(tracks);
      });
    });
  }

  // ---- warm search-result cache (memory.js, optional) ----
  // We often replay the same request ("play indian music") over and over, and a
  // fresh 50-result YouTube search is multiple seconds on the critical path. So:
  // the FIRST play of a query starts from a single-result search (fastest first
  // note) and warms a full 50-result cache in the BACKGROUND; later plays start
  // instantly from a random stored track and re-warm the cache for next time.
  const cacheEnabled = () => !!(memory && typeof memory.getMusicCache === "function");
  const normalizeKey = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();

  async function readCache(key) {
    if (!cacheEnabled() || !memory.ready?.()) return null;
    try {
      const tracks = await memory.getMusicCache(key);
      return Array.isArray(tracks) && tracks.length ? tracks : null;
    } catch { return null; }
  }

  async function writeCache(key, tracks) {
    if (!cacheEnabled() || !memory.ready?.() || typeof memory.setMusicCache !== "function") return;
    try { await memory.setMusicCache(key, tracks); } catch { /* best-effort; keep old cache */ }
  }

  // ---- play history (the no-repeat window) ----
  // Every track that actually put audio on the wire is recorded (newest last),
  // capped at `historyLimit`, and excluded whenever a mix queue is built — a song
  // never repeats until ~250 others have played, whether it comes back under the
  // same video id or a different upload of the same title. The ONE exception: a by-name
  // request (play() with a `continuation`, i.e. the user asked for that specific
  // song) plays regardless and is never filtered. Persisted via memory.js
  // (getMusicHistory/setMusicHistory) when available so the window survives
  // restarts; in-RAM only otherwise. historyLimit 0 disables the whole feature.
  let history = [];                 // [{ id, title, artist, ts }], oldest → newest
  let historyKeys = new Set();      // O(1) membership for filtering
  let historyLoad = null;           // memoized lazy load (memory may not be ready at construction)
  const historyEnabled = () => historyLimit > 0;
  // A track matches the window on its id OR its (normalized) title OR the title's
  // parenthetical-stripped BASE — the same song is uploaded to YouTube many times
  // under different ids AND variant titles ("Song", "Song (Instrumental Mix)",
  // "Song (Official Video)"), so id or exact title alone lets it repeat. The
  // placeholder fused-start title never keys (it isn't a real title).
  const baseTitle = (titleKey) => titleKey.replace(/\s*[([][^)\]]*[)\]]/g, " ").replace(/\s+/g, " ").trim();
  const historyKeysOf = (t) => {
    const keys = [];
    if (t.id) keys.push(t.id);
    const titleKey = t.title === LOADING_TITLE || t.title === UNTITLED ? "" : normalizeKey(t.title);
    if (titleKey) {
      keys.push(`title:${titleKey}`);
      const base = baseTitle(titleKey);
      if (base && base !== titleKey) keys.push(`title:${base}`);
    }
    return keys;
  };
  const inWindow = (t) => historyEnabled() && historyKeysOf(t).some((k) => historyKeys.has(k));

  function ensureHistoryLoaded() {
    if (historyLoad) return historyLoad;
    if (!historyEnabled() || typeof memory?.getMusicHistory !== "function") return Promise.resolve();
    // Memory not ready yet (e.g. Mongo still connecting at boot): do NOT memoize a
    // no-op — leave historyLoad unset so a later call retries the load.
    if (!memory.ready?.()) return Promise.resolve();
    historyLoad = (async () => {
      try {
        const stored = await memory.getMusicHistory();
        if (Array.isArray(stored) && stored.length) {
          // Anything recorded in-RAM before the load landed is newer than the store.
          const ram = history;
          const ramKeys = new Set(ram.flatMap(historyKeysOf));
          history = [...stored.filter((h) => !historyKeysOf(h).some((k) => ramKeys.has(k))), ...ram].slice(-historyLimit);
          historyKeys = new Set(history.flatMap(historyKeysOf));
          log(`play history loaded: ${history.length} tracks`);
        }
      } catch { /* best-effort; start with an empty window */ }
    })();
    return historyLoad;
  }

  // A track put frames on the wire → it counts as played. A repeat (the
  // superseded-replay path, or the same song under a new id) moves to
  // most-recent instead of duplicating.
  function recordPlayed(track) {
    if (!historyEnabled() || !track) return;
    if (!track.id && track.title === LOADING_TITLE) return;  // fused seed that never resolved
    const keys = historyKeysOf(track);
    history = history.filter((h) => !historyKeysOf(h).some((k) => keys.includes(k)));
    history.push({ id: track.id, title: track.title, artist: track.artist ?? null, ts: clock() });
    if (history.length > historyLimit) history = history.slice(-historyLimit);
    historyKeys = new Set(history.flatMap(historyKeysOf));
    if (memory?.ready?.() && typeof memory.setMusicHistory === "function") {
      Promise.resolve(memory.setMusicHistory(history)).catch(() => {});
    }
  }

  // Drop recently played tracks from a batch, and dedupe the batch against itself
  // (a search can return the same song twice under different uploads — without
  // this, both play). Returns ONLY fresh tracks (possibly empty) — the dry-pool
  // fallback is the caller's call (refill escalates first).
  function filterFresh(tracks) {
    if (!historyEnabled() || !tracks.length) return tracks;
    const seen = new Set();
    const fresh = [];
    for (const t of tracks) {
      const keys = historyKeysOf(t);
      if (keys.some((k) => historyKeys.has(k) || seen.has(k))) continue;
      for (const k of keys) seen.add(k);
      fresh.push(t);
    }
    if (fresh.length < tracks.length) log(`play history filtered ${tracks.length - fresh.length}/${tracks.length} recently played/duplicate tracks`);
    return fresh;
  }

  // Deliberate-repeat order: LEAST recently played first, so a forced repeat is
  // always the track heard longest ago — never one from minutes back.
  function lruOrder(tracks) {
    const pos = new Map();   // history key → index in history (oldest → newest; newest wins)
    history.forEach((h, i) => { for (const k of historyKeysOf(h)) pos.set(k, i); });
    const rank = (t) => Math.max(-1, ...historyKeysOf(t).map((k) => (pos.has(k) ? pos.get(k) : -1)));
    return tracks.slice().sort((a, b) => rank(a) - rank(b));
  }

  // The window is FULL for this corner of music: every track findable (deep search
  // + every altered query) is in the play history. Wipe the window — persisted
  // too — so the rotation starts over with everything eligible again. Only the
  // just-played track is re-recorded (it can't come straight back); recordPlayed's
  // write-through persists that fresh 1-track window. Returns the rebuilt queue.
  function resetWindow(term, pool) {
    log(`no fresh tracks anywhere for "${term}" — play history is full (${history.length} tracks); clearing it to restart the rotation`);
    history = [];
    historyKeys = new Set();
    if (current) recordPlayed(current);
    else if (memory?.ready?.() && typeof memory.setMusicHistory === "function") {
      Promise.resolve(memory.setMusicHistory([])).catch(() => {});
    }
    const fresh = filterFresh(pool);
    if (fresh.length) return { tracks: shuffle(fresh), allowRepeats: false };
    return { tracks: pool.slice(), allowRepeats: true };  // the just-played song is ALL we know → repeat beats silence
  }

  // External plays (the play_youtube tool) report into the window here, so the mix
  // can't replay a song she just streamed directly by URL.
  function notePlayed({ id = null, title = null, artist = null } = {}) {
    if (!historyEnabled() || (!id && !title)) return;
    Promise.resolve(ensureHistoryLoaded())
      .then(() => recordPlayed({ id, title, artist }))
      .catch(() => {});
  }

  // Fire-and-forget: pull a fresh full batch and persist it for next time. Failures
  // leave the previous cache intact. Skipped without a cache backend (nothing to
  // persist to — the eager search path covers continuation there). Searches DEEP:
  // the cache is the query's candidate pool, and a top-50-only pool exhausts
  // against the no-repeat window in a single long session.
  function refreshCache(term, key) {
    if (!cacheEnabled() || !memory.ready?.()) return;
    search(term, deepLimit).then((full) => {
      if (!full.length) { log(`cache refresh "${key}" → empty, kept old cache`); return; }
      writeCache(key, full);
      // Fused cold start is playing a placeholder-titled seed — fill in the real
      // title/id now that we know it (ytsearch1 and this search pick the same #0).
      if (current && current.title === LOADING_TITLE && normalizeKey(query) === key) {
        current.title = full[0].title;
        current.id = full[0].id;
        current.artist = full[0].artist ?? null;
        notify();          // the placeholder title just resolved
        persistSession();  // re-checkpoint with the real title/id
      }
      log(`cache refresh "${key}" → ${full.length} tracks stored`);
    }).catch(() => {});
  }

  // Claim the live mix for `tracks` and start playing. Shared by play/playMore.
  // leadIn=true (play_music only, which fires a spoken heads-up) lets the FIRST track
  // play in behind that announcement instead of cutting it off — see audio-out.js.
  function startSession(term, tracks, { leadIn = false, continuation = null, allowRepeats = false, confirm = false } = {}) {
    settleFirst(firstOutcome, "superseded");   // any prior awaiter must not hang
    firstOutcome = confirm ? makeOutcome() : null;
    query = term;
    continuationQuery = continuation;
    queue = tracks;
    index = 0;
    queueExempt = !!continuation;      // by-name request: never filtered against the window
    queueAllowsRepeats = allowRepeats;
    pendingLeadIn = leadIn;
    runLoop(); // fire-and-forget; bumps generation and preempts any prior loop/track
  }

  // After ANOTHER playback — her speech or a play_audio_file/play_youtube tool —
  // preempted us and owns the speaker, wait for it to free up before resuming.
  // isBusy() (speaker occupancy: voice OR music channel, mute-blind) — NOT the
  // voice-only isPlaying() echo predicate, which is false during a file/URL tool
  // playback and would let us stomp it. Bails false if it times out or the loop
  // was superseded meanwhile.
  async function waitForIdle(myGen) {
    const deadline = clock() + resumeTimeoutMs;
    while (audioOut.isBusy() && clock() < deadline) {
      await sleep(pollMs);
      if (myGen !== generation) return false;
    }
    return !audioOut.isBusy();
  }

  // Escalating fresh-track discovery: the candidate pool for a query — not the
  // no-repeat window — is what runs out (YouTube returns the same top results for
  // the same search forever). So when a step yields nothing fresh, widen the
  // search instead of giving up: warm cache → deep live search → mutated queries.
  // Returns { fresh, pool }: `fresh` is filtered+deduped and ready to queue;
  // `pool` is the deduped union of everything seen (the repeat fallback source —
  // empty ⇒ every search failed outright, the caller should back off and retry).
  async function gatherFresh(term, { useCache = true, alive = () => true } = {}) {
    const key = normalizeKey(term);
    const fresh = [];
    const pool = [];
    const poolKeys = new Set();
    let liveContributed = false;
    const absorb = (entries) => {
      for (const t of entries) {
        const keys = historyKeysOf(t);
        if (keys.length && keys.some((k) => poolKeys.has(k))) continue;  // already seen this song
        for (const k of keys) poolKeys.add(k);
        pool.push(t);
        if (!inWindow(t)) fresh.push(t);
      }
    };
    if (useCache) {
      const cached = await readCache(key);
      if (cached) absorb(cached);
    }
    if (!fresh.length && alive()) {
      const deep = await search(term, deepLimit);
      if (deep.length) {
        liveContributed = true;
        absorb(deep);
        // Altered queries run only when the deep search SUCCEEDED but came back
        // all-stale — a zero-result search means yt-dlp/network trouble, and
        // hammering more searches into an outage helps nobody (the caller's
        // backoff handles that case). The generator may be async (the LLM
        // brainstorm) and may fail — the static suffixes always back it up.
        // Order is randomized; each variant is tried until one yields a song
        // not in the window.
        if (!fresh.length) {
          let variants = [];
          try { variants = (await queryVariants(term)) || []; } catch (e) { log(`query variants failed (${e.message}) — using static fallbacks`); }
          variants = variants.filter((v) => typeof v === "string" && normalizeKey(v) && normalizeKey(v) !== normalizeKey(term));
          if (!variants.length) variants = STATIC_VARIANTS(term);
          for (const variant of shuffle(variants)) {
            if (!alive()) break;
            log(`pool for "${term}" is stale — trying altered query "${variant}"`);
            const got = await search(variant, searchLimit);
            if (got.length) absorb(got);
            if (fresh.length) break;
          }
        }
      }
    }
    // Persist what the live work found (richer than — and repairing — the old
    // cache); the cache is read back as the pool on the next refill/play.
    if (liveContributed && pool.length) writeCache(key, pool);
    return { fresh, pool };
  }

  // Mix exhausted → get more. Prefer the warm cache (the background refresh from
  // play() has long since landed by the time a track ends), escalating to live
  // searches when it's stale. skipCache (the error-burst recovery path) forces the
  // LIVE path — the cached batch may be stale/dead video ids. When every
  // escalation step comes back stale, the window is full → resetWindow clears it
  // and the whole pool comes back into rotation.
  async function refill(myGen, { skipCache = false } = {}) {
    await ensureHistoryLoaded();
    const { fresh, pool } = await gatherFresh(query, { useCache: !skipCache, alive: () => myGen === generation });
    if (myGen !== generation) return false;
    if (fresh.length) {
      queue = shuffle(fresh);
      queueExempt = false; queueAllowsRepeats = false;
      index = 0;
      return true;
    }
    if (!pool.length) return false;        // searches failed outright → caller backs off
    const rebuilt = resetWindow(query, pool);
    queue = rebuilt.tracks;
    queueExempt = false; queueAllowsRepeats = rebuilt.allowRepeats;
    index = 0;
    return true;
  }

  // Exponential recovery backoff: 5s, 10s, 20s, … capped at retryMaxMs, forever.
  const backoff = (n) => Math.min(retryBaseMs * 2 ** n, retryMaxMs);

  // Move past the current track. A single-song session graduates here: instead of
  // the next queue entry (just another version of the same song), the similar-songs
  // continuation becomes the session query and the emptied queue forces a refill.
  function advance() {
    if (continuationQuery) {
      query = continuationQuery;
      continuationQuery = null;
      queue = [];
      index = 0;
    } else {
      index += 1;
    }
  }

  async function runLoop() {
    const myGen = ++generation;     // claim the loop; orphans any prior one
    const myOutcome = firstOutcome; // this session's confirmation promise (or null)
    wakeSuspendGate();              // release a prior loop parked at the gate so it observes the bump
    active = true;
    paused = false;
    let consecutiveErrors = 0;
    let recoveryAttempts = 0;       // empty-refill / error-burst rounds (shared backoff)
    while (myGen === generation) {
      // Suspend gate: the device is gone — park instead of starting a track into
      // the void. Woken by resumeFromSuspend (reconnect) or any generation bump.
      while (suspended && myGen === generation) {
        await new Promise((r) => { suspendWaiter = r; });
      }
      if (myGen !== generation) return;
      if (index >= queue.length) {              // exhausted → reshuffle/refill
        const ok = await refill(myGen);
        if (myGen !== generation) return;
        if (!ok) {
          // Search came back empty (transient yt-dlp/network failure) — never
          // give up: back off and retry until it recovers or someone stops us.
          settleFirst(myOutcome, "empty");   // first track produced no audio; surface this
          const delay = backoff(recoveryAttempts++);
          log(`refill came back empty — retrying the search in ${delay}ms`);
          await sleep(delay);
          if (myGen !== generation) return;
          continue;
        }
      }
      // Play-time freshness check: the queue was filtered when BUILT — a second
      // upload of a song that played later from this same batch, or a track played
      // elsewhere meanwhile (notePlayed), is only catchable here. Deliberate
      // repeats are exempt: by-name queues, the dry-pool fallback, and an
      // intentional same-track replay (superseded / device-loss recovery).
      if (replayCurrent) {
        replayCurrent = false;
      } else if (!queueExempt && !queueAllowsRepeats) {
        const from = index;
        while (index < queue.length && inWindow(queue[index])) index += 1;
        if (index > from) log(`play-time check skipped ${index - from} track(s) already in the play history`);
        if (index >= queue.length) continue;     // queue ran dry → the refill branch handles it
      }
      current = queue[index];
      notify();          // now-playing changed (new track)
      persistSession();  // restart-resume checkpoint: this track + the rest of the queue
      const trackTitle = current.title;
      const leadIn = pendingLeadIn;   // only the first track of a play() session leads in
      pendingLeadIn = false;
      const trackStart = clock();
      log(`track start [${index}]: "${trackTitle}" (${current.url})${leadIn ? " [lead-in]" : ""}`);
      const playedEntry = current;              // capture: a new loop may reassign `current` while we play
      const { reason, frames } = await audioOut.playYoutubeTrack(current.url, { leadIn });
      log(`track end [${index}]: "${trackTitle}" reason=${reason} frames=${frames} after ${clock() - trackStart}ms`);
      if (frames > 0) { recordPlayed(playedEntry); settleFirst(myOutcome, "started"); }
      if (myGen !== generation) return;         // a control method took over while we played

      if (reason === "stopped") { settleFirst(myOutcome, "superseded"); break; }
      if (reason === "superseded") {            // her speech took the speaker
        // If the first track put zero frames before the barge-in, myOutcome was
        // never settled by the frames>0 branch above — settle it now so an
        // in-flight fused play() await doesn't wait the full startConfirmMs.
        // Idempotent: a prior "started" settle is a no-op.
        settleFirst(myOutcome, "superseded");
        // An interjection suspended us (paused): don't auto-replay over the open
        // conversation window (that would re-gate the mic). Orphan instead — resume()
        // restarts the track once the interjection ends. Checked both before AND after
        // waitForIdle, since a barge-in can land while we wait for her voice to finish.
        if (paused) return;
        let idle = await waitForIdle(myGen);
        if (myGen !== generation) return;
        if (paused) return;
        while (!idle) {                          // still busy past the window (e.g. a long
          log("speaker still busy past the resume window — waiting it out");
          idle = await waitForIdle(myGen);       // play_youtube tool playback) — keep waiting
          if (myGen !== generation) return;
          if (paused) return;
        }
        replayCurrent = true;                    // it recorded as played; replay it anyway
        continue;                                // replay the SAME track after she's done
      }
      if (reason === "error") {
        if (++consecutiveErrors >= maxConsecutiveErrors) {
          // The whole batch is probably bad (stale cache / dead ids) — back off,
          // then force a fresh LIVE re-search and keep the mix alive.
          const delay = backoff(recoveryAttempts++);
          log(`too many failures in a row — re-searching live in ${delay}ms`);
          await sleep(delay);
          if (myGen !== generation) return;
          consecutiveErrors = 0;
          if (continuationQuery) advance();      // graduate the single-song session
          else index = queue.length;             // the rest of this batch is likely dead too
          await refill(myGen, { skipCache: true });
          if (myGen !== generation) return;
          continue;                              // empty result → the exhausted branch retries
        }
        advance();
        continue;
      }
      // reason === "ended" (natural EOF or the 10-min cap)
      if (frames === 0) {
        // Suspended mid-flight: the empty drain is the disconnect itself, not a
        // dead session — park at the gate and replay this track on reconnect.
        if (suspended) { replayCurrent = true; continue; }
        settleFirst(myOutcome, "empty");
        log("no audio reached the device (offline?) — stopping the mix"); break;
      }
      consecutiveErrors = 0;
      recoveryAttempts = 0;                      // a track actually played — fresh slate
      advance();
    }
    if (myGen === generation) { active = false; paused = false; current = null; clearSession(); notify(); }
  }

  // ---- public control surface (tool-result convention: { ok, text } | { ok:false, error }) ----

  async function play({ query: q, continuation: c } = {}) {
    const term = (q || "").trim();
    if (!term) return { ok: false, error: "What would you like me to play?" };
    const continuation = (c || "").trim() || null;  // single-song request: graduate to this
    const key = normalizeKey(term);
    await ensureHistoryLoaded();
    // A by-name single-song request (continuation set) is exempt from the no-repeat
    // window: the user asked for THAT song, so its queue of versions is never filtered.
    const exemptFromHistory = !!continuation;

    // When every candidate is in the no-repeat window, instant start still wins:
    // play the ONE least-recently-played track now, and let the first refill
    // (one track from now) escalate to live searches for fresh material.
    let seedRepeats = false;
    const seedFrom = (entries) => {
      const fresh = exemptFromHistory ? entries : filterFresh(entries);
      if (fresh.length) return shuffle(fresh);
      seedRepeats = true;
      log(`all ${entries.length} known tracks for "${term}" are recently played — starting on the oldest while the mix re-searches`);
      return lruOrder(entries).slice(0, 1);
    };

    const cached = await readCache(key);
    let seed;
    let confirm = false;
    if (cached) {
      // Warm: start instantly from a random stored track (shuffle picks the first).
      log(`cache HIT "${key}" (${cached.length} tracks) — instant start`);
      seed = seedFrom(cached);
    } else if (cacheEnabled()) {
      // Cold + cache backend: FUSE search and playback — hand the search expression
      // straight to the player so ONE yt-dlp process searches AND streams the top
      // result (no separate metadata round-trip). The real title lands with the
      // background full search. On the fused path, play() awaits the first-track
      // outcome (bounded by startConfirmMs) so a no-results query surfaces as an error
      // rather than silently returning ok:true.
      log(`cache MISS "${key}" — fused music-search start`);
      seed = [{ id: null, title: LOADING_TITLE, artist: null, url: musicSearchUrl(term) }];
      confirm = true;
    } else {
      // No cache backend: original eager full search (refill handles continuation).
      log(`cache MISS "${key}" — music search (limit ${searchLimit})`);
      const entries = await search(term, searchLimit);
      if (!entries.length) return { ok: false, error: `I couldn't find anything on YouTube for "${term}".` };
      seed = seedFrom(entries);
    }

    const seededTitle = seed[0]?.title;
    startSession(term, seed, { leadIn: true, continuation, allowRepeats: seedRepeats, confirm });
    refreshCache(term, key);   // warm/re-warm the cache for next time (no-op without memory)

    if (confirm) {
      const outcome = await waitFirstOutcome(startConfirmMs);
      if (outcome === "empty") return { ok: false, error: `I couldn't find anything to play for "${term}".` };
    }

    const startingTitle = (current && current.title !== LOADING_TITLE) ? current.title : seededTitle;
    return {
      ok: true,
      text: startingTitle && startingTitle !== LOADING_TITLE
        ? `Playing ${term} — starting with "${startingTitle}". I'll keep it going until you tell me to stop.`
        : `Playing ${term} — pulling up the first track now. I'll keep it going until you tell me to stop.`,
    };
  }

  async function playMore() {
    if (!query) return { ok: false, error: "Nothing's playing yet — start something with play_music first." };
    // "More like this" wants FRESH tracks, so always search live (gatherFresh
    // persists what it finds, keeping the warm cache current, and escalates past
    // a stale top-of-search on its own). A single-song session graduates here
    // too: "more like this" means the similar-songs search, not more versions.
    const term = continuationQuery || query;
    await ensureHistoryLoaded();
    const { fresh, pool } = await gatherFresh(term, { useCache: false });
    if (!pool.length) return { ok: false, error: `I couldn't find more for "${term}".` };
    if (fresh.length) startSession(term, shuffle(fresh));
    else {
      const rebuilt = resetWindow(term, pool);
      startSession(term, rebuilt.tracks, { allowRepeats: rebuilt.allowRepeats });
    }
    return { ok: true, text: `Reshuffled — more ${term} coming up, starting with "${queue[0].title}".` };
  }

  function skip() {
    if (!active) return { ok: false, error: "Nothing's playing to skip." };
    advance();
    paused = false;
    runLoop();
    return { ok: true, text: "Skipped to the next track." };
  }

  // Pause for a voice interjection: freeze the live track IN PLACE on a frame
  // boundary (audioOut.pause silences the device so isPlaying() goes false and the
  // mic path re-enables) WITHOUT orphaning the loop — it stays parked inside
  // playYoutubeTrack, so a silent interjection resumes the SAME track mid-stream.
  function pause() {
    if (!active || paused) return { ok: false, error: "Nothing to pause." };
    paused = true;
    audioOut.pause();
    notify();
    return { ok: true, text: "Paused." };
  }

  function resume() {
    if (!active || !paused) return { ok: false, error: "Nothing to resume." };
    paused = false;
    // Still frozen in place (she said nothing) → continue the SAME track mid-stream.
    // Otherwise her speech took the pipeline (the loop orphaned on superseded) →
    // restart the current track from the top (it already recorded as played, so
    // flag the deliberate replay past the play-time check).
    if (audioOut.isPaused()) { audioOut.resume(); notify(); }
    else { replayCurrent = true; runLoop(); }
    return { ok: true, text: "Resumed." };
  }

  // Device disconnected: freeze the session IN PLACE (don't end it). A playing
  // track pauses on a frame boundary (yt-dlp/ffmpeg stay parked on backpressure),
  // a loop between tracks parks at the suspend gate — either way resumeFromSuspend
  // continues exactly where the disconnect landed. An existing USER pause is left
  // alone (suspendFroze records who froze it, so reconnect can't release it).
  function suspend() {
    if (!active || suspended) return false;
    suspended = true;
    suspendFroze = !paused && audioOut.pause();
    return true;
  }

  // Device reconnected: thaw whatever suspend() froze and wake the parked loop.
  function resumeFromSuspend() {
    if (!suspended) return false;
    suspended = false;
    if (suspendFroze && audioOut.isPaused()) audioOut.resume();
    suspendFroze = false;
    wakeSuspendGate();
    return true;
  }

  function stop() {
    generation += 1;
    // Promptly resolve any in-flight fused play() await so it doesn't stall
    // the full startConfirmMs (8s) waiting for a first-track outcome that will
    // never arrive. Idempotent — a prior "started"/"empty" settle is a no-op.
    settleFirst(firstOutcome, "superseded");
    active = false;
    paused = false;
    suspended = false;
    suspendFroze = false;
    wakeSuspendGate();   // unwind a loop parked at the suspend gate
    queue = [];
    index = 0;
    queueExempt = false;
    queueAllowsRepeats = false;
    replayCurrent = false;
    query = null;
    continuationQuery = null;
    current = null;
    audioOut.stop();
    clearSession();
    notify();
    return { ok: true, text: "Stopped the music." };
  }

  // Boot-time restart-resume: reload the session persistSession checkpointed and
  // park it at the suspend gate — the device is never connected this early, and
  // the existing onDeviceConnected → resumeFromSuspend() wiring thaws it, so the
  // interrupted track restarts (from the top; a mid-stream position isn't
  // recoverable) and the rest of the queued mix follows. A session older than
  // resumeMaxAgeMs is discarded (and cleared) rather than surprising the room
  // with music from last week.
  async function restoreSession() {
    if (active || typeof memory?.getMusicSession !== "function" || !memory.ready?.()) return false;
    let saved = null;
    try { saved = await memory.getMusicSession(); } catch { return false; }
    if (!saved || !saved.query || !Array.isArray(saved.queue) || !saved.queue.length) return false;
    if (resumeMaxAgeMs > 0 && saved.ts && clock() - saved.ts > resumeMaxAgeMs) {
      log(`saved music session ("${saved.query}") is older than ${resumeMaxAgeMs}ms — not resuming`);
      clearSession();
      return false;
    }
    await ensureHistoryLoaded();
    query = saved.query;
    continuationQuery = saved.continuation || null;
    queue = saved.queue;
    index = Math.min(Math.max(0, saved.index | 0), queue.length - 1);
    queueExempt = !!saved.exempt;
    queueAllowsRepeats = !!saved.allowRepeats;
    replayCurrent = true;   // deliberate replay: the interrupted track is (likely) in the window
    pendingLeadIn = false;
    suspended = true;       // park until the device (re)connects
    suspendFroze = false;
    log(`restoring music session: "${query}" at track ${index + 1}/${queue.length} — waiting for the device`);
    runLoop();
    return true;
  }

  function nowPlaying() {
    if (active && current) {
      const who = current.artist ? ` by ${current.artist}` : "";
      const mix = query ? ` — from your "${query}" mix` : "";
      return { ok: true, text: `Now playing: "${current.title}"${who}${mix}.` };
    }
    return { ok: true, text: "Nothing's playing right now." };
  }

  function status() {
    return {
      active,
      paused,
      query,
      continuation: continuationQuery,
      queueLength: queue.length,
      index,
      current: current ? { title: current.title, artist: current.artist ?? null, url: current.url } : null,
    };
  }

  return { play, playMore, skip, pause, resume, suspend, resumeFromSuspend, stop, nowPlaying, status, notePlayed, restoreSession, isActive: () => active };
}
