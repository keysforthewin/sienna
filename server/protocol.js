import { z } from "zod";

const u8 = z.number().int().min(0).max(255);
const ref = z.string().min(1).max(64);

// ---- Device → server messages ----
export const HelloMsg = z.object({
  type: z.literal("hello"),
  token: z.string().min(1),
  fw_version: z.string().optional(),
});

export const StateName = z.enum([
  "BOOTING",
  "BLE_PROVISIONING",
  "WIFI_TRYING",
  "WS_OPENING",
  "ONLINE",
  "RECOVERING",
]);

export const StateMsg = z.object({
  type: z.literal("state"),
  state: StateName,
  ip: z.string().nullable().optional(),
  wifi_rssi: z.number().int().nullable().optional(),
  last_error: z.string().nullable().optional(),
});

export const MicRmsMsg = z.object({
  type: z.literal("mic_rms"),
  rms: z.number(),
  peak: z.number(),
  ts_ms: z.number().int(),
});

export const LdrMsg = z.object({
  type: z.literal("ldr"),
  value: z.number().int().min(0).max(4095),
  ts_ms: z.number().int(),
});

export const AckMsg = z.object({
  type: z.literal("ack"),
  ref: ref,
  ok: z.boolean(),
  error: z.string().optional(),
});

export const EventMsg = z.object({
  type: z.literal("event"),
  name: z.string(),
}).passthrough();

// Physical button edges (debounced on-device). id "ptt" is the GPIO 45
// push-to-talk button; the field exists so future buttons share the shape.
export const ButtonMsg = z.object({
  type: z.literal("button"),
  id: z.string().min(1).max(16),
  pressed: z.boolean(),
  ts_ms: z.number().int(),
});

// Periodic link-health telemetry (every ~5 s while online): Wi-Fi RSSI, free /
// min-ever free heap, last Wi-Fi disconnect reason code + drop count since
// boot. Instrumentation for diagnosing the random 1006 device disconnects.
export const NetStatsMsg = z.object({
  type: z.literal("net_stats"),
  rssi: z.number().int(),
  heap: z.number().int().nonnegative().optional(),
  min_heap: z.number().int().nonnegative().optional(),
  disc_reason: z.number().int().optional(),
  disc_count: z.number().int().nonnegative().optional(),
  ts_ms: z.number().int(),
});

// ---- Sienna agent device-RPC responses (new firmware) ----
// Each carries the request's `ref` so the server can correlate exactly; older
// firmware that omits it falls back to next-message-of-type matching.
export const WifiScanMsg = z.object({
  type: z.literal("wifi_scan"),
  ref: ref.optional(),
  networks: z.array(z.object({
    ssid: z.string(),
    rssi: z.number().int(),
    channel: z.number().int().optional(),
    secured: z.boolean().optional(),
  })),
});

export const BleScanMsg = z.object({
  type: z.literal("ble_scan"),
  ref: ref.optional(),
  devices: z.array(z.object({
    name: z.string(),
    rssi: z.number().int(),
    addr: z.string().optional(),
  })),
});

export const TimerSetMsg = z.object({
  type: z.literal("timer_set"),
  ref: ref.optional(),
  id: z.number().int().nonnegative(),
  seconds: z.number().int(),
  label: z.string().optional(),
});

export const TimerFiredMsg = z.object({
  type: z.literal("timer_fired"),
  id: z.number().int().nonnegative(),
  label: z.string().optional(),
});

export const DeviceMsg = z.discriminatedUnion("type", [
  HelloMsg, StateMsg, MicRmsMsg, LdrMsg, AckMsg, EventMsg,
  ButtonMsg, NetStatsMsg,
  WifiScanMsg, BleScanMsg, TimerSetMsg, TimerFiredMsg,
]);

// ---- Browser → server commands (also forwarded to device) ----
export const SetBlueLedCmd = z.object({ type: z.literal("set_blue_led"), ref: ref, on: z.boolean() });
export const SetBlueFlashCmd = z.object({ type: z.literal("set_blue_flash"), ref: ref, on: z.boolean() });
export const SetFlashLedCmd = z.object({ type: z.literal("set_flash_led"), ref: ref, on: z.boolean() });
export const SetRgbCmd = z.object({ type: z.literal("set_rgb"), ref: ref, r: u8, g: u8, b: u8 });
export const ReadLdrCmd = z.object({ type: z.literal("read_ldr"), ref: ref });
export const SetLdrRateCmd = z.object({ type: z.literal("set_ldr_rate"), ref: ref, hz: z.number().min(0).max(50) });
export const StartRecordingCmd = z.object({ type: z.literal("start_recording"), ref: ref });
export const StopRecordingCmd = z.object({ type: z.literal("stop_recording"), ref: ref });
// Consumed server-side by the mic-stream arbiter; never forwarded to the device
// (the device only knows start_recording/stop_recording, which the arbiter sends).
export const StartListeningCmd = z.object({ type: z.literal("start_listening"), ref: ref });
export const StopListeningCmd = z.object({ type: z.literal("stop_listening"), ref: ref });
export const PlayToneCmd = z.object({
  type: z.literal("play_tone"), ref: ref,
  hz: z.number().min(20).max(20000),
  duration_ms: z.number().int().min(1).max(10000),
  amplitude: z.number().min(0).max(1),
});
export const PlayAudioStartCmd = z.object({
  type: z.literal("play_audio_start"), ref: ref,
  sample_rate: z.literal(16000),
  bits: z.literal(16),
  channels: z.literal(1),
});
export const PlayAudioEndCmd = z.object({ type: z.literal("play_audio_end"), ref: ref });
// Abort playback and flush the device speaker DMA immediately (vs play_audio_end,
// which lets a finite clip's tail drain). Sent by Hold-to-talk on release so the
// live stream cuts off promptly instead of draining a buffered tail.
export const StopAudioCmd = z.object({ type: z.literal("stop_audio"), ref: ref });
export const SnapshotCmd = z.object({ type: z.literal("snapshot"), ref: ref });
export const RebootCmd = z.object({ type: z.literal("reboot"), ref: ref });
// Sienna agent device-RPC commands (forwarded to the device by device-rpc.js).
export const ScanWifiCmd = z.object({ type: z.literal("scan_wifi"), ref: ref });
export const ScanBleCmd = z.object({ type: z.literal("scan_ble"), ref: ref });
export const SetTimerCmd = z.object({
  type: z.literal("set_timer"), ref: ref,
  seconds: z.number().int().min(1).max(86400),
  label: z.string().max(64).optional(),
});
export const CancelTimerCmd = z.object({
  type: z.literal("cancel_timer"), ref: ref,
  id: z.number().int().nonnegative(),
});
// Consumed server-side by the Sienna agent; never forwarded to the device
// (like start_transcription). The agent runs in the server.
export const AgentInputCmd = z.object({
  type: z.literal("agent_input"), ref: ref,
  text: z.string().min(1).max(2000),
});
export const SetAutonomyCmd = z.object({
  type: z.literal("set_autonomy"), ref: ref,
  enabled: z.boolean(),
});
// Consumed server-side: the master speaker volume / gain (see volume.js). Never
// forwarded to the device — the firmware has no volume control.
export const SetVolumeCmd = z.object({
  type: z.literal("set_volume"), ref: ref,
  percent: z.number().int().min(0).max(400),
});
// Consumed server-side: the music-playback pacing knob (ms between frames; see
// audio-out.js, which clamps to its own [MIN,MAX]). Never forwarded to the device.
export const SetMusicPacingCmd = z.object({
  type: z.literal("set_music_pacing"), ref: ref,
  ms: z.number().int().min(40).max(300),
});
// Consumed server-side: the voice (TTS) pacing knob — same shape as music, clamped to
// its own [TTS_PACE_MIN,TTS_PACE_MAX] in audio-out.js. Never forwarded to the device.
export const SetTtsPacingCmd = z.object({
  type: z.literal("set_tts_pacing"), ref: ref,
  ms: z.number().int().min(40).max(300),
});

export const BrowserMsg = z.discriminatedUnion("type", [
  SetBlueLedCmd, SetBlueFlashCmd, SetFlashLedCmd, SetRgbCmd,
  ReadLdrCmd, SetLdrRateCmd,
  StartRecordingCmd, StopRecordingCmd,
  StartListeningCmd, StopListeningCmd,
  PlayToneCmd, PlayAudioStartCmd, PlayAudioEndCmd, StopAudioCmd,
  SnapshotCmd, RebootCmd,
  ScanWifiCmd, ScanBleCmd, SetTimerCmd, CancelTimerCmd,
  AgentInputCmd, SetAutonomyCmd, SetVolumeCmd, SetMusicPacingCmd, SetTtsPacingCmd,
]);

export function parseDeviceMessage(raw) {
  return DeviceMsg.parse(JSON.parse(raw));
}

export function parseBrowserMessage(raw) {
  return BrowserMsg.parse(JSON.parse(raw));
}

// Server-side: re-validate before sending to device, attach a fresh ref.
export function buildServerCommand(cmd, refValue) {
  const withRef = { ...cmd, ref: refValue };
  const validated = BrowserMsg.parse(withRef);
  return JSON.stringify(validated);
}

// Binary frame tags (as bytes prepended to binary WS frames)
export const BinTag = Object.freeze({
  RECORDED_PCM: 0x01,
  JPEG: 0x02,
  PLAYBACK_PCM: 0x03,
});
