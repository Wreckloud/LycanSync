#include "../src/window_capture.h"
#include <callback/calldata.h>
#include <callback/proc.h>
#include <winrt/Windows.Foundation.Metadata.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Security.Authorization.AppCapabilityAccess.h>
#include <cstdio>
#include <cstring>

namespace {
int checks = 0;
int closes_at = 0;
int binding_version = 2;
int method = 1;
bool queried = true;
bool bound_valid = true;
bool available = true;
bool failed = false;
bool wgc_supported = true;
int created = 0;
int released = 0;
int capability_checks = 0;
bool requested_borderless = false;
const char *capability_error = nullptr;
HWND selected = reinterpret_cast<HWND>(1);
HWND captured = nullptr;
proc_handler_t *query_handler(obs_source_t *) { return nullptr; }
bool query_target(proc_handler_t *, const char *, calldata_t *status) {
  calldata_set_int(status, "binding_version", binding_version);
  calldata_set_ptr(status, "window", selected);
  calldata_set_ptr(status, "capture_window", captured);
  calldata_set_int(status, "method", method);
  calldata_set_bool(status, "valid", bound_valid);
  calldata_set_bool(status, "available", method == 1 || available);
  calldata_set_bool(status, "failed", failed);
  return queried;
}
BOOL target_exists(HWND) { return !closes_at || ++checks < closes_at; }
const char *input_type(const char *id) { return id; }
void release_source(obs_source_t *) { ++released; }
bool settings_valid = true;
obs_source_t *create_source(const char *id, const char *, obs_data_t *settings, obs_data_t *) {
  ++created;
  const auto requested = static_cast<int>(obs_data_get_int(settings, "method"));
  method = requested == 1 || !wgc_supported ? 1 : 2;
  settings_valid = std::strcmp(id, "lycansync_window_capture") == 0
      && obs_data_get_int(settings, "lycansync_window_id") == 1
      && obs_data_get_int(settings, "lycansync_process_id") == 5
      && std::strcmp(obs_data_get_string(settings, "lycansync_process_creation"), "6") == 0
      && !obs_data_get_bool(settings, "capture_audio") && obs_data_get_bool(settings, "client_area")
      && obs_data_get_bool(settings, "force_sdr");
  return reinterpret_cast<obs_source_t *>(1);
}
void capability_task(enum obs_task_type, obs_task_t, void *, bool);
}

extern "C" bool lycan_game_target_valid(const lycan_game_target *) { return target_exists(selected); }
extern "C" bool lycan_game_target_read(lycan_game_target *, obs_data_t *) { return true; }
extern "C" void lycan_game_target_close(lycan_game_target *) {}

#define obs_source_get_proc_handler query_handler
#define proc_handler_call query_target
#define IsWindow target_exists
#define obs_get_latest_input_type_id input_type
#define obs_source_create create_source
#define obs_source_release release_source
#define obs_queue_task capability_task
#include "../src/window_capture.cpp"
#undef obs_source_get_proc_handler
#undef proc_handler_call
#undef IsWindow
#undef obs_get_latest_input_type_id
#undef obs_source_create
#undef obs_source_release
#undef obs_queue_task

namespace {
void capability_task(enum obs_task_type, obs_task_t, void *parameter, bool) {
  ++capability_checks;
  auto &preparation = *static_cast<WindowPreparation *>(parameter);
  requested_borderless = preparation.hide_border;
  preparation.error = capability_error;
}
}

#define CHECK(condition) do { if (!(condition)) { std::fprintf(stderr, "window failure check failed at line %d\n", __LINE__); return 1; } } while (0)
int main() {
  WindowVideoTarget target{selected, "test", 5, "6", std::make_shared<lycan_game_target>()};
  CHECK(window_video_failure(nullptr, target) == nullptr);
  CHECK(std::strcmp(window_video_method(nullptr), "bitblt-window") == 0);
  captured = reinterpret_cast<HWND>(2);
  CHECK(std::strcmp(window_video_failure(nullptr, target), "obsWindowTargetMismatch") == 0);
  captured = selected;
  bound_valid = false;
  CHECK(std::strcmp(window_video_failure(nullptr, target), "obsWindowTargetMismatch") == 0);
  closes_at = 2;
  queried = false;
  CHECK(std::strcmp(window_video_failure(nullptr, target), "captureTargetClosed") == 0);
  closes_at = 0;
  bound_valid = true;
  CHECK(std::strcmp(window_video_failure(nullptr, target), "obsWindowBindingUnavailable") == 0);
  queried = true;
  binding_version = 1;
  CHECK(std::strcmp(window_video_failure(nullptr, target), "obsWindowBindingUnavailable") == 0);
  binding_version = 2;
  method = 2;
  available = false;
  CHECK(std::strcmp(window_video_failure(nullptr, target), "obsWindowRuntimeUnavailable") == 0);
  available = true;
  failed = true;
  CHECK(std::strcmp(window_video_failure(nullptr, target), "obsWindowCaptureStartFailed") == 0);
  failed = false;
  CHECK(window_video_failure(nullptr, target) == nullptr);
  CHECK(std::strcmp(window_video_method(nullptr), "wgc-window") == 0);
  method = 0;
  CHECK(window_video_method(nullptr) == nullptr);
  const char *error = nullptr;
  const char *fallback = nullptr;
  auto *source = create_window_video_source(target, true, true, "bitblt", error, fallback);
  CHECK(source && !error && !fallback && created == 1 && capability_checks == 0 && settings_valid);
  created = released = 0;
  capability_error = "captureBorderAccessDenied";
  source = create_window_video_source(target, false, true, "auto", error, fallback);
  CHECK(source && !error && created == 2 && released == 1 && requested_borderless && settings_valid);
  CHECK(std::strcmp(fallback, "captureBorderAccessDenied") == 0 && method == 1);
  created = released = 0;
  source = create_window_video_source(target, false, true, "wgc", error, fallback);
  CHECK(!source && !fallback && created == 1 && released == 1);
  CHECK(std::strcmp(error, "captureBorderAccessDenied") == 0);
  capability_error = nullptr;
  source = create_window_video_source(target, false, false, "wgc", error, fallback);
  CHECK(source && !error && !fallback && method == 2 && !requested_borderless);
  wgc_supported = false;
  source = create_window_video_source(target, false, false, "wgc", error, fallback);
  CHECK(!source && !fallback && std::strcmp(error, "captureSettingsUnsupported") == 0);
  wgc_supported = true;
  available = false;
  const int before_unavailable = capability_checks;
  source = create_window_video_source(target, false, true, "auto", error, fallback);
  CHECK(source && !error && fallback && std::strcmp(fallback, "obsWindowRuntimeUnavailable") == 0 && method == 1);
  CHECK(capability_checks == before_unavailable);
  available = true;
  closes_at = 1;
  checks = 0;
  const int before_closed = created;
  source = create_window_video_source(target, false, true, "auto", error, fallback);
  CHECK(!source && created == before_closed && std::strcmp(error, "captureTargetClosed") == 0);
  std::puts("window binding and failure checks passed");
  return 0;
}
