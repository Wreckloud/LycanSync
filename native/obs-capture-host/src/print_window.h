#pragma once
#include "window_capture.h"

void register_print_window_source();
obs_source_t *try_auto_print_window_source(const WindowVideoTarget &target, bool show_cursor);
bool print_window_failed(obs_source_t *source);
int run_print_window_worker(const wchar_t *channel);
