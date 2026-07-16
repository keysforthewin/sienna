# Sienna

A push-to-talk voice companion that lives on your desk. Sienna is an
ESP32-S3 device (mic, speaker, camera, LEDs, light sensor) paired with a
server-side agent — a Claude/Gemini tool-use loop with persistent memory and
an evolving personality. Hold the button, talk to her, and she talks back.

## What she can do

- **Push-to-talk conversation** — a physical button opens the mic; speech is
  transcribed in realtime (ElevenLabs Scribe) and routed to the agent, whose
  reply is streamed back to the speaker as expressive TTS (ElevenLabs v3,
  sentence-chunked for fast first audio).
- **Memory and personality** — conversations, saved facts, and a
  self-editable personality persist in MongoDB and are recalled into every
  prompt. She reflects on interactions after quiet delays and may remember,
  refine herself, or (if you allow it) speak up on her own.
- **Sight and senses** — a camera tool for looking around, a light sensor,
  and once-a-day ambient behaviors (a brief listen, a glance at the room)
  gated behind an autonomy toggle and waking hours.
- **Music** — a YouTube jukebox (yt-dlp + ffmpeg) with a no-repeat history,
  loudness capping, ducking under her voice, and resume-after-restart.
- **Device tools** — LEDs, tones, timers, Wi-Fi/BLE scans, volume — all
  driven by the agent over a WebSocket bridge.
- **Web dashboard** — provisioning (Web Bluetooth), live camera/audio/LED
  panels, a speech monitor, and a card view of her messages, memories, and
  personality history.

## Repository layout

```
esp32/
  sienna_dashboard/    Main firmware: BLE provisioning + Wi-Fi + WS dashboard client
  mic_speaker_test/    (legacy) I2S mic + speaker bring-up
  speaker_test/        (legacy) Standalone speaker test
  led_test/            (legacy) RGB + blue LED test
  lsr_test/            (legacy) LDR test
server/
  index.js             Express + WS dashboard backend
  public/              Static dashboard SPA (provision + dashboard)
```

## Hardware

Built on the Freenove ESP32-S3-WROOM CAM board (FNK0085) with an INMP441
I2S microphone, a MAX98357A I2S amplifier, an OV2640 camera, an LDR, RGB +
status LEDs, and a push-to-talk button. Audio is 16 kHz mono, full-duplex
(mic and speaker on separate I2S controllers).

| Component | Signal | GPIO |
|-----------|--------|------|
| OV2640 camera | 14 lines | 4–18 (Freenove-fixed) |
| LDR | ADC1_CH0 | 1 |
| Blue LED | digital | 2 |
| Flashing LED string | digital | 3 |
| INMP441 mic | SD / SCK / WS | 14 / 38 / 39 |
| MAX98357A amp | BCLK / LRC / DIN | 40 / 41 / 42 |
| RGB LED | R / G / B | 47 / 48 / 21 |
| BOOT button | digital | 0 |
| PTT button | digital, active-low | 45 |

`esp32/sienna_dashboard/pins.h` is the canonical pin map.

## Quick start

### Server

Node 22+ required.

```bash
cd server
cp .env.example .env    # set DASHBOARD_TOKEN; add API keys for the features you want
npm install
npm test
npm start               # http://localhost:3387
```

Or with Docker (brings up the server plus MongoDB, which enables the agent's
memory):

```bash
cd server
cp .env.example .env
docker compose up --build
```

Open `/` for BLE provisioning (Chrome/Edge — Web Bluetooth) and
`/dashboard.html` for the live dashboard.

Every integration is optional and degrades gracefully — see
`server/.env.example` for the full annotated list:

- `ELEVENLABS_API_KEY` — TTS voice + realtime transcription (push-to-talk)
- `ANTHROPIC_API_KEY` and/or `GEMINI_API_KEY` — the agent's reasoning
- `MONGODB_URI` — memory, personality, and settings persistence (the agent
  requires this plus at least one reasoning key; Docker wires it up for you)

### Firmware

Open `esp32/sienna_dashboard/` in the Arduino IDE with the
"esp32 by Espressif Systems" board package (>= 3.0.0). Board: **ESP32S3 Dev
Module**, USB CDC On Boot: Enabled. The sketch ships a `partitions.csv`
("Huge APP" — 3 MB app) that arduino-esp32 auto-detects; if the build hits
the stock 1.25 MB app ceiling, select **Tools → Partition Scheme → Huge APP
(3MB No OTA/1MB SPIFFS)** manually.

Flash the board, then provision Wi-Fi and the server address over BLE from
the dashboard's provisioning page.

## How it fits together

The device speaks a small JSON + binary-frame protocol over a WebSocket to
the server, which bridges it to browser dashboards and to the agent. The
server is the brain: transcription, TTS synthesis, the agent loop, music
decoding, and volume all run server-side, so the firmware stays a thin,
non-blocking I/O client polled from a single cooperative `loop()`.
