#include "voice_filter.h"

#include <atomic>
#include <cstdint>
#include <mutex>
#include <cmath>
#include <array>
#include <algorithm>
#include <util/platform.h>

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
bool lycan_voice_set_echo(void *, uint8_t enabled);
bool lycan_voice_set_echo_delay(void *, int32_t delay_ms);
bool lycan_voice_render(void *, const float *, uint32_t frames);
}

namespace {
std::atomic<bool> failed = false;
struct Filter {
  std::mutex mutex;
  void *processor = nullptr;
  bool echo_requested = false, echo_active = false;
  std::array<float, 480> reference{};
  size_t reference_cursor = 0;
  uint64_t reference_end = 0, reference_received = 0;
  uint64_t reference_frames = 0, echo_resets = 0, reference_start = 0;
  int64_t reference_latency = 0;
  int32_t echo_delay_ms = 0;
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
  proc_handler_add(obs_source_get_proc_handler(source), "void voice_echo(bool enabled)", [](void *context, calldata_t *values) {
    auto &filter = *static_cast<Filter *>(context);
    const std::lock_guard<std::mutex> lock(filter.mutex);
    filter.echo_requested = calldata_bool(values, "enabled");
    filter.echo_active = false;
    filter.reference_cursor = 0;
    filter.reference_end = 0;
    filter.reference_received = 0;
    filter.echo_delay_ms = 0;
    lycan_voice_set_echo(filter.processor, 0);
  }, filter);
  proc_handler_add(obs_source_get_proc_handler(source), "void voice_reference(ptr audio)", [](void *context, calldata_t *values) {
    auto &filter = *static_cast<Filter *>(context);
    const auto *audio = static_cast<const obs_audio_data *>(calldata_ptr(values, "audio"));
    const std::lock_guard<std::mutex> lock(filter.mutex);
    if (!filter.echo_requested || !audio || !audio->frames || audio->frames > 4800 || !audio->data[0]) return;
    const auto *samples = reinterpret_cast<const float *>(audio->data[0]);
    if (!std::all_of(samples, samples + audio->frames, [](float value) { return std::isfinite(value); })) return;
    const auto now = os_gettime_ns();
    const bool discontinuity = filter.reference_end
        && (audio->timestamp < filter.reference_end
          ? filter.reference_end - audio->timestamp > 20'000'000
          : audio->timestamp - filter.reference_end > 20'000'000);
    if (!filter.echo_active || discontinuity) {
      lycan_voice_set_echo(filter.processor, 1);
      filter.echo_active = true;
      filter.reference_cursor = 0;
      ++filter.echo_resets;
    }
    // 参考只保留不足一块的尾部；AEC 自己持有有界历史，不另建无界声音队列。
    for (uint32_t i = 0; i < audio->frames; ++i) {
      if (!filter.reference_cursor) filter.reference_start = audio->timestamp + uint64_t(i) * 1'000'000'000 / 48000;
      filter.reference[filter.reference_cursor++] = samples[i];
      if (filter.reference_cursor == filter.reference.size()) {
        lycan_voice_render(filter.processor, filter.reference.data(), 480);
        filter.reference_cursor = 0;
        filter.reference_latency = static_cast<int64_t>(os_gettime_ns()) - static_cast<int64_t>(filter.reference_start);
      }
    }
    filter.reference_received = now;
    filter.reference_end = audio->timestamp + uint64_t(audio->frames) * 1'000'000'000 / 48000;
    filter.reference_frames += audio->frames;
  }, filter);
  proc_handler_add(obs_source_get_proc_handler(source), "void voice_echo_metrics(ptr output)", [](void *context, calldata_t *values) {
    auto &filter = *static_cast<Filter *>(context);
    auto *output = static_cast<std::string *>(calldata_ptr(values, "output"));
    const std::lock_guard<std::mutex> lock(filter.mutex);
    *output = "{\"enabled\":" + std::string(filter.echo_requested ? "true" : "false")
      + ",\"active\":" + (filter.echo_active ? "true" : "false")
      + ",\"referenceFrames\":" + std::to_string(filter.reference_frames)
      + ",\"resets\":" + std::to_string(filter.echo_resets)
      + ",\"delayMs\":" + std::to_string(filter.echo_delay_ms) + "}";
  }, filter);
  return filter;
}
obs_audio_data *process(void *context, obs_audio_data *audio) {
  if (!audio->frames) return audio;
  auto &filter = *static_cast<Filter *>(context);
  const std::lock_guard<std::mutex> lock(filter.mutex);
  const auto now = os_gettime_ns();
  if (filter.echo_active && now - filter.reference_received > 250'000'000) {
    // 扬声器无活动时 WASAPI 可以停止出包；不拿旧参考继续压制新的人声。
    lycan_voice_set_echo(filter.processor, 0);
    filter.echo_active = false;
    filter.reference_cursor = 0;
    filter.echo_delay_ms = 0;
  }
  if (filter.echo_active) {
    const auto capture_latency = static_cast<int64_t>(now) - static_cast<int64_t>(audio->timestamp);
    const auto delay = std::clamp<int64_t>((capture_latency - filter.reference_latency) / 1'000'000, 0, 500);
    filter.echo_delay_ms = static_cast<int32_t>(delay);
    lycan_voice_set_echo_delay(filter.processor, static_cast<int32_t>(delay));
  }
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

void voice_filter_echo_enabled(obs_source_t *filter, bool enabled) {
  calldata_t values;
  calldata_init(&values);
  calldata_set_bool(&values, "enabled", enabled);
  proc_handler_call(obs_source_get_proc_handler(filter), "voice_echo", &values);
  calldata_free(&values);
}

void voice_filter_reference(obs_source_t *filter, const obs_audio_data *audio) {
  calldata_t values;
  calldata_init(&values);
  calldata_set_ptr(&values, "audio", const_cast<obs_audio_data *>(audio));
  proc_handler_call(obs_source_get_proc_handler(filter), "voice_reference", &values);
  calldata_free(&values);
}

std::string voice_filter_echo_metrics(obs_source_t *filter) {
  std::string output = "null";
  calldata_t values;
  calldata_init(&values);
  calldata_set_ptr(&values, "output", &output);
  proc_handler_call(obs_source_get_proc_handler(filter), "voice_echo_metrics", &values);
  calldata_free(&values);
  return output;
}

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
