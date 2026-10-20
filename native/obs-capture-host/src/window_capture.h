#pragma once

#include <obs.h>
#include <windows.h>
#include <cstdint>
#include <string>

struct WindowVideoTarget {
  HWND window = nullptr;
  std::wstring property_name;
  uintptr_t property_value = 0;
};

bool window_video_target_valid(const WindowVideoTarget &target);
obs_source_t *create_window_video_source(const WindowVideoTarget &target, const std::wstring &runtime_directory,
                                        bool hide_cursor, bool hide_border, const char *&error);
const char *window_video_failure();
bool window_video_suspended();
