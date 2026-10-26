#include "../src/game_capture.h"
#include <callback/calldata.h>
#include <callback/proc.h>
#include <cstdio>
#include <cstring>

namespace {
int checks = 0;
int closes_at = 0;
bool queried = true;
bool bound_valid = true;
bool hooked = false;
bool captured_alive = true;
HWND selected = reinterpret_cast<HWND>(1);
HWND captured = selected;
proc_handler_t *query_handler(obs_source_t *) { return nullptr; }
bool query_target(proc_handler_t *, const char *, calldata_t *status) {
  calldata_set_int(status, "binding_version", 2);
  calldata_set_ptr(status, "window", selected);
  calldata_set_ptr(status, "capture_window", captured);
  calldata_set_bool(status, "valid", bound_valid);
  calldata_set_bool(status, "hooked", hooked);
  return queried;
}
BOOL captured_exists(HWND) { return captured_alive; }
BOOL child_matches(HWND, HWND) { return FALSE; }
}

bool window_video_target_valid(const WindowVideoTarget &) { return !closes_at || ++checks < closes_at; }

#define obs_source_get_proc_handler query_handler
#define proc_handler_call query_target
#define IsWindow captured_exists
#define IsChild child_matches
#include "../src/game_capture.cpp"
#undef obs_source_get_proc_handler
#undef proc_handler_call
#undef IsWindow
#undef IsChild

#define CHECK(condition) do { if (!(condition)) { std::fprintf(stderr, "game failure check failed at line %d\n", __LINE__); return 1; } } while (0)
int main() {
  WindowVideoTarget target{selected, "test", 1, "2"};
  closes_at = 2;
  bound_valid = false;
  CHECK(std::strcmp(game_video_failure(nullptr, target), "captureTargetClosed") == 0);
  closes_at = 0;
  bound_valid = true;
  hooked = true;
  captured = reinterpret_cast<HWND>(2);
  captured_alive = false;
  CHECK(std::strcmp(game_video_failure(nullptr, target), "captureTargetClosed") == 0);
  captured_alive = true;
  CHECK(std::strcmp(game_video_failure(nullptr, target), "obsGameTargetMismatch") == 0);
  queried = false;
  CHECK(std::strcmp(game_video_failure(nullptr, target), "obsGameBindingUnavailable") == 0);
  queried = true;
  captured = selected;
  CHECK(game_video_failure(nullptr, target) == nullptr);
  std::puts("game failure classification checks passed");
  return 0;
}
