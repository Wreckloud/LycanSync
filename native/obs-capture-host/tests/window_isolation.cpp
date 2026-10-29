#include "../src/window_capture.h"
#include <obs-module.h>
#include <graphics/graphics.h>
#include <util/base.h>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <filesystem>
#include <string>

namespace {
using Clock = std::chrono::steady_clock;
constexpr COLORREF kSelectedColor = RGB(16, 200, 80);
constexpr COLORREF kOtherColor = RGB(220, 16, 200);

void quiet_log(int level, const char *format, va_list args, void *) {
  if (level > LOG_WARNING) return;
  if (std::string_view(format).starts_with("CreateForWindow (0x")) {
    std::vfprintf(stderr, format, args); std::fputc('\n', stderr);
  } else std::fprintf(stderr, "obs-test: %s\n", format);
}
void pump(int milliseconds) {
  const auto deadline = Clock::now() + std::chrono::milliseconds(milliseconds);
  while (Clock::now() < deadline) {
    MSG message{};
    while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) { TranslateMessage(&message); DispatchMessageW(&message); }
    Sleep(10);
  }
}
LRESULT CALLBACK paint_window(HWND window, UINT message, WPARAM word, LPARAM parameter) {
  if (message == WM_PAINT) {
    PAINTSTRUCT paint{};
    const auto dc = BeginPaint(window, &paint);
    const auto brush = CreateSolidBrush(static_cast<COLORREF>(GetWindowLongPtrW(window, GWLP_USERDATA)));
    FillRect(dc, &paint.rcPaint, brush); DeleteObject(brush); EndPaint(window, &paint);
    return 0;
  }
  return DefWindowProcW(window, message, word, parameter);
}
std::string utf8(const std::filesystem::path &path) {
  const auto value = path.u8string(); return {value.begin(), value.end()};
}
struct Target {
  WindowVideoTarget identity;
  HANDLE lifetime = nullptr;
  bool create(int left, COLORREF color, int sequence) {
    const auto window = CreateWindowExW(0, L"LycanSyncIsolationTest",
        L"LycanSync isolation test", WS_OVERLAPPEDWINDOW, left, 100, 320, 220, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
    if (!window) return false;
    identity.window = window; identity.process_id = GetCurrentProcessId();
    FILETIME creation{}, exit{}, kernel{}, user{};
    if (!GetProcessTimes(GetCurrentProcess(), &creation, &exit, &kernel, &user)) return false;
    identity.process_creation = std::to_string((uint64_t{creation.dwHighDateTime} << 32) | creation.dwLowDateTime);
    identity.lifetime_name = "Local\\LycanSync.WindowLifetime." + std::to_string(identity.process_id) + "."
        + identity.process_creation + "." + std::to_string(sequence) + "." + std::to_string(reinterpret_cast<uintptr_t>(window));
    lifetime = CreateEventA(nullptr, TRUE, FALSE, identity.lifetime_name.c_str());
    if (!lifetime || !bind_window_video_target(identity)) return false;
    SetWindowLongPtrW(window, GWLP_USERDATA, color);
    SetWindowPos(window, nullptr, left, 100, 320, 220, SWP_NOACTIVATE | SWP_NOZORDER | SWP_SHOWWINDOW);
    InvalidateRect(window, nullptr, TRUE); UpdateWindow(window);
    return true;
  }
  ~Target() {
    if (lifetime) { SetEvent(lifetime); CloseHandle(lifetime); }
    identity.binding.reset();
    if (IsWindow(identity.window)) DestroyWindow(identity.window);
  }
};

// 只回读测试来源中心 16×16；像素不离开内存，不进入正式采集或安装包。
struct Probe {
  obs_source_t *source = nullptr;
  obs_scene_t *scene = nullptr;
  gs_texrender_t *render = nullptr;
  gs_stagesurf_t *stage = nullptr;
  bool callback = false;
  std::atomic<bool> magenta = false;
  std::atomic<unsigned> matched = 0, wrong = 0;
  Clock::time_point last_read{};
  static void sample(void *context) {
    auto &self = *static_cast<Probe *>(context);
    if (Clock::now() - self.last_read < std::chrono::milliseconds(100)) return;
    self.last_read = Clock::now();
    const auto width = obs_source_get_width(self.source), height = obs_source_get_height(self.source);
    if (width < 16 || height < 16) return;
    gs_texrender_reset(self.render);
    if (!gs_texrender_begin(self.render, 16, 16)) { self.wrong++; return; }
    vec4 black{};
    gs_clear(GS_CLEAR_COLOR, &black, 0.0f, 0);
    gs_matrix_push(); gs_matrix_identity();
    const float x = width / 2.0f, y = height / 2.0f;
    gs_ortho(x - 8, x + 8, y - 8, y + 8, -100, 100);
    obs_source_video_render(self.source);
    gs_matrix_pop(); gs_texrender_end(self.render);
    gs_stage_texture(self.stage, gs_texrender_get_texture(self.render));
    uint8_t *pixels = nullptr; uint32_t stride = 0;
    if (!gs_stagesurface_map(self.stage, &pixels, &stride)) { self.wrong++; return; }
    unsigned colored = 0, wrong = 0;
    for (unsigned row = 0; row < 16; ++row) for (unsigned column = 0; column < 16; ++column) {
      const auto *pixel = pixels + row * stride + column * 4;
      const int blue = pixel[0], green = pixel[1], red = pixel[2];
      if (red < 8 && green < 8 && blue < 8) continue;
      const bool expected = self.magenta ? red > green + 40 && blue > green + 40
          : green > red + 40 && green > blue + 30;
      colored += expected; wrong += !expected;
    }
    gs_stagesurface_unmap(self.stage);
    if (wrong) self.wrong++;
    if (colored == 256) self.matched++;
  }
  bool start(Target &target, bool expect_magenta) {
    const char *error = nullptr;
    source = create_window_video_source(target.identity, true, false, "auto", error);
    if (!source || error || std::string_view(window_video_method(source)) != "wgc-window") {
      std::printf("source-start-failed: %s\n", error ? error : "unexpected-method"); return false;
    }
    scene = obs_scene_create("LycanSync isolated test");
    if (!scene || !obs_scene_add(scene, source)) return false;
    obs_set_output_source(0, obs_scene_get_source(scene));
    magenta = expect_magenta; matched = wrong = 0;
    obs_enter_graphics();
    render = gs_texrender_create(GS_BGRA, GS_ZS_NONE); stage = gs_stagesurface_create(16, 16, GS_BGRA);
    obs_leave_graphics();
    if (!render || !stage) return false;
    obs_add_main_rendered_callback(sample, this); callback = true;
    const auto deadline = Clock::now() + std::chrono::seconds(7);
    while (matched < 3 && !wrong && Clock::now() < deadline) pump(50);
    return matched >= 3 && !wrong;
  }
  void reset() {
    if (callback) obs_remove_main_rendered_callback(sample, this);
    callback = false;
    obs_set_output_source(0, nullptr);
    if (scene) { obs_source_remove(obs_scene_get_source(scene)); obs_scene_release(scene); scene = nullptr; }
    if (source) { obs_source_release(source); source = nullptr; }
    obs_wait_for_destroy_queue();
    obs_enter_graphics();
    if (stage) gs_stagesurface_destroy(stage);
    if (render) gs_texrender_destroy(render);
    stage = nullptr; render = nullptr; obs_leave_graphics();
  }
  ~Probe() { reset(); }
};

bool verify(Target &selected, Target &other) {
  const char *error = nullptr;
  if (create_window_video_source(selected.identity, true, true, "bitblt", error)
      || !error || std::string_view(error) != "captureMethodNotIsolated") return false;
  Probe probe;
  if (!probe.start(selected, false)) { std::printf("selected-source-failed: matched=%u wrong=%u\n", probe.matched.load(), probe.wrong.load()); return false; }
  std::puts("selected-source: green-only");
  const auto baseline = probe.matched.load();
  SetWindowPos(other.identity.window, HWND_TOPMOST, 80, 100, 320, 220, SWP_NOACTIVATE | SWP_SHOWWINDOW);
  pump(1800);
  if (probe.wrong || probe.matched <= baseline) return false;
  std::puts("fully-occluded: green-only");
  SetWindowPos(other.identity.window, HWND_NOTOPMOST, 440, 100, 320, 220, SWP_NOACTIVATE | SWP_SHOWWINDOW);
  const auto restored = probe.matched.load();
  pump(800);
  if (probe.wrong || probe.matched <= restored) return false;
  std::puts("restored-source: green-only");
  probe.reset();
  if (!probe.start(other, true)) return false;
  std::puts("source-switch: magenta-only");
  return true;
}
}

int wmain(int argc, wchar_t **argv) {
  if (argc != 4) return 2;
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  base_set_log_handler(quiet_log, nullptr);
  WNDCLASSW type{}; type.hInstance = GetModuleHandleW(nullptr); type.lpfnWndProc = paint_window;
  type.lpszClassName = L"LycanSyncIsolationTest";
  if (!RegisterClassW(&type)) return 1;
  Target selected, other;
  if (!selected.create(80, kSelectedColor, 1) || !other.create(440, kOtherColor, 2)) return 1;
  pump(300);
  std::printf("test-windows-visible: %d %d\n", IsWindowVisible(selected.identity.window), IsWindowVisible(other.identity.window));
  if (!obs_startup("en-US", utf8(argv[3]).c_str(), nullptr)) return 1;
  const auto obs_data = utf8(std::filesystem::path(argv[1]).parent_path().parent_path().parent_path() / "data/libobs");
  obs_add_data_path((obs_data + "/").c_str());
  obs_video_info video{}; video.graphics_module = "libobs-d3d11";
  video.base_width = video.output_width = 320; video.base_height = video.output_height = 180;
  video.fps_num = 30; video.fps_den = 1; video.output_format = VIDEO_FORMAT_BGRA;
  video.colorspace = VIDEO_CS_SRGB; video.range = VIDEO_RANGE_FULL; video.gpu_conversion = true;
  bool passed = false;
  const auto graphics = obs_reset_video(&video);
  std::printf("graphics-initialization: %d\n", graphics);
  if (graphics == OBS_VIDEO_SUCCESS) {
    obs_module_t *module = nullptr;
    const auto opened = obs_open_module(&module, utf8(argv[1]).c_str(), utf8(argv[2]).c_str());
    std::printf("module-open: %d\n", opened);
    if (opened == MODULE_SUCCESS && obs_init_module(module)) {
      obs_post_load_modules(); passed = verify(selected, other);
    }
  }
  obs_shutdown();
  std::puts(passed ? "window isolation: passed" : "window isolation: failed");
  return passed ? 0 : 1;
}
