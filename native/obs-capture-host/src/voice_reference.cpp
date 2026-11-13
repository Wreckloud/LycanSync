#include "voice_reference.h"
#include "voice_filter.h"
#include <array>
#include <algorithm>
#include <windows.h>
#include <mmdeviceapi.h>
#include <wrl/client.h>

namespace {
std::string default_device() {
  Microsoft::WRL::ComPtr<IMMDeviceEnumerator> enumerator;
  Microsoft::WRL::ComPtr<IMMDevice> device;
  if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator)))
      || FAILED(enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device))) return {};
  LPWSTR id = nullptr;
  if (FAILED(device->GetId(&id))) return {};
  const int size = WideCharToMultiByte(CP_UTF8, 0, id, -1, nullptr, 0, nullptr, nullptr);
  std::string result(size, '\0');
  if (size) WideCharToMultiByte(CP_UTF8, 0, id, -1, result.data(), size, nullptr, nullptr);
  CoTaskMemFree(id);
  if (!result.empty()) result.pop_back();
  return result;
}
}

void VoiceReference::stop() {
  if (source_) {
    obs_source_remove_audio_capture_callback(source_, capture, this);
    voice_filter_echo_enabled(filter_, false);
    obs_source_dec_active(source_);
    obs_source_release(source_);
    source_ = nullptr;
  }
}

void VoiceReference::configure(bool enabled, const std::string &selector) {
  if (enabled_ == enabled && selector_ == selector && state_ != "unavailable") return;
  stop();
  enabled_ = enabled;
  selector_ = selector;
  state_ = enabled ? "unavailable" : "disabled";
  if (!enabled || selector == "none") return;
  std::string device;
  if (selector == "default") {
    device = default_device();
    default_device_ = device;
    last_device_check_ = std::chrono::steady_clock::now();
  }
  else if (selector.starts_with("name:")) {
    auto *properties = obs_get_source_properties("wasapi_output_capture");
    if (!properties) return;
    auto *devices = obs_properties_get(properties, "device_id");
    unsigned matches = 0;
    if (devices) for (size_t i = 0; i < obs_property_list_item_count(devices); ++i) {
      const char *name = obs_property_list_item_name(devices, i);
      const char *id = obs_property_list_item_string(devices, i);
      if (name && id && std::string_view(id) != "default" && std::string_view(name) == std::string_view(selector).substr(5)) {
        device = id;
        ++matches;
      }
    }
    obs_properties_destroy(properties);
    // Chromium 使用经过哈希的设备 ID；只接受完整名称的唯一对应，重名不得猜测。
    if (matches != 1) return;
  }
  if (device.empty()) return;
  auto *settings = obs_data_create();
  obs_data_set_string(settings, "device_id", device.c_str());
  obs_data_set_bool(settings, "use_device_timing", true);
  source_ = obs_source_create_private("wasapi_output_capture", "LycanSync echo reference", settings);
  obs_data_release(settings);
  if (!source_) return;
  obs_source_set_monitoring_type(source_, OBS_MONITORING_TYPE_NONE);
  obs_source_set_audio_mixers(source_, 0);
  voice_filter_echo_enabled(filter_, true);
  obs_source_add_audio_capture_callback(source_, capture, this);
  obs_source_inc_active(source_);
  last_available_ = std::chrono::steady_clock::now();
  state_ = "pending";
}

std::string VoiceReference::status() {
  const auto now = std::chrono::steady_clock::now();
  if (enabled_ && selector_ == "default" && now - last_device_check_ > std::chrono::seconds(1)) {
    last_device_check_ = now;
    const auto current = default_device();
    if (current != default_device_) {
      // 参考固定到已确认的端点；只有系统默认确实变化才重新绑定，不修改共享声音的停止策略。
      selector_.clear();
      configure(true, "default");
    }
  }
  if (!source_) return state_;
  calldata_t values;
  calldata_init(&values);
  const bool valid = proc_handler_call(obs_source_get_proc_handler(source_), "lycansync_audio_status", &values)
      && calldata_int(&values, "binding_version") == 1;
  const auto capture_state = calldata_int(&values, "capture_state");
  calldata_free(&values);
  if (valid && capture_state == 1) {
    last_available_ = std::chrono::steady_clock::now();
    state_ = "ready";
  } else if (!valid || std::chrono::steady_clock::now() - last_available_ > std::chrono::seconds(8)) {
    stop();
    state_ = "unavailable";
  } else state_ = "pending";
  return state_;
}

void VoiceReference::capture(void *context, obs_source_t *, const audio_data *audio, bool muted) {
  if (!audio || !audio->frames || audio->frames > 4800) return;
  auto &reference = *static_cast<VoiceReference *>(context);
  obs_audio_data mono{};
  mono.frames = audio->frames;
  mono.timestamp = audio->timestamp;
  std::array<float, 4800> silence{};
  mono.data[0] = muted ? reinterpret_cast<uint8_t *>(silence.data()) : audio->data[0];
  voice_filter_reference(reference.filter_, &mono);
}
