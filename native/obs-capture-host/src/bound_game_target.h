#pragma once

#include <obs-data.h>
#include <windows.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

struct lycan_game_target {
  HWND window;
  HANDLE lifetime;
  HANDLE owner;
  HANDLE process;
  DWORD process_id;
};

HANDLE lycan_open_original_process(DWORD process_id, unsigned long long expected_creation);
bool lycan_game_target_read(struct lycan_game_target *target, obs_data_t *settings);
void lycan_game_target_close(struct lycan_game_target *target);
bool lycan_game_target_valid(const struct lycan_game_target *target);
bool lycan_game_capture_matches(const struct lycan_game_target *target, HWND capture_window);

#ifdef __cplusplus
}
#endif
