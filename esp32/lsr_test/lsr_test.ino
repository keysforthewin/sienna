// lsr_test.ino
//
// Light-sensing resistor (photoresistor / LDR) test for ESP32-S3-WROOM-1.
// Reads the LDR on an analog pin and drives the RGB LED red at a brightness
// proportional to ambient light.  Brightest when dark (ADC ≈ 0), off when
// bright (ADC ≈ 4095).
//
// Wiring
// ------
// Photoresistor (LDR)                ESP32-S3
//   Signal ----------------------------- GPIO 10  (ADC)
//
// RGB LED (common-anode)             ESP32-S3
//   Red   ----------------------------- GPIO 6
//   Green ----------------------------- GPIO 7
//   Blue  ----------------------------- GPIO 9
//   Common (anode) -------------------- 3.3 V
//
// Build: Arduino IDE with "esp32 by Espressif Systems" >= 3.0.0,
//        Board: "ESP32S3 Dev Module", USB CDC On Boot: Enabled.

// ---- Pin assignments ----
static const int LSR_PIN = 10;

static const int LED_R = 6;
static const int LED_G = 7;
static const int LED_B = 9;

// ---- Configuration ----
static const bool COMMON_ANODE = true;   // flip to false for common-cathode LEDs
static const unsigned long LOG_INTERVAL_MS = 200;  // ~5 Hz serial logging

// ---------------------------------------------------------------------------
// Set the RGB LED color (0–255 per channel).
// ---------------------------------------------------------------------------
static void setColor(uint8_t r, uint8_t g, uint8_t b) {
  if (COMMON_ANODE) {
    r = 255 - r;
    g = 255 - g;
    b = 255 - b;
  }
  analogWrite(LED_R, r);
  analogWrite(LED_G, g);
  analogWrite(LED_B, b);
}

// ---------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println();
  Serial.println("=== ESP32-S3 Light Sensor + Red LED test ===");

  pinMode(LSR_PIN, INPUT);
  analogSetPinAttenuation(LSR_PIN, ADC_11db);  // full 0–3.3 V range

  pinMode(LED_R, OUTPUT);
  pinMode(LED_G, OUTPUT);
  pinMode(LED_B, OUTPUT);
  setColor(0, 0, 0);

  Serial.println("LED pins configured.  Reading LDR on GPIO 10...");
  Serial.println();
}

// ---------------------------------------------------------------------------
void loop() {
  int lsrValue   = analogRead(LSR_PIN);                    // 0–4095
  int brightness  = map(lsrValue, 0, 4095, 255, 0);        // invert: dark → bright
  setColor((uint8_t)brightness, 0, 0);

  static unsigned long lastLog = 0;
  unsigned long now = millis();
  if (now - lastLog >= LOG_INTERVAL_MS) {
    lastLog = now;
    Serial.printf("LSR: %4d  |  Red brightness: %3d\n", lsrValue, brightness);
  }
}
