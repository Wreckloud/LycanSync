#include "bound_audio_target.h"

BoundAudioTarget::~BoundAudioTarget() {
  if (process_) CloseHandle(process_);
  lycan_game_target_close(&target_);
}

bool BoundAudioTarget::read(obs_data_t *settings) {
  if (process_ || target_.lifetime || !settings) return false;
  exclude_ = obs_data_get_bool(settings, "lycansync_exclude_process");
  if (exclude_) {
    // 整屏仅排除主进程树；不能把缺失窗口偷偷扩大为系统声音。
    if (obs_data_has_user_value(settings, "lycansync_window_id")
        || obs_data_has_user_value(settings, "lycansync_window_lifetime")
        || obs_data_has_user_value(settings, "lycansync_process_creation")) return false;
    const auto process_id = obs_data_get_int(settings, "lycansync_process_id");
    if (process_id <= 0 || process_id > MAXDWORD) return false;
    process_id_ = static_cast<DWORD>(process_id);
  } else {
    if (!lycan_game_target_read(&target_, settings)) return false;
    window_ = target_.window;
    process_id_ = target_.process_id;
    return valid();
  }
  process_ = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, process_id_);
  return valid();
}

bool BoundAudioTarget::valid() const {
  // 持有并检查原进程对象；即使 PID/HWND 被复用，也不接管新实例。
  if (!exclude_) return lycan_game_target_valid(&target_);
  return process_ && WaitForSingleObject(process_, 0) == WAIT_TIMEOUT;
}
