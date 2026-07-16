// Header view-switcher: toggles the two top-level areas (Input/Output vs Sienna).
// A pure DOM-visibility toggle via the `hidden` attribute — panels inside the
// hidden view keep their JS state and animation loops alive (display:none just
// stops them painting), so switching back is instant and nothing re-inits. The
// last-selected view is persisted in localStorage, mirroring the volume-slider
// pattern. The `.view-tab` buttons are whitelisted in dashboard.js's
// disableAllControls so they stay clickable when the device goes offline.
const VIEW_KEY = "sienna.view";
const VIEWS = ["io", "sienna", "usage"];

export function initViews() {
  const tabs = Array.from(document.querySelectorAll(".view-tab"));
  const panes = {
    io:     document.getElementById("view-io"),
    sienna: document.getElementById("view-sienna"),
    usage:  document.getElementById("view-usage"),
  };
  if (!tabs.length || !panes.io || !panes.sienna || !panes.usage) return;

  let current = localStorage.getItem(VIEW_KEY);
  if (!VIEWS.includes(current)) current = "io";

  function show(view) {
    current = view;
    localStorage.setItem(VIEW_KEY, view);
    for (const v of VIEWS) panes[v].hidden = v !== view;
    for (const t of tabs) {
      const on = t.dataset.view === view;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
    }
  }

  for (const t of tabs) t.addEventListener("click", () => show(t.dataset.view));
  show(current);
}
