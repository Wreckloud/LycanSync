#include "bound_game_target.h"
#include <stdint.h>
#include <stdio.h>

#define CHECK(condition) do { if (!(condition)) { fprintf(stderr, "game target check failed at line %d\n", __LINE__); return 1; } } while (0)

int main(void)
{
  // 只创建本测试自己的隐藏窗口，不初始化 OBS、加载插件或注入其他进程。
  HWND selected = CreateWindowExA(0, "STATIC", "LycanSync game binding test", WS_OVERLAPPEDWINDOW,
      0, 0, 100, 100, NULL, NULL, NULL, NULL);
  HWND other = CreateWindowExA(0, "STATIC", "LycanSync game binding test", WS_OVERLAPPEDWINDOW,
      0, 0, 100, 100, NULL, NULL, NULL, NULL);
  HWND child = CreateWindowExA(0, "STATIC", "draw surface", WS_CHILD,
      0, 0, 50, 50, selected, NULL, NULL, NULL);
  HWND popup = CreateWindowExA(0, "STATIC", "owned popup", WS_OVERLAPPEDWINDOW,
      0, 0, 50, 50, selected, NULL, NULL, NULL);
  CHECK(selected && other && child && popup);
  const char *property = "LycanSync.MediaHelper.Window.1.2.3";
  HANDLE marker = (HANDLE)(uintptr_t)123;
  CHECK(SetPropA(selected, property, marker));
  obs_data_t *settings = obs_data_create();
  struct lycan_game_target target;
  CHECK(!lycan_game_target_read(&target, settings));
  obs_data_set_int(settings, "lycansync_window_id", (long long)(uintptr_t)selected);
  obs_data_set_string(settings, "lycansync_window_property", property);
  obs_data_set_int(settings, "lycansync_window_property_value", (long long)(uintptr_t)marker);
  CHECK(lycan_game_target_read(&target, settings));
  CHECK(lycan_game_capture_matches(&target, selected));
  CHECK(lycan_game_capture_matches(&target, child));
  CHECK(!lycan_game_capture_matches(&target, other));
  CHECK(!lycan_game_capture_matches(&target, popup));
  CHECK(!lycan_game_capture_matches(&target, NULL));
  obs_data_set_int(settings, "lycansync_window_property_value", 456);
  CHECK(!lycan_game_target_read(&target, settings));
  obs_data_set_int(settings, "lycansync_window_property_value", 123);
  CHECK(lycan_game_target_read(&target, settings));
  SetWindowTextA(selected, "renamed");
  CHECK(lycan_game_target_valid(&target));
  CHECK(RemovePropA(selected, property) == marker);
  CHECK(!lycan_game_target_valid(&target));
  CHECK(!lycan_game_capture_matches(&target, child));
  CHECK(SetPropA(selected, property, marker));
  CHECK(DestroyWindow(selected));
  CHECK(!lycan_game_target_valid(&target));
  CHECK(IsWindow(other));
  CHECK(DestroyWindow(other));
  obs_data_release(settings);
  puts("bound game target checks passed");
  return 0;
}
