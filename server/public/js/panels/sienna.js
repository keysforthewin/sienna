// "Sienna" view: her input (send box + speech monitor + autonomy) on top, then six
// tabs — Activity (a time-merged feed of messages + memories + personality +
// tool calls + images), Messages, Memories, Personality History, Tool Calls,
// Images — over a vertical feed. Tool calls render live and are persisted (so
// they backfill on reload); output-device calls (speaker / LEDs) get a special
// graphic, and image cards render an inline thumbnail.
// Newest is at the TOP; new entries auto-prepend (and, when you're
// scrolled down reading older ones, the scroll position is held so the view
// doesn't jump). Scrolling toward the bottom lazily loads older entries
// (infinite scroll, backed by growing the REST `?limit=`). The speech-monitor widget
// itself is mounted by dashboard.js into `#sienna-speech`.

import { relTime, absTime, cardModel, DISPLAY_TZ } from "./sienna-strip.js";

const TABS = [
  { key: "activity",    label: "Activity",            path: "/api/sienna/activity",    accepts: () => true },
  { key: "messages",    label: "Messages",            path: "/api/sienna/messages",    accepts: (k) => k === "message" },
  { key: "memories",    label: "Memories",            path: "/api/sienna/memories",    accepts: (k) => k === "memory" },
  { key: "personality", label: "Personality History", path: "/api/sienna/personality", accepts: (k) => k === "personality" },
  { key: "tools",       label: "Tool Calls",          path: "/api/sienna/tools",       accepts: (k) => k === "tool" },
  { key: "images",      label: "Images",              path: "/api/sienna/images",      accepts: (k) => k === "image" },
];

const PAGE = 50;          // how many to fetch per "page"
const MAX = 500;          // server clamp on ?limit; the infinite-scroll ceiling

export function initSiennaPanel(client) {
  const root = document.getElementById("panel-sienna");
  if (!root) return;

  root.innerHTML = `
    <div id="sienna-nowplaying" class="sienna-nowplaying" hidden>
      <span class="sienna-np-icon">♪</span>
      <span id="sienna-np-text" class="sienna-np-text"></span>
    </div>
    <div class="sienna-input-row">
      <textarea id="sienna-input" rows="2" placeholder="Say something to Sienna… (Enter to send)"></textarea>
      <button id="sienna-send" class="primary">Send</button>
    </div>
    <div id="sienna-speech" class="sienna-speech"></div>
    <div class="sienna-controls">
      <label class="sienna-toggle">
        <input type="checkbox" id="sienna-autonomy"> Autonomous speech
      </label>
      <span id="sienna-status" class="sienna-status"></span>
    </div>
    <div class="sienna-tabs" id="sienna-tabs"></div>
    <div id="sienna-feeds"></div>
  `;

  const tabsBar = root.querySelector("#sienna-tabs");
  const feedsWrap = root.querySelector("#sienna-feeds");
  const input = root.querySelector("#sienna-input");
  const sendBtn = root.querySelector("#sienna-send");
  const autonomy = root.querySelector("#sienna-autonomy");
  const statusEl = root.querySelector("#sienna-status");
  const npBar = root.querySelector("#sienna-nowplaying");
  const npText = root.querySelector("#sienna-np-text");

  // Now-playing bar: driven by the server's now_playing broadcasts (one arrives on
  // connect with the current state, then live on every track change / pause / stop).
  function renderNowPlaying(np) {
    if (!np || !np.active || !np.title) { npBar.hidden = true; npText.replaceChildren(); return; }
    const bits = [document.createTextNode(`“${np.title}”`)];
    const span = (cls, text) => { const s = document.createElement("span"); s.className = cls; s.textContent = text; return s; };
    if (np.artist) bits.push(span("np-artist", ` by ${np.artist}`));
    if (np.query) bits.push(span("np-mix", ` — ${np.query} mix`));
    if (np.paused) bits.push(span("np-paused", " (paused)"));
    npText.replaceChildren(...bits);
    npBar.title = np.title + (np.artist ? ` by ${np.artist}` : "");
    npBar.hidden = false;
  }
  client.addEventListener("msg:now_playing", (ev) => renderNowPlaying(ev.detail));

  // Build the tab buttons + per-tab vertical feeds.
  let active = TABS[0];
  for (const tab of TABS) {
    tab.ids = new Set();
    tab.limit = PAGE;
    tab.gen = 0;
    tab.loading = false;
    tab.exhausted = false;

    tab.btn = document.createElement("button");
    tab.btn.className = "sienna-tab";
    tab.btn.textContent = tab.label;
    tab.btn.addEventListener("click", () => activate(tab));
    tabsBar.append(tab.btn);

    tab.el = document.createElement("div");           // scroll container
    tab.el.className = "sienna-feed";
    tab.list = document.createElement("div");         // newest-on-top column
    tab.list.className = "sienna-feed-list";
    tab.sentinel = document.createElement("div");     // bottom infinite-scroll trigger
    tab.sentinel.className = "sienna-feed-sentinel";
    tab.el.append(tab.list, tab.sentinel);
    feedsWrap.append(tab.el);
    tab.list.append(emptyEl("Loading…"));

    // Load older entries when the bottom sentinel scrolls into view. A hidden
    // tab's container has no layout, so its observer never fires — only the
    // visible tab paginates, and a freshly-activated tab catches up on switch.
    tab.observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) loadMore(tab);
    }, { root: tab.el, rootMargin: "240px" });
    tab.observer.observe(tab.sentinel);
  }

  function activate(tab) {
    active = tab;
    for (const t of TABS) {
      t.btn.classList.toggle("active", t === tab);
      t.el.hidden = t !== tab;
    }
  }
  activate(TABS[0]);

  function emptyEl(text) {
    const d = document.createElement("div");
    d.className = "sienna-empty";
    d.textContent = text;
    return d;
  }
  function clearPlaceholder(tab) {
    const ph = tab.list.querySelector(".sienna-empty");
    if (ph) ph.remove();
  }

  function buildItem(card) {
    const m = cardModel(card);
    const node = document.createElement("div");
    node.className = `sienna-feed-item ${m.kind}${m.role ? " " + m.role : ""}${m.output ? " output" : ""}`;
    if (card.id) node.dataset.id = card.id;
    if (m.title) node.title = m.title;

    const head = document.createElement("div");
    head.className = "sienna-feed-head";
    // Output-device tool calls (speaker / LEDs) get a special graphic up front.
    if (m.icon) {
      const ic = document.createElement("span");
      ic.className = "sienna-feed-icon";
      ic.textContent = m.icon;
      head.append(ic);
    }
    const label = document.createElement("span");
    label.className = "sienna-feed-label";
    label.textContent = m.label;
    const meta = document.createElement("span");
    meta.className = "sienna-feed-meta";
    meta.textContent = m.meta;
    // Two times per card: a coarse relative one that ticks (refreshed by the
    // interval below via [data-ts]) and an explicit absolute timestamp so every
    // log line on the Sienna page carries a real date/time, not just "5m".
    const time = document.createElement("span");
    time.className = "sienna-feed-time";
    const abs = document.createElement("span");
    abs.className = "sienna-feed-abs";
    if (card.ts != null) {
      time.dataset.ts = String(card.ts);
      time.textContent = relTime(card.ts, Date.now());
      abs.textContent = absTime(card.ts);
      abs.title = new Date(card.ts).toLocaleString(undefined, { timeZone: DISPLAY_TZ });
    }
    head.append(label, meta, time, abs);

    const body = document.createElement("div");
    body.className = "sienna-feed-body";
    if (card.kind === "image" && card.filename) {
      // Inline thumbnail; click opens the full-size JPEG. Token rides in the
      // query string because <img> can't send an Authorization header.
      const url = `/api/sienna/images/${encodeURIComponent(card.filename)}?token=${encodeURIComponent(client.token)}`;
      const a = document.createElement("a");
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener";
      const img = document.createElement("img");
      img.className = "sienna-feed-image";
      img.loading = "lazy";
      img.src = url;
      img.alt = "camera snapshot";
      a.append(img);
      body.append(a);
    } else {
      body.textContent = m.body;
    }

    node.append(head, body);
    if (m.tags.length) {
      const tagsEl = document.createElement("div");
      tagsEl.className = "sienna-feed-tags";
      for (const t of m.tags) {
        const chip = document.createElement("span");
        chip.className = "sienna-feed-tag";
        chip.textContent = t;
        tagsEl.append(chip);
      }
      node.append(tagsEl);
    }
    return node;
  }

  // A live entry: prepend to the top. If the reader is scrolled down reading
  // older entries, hold their position by nudging scrollTop down by the new
  // node's height; if they're at the top, leave them there so the newest is
  // simply revealed (read without moving).
  function prependLive(tab, card) {
    if (card.id && tab.ids.has(card.id)) return null;
    if (card.id) tab.ids.add(card.id);
    clearPlaceholder(tab);
    const node = buildItem(card);
    const el = tab.el;
    const atTop = el.scrollTop <= 4;
    tab.list.prepend(node);
    if (!atTop && tab === active) el.scrollTop += node.offsetHeight;
    return node;
  }

  async function fetchCards(path, limit) {
    const res = await fetch(`${path}?limit=${limit}`, { headers: { authorization: `Bearer ${client.token}` } });
    if (res.status === 503) return { unavailable: true };
    if (!res.ok) throw new Error(`${path} ${res.status}`);
    return { cards: await res.json() };
  }

  // Full (re)load of a tab — newest-first from REST renders straight down, so the
  // newest lands at the top. A generation guard drops a slow earlier load if a
  // newer one already started (reconnect can't let stale data overwrite fresh).
  async function reload(tab) {
    const gen = ++tab.gen;
    tab.limit = PAGE;
    tab.exhausted = false;
    let result;
    try { result = await fetchCards(tab.path, tab.limit); }
    catch { result = { error: true }; }
    if (gen !== tab.gen) return;
    tab.ids.clear();
    tab.list.replaceChildren();
    if (result.unavailable) { tab.list.append(emptyEl("Sienna's agent isn't configured (needs MongoDB + Gemini).")); tab.exhausted = true; return; }
    if (result.error) { tab.list.append(emptyEl("Couldn't load — will retry on reconnect.")); return; }
    const cards = result.cards || [];
    if (!cards.length) { tab.list.append(emptyEl("Nothing here yet.")); tab.exhausted = true; return; }
    for (const card of cards) {           // newest-first → newest ends up at top
      if (card.id && tab.ids.has(card.id)) continue;
      if (card.id) tab.ids.add(card.id);
      tab.list.append(buildItem(card));
    }
    if (cards.length < tab.limit) tab.exhausted = true;
    tab.el.scrollTop = 0;
  }

  // Grow the window and append the older entries at the bottom (deduped).
  async function loadMore(tab) {
    if (tab.loading || tab.exhausted || tab.limit >= MAX) return;
    tab.loading = true;
    const gen = tab.gen;
    const want = Math.min(tab.limit + PAGE, MAX);
    try {
      const result = await fetchCards(tab.path, want);
      if (gen !== tab.gen) return;        // a reload happened mid-flight; abandon
      const cards = result.cards || [];
      let added = 0;
      for (const card of cards) {
        if (card.id && tab.ids.has(card.id)) continue;
        if (card.id) tab.ids.add(card.id);
        clearPlaceholder(tab);
        tab.list.append(buildItem(card));  // older → appended at the bottom
        added++;
      }
      tab.limit = want;
      if (added === 0 || want >= MAX || cards.length < want) tab.exhausted = true;
    } catch { /* leave un-exhausted; retries on the next intersect */ }
    finally { tab.loading = false; }
  }

  // ---- input + controls ----
  function send() {
    const text = input.value.trim();
    if (!text) return;
    const ref = client.send({ type: "agent_input", text });
    if (ref === null) { statusEl.textContent = "not connected"; return; }
    input.value = "";  // her reply (and this turn's "you" entry) arrive via sienna_entry
  }
  sendBtn.addEventListener("click", send);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });
  autonomy.addEventListener("change", () => client.send({ type: "set_autonomy", enabled: autonomy.checked }));

  // ---- live events ----
  client.addEventListener("msg:sienna_entry", (ev) => {
    const card = ev.detail.entry;
    if (!card) return;
    for (const tab of TABS) if (tab.accepts(card.kind)) prependLive(tab, card);
  });

  // Tool calls render live the instant the agent starts one ("what she's doing
  // right now"), then update in place with the result. They're ALSO persisted
  // server-side, so they backfill on reload via the Activity + Tool Calls REST
  // endpoints — the live card and the REST card share the id `tool-<id>`, so the
  // per-tab id-set dedupes them. The live card goes to every tab that accepts a
  // tool kind (Activity + Tool Calls); we track all its nodes to update together.
  const toolNodes = new Map();
  client.addEventListener("msg:agent_tool", (ev) => {
    const { id, name, input: ti } = ev.detail;
    const arg = ti && Object.keys(ti).length ? JSON.stringify(ti) : "";
    const card = { kind: "tool", id: `tool-${id}`, ts: Date.now(), name, content: arg };
    const nodes = [];
    for (const tab of TABS) {
      if (!tab.accepts("tool")) continue;
      const node = prependLive(tab, card);
      if (node) nodes.push(node);
    }
    if (nodes.length) toolNodes.set(id, nodes);
  });
  client.addEventListener("msg:agent_tool_result", (ev) => {
    const { id, summary, is_error } = ev.detail;
    const nodes = toolNodes.get(id);
    if (!nodes) return;
    for (const node of nodes) {
      const body = node.querySelector(".sienna-feed-body");
      body.textContent = `${body.textContent}\n← ${summary}`.trim();
      if (is_error) node.classList.add("error");
    }
  });

  client.addEventListener("msg:agent_status", (ev) => {
    statusEl.textContent = ev.detail.state === "thinking" ? "thinking…" : "";
  });
  client.addEventListener("msg:agent_error", (ev) => { statusEl.textContent = `error: ${ev.detail.reason}`; });
  client.addEventListener("msg:autonomy_state", (ev) => { autonomy.checked = !!ev.detail.enabled; });
  client.addEventListener("msg:command_error", (ev) => {
    if (ev.detail.reason === "agent_unavailable") {
      statusEl.textContent = "Sienna's agent isn't configured (needs MongoDB + Gemini).";
    }
  });

  // Refresh the relative timestamps in place.
  setInterval(() => {
    const now = Date.now();
    root.querySelectorAll(".sienna-feed-time[data-ts]").forEach((el) => {
      el.textContent = relTime(Number(el.dataset.ts), now);
    });
  }, 30000);

  function loadAll() { for (const tab of TABS) reload(tab); }
  client.addEventListener("open", () => { loadAll(); });
  loadAll();
}
