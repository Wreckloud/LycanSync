#include "bound_game_target.h"

#include <stdint.h>
#include <limits.h>
#include <string.h>

void lycan_game_target_close(struct lycan_game_target *target)
{
  if (target->lifetime) CloseHandle(target->lifetime);
  if (target->owner) CloseHandle(target->owner);
  if (target->process) CloseHandle(target->process);
  memset(target, 0, sizeof(*target));
}

bool lycan_game_target_valid(const struct lycan_game_target *target)
{
  DWORD process_id = 0;
  return target->window && target->lifetime && target->owner && target->process
      && WaitForSingleObject(target->lifetime, 0) == WAIT_TIMEOUT
      && WaitForSingleObject(target->owner, 0) == WAIT_TIMEOUT
      && WaitForSingleObject(target->process, 0) == WAIT_TIMEOUT
      && IsWindow(target->window) && GetWindowThreadProcessId(target->window, &process_id)
      && process_id == target->process_id;
}

static HANDLE open_original_process(DWORD process_id, unsigned long long expected_creation)
{
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, process_id);
  FILETIME creation, exit, kernel, user;
  if (process && GetProcessTimes(process, &creation, &exit, &kernel, &user)
      && (((unsigned long long)creation.dwHighDateTime << 32) | creation.dwLowDateTime) == expected_creation) return process;
  if (process) CloseHandle(process);
  return NULL;
}

static bool read_positive_integer(const char **text, char separator, unsigned long long *value)
{
  const char *position = *text;
  *value = 0;
  if (*position < '1' || *position > '9') return false;
  do {
    const unsigned int digit = (unsigned int)(*position - '0');
    if (*value > (ULLONG_MAX - digit) / 10) return false;
    *value = *value * 10 + digit;
    ++position;
  } while (*position >= '0' && *position <= '9');
  if (*position != separator) return false;
  *text = separator ? position + 1 : position;
  return true;
}

bool lycan_game_target_read(struct lycan_game_target *target, obs_data_t *settings)
{
  const char *name = obs_data_get_string(settings, "lycansync_window_lifetime");
  const char *prefix = "Local\\LycanSync.WindowLifetime.";
  const size_t name_length = strlen(name);
  const long long window = obs_data_get_int(settings, "lycansync_window_id");
  const long long process_id = obs_data_get_int(settings, "lycansync_process_id");
  const char *creation_text = obs_data_get_string(settings, "lycansync_process_creation");
  unsigned long long creation = 0, owner_id = 0, owner_creation = 0, sequence = 0, selected_window = 0;
  const char *parts = name + (name_length >= strlen(prefix) ? strlen(prefix) : name_length);
  memset(target, 0, sizeof(*target));
  // 身份来自私有注册表，事件只供读取；不能将标题或 PID 单独作为窗口授权。
  if (window <= 0 || process_id <= 0 || process_id > MAXDWORD
      || !read_positive_integer(&creation_text, 0, &creation)
      || name_length > 128 || strncmp(name, prefix, strlen(prefix)) != 0
      || !read_positive_integer(&parts, '.', &owner_id) || owner_id > MAXDWORD
      || !read_positive_integer(&parts, '.', &owner_creation)
      || !read_positive_integer(&parts, '.', &sequence)
      || !read_positive_integer(&parts, 0, &selected_window) || selected_window != (unsigned long long)window) return false;
  target->window = (HWND)(uintptr_t)window;
  target->process_id = (DWORD)process_id;
  target->owner = open_original_process((DWORD)owner_id, owner_creation);
  target->process = open_original_process(target->process_id, creation);
  target->lifetime = OpenEventA(SYNCHRONIZE, FALSE, name);
  if (lycan_game_target_valid(target)) return true;
  lycan_game_target_close(target);
  return false;
}

bool lycan_game_capture_matches(const struct lycan_game_target *target, HWND capture_window)
{
  // 允许所选顶层窗内的绘制子窗，不接管同进程的另一个顶层窗或独立弹窗。
  return lycan_game_target_valid(target) && capture_window
      && (capture_window == target->window || IsChild(target->window, capture_window));
}
