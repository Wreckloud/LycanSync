#pragma once

#include <obs.h>
#include <functional>
#include <string>

// 只接收页面已选中的人声 PCM，不打开麦克风或扬声器设备。
class RecordingAudioInput {
public:
  explicit RecordingAudioInput(std::function<void()> failed);
  ~RecordingAudioInput();
  bool start(const std::string &pipe_id);
  void request_stop();
  void stop();
private:
  std::function<void()> failed_;
  obs_source_t *source_ = nullptr;
};
