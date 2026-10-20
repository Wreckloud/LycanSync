#pragma once

#include "window_capture.h"

obs_source_t *create_game_video_source(const WindowVideoTarget &target, bool hide_cursor, const char *&error);
const char *game_video_failure(obs_source_t *source, const WindowVideoTarget &target);
