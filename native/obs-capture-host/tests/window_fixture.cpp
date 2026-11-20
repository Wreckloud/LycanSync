#include <windows.h>
#include <iostream>
#include <cstdint>
#include <string>
#include <thread>
#include <charconv>

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
      case 7: {
        RECT client{}; POINT center{};
        if (!GetClientRect(g_target, &client)) return 0;
        center.x = client.right / 2; center.y = client.bottom / 2;
        if (!ClientToScreen(g_target, &center)) return 0;
        const auto cover = GetAncestor(WindowFromPoint(center), GA_ROOT);
        RECT receiver{};
        GetWindowRect(reinterpret_cast<HWND>(parameter), &receiver);
        std::cout << "{\"event\":\"coverChecked\",\"receiverCoversTarget\":"
                  << (cover == reinterpret_cast<HWND>(parameter) ? "true" : "false")
                  << ",\"targetCenter\":{\"x\":" << center.x << ",\"y\":" << center.y
                  << "},\"receiverBounds\":{\"left\":" << receiver.left << ",\"top\":" << receiver.top
                  << ",\"right\":" << receiver.right << ",\"bottom\":" << receiver.bottom << "}}\n" << std::flush;
        return 0;
      }
      case 8:
      case 9:
      case 10: {
        // 只移动夹具自己的洋红窗；用物理坐标确认目标四角和中心确实被它覆盖。
        const auto target = reinterpret_cast<HWND>(parameter);
        RECT rect{};
        const bool measurable = target != g_other && IsWindowVisible(target) && !IsIconic(target)
            && GetWindowRect(target, &rect) && rect.right > rect.left && rect.bottom > rect.top;
        bool covered = measurable;
        if (covered && word == 8) {
          SetWindowLongPtrW(g_other, GWL_STYLE, WS_POPUP | WS_VISIBLE);
          covered = SetWindowPos(g_other, HWND_TOPMOST, rect.left, rect.top, rect.right - rect.left,
              rect.bottom - rect.top, SWP_NOACTIVATE | SWP_FRAMECHANGED | SWP_SHOWWINDOW) != FALSE;
          UpdateWindow(g_other);
        }
        const POINT center = {(rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2};
        if (word == 10) {
          const bool visible = measurable && GetAncestor(WindowFromPoint(center), GA_ROOT) == target;
          std::cout << "{\"event\":\"targetVisibilityChecked\",\"visible\":" << (visible ? "true" : "false")
                    << "}\n" << std::flush;
          return 0;
        }
        const POINT points[] = {{rect.left, rect.top}, {rect.right - 1, rect.top},
            {rect.left, rect.bottom - 1}, {rect.right - 1, rect.bottom - 1},
            center};
        for (auto point : points) {
          if (GetAncestor(WindowFromPoint(point), GA_ROOT) != g_other) covered = false;
        }
        std::cout << "{\"event\":\"fullCoverChecked\",\"covered\":" << (covered ? "true" : "false")
                  << "}\n" << std::flush;
        return 0;
      }
    }
    std::cout << "{\"event\":\"" << event << "\"}\n" << std::flush;
    return 0;
  }
  return DefWindowProcW(window, message, word, parameter);
}
}  // namespace

int wmain(int argc, wchar_t **argv) {
  const bool cover_only = argc == 2 && std::wstring(argv[1]) == L"--cover-only";
  if (argc != 1 && !cover_only) return 2;
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  const auto instance = GetModuleHandleW(nullptr);
  WNDCLASSW window_class{};
  window_class.hInstance = instance;
  window_class.lpfnWndProc = window_proc;
  window_class.lpszClassName = L"LycanSyncObsCaptureTest";
  if (!RegisterClassW(&window_class)) { std::cerr << "testWindowClassFailed:" << GetLastError() << '\n'; return 1; }
  // 两个同名窗口分属同一进程；只绘制受控色块，不接入真实应用或媒体设备。
  g_target = CreateWindowExW(0, L"LycanSyncObsCaptureTest",
                            L"LycanSync selected window test", WS_OVERLAPPEDWINDOW,
                            80, 120, 420, 310, nullptr, nullptr, instance, nullptr);
  g_other = CreateWindowExW(0, window_class.lpszClassName, L"LycanSync selected window test", WS_OVERLAPPEDWINDOW,
                           540, 120, 420, 310, nullptr, nullptr, instance, reinterpret_cast<void *>(1));
  if (!g_target || !g_other) { std::cerr << "testWindowCreateFailed:" << GetLastError() << '\n'; return 1; }
  std::cerr << "test-window: created\n";
  if (!cover_only) {
    ShowWindow(g_target, SW_SHOWNOACTIVATE);
    ShowWindow(g_other, SW_SHOWNOACTIVATE);
  }
  std::cerr << "test-window: shown\n";
  std::cout << "{\"event\":\"ready\",\"windowId\":\"" << reinterpret_cast<uintptr_t>(g_target)
            << "\",\"otherWindowId\":\"" << reinterpret_cast<uintptr_t>(g_other) << "\"}\n" << std::flush;
  std::thread reader([] {
    std::string command;
    while (std::getline(std::cin, command)) {
      const auto verb = command.substr(0, command.find(':'));
      if (verb == "check-cover" || verb == "place-cover" || verb == "verify-cover" || verb == "check-visible") {
        const auto separator = command.find(':');
        if (separator == std::string::npos) continue;
        uintptr_t cover = 0;
        const auto parsed = std::from_chars(command.data() + separator + 1, command.data() + command.size(), cover);
        if (parsed.ec == std::errc{} && parsed.ptr == command.data() + command.size() && cover)
          PostMessageW(g_other, kCommand, verb == "check-cover" ? 7 :
              verb == "place-cover" ? 8 : verb == "verify-cover" ? 9 : 10, static_cast<LPARAM>(cover));
        continue;
      }
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
