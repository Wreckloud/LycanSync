#pragma once

#include <obs.h>
#include <atomic>
#include <condition_variable>
#include <functional>
#include <mutex>
#include <memory>
#include <string>
#include <string_view>

class RecordingAudioInput;
class RecordingOutput {
public:
  using Emit = std::function<void(std::string_view, std::string_view, std::string_view)>;
  RecordingOutput(std::string plugin_directory, std::string data_directory, Emit emit);
  ~RecordingOutput();
  bool start(std::string id, std::string path, bool voices, obs_source_t *source, const std::string &pipeline_id, uint32_t height, uint32_t fps);
  bool start_replay(std::string id, bool voices, obs_source_t *source, const std::string &pipeline_id, uint32_t seconds, uint32_t height, uint32_t fps);
  bool save_replay(std::string id, const std::string &path, const std::string &replay_id);
  void stop_replay();
  bool replay_active() const;
  std::string_view saved_id() const;
  void stop();
  bool shutdown();
  bool active() const;
  void poll();
  uint64_t bytes() const;
  uint64_t frames() const;
  uint32_t width() const;
  uint32_t height() const;
  uint32_t frame_rate() const;
  uint32_t replay_memory_mb() const;
  std::string encoding_diagnostics() const;

private:
  std::string plugin_directory_, data_directory_, id_;
  Emit emit_;
  obs_output_t *output_ = nullptr;
  obs_output_t *replay_ = nullptr;
  std::string pipeline_id_, replay_id_, save_id_, save_path_, pipeline_error_;
  bool voices_ = false;
  std::atomic<bool> replay_running_ = false, replay_started_ = false, replay_completed_ = true, replay_saved_ = false;
  int replay_code_ = 0;
  obs_encoder_t *video_ = nullptr;
  obs_encoder_t *audio_ = nullptr;
  obs_view_t *view_ = nullptr;
  obs_scene_t *scene_ = nullptr;
  uint32_t width_ = 0, height_ = 0;
  uint32_t height_limit_ = 0, fps_limit_ = 0, frame_rate_ = 0;
  uint32_t replay_memory_mb_ = 0;
  std::atomic<bool> running_ = false;
  std::mutex mutex_;
  std::condition_variable stopped_;
  bool completed_ = true;
  int stop_code_ = 0;
  std::atomic<bool> started_ = false;
  bool modules_loaded_ = false;
  std::unique_ptr<RecordingAudioInput> voice_;
  std::atomic<bool> voice_failed_ = false;
  void release();
  void release_pipeline();
  void release_output(obs_output_t *&output, bool replay);
  bool prepare_pipeline(const std::string &id, bool voices, obs_source_t *source, uint32_t height, uint32_t fps);
  bool load_modules();
  static void started(void *, calldata_t *);
  static void stopped(void *, calldata_t *);
  static void replay_started(void *, calldata_t *);
  static void replay_stopped(void *, calldata_t *);
  static void replay_saved(void *, calldata_t *);
};
