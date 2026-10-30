#pragma once

#include <atomic>
#include <chrono>

// 授权只保持短时有效；页面／主进程停止续期后，采集线程自己恢复静音。
class VoiceTransmission {
public:
  using Clock = std::chrono::steady_clock;
  void set_mode(bool enabled) {
    if (push_to_talk.exchange(enabled) != enabled) transmit_until = 0;
  }
  void renew(bool held, Clock::time_point now = Clock::now()) {
    transmit_until = held ? (now + std::chrono::milliseconds(350)).time_since_epoch().count() : 0;
  }
  bool allowed(Clock::time_point now = Clock::now()) const {
    return !push_to_talk.load() || now.time_since_epoch().count() < transmit_until.load();
  }
  bool enabled() const { return push_to_talk.load(); }
private:
  std::atomic<bool> push_to_talk = false;
  std::atomic<Clock::duration::rep> transmit_until = 0;
};
