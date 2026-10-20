#include "game_capture.h"

#include <callback/calldata.h>
#include <callback/proc.h>

const char *game_video_failure(obs_source_t *source, const WindowVideoTarget &target) {
  if (!window_video_target_valid(target)) return "captureTargetClosed";
  calldata_t status;
  calldata_init(&status);
  const bool queried = proc_handler_call(obs_source_get_proc_handler(source), "lycansync_get_target", &status);
  const bool version_matches = calldata_int(&status, "binding_version") == 1;
  const auto selected = static_cast<HWND>(calldata_ptr(&status, "window"));
  const auto captured = static_cast<HWND>(calldata_ptr(&status, "capture_window"));
  const bool valid = calldata_bool(&status, "valid");
  const bool hooked = calldata_bool(&status, "hooked");
  calldata_free(&status);
  if (!queried || !version_matches) return "obsGameBindingUnavailable";
  if (selected != target.window || !valid
      || (hooked && captured != target.window && !IsChild(target.window, captured))) return "obsGameTargetMismatch";
  return window_video_target_valid(target) ? nullptr : "captureTargetClosed";
}

obs_source_t *create_game_video_source(const WindowVideoTarget &target, bool hide_cursor, const char *&error) {
  if (!window_video_target_valid(target)) { error = "captureTargetClosed"; return nullptr; }
  if (!obs_get_latest_input_type_id("lycansync_game_capture")) { error = "obsGameBindingUnavailable"; return nullptr; }
  std::string property;
  for (const wchar_t character : target.property_name) {
    if (character > 127) { error = "invalidCaptureArguments"; return nullptr; }
    property.push_back(static_cast<char>(character));
  }
  obs_data_t *settings = obs_data_create();
  obs_data_set_int(settings, "lycansync_window_id", static_cast<long long>(reinterpret_cast<uintptr_t>(target.window)));
  obs_data_set_string(settings, "lycansync_window_property", property.c_str());
  obs_data_set_int(settings, "lycansync_window_property_value", static_cast<long long>(target.property_value));
  obs_data_set_string(settings, "capture_mode", "window");
  obs_data_set_bool(settings, "capture_cursor", !hide_cursor);
  // 游戏浮窗和共享声音尚未接通，不能借上游子源扩大本次验证范围。
  obs_data_set_bool(settings, "capture_overlays", false);
  obs_data_set_bool(settings, "capture_audio", false);
  auto *source = obs_source_create("lycansync_game_capture", "LycanSync selected game", settings, nullptr);
  obs_data_release(settings);
  error = source ? game_video_failure(source, target) : "obsGameSourceUnavailable";
  if (error && source) {
    obs_source_release(source);
    source = nullptr;
  }
  return source;
}
