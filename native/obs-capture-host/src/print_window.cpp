#include "print_window.h"
#include <util/windows/win-version.h>
#include <winrt/base.h>
#include <objbase.h>
#include <atomic>
#include <chrono>
#include <filesystem>
#include <vector>

namespace {
using Clock = std::chrono::steady_clock;
constexpr wchar_t prefix[] = L"Local\\LycanSync.PrintWindow.";
constexpr char source_id[] = "lycansync_print_window";
// 一个请求对应一帧。宿主上传完成才唤醒子进程，DIB 在此之前不会被覆盖。
struct FrameSlot {
  LONG ready;
  DWORD width, height, generation;
  HWND window;
  DWORD pid;
  bool show_cursor;
  char lifetime[129], creation[24];
};

struct Mapping {
  winrt::handle handle;
  void *view = nullptr;
  ~Mapping() { reset(); }
  void reset() {
    if (view) UnmapViewOfFile(view);
    view = nullptr;
    handle.close();
  }
  bool create(const std::wstring &name, DWORD size) {
    reset();
    handle.attach(CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0, size, name.c_str()));
    if (!handle || GetLastError() == ERROR_ALREADY_EXISTS) return false;
    view = MapViewOfFile(handle.get(), FILE_MAP_WRITE, 0, 0, size);
    return view != nullptr;
  }
  bool open(const std::wstring &name, DWORD access, size_t size) {
    reset();
    handle.attach(OpenFileMappingW(access, FALSE, name.c_str()));
    if (handle) view = MapViewOfFile(handle.get(), access, 0, 0, size);
    return view != nullptr;
  }
};

bool valid_size(DWORD width, DWORD height) {
  return width && height && uint64_t(width) * height <= 16'777'216;
}

struct PrintSource {
  std::wstring channel;
  Mapping control, pixels;
  winrt::handle wake, process, job;
  Clock::time_point requested;
  WindowVideoTarget target;
  gs_texture_t *texture = nullptr;
  std::atomic<DWORD> width = 0, height = 0;
  std::atomic<bool> started = false;
  DWORD generation = 0;
  bool failed = false;
  ~PrintSource() {
    // PrintWindow 是不可取消的同步调用。关闭专属作业会一并回收卡在外部窗口的进程。
    job.close();
    obs_enter_graphics();
    gs_texture_destroy(texture);
    obs_leave_graphics();
  }
  bool start(const WindowVideoTarget &selected, bool show_cursor) {
    target = selected;
    GUID guid{};
    wchar_t identifier[40]{}, executable[32768]{};
    if (FAILED(CoCreateGuid(&guid)) || !StringFromGUID2(guid, identifier, 40)
        || !GetModuleFileNameW(nullptr, executable, 32768)) return false;
    channel = std::wstring(prefix) + identifier;
    if (!control.create(channel, sizeof(FrameSlot))) return false;
    auto &slot = *static_cast<FrameSlot *>(control.view);
    slot.window = target.window;
    slot.pid = target.process_id;
    slot.show_cursor = show_cursor;
    if (target.lifetime_name.size() >= sizeof(slot.lifetime) || target.process_creation.size() >= sizeof(slot.creation)) return false;
    strcpy_s(slot.lifetime, target.lifetime_name.c_str());
    strcpy_s(slot.creation, target.process_creation.c_str());
    wake.attach(CreateEventW(nullptr, FALSE, TRUE, (channel + L".request").c_str()));
    job.attach(CreateJobObjectW(nullptr, nullptr));
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!wake || !job || !SetInformationJobObject(job.get(), JobObjectExtendedLimitInformation, &limits, sizeof(limits))) return false;
    STARTUPINFOEXW startup{};
    startup.StartupInfo.cb = sizeof(startup);
    SIZE_T bytes = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &bytes);
    std::vector<unsigned char> storage(bytes);
    startup.lpAttributeList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
    if (!InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &bytes)) return false;
    HANDLE owned_job = job.get();
    PROCESS_INFORMATION child{};
    auto command = L"\"" + std::wstring(executable) + L"\" --print-window " + channel;
    const bool launched = UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST,
        &owned_job, sizeof(owned_job), nullptr, nullptr) && CreateProcessW(executable, command.data(), nullptr, nullptr,
        FALSE, CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT, nullptr, nullptr, &startup.StartupInfo, &child);
    DeleteProcThreadAttributeList(startup.lpAttributeList);
    if (!launched) return false;
    CloseHandle(child.hThread);
    process.attach(child.hProcess);
    requested = Clock::now();
    started.store(true);
    return true;
  }
  void tick() {
    if (!started.load() || failed || !window_video_target_valid(target)) return;
    if (WaitForSingleObject(process.get(), 0) != WAIT_TIMEOUT) { failed = true; return; }
    auto &slot = *static_cast<FrameSlot *>(control.view);
    if (!InterlockedCompareExchange(&slot.ready, 0, 0)) {
      if (Clock::now() - requested > std::chrono::seconds(2)) { failed = true; job.close(); }
      return;
    }
    if (window_video_suspended(target)) return;
    if (slot.width && slot.height) {
      if (!valid_size(slot.width, slot.height)) { failed = true; return; }
      obs_enter_graphics();
      if (slot.generation != generation) {
        gs_texture_destroy(texture);
        texture = nullptr;
        if (pixels.open(channel + L"." + std::to_wstring(slot.generation), FILE_MAP_READ, size_t(slot.width) * slot.height * 4))
          texture = gs_texture_create(slot.width, slot.height, GS_BGRX, 1, nullptr, GS_DYNAMIC);
        generation = slot.generation;
      }
      if (texture) {
        gs_texture_set_image(texture, static_cast<const uint8_t *>(pixels.view), slot.width * 4, false);
        width.store(slot.width);
        height.store(slot.height);
      } else failed = true;
      obs_leave_graphics();
    }
    requested = Clock::now();
    InterlockedExchange(&slot.ready, 0);
    if (!SetEvent(wake.get())) failed = true;
  }
};

struct WorkerBitmap {
  HDC dc = CreateCompatibleDC(nullptr);
  HBITMAP bitmap = nullptr;
  HGDIOBJ previous = nullptr;
  Mapping pixels;
  DWORD width = 0, height = 0;
  void clear() {
    if (previous) SelectObject(dc, previous);
    if (bitmap) DeleteObject(bitmap);
    bitmap = nullptr;
    previous = nullptr;
    pixels.reset();
  }
  ~WorkerBitmap() { clear(); if (dc) DeleteDC(dc); }
  bool resize(const std::wstring &name, DWORD w, DWORD h) {
    clear();
    if (!dc || !pixels.create(name, w * h * 4)) return false;
    BITMAPINFO info{};
    info.bmiHeader = {sizeof(BITMAPINFOHEADER), LONG(w), -LONG(h), 1, 32, BI_RGB};
    void *bits = nullptr;
    bitmap = CreateDIBSection(dc, &info, DIB_RGB_COLORS, &bits, pixels.handle.get(), 0);
    if (!bitmap) return false;
    previous = SelectObject(dc, bitmap);
    width = w; height = h;
    return previous && previous != HGDI_ERROR;
  }
  void draw_cursor(HWND window) {
    CURSORINFO cursor{sizeof(CURSORINFO)};
    if (!GetCursorInfo(&cursor) || !(cursor.flags & CURSOR_SHOWING)
        || GetAncestor(WindowFromPoint(cursor.ptScreenPos), GA_ROOT) != window) return;
    ICONINFO icon{};
    if (!GetIconInfo(cursor.hCursor, &icon)) return;
    POINT point = cursor.ptScreenPos;
    if (ScreenToClient(window, &point))
      DrawIconEx(dc, point.x - int(icon.xHotspot), point.y - int(icon.yHotspot), cursor.hCursor, 0, 0, 0, nullptr, DI_NORMAL);
    if (icon.hbmColor) DeleteObject(icon.hbmColor);
    if (icon.hbmMask) DeleteObject(icon.hbmMask);
  }
};
}

bool prefers_print_window(const WindowVideoTarget &target) {
  win_version_info version{};
  get_win_ver(&version);
  if (version.major != 10 || version.build < 19041 || version.build >= 20348 || !window_video_target_valid(target)) return false;
  wchar_t path[32768]{}, cls[128]{};
  DWORD length = 32768;
  if (!QueryFullProcessImageNameW(target.binding->process, 0, path, &length) || !GetClassNameW(target.window, cls, 128)) return false;
  const auto exe = std::filesystem::path(path).filename().wstring();
  return ((!_wcsicmp(exe.c_str(), L"ChatGPT.exe") || !_wcsicmp(exe.c_str(), L"chrome.exe")) && !wcscmp(cls, L"Chrome_WidgetWin_1"))
      || (!_wcsicmp(exe.c_str(), L"dontstarve_steam_x64.exe") && !wcscmp(cls, L"opengles2.0"));
}

void register_print_window_source() {
  obs_source_info info{};
  info.id = source_id;
  info.type = OBS_SOURCE_TYPE_INPUT;
  info.output_flags = OBS_SOURCE_VIDEO;
  info.get_name = [](void *) { return "LycanSync PrintWindow"; };
  info.create = [](obs_data_t *, obs_source_t *) -> void * { return new PrintSource; };
  info.destroy = [](void *data) { delete static_cast<PrintSource *>(data); };
  info.video_tick = [](void *data, float) { static_cast<PrintSource *>(data)->tick(); };
  info.get_width = [](void *data) -> uint32_t { return static_cast<PrintSource *>(data)->width.load(); };
  info.get_height = [](void *data) -> uint32_t { return static_cast<PrintSource *>(data)->height.load(); };
  info.video_render = [](void *data, gs_effect_t *) {
    auto &source = *static_cast<PrintSource *>(data);
    if (source.texture && !source.failed && window_video_target_valid(source.target))
      obs_source_draw(source.texture, 0, 0, 0, 0, false);
  };
  obs_register_source(&info);
}

obs_source_t *create_print_window_source(const WindowVideoTarget &target, bool show_cursor) {
  auto *source = obs_source_create_private(source_id, "LycanSync selected window", nullptr);
  auto *state = source ? static_cast<PrintSource *>(obs_obj_get_data(source)) : nullptr;
  if (state && state->start(target, show_cursor)) return source;
  obs_source_release(source);
  return nullptr;
}

bool print_window_failed(obs_source_t *source) {
  return static_cast<PrintSource *>(obs_obj_get_data(source))->failed;
}

int run_print_window_worker(const wchar_t *name) {
  const std::wstring channel(name);
  if (!channel.starts_with(prefix) || channel.size() != std::wstring_view(prefix).size() + 38) return 2;
  SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  Mapping control;
  winrt::handle wake(OpenEventW(SYNCHRONIZE, FALSE, (channel + L".request").c_str()));
  if (!wake || !control.open(channel, FILE_MAP_WRITE, sizeof(FrameSlot))) return 1;
  auto &slot = *static_cast<FrameSlot *>(control.view);
  if (!memchr(slot.lifetime, 0, sizeof(slot.lifetime)) || !memchr(slot.creation, 0, sizeof(slot.creation))) return 2;
  WindowVideoTarget target{slot.window, slot.lifetime, slot.pid, slot.creation};
  if (!bind_window_video_target(target)) return 1;
  WorkerBitmap bitmap;
  while (WaitForSingleObject(wake.get(), INFINITE) == WAIT_OBJECT_0) {
    if (!window_video_target_valid(target)) return 1;
    RECT client{};
    if (!GetClientRect(target.window, &client)) return 1;
    if (window_video_suspended(target) || !client.right || !client.bottom) {
      slot.width = slot.height = 0;
    } else {
      DWORD affinity = 0;
      if (GetWindowDisplayAffinity(target.window, &affinity) && affinity != WDA_NONE) return 1;
      if (!valid_size(client.right, client.bottom)) return 1;
      if (bitmap.width != DWORD(client.right) || bitmap.height != DWORD(client.bottom)) {
        if (!bitmap.resize(channel + L"." + std::to_wstring(++slot.generation), client.right, client.bottom)) return 1;
      }
      if (!PrintWindow(target.window, bitmap.dc, PW_CLIENTONLY | PW_RENDERFULLCONTENT)) return 1;
      if (slot.show_cursor) bitmap.draw_cursor(target.window);
      if (!GdiFlush() || !window_video_target_valid(target)) return 1;
      slot.width = bitmap.width; slot.height = bitmap.height;
    }
    InterlockedExchange(&slot.ready, 1);
  }
  return 1;
}
