#pragma once

#include <obs.h>
#include <chrono>
#include <string>

// 只属于麦克风会话的播放参考，不交付页面、不进入共享或录制。
class VoiceReference {
public:
  explicit VoiceReference(obs_source_t *filter) : filter_(filter) {}
  ~VoiceReference() { stop(); }
  VoiceReference(const VoiceReference &) = delete;
  VoiceReference &operator=(const VoiceReference &) = delete;
  void configure(bool enabled, const std::string &selector);
  std::string status();
  void stop();
private:
  obs_source_t *filter_;
  obs_source_t *source_ = nullptr;
  bool enabled_ = false;
  std::string selector_;
  std::string state_ = "disabled";
  std::string default_device_;
  std::chrono::steady_clock::time_point last_available_;
  std::chrono::steady_clock::time_point last_device_check_;
  static void capture(void *context, obs_source_t *, const audio_data *audio, bool muted);
};
