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
  bool start(std::string id, std::string path, bool voices);
  void stop();
  bool shutdown();
  bool active() const;
  void poll();
  uint64_t bytes() const;
  uint64_t frames() const;

private:
  std::string plugin_directory_, data_directory_, id_;
  Emit emit_;
  obs_output_t *output_ = nullptr;
  obs_encoder_t *video_ = nullptr;
  obs_encoder_t *audio_ = nullptr;
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
  bool load_modules();
  static void started(void *, calldata_t *);
  static void stopped(void *, calldata_t *);
};
