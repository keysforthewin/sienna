import { test } from "node:test";
import assert from "node:assert/strict";
import { isWithinActiveHours } from "./active-hours.js";

const at = (iso) => new Date(Date.parse(iso));

// Default window is 7am–10pm in America/Toronto (Eastern). June is EDT (UTC-4).
test("inside the 7am–10pm Eastern window is true", () => {
  assert.equal(isWithinActiveHours(at("2026-06-13T12:00:00Z")), true); // 8:00am EDT
});

test("7am Eastern is inclusive (window start)", () => {
  assert.equal(isWithinActiveHours(at("2026-06-13T11:00:00Z")), true); // 7:00am EDT
});

test("10pm Eastern is exclusive (window end)", () => {
  assert.equal(isWithinActiveHours(at("2026-06-13T02:00:00Z")), false); // 10:00pm EDT (Jun 12)
});

test("before 7am Eastern is false", () => {
  assert.equal(isWithinActiveHours(at("2026-06-13T10:00:00Z")), false); // 6:00am EDT
});

test("midnight Eastern is false", () => {
  assert.equal(isWithinActiveHours(at("2026-06-13T04:00:00Z")), false); // 12:00am EDT
});

test("tracks EST in winter, not a fixed offset", () => {
  // 06:30 EST in January — would read 07:30 (inside) if we wrongly assumed UTC-4 year-round.
  assert.equal(isWithinActiveHours(at("2026-01-15T11:30:00Z")), false);
});

test("custom hours support an overnight wrap-around window", () => {
  const opts = { startHour: 22, endHour: 6 };
  assert.equal(isWithinActiveHours(at("2026-06-13T04:00:00Z"), opts), true);  // 12:00am EDT
  assert.equal(isWithinActiveHours(at("2026-06-13T16:00:00Z"), opts), false); // 12:00pm EDT
});
