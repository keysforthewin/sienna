import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseDeviceMessage,
  parseBrowserMessage,
  buildServerCommand,
  HelloMsg,
  StateMsg,
  SetRgbCmd,
  StartRecordingCmd,
  PlayAudioStartCmd,
} from "./protocol.js";

test("parses device hello", () => {
  const m = parseDeviceMessage('{"type":"hello","token":"abc","fw_version":"0.1.0"}');
  assert.equal(m.type, "hello");
  assert.equal(m.token, "abc");
});

test("parses device state", () => {
  const m = parseDeviceMessage(
    '{"type":"state","state":"ONLINE","ip":"192.168.1.42","wifi_rssi":-54}'
  );
  assert.equal(m.state, "ONLINE");
  assert.equal(m.ip, "192.168.1.42");
});

test("parses device mic_rms", () => {
  const m = parseDeviceMessage('{"type":"mic_rms","rms":1234,"peak":5678,"ts_ms":1000}');
  assert.equal(m.rms, 1234);
  assert.equal(m.peak, 5678);
});

test("rejects unknown device type", () => {
  assert.throws(() => parseDeviceMessage('{"type":"bogus"}'));
});

test("rejects malformed JSON", () => {
  assert.throws(() => parseDeviceMessage("not json"));
});

test("parses browser set_rgb", () => {
  const m = parseBrowserMessage('{"type":"set_rgb","ref":"r1","r":255,"g":0,"b":128}');
  assert.equal(m.type, "set_rgb");
  assert.equal(m.r, 255);
});

test("rejects rgb out of range", () => {
  assert.throws(() => parseBrowserMessage('{"type":"set_rgb","ref":"r1","r":300,"g":0,"b":0}'));
});

test("parses browser stop_audio and round-trips through buildServerCommand", () => {
  const m = parseBrowserMessage('{"type":"stop_audio","ref":"s1"}');
  assert.equal(m.type, "stop_audio");
  const out = JSON.parse(buildServerCommand({ type: "stop_audio" }, "srv-1"));
  assert.equal(out.type, "stop_audio");
  assert.equal(out.ref, "srv-1");
});

test("parses start_recording", () => {
  const m = parseBrowserMessage('{"type":"start_recording","ref":"r2"}');
  assert.equal(m.type, "start_recording");
  assert.equal(m.ref, "r2");
});

test("browser transcription commands are gone (voice input is PTT-only)", () => {
  assert.throws(() => parseBrowserMessage('{"type":"start_transcription","ref":"t1"}'));
  assert.throws(() => parseBrowserMessage('{"type":"stop_transcription","ref":"t2"}'));
});

test("buildServerCommand attaches ref", () => {
  const out = JSON.parse(buildServerCommand({ type: "set_rgb", r: 1, g: 2, b: 3 }, "ref-123"));
  assert.equal(out.ref, "ref-123");
  assert.equal(out.type, "set_rgb");
});

test("buildServerCommand rejects invalid command", () => {
  assert.throws(() => buildServerCommand({ type: "set_rgb", r: 999 }, "r"));
});

test("parses device button press/release", () => {
  const m = parseDeviceMessage('{"type":"button","id":"ptt","pressed":true,"ts_ms":1000}');
  assert.equal(m.type, "button");
  assert.equal(m.id, "ptt");
  assert.equal(m.pressed, true);
  assert.equal(m.ts_ms, 1000);
  const r = parseDeviceMessage('{"type":"button","id":"ptt","pressed":false,"ts_ms":2000}');
  assert.equal(r.pressed, false);
});

test("rejects button without id or with non-boolean pressed", () => {
  assert.throws(() => parseDeviceMessage('{"type":"button","pressed":true,"ts_ms":1}'));
  assert.throws(() => parseDeviceMessage('{"type":"button","id":"ptt","pressed":"yes","ts_ms":1}'));
});

test("parses device net_stats telemetry", () => {
  const m = parseDeviceMessage(
    '{"type":"net_stats","rssi":-62,"heap":123456,"min_heap":98765,"disc_reason":200,"disc_count":3,"ts_ms":5000}'
  );
  assert.equal(m.type, "net_stats");
  assert.equal(m.rssi, -62);
  assert.equal(m.heap, 123456);
  assert.equal(m.min_heap, 98765);
  assert.equal(m.disc_reason, 200);
  assert.equal(m.disc_count, 3);
});

test("net_stats tolerates missing optional fields, rejects missing rssi", () => {
  const m = parseDeviceMessage('{"type":"net_stats","rssi":-70,"ts_ms":1}');
  assert.equal(m.rssi, -70);
  assert.throws(() => parseDeviceMessage('{"type":"net_stats","ts_ms":1}'));
});

test("set_wake_threshold is gone (wake word removed)", () => {
  assert.throws(() =>
    parseBrowserMessage('{"type":"set_wake_threshold","ref":"r1","threshold":0.6}')
  );
});

// ---- Sienna agent additions ----

test("parses device wifi_scan and ble_scan", () => {
  const w = parseDeviceMessage('{"type":"wifi_scan","ref":"r1","networks":[{"ssid":"home","rssi":-50,"secure":true}]}');
  assert.equal(w.networks[0].ssid, "home");
  const b = parseDeviceMessage('{"type":"ble_scan","ref":"r2","devices":[{"name":"buds","rssi":-70,"addr":"aa:bb"}]}');
  assert.equal(b.devices[0].name, "buds");
});

test("parses device timer_set and timer_fired", () => {
  const s = parseDeviceMessage('{"type":"timer_set","ref":"r1","id":3,"seconds":60,"label":"tea"}');
  assert.equal(s.id, 3);
  const f = parseDeviceMessage('{"type":"timer_fired","id":3,"label":"tea"}');
  assert.equal(f.type, "timer_fired");
  assert.equal(f.id, 3);
});

test("buildServerCommand validates scan_wifi / scan_ble / set_timer / cancel_timer", () => {
  assert.equal(JSON.parse(buildServerCommand({ type: "scan_wifi" }, "r1")).ref, "r1");
  assert.equal(JSON.parse(buildServerCommand({ type: "scan_ble" }, "r2")).ref, "r2");
  const t = JSON.parse(buildServerCommand({ type: "set_timer", seconds: 60, label: "tea" }, "r3"));
  assert.equal(t.seconds, 60);
  assert.equal(JSON.parse(buildServerCommand({ type: "cancel_timer", id: 3 }, "r4")).id, 3);
});

test("rejects set_timer out of range", () => {
  assert.throws(() => buildServerCommand({ type: "set_timer", seconds: 0 }, "r"));
  assert.throws(() => buildServerCommand({ type: "set_timer", seconds: 999999 }, "r"));
});

test("parses agent_input and set_autonomy (server-consumed browser commands)", () => {
  const a = parseBrowserMessage('{"type":"agent_input","ref":"r1","text":"hello sienna"}');
  assert.equal(a.text, "hello sienna");
  const s = parseBrowserMessage('{"type":"set_autonomy","ref":"r2","enabled":true}');
  assert.equal(s.enabled, true);
});

test("rejects empty/oversized agent_input text", () => {
  assert.throws(() => parseBrowserMessage('{"type":"agent_input","ref":"r1","text":""}'));
  assert.throws(() => parseBrowserMessage(JSON.stringify({ type: "agent_input", ref: "r1", text: "x".repeat(2001) })));
});

test("start_listening and stop_listening parse as browser commands", () => {
  const start = parseBrowserMessage(JSON.stringify({ type: "start_listening", ref: "b1" }));
  assert.equal(start.type, "start_listening");
  assert.equal(start.ref, "b1");
  const stop = parseBrowserMessage(JSON.stringify({ type: "stop_listening", ref: "b2" }));
  assert.equal(stop.type, "stop_listening");
});

test("buildServerCommand accepts set_blue_flash", () => {
  const json = buildServerCommand({ type: "set_blue_flash", on: true }, "r1");
  assert.deepEqual(JSON.parse(json), { type: "set_blue_flash", ref: "r1", on: true });
});
