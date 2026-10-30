#include "../src/voice_transmission.h"
#include <cstdio>

int main() {
  using namespace std::chrono_literals;
  const auto now = VoiceTransmission::Clock::time_point(1s);
  VoiceTransmission gate;
  auto check = [](bool condition) { if (!condition) throw "transmission gate failed"; };
  check(gate.allowed(now));
  gate.set_mode(true);
  check(!gate.allowed(now));
  gate.renew(true, now);
  check(gate.allowed(now + 349ms));
  check(!gate.allowed(now + 350ms));
  gate.renew(true, now + 300ms);
  check(gate.allowed(now + 649ms));
  gate.renew(false, now + 301ms);
  check(!gate.allowed(now + 301ms));
  gate.set_mode(false);
  check(gate.allowed(now + 10s));
  gate.set_mode(true);
  check(!gate.allowed(now + 10s));
  std::puts("Voice transmission expiry and mode checks passed; no devices initialized.");
}
