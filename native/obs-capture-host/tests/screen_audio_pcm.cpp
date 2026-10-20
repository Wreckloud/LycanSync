#include "screen_audio_pcm.h"

#include <cstdio>

#define CHECK(condition) do { if (!(condition)) { std::fprintf(stderr, "audio PCM check failed at line %d\n", __LINE__); return 1; } } while (0)

int main() {
  ScreenAudioPcmQueue queue;
  std::array<float, 480> left;
  std::array<float, 480> right;
  left.fill(0.25f);
  right.fill(-0.5f);
  ScreenAudioPacket packet;
  CHECK(!queue.push(left.data(), right.data(), 480, false));
  CHECK(queue.start());
  CHECK(!queue.push(left.data(), right.data(), 200, false));
  CHECK(!queue.pop(packet));
  CHECK(queue.push(left.data(), right.data(), 280, false));
  CHECK(queue.pop(packet) && packet.frames == 480);
  for (size_t frame = 0; frame < 480; ++frame) {
    CHECK(packet.samples[frame * 2] == 0.25f && packet.samples[frame * 2 + 1] == -0.5f);
  }
  CHECK(queue.push(nullptr, nullptr, 480, true));
  CHECK(queue.pop(packet));
  for (const auto sample : packet.samples) CHECK(sample == 0.0f);
  CHECK(!queue.push(nullptr, right.data(), 480, false));
  for (int chunk = 0; chunk < 15; ++chunk) {
    left.fill(static_cast<float>(chunk));
    CHECK(queue.push(left.data(), right.data(), 480, false));
  }
  CHECK(queue.dropped() == 3);
  for (int chunk = 3; chunk < 15; ++chunk) {
    CHECK(queue.pop(packet) && packet.samples[0] == static_cast<float>(chunk));
  }
  CHECK(!queue.pop(packet));
  CHECK(queue.push(left.data(), right.data(), 480, false));
  CHECK(!queue.push(left.data(), right.data(), 240, false));
  queue.stop();
  CHECK(!queue.pop(packet));
  CHECK(!queue.start());
  CHECK(!queue.push(left.data(), right.data(), 480, false));
  CHECK(queue.dropped() == 3);
  std::puts("screen audio PCM checks passed");
  return 0;
}
