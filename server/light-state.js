// Server-side cache of the device's LED state, fed by observing the outgoing
// command stream (bridge.onDeviceCommand) — the single choke point both
// Sienna's tools (device-rpc) and the dashboard LED panel (ws-browser
// forwarding) pass through. The firmware never reports LED state, so index.js
// calls reset() on device connect: after a true reboot the firmware boots
// dark, which reset matches; after a mere Wi-Fi-blip reconnect the device
// actually keeps its LEDs, so the tracker briefly understates them until the
// next command — the deliberate lesser error of the two. The PTT blue-LED
// flash is device-local (the firmware restores the prior state on release)
// and is correctly invisible here.

export function createLightState() {
  let blue = false;
  let white = false;
  let rgb = null; // {r,g,b} once commanded; null = never set since boot

  function observe(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "set_blue_led") blue = !!msg.on;
    else if (msg.type === "set_flash_led") white = !!msg.on;
    else if (msg.type === "set_rgb") rgb = { r: msg.r | 0, g: msg.g | 0, b: msg.b | 0 };
  }

  function reset() {
    blue = false;
    white = false;
    rgb = null;
  }

  // One human-readable line for the prompt's "Right now" block, in her own
  // vocabulary (necklace / blue hat light / bindi).
  function describe() {
    const bindi =
      rgb == null ? "bindi unset"
      : rgb.r === 0 && rgb.g === 0 && rgb.b === 0 ? "bindi off"
      : `bindi glowing (${rgb.r}, ${rgb.g}, ${rgb.b})`;
    return `necklace ${white ? "on" : "off"}, blue hat light ${blue ? "on" : "off"}, ${bindi}`;
  }

  return { observe, reset, describe };
}
