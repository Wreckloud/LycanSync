#include "window_capture.h"

#include <callback/calldata.h>
#include <callback/proc.h>
#include <winrt/Windows.Foundation.Metadata.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Security.Authorization.AppCapabilityAccess.h>
#include <chrono>
#include <cstdio>

namespace {

struct WindowStatus {
  HWND selected = nullptr;
  HWND captured = nullptr;
  int method = 0;
  bool available = false;
  bool valid = false;
  bool failed = false;
};

bool read_window_status(obs_source_t *source, WindowStatus &status) {
  calldata_t result;
  calldata_init(&result);
  const bool queried = proc_handler_call(obs_source_get_proc_handler(source), "lycansync_get_target", &result);
  const bool version_matches = calldata_int(&result, "binding_version") == 2;
  status.selected = static_cast<HWND>(calldata_ptr(&result, "window"));
  status.captured = static_cast<HWND>(calldata_ptr(&result, "capture_window"));
  status.method = static_cast<int>(calldata_int(&result, "method"));
  status.available = calldata_bool(&result, "available");
  status.valid = calldata_bool(&result, "valid");
  status.failed = calldata_bool(&result, "failed");
  calldata_free(&result);
  return queried && version_matches && (status.method == 1 || status.method == 2);
}

struct WindowPreparation {
  bool hide_cursor;
  bool hide_border;
  const char *error = "obsWindowRuntimeUnavailable";
};

void prepare_window_capture(void *opaque) {
  auto &request = *static_cast<WindowPreparation *>(opaque);
  try {
    using namespace winrt::Windows;
    if (!Graphics::Capture::GraphicsCaptureSession::IsSupported()) return;
    if (request.hide_cursor && !Foundation::Metadata::ApiInformation::IsPropertyPresent(
        L"Windows.Graphics.Capture.GraphicsCaptureSession", L"IsCursorCaptureEnabled")) {
      request.error = "captureSettingsUnsupported";
      return;
    }
    if (request.hide_border) {
      if (!Foundation::Metadata::ApiInformation::IsPropertyPresent(
          L"Windows.Graphics.Capture.GraphicsCaptureSession", L"IsBorderRequired")) {
        request.error = "captureSettingsUnsupported";
        return;
      }
      request.error = "captureBorderAccessDenied";
      auto access = Graphics::Capture::GraphicsCaptureAccess::RequestAccessAsync(Graphics::Capture::GraphicsCaptureAccessKind::Borderless);
      if (access.wait_for(std::chrono::seconds(5)) != Foundation::AsyncStatus::Completed) {
        access.Cancel();
        return;
      }
      if (access.GetResults() != Security::Authorization::AppCapabilityAccess::AppCapabilityAccessStatus::Allowed) return;
    }
    request.error = nullptr;
  } catch (const winrt::hresult_error &failure) {
    std::fprintf(stderr, "window capture capability failed: 0x%08lx\n", static_cast<unsigned long>(failure.code().value));
  }
}

}  // namespace

bool bind_window_video_target(WindowVideoTarget &target) {
  obs_data_t *settings = obs_data_create();
  obs_data_set_int(settings, "lycansync_window_id", static_cast<long long>(reinterpret_cast<uintptr_t>(target.window)));
  obs_data_set_string(settings, "lycansync_window_lifetime", target.lifetime_name.c_str());
  obs_data_set_int(settings, "lycansync_process_id", target.process_id);
  obs_data_set_string(settings, "lycansync_process_creation", target.process_creation.c_str());
  auto binding = std::shared_ptr<lycan_game_target>(new lycan_game_target{}, [](lycan_game_target *value) {
    lycan_game_target_close(value);
    delete value;
  });
  const bool valid = lycan_game_target_read(binding.get(), settings);
  obs_data_release(settings);
  if (valid) target.binding = std::move(binding);
  return valid;
}

bool window_video_target_valid(const WindowVideoTarget &target) {
  return target.binding && lycan_game_target_valid(target.binding.get());
}

bool window_video_suspended(const WindowVideoTarget &target) {
  return IsIconic(target.window) || !IsWindowVisible(target.window);
}

const char *window_video_failure(obs_source_t *source, const WindowVideoTarget &target) {
  if (!window_video_target_valid(target)) return "captureTargetClosed";
  WindowStatus status;
  const bool queried = read_window_status(source, status);
  if (!window_video_target_valid(target)) return "captureTargetClosed";
  if (!queried) return "obsWindowBindingUnavailable";
  if (!status.valid || status.selected != target.window || (status.captured && status.captured != target.window)) {
    return "obsWindowTargetMismatch";
  }
  if (!status.available) return "obsWindowRuntimeUnavailable";
  return status.failed ? "obsWindowCaptureStartFailed" : nullptr;
}

const char *window_video_method(obs_source_t *source) {
  WindowStatus status;
  if (!read_window_status(source, status)) return nullptr;
  return status.method == 1 ? "bitblt-window" : "wgc-window";
}

obs_source_t *create_window_video_source(const WindowVideoTarget &target, bool hide_cursor,
    bool hide_border, std::string_view method, const char *&error, const char *&fallback_reason) {
  fallback_reason = nullptr;
  if (!window_video_target_valid(target)) { error = "captureTargetClosed"; return nullptr; }
  if (!obs_get_latest_input_type_id("lycansync_window_capture")) { error = "obsWindowBindingUnavailable"; return nullptr; }
  const int requested = method == "auto" ? 0 : method == "bitblt" ? 1 : method == "wgc" ? 2 : -1;
  if (requested < 0) { error = "invalidCaptureArguments"; return nullptr; }
  obs_data_t *settings = obs_data_create();
  obs_data_set_int(settings, "lycansync_window_id", static_cast<long long>(reinterpret_cast<uintptr_t>(target.window)));
  obs_data_set_string(settings, "lycansync_window_lifetime", target.lifetime_name.c_str());
  obs_data_set_int(settings, "lycansync_process_id", target.process_id);
  obs_data_set_string(settings, "lycansync_process_creation", target.process_creation.c_str());
  obs_data_set_int(settings, "method", requested);
  obs_data_set_bool(settings, "cursor", !hide_cursor);
  obs_data_set_bool(settings, "capture_audio", false);
  obs_data_set_bool(settings, "client_area", true);
  obs_data_set_bool(settings, "force_sdr", true);
  auto *source = obs_source_create("lycansync_window_capture", "LycanSync selected window", settings, nullptr);
  error = source ? nullptr : "obsWindowSourceUnavailable";
  if (source) {
    WindowStatus status;
    if (!read_window_status(source, status)) error = "obsWindowBindingUnavailable";
    else if (requested == 2 && status.method != 2) error = "captureSettingsUnsupported";
    else if (status.method == 2) {
      WindowPreparation preparation{hide_cursor, hide_border};
      // 来源尚未加入场景，不会先启动 WGC 再补问边框授权。
      if (status.available) obs_queue_task(OBS_TASK_GRAPHICS, prepare_window_capture, &preparation, true);
      if (preparation.error && requested == 0) {
        fallback_reason = preparation.error;
        obs_data_set_int(settings, "method", 1);
        // 视频来源 update 延迟到后续视频循环；这里只重建尚未启动的来源，不能带着旧方式进入场景。
        obs_source_release(source);
        source = obs_source_create("lycansync_window_capture", "LycanSync selected window", settings, nullptr);
        if (!source) error = "obsWindowSourceUnavailable";
      } else error = preparation.error;
    }
    if (!error) error = window_video_failure(source, target);
  }
  if (!window_video_target_valid(target)) error = "captureTargetClosed";
  obs_data_release(settings);
  if (error && source) {
    obs_source_release(source);
    source = nullptr;
  }
  return source;
}
