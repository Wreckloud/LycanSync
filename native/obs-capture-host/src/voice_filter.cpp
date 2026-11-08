#include "voice_filter.h"

#include <atomic>
#include <cstdint>
#include <mutex>
#include <cmath>

// 与 Rust repr(C) 一致；只传统计量，不传出 PCM 或处理器所有权。
struct VoiceMetrics {
  uint64_t samples = 0, limited_samples = 0, full_scale_samples = 0;
  double input_energy = 0, output_energy = 0;
  float input_peak = 0, output_peak = 0;
};
static_assert(sizeof(VoiceMetrics) == 48);

extern "C" {
void *lycan_voice_create(float gain, uint8_t noise, uint8_t agc, uint8_t high_pass);
bool lycan_voice_configure(void *, float gain, uint8_t noise, uint8_t agc, uint8_t high_pass);
bool lycan_voice_process(void *, float *samples, uint32_t frames);
void lycan_voice_destroy(void *);
bool lycan_voice_take_metrics(void *, VoiceMetrics *);
}

namespace {
std::atomic<bool> failed = false;
struct Filter {
  std::mutex mutex;
  void *processor = nullptr;
  ~Filter() { lycan_voice_destroy(processor); }
};
void update(void *context, obs_data_t *settings) {
  auto &filter = *static_cast<Filter *>(context);
  const std::lock_guard<std::mutex> lock(filter.mutex);
  const auto gain = static_cast<float>(obs_data_get_double(settings, "input_gain"));
  const auto noise = obs_data_get_bool(settings, "noise_suppression");
  const auto agc = obs_data_get_bool(settings, "auto_gain_control");
  const auto high_pass = obs_data_get_bool(settings, "voice_enhancement");
  if (!filter.processor) filter.processor = lycan_voice_create(gain, noise, agc, high_pass);
  else if (!lycan_voice_configure(filter.processor, gain, noise, agc, high_pass)) failed = true;
  if (!filter.processor) failed = true;
}
void *create(obs_data_t *settings, obs_source_t *source) {
  auto *filter = new Filter;
  update(filter, settings);
  if (!filter->processor) { delete filter; return nullptr; }
  proc_handler_add(obs_source_get_proc_handler(source), "void voice_metrics(ptr output)", [](void *context, calldata_t *values) {
    auto &filter = *static_cast<Filter *>(context);
    const std::lock_guard<std::mutex> lock(filter.mutex);
    lycan_voice_take_metrics(filter.processor, static_cast<VoiceMetrics *>(calldata_ptr(values, "output")));
  }, filter);
  return filter;
}
obs_audio_data *process(void *context, obs_audio_data *audio) {
  if (!audio->frames) return audio;
  auto &filter = *static_cast<Filter *>(context);
  const std::lock_guard<std::mutex> lock(filter.mutex);
  // 专用宿主固定为 48k 单声道；处理不写文件、不等待 IPC。
  if (!lycan_voice_process(filter.processor, reinterpret_cast<float *>(audio->data[0]), audio->frames)) {
    failed = true;
    return nullptr;
  }
  return audio;
}
}

void register_voice_filter() {
  obs_source_info filter{};
  filter.id = "lycansync_voice_processing";
  filter.type = OBS_SOURCE_TYPE_FILTER;
  filter.output_flags = OBS_SOURCE_AUDIO;
  filter.get_name = [](void *) { return "LycanSync voice processing"; };
  filter.create = create;
  filter.destroy = [](void *context) { delete static_cast<Filter *>(context); };
  filter.update = update;
  filter.filter_audio = process;
  obs_register_source(&filter);
}

bool voice_filter_failed() { return failed.load(); }

std::string voice_filter_metrics(obs_source_t *filter) {
  VoiceMetrics metrics;
  calldata_t values;
  calldata_init(&values);
  calldata_set_ptr(&values, "output", &metrics);
  const bool available = proc_handler_call(obs_source_get_proc_handler(filter), "voice_metrics", &values);
  calldata_free(&values);
  if (!available || !metrics.samples) return "null";
  return "{\"samples\":" + std::to_string(metrics.samples)
    + ",\"limitedSamples\":" + std::to_string(metrics.limited_samples)
    + ",\"fullScaleSamples\":" + std::to_string(metrics.full_scale_samples)
    + ",\"inputRms\":" + std::to_string(std::sqrt(metrics.input_energy / metrics.samples))
    + ",\"outputRms\":" + std::to_string(std::sqrt(metrics.output_energy / metrics.samples))
    + ",\"inputPeak\":" + std::to_string(metrics.input_peak)
    + ",\"outputPeak\":" + std::to_string(metrics.output_peak) + "}";
}
