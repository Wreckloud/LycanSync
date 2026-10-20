#include "screen_audio_pcm.h"

bool ScreenAudioPcmQueue::start() {
  const std::lock_guard<std::mutex> lock(mutex_);
  if (stopped_) return false;
  accepting_ = true;
  return true;
}

void ScreenAudioPcmQueue::stop() {
  const std::lock_guard<std::mutex> lock(mutex_);
  accepting_ = false;
  stopped_ = true;
  size_ = 0;
  partial_frames_ = 0;
}

bool ScreenAudioPcmQueue::push(const float *left, const float *right, uint32_t frames, bool muted) {
  const std::lock_guard<std::mutex> lock(mutex_);
  if (!accepting_ || (!muted && (!left || !right))) return false;
  bool queued = false;
  for (uint32_t frame = 0; frame < frames; ++frame) {
    partial_.samples[partial_frames_ * 2] = muted ? 0.0f : left[frame];
    partial_.samples[partial_frames_ * 2 + 1] = muted ? 0.0f : right[frame];
    if (++partial_frames_ != 480) continue;
    if (size_ == packets_.size()) {
      head_ = (head_ + 1) % packets_.size();
      --size_;
      ++dropped_;
    }
    packets_[(head_ + size_++) % packets_.size()] = partial_;
    partial_frames_ = 0;
    queued = true;
  }
  return queued;
}

bool ScreenAudioPcmQueue::pop(ScreenAudioPacket &packet) {
  const std::lock_guard<std::mutex> lock(mutex_);
  if (!accepting_ || !size_) return false;
  packet = packets_[head_];
  head_ = (head_ + 1) % packets_.size();
  --size_;
  return true;
}

uint64_t ScreenAudioPcmQueue::dropped() const {
  const std::lock_guard<std::mutex> lock(mutex_);
  return dropped_;
}
