#include "recording.h"
#include "recording_audio.h"

#include <obs-module.h>
#include <callback/calldata.h>
#include <callback/signal.h>
#include <callback/proc.h>
#include <filesystem>
#include <chrono>
#include <array>
#include <algorithm>
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

bool RecordingOutput::prepare_pipeline(const std::string &id, bool voices, obs_source_t *source, uint32_t height, uint32_t fps) {
  pipeline_error_ = "recordingBusy";
  if (video_) return pipeline_id_ == id && voices_ == voices && height_limit_ == height && fps_limit_ == fps;
  if ((height != 720 && height != 1080 && height != 1440) || (fps != 30 && fps != 60 && fps != 120)) return false;
  height_limit_ = height; fps_limit_ = fps;
  pipeline_id_ = id;
  voices_ = voices;
  const auto fail = [&](const char *code) { pipeline_error_ = code; release_pipeline(); return false; };
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
  obs_video_info video_info{};
  const auto source_width = source ? obs_source_get_width(source) : 0;
  const auto source_height = source ? obs_source_get_height(source) : 0;
  if (!source_width || !source_height || !obs_get_video_info(&video_info)) return fail("recordingShareUnavailable");
  const auto scale = std::min({1.0, static_cast<double>(height * 16 / 9) / source_width,
      static_cast<double>(height) / source_height});
  // libobs 输出宽度按四像素、高度按两像素对齐；固定本段尺寸，不录入共享画布的空白区域。
  width_ = static_cast<uint32_t>(source_width * scale) & ~3u;
  height_ = static_cast<uint32_t>(source_height * scale) & ~1u;
  if (!width_ || !height_) return fail("recordingShareUnavailable");
  scene_ = obs_canvas_scene_create(obs_get_main_canvas(), "LycanSync recording framing");
  auto *item = scene_ ? obs_scene_add(scene_, source) : nullptr;
  if (!item) return fail("recordingOutputUnavailable");
  obs_transform_info transform{};
  transform.pos = {width_ / 2.0f, height_ / 2.0f};
  transform.scale = {1.0f, 1.0f};
  transform.alignment = OBS_ALIGN_CENTER;
  transform.bounds_type = OBS_BOUNDS_MAX_ONLY;
  transform.bounds_alignment = OBS_ALIGN_CENTER;
  transform.bounds = {static_cast<float>(width_), static_cast<float>(height_)};
  obs_sceneitem_set_info2(item, &transform);
  // 复用同一个已授权来源，仅录像期间增加合成输出；不启动第二路捕获或回读 CPU 像素。
  view_ = obs_view_create();
  if (!view_) return fail("recordingOutputUnavailable");
  obs_view_set_source(view_, 0, obs_scene_get_source(scene_));
  video_info.base_width = video_info.output_width = width_;
  video_info.base_height = video_info.output_height = height_;
  video_info.fps_num = frame_rate_ = std::min(video_info.fps_num, fps);
  video_info.output_format = VIDEO_FORMAT_NV12;
  video_info.gpu_conversion = true;
  video_info.colorspace = VIDEO_CS_709;
  auto *recording_video = obs_view_add2(view_, &video_info);
  if (!recording_video) return fail("recordingOutputUnavailable");
  obs_data_t *settings = obs_encoder_defaults(encoder_id);
  if (std::string_view(encoder_id) == "obs_nvenc_h264_tex") {
    obs_data_set_string(settings, "rate_control", "CQP");
    obs_data_set_int(settings, "cqp", 23);
    obs_data_set_string(settings, "preset", "p4");
    obs_data_set_string(settings, "multipass", "disabled");
    obs_data_set_bool(settings, "lookahead", false);
  } else if (std::string_view(encoder_id) == "obs_qsv11_v2") {
    obs_data_set_string(settings, "rate_control", "ICQ");
    obs_data_set_int(settings, "icq_quality", 23);
  } else {
    obs_data_set_string(settings, "rate_control", "CQP");
    obs_data_set_int(settings, "qp_i", 23);
    obs_data_set_int(settings, "qp_p", 23);
    obs_data_set_int(settings, "qp_b", 23);
  }
  obs_data_set_int(settings, "keyint_sec", 2);
  video_ = obs_video_encoder_create(encoder_id, "LycanSync recording video", settings, nullptr);
  obs_data_release(settings);
  if (!video_) return fail("recordingEncoderStartFailed");
  obs_encoder_set_video(video_, recording_video);
  {
    settings = obs_encoder_defaults("ffmpeg_aac");
    obs_data_set_int(settings, "bitrate", 192);
    audio_ = obs_audio_encoder_create("ffmpeg_aac", "LycanSync recording audio", settings, 0, nullptr);
    obs_data_release(settings);
    if (!audio_) return fail("recordingAudioEncoderUnavailable");
    obs_encoder_set_audio(audio_, obs_get_audio());
  }
  voice_failed_ = false;
  if (voices) {
    voice_ = std::make_unique<RecordingAudioInput>([this] { voice_failed_ = true; });
    if (!voice_->start(pipeline_id_)) return fail("recordingVoiceUnavailable");
  }
  return true;
}

bool RecordingOutput::start(std::string id, std::string path, bool voices, obs_source_t *source, const std::string &pipeline_id, uint32_t height, uint32_t fps) {
  if (output_) { emit_("recordingFailed", id, "recordingAlreadyRunning"); return false; }
  id_ = std::move(id);
  started_ = false;
  const auto fail = [&](const char *code) {
    release_output(output_, false);
    emit_("recordingFailed", id_, code);
    return false;
  };
  if (!std::filesystem::u8path(path).is_absolute() || std::filesystem::u8path(path).extension() != L".mkv") return fail("recordingPathInvalid");
  if (!prepare_pipeline(pipeline_id, voices, source, height, fps)) return fail(pipeline_error_.c_str());
  auto *settings = obs_data_create();
  obs_data_set_string(settings, "path", path.c_str());
  output_ = obs_output_create("ffmpeg_muxer", "LycanSync recording", settings, nullptr);
  obs_data_release(settings);
  if (!output_) return fail("recordingOutputUnavailable");
  obs_output_set_video_encoder(output_, video_);
  if (audio_) obs_output_set_audio_encoder(output_, audio_, 0);
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

bool RecordingOutput::active() const { return running_.load() || replay_running_.load(); }
bool RecordingOutput::replay_active() const { return replay_running_.load(); }
std::string_view RecordingOutput::saved_id() const { return save_id_; }
void RecordingOutput::poll() {
  if (voice_failed_) { stop(); stop_replay(); }
  if (started_.exchange(false)) emit_("recordingStarted", id_, "");
  if (replay_started_.exchange(false)) emit_("replayStarted", replay_id_, "");
  if (replay_saved_.exchange(false)) {
    calldata_t result = {};
    proc_handler_call(obs_output_get_proc_handler(replay_), "get_last_replay", &result);
    const auto *path = calldata_string(&result, "path");
    const bool expected = path && std::filesystem::u8path(path).lexically_normal() == std::filesystem::u8path(save_path_).lexically_normal();
    calldata_free(&result);
    emit_(expected ? "replaySaved" : "replaySaveFailed", replay_id_, expected ? "" : "recordingWriteFailed");
    save_id_.clear(); save_path_.clear();
  }
  int code; bool completed;
  { const std::lock_guard<std::mutex> lock(mutex_); completed = completed_; code = stop_code_; }
  if (output_ && running_ && completed) {
    running_ = false;
    emit_("recordingStopped", id_, voice_failed_ ? "recordingVoiceUnavailable" : code == OBS_OUTPUT_SUCCESS ? "" :
        code == OBS_OUTPUT_NO_SPACE ? "recordingDiskFull" : "recordingWriteFailed");
    release_output(output_, false);
  }
  if (replay_ && replay_running_ && replay_completed_) {
    replay_running_ = false;
    // 回放析构会等待正在落盘的快照，确认释放后才能允许下一次输出。
    release_output(replay_, true);
    replay_saved_ = false;
    emit_("replayStopped", replay_id_, voice_failed_ ? "recordingVoiceUnavailable" : replay_code_ == OBS_OUTPUT_SUCCESS ? "" : "recordingWriteFailed");
    save_id_.clear(); save_path_.clear();
  }
}
uint64_t RecordingOutput::bytes() const { return output_ ? obs_output_get_total_bytes(output_) : 0; }
uint64_t RecordingOutput::frames() const { return output_ ? obs_output_get_total_frames(output_) : 0; }
uint32_t RecordingOutput::width() const { return width_; }
uint32_t RecordingOutput::height() const { return height_; }
uint32_t RecordingOutput::frame_rate() const { return frame_rate_; }
uint32_t RecordingOutput::replay_memory_mb() const { return replay_memory_mb_; }
std::string RecordingOutput::encoding_diagnostics() const {
  if (!video_) return "";
  const std::string_view id = obs_encoder_get_id(video_);
  const auto encoder = id == "obs_nvenc_h264_tex" ? "nvenc" : id == "obs_qsv11_v2" ? "qsv" : id == "h264_texture_amf" ? "amf" : "unknown";
  auto *settings = obs_encoder_get_settings(video_);
  const std::string_view rate = obs_data_get_string(settings, "rate_control");
  const auto mode = rate == "CQP" ? "CQP" : rate == "ICQ" ? "ICQ" : "unknown";
  std::string result = ",\"encoder\":\"" + std::string(encoder) + "\",\"configuredRateControl\":\"" + mode + "\"";
  if (id == "obs_nvenc_h264_tex") result += std::string(",\"configuredLookahead\":") + (obs_data_get_bool(settings, "lookahead") ? "true" : "false");
  obs_data_release(settings);
  return result;
}
void RecordingOutput::stop() {
  if (voice_ && !replay_running_) voice_->request_stop();
  if (output_ && running_) obs_output_stop(output_);
}
bool RecordingOutput::shutdown() {
  stop();
  stop_replay();
  std::unique_lock<std::mutex> lock(mutex_);
  const bool completed = stopped_.wait_for(lock, std::chrono::seconds(8), [&] { return (!output_ || completed_) && (!replay_ || replay_completed_); });
  lock.unlock();
  if (completed) poll();
  return completed;
}
void RecordingOutput::release() {
  release_output(output_, false);
  release_output(replay_, true);
}
void RecordingOutput::release_output(obs_output_t *&output, bool replay) {
  if (output) {
    auto *signals = obs_output_get_signal_handler(output);
    signal_handler_disconnect(signals, "start", replay ? replay_started : started, this);
    signal_handler_disconnect(signals, "stop", replay ? replay_stopped : stopped, this);
    if (replay) signal_handler_disconnect(signals, "saved", replay_saved, this);
    if (obs_output_active(output)) obs_output_force_stop(output);
    obs_output_release(output); output = nullptr;
  }
  if (!output_ && !replay_) release_pipeline();
}
void RecordingOutput::release_pipeline() {
  started_ = false;
  voice_.reset();
  if (video_) { obs_encoder_release(video_); video_ = nullptr; }
  if (audio_) { obs_encoder_release(audio_); audio_ = nullptr; }
  // 编码器先脱离输出，再移除视图；共享来源仍由采集场景持有，不能随录像销毁。
  if (view_) { obs_view_remove(view_); obs_view_destroy(view_); view_ = nullptr; }
  if (scene_) { obs_source_remove(obs_scene_get_source(scene_)); obs_scene_release(scene_); scene_ = nullptr; }
}

bool RecordingOutput::start_replay(std::string id, bool voices, obs_source_t *source, const std::string &pipeline_id, uint32_t seconds, uint32_t height, uint32_t fps) {
  if (replay_) { emit_("replayFailed", id, "recordingBusy"); return false; }
  replay_id_ = std::move(id);
  const auto fail = [&](const char *code) { release_output(replay_, true); emit_("replayFailed", replay_id_, code); return false; };
  if (seconds != 30 && seconds != 60 && seconds != 120) return fail("recordingPathInvalid");
  if (!prepare_pipeline(pipeline_id, voices, source, height, fps)) return fail(pipeline_error_.c_str());
  auto *settings = obs_data_create();
  // 按完整 GOP 留出两秒，避免达到时间阈值后清理首个关键帧导致片段反而偏短。
  obs_data_set_int(settings, "max_time_sec", seconds + 2);
  replay_memory_mb_ = seconds / 30 * 256;
  obs_data_set_int(settings, "max_size_mb", replay_memory_mb_);
  obs_data_set_string(settings, "extension", "mkv");
  obs_data_set_bool(settings, "allow_spaces", true);
  replay_ = obs_output_create("replay_buffer", "LycanSync replay", settings, nullptr);
  obs_data_release(settings);
  if (!replay_) return fail("recordingOutputUnavailable");
  obs_output_set_video_encoder(replay_, video_);
  obs_output_set_audio_encoder(replay_, audio_, 0);
  auto *signals = obs_output_get_signal_handler(replay_);
  signal_handler_connect(signals, "start", replay_started, this);
  signal_handler_connect(signals, "stop", replay_stopped, this);
  signal_handler_connect(signals, "saved", replay_saved, this);
  replay_completed_ = false; replay_running_ = true;
  if (!obs_output_start(replay_)) { replay_completed_ = true; replay_running_ = false; return fail("recordingEncoderStartFailed"); }
  return true;
}
bool RecordingOutput::save_replay(std::string id, const std::string &path, const std::string &replay_id) {
  if (!replay_ || !replay_running_ || replay_id != replay_id_ || !save_id_.empty()) return false;
  const auto target = std::filesystem::u8path(path);
  std::error_code error;
  if (!target.is_absolute() || target.extension() != L".mkv" || std::filesystem::exists(target, error) || error) return false;
  save_id_ = std::move(id); save_path_ = path;
  auto *settings = obs_data_create();
  const auto directory = target.parent_path().generic_u8string();
  const auto filename = target.stem().u8string();
  obs_data_set_string(settings, "directory", reinterpret_cast<const char *>(directory.c_str()));
  obs_data_set_string(settings, "format", reinterpret_cast<const char *>(filename.c_str()));
  obs_output_update(replay_, settings);
  obs_data_release(settings);
  calldata_t request = {};
  if (proc_handler_call(obs_output_get_proc_handler(replay_), "save", &request)) return true;
  save_id_.clear(); save_path_.clear();
  return false;
}
void RecordingOutput::stop_replay() {
  if (voice_ && !running_) voice_->request_stop();
  if (replay_ && replay_running_) obs_output_stop(replay_);
}
void RecordingOutput::replay_started(void *context, calldata_t *) {
  static_cast<RecordingOutput *>(context)->replay_started_ = true;
}
void RecordingOutput::replay_stopped(void *context, calldata_t *event) {
  auto &self = *static_cast<RecordingOutput *>(context);
  const std::lock_guard<std::mutex> lock(self.mutex_);
  self.replay_code_ = static_cast<int>(calldata_int(event, "code"));
  self.replay_completed_ = true;
  self.stopped_.notify_all();
}
void RecordingOutput::replay_saved(void *context, calldata_t *) {
  static_cast<RecordingOutput *>(context)->replay_saved_ = true;
}
