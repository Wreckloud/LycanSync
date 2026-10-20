#pragma once

#include <obs-data.h>
#include <windows.h>
#include <string>

// 仅约束官方 WASAPI 的进程来源，不读取窗口标题，也不实现另一套声音采集。
class BoundAudioTarget {
public:
  BoundAudioTarget() = default;
  ~BoundAudioTarget();
  BoundAudioTarget(const BoundAudioTarget &) = delete;
  BoundAudioTarget &operator=(const BoundAudioTarget &) = delete;

  bool read(obs_data_t *settings);
  bool valid() const;
  DWORD process_id() const { return process_id_; }
  HWND window() const { return window_; }
  bool exclude() const { return exclude_; }

private:
  HANDLE process_ = nullptr;
  DWORD process_id_ = 0;
  HWND window_ = nullptr;
  HANDLE property_value_ = nullptr;
  std::string property_name_;
  bool exclude_ = false;
};
