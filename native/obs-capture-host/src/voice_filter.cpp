#include "voice_filter.h"

#include <atomic>
#include <cstdint>
#include <mutex>

extern "C" {
void *lycan_voice_create(float gain, uint8_t noise, uint8_t agc, uint8_t high_pass);
bool lycan_voice_configure(void *, float gain, uint8_t noise, uint8_t agc, uint8_t high_pass);
bool lycan_voice_process(void *, float *samples, uint32_t frames);
void lycan_voice_destroy(void *);
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
void *create(obs_data_t *settings, obs_source_t *) {
  auto *filter = new Filter;
  update(filter, settings);
  if (!filter->processor) { delete filter; return nullptr; }
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
