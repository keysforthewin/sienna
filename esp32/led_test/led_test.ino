// led_test.ino
//
// RGB LED test for ESP32-S3-WROOM-1.
// Cycles through color phases to visually verify all three channels
// and PWM range of an RGB LED.
//
// Wiring
// ------
// RGB LED                          ESP32-S3
//   Red   ----------------------------- GPIO 6
//   Green ----------------------------- GPIO 7
//   Blue  ----------------------------- GPIO 9
//   Common (cathode) ------------------ GND
//
// Standalone blue LED               ESP32-S3
//   Anode ----------------------------- GPIO 5
//   Cathode --------------------------- GND
//
// If using a common-anode LED, set COMMON_ANODE = true below.
//
// Build: Arduino IDE with "esp32 by Espressif Systems" >= 3.0.0,
//        Board: "ESP32S3 Dev Module", USB CDC On Boot: Enabled.

// ---- Pin assignments ----
static const int LED_R = 6;
static const int LED_G = 7;
static const int LED_B = 9;
static const int LED_BLUE = 5;  // standalone blue LED

// ---- Configuration ----
static const bool COMMON_ANODE = true;  // flip to false for common-cathode LEDs

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
// Convert HSV to RGB.
//   h: hue        0–360
//   s: saturation  0–255
//   v: value       0–255
// ---------------------------------------------------------------------------
static void hsvToRgb(int h, uint8_t s, uint8_t v,
                     uint8_t &r, uint8_t &g, uint8_t &b) {
  if (s == 0) { r = g = b = v; return; }

  h = h % 360;
  int region    = h / 60;
  int remainder = (h - region * 60) * 255 / 60;

  uint8_t p = (uint8_t)((uint16_t)v * (255 - s) / 255);
  uint8_t q = (uint8_t)((uint16_t)v * (255 - (uint16_t)s * remainder / 255) / 255);
  uint8_t t = (uint8_t)((uint16_t)v * (255 - (uint16_t)s * (255 - remainder) / 255) / 255);

  switch (region) {
    case 0:  r = v; g = t; b = p; break;
    case 1:  r = q; g = v; b = p; break;
    case 2:  r = p; g = v; b = t; break;
    case 3:  r = p; g = q; b = v; break;
    case 4:  r = t; g = p; b = v; break;
    default: r = v; g = p; b = q; break;
  }
}

// ---------------------------------------------------------------------------
// Breathing effect: pulse a color's brightness up then down.
// ---------------------------------------------------------------------------
static void breatheColor(uint8_t r, uint8_t g, uint8_t b, int cycles) {
  for (int c = 0; c < cycles; c++) {
    // Ramp up
    for (int v = 0; v <= 255; v += 3) {
      setColor(r * v / 255, g * v / 255, b * v / 255);
      delay(4);
    }
    // Ramp down
    for (int v = 255; v >= 0; v -= 3) {
      setColor(r * v / 255, g * v / 255, b * v / 255);
      delay(4);
    }
  }
}

// ---------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println();
  Serial.println("=== ESP32-S3 RGB LED test ===");

  pinMode(LED_R, OUTPUT);
  pinMode(LED_G, OUTPUT);
  pinMode(LED_B, OUTPUT);
  setColor(0, 0, 0);

  pinMode(LED_BLUE, OUTPUT);
  digitalWrite(LED_BLUE, LOW);

  Serial.println("LED pins configured. Starting test cycle...");
  Serial.println();
}

// ---------------------------------------------------------------------------
void loop() {
  // ---- Phase 1: Individual channel test ----
  Serial.println("[Phase 1] Individual channels");

  Serial.println("  Red");
  setColor(255, 0, 0);
  delay(1000);

  Serial.println("  Green");
  setColor(0, 255, 0);
  delay(1000);

  Serial.println("  Blue");
  setColor(0, 0, 255);
  delay(1000);

  setColor(0, 0, 0);
  delay(300);

  // ---- Phase 2: Rapid RGB blink ----
  Serial.println("[Phase 2] Rapid R-G-B blink");
  for (int i = 0; i < 6; i++) {
    setColor(255, 0, 0); delay(100);
    setColor(0, 255, 0); delay(100);
    setColor(0, 0, 255); delay(100);
  }
  setColor(0, 0, 0);
  delay(300);

  // ---- Phase 3: Smooth HSV color wheel ----
  Serial.println("[Phase 3] Color wheel (3 rotations)");
  for (int rot = 0; rot < 3; rot++) {
    for (int h = 0; h < 360; h += 1) {
      uint8_t r, g, b;
      hsvToRgb(h, 255, 255, r, g, b);
      setColor(r, g, b);
      delay(10);  // ~3.6 s per rotation
    }
  }
  setColor(0, 0, 0);
  delay(300);

  // ---- Phase 4: Breathing on key colors ----
  Serial.println("[Phase 4] Breathing effect");

  Serial.println("  Red breathe");
  breatheColor(255, 0, 0, 2);

  Serial.println("  Yellow breathe");
  breatheColor(255, 200, 0, 2);

  Serial.println("  Cyan breathe");
  breatheColor(0, 255, 255, 2);

  Serial.println("  Magenta breathe");
  breatheColor(255, 0, 255, 2);

  setColor(0, 0, 0);
  delay(300);

  // ---- Phase 5: White balance ----
  Serial.println("[Phase 5] White balance");
  setColor(255, 255, 255);
  delay(2000);
  setColor(0, 0, 0);
  delay(500);

  // ---- Phase 6: Standalone blue LED ----
  Serial.println("[Phase 6] Standalone blue LED");
  for (int i = 0; i < 6; i++) {
    digitalWrite(LED_BLUE, HIGH);
    delay(250);
    digitalWrite(LED_BLUE, LOW);
    delay(250);
  }
  delay(300);

  Serial.println("--- Cycle complete, restarting ---");
  Serial.println();
}
