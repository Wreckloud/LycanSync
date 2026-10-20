#include "bound_audio_target.h"

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <string_view>

#define CHECK(condition) do { if (!(condition)) { std::fprintf(stderr, "audio target check failed at line %d\n", __LINE__); return 1; } } while (0)

int main(int argc, char **argv) {
  if (argc == 3 && std::string_view(argv[1]) == "--wait-for-event") {
    const HANDLE signal = reinterpret_cast<HANDLE>(static_cast<uintptr_t>(std::strtoull(argv[2], nullptr, 10)));
    return WaitForSingleObject(signal, 10'000) == WAIT_OBJECT_0 ? 0 : 1;
  }
  // 本测试只创建自己的隐藏窗口；不初始化 OBS、WASAPI 或任何录音设备。
  const HWND selected = CreateWindowExA(0, "STATIC", "LycanSync audio binding test", WS_OVERLAPPEDWINDOW,
      0, 0, 100, 100, nullptr, nullptr, nullptr, nullptr);
  const HWND other = CreateWindowExA(0, "STATIC", "LycanSync audio binding test", WS_OVERLAPPEDWINDOW,
      0, 0, 100, 100, nullptr, nullptr, nullptr, nullptr);
  CHECK(selected && other);
  const char *property = "LycanSync.MediaHelper.Window.1.2.3";
  const HANDLE marker = reinterpret_cast<HANDLE>(uintptr_t{123});
  CHECK(SetPropA(selected, property, marker));
  obs_data_t *settings = obs_data_create();
  BoundAudioTarget missing;
  CHECK(!missing.read(settings));
  obs_data_set_int(settings, "lycansync_window_id", static_cast<long long>(reinterpret_cast<uintptr_t>(selected)));
  obs_data_set_string(settings, "lycansync_window_property", property);
  obs_data_set_int(settings, "lycansync_window_property_value", 456);
  BoundAudioTarget wrong_marker;
  CHECK(!wrong_marker.read(settings));
  obs_data_set_int(settings, "lycansync_window_property_value", 123);
  obs_data_set_string(settings, "lycansync_window_property", "LycanSync.MediaHelper.Window.fake");
  BoundAudioTarget invalid_property;
  CHECK(!invalid_property.read(settings));
  obs_data_set_string(settings, "lycansync_window_property", property);
  BoundAudioTarget target;
  CHECK(target.read(settings));
  CHECK(target.valid() && target.window() == selected && target.process_id() == GetCurrentProcessId());
  CHECK(!target.exclude());
  CHECK(SetWindowTextA(selected, "renamed"));
  CHECK(target.valid());
  obs_data_set_int(settings, "lycansync_window_id", static_cast<long long>(reinterpret_cast<uintptr_t>(other)));
  BoundAudioTarget same_title;
  CHECK(!same_title.read(settings));
  CHECK(RemovePropA(selected, property) == marker);
  CHECK(!target.valid());
  CHECK(SetPropA(selected, property, marker));
  CHECK(target.valid());
  CHECK(DestroyWindow(selected));
  CHECK(!target.valid() && IsWindow(other));
  CHECK(DestroyWindow(other));
  obs_data_release(settings);

  settings = obs_data_create();
  obs_data_set_bool(settings, "lycansync_exclude_process", true);
  BoundAudioTarget missing_process;
  CHECK(!missing_process.read(settings));
  obs_data_set_int(settings, "lycansync_process_id", -1);
  BoundAudioTarget negative_process;
  CHECK(!negative_process.read(settings));
  obs_data_set_int(settings, "lycansync_process_id", 0x100000000LL);
  BoundAudioTarget oversized_process;
  CHECK(!oversized_process.read(settings));
  obs_data_set_int(settings, "lycansync_process_id", GetCurrentProcessId());
  BoundAudioTarget excluded;
  CHECK(excluded.read(settings) && excluded.valid() && excluded.exclude());
  CHECK(excluded.window() == nullptr && excluded.process_id() == GetCurrentProcessId());
  CHECK(!excluded.read(settings));
  obs_data_set_int(settings, "lycansync_window_id", 0);
  BoundAudioTarget mixed_target;
  CHECK(!mixed_target.read(settings));
  obs_data_release(settings);

  // 子进程只等待本测试的事件，退出后原句柄必须失效，不能仅凭 PID 留住采集资格。
  SECURITY_ATTRIBUTES security{sizeof(security), nullptr, TRUE};
  const HANDLE signal = CreateEventW(&security, TRUE, FALSE, nullptr);
  CHECK(signal);
  wchar_t executable[32768];
  const DWORD length = GetModuleFileNameW(nullptr, executable, 32768);
  CHECK(length && length < 32768);
  std::wstring command = L"\"" + std::wstring(executable, length) + L"\" --wait-for-event "
      + std::to_wstring(reinterpret_cast<uintptr_t>(signal));
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION child{};
  CHECK(CreateProcessW(executable, command.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW,
      nullptr, nullptr, &startup, &child));
  CloseHandle(child.hThread);
  settings = obs_data_create();
  obs_data_set_bool(settings, "lycansync_exclude_process", true);
  obs_data_set_int(settings, "lycansync_process_id", child.dwProcessId);
  BoundAudioTarget child_target;
  CHECK(child_target.read(settings) && child_target.valid());
  CHECK(SetEvent(signal));
  CHECK(WaitForSingleObject(child.hProcess, 10'000) == WAIT_OBJECT_0);
  CHECK(!child_target.valid());
  CloseHandle(child.hProcess);
  CloseHandle(signal);
  obs_data_release(settings);
  std::puts("bound audio target checks passed");
  return 0;
}
