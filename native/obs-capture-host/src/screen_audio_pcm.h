#pragma once

#include <array>
#include <cstdint>
#include <mutex>

struct ScreenAudioPacket {
  uint32_t frames = 480;
  std::array<float, 960> samples{};
};
static_assert(sizeof(ScreenAudioPacket) == 4 + 480 * 2 * sizeof(float));

// 声音回调只整理 10ms PCM；管道阻塞不能阻塞 OBS 的采集线程。
class ScreenAudioPcmQueue {
public:
  bool start();
  void stop();
  bool push(const float *left, const float *right, uint32_t frames, bool muted);
  bool pop(ScreenAudioPacket &packet);
  uint64_t dropped() const;

private:
  mutable std::mutex mutex_;
  std::array<ScreenAudioPacket, 12> packets_;
  ScreenAudioPacket partial_;
  uint32_t partial_frames_ = 0;
  size_t head_ = 0;
  size_t size_ = 0;
  uint64_t dropped_ = 0;
  bool accepting_ = false;
  bool stopped_ = false;
};
