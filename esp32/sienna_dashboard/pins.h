// pins.h — Authoritative GPIO assignments for sienna_dashboard.
//
// See docs/superpowers/specs/2026-04-15-sienna-dashboard-design.md for the
// full rationale behind each assignment.
//
// Hardware: Freenove ESP32-S3-WROOM CAM (OV2640 onboard, OPI PSRAM).

#pragma once

namespace pins {

// Camera: stock Freenove pinout, hardwired.
constexpr int CAM_PWDN  = -1;
constexpr int CAM_RESET = -1;
constexpr int CAM_XCLK  = 15;
constexpr int CAM_SIOD  = 4;
constexpr int CAM_SIOC  = 5;
constexpr int CAM_Y9    = 16;
constexpr int CAM_Y8    = 17;
constexpr int CAM_Y7    = 18;
constexpr int CAM_Y6    = 12;
constexpr int CAM_Y5    = 10;
constexpr int CAM_Y4    = 8;
constexpr int CAM_Y3    = 9;
constexpr int CAM_Y2    = 11;
constexpr int CAM_VSYNC = 6;
constexpr int CAM_HREF  = 7;
constexpr int CAM_PCLK  = 13;

// Sensors / actuators
constexpr int LDR        = 1;   // ADC1_CH0
constexpr int LED_BLUE   = 2;
constexpr int LED_FLASH  = 3;   // strapping (USB-JTAG select; safe with USB CDC)

// Mic (INMP441) — I2S RX
constexpr int MIC_SD     = 14;
constexpr int MIC_SCK    = 38;
constexpr int MIC_WS     = 39;

// Speaker (MAX98357A) — I2S TX
constexpr int SPK_BCLK   = 40;
constexpr int SPK_LRC    = 41;
constexpr int SPK_DIN    = 42;

// RGB LED
constexpr int RGB_R      = 47;
constexpr int RGB_G      = 48;
constexpr int RGB_B      = 21;

// Buttons
constexpr int BOOT_BTN   = 0;
// Push-to-talk. GPIO 45 is a strapping pin (VDD_SPI voltage select), but
// active-low to GND with the internal pullup is boot-safe: low selects the
// 3.3 V default, so holding the button through a reset is harmless. (GPIO 46
// would also work but isn't broken out on the Freenove FNK0085 headers.)
// Never wire this button to pull the pin HIGH — high selects 1.8 V flash.
constexpr int PTT_BTN    = 45;

// LEDC channels (must be unique per pin)
constexpr int LEDC_CH_R = 0;
constexpr int LEDC_CH_G = 1;
constexpr int LEDC_CH_B = 2;

}  // namespace pins
