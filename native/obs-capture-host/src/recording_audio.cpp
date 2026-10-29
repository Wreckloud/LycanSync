#include "recording_audio.h"

#include <windows.h>
#include <obs-module.h>
#include <util/platform.h>
#include <array>
#include <atomic>
#include <cstring>
#include <cmath>
#include <algorithm>
#include <thread>

namespace {
struct Input {
  obs_source_t *source;
  std::function<void()> failed;
  HANDLE stopping = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  std::thread worker;
  bool read(HANDLE pipe, HANDLE completed, uint8_t *buffer, DWORD bytes) {
    DWORD received = 0;
    while (received < bytes) {
      OVERLAPPED operation{}; operation.hEvent = completed;
      ResetEvent(completed);
      DWORD count = 0;
      if (!ReadFile(pipe, buffer + received, bytes - received, &count, &operation)
          && GetLastError() != ERROR_IO_PENDING) return false;
      const HANDLE events[] = {stopping, completed};
      if (WaitForMultipleObjects(2, events, FALSE, 5000) != WAIT_OBJECT_0 + 1) {
        CancelIoEx(pipe, &operation); GetOverlappedResult(pipe, &operation, &count, TRUE); return false;
      }
      if (!GetOverlappedResult(pipe, &operation, &count, FALSE) || !count) return false;
      received += count;
    }
    return true;
  }
  void run(std::string id) {
    const std::wstring path = L"\\\\.\\pipe\\lycansync-recording-voice-" + std::wstring(id.begin(), id.end());
    HANDLE pipe = CreateFileW(path.c_str(), GENERIC_READ, 0, nullptr, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, nullptr);
    HANDLE completed = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    uint64_t anchor = 0, first_position = 0, previous_position = 0;
    bool initialized = false;
    std::array<uint8_t, 1932> packet{};
    std::array<float, 480> samples{};
    while (pipe != INVALID_HANDLE_VALUE && completed && WaitForSingleObject(stopping, 0) != WAIT_OBJECT_0
        && read(pipe, completed, packet.data(), static_cast<DWORD>(packet.size()))) {
      uint32_t frames; uint64_t position;
      std::memcpy(&frames, packet.data(), 4); std::memcpy(&position, packet.data() + 4, 8);
      if (frames != 480 || position > 9'007'199'254'740'991ULL || (initialized && position <= previous_position)) break;
      std::memcpy(samples.data(), packet.data() + 12, sizeof(samples));
      for (auto &sample : samples) sample = std::isfinite(sample) ? std::clamp(sample, -1.0f, 1.0f) : 0.0f;
      const auto now = os_gettime_ns();
      if (!initialized) { first_position = position; anchor = now; initialized = true; }
      const auto delta = position - first_position;
      auto timestamp = anchor + delta / 48'000 * 1'000'000'000ULL + delta % 48'000 * 1'000'000'000ULL / 48'000;
      // 丢块保留采样位置形成静音间隙；长期迟到不积压到后续画面。
      if (timestamp + 200'000'000ULL < now || timestamp > now + 200'000'000ULL) {
        first_position = position; anchor = now; timestamp = now;
      }
      previous_position = position;
      obs_source_audio audio{};
      audio.data[0] = reinterpret_cast<uint8_t *>(samples.data()); audio.frames = frames;
      audio.speakers = SPEAKERS_MONO; audio.format = AUDIO_FORMAT_FLOAT; audio.samples_per_sec = 48'000; audio.timestamp = timestamp;
      obs_source_output_audio(source, &audio);
    }
    if (completed) CloseHandle(completed);
    if (pipe != INVALID_HANDLE_VALUE) CloseHandle(pipe);
    if (WaitForSingleObject(stopping, 0) != WAIT_OBJECT_0) failed();
  }
  ~Input() {
    if (stopping) SetEvent(stopping);
    if (worker.joinable()) worker.join();
    if (stopping) CloseHandle(stopping);
  }
};
bool registered = false;
}

RecordingAudioInput::RecordingAudioInput(std::function<void()> failed) : failed_(std::move(failed)) {}
RecordingAudioInput::~RecordingAudioInput() { stop(); }
bool RecordingAudioInput::start(const std::string &pipe_id) {
  if (!registered) {
    obs_source_info info{};
    info.id = "lycansync_recording_voice"; info.type = OBS_SOURCE_TYPE_INPUT; info.output_flags = OBS_SOURCE_AUDIO;
    info.get_name = [](void *) { return "LycanSync recording voice"; };
    info.create = [](obs_data_t *, obs_source_t *source) -> void * { return new Input{source}; };
    info.destroy = [](void *context) { delete static_cast<Input *>(context); };
    obs_register_source(&info); registered = true;
  }
  source_ = obs_source_create_private("lycansync_recording_voice", "LycanSync recording voice", nullptr);
  if (!source_) return false;
  auto *input = static_cast<Input *>(obs_obj_get_data(source_));
  if (!input || !input->stopping) { stop(); return false; }
  input->failed = failed_;
  obs_source_set_audio_mixers(source_, 1);
  obs_source_set_monitoring_type(source_, OBS_MONITORING_TYPE_NONE);
  obs_set_output_source(2, source_);
  input->worker = std::thread([input, pipe_id] { input->run(pipe_id); });
  return true;
}
void RecordingAudioInput::stop() {
  if (!source_) return;
  obs_set_output_source(2, nullptr);
  auto *input = static_cast<Input *>(obs_obj_get_data(source_));
  if (input && input->stopping) SetEvent(input->stopping);
  obs_source_remove(source_); obs_source_release(source_); source_ = nullptr;
  obs_wait_for_destroy_queue();
}
void RecordingAudioInput::request_stop() {
  if (!source_) return;
  auto *input = static_cast<Input *>(obs_obj_get_data(source_));
  if (input && input->stopping) SetEvent(input->stopping);
}
