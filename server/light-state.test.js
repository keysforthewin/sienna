import { test } from "node:test";
import assert from "node:assert/strict";
import { createLightState } from "./light-state.js";

test("starts all-off with bindi unset", () => {
  const s = createLightState();
  assert.equal(s.describe(), "necklace off, blue hat light off, bindi unset");
});

test("observe tracks set_blue_led / set_flash_led / set_rgb", () => {
  const s = createLightState();
  s.observe({ type: "set_blue_led", on: true });
  s.observe({ type: "set_flash_led", on: true });
  s.observe({ type: "set_rgb", r: 255, g: 100, b: 0 });
  assert.equal(s.describe(), "necklace on, blue hat light on, bindi glowing (255, 100, 0)");
});

test("observe ignores unrelated and malformed messages", () => {
  const s = createLightState();
  s.observe({ type: "play_tone", hz: 440 });
  s.observe(null);
  s.observe("set_rgb");
  assert.equal(s.describe(), "necklace off, blue hat light off, bindi unset");
});

test("an all-zero rgb reads as bindi off, not glowing", () => {
  const s = createLightState();
  s.observe({ type: "set_rgb", r: 0, g: 0, b: 0 });
  assert.equal(s.describe(), "necklace off, blue hat light off, bindi off");
});

test("later observes overwrite earlier state", () => {
  const s = createLightState();
  s.observe({ type: "set_blue_led", on: true });
  s.observe({ type: "set_blue_led", on: false });
  assert.match(s.describe(), /blue hat light off/);
});

test("reset returns to boot state (device reconnect = firmware booted dark)", () => {
  const s = createLightState();
  s.observe({ type: "set_flash_led", on: true });
  s.observe({ type: "set_rgb", r: 1, g: 2, b: 3 });
  s.reset();
  assert.equal(s.describe(), "necklace off, blue hat light off, bindi unset");
});
