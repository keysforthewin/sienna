#include "camera.h"

#include <Arduino.h>
#include "esp_camera.h"
#include "log.h"
#include "pins.h"

namespace camera {

// The camera is ON-DEMAND: begin() right before a snapshot, end() right after.
// It must NOT stay initialized between snapshots — with CAMERA_GRAB_WHEN_EMPTY
// the driver fills its frame-buffer queue once and then stops capturing until a
// buffer is returned, so esp_camera_fb_get() on an always-on camera dequeues a
// frame captured around the time of the PREVIOUS snapshot (or boot) — minutes
// stale, not live. Tearing the driver down between shots also leaves the sensor
// unclocked (XCLK stops; PWDN isn't wired on the Freenove board, so this is the
// closest thing to "off") and returns the driver's internal-DRAM DMA buffers to
// the heap that the wss/TLS handshake competes for.
static bool gInited = false;

bool begin() {
  if (gInited) return true;
  camera_config_t config = {};
  config.ledc_channel = LEDC_CHANNEL_7;
  config.ledc_timer   = LEDC_TIMER_3;
  config.pin_d0       = pins::CAM_Y2;
  config.pin_d1       = pins::CAM_Y3;
  config.pin_d2       = pins::CAM_Y4;
  config.pin_d3       = pins::CAM_Y5;
  config.pin_d4       = pins::CAM_Y6;
  config.pin_d5       = pins::CAM_Y7;
  config.pin_d6       = pins::CAM_Y8;
  config.pin_d7       = pins::CAM_Y9;
  config.pin_xclk     = pins::CAM_XCLK;
  config.pin_pclk     = pins::CAM_PCLK;
  config.pin_vsync    = pins::CAM_VSYNC;
  config.pin_href     = pins::CAM_HREF;
  config.pin_sccb_sda = pins::CAM_SIOD;
  config.pin_sccb_scl = pins::CAM_SIOC;
  config.pin_pwdn     = pins::CAM_PWDN;
  config.pin_reset    = pins::CAM_RESET;
  config.xclk_freq_hz = 10000000;
  config.pixel_format = PIXFORMAT_JPEG;
  config.grab_mode    = CAMERA_GRAB_WHEN_EMPTY;
  config.fb_location  = CAMERA_FB_IN_PSRAM;
  config.jpeg_quality = 12;
  // fb_count = 1: one-shot capture. The single buffer is filled AFTER begin(),
  // so the frame handed to capture() is live — never a stale queue resident.
  if (psramFound()) {
    config.frame_size = FRAMESIZE_VGA;
    config.fb_count   = 1;
  } else {
    config.frame_size = FRAMESIZE_QVGA;
    config.fb_count   = 1;
    config.fb_location = CAMERA_FB_IN_DRAM;
  }
  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    LOGE("camera init failed: 0x%x", err);
    return false;
  }
  // Discard 3 warm-up frames so AE/AWB settle before the frame we keep.
  for (int i = 0; i < 3; i++) {
    camera_fb_t* fb = esp_camera_fb_get();
    if (fb) esp_camera_fb_return(fb);
  }
  gInited = true;
  LOGI("camera: ready");
  return true;
}

void end() {
  if (!gInited) return;
  esp_camera_deinit();
  gInited = false;
  LOGI("camera: off");
}

bool capture(Frame* out) {
  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) return false;
  out->buf = fb->buf;
  out->len = fb->len;
  out->internal = fb;
  return true;
}

void returnFrame(Frame* f) {
  if (!f || !f->internal) return;
  esp_camera_fb_return((camera_fb_t*)f->internal);
  f->internal = nullptr;
  f->buf = nullptr;
  f->len = 0;
}

}  // namespace camera
