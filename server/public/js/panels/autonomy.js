// "Agent" panel (Diagnostics view): the Autonomous speech toggle, relocated
// from the Interact page. Server-owned state — the agent holds it (persisted to
// Mongo), every browser's checkbox syncs via the autonomy_state broadcast and
// the connect-time snapshot — so the checkbox is whitelisted in
// disableAllControls and stays usable while the device is offline.

export function initAutonomyPanel(client) {
  const root = document.getElementById("panel-autonomy");
  if (!root) return;

  root.innerHTML = `
    <h2>Agent</h2>
    <label class="sienna-toggle">
      <input type="checkbox" id="sienna-autonomy"> Autonomous speech
    </label>
    <p class="panel-hint">When on, Sienna may speak up on her own — reflections,
    the daily eavesdrop, and camera glances can start a conversation. When off,
    she only ever answers.</p>
    <span id="autonomy-status" class="sienna-status"></span>
  `;

  const checkbox = root.querySelector("#sienna-autonomy");
  const statusEl = root.querySelector("#autonomy-status");

  checkbox.addEventListener("change", () => {
    statusEl.textContent = "";
    client.send({ type: "set_autonomy", enabled: checkbox.checked });
  });
  client.addEventListener("msg:autonomy_state", (ev) => { checkbox.checked = !!ev.detail.enabled; });
  client.addEventListener("msg:command_error", (ev) => {
    if (ev.detail.reason === "agent_unavailable") {
      checkbox.checked = false;
      statusEl.textContent = "Sienna's agent isn't configured (needs MongoDB + Gemini).";
    }
  });
}
