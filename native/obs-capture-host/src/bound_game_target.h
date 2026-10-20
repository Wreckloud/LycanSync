#pragma once

#include <obs-data.h>
#include <windows.h>
#include <stdbool.h>

struct lycan_game_target {
  HWND window;
  HANDLE property_value;
  char property_name[129];
};

bool lycan_game_target_read(struct lycan_game_target *target, obs_data_t *settings);
bool lycan_game_target_valid(const struct lycan_game_target *target);
bool lycan_game_capture_matches(const struct lycan_game_target *target, HWND capture_window);
