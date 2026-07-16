export function initCameraPanel(client) {
  const root = document.getElementById("panel-camera");
  root.innerHTML = `
    <h2>Camera</h2>
    <div style="width: 640px; height: 480px; max-width: 100%; aspect-ratio: 4 / 3; background: var(--panel-2); border: 1px solid var(--border); border-radius: var(--radius-1); display: flex; align-items: center; justify-content: center; color: var(--muted); margin: 0 auto;" id="cam-frame">no snapshot yet</div>
    <div style="margin-top: 8px;">
      <button id="cam-snap" class="primary">Take snapshot</button>
    </div>
  `;
  const frame = root.querySelector("#cam-frame");
  const snapBtn = root.querySelector("#cam-snap");

  snapBtn.addEventListener("click", () => client.send({ type: "snapshot" }));

  client.addEventListener("bin:2", (ev) => {
    const buf = ev.detail; // Uint8Array of JPEG bytes (no tag)
    const blob = new Blob([buf], { type: "image/jpeg" });
    const url = URL.createObjectURL(blob);
    frame.innerHTML = `<img src="${url}" style="max-width: 100%; height: auto;">`;
  });
}
