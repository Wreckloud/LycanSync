#pragma once

#include <obs.h>
#include <windows.h>
#include <cstdint>
#include <string>
#include <string_view>
#include <memory>
#include "bound_game_target.h"

struct WindowVideoTarget {
  HWND window = nullptr;
  std::string lifetime_name;
  DWORD process_id = 0;
  std::string process_creation;
  std::shared_ptr<lycan_game_target> binding;
};

bool bind_window_video_target(WindowVideoTarget &target);
bool window_video_target_valid(const WindowVideoTarget &target);
obs_source_t *create_window_video_source(const WindowVideoTarget &target, bool hide_cursor,
    bool hide_border, std::string_view method, const char *&error, const char *&fallback_reason);
const char *window_video_failure(obs_source_t *source, const WindowVideoTarget &target);
const char *window_video_method(obs_source_t *source);
bool window_video_suspended(const WindowVideoTarget &target);
