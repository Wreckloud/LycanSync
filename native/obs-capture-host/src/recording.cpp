#include "recording.h"
#include "recording_audio.h"

#include <obs-module.h>
#include <callback/calldata.h>
#include <callback/signal.h>
#include <filesystem>
#include <chrono>
#include <array>
#include <windows.h>
#include <d3d11.h>
#include <dxgi.h>
#include <wrl/client.h>
#include <graphics/graphics.h>

RecordingOutput::RecordingOutput(std::string plugin_directory, std::string data_directory, Emit emit)
    : plugin_directory_(std::move(plugin_directory)), data_directory_(std::move(data_directory)), emit_(std::move(emit)) {}

RecordingOutput::~RecordingOutput() {
  shutdown();
  release();
}

bool RecordingOutput::load_modules() {
  if (modules_loaded_) return true;
  for (const auto *name : {"obs-ffmpeg", "obs-nvenc", "obs-qsv11"}) {
    obs_module_t *module = obs_get_module(name);
    const auto path = plugin_directory_ + "/" + name + ".dll";
    const auto data = data_directory_ + "/" + name;
    if ((!module && obs_open_module(&module, path.c_str(), data.c_str()) != MODULE_SUCCESS) || !obs_init_module(module)) {
      if (std::string_view(name) == "obs-ffmpeg") return false;
      // 显卡编码模块缺少对应硬件时可能拒绝加载，不启用软件编码兜底。
      continue;
    }
  }
  obs_post_load_modules();
  modules_loaded_ = true;
  return true;
}

bool RecordingOutput::start(std::string id, std::string path, bool voices) {
  if (active()) { emit_("recordingFailed", id, "recordingAlreadyRunning"); return false; }
  release();
  id_ = std::move(id);
  started_ = false;
  const auto fail = [&](const char *code) { release(); emit_("recordingFailed", id_, code); return false; };
  if (!std::filesystem::u8path(path).is_absolute() || std::filesystem::u8path(path).extension() != L".mkv") {
    return fail("recordingPathInvalid");
  }
  if (!load_modules()) return fail("recordingModuleUnavailable");
  std::array<const char *, 3> candidates{"obs_nvenc_h264_tex", "obs_qsv11_v2", "h264_texture_amf"};
  obs_enter_graphics();
  auto *device = static_cast<ID3D11Device *>(gs_get_device_obj());
  Microsoft::WRL::ComPtr<IDXGIDevice> dxgi_device;
  Microsoft::WRL::ComPtr<IDXGIAdapter> adapter;
  DXGI_ADAPTER_DESC description{};
  if (device && SUCCEEDED(device->QueryInterface(IID_PPV_ARGS(&dxgi_device)))
      && SUCCEEDED(dxgi_device->GetAdapter(&adapter)) && SUCCEEDED(adapter->GetDesc(&description))) {
    // 优先当前画布所在显卡，避免双显卡电脑默认跨设备编码。
    if (description.VendorId == 0x8086) std::swap(candidates[0], candidates[1]);
    else if (description.VendorId == 0x1002) std::swap(candidates[0], candidates[2]);
  }
  obs_leave_graphics();
  const char *encoder_id = nullptr;
  for (const auto *candidate : candidates) {
    const auto *codec = obs_get_encoder_codec(candidate);
    if (codec && std::string_view(codec) == "h264") { encoder_id = candidate; break; }
  }
  if (!encoder_id) return fail("recordingHardwareEncoderUnavailable");
  obs_data_t *settings = obs_encoder_defaults(encoder_id);
  if (std::string_view(encoder_id) == "obs_nvenc_h264_tex") {
    obs_data_set_string(settings, "rate_control", "cqp");
    obs_data_set_int(settings, "cqp", 23);
    obs_data_set_string(settings, "preset", "p4");
    obs_data_set_string(settings, "multipass", "disabled");
  } else if (std::string_view(encoder_id) == "obs_qsv11_v2") {
    obs_data_set_string(settings, "rate_control", "ICQ");
    obs_data_set_int(settings, "icq_quality", 23);
  } else {
    obs_data_set_string(settings, "rate_control", "CQP");
    obs_data_set_int(settings, "qp_i", 23);
    obs_data_set_int(settings, "qp_p", 23);
    obs_data_set_int(settings, "qp_b", 23);
  }
  video_ = obs_video_encoder_create(encoder_id, "LycanSync recording video", settings, nullptr);
  obs_data_release(settings);
  if (!video_) return fail("recordingEncoderStartFailed");
  obs_encoder_set_video(video_, obs_get_video());
  {
    settings = obs_encoder_defaults("ffmpeg_aac");
    obs_data_set_int(settings, "bitrate", 192);
    audio_ = obs_audio_encoder_create("ffmpeg_aac", "LycanSync recording audio", settings, 0, nullptr);
    obs_data_release(settings);
    if (!audio_) return fail("recordingAudioEncoderUnavailable");
    obs_encoder_set_audio(audio_, obs_get_audio());
  }
  settings = obs_data_create();
  obs_data_set_string(settings, "path", path.c_str());
  output_ = obs_output_create("ffmpeg_muxer", "LycanSync recording", settings, nullptr);
  obs_data_release(settings);
  if (!output_) return fail("recordingOutputUnavailable");
  obs_output_set_video_encoder(output_, video_);
  if (audio_) obs_output_set_audio_encoder(output_, audio_, 0);
  voice_failed_ = false;
  if (voices) {
    voice_ = std::make_unique<RecordingAudioInput>([this] { voice_failed_ = true; stop(); });
    if (!voice_->start(id_)) return fail("recordingVoiceUnavailable");
  }
  auto *signals = obs_output_get_signal_handler(output_);
  signal_handler_connect(signals, "start", started, this);
  signal_handler_connect(signals, "stop", stopped, this);
  { const std::lock_guard<std::mutex> lock(mutex_); completed_ = false; }
  running_ = true;
  if (!obs_output_start(output_)) {
    running_ = false;
    { const std::lock_guard<std::mutex> lock(mutex_); completed_ = true; }
    return fail("recordingEncoderStartFailed");
  }
  if (voice_failed_) stop();
  return true;
}

void RecordingOutput::started(void *context, calldata_t *) {
  auto &self = *static_cast<RecordingOutput *>(context);
  self.started_ = true;
}

void RecordingOutput::stopped(void *context, calldata_t *event) {
  auto &self = *static_cast<RecordingOutput *>(context);
  const auto code = calldata_int(event, "code");
  {
    const std::lock_guard<std::mutex> lock(self.mutex_);
    self.stop_code_ = static_cast<int>(code);
    self.completed_ = true;
    self.stopped_.notify_all();
  }
}

bool RecordingOutput::active() const { return running_.load(); }
void RecordingOutput::poll() {
  if (started_.exchange(false)) emit_("recordingStarted", id_, "");
  if (!output_ || !active()) return;
  int code;
  { const std::lock_guard<std::mutex> lock(mutex_); if (!completed_) return; code = stop_code_; }
  running_ = false;
  emit_("recordingStopped", id_, voice_failed_ ? "recordingVoiceUnavailable" : code == OBS_OUTPUT_SUCCESS ? "" :
      code == OBS_OUTPUT_NO_SPACE ? "recordingDiskFull" : "recordingWriteFailed");
  release();
}
uint64_t RecordingOutput::bytes() const { return output_ ? obs_output_get_total_bytes(output_) : 0; }
uint64_t RecordingOutput::frames() const { return output_ ? obs_output_get_total_frames(output_) : 0; }
void RecordingOutput::stop() {
  if (voice_) voice_->request_stop();
  if (output_ && active()) obs_output_stop(output_);
}
bool RecordingOutput::shutdown() {
  if (!output_) return true;
  stop();
  std::unique_lock<std::mutex> lock(mutex_);
  const bool completed = stopped_.wait_for(lock, std::chrono::seconds(8), [&] { return completed_; });
  lock.unlock();
  if (completed) poll();
  return completed;
}
void RecordingOutput::release() {
  started_ = false;
  voice_.reset();
  if (output_) {
    auto *signals = obs_output_get_signal_handler(output_);
    signal_handler_disconnect(signals, "start", started, this);
    signal_handler_disconnect(signals, "stop", stopped, this);
    if (obs_output_active(output_)) obs_output_force_stop(output_);
    obs_output_release(output_); output_ = nullptr;
  }
  if (video_) { obs_encoder_release(video_); video_ = nullptr; }
  if (audio_) { obs_encoder_release(audio_); audio_ = nullptr; }
}
