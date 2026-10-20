#pragma once

#include "window_capture.h"

#include <functional>
#include <memory>
#include <string>
#include <string_view>

struct ScreenAudioSnapshot {
  std::string state = "idle";
  uint32_t sample_rate = 0;
  uint32_t channels = 0;
  uint64_t packets_received = 0;
  uint64_t frames_received = 0;
  uint64_t silent_packets = 0;
  uint64_t dropped_chunks = 0;
  std::string last_error;
};

class ScreenAudioHost {
public:
  using Emit = std::function<void(std::string_view, std::string_view, std::string_view)>;
  ScreenAudioHost(std::string module_path, std::string data_path, WindowVideoTarget target, bool window, Emit emit);
  ~ScreenAudioHost();
  bool command(std::string_view command);
  ScreenAudioSnapshot snapshot() const;
  void shutdown();

private:
  struct Session;
  std::shared_ptr<Session> session_;
  std::string module_path_;
  std::string data_path_;
  WindowVideoTarget target_;
  bool window_;
  Emit emit_;
  bool module_loaded_ = false;
  bool module_apartment_initialized_ = false;
  void run(const std::shared_ptr<Session> &session, bool system_mix, DWORD client_process);
};
