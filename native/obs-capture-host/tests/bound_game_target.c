#include "bound_game_target.h"
#include <stdint.h>
#include <stdio.h>

#define CHECK(condition) do { if (!(condition)) { fprintf(stderr, "game target check failed at line %d\n", __LINE__); return 1; } } while (0)

int main(void)
{
  // 只创建本测试的隐藏窗口和生命周期事件，不初始化 OBS 或注入进程。
  HWND selected = CreateWindowExA(0, "STATIC", "binding test", WS_OVERLAPPEDWINDOW,
      0, 0, 100, 100, NULL, NULL, NULL, NULL);
  HWND other = CreateWindowExA(0, "STATIC", "binding test", WS_OVERLAPPEDWINDOW,
      0, 0, 100, 100, NULL, NULL, NULL, NULL);
  HWND child = CreateWindowExA(0, "STATIC", "draw surface", WS_CHILD,
      0, 0, 50, 50, selected, NULL, NULL, NULL);
  HWND popup = CreateWindowExA(0, "STATIC", "owned popup", WS_OVERLAPPEDWINDOW,
      0, 0, 50, 50, selected, NULL, NULL, NULL);
  CHECK(selected && other && child && popup);
  FILETIME creation, exit, kernel, user;
  CHECK(GetProcessTimes(GetCurrentProcess(), &creation, &exit, &kernel, &user));
  const unsigned long long created = ((unsigned long long)creation.dwHighDateTime << 32) | creation.dwLowDateTime;
  char name[129], timestamp[21];
  snprintf(name, sizeof(name), "Local\\LycanSync.WindowLifetime.%lu.%llu.1.%llu",
      GetCurrentProcessId(), created, (unsigned long long)(uintptr_t)selected);
  snprintf(timestamp, sizeof(timestamp), "%llu", created);
  HANDLE lifetime = CreateEventA(NULL, TRUE, FALSE, name);
  CHECK(lifetime);
  obs_data_t *settings = obs_data_create();
  struct lycan_game_target target;
  CHECK(!lycan_game_target_read(&target, settings));
  obs_data_set_int(settings, "lycansync_window_id", (long long)(uintptr_t)selected);
  obs_data_set_string(settings, "lycansync_window_lifetime", name);
  obs_data_set_int(settings, "lycansync_process_id", GetCurrentProcessId());
  obs_data_set_string(settings, "lycansync_process_creation", "18446744073709551616");
  CHECK(!lycan_game_target_read(&target, settings));
  obs_data_set_string(settings, "lycansync_process_creation", timestamp);
  CHECK(lycan_game_target_read(&target, settings));
  CHECK(lycan_game_capture_matches(&target, selected));
  CHECK(lycan_game_capture_matches(&target, child));
  CHECK(!lycan_game_capture_matches(&target, other));
  CHECK(!lycan_game_capture_matches(&target, popup));
  CHECK(!lycan_game_capture_matches(&target, NULL));
  // 消费者仅有 SYNCHRONIZE 权限，不能重置已失效的来源。
  CHECK(!ResetEvent(target.lifetime) && GetLastError() == ERROR_ACCESS_DENIED);
  CHECK(SetWindowTextA(selected, "renamed"));
  CHECK(lycan_game_target_valid(&target));
  lycan_game_target_close(&target);
  obs_data_set_int(settings, "lycansync_window_id", (long long)(uintptr_t)other);
  CHECK(!lycan_game_target_read(&target, settings));
  obs_data_set_int(settings, "lycansync_window_id", (long long)(uintptr_t)selected);
  obs_data_set_string(settings, "lycansync_process_creation", "1");
  CHECK(!lycan_game_target_read(&target, settings));
  obs_data_set_string(settings, "lycansync_process_creation", timestamp);
  CHECK(lycan_game_target_read(&target, settings));
  CHECK(SetEvent(lifetime));
  CHECK(!lycan_game_target_valid(&target));
  CHECK(!lycan_game_capture_matches(&target, child));
  lycan_game_target_close(&target);
  CHECK(!lycan_game_target_read(&target, settings));
  CHECK(DestroyWindow(selected));
  CHECK(IsWindow(other) && DestroyWindow(other));
  CloseHandle(lifetime);
  obs_data_release(settings);
  puts("read-only window lifetime, process instance and scope checks passed");
  return 0;
}
