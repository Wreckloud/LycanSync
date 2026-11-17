#include <windows.h>
#include <d3d11.h>
#include <d3d11_1.h>
#include <wrl/client.h>
#include <chrono>
#include <cstdint>
#include <iostream>
#include <string>
#include <string_view>
#include <thread>

using Microsoft::WRL::ComPtr;

namespace {
struct TestWindow {
  HWND window = nullptr;
  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11DeviceContext> context;
  ComPtr<ID3D11DeviceContext1> motion_context;
  ComPtr<IDXGISwapChain> swap_chain;
  ComPtr<ID3D11RenderTargetView> render_target;
  unsigned width = 400, height = 260;
  uint64_t present_calls = 0;
};
TestWindow g_target, g_other;
bool g_target_cyan = false;
bool g_benchmark = false;
std::chrono::steady_clock::time_point g_started;
constexpr UINT kCommand = WM_APP + 1;

void close_window(TestWindow &target) {
  target.motion_context.Reset();
  target.context.Reset();
  target.render_target.Reset();
  target.swap_chain.Reset();
  target.device.Reset();
  if (target.window) DestroyWindow(target.window);
  target.window = nullptr;
}

LRESULT CALLBACK window_proc(HWND window, UINT message, WPARAM word, LPARAM parameter) {
  // 控制消息发给保留的第二个窗口；关闭被采集窗口后仍可验证不会接管它。
  if (message == kCommand) {
    const char *event = "unknown";
    switch (word) {
      case 1: SetWindowTextW(g_target.window, L"LycanSync renamed D3D test"); event = "renamed"; break;
      case 2: ShowWindow(g_target.window, SW_MINIMIZE); event = "minimized"; break;
      case 3: ShowWindow(g_target.window, SW_SHOWNOACTIVATE); event = "restored"; break;
      case 4: close_window(g_target); event = "targetClosed"; break;
      case 5: PostQuitMessage(0); event = "quitting"; break;
      case 6: g_target_cyan = !g_target_cyan; event = "colorChanged"; break;
      case 7:
        std::cout << "{\"event\":\"statistics\",\"presentCalls\":" << g_target.present_calls
                  << ",\"elapsedMs\":" << std::chrono::duration_cast<std::chrono::milliseconds>(
                      std::chrono::steady_clock::now() - g_started).count()
                  << ",\"width\":" << g_target.width << ",\"height\":" << g_target.height
                  << ",\"motion\":" << (g_benchmark ? "true" : "false") << "}\n" << std::flush;
        return 0;
    }
    std::cout << "{\"event\":\"" << event << "\"}\n" << std::flush;
    return 0;
  }
  if (message == WM_CLOSE) { PostQuitMessage(0); return 0; }
  return DefWindowProcW(window, message, word, parameter);
}

bool create_window(TestWindow &target, int x, unsigned width = 400, unsigned height = 260) {
  target.width = width; target.height = height;
  target.window = CreateWindowExW(0, L"LycanSyncObsD3DTest", L"LycanSync selected D3D test", WS_OVERLAPPEDWINDOW,
                                 x, 440, 420, 310, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
  if (!target.window) return false;
  DXGI_SWAP_CHAIN_DESC description{};
  description.BufferDesc.Width = width;
  description.BufferDesc.Height = height;
  description.BufferDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
  description.SampleDesc.Count = 1;
  description.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
  description.BufferCount = 2;
  description.OutputWindow = target.window;
  description.Windowed = TRUE;
  description.SwapEffect = DXGI_SWAP_EFFECT_DISCARD;
  if (FAILED(D3D11CreateDeviceAndSwapChain(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, 0, nullptr, 0,
      D3D11_SDK_VERSION, &description, &target.swap_chain, &target.device, nullptr, &target.context))) return false;
  if (g_benchmark && &target == &g_target && FAILED(target.context.As(&target.motion_context))) return false;
  ComPtr<ID3D11Texture2D> back_buffer;
  if (FAILED(target.swap_chain->GetBuffer(0, IID_PPV_ARGS(&back_buffer)))
      || FAILED(target.device->CreateRenderTargetView(back_buffer.Get(), nullptr, &target.render_target))) return false;
  ShowWindow(target.window, SW_SHOWNOACTIVATE);
  return true;
}

bool present(TestWindow &target, const float (&color)[4]) {
  if (!target.window) return true;
  target.context->ClearRenderTargetView(target.render_target.Get(), color);
  if (g_benchmark && &target == &g_target) {
    const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - g_started).count();
    for (unsigned index = 0; index < 32; ++index) {
      const LONG x = static_cast<LONG>((elapsed * 9 / 16 + index * 61) % (target.width - 96));
      // 中心仍保留受控颜色，移动条纹用于独立核对传输中的实际新画面。
      const LONG y = index < 16 ? index * 28 : 600 + (index - 16) * 28;
      const D3D11_RECT rectangle{x, y, x + 96, y + 24};
      const float tint[4] = {0.2f + (index % 3) * 0.3f, 0.2f + (index % 5) * 0.15f, 0.8f, 1};
      target.motion_context->ClearView(target.render_target.Get(), tint, &rectangle, 1);
    }
  }
  if (FAILED(target.swap_chain->Present(0, 0))) return false;
  ++target.present_calls;
  return true;
}
}  // namespace

int wmain(int argc, wchar_t **argv) {
  if (argc != 1 && (argc != 2 || std::wstring_view(argv[1]) != L"--benchmark")) return 2;
  g_benchmark = argc == 2;
  g_started = std::chrono::steady_clock::now();
  WNDCLASSW window_class{};
  window_class.hInstance = GetModuleHandleW(nullptr);
  window_class.lpfnWndProc = window_proc;
  window_class.lpszClassName = L"LycanSyncObsD3DTest";
  if (!RegisterClassW(&window_class)
      || !create_window(g_target, 80, g_benchmark ? 1920 : 400, g_benchmark ? 1080 : 260)
      || !create_window(g_other, 540)) {
    std::cerr << "d3dFixtureCreationFailed\n";
    close_window(g_target);
    close_window(g_other);
    return 1;
  }
  std::cout << "{\"event\":\"ready\",\"windowId\":\"" << reinterpret_cast<uintptr_t>(g_target.window)
            << "\",\"otherWindowId\":\"" << reinterpret_cast<uintptr_t>(g_other.window) << "\"}\n" << std::flush;
  const HWND command_window = g_other.window;
  std::thread reader([command_window] {
    std::string command;
    while (std::getline(std::cin, command)) {
      const WPARAM code = command == "rename" ? 1 : command == "minimize" ? 2 : command == "restore" ? 3
          : command == "close" ? 4 : command == "quit" ? 5 : command == "toggle-color" ? 6 : command == "statistics" ? 7 : 0;
      if (code) PostMessageW(command_window, kCommand, code, 0);
      if (code == 5) return;
    }
    PostMessageW(command_window, kCommand, 5, 0);
  });
  const float green[4] = {16 / 255.0f, 200 / 255.0f, 80 / 255.0f, 1};
  const float cyan[4] = {16 / 255.0f, 200 / 255.0f, 220 / 255.0f, 1};
  const float magenta[4] = {220 / 255.0f, 16 / 255.0f, 200 / 255.0f, 1};
  bool running = true;
  int result = 0;
  while (running) {
    const auto next_frame = std::chrono::steady_clock::now() + std::chrono::milliseconds(8);
    MSG message{};
    while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
      if (message.message == WM_QUIT) { running = false; break; }
      TranslateMessage(&message);
      DispatchMessageW(&message);
    }
    if (!running) break;
    if (!present(g_target, g_target_cyan ? cyan : green) || !present(g_other, magenta)) {
      std::cerr << "d3dFixturePresentFailed\n";
      result = 1;
      break;
    }
    std::this_thread::sleep_until(next_frame);
  }
  // 外部关窗也唤醒阻塞的 stdin；不留下控制线程或 D3D 交换链。
  if (reader.joinable()) {
    CancelSynchronousIo(reader.native_handle());
    reader.join();
  }
  close_window(g_target);
  close_window(g_other);
  return result;
}
