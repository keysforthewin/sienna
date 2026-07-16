// speaker_test.ino
//
// Isolated bring-up test for the MAX98357A I2S class-D amplifier on an
// ESP32-S3-WROOM-1. Continuously cycles through a short arpeggio of tones
// so you can confirm the speaker, amp, and I2S TX wiring are working.
//
// Wiring
// ------
// MAX98357A (amp, I2S TX)          ESP32-S3
//   VIN  ----------------------------- 5V (or 3V3)
//   GND  ----------------------------- GND
//   BCLK ----------------------------- GPIO 40
//   LRC  ----------------------------- GPIO 41
//   DIN  ----------------------------- GPIO 42
//
// Build: Arduino IDE with "esp32 by Espressif Systems" >= 3.0.0,
//        Board: "ESP32S3 Dev Module", USB CDC On Boot: Enabled.

#include <ESP_I2S.h>
#include <math.h>

// ---- Speaker (MAX98357A, I2S TX) ----
static const int SPK_BCLK = 40;
static const int SPK_LRC  = 41;
static const int SPK_DIN  = 42;

// ---- Audio format ----
static const uint32_t SAMPLE_RATE = 16000;
static const int16_t  TONE_AMP    = 8000;   // ~25% of full scale

// ---- Tone sequence: C4, E4, G4, C5, E5, G5, A5 ----
static const float TONES[] = { 262.0f, 330.0f, 392.0f, 523.0f,
                               659.0f, 784.0f, 880.0f };
static const size_t NUM_TONES = sizeof(TONES) / sizeof(TONES[0]);
static const uint32_t HOLD_MS = 500;

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
  Serial.println("=== ESP32-S3 speaker test ===");

  spkI2S.setPins(SPK_BCLK, SPK_LRC, /*dout=*/SPK_DIN, /*din=*/-1);
  if (!spkI2S.begin(I2S_MODE_STD, SAMPLE_RATE,
                    I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO)) {
    fatal("spkI2S.begin failed");
  }
  Serial.println("Speaker ready. Cycling tones...");
  Serial.println();
}

void loop() {
  static const size_t TONE_CHUNK = 256;
  static int16_t toneBuf[TONE_CHUNK];
  static size_t   toneIdx       = 0;
  static uint32_t samplesInTone = 0;
  static float    phase         = 0.0f;
  static bool     announced     = false;

  const uint32_t samplesPerTone = (SAMPLE_RATE * HOLD_MS) / 1000;
  const float    freq           = TONES[toneIdx];
  const float    phaseInc       = 2.0f * (float)M_PI * freq / (float)SAMPLE_RATE;

  if (!announced) {
    Serial.print("tone=");
    Serial.print(freq, 0);
    Serial.println(" Hz");
    announced = true;
  }

  for (size_t i = 0; i < TONE_CHUNK; i++) {
    toneBuf[i] = (int16_t)(sinf(phase) * TONE_AMP);
    phase += phaseInc;
    if (phase > 2.0f * (float)M_PI) phase -= 2.0f * (float)M_PI;
  }
  spkI2S.write(reinterpret_cast<const uint8_t *>(toneBuf),
               TONE_CHUNK * sizeof(int16_t));

  samplesInTone += TONE_CHUNK;
  if (samplesInTone >= samplesPerTone) {
    samplesInTone = 0;
    phase         = 0.0f;
    toneIdx       = (toneIdx + 1) % NUM_TONES;
    announced     = false;
  }
}
