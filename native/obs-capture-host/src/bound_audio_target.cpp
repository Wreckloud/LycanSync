#include "bound_audio_target.h"

#include <algorithm>
#include <cstdint>
#include <string_view>

BoundAudioTarget::~BoundAudioTarget() {
  if (process_) CloseHandle(process_);
}

bool BoundAudioTarget::read(obs_data_t *settings) {
  if (process_ || !settings) return false;
  exclude_ = obs_data_get_bool(settings, "lycansync_exclude_process");
  if (exclude_) {
    // 整屏仅排除主进程树；不能把缺失窗口偷偷扩大为系统声音。
    if (obs_data_has_user_value(settings, "lycansync_window_id")
        || obs_data_has_user_value(settings, "lycansync_window_property")
        || obs_data_has_user_value(settings, "lycansync_window_property_value")) return false;
    const auto process_id = obs_data_get_int(settings, "lycansync_process_id");
    if (process_id <= 0 || process_id > MAXDWORD) return false;
    process_id_ = static_cast<DWORD>(process_id);
  } else {
    if (obs_data_has_user_value(settings, "lycansync_process_id")) return false;
    const auto window = obs_data_get_int(settings, "lycansync_window_id");
    const auto property_value = obs_data_get_int(settings, "lycansync_window_property_value");
    if (window <= 0 || property_value <= 0) return false;
    window_ = reinterpret_cast<HWND>(static_cast<uintptr_t>(window));
    property_value_ = reinterpret_cast<HANDLE>(static_cast<uintptr_t>(property_value));
    property_name_ = obs_data_get_string(settings, "lycansync_window_property");
    constexpr std::string_view prefix = "LycanSync.MediaHelper.Window.";
    if (!property_name_.starts_with(prefix) || property_name_.size() <= prefix.size() || property_name_.size() > 128
        || !std::all_of(property_name_.begin() + prefix.size(), property_name_.end(), [](unsigned char value) {
             return (value >= '0' && value <= '9') || value == '.';
           })
        || !IsWindow(window_) || GetPropA(window_, property_name_.c_str()) != property_value_
        || !GetWindowThreadProcessId(window_, &process_id_) || !process_id_) return false;
  }
  process_ = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, process_id_);
  return valid();
}

bool BoundAudioTarget::valid() const {
  // 持有并检查原进程对象；即使 PID/HWND 被复用，也不接管新实例。
  if (!process_ || WaitForSingleObject(process_, 0) != WAIT_TIMEOUT) return false;
  if (exclude_) return true;
  DWORD process_id = 0;
  return IsWindow(window_) && GetPropA(window_, property_name_.c_str()) == property_value_
      && GetWindowThreadProcessId(window_, &process_id) && process_id == process_id_;
}
