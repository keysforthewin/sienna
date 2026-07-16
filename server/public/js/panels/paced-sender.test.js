import { test } from "node:test";
import assert from "node:assert/strict";
import { createPacedSender } from "./paced-sender.js";

// Fake metronome: capture the registered tick fn so tests fire it by hand, and
// track whether an interval is currently armed (mirrors reflection.test.js).
function makeScheduler() {
  let armed = null;
  const scheduler = (fn) => { armed = { fn }; return armed; };
  const clearScheduler = (h) => { if (h === armed) armed = null; };
  const tick = () => { if (armed) armed.fn(); };
  return { scheduler, clearScheduler, tick, isArmed: () => armed !== null };
}

function setup(opts = {}) {
  const sends = [];
  const s = makeScheduler();
  const sender = createPacedSender({
    send: (f) => sends.push(f),
    scheduler: s.scheduler,
    clearScheduler: s.clearScheduler,
    ...opts,
  });
  return { sender, sends, s };
}

test("sends exactly one frame per tick, in order; nothing before the first tick", () => {
  const { sender, sends, s } = setup();
  sender.enqueue("A");
  sender.enqueue("B");
  sender.enqueue("C");
  sender.start();
  assert.deepEqual(sends, [], "nothing is sent synchronously on start");
  s.tick(); assert.deepEqual(sends, ["A"]);
  s.tick(); assert.deepEqual(sends, ["A", "B"]);
  s.tick(); assert.deepEqual(sends, ["A", "B", "C"]);
  s.tick(); assert.deepEqual(sends, ["A", "B", "C"], "idle tick is a no-op");
});

test("drops the OLDEST frame when oversupplied past maxQueue", () => {
  const { sender, sends, s } = setup({ maxQueue: 2 });
  assert.equal(sender.enqueue("A"), true);
  assert.equal(sender.enqueue("B"), true);
  assert.equal(sender.enqueue("C"), false, "overflow enqueue reports a drop");
  assert.equal(sender.enqueue("D"), false);
  assert.equal(sender.size(), 2);
  sender.start();
  s.tick(); s.tick(); s.tick();
  assert.deepEqual(sends, ["C", "D"], "oldest A,B dropped; newest kept");
});

test("stop() clears the queue, cancels the timer, and silences later ticks", () => {
  const { sender, sends, s } = setup();
  sender.enqueue("A");
  sender.enqueue("B");
  sender.start();
  sender.stop();
  assert.equal(sender.size(), 0);
  assert.equal(s.isArmed(), false);
  s.tick();
  assert.deepEqual(sends, [], "post-stop tick sends nothing");
});

test("start() is idempotent — no double-arming, still one send per tick", () => {
  const { sender, sends, s } = setup();
  sender.start();
  sender.start();
  sender.enqueue("A");
  sender.enqueue("B");
  s.tick();
  assert.deepEqual(sends, ["A"], "a single tick drains exactly one frame");
});

test("stop() is idempotent and safe to call twice", () => {
  const { sender, s } = setup();
  sender.start();
  sender.stop();
  assert.doesNotThrow(() => sender.stop());
  assert.equal(s.isArmed(), false);
});
