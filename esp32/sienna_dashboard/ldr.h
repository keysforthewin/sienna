#pragma once
#include <stdint.h>
#include <functional>

namespace ldr {

void begin();
int  readNow();                // 0–4095
void setPushHz(float hz);      // 0 = pause
void onPush(std::function<void(int)> cb);
void tick();                   // call from loop()

}  // namespace ldr
