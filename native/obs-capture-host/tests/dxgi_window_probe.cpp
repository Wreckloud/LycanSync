#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <dwmapi.h>
#include <wrl/client.h>

#include <chrono>
#include <atomic>
#include <cstdint>
#include <cstdio>
#include <memory>
#include <string_view>
#include <thread>

using Microsoft::WRL::ComPtr;

namespace {
constexpr UINT kSampleSize = 16;
constexpr COLORREF kTargetColor = RGB(16, 208, 64);
constexpr COLORREF kOverlayColor = RGB(224, 16, 208);

struct ProbeFailure { const char *stage; HRESULT result; };
void require_success(HRESULT result, const char *stage) {
  if (FAILED(result)) throw ProbeFailure{stage, result};
}

struct Sample {
  UINT target_pixels = 0;
  UINT overlay_pixels = 0;
  LONGLONG present_time = 0;
  UINT accumulated_frames = 0;
};

Sample count_markers(const uint8_t *pixels, UINT pitch) {
  Sample result;
  for (UINT y = 0; y < kSampleSize; ++y) {
    const auto *row = pixels + y * pitch;
    for (UINT x = 0; x < kSampleSize; ++x) {
      const int blue = row[x * 4], green = row[x * 4 + 1], red = row[x * 4 + 2];
      if (green > red + 64 && green > blue + 32) ++result.target_pixels;
      if (red > green + 64 && blue > green + 64) ++result.overlay_pixels;
    }
  }
  return result;
}

bool has_marker(const Sample &sample, bool overlay) {
  return (overlay ? sample.overlay_pixels : sample.target_pixels) == kSampleSize * kSampleSize;
}

void pump_messages() {
  MSG message{};
  while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }
}

struct ProbeEvent {
  HANDLE value = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  ProbeEvent() {
    if (!value) throw ProbeFailure{"createProbeEvent", HRESULT_FROM_WIN32(GetLastError())};
  }
  ~ProbeEvent() { CloseHandle(value); }
  ProbeEvent(const ProbeEvent &) = delete;
  ProbeEvent &operator=(const ProbeEvent &) = delete;
};

// 仅对测试遮挡窗口暂停观察线程，构造消息延后交付；不挂钩其他进程。
class DelayedWindowEvents {
 public:
  std::atomic<UINT> generation{0}, show_count{0}, hide_count{0};
  std::atomic<LONGLONG> first_delivery{0};

 private:
  ProbeEvent stop, ready, resume, delivered;
  HWND overlay;
  std::atomic<DWORD> error{ERROR_SUCCESS};
  std::jthread worker;
  inline static thread_local DelayedWindowEvents *observer = nullptr;

  static void CALLBACK on_event(HWINEVENTHOOK, DWORD event, HWND window, LONG object, LONG child, DWORD, DWORD) {
    auto *current = observer;
    if (!current || window != current->overlay || object != OBJID_WINDOW || child != CHILDID_SELF) return;
    if (event == EVENT_OBJECT_SHOW) ++current->show_count;
    else if (event == EVENT_OBJECT_HIDE) ++current->hide_count;
    else return;
    LARGE_INTEGER time{};
    QueryPerformanceCounter(&time);
    LONGLONG empty = 0;
    current->first_delivery.compare_exchange_strong(empty, time.QuadPart);
    ++current->generation;
    if (current->show_count.load() && current->hide_count.load()) SetEvent(current->delivered.value);
  }

  void observe(std::stop_token token) {
    std::stop_callback cancellation(token, [this] { SetEvent(stop.value); SetEvent(resume.value); });
    observer = this;
    MSG message{};
    PeekMessageW(&message, nullptr, 0, 0, PM_NOREMOVE);
    const auto hook = SetWinEventHook(EVENT_OBJECT_SHOW, EVENT_OBJECT_HIDE, nullptr, on_event,
        GetCurrentProcessId(), 0, WINEVENT_OUTOFCONTEXT);
    if (!hook) error = GetLastError() ? GetLastError() : ERROR_GEN_FAILURE;
    SetEvent(ready.value);
    if (hook) {
      HANDLE waiting[]{stop.value, resume.value};
      const auto resumed = WaitForMultipleObjects(2, waiting, FALSE, 2000);
      if (resumed == WAIT_OBJECT_0 + 1) {
        while (WaitForSingleObject(stop.value, 0) == WAIT_TIMEOUT) {
          const auto result = MsgWaitForMultipleObjects(1, &stop.value, FALSE, 100, QS_ALLINPUT);
          if (result == WAIT_OBJECT_0) break;
          if (result == WAIT_FAILED) { error = GetLastError(); break; }
          pump_messages();
        }
      } else if (resumed != WAIT_OBJECT_0) error = resumed == WAIT_TIMEOUT ? ERROR_TIMEOUT : GetLastError();
      UnhookWinEvent(hook);
    }
    observer = nullptr;
  }

 public:
  explicit DelayedWindowEvents(HWND window) : overlay(window) {
    worker = std::jthread([this](std::stop_token token) { observe(token); });
    const auto result = WaitForSingleObject(ready.value, 2000);
    if (result != WAIT_OBJECT_0 || error.load()) {
      throw ProbeFailure{"prepareEventObserver", HRESULT_FROM_WIN32(error.load() ? error.load() : ERROR_TIMEOUT)};
    }
  }

  bool drain() {
    SetEvent(resume.value);
    const auto result = WaitForSingleObject(delivered.value, 1000);
    return result == WAIT_OBJECT_0 && error.load() == ERROR_SUCCESS;
  }
};

LRESULT CALLBACK paint_window(HWND window, UINT message, WPARAM word, LPARAM parameter) {
  if (message == WM_NCCREATE) {
    const auto *creation = reinterpret_cast<CREATESTRUCTW *>(parameter);
    SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(creation->lpCreateParams));
  }
  if (message == WM_PAINT) {
    PAINTSTRUCT paint{};
    const auto dc = BeginPaint(window, &paint);
    const auto color = GetWindowLongPtrW(window, GWLP_USERDATA) ? kOverlayColor : kTargetColor;
    const auto brush = CreateSolidBrush(color);
    FillRect(dc, &paint.rcPaint, brush);
    DeleteObject(brush);
    EndPaint(window, &paint);
    return 0;
  }
  return DefWindowProcW(window, message, word, parameter);
}

struct Fixture {
  HWND target = nullptr;
  HWND overlay = nullptr;
  RECT bounds{};
  HMONITOR monitor = nullptr;

  Fixture() {
    WNDCLASSW type{};
    type.lpfnWndProc = paint_window;
    type.hInstance = GetModuleHandleW(nullptr);
    type.lpszClassName = L"LycanSyncDxgiWindowProbe";
    if (!RegisterClassW(&type)) throw ProbeFailure{"registerFixture", HRESULT_FROM_WIN32(GetLastError())};
    monitor = MonitorFromPoint(POINT{}, MONITOR_DEFAULTTOPRIMARY);
    MONITORINFO info{sizeof(info)};
    if (!GetMonitorInfoW(monitor, &info)) throw ProbeFailure{"fixtureMonitor", HRESULT_FROM_WIN32(GetLastError())};
    bounds = {info.rcWork.left + 32, info.rcWork.top + 32, info.rcWork.left + 352, info.rcWork.top + 212};
    if (bounds.right > info.rcWork.right || bounds.bottom > info.rcWork.bottom) throw ProbeFailure{"fixtureSpace", E_FAIL};
    target = CreateWindowExW(WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW, type.lpszClassName,
        L"LycanSync DXGI controlled target", WS_POPUP, bounds.left, bounds.top, 320, 180,
        nullptr, nullptr, type.hInstance, nullptr);
    if (!target) throw ProbeFailure{"createFixture", HRESULT_FROM_WIN32(GetLastError())};
    overlay = CreateWindowExW(WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW, type.lpszClassName,
        L"LycanSync DXGI controlled cover", WS_POPUP, bounds.left, bounds.top, 320, 180,
        nullptr, nullptr, type.hInstance, reinterpret_cast<void *>(1));
    if (!overlay) {
      DestroyWindow(target);
      target = nullptr;
      throw ProbeFailure{"createOverlay", HRESULT_FROM_WIN32(GetLastError())};
    }
    ShowWindow(target, SW_SHOWNOACTIVATE);
    UpdateWindow(target);
  }

  ~Fixture() {
    if (overlay) DestroyWindow(overlay);
    if (target) DestroyWindow(target);
  }

  void cover(bool visible) {
    if (!IsWindow(target) || !IsWindow(overlay)) throw ProbeFailure{"fixtureClosed", E_ABORT};
    if (visible) {
      if (!SetWindowPos(overlay, HWND_TOPMOST, bounds.left, bounds.top, 320, 180,
          SWP_NOACTIVATE | SWP_SHOWWINDOW)) throw ProbeFailure{"showOverlay", HRESULT_FROM_WIN32(GetLastError())};
      UpdateWindow(overlay);
    } else ShowWindow(overlay, SW_HIDE);
    pump_messages();
    // 只用于本进程色块已提交的实验条件；不是跨应用的隐私同步屏障。
    require_success(DwmFlush(), "fixtureFlush");
  }

  bool uncovered() const {
    if (!IsWindow(target) || !IsWindowVisible(target) || IsIconic(target)) return false;
    RECT current{};
    if (!GetWindowRect(target, &current) || !EqualRect(&current, &bounds)) return false;
    HWND window = nullptr;
    for (UINT checked = 0; checked < 512; ++checked) {
      // 包含开始菜单等系统顶层窗口；找不到目标或遍历异常都不视为无遮挡。
      window = FindWindowExW(nullptr, window, nullptr, nullptr);
      if (!window) return false;
      if (window == target) return true;
      if (!IsWindowVisible(window) || IsIconic(window)) continue;
      DWORD cloaked = 0;
      if (FAILED(DwmGetWindowAttribute(window, DWMWA_CLOAKED, &cloaked, sizeof(cloaked)))) return false;
      if (cloaked) continue;
      RECT other{}, overlap{};
      if (!GetWindowRect(window, &other) || IntersectRect(&overlap, &bounds, &other)) return false;
    }
    return false;
  }
};

struct DesktopProbe {
  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11DeviceContext> context;
  ComPtr<IDXGIOutputDuplication> duplication;
  ComPtr<ID3D11Texture2D> staging;
  RECT output_bounds{};

  explicit DesktopProbe(HMONITOR monitor) {
    ComPtr<IDXGIFactory1> factory;
    require_success(CreateDXGIFactory1(IID_PPV_ARGS(&factory)), "createFactory");
    bool found = false;
    for (UINT index = 0; !found; ++index) {
      ComPtr<IDXGIAdapter1> adapter;
      const auto enumerated = factory->EnumAdapters1(index, &adapter);
      if (enumerated == DXGI_ERROR_NOT_FOUND) break;
      require_success(enumerated, "enumerateAdapter");
      for (UINT number = 0; !found; ++number) {
        ComPtr<IDXGIOutput> output;
        const auto next = adapter->EnumOutputs(number, &output);
        if (next == DXGI_ERROR_NOT_FOUND) break;
        require_success(next, "enumerateOutput");
        DXGI_OUTPUT_DESC description{};
        require_success(output->GetDesc(&description), "describeOutput");
        if (description.Monitor != monitor) continue;
        if (!description.AttachedToDesktop || description.Rotation != DXGI_MODE_ROTATION_IDENTITY) {
          throw ProbeFailure{"unsupportedOutput", E_NOTIMPL};
        }
        output_bounds = description.DesktopCoordinates;
        require_success(D3D11CreateDevice(adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr,
            D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION, &device, nullptr, &context), "createDevice");
        ComPtr<IDXGIOutput1> compatible;
        require_success(output.As(&compatible), "queryOutput");
        require_success(compatible->DuplicateOutput(device.Get(), &duplication), "duplicateOutput");
        found = true;
      }
    }
    if (!found) throw ProbeFailure{"outputUnavailable", E_FAIL};
    D3D11_TEXTURE2D_DESC sample{};
    sample.Width = sample.Height = kSampleSize;
    sample.MipLevels = sample.ArraySize = 1;
    sample.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    sample.SampleDesc.Count = 1;
    sample.Usage = D3D11_USAGE_STAGING;
    sample.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    require_success(device->CreateTexture2D(&sample, nullptr, &staging), "createSample");
  }

  Sample wait_for_marker(const Fixture &fixture, bool overlay) {
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
    while (std::chrono::steady_clock::now() < deadline) {
      pump_messages();
      ComPtr<IDXGIResource> resource;
      DXGI_OUTDUPL_FRAME_INFO info{};
      const auto acquired = duplication->AcquireNextFrame(40, &info, &resource);
      if (acquired == DXGI_ERROR_WAIT_TIMEOUT) continue;
      require_success(acquired, "acquireFrame");
      struct Lease {
        IDXGIOutputDuplication *value;
        ~Lease() { if (value) value->ReleaseFrame(); }
      } lease{duplication.Get()};
      ComPtr<ID3D11Texture2D> texture;
      require_success(resource.As(&texture), "queryFrame");
      D3D11_TEXTURE2D_DESC description{};
      texture->GetDesc(&description);
      if (description.Format != DXGI_FORMAT_B8G8R8A8_UNORM) throw ProbeFailure{"unsupportedFrameFormat", E_NOTIMPL};
      DWORD owner = 0;
      if (!IsWindow(fixture.target) || GetWindowThreadProcessId(fixture.target, &owner) == 0
          || owner != GetCurrentProcessId()) throw ProbeFailure{"fixtureIdentity", E_ABORT};
      const LONG left = fixture.bounds.left - output_bounds.left + 152;
      const LONG top = fixture.bounds.top - output_bounds.top + 82;
      if (left < 0 || top < 0 || static_cast<UINT>(left) + kSampleSize > description.Width
          || static_cast<UINT>(top) + kSampleSize > description.Height) throw ProbeFailure{"sampleBounds", E_INVALIDARG};
      const D3D11_BOX box{static_cast<UINT>(left), static_cast<UINT>(top), 0,
          static_cast<UINT>(left) + kSampleSize, static_cast<UINT>(top) + kSampleSize, 1};
      // 桌面资源只在 GPU；CPU 只读自有色块中心 16×16，不保存或输出画面。
      context->CopySubresourceRegion(staging.Get(), 0, 0, 0, 0, texture.Get(), 0, &box);
      context->Flush();
      D3D11_MAPPED_SUBRESOURCE mapped{};
      HRESULT mapping;
      do {
        mapping = context->Map(staging.Get(), 0, D3D11_MAP_READ, D3D11_MAP_FLAG_DO_NOT_WAIT, &mapped);
        if (mapping != DXGI_ERROR_WAS_STILL_DRAWING) break;
        if (std::chrono::steady_clock::now() >= deadline) throw ProbeFailure{"mapSampleTimeout", mapping};
        Sleep(1);
      } while (true);
      require_success(mapping, "mapSample");
      auto result = count_markers(static_cast<const uint8_t *>(mapped.pData), mapped.RowPitch);
      context->Unmap(staging.Get(), 0);
      const auto released = duplication->ReleaseFrame();
      lease.value = nullptr;
      require_success(released, "releaseFrame");
      if (info.LastPresentTime.QuadPart && has_marker(result, overlay)) {
        result.present_time = info.LastPresentTime.QuadPart;
        result.accumulated_frames = info.AccumulatedFrames;
        return result;
      }
    }
    throw ProbeFailure{"markerNotObserved", HRESULT_FROM_WIN32(WAIT_TIMEOUT)};
  }
};

int self_test() {
  constexpr UINT pitch = kSampleSize * 4 + 12;
  uint8_t pixels[pitch * kSampleSize]{};
  for (UINT y = 0; y < kSampleSize; ++y) for (UINT x = 0; x < kSampleSize; ++x) {
    auto *pixel = pixels + y * pitch + x * 4;
    pixel[0] = 64; pixel[1] = 208; pixel[2] = 16;
  }
  const auto green = count_markers(pixels, pitch);
  if (!has_marker(green, false) || green.overlay_pixels) return 1;
  for (UINT y = 0; y < kSampleSize; ++y) for (UINT x = 0; x < kSampleSize; ++x) {
    auto *pixel = pixels + y * pitch + x * 4;
    pixel[0] = 208; pixel[1] = 16; pixel[2] = 224;
  }
  const auto purple = count_markers(pixels, pitch);
  if (!has_marker(purple, true) || purple.target_pixels) return 1;
  pixels[0] = pixels[1] = pixels[2] = 128;
  if (has_marker(count_markers(pixels, pitch), true)) return 1;
  std::puts("{\"event\":\"probeSelfTestPassed\",\"deviceAccessed\":false}");
  return 0;
}

int run_probe(bool delay_events) {
  const auto previous = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  if (!previous) throw ProbeFailure{"setThreadDpi", HRESULT_FROM_WIN32(GetLastError())};
  struct RestoreDpi { DPI_AWARENESS_CONTEXT value; ~RestoreDpi() { SetThreadDpiAwarenessContext(value); } } restore{previous};
  Fixture fixture;
  require_success(DwmFlush(), "fixturePresent");
  DesktopProbe desktop(fixture.monitor);
  desktop.wait_for_marker(fixture, false);
  const bool clear_before = fixture.uncovered();
  if (!clear_before) throw ProbeFailure{"fixtureAlreadyCovered", E_ABORT};
  const auto events = delay_events ? std::make_unique<DelayedWindowEvents>(fixture.overlay) : nullptr;
  const UINT generation_before = events ? events->generation.load() : 0;
  fixture.cover(true);
  const bool blocked_during = !fixture.uncovered();
  const auto captured = desktop.wait_for_marker(fixture, true);
  fixture.cover(false);
  const bool clear_after = fixture.uncovered();
  LARGE_INTEGER after{};
  QueryPerformanceCounter(&after);
  const UINT generation_at_decision = events ? events->generation.load() : 0;
  const bool stale_cover = captured.present_time < after.QuadPart;
  if (events) {
    const bool delivered = events->drain();
    const bool unchanged = generation_at_decision == generation_before;
    const bool late = events->first_delivery.load() > after.QuadPart;
    std::printf("{\"event\":\"dxgiWindowEventDelay\",\"generationBefore\":%u,\"generationAtDecision\":%u,"
        "\"generationAfterDrain\":%u,\"showEvents\":%u,\"hideEvents\":%u,\"eventsDelivered\":%s,"
        "\"firstDeliveryAfterDecision\":%s,\"unchangedGenerationWouldAcceptForeignFrame\":%s,\"productionApproved\":false}\n",
        generation_before, generation_at_decision, events->generation.load(), events->show_count.load(), events->hide_count.load(),
        delivered ? "true" : "false", late ? "true" : "false",
        clear_before && clear_after && unchanged && has_marker(captured, true) ? "true" : "false");
    if (!delivered || !late || !unchanged) throw ProbeFailure{"eventDelayNotObserved", E_FAIL};
  }
  desktop.wait_for_marker(fixture, false);
  std::printf("{\"event\":\"dxgiWindowProbe\",\"clearBefore\":%s,\"blockedDuring\":%s,\"clearAfter\":%s,"
      "\"foreignPixels\":%u,\"framePredatesFinalCheck\":%s,\"accumulatedFrames\":%u,"
      "\"naiveGateWouldAcceptForeignFrame\":%s,\"productionApproved\":false}\n",
      clear_before ? "true" : "false", blocked_during ? "true" : "false", clear_after ? "true" : "false",
      captured.overlay_pixels, stale_cover ? "true" : "false", captured.accumulated_frames,
      clear_before && clear_after && has_marker(captured, true) ? "true" : "false");
  return blocked_during && clear_after && stale_cover ? 0 : 1;
}
}  // namespace

int wmain(int argc, wchar_t **argv) {
  if (argc == 2 && std::wstring_view(argv[1]) == L"--self-test") return self_test();
  const bool event_delay = argc == 2 && std::wstring_view(argv[1]) == L"--run-event-delay";
  if (argc != 2 || (std::wstring_view(argv[1]) != L"--run-controlled-windows" && !event_delay)) {
    std::fputs("Use --self-test without devices, or explicitly authorize --run-controlled-windows / --run-event-delay.\n", stderr);
    return 2;
  }
  try { return run_probe(event_delay); }
  catch (const ProbeFailure &failure) {
    std::printf("{\"event\":\"probeFailed\",\"stage\":\"%s\",\"hresult\":\"%08lx\",\"productionApproved\":false}\n",
        failure.stage, static_cast<unsigned long>(failure.result));
    return 1;
  }
}
