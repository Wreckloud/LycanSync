#include <windows.h>
#include <iostream>
#include <cstdint>
#include <string>
#include <thread>

namespace {
HWND g_target = nullptr;
HWND g_other = nullptr;
bool g_target_cyan = false;
constexpr UINT kCommand = WM_APP + 1;

LRESULT CALLBACK window_proc(HWND window, UINT message, WPARAM word, LPARAM parameter) {
  if (message == WM_NCCREATE) {
    const auto *creation = reinterpret_cast<CREATESTRUCTW *>(parameter);
    SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(creation->lpCreateParams));
  }
  if (message == WM_PAINT) {
    PAINTSTRUCT paint{};
    const auto dc = BeginPaint(window, &paint);
    const auto brush = CreateSolidBrush(GetWindowLongPtrW(window, GWLP_USERDATA) ? RGB(220, 16, 200)
        : g_target_cyan ? RGB(16, 200, 220) : RGB(16, 200, 80));
    FillRect(dc, &paint.rcPaint, brush);
    DeleteObject(brush);
    EndPaint(window, &paint);
    return 0;
  }
  if (message == kCommand) {
    const char *event = "unknown";
    switch (word) {
      case 1: SetWindowTextW(g_target, L"LycanSync renamed test window"); event = "renamed"; break;
      case 2: ShowWindow(g_target, SW_MINIMIZE); event = "minimized"; break;
      case 3: ShowWindow(g_target, SW_SHOWNOACTIVATE); event = "restored"; break;
      case 4: DestroyWindow(g_target); g_target = nullptr; event = "targetClosed"; break;
      case 5:
        if (g_target) DestroyWindow(g_target);
        DestroyWindow(g_other);
        PostQuitMessage(0);
        event = "quitting";
        break;
      case 6:
        g_target_cyan = !g_target_cyan;
        InvalidateRect(g_target, nullptr, FALSE);
        UpdateWindow(g_target);
        event = "colorChanged";
        break;
    }
    std::cout << "{\"event\":\"" << event << "\"}\n" << std::flush;
    return 0;
  }
  return DefWindowProcW(window, message, word, parameter);
}
}  // namespace

int wmain() {
  const auto instance = GetModuleHandleW(nullptr);
  WNDCLASSW window_class{};
  window_class.hInstance = instance;
  window_class.lpfnWndProc = window_proc;
  window_class.lpszClassName = L"LycanSyncObsCaptureTest";
  if (!RegisterClassW(&window_class)) return 1;
  // 两个同名窗口分属同一进程；只绘制受控色块，不接入真实应用或媒体设备。
  g_target = CreateWindowExW(0, window_class.lpszClassName, L"LycanSync selected window test", WS_OVERLAPPEDWINDOW,
                            80, 120, 420, 310, nullptr, nullptr, instance, nullptr);
  g_other = CreateWindowExW(0, window_class.lpszClassName, L"LycanSync selected window test", WS_OVERLAPPEDWINDOW,
                           540, 120, 420, 310, nullptr, nullptr, instance, reinterpret_cast<void *>(1));
  if (!g_target || !g_other) return 1;
  ShowWindow(g_target, SW_SHOWNOACTIVATE);
  ShowWindow(g_other, SW_SHOWNOACTIVATE);
  std::cout << "{\"event\":\"ready\",\"windowId\":\"" << reinterpret_cast<uintptr_t>(g_target)
            << "\",\"otherWindowId\":\"" << reinterpret_cast<uintptr_t>(g_other) << "\"}\n" << std::flush;
  std::thread reader([] {
    std::string command;
    while (std::getline(std::cin, command)) {
      const WPARAM code = command == "rename" ? 1 : command == "minimize" ? 2 : command == "restore" ? 3
          : command == "close" ? 4 : command == "quit" ? 5 : command == "toggle-color" ? 6 : 0;
      if (code) PostMessageW(g_other, kCommand, code, 0);
      if (code == 5) return;
    }
    PostMessageW(g_other, kCommand, 5, 0);
  });
  MSG message{};
  while (GetMessageW(&message, nullptr, 0, 0) > 0) {
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }
  reader.join();
  return 0;
}
