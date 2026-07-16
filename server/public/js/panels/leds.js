export function initLedPanel(client) {
  const root = document.getElementById("panel-leds");
  root.innerHTML = `
    <h2>LEDs</h2>
    <div style="display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: center;">
      <span>Blue LED</span>          <button data-on="false" id="led-blue">off</button>
      <span>Flashing string</span>   <button data-on="false" id="led-flash">off</button>
    </div>
    <div style="margin-top: 12px;">
      <div style="display: flex; gap: 8px; align-items: center;">
        <input type="color" id="rgb-picker" value="#000000">
        <button id="rgb-off">off</button>
      </div>
    </div>
  `;
  const blueBtn  = root.querySelector("#led-blue");
  const flashBtn = root.querySelector("#led-flash");
  const picker   = root.querySelector("#rgb-picker");
  const offBtn   = root.querySelector("#rgb-off");

  function toggle(btn, type) {
    return () => {
      const newOn = btn.dataset.on !== "true";
      btn.dataset.on = String(newOn);
      btn.textContent = newOn ? "on" : "off";
      client.send({ type, on: newOn });
    };
  }
  blueBtn.addEventListener("click", toggle(blueBtn, "set_blue_led"));
  flashBtn.addEventListener("click", toggle(flashBtn, "set_flash_led"));

  picker.addEventListener("input", () => {
    const hex = picker.value;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    client.send({ type: "set_rgb", r, g, b });
  });
  offBtn.addEventListener("click", () => {
    picker.value = "#000000";
    client.send({ type: "set_rgb", r: 0, g: 0, b: 0 });
  });
}
