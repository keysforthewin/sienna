// "Usage" view: Gemini token usage + cost, bucketed by hour / day / week / month.
// All data is REST-backed (/api/usage) and device-independent, so it stays usable
// while the device is offline — the granularity buttons carry the `usage-tab` class
// so dashboard.js's disableAllControls keeps them clickable. Input is split into
// text vs image tokens (combined and separate); cost is summed from the per-call
// cost the server locked in at record time.

const GRAN_KEY = "sienna.usage.gran";
const GRANULARITIES = [
  { key: "hour", label: "Hourly" },
  { key: "day", label: "Daily" },
  { key: "week", label: "Weekly" },
  { key: "month", label: "Monthly" },
];

const fmtInt = (n) => Number(n || 0).toLocaleString();
const fmtCost = (n) => `$${Number(n || 0).toFixed(4)}`;

export function initUsagePanel(client) {
  const root = document.getElementById("panel-usage");
  if (!root) return;

  root.innerHTML = `
    <div class="usage-head">
      <h2>Token usage &amp; cost <span class="usage-sub">Gemini</span></h2>
      <div class="usage-granularity" id="usage-granularity"></div>
    </div>
    <div class="usage-totals" id="usage-totals"></div>
    <div class="usage-table-wrap">
      <table class="usage-table">
        <thead><tr>
          <th>When</th><th>Calls</th><th>In · text</th><th>In · image</th>
          <th>In · total</th><th>Output</th><th>Total</th><th>Cost</th>
        </tr></thead>
        <tbody id="usage-rows"></tbody>
      </table>
    </div>
    <div class="usage-status" id="usage-status"></div>
  `;

  const granBar = root.querySelector("#usage-granularity");
  const totalsEl = root.querySelector("#usage-totals");
  const rowsEl = root.querySelector("#usage-rows");
  const statusEl = root.querySelector("#usage-status");

  let granularity = localStorage.getItem(GRAN_KEY) || "day";
  if (!GRANULARITIES.some((g) => g.key === granularity)) granularity = "day";

  const btns = {};
  for (const g of GRANULARITIES) {
    const b = document.createElement("button");
    b.className = "usage-tab";
    b.textContent = g.label;
    b.addEventListener("click", () => setGranularity(g.key));
    granBar.append(b);
    btns[g.key] = b;
  }
  function syncButtons() {
    for (const g of GRANULARITIES) btns[g.key].classList.toggle("active", g.key === granularity);
  }
  function setGranularity(g) {
    granularity = g;
    localStorage.setItem(GRAN_KEY, g);
    syncButtons();
    load();
  }

  function totalCell(label, val, accent) {
    const cell = document.createElement("div");
    cell.className = `usage-total${accent ? " accent" : ""}`;
    const v = document.createElement("span");
    v.className = "usage-total-val";
    v.textContent = val;
    const l = document.createElement("span");
    l.className = "usage-total-label";
    l.textContent = label;
    cell.append(v, l);
    return cell;
  }
  function renderTotals(t) {
    totalsEl.replaceChildren();
    if (!t) return;
    totalsEl.append(
      totalCell("Total cost", fmtCost(t.cost), true),
      totalCell("Calls", fmtInt(t.calls)),
      totalCell("Input · text", fmtInt(t.input_text)),
      totalCell("Input · image", fmtInt(t.input_image)),
      totalCell("Output", fmtInt(t.output)),
      totalCell("Total tokens", fmtInt(t.total)),
    );
  }

  function renderRows(buckets) {
    rowsEl.replaceChildren();
    for (const b of buckets) {
      const tr = document.createElement("tr");
      const cells = [
        b.key, fmtInt(b.calls), fmtInt(b.input_text), fmtInt(b.input_image),
        fmtInt(b.input_total), fmtInt(b.output), fmtInt(b.total), fmtCost(b.cost),
      ];
      cells.forEach((text, i) => {
        const td = document.createElement("td");
        td.textContent = text;
        if (i === 0) td.className = "usage-when";
        tr.append(td);
      });
      rowsEl.append(tr);
    }
  }

  async function load({ quiet = false } = {}) {
    if (!quiet) statusEl.textContent = "Loading…";
    let res;
    try {
      res = await fetch(`/api/usage?granularity=${granularity}`, { headers: { authorization: `Bearer ${client.token}` } });
    } catch {
      statusEl.textContent = "Couldn't load — will retry on reconnect.";
      return;
    }
    if (res.status === 503) {
      renderTotals(null); renderRows([]);
      statusEl.textContent = "Sienna's agent isn't configured (needs MongoDB + Gemini).";
      return;
    }
    if (!res.ok) { statusEl.textContent = `Couldn't load (${res.status}).`; return; }
    const data = await res.json();
    renderTotals(data.totals);
    renderRows(data.buckets || []);
    statusEl.textContent = (data.buckets && data.buckets.length) ? "" : "No usage recorded yet.";
  }

  // Live updates: the server broadcasts a `usage` event after each LLM call is
  // recorded. Coalesce a burst (one agent turn = several calls) into a single quiet
  // refetch so the numbers refresh without a manual reload.
  let refreshTimer = null;
  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => { refreshTimer = null; load({ quiet: true }); }, 1500);
  }
  client.addEventListener("msg:usage", () => scheduleRefresh());

  syncButtons();
  load();
  client.addEventListener("open", () => load());
}
