#include "window_capture.h"

#include <winrt/Windows.Foundation.Metadata.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Security.Authorization.AppCapabilityAccess.h>
#include <chrono>
#include <filesystem>
#include <cstdio>

namespace {

struct winrt_capture;

struct WindowCapture {
  WindowVideoTarget target;
  HMODULE module = nullptr;
  winrt_capture *capture = nullptr;
  bool hide_cursor = false;
  const char *error = nullptr;
  // ABI 来自固定32.2.2的libobs-winrt/winrt-capture.h，不读取插件私有结构或自行实现WGC。
  BOOL (*supported)() = nullptr;
  BOOL (*cursor_supported)() = nullptr;
  winrt_capture *(*initialize)(BOOL, HWND, BOOL, BOOL) = nullptr;
  void (*free_capture)(winrt_capture *) = nullptr;
  BOOL (*active)(const winrt_capture *) = nullptr;
  void (*render)(winrt_capture *) = nullptr;
  uint32_t (*width)(const winrt_capture *) = nullptr;
  uint32_t (*height)(const winrt_capture *) = nullptr;

  ~WindowCapture() {
    if (module) FreeLibrary(module);
  }
};

WindowCapture g_window;

bool load_exports(const std::wstring &directory) {
  const auto path = std::filesystem::path(directory) / L"libobs-winrt.dll";
  g_window.module = LoadLibraryExW(path.c_str(), nullptr, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
  if (!g_window.module) {
    std::fprintf(stderr, "window runtime load failed: %lu\n", GetLastError());
    return false;
  }
  const auto load = []<typename T>(T &function, const char *name) {
    function = reinterpret_cast<T>(GetProcAddress(g_window.module, name));
    if (!function) std::fprintf(stderr, "window runtime export missing: %s\n", name);
    return function != nullptr;
  };
  return load(g_window.supported, "winrt_capture_supported")
      && load(g_window.cursor_supported, "winrt_capture_cursor_toggle_supported")
      && load(g_window.initialize, "winrt_capture_init_window")
      && load(g_window.free_capture, "winrt_capture_free")
      && load(g_window.active, "winrt_capture_active")
      && load(g_window.render, "winrt_capture_render")
      && load(g_window.width, "winrt_capture_width")
      && load(g_window.height, "winrt_capture_height");
}

void tick_window(void *, float) {
  if (g_window.capture || g_window.error || !window_video_target_valid(g_window.target) || window_video_suspended()) return;
  obs_enter_graphics();
  g_window.capture = g_window.initialize(!g_window.hide_cursor, g_window.target.window, false, true);
  obs_leave_graphics();
  if (!window_video_target_valid(g_window.target)) g_window.error = "captureTargetClosed";
  else if (!g_window.capture) g_window.error = "obsWindowCaptureStartFailed";
}

void free_window_capture(void *) {
  if (g_window.capture) {
    g_window.free_capture(g_window.capture);
    g_window.capture = nullptr;
  }
}

void destroy_window(void *) {
  // 与官方窗口来源一致，在图形线程释放帧池和设备回调。
  obs_queue_task(OBS_TASK_GRAPHICS, free_window_capture, nullptr, false);
}

uint32_t window_width(void *) {
  return !window_video_failure() && !window_video_suspended() && g_window.capture ? g_window.width(g_window.capture) : 0;
}

uint32_t window_height(void *) {
  return !window_video_failure() && !window_video_suspended() && g_window.capture ? g_window.height(g_window.capture) : 0;
}

void render_window(void *, gs_effect_t *) {
  if (g_window.capture && !window_video_failure() && !window_video_suspended()) g_window.render(g_window.capture);
}

struct WindowPreparation {
  const std::wstring &runtime_directory;
  bool hide_cursor;
  bool hide_border;
  const char *error = "obsWindowRuntimeUnavailable";
};

void prepare_window_capture(void *opaque) {
  auto &request = *static_cast<WindowPreparation *>(opaque);
  try {
    if (!load_exports(request.runtime_directory)) return;
    if (!g_window.supported()) {
      std::fprintf(stderr, "window runtime reports capture unsupported\n");
      return;
    }
    if (request.hide_cursor && !g_window.cursor_supported()) { request.error = "captureSettingsUnsupported"; return; }
    if (request.hide_border) {
      using namespace winrt::Windows;
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
    std::fprintf(stderr, "window runtime initialization failed: 0x%08lx\n", static_cast<unsigned long>(failure.code().value));
  }
}

}  // namespace

bool window_video_target_valid(const WindowVideoTarget &target) {
  return target.window && !target.property_name.empty() && target.property_value
      && IsWindow(target.window)
      && GetPropW(target.window, target.property_name.c_str()) == reinterpret_cast<HANDLE>(target.property_value);
}

bool window_video_suspended() {
  return IsIconic(g_window.target.window) || !IsWindowVisible(g_window.target.window);
}

const char *window_video_failure() {
  if (!window_video_target_valid(g_window.target)) return "captureTargetClosed";
  if (g_window.error) return g_window.error;
  if (g_window.capture && !g_window.active(g_window.capture)) return "obsWindowCaptureStopped";
  return nullptr;
}

obs_source_t *create_window_video_source(const WindowVideoTarget &target, const std::wstring &runtime_directory,
                                        bool hide_cursor, bool hide_border, const char *&error) {
  if (!window_video_target_valid(target)) { error = "captureTargetClosed"; return nullptr; }
  WindowPreparation request{runtime_directory, hide_cursor, hide_border};
  // libobs 已将主线程初始化为 STA；WinRT 检查复用其已初始化的 MTA 图形线程，不改线程模型。
  obs_queue_task(OBS_TASK_GRAPHICS, prepare_window_capture, &request, true);
  if (request.error) { error = request.error; return nullptr; }
  if (!window_video_target_valid(target)) { error = "captureTargetClosed"; return nullptr; }
  g_window.target = target;
  g_window.hide_cursor = hide_cursor;
  obs_source_info info{};
  info.id = "lycansync_bound_window";
  info.type = OBS_SOURCE_TYPE_INPUT;
  info.output_flags = OBS_SOURCE_VIDEO | OBS_SOURCE_CUSTOM_DRAW | OBS_SOURCE_SRGB;
  info.get_name = [](void *) { return "LycanSync selected window"; };
  info.create = [](obs_data_t *, obs_source_t *) -> void * { return &g_window; };
  info.destroy = destroy_window;
  info.video_tick = tick_window;
  info.video_render = render_window;
  info.get_width = window_width;
  info.get_height = window_height;
  obs_register_source(&info);
  auto *source = obs_source_create(info.id, "LycanSync selected window", nullptr, nullptr);
  error = source ? nullptr : "obsWindowSourceUnavailable";
  return source;
}
