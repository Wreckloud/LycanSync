#include "../src/window_capture.h"
#include <obs-module.h>
#include <graphics/graphics.h>
#include <util/base.h>
#include <d3d11.h>
#include <wrl/client.h>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <filesystem>
#include <string>
extern "C" {
#include <dc-capture.h>
}

namespace {
using Clock = std::chrono::steady_clock;
constexpr COLORREF kSelectedColor = RGB(16, 200, 80);
constexpr COLORREF kChangedColor = RGB(16, 200, 220);
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
  bool owned = false;
  Microsoft::WRL::ComPtr<ID3D11Device> device;
  Microsoft::WRL::ComPtr<ID3D11DeviceContext> context;
  Microsoft::WRL::ComPtr<IDXGISwapChain> swap_chain;
  Microsoft::WRL::ComPtr<ID3D11RenderTargetView> render_target;
  bool enable_gpu() {
    DXGI_SWAP_CHAIN_DESC description{};
    description.BufferDesc.Width = 320; description.BufferDesc.Height = 220;
    description.BufferDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    description.SampleDesc.Count = 1; description.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    description.BufferCount = 2; description.OutputWindow = identity.window;
    description.Windowed = TRUE; description.SwapEffect = DXGI_SWAP_EFFECT_DISCARD;
    if (FAILED(D3D11CreateDeviceAndSwapChain(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, 0, nullptr, 0,
        D3D11_SDK_VERSION, &description, &swap_chain, &device, nullptr, &context))) return false;
    Microsoft::WRL::ComPtr<ID3D11Texture2D> buffer;
    if (FAILED(swap_chain->GetBuffer(0, IID_PPV_ARGS(&buffer)))
        || FAILED(device->CreateRenderTargetView(buffer.Get(), nullptr, &render_target))) return false;
    const float color[4] = {220 / 255.0f, 16 / 255.0f, 200 / 255.0f, 1};
    context->ClearRenderTargetView(render_target.Get(), color);
    return SUCCEEDED(swap_chain->Present(0, 0));
  }
  void disable_gpu() {
    render_target.Reset(); swap_chain.Reset(); context.Reset(); device.Reset();
  }
  bool bind(HWND window, bool own, int sequence) {
    identity.window = window; owned = own;
    if (!GetWindowThreadProcessId(window, &identity.process_id)) return false;
    const auto process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, identity.process_id);
    FILETIME creation{}, exit{}, kernel{}, user{}, owner{};
    const bool read = process && GetProcessTimes(process, &creation, &exit, &kernel, &user);
    if (process) CloseHandle(process);
    if (!read || !GetProcessTimes(GetCurrentProcess(), &owner, &exit, &kernel, &user)) return false;
    identity.process_creation = std::to_string((uint64_t{creation.dwHighDateTime} << 32) | creation.dwLowDateTime);
    const auto owner_creation = std::to_string((uint64_t{owner.dwHighDateTime} << 32) | owner.dwLowDateTime);
    identity.lifetime_name = "Local\\LycanSync.WindowLifetime." + std::to_string(GetCurrentProcessId()) + "."
        + owner_creation + "." + std::to_string(sequence) + "." + std::to_string(reinterpret_cast<uintptr_t>(window));
    lifetime = CreateEventA(nullptr, TRUE, FALSE, identity.lifetime_name.c_str());
    return lifetime && bind_window_video_target(identity);
  }
  bool create(int left, COLORREF color, int sequence, const wchar_t *class_name = L"LycanSyncIsolationTest") {
    reset();
    const auto window = CreateWindowExW(0, class_name,
        L"LycanSync isolation test", WS_OVERLAPPEDWINDOW, left, 100, 320, 220, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
    if (!window) return false;
    if (!bind(window, true, sequence)) return false;
    SetWindowLongPtrW(window, GWLP_USERDATA, color);
    SetWindowPos(window, nullptr, left, 100, 320, 220, SWP_NOACTIVATE | SWP_NOZORDER | SWP_SHOWWINDOW);
    InvalidateRect(window, nullptr, TRUE); UpdateWindow(window);
    return true;
  }
  void reset() {
    disable_gpu();
    if (lifetime) { SetEvent(lifetime); CloseHandle(lifetime); lifetime = nullptr; }
    identity.binding.reset();
    if (owned && IsWindow(identity.window)) DestroyWindow(identity.window);
    identity.window = nullptr;
    owned = false;
  }
  ~Target() { reset(); }
};

// 只回读测试来源中心 16×16；像素不离开内存，不进入正式采集或安装包。
struct Probe {
  obs_source_t *source = nullptr;
  obs_scene_t *scene = nullptr;
  gs_texrender_t *render = nullptr;
  gs_stagesurf_t *stage = nullptr;
  bool callback = false;
  std::atomic<bool> magenta = false;
  bool external = false;
  std::atomic<unsigned> matched = 0, wrong = 0;
  std::atomic<unsigned> changed = 0;
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
    unsigned colored = 0, wrong = 0, changed = 0, overlay = 0;
    for (unsigned row = 0; row < 16; ++row) for (unsigned column = 0; column < 16; ++column) {
      const auto *pixel = pixels + row * stride + column * 4;
      const int blue = pixel[0], green = pixel[1], red = pixel[2];
      if (red < 8 && green < 8 && blue < 8) continue;
      const bool cyan = green > red + 40 && blue > 160 && blue > red + 40;
      const bool expected = self.external || (self.magenta ? red > green + 40 && blue > green + 40
          : green > red + 40 && (green > blue + 30 || cyan));
      colored += expected; wrong += !expected;
      changed += !self.magenta && cyan;
      overlay += red > green + 100 && blue > green + 100;
    }
    gs_stagesurface_unmap(self.stage);
    if (wrong) self.wrong++;
    if (self.external && (overlay == 256 || changed == 256)) self.wrong++;
    if (colored == 256) self.matched++;
    if (changed == 256) self.changed++;
  }
  bool start(Target &target, bool expect_magenta, std::string_view expected_method) {
    const auto started = Clock::now();
    const char *error = nullptr;
    source = create_window_video_source(target.identity, true, false, "auto", error);
    const auto *actual = source ? window_video_method(source) : nullptr;
    if (!source || error || !actual || (!expected_method.empty() && std::string_view(actual) != expected_method)) {
      std::printf("source-start-failed: %s\n", error ? error : "unexpected-method"); return false;
    }
    std::printf("auto-selected: %s\n", actual);
    scene = obs_scene_create("LycanSync isolated test");
    if (!scene || !obs_scene_add(scene, source)) return false;
    obs_set_output_source(0, obs_scene_get_source(scene));
    magenta = expect_magenta; matched = wrong = changed = 0;
    obs_enter_graphics();
    render = gs_texrender_create(GS_BGRA, GS_ZS_NONE); stage = gs_stagesurface_create(16, 16, GS_BGRA);
    obs_leave_graphics();
    if (!render || !stage) return false;
    obs_add_main_rendered_callback(sample, this); callback = true;
    const auto deadline = Clock::now() + std::chrono::seconds(7);
    while (matched < 3 && !wrong && Clock::now() < deadline) pump(50);
    std::printf("fresh-samples-ready-ms: %lld\n", static_cast<long long>(
        std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - started).count()));
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

bool verify(Target &selected, Target &other, std::string_view expected_method, bool gpu_cover = false) {
  Probe probe;
  if (!probe.start(selected, false, expected_method)) { std::printf("selected-source-failed: matched=%u wrong=%u\n", probe.matched.load(), probe.wrong.load()); return false; }
  std::puts("selected-source: green-only");
  if (gpu_cover && !other.enable_gpu()) return false;
  const auto baseline = probe.matched.load();
  SetWindowPos(other.identity.window, HWND_TOPMOST, 80, 100, 320, 220, SWP_NOACTIVATE | SWP_SHOWWINDOW);
  pump(1800);
  if (probe.wrong || probe.matched <= baseline) return false;
  std::puts("fully-occluded: green-only");
  SetWindowLongPtrW(selected.identity.window, GWLP_USERDATA, kChangedColor);
  InvalidateRect(selected.identity.window, nullptr, TRUE); UpdateWindow(selected.identity.window);
  pump(800);
  if (probe.wrong || !probe.changed) return false;
  std::puts("occluded-source-update: fresh-cyan-only");
  SetWindowPos(other.identity.window, HWND_NOTOPMOST, 440, 100, 320, 220, SWP_NOACTIVATE | SWP_SHOWWINDOW);
  const auto restored = probe.matched.load();
  pump(800);
  if (probe.wrong || probe.matched <= restored) return false;
  std::puts("restored-source: cyan-only");
  SetWindowTextW(selected.identity.window, L"LycanSync renamed isolation test");
  if (window_video_failure(probe.source, selected.identity)) return false;
  if (gpu_cover) SetWindowPos(other.identity.window, HWND_TOPMOST, 80, 100, 320, 220, SWP_NOACTIVATE | SWP_SHOWWINDOW);
  ShowWindow(selected.identity.window, SW_SHOWMINNOACTIVE); pump(350);
  if (!window_video_suspended(selected.identity) || probe.wrong) return false;
  ShowWindow(selected.identity.window, SW_SHOWNOACTIVATE); pump(800);
  if (window_video_suspended(selected.identity) || window_video_failure(probe.source, selected.identity) || probe.wrong) {
    std::printf("minimize-restore-failed: gpu-cover=%d wrong=%u\n", gpu_cover, probe.wrong.load()); return false;
  }
  std::puts("renamed-minimized-restored: original-instance");
  other.disable_gpu();
  InvalidateRect(other.identity.window, nullptr, TRUE); UpdateWindow(other.identity.window);
  SetWindowPos(other.identity.window, HWND_NOTOPMOST, 440, 100, 320, 220, SWP_NOACTIVATE | SWP_SHOWWINDOW);
  probe.reset();
  if (!probe.start(selected, false, expected_method)) return false;
  std::puts("stop-and-reopen: original-instance");
  wchar_t class_name[128]{};
  if (!GetClassNameW(selected.identity.window, class_name, 128)) return false;
  const auto closed_target = selected.identity;
  selected.reset();
  Target replacement;
  if (!replacement.create(80, kOtherColor, 10, class_name)) return false;
  pump(500);
  const auto *failure = window_video_failure(probe.source, closed_target);
  if (!failure || std::string_view(failure) != "captureTargetClosed" || probe.wrong) return false;
  std::puts("closed-with-same-title-replacement: no-takeover");
  probe.reset();
  if (!probe.start(other, true, expected_method)) return false;
  std::puts("source-switch: magenta-only");
  return true;
}

bool verify_dc_copy_failures(HWND selected) {
  // 调用补丁中的真实复制实现，只用自建窗口和明确无效的 DC，不采集桌面。
  dc_capture capture{};
  obs_enter_graphics();
  dc_capture_init(&capture, 0, 0, 16, 16, false, true);
  bool passed = capture.valid;
  if (passed) {
    dc_capture_capture(&capture, selected);
    passed = capture.texture_written;
    const auto invalid = reinterpret_cast<HWND>(static_cast<intptr_t>(-1));
    if (IsWindow(invalid)) passed = false;
    else {
      dc_capture_capture(&capture, invalid);
      passed = passed && !capture.texture_written;
    }
    const HDC valid_dc = capture.hdc;
    capture.hdc = reinterpret_cast<HDC>(static_cast<intptr_t>(-1));
    dc_capture_capture(&capture, selected);
    passed = passed && !capture.texture_written;
    capture.hdc = valid_dc;
    dc_capture_capture(&capture, selected);
    passed = passed && capture.texture_written;
  }
  dc_capture_free(&capture);
  obs_leave_graphics();
  std::printf("bitblt-invalid-dc-rejected: %d\n", passed);
  return passed;
}

bool verify_external(Target &selected) {
  if (window_video_suspended(selected.identity)) { std::puts("external-window-not-visible"); return false; }
  Probe probe;
  probe.external = true;
  if (!probe.start(selected, false, {})) { std::puts("external-baseline-unavailable"); return false; }
  POINT center{};
  RECT client{};
  if (!GetClientRect(selected.identity.window, &client)) return false;
  center.x = client.right / 2; center.y = client.bottom / 2;
  if (!ClientToScreen(selected.identity.window, &center)) return false;
  Target cover;
  if (!cover.create(80, kOtherColor, 20)) return false;
  SetWindowPos(cover.identity.window, HWND_TOPMOST, center.x - 160, center.y - 110, 320, 220,
      SWP_NOACTIVATE | SWP_SHOWWINDOW);
  pump(1200);
  SetWindowLongPtrW(cover.identity.window, GWLP_USERDATA, kChangedColor);
  InvalidateRect(cover.identity.window, nullptr, TRUE); UpdateWindow(cover.identity.window);
  pump(1200);
  cover.reset();
  const auto before = probe.matched.load();
  pump(800);
  const bool passed = !probe.wrong && probe.matched > before && !window_video_failure(probe.source, selected.identity);
  std::printf("external-occlusion: marker-frames=%u restored=%d\n", probe.wrong.load(), probe.matched > before);
  return passed;
}

bool verify_foreign_fixture(Target &selected) {
  wchar_t class_name[128]{};
  if (!GetClassNameW(selected.identity.window, class_name, 128)
      || (std::wstring_view(class_name) != L"LycanSyncObsCaptureTest"
          && std::wstring_view(class_name) != L"Chrome_WidgetWin_LycanSyncObsCaptureTest")) return false;
  Probe probe;
  if (!probe.start(selected, false, {})) {
    std::printf("foreign-fixture-source: matched=%u wrong=%u\n", probe.matched.load(), probe.wrong.load()); return false;
  }
  Target cover;
  POINT center{}; RECT client{};
  if (!GetClientRect(selected.identity.window, &client)) return false;
  center.x = client.right / 2; center.y = client.bottom / 2;
  if (!ClientToScreen(selected.identity.window, &center) || !cover.create(80, kOtherColor, 30) || !cover.enable_gpu()) return false;
  SetWindowPos(cover.identity.window, HWND_TOPMOST, center.x - 160, center.y - 110, 320, 220, SWP_NOACTIVATE | SWP_SHOWWINDOW);
  pump(800);
  if (probe.wrong) return false;
  ShowWindow(selected.identity.window, SW_SHOWMINNOACTIVE); pump(350);
  ShowWindow(selected.identity.window, SW_SHOWNOACTIVATE); pump(800);
  const bool passed = !probe.wrong && !window_video_failure(probe.source, selected.identity);
  std::printf("foreign-fixture-source: matched=%u wrong=%u\n", probe.matched.load(), probe.wrong.load());
  return passed;
}
}

int wmain(int argc, wchar_t **argv) {
  const bool gpu_cover = argc == 5 && std::wstring_view(argv[4]) == L"--gpu-cover";
  const bool foreign_fixture = argc == 6 && std::wstring_view(argv[4]) == L"--observe-test-window";
  if (argc != 4 && !gpu_cover && !foreign_fixture && (argc != 6 || std::wstring_view(argv[4]) != L"--window")) return 2;
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  base_set_log_handler(quiet_log, nullptr);
  WNDCLASSW type{}; type.hInstance = GetModuleHandleW(nullptr); type.lpfnWndProc = paint_window;
  type.lpszClassName = L"LycanSyncIsolationTest";
  if (!RegisterClassW(&type)) return 1;
  type.lpszClassName = L"Chrome_WidgetWin_LycanSyncIsolationTest";
  if (!RegisterClassW(&type)) return 1;
  Target selected, other;
  const bool external = argc == 6;
  if (external) {
    wchar_t *end = nullptr;
    const auto window = std::wcstoull(argv[5], &end, 10);
    if (!window || *end || !selected.bind(reinterpret_cast<HWND>(window), false, 1)) return 2;
  } else if (!selected.create(80, kSelectedColor, 1) || !other.create(440, kOtherColor, 2)) return 1;
  pump(300);
  std::printf("test-windows-visible: %d %d\n", IsWindowVisible(selected.identity.window), IsWindowVisible(other.identity.window));
  const auto sdk = std::filesystem::absolute(argv[1]).parent_path().parent_path().parent_path();
  const auto dll_directory = AddDllDirectory((sdk / "bin/64bit").c_str());
  if (!dll_directory) return 1;
  if (!obs_startup("en-US", utf8(argv[3]).c_str(), nullptr)) return 1;
  const auto obs_data = utf8(sdk / "data/libobs");
  obs_add_data_path((obs_data + "/").c_str());
  const auto graphics_module = utf8(sdk / "bin/64bit/libobs-d3d11.dll");
  obs_video_info video{}; video.graphics_module = graphics_module.c_str();
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
      obs_post_load_modules();
      passed = external ? (foreign_fixture ? verify_foreign_fixture(selected) : verify_external(selected))
          : verify_dc_copy_failures(selected.identity.window) && verify(selected, other, "bitblt-window", gpu_cover);
      if (passed && !external) {
        selected.reset(); other.reset();
        passed = selected.create(80, kSelectedColor, 3, L"Chrome_WidgetWin_LycanSyncIsolationTest")
            && other.create(440, kOtherColor, 4, L"Chrome_WidgetWin_LycanSyncIsolationTest");
        pump(300);
        if (passed) passed = verify(selected, other, "wgc-window", gpu_cover);
      }
    }
  }
  obs_shutdown();
  RemoveDllDirectory(dll_directory);
  std::puts(passed ? "window isolation: passed" : "window isolation: failed");
  return passed ? 0 : 1;
}
