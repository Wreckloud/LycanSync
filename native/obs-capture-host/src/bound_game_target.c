#include "bound_game_target.h"

#include <stdint.h>
#include <string.h>

bool lycan_game_target_valid(const struct lycan_game_target *target)
{
  return target->window && target->property_value && target->property_name[0]
      && IsWindow(target->window)
      && GetPropA(target->window, target->property_name) == target->property_value;
}

bool lycan_game_target_read(struct lycan_game_target *target, obs_data_t *settings)
{
  const char *name = obs_data_get_string(settings, "lycansync_window_property");
  const char *prefix = "LycanSync.MediaHelper.Window.";
  const size_t prefix_length = strlen(prefix);
  const size_t name_length = strlen(name);
  const long long window = obs_data_get_int(settings, "lycansync_window_id");
  const long long value = obs_data_get_int(settings, "lycansync_window_property_value");
  memset(target, 0, sizeof(*target));
  // 属性名只来自既有 Rust 注册表的 ASCII 标记，禁止把标题当身份或接受无标记窗口。
  if (window <= 0 || value <= 0 || name_length <= prefix_length || name_length >= sizeof(target->property_name)
      || strncmp(name, prefix, prefix_length) != 0
      || strspn(name + prefix_length, "0123456789.") != name_length - prefix_length) return false;
  target->window = (HWND)(uintptr_t)window;
  target->property_value = (HANDLE)(uintptr_t)value;
  memcpy(target->property_name, name, name_length + 1);
  return lycan_game_target_valid(target);
}

bool lycan_game_capture_matches(const struct lycan_game_target *target, HWND capture_window)
{
  // 允许所选顶层窗内的绘制子窗，不接管同进程的另一个顶层窗或独立弹窗。
  return lycan_game_target_valid(target) && capture_window
      && (capture_window == target->window || IsChild(target->window, capture_window));
}
