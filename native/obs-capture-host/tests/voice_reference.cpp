#include "../src/voice_reference.h"
#include "../src/voice_filter.h"
#include <obs-module.h>
#include <callback/calldata.h>
#include <callback/proc.h>
#include <util/base.h>
#include <windows.h>
#include <mmdeviceapi.h>
#include <wrl/client.h>
#include <array>
#include <algorithm>
#include <cstdio>
#include <filesystem>
#include <stdexcept>

namespace {
void check(bool condition, const char *message) {
  if (!condition) throw std::runtime_error(message);
}
auto *synthetic_source = reinterpret_cast<obs_source_t *>(1);
unsigned created = 0, released = 0, active = 0;
bool duplicate_name = false, valid_status = true, echo_enabled = false;
obs_source_audio_capture_t capture_callback = nullptr;
void *capture_context = nullptr;

obs_properties_t *device_properties(const char *id) {
  // 查询真实插件注册表；端点列表仅由本测试合成，不枚举系统播放设备。
  if (!obs_get_latest_input_type_id(id)) return nullptr;
  auto *properties = obs_properties_create();
  auto *devices = obs_properties_add_list(properties, "device_id", "Devices", OBS_COMBO_TYPE_LIST, OBS_COMBO_FORMAT_STRING);
  obs_property_list_add_string(devices, "Synthetic speakers", "synthetic-device");
  if (duplicate_name) obs_property_list_add_string(devices, "Synthetic speakers", "other-device");
  return properties;
}
obs_source_t *create_reference(const char *id, const char *, obs_data_t *settings) {
  if (!obs_get_latest_input_type_id(id)) return nullptr;
  check(std::string_view(obs_data_get_string(settings, "device_id")) == "synthetic-device", "wrong selected device");
  check(obs_data_get_bool(settings, "use_device_timing"), "device timing disabled");
  ++created;
  return synthetic_source;
}
void set_monitoring(obs_source_t *, obs_monitoring_type type) { check(type == OBS_MONITORING_TYPE_NONE, "reference monitored"); }
void set_mixers(obs_source_t *, uint32_t mixers) { check(mixers == 0, "reference entered recording mix"); }
void activate(obs_source_t *) { ++active; }
void deactivate(obs_source_t *) { check(active == 1, "reference activity leaked"); --active; }
void release_reference(obs_source_t *) { check(!active && !capture_callback, "reference released before detach"); ++released; }
void add_capture(obs_source_t *, obs_source_audio_capture_t callback, void *context) {
  check(!capture_callback, "duplicate reference callback"); capture_callback = callback; capture_context = context;
}
void remove_capture(obs_source_t *, obs_source_audio_capture_t callback, void *context) {
  check(capture_callback == callback && capture_context == context, "reference callback mismatch");
  capture_callback = nullptr; capture_context = nullptr;
}
proc_handler_t *query_handler(obs_source_t *) { return nullptr; }
bool query_status(proc_handler_t *, const char *, calldata_t *status) {
  calldata_set_int(status, "binding_version", 1);
  calldata_set_int(status, "capture_state", 1);
  return valid_status;
}
std::string utf8(const std::filesystem::path &path) { const auto value = path.u8string(); return {value.begin(), value.end()}; }
}

void voice_filter_echo_enabled(obs_source_t *, bool enabled) { echo_enabled = enabled; }
void voice_filter_reference(obs_source_t *, const obs_audio_data *) {}

#define obs_get_source_properties device_properties
#define obs_source_create_private create_reference
#define obs_source_set_monitoring_type set_monitoring
#define obs_source_set_audio_mixers set_mixers
#define obs_source_inc_active activate
#define obs_source_dec_active deactivate
#define obs_source_release release_reference
#define obs_source_add_audio_capture_callback add_capture
#define obs_source_remove_audio_capture_callback remove_capture
#define obs_source_get_proc_handler query_handler
#define proc_handler_call query_status
#include "../src/voice_reference.cpp"
#undef obs_get_source_properties
#undef obs_source_create_private
#undef obs_source_set_monitoring_type
#undef obs_source_set_audio_mixers
#undef obs_source_inc_active
#undef obs_source_dec_active
#undef obs_source_release
#undef obs_source_add_audio_capture_callback
#undef obs_source_remove_audio_capture_callback
#undef obs_source_get_proc_handler
#undef proc_handler_call

// 仅加载固定插件核对真实注册名；来源创建、设备列表及回调均由上面的边界替换。
int wmain(int argc, wchar_t **argv) {
  if (argc != 2) return 2;
  const auto sdk = std::filesystem::absolute(argv[1]);
  base_set_log_handler([](int level, const char *format, va_list args, void *) {
    if (level <= LOG_WARNING) { std::vfprintf(stderr, format, args); std::fputc('\n', stderr); }
  }, nullptr);
  if (!obs_startup("en-US", nullptr, nullptr)) return 3;
  int result = 0;
  try {
    check(std::string_view(obs_get_version_string()) == "32.2.2", "wrong OBS version");
    obs_module_t *module = nullptr;
    const auto library = utf8(sdk / "obs-plugins/64bit/win-wasapi.dll");
    const auto data = utf8(sdk / "data/obs-plugins/win-wasapi");
    check(obs_open_module(&module, library.c_str(), data.c_str()) == MODULE_SUCCESS && obs_init_module(module), "audio module unavailable");
    {
      VoiceReference reference(synthetic_source);
      reference.configure(true, "name:Synthetic speakers");
      check(created == 1 && active == 1 && echo_enabled, "registered reference source did not start");
      check(reference.status() == "ready", "reference readiness missing");
      reference.configure(true, "name:Synthetic speakers");
      check(created == 1, "unchanged reference recreated");
      reference.configure(false, "name:Synthetic speakers");
      check(reference.status() == "disabled" && released == 1 && !active && !echo_enabled, "disabled reference retained");
      duplicate_name = true;
      reference.configure(true, "name:Synthetic speakers");
      check(reference.status() == "unavailable" && created == 1, "duplicate device name accepted");
      duplicate_name = false;
      reference.configure(true, "name:Synthetic speakers");
      check(reference.status() == "ready" && created == 2, "unavailable reference could not retry");
      valid_status = false;
      check(reference.status() == "unavailable" && released == 2 && !active && !echo_enabled, "failed reference retained");
    }
    check(!capture_callback && created == released, "reference resources leaked");
    std::puts("registered echo source, selection, retry and cleanup checks passed; no capture devices opened");
  } catch (const std::exception &error) {
    std::fprintf(stderr, "%s\n", error.what()); result = 1;
  }
  obs_shutdown();
  return result;
}
