// mic_speaker_test.ino
//
// Minimal bring-up test for an ESP32-S3-WROOM-1 with:
//   * INMP441 I2S MEMS microphone (RX) -> log sample values to Serial
//   * MAX98357A I2S class-D amplifier (TX) -> play a solid 440 Hz tone
//
// Wiring
// ------
// INMP441 (mic, I2S RX)            ESP32-S3
//   VDD  ----------------------------- 3V3
//   GND  ----------------------------- GND
//   L/R  ----------------------------- GND   (left channel)
//   SCK  ----------------------------- GPIO 8
//   WS   ----------------------------- GPIO 18
//   SD   ----------------------------- GPIO 3
//
// MAX98357A (amp, I2S TX)          ESP32-S3
//   VIN  ----------------------------- 5V (or 3V3)
//   GND  ----------------------------- GND
//   BCLK ----------------------------- GPIO 16
//   LRC  ----------------------------- GPIO 17
//   DIN  ----------------------------- GPIO 15
//
// Build: Arduino IDE with "esp32 by Espressif Systems" >= 3.0.0,
//        Board: "ESP32S3 Dev Module", USB CDC On Boot: Enabled.

#include <ESP_I2S.h>
#include <math.h>

// ---- Mic (INMP441, I2S RX) ----
static const int MIC_SCK = 8;
static const int MIC_WS  = 18;
static const int MIC_SD  = 3;

// ---- Speaker (MAX98357A, I2S TX) ----
static const int SPK_BCLK = 16;
static const int SPK_LRC  = 17;
static const int SPK_DIN  = 15;

// ---- Audio format ----
static const uint32_t SAMPLE_RATE = 16000;
static const float    TONE_HZ     = 440.0f;
static const int16_t  TONE_AMP    = 8000;   // ~25% of full scale

I2SClass micI2S;
I2SClass spkI2S;

static void fatal(const char *msg) {
  Serial.print("FATAL: ");
  Serial.println(msg);
  while (true) { delay(1000); }
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println();
  Serial.println("=== ESP32-S3 mic + speaker test ===");

  // Mic: 32-bit mono left, RX only.
  micI2S.setPins(MIC_SCK, MIC_WS, /*dout=*/-1, /*din=*/MIC_SD);
  if (!micI2S.begin(I2S_MODE_STD, SAMPLE_RATE,
                    I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_MONO,
                    I2S_STD_SLOT_LEFT)) {
    fatal("micI2S.begin failed");
  }
  Serial.println("Mic ready.");

  // Speaker: 16-bit mono, TX only.
  spkI2S.setPins(SPK_BCLK, SPK_LRC, /*dout=*/SPK_DIN, /*din=*/-1);
  if (!spkI2S.begin(I2S_MODE_STD, SAMPLE_RATE,
                    I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO)) {
    fatal("spkI2S.begin failed");
  }
  Serial.println("Speaker ready. Playing 440 Hz tone, logging mic...");
  Serial.println();
}

void loop() {
  // ---- Push a chunk of sine-wave samples to the speaker ----
  static const size_t TONE_CHUNK = 256;
  static int16_t toneBuf[TONE_CHUNK];
  static float phase = 0.0f;
  const float phaseInc = 2.0f * (float)M_PI * TONE_HZ / (float)SAMPLE_RATE;

  for (size_t i = 0; i < TONE_CHUNK; i++) {
    toneBuf[i] = (int16_t)(sinf(phase) * TONE_AMP);
    phase += phaseInc;
    if (phase > 2.0f * (float)M_PI) phase -= 2.0f * (float)M_PI;
  }
  spkI2S.write(reinterpret_cast<const uint8_t *>(toneBuf),
               TONE_CHUNK * sizeof(int16_t));

  // ---- Read a chunk of mic samples and log peak/RMS ----
  static const size_t MIC_CHUNK = 256;
  static int32_t micBuf[MIC_CHUNK];

  size_t got_bytes = micI2S.readBytes(reinterpret_cast<char *>(micBuf),
                                      MIC_CHUNK * sizeof(int32_t));
  size_t got = got_bytes / sizeof(int32_t);

  if (got > 0) {
    int32_t peak = 0;
    double  sumsq = 0.0;
    for (size_t i = 0; i < got; i++) {
      // INMP441 24-bit sample left-justified in int32.
      int32_t s = micBuf[i] >> 8;  // -> signed 24-bit
      if (s < 0 ? -s > peak : s > peak) peak = s < 0 ? -s : s;
      sumsq += (double)s * (double)s;
    }
    double rms = sqrt(sumsq / got);

    static uint32_t lastLog = 0;
    uint32_t now = millis();
    if (now - lastLog >= 200) {  // log ~5x/sec so Serial isn't flooded
      lastLog = now;
      Serial.print("mic peak=");
      Serial.print(peak);
      Serial.print("  rms=");
      Serial.println(rms, 1);
    }
  }
}
