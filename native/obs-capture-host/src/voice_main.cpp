#include "voice_filter.h"

#include <windows.h>
#include <obs-module.h>
#include <callback/calldata.h>
#include <callback/proc.h>
#include <objbase.h>

#include <array>
#include <algorithm>
#include <atomic>
#include <charconv>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdio>
#include <iostream>
#include <mutex>
#include <memory>
#include <string>
#include <string_view>
#include <thread>

namespace {
using Clock = std::chrono::steady_clock;
std::atomic<unsigned long> audio_hresult = 0;
void audio_log(int, const char *format, va_list args, void *) {
  // 只提取固定 WASAPI 失败模板中的错误码，不记录设备名称或异常正文。
  if (std::string_view(format) == "[CreateWASAPISource] %s: %lX") {
    va_arg(args, const char *);
    audio_hresult = static_cast<unsigned long>(va_arg(args, long));
  } else if (std::string_view(format) == "[WASAPISource::TryInitialize]:[%s] %s: %lX") {
    va_arg(args, const char *);
    va_arg(args, const char *);
    audio_hresult = static_cast<unsigned long>(va_arg(args, long));
  }
}
struct Settings { float gain = 1; bool noise = true; bool agc = true; bool high_pass = true; };
bool parse_settings(std::string_view text, Settings &settings) {
  const auto split = text.find('|');
  if (split == text.npos || text.size() - split != 4) return false;
  const auto result = std::from_chars(text.data(), text.data() + split, settings.gain);
  if (result.ec != std::errc{} || result.ptr != text.data() + split || !std::isfinite(settings.gain)
      || settings.gain < 0 || settings.gain > 2) return false;
  for (size_t i = split + 1; i < text.size(); ++i) if (text[i] != '0' && text[i] != '1') return false;
  settings.noise = text[split + 1] == '1'; settings.agc = text[split + 2] == '1'; settings.high_pass = text[split + 3] == '1';
  return true;
}
std::string utf8(std::wstring_view value) {
  const int count = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  std::string result(count, '\0');
  if (count) WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), count, nullptr, nullptr);
  return result;
}
bool pipe_id(std::wstring_view value) {
  if (value.size() != 36) return false;
  for (size_t i = 0; i < value.size(); ++i) {
    if (i == 8 || i == 13 || i == 18 || i == 23) { if (value[i] != '-') return false; }
    else if (!((value[i] >= '0' && value[i] <= '9') || (value[i] >= 'a' && value[i] <= 'f') || (value[i] >= 'A' && value[i] <= 'F'))) return false;
  }
  return true;
}
void event(const char *name, std::string_view fields = "") {
  std::cout << "{\"event\":\"" << name << '"' << fields << "}\n" << std::flush;
}
void failure_event(std::string_view code) {
  std::string fields = ",\"code\":\"" + std::string(code) + "\"";
  if (const auto result = audio_hresult.load()) {
    char value[11]{};
    std::snprintf(value, sizeof(value), "0x%08lX", result);
    fields += ",\"hresult\":\"" + std::string(value) + "\"";
  }
  event("failed", fields);
}
void configure(obs_source_t *filter, Settings settings) {
  obs_data_t *values = obs_data_create();
  obs_data_set_double(values, "input_gain", settings.gain);
  obs_data_set_bool(values, "noise_suppression", settings.noise);
  obs_data_set_bool(values, "auto_gain_control", settings.agc);
  obs_data_set_bool(values, "voice_enhancement", settings.high_pass);
  obs_source_update(filter, values);
  obs_data_release(values);
}
struct Packet { uint32_t frames = 480; std::array<float, 480> samples{}; };
static_assert(sizeof(Packet) == 1924);

struct AudioPipe {
  HANDLE stop = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  std::mutex mutex;
  std::condition_variable changed;
  std::array<Packet, 12> packets{};
  Packet partial;
  size_t cursor = 0, head = 0, count = 0;
  uint64_t dropped = 0;
  uint64_t received = 0;
  bool accepting = true;
  std::atomic<bool> delivered = false;
  std::atomic<bool> failed = false;
  std::thread writer;
  ~AudioPipe() { shutdown(); if (stop) CloseHandle(stop); }
  void shutdown() {
    { const std::lock_guard<std::mutex> lock(mutex); accepting = false; count = 0; }
    if (stop) SetEvent(stop);
    changed.notify_all();
    if (writer.joinable()) writer.join();
  }
  static void capture(void *context, obs_source_t *, const audio_data *audio, bool muted) {
    auto &pipe = *static_cast<AudioPipe *>(context);
    const auto *samples = reinterpret_cast<const float *>(audio->data[0]);
    const std::lock_guard<std::mutex> lock(pipe.mutex);
    if (!pipe.accepting) return;
    if (!muted && !samples) { pipe.failed = true; return; }
    pipe.received += audio->frames;
    for (uint32_t i = 0; i < audio->frames; ++i) {
      pipe.partial.samples[pipe.cursor++] = muted ? 0.0f : samples[i];
      if (pipe.cursor != 480) continue;
      if (pipe.count == pipe.packets.size()) { pipe.head = (pipe.head + 1) % pipe.packets.size(); --pipe.count; ++pipe.dropped; }
      pipe.packets[(pipe.head + pipe.count++) % pipe.packets.size()] = pipe.partial;
      pipe.cursor = 0;
    }
    pipe.changed.notify_one();
  }
  void run(std::wstring name) {
    HANDLE pipe = CreateFileW(name.c_str(), GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, nullptr);
    HANDLE completed = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (pipe == INVALID_HANDLE_VALUE || !completed) failed = true;
    while (!failed && WaitForSingleObject(stop, 0) != WAIT_OBJECT_0) {
      Packet packet;
      {
        std::unique_lock<std::mutex> lock(mutex);
        changed.wait(lock, [&] { return !accepting || count; });
        if (!accepting) break;
        packet = packets[head]; head = (head + 1) % packets.size(); --count;
      }
      OVERLAPPED operation{}; operation.hEvent = completed;
      ResetEvent(completed);
      DWORD written = 0;
      if (!WriteFile(pipe, &packet, sizeof(packet), &written, &operation) && GetLastError() != ERROR_IO_PENDING) { failed = true; break; }
      const HANDLE signals[] = {stop, completed};
      const auto ready = WaitForMultipleObjects(2, signals, FALSE, 1000);
      if (ready != WAIT_OBJECT_0 + 1) {
        CancelIoEx(pipe, &operation);
        GetOverlappedResult(pipe, &operation, &written, TRUE);
        if (ready != WAIT_OBJECT_0) failed = true;
        break;
      }
      if (!GetOverlappedResult(pipe, &operation, &written, FALSE) || written != sizeof(packet)) { failed = true; break; }
      delivered = true;
    }
    if (completed) CloseHandle(completed);
    if (pipe != INVALID_HANDLE_VALUE) CloseHandle(pipe);
  }
};

struct Commands {
  HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  std::string pending;
  bool closed = false;
  bool invalid = false;
  std::string next() {
    if (pending.find('\n') == pending.npos) {
      DWORD available = 0, count = 0;
      if (!PeekNamedPipe(input, nullptr, 0, nullptr, &available, nullptr)) { closed = true; return {}; }
      if (!available) { Sleep(25); return {}; }
      std::array<char, 256> buffer{};
      if (!ReadFile(input, buffer.data(), static_cast<DWORD>(std::min<size_t>(buffer.size(), available)), &count, nullptr)) {
        closed = true; return {};
      }
      pending.append(buffer.data(), count);
    }
    const auto end = pending.find('\n');
    if (end != pending.npos && end >= 256) { invalid = true; return {}; }
    if (end == pending.npos) {
      if (pending.size() >= 256) invalid = true;
      return {};
    }
    auto line = pending.substr(0, end);
    pending.erase(0, end + 1);
    return line;
  }
};

struct SourceRelease { void operator()(obs_source_t *source) const { obs_source_release(source); } };
using Source = std::unique_ptr<obs_source_t, SourceRelease>;
struct CaptureCallback {
  obs_source_t *source;
  AudioPipe &pipe;
  bool attached = true;
  CaptureCallback(obs_source_t *source, AudioPipe &pipe) : source(source), pipe(pipe) {
    obs_source_add_audio_capture_callback(source, AudioPipe::capture, &pipe);
    // 私有来源不进入视频场景；这里只标记使用状态，无数据仍按宿主的有界超时处理。
    obs_source_inc_active(source);
  }
  ~CaptureCallback() { detach(); }
  void detach() {
    if (!attached) return;
    attached = false;
    pipe.shutdown();
    obs_source_remove_audio_capture_callback(source, AudioPipe::capture, &pipe);
    obs_source_dec_active(source);
  }
};

int capture(int argc, wchar_t **argv) {
  if (argc != 7 || !pipe_id(argv[4]) || !argv[6][0] || wcslen(argv[6]) > 1024) return 2;
  Settings settings;
  if (!parse_settings(utf8(argv[5]), settings)) return 2;
  base_set_log_handler(audio_log, nullptr);
  if (!obs_startup("en-US", utf8(argv[3]).c_str(), nullptr)) { event("failed", ",\"code\":\"obsAudioInitFailed\""); return 1; }
  struct Core { ~Core() { obs_shutdown(); } } core;
  if (std::string_view(obs_get_version_string()) != "32.2.2") { event("failed", ",\"code\":\"obsCaptureVersionUnsupported\""); return 1; }
  obs_audio_info format{}; format.samples_per_sec = 48'000; format.speakers = SPEAKERS_MONO;
  if (!obs_reset_audio(&format)) { event("failed", ",\"code\":\"obsAudioInitFailed\""); return 1; }
  obs_module_t *module = nullptr;
  if (obs_open_module(&module, utf8(argv[1]).c_str(), utf8(argv[2]).c_str()) != MODULE_SUCCESS || !obs_init_module(module)) {
    event("failed", ",\"code\":\"microphoneModuleLoadFailed\""); return 1;
  }
  obs_post_load_modules();
  if (!obs_get_latest_input_type_id("wasapi_input_capture")) {
    event("failed", ",\"code\":\"microphoneModuleLoadFailed\""); return 1;
  }
  register_voice_filter();
  obs_data_t *values = obs_data_create();
  obs_data_set_string(values, "device_id", utf8(argv[6]).c_str());
  Source sourceOwner(obs_source_create_private("wasapi_input_capture", "LycanSync microphone", values));
  auto *source = sourceOwner.get();
  obs_data_release(values);
  if (!source) { event("failed", ",\"code\":\"microphoneCaptureStartFailed\""); return 1; }
  calldata_t initial_status;
  calldata_init(&initial_status);
  const bool bound = proc_handler_call(obs_source_get_proc_handler(source), "lycansync_audio_status", &initial_status)
      && calldata_int(&initial_status, "binding_version") == 1;
  calldata_free(&initial_status);
  if (!bound) {
    failure_event("microphoneCaptureStartFailed");
    return 1;
  }
  Source filterOwner(obs_source_create_private("lycansync_voice_processing", "LycanSync voice", nullptr));
  auto *filter = filterOwner.get();
  if (!filter) { event("failed", ",\"code\":\"microphoneProcessingFailed\""); return 1; }
  configure(filter, settings);
  obs_source_filter_add(source, filter);
  obs_source_set_monitoring_type(source, OBS_MONITORING_TYPE_NONE);
  obs_source_set_audio_mixers(source, 0);
  AudioPipe pipe;
  if (!pipe.stop) { event("failed", ",\"code\":\"microphoneCapturePipeFailed\""); return 1; }
  CaptureCallback callback(source, pipe);
  pipe.writer = std::thread([&] { pipe.run(L"\\\\.\\pipe\\lycansync-microphone-audio-" + std::wstring(argv[4])); });
  Commands commands;
  const auto started = Clock::now();
  auto lastAudio = started;
  uint64_t previousFrames = 0;
  bool ready = false;
  std::string failure;
  for (;;) {
    const auto command = commands.next();
    if (commands.invalid) { failure = "invalidMicrophoneCommand"; break; }
    if (command == "stop" || (commands.closed && command.empty())) break;
    if (!command.empty()) {
      const bool statistics = command.starts_with("statistics|");
      const size_t prefix = statistics ? 11 : 10;
      const auto separator = statistics ? command.size() : command.find('|', prefix);
      uint32_t request = 0;
      if ((!statistics && !command.starts_with("configure|")) || separator == command.npos) { failure = "invalidMicrophoneCommand"; break; }
      const auto parsed = std::from_chars(command.data() + prefix, command.data() + separator, request);
      if (parsed.ec != std::errc{} || parsed.ptr != command.data() + separator || !request
          || (!statistics && !parse_settings(std::string_view(command).substr(separator + 1), settings))) { failure = "invalidMicrophoneCommand"; break; }
      if (statistics) {
        uint64_t received, dropped;
        { const std::lock_guard<std::mutex> lock(pipe.mutex); received = pipe.received; dropped = pipe.dropped; }
        calldata_t status;
        calldata_init(&status);
        const bool queried = proc_handler_call(obs_source_get_proc_handler(source), "lycansync_audio_status", &status)
            && calldata_int(&status, "binding_version") == 1;
        if (!queried) { calldata_free(&status); failure = "microphoneModuleLoadFailed"; break; }
        event("statistics", ",\"requestId\":" + std::to_string(request) + ",\"framesReceived\":"
          + std::to_string(received) + ",\"droppedChunks\":" + std::to_string(dropped)
          + ",\"sourceState\":" + std::to_string(calldata_int(&status, "capture_state"))
          + ",\"sourceFrames\":" + std::to_string(calldata_int(&status, "frames_received")));
        calldata_free(&status);
      } else {
        configure(filter, settings);
        event("configured", ",\"requestId\":" + std::to_string(request));
      }
    }
    if (voice_filter_failed()) { failure = "microphoneProcessingFailed"; break; }
    if (pipe.failed) { failure = "microphoneCapturePipeFailed"; break; }
    {
      const std::lock_guard<std::mutex> lock(pipe.mutex);
      if (pipe.received != previousFrames) { previousFrames = pipe.received; lastAudio = Clock::now(); }
    }
    // 静音也有 PCM 块；设备恢复只等待有界时间，不无限保持无声通话。
    if (ready && Clock::now() - lastAudio > std::chrono::seconds(8)) { failure = "microphoneDeviceUnavailable"; break; }
    if (!ready && pipe.delivered) {
      ready = true;
      event("ready", ",\"obsVersion\":\"32.2.2\",\"processing\":\"sonora-0.2.0\",\"sampleRate\":48000,\"channels\":1,\"bitsPerSample\":32,\"nominalChunkMs\":10");
    }
    if (!ready && Clock::now() - started > std::chrono::seconds(10)) { failure = "microphoneCaptureStartTimedOut"; break; }
  }
  // 停止交付后才销毁来源；进程退出确认晚于 OBS 销毁队列回收。
  callback.detach();
  obs_source_remove(source);
  filterOwner.reset();
  sourceOwner.reset();
  obs_wait_for_destroy_queue();
  if (!failure.empty()) { failure_event(failure); return 1; }
  event("stopped");
  return 0;
}
}

int wmain(int argc, wchar_t **argv) {
  const auto apartment = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(apartment)) return 1;
  int result = 1;
  try { result = capture(argc, argv); }
  catch (...) { event("failed", ",\"code\":\"microphoneCaptureFailed\""); }
  CoUninitialize();
  return result;
}
