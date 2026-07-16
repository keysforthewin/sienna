#pragma once
#include <stdint.h>
#include <stddef.h>

namespace camera {

// On-demand one-shot camera: begin() → capture() → returnFrame() → end().
// Do NOT leave it initialized between snapshots — see camera.cpp for why an
// always-on camera serves stale frames.
bool begin();
void end();

// Caller must call returnFrame() when done with the buffer (and BEFORE end(),
// which frees the driver's buffers).
struct Frame { uint8_t* buf; size_t len; void* internal; };
bool capture(Frame* out);
void returnFrame(Frame* f);

}  // namespace camera
