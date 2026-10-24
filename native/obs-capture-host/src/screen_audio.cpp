#include "screen_audio.h"
#include "screen_audio_pcm.h"

#include <obs-module.h>
#include <callback/calldata.h>
#include <callback/proc.h>
#include <util/windows/win-version.h>
#include <objbase.h>

#include <algorithm>
#include <atomic>
#include <charconv>
#include <chrono>
#include <thread>

namespace {

bool valid_audio_id(std::string_view value) {
  if (value.size() != 36) return false;
  for (size_t index = 0; index < value.size(); ++index) {
    if (index == 8 || index == 13 || index == 18 || index == 23) {
      if (value[index] != '-') return false;
    } else if (!((value[index] >= '0' && value[index] <= '9') || (value[index] >= 'a' && value[index] <= 'f')
        || (value[index] >= 'A' && value[index] <= 'F'))) return false;
  }
  return true;
}

struct SourceStatus {
  int state = 0;
  uint32_t sample_rate = 0;
  uint32_t channels = 0;
  uint64_t packets = 0;
  uint64_t frames = 0;
  uint64_t silent = 0;
};

bool read_source_status(obs_source_t *source, SourceStatus &status) {
  calldata_t result;
  calldata_init(&result);
  const bool queried = proc_handler_call(obs_source_get_proc_handler(source), "lycansync_audio_status", &result);
  const bool valid = queried && calldata_int(&result, "binding_version") == 1;
  if (valid) {
    status.state = static_cast<int>(calldata_int(&result, "capture_state"));
    status.sample_rate = static_cast<uint32_t>(calldata_int(&result, "sample_rate"));
    status.channels = static_cast<uint32_t>(calldata_int(&result, "channels"));
    status.packets = static_cast<uint64_t>(calldata_int(&result, "packets_received"));
    status.frames = static_cast<uint64_t>(calldata_int(&result, "frames_received"));
    status.silent = static_cast<uint64_t>(calldata_int(&result, "silent_packets"));
  }
  calldata_free(&result);
  return valid && status.state >= 0 && status.state <= 2
      && (status.state != 1 || (status.sample_rate >= 8000 && status.sample_rate <= 192000
          && status.channels >= 1 && status.channels <= 8));
}

bool write_packet(HANDLE pipe, HANDLE stop, HANDLE completed, const ScreenAudioPacket &packet) {
  OVERLAPPED operation{};
  operation.hEvent = completed;
  ResetEvent(completed);
  DWORD written = 0;
  if (!WriteFile(pipe, &packet, sizeof(packet), &written, &operation) && GetLastError() != ERROR_IO_PENDING) return false;
  const HANDLE signals[] = {stop, completed};
  const auto ready = WaitForMultipleObjects(2, signals, FALSE, 1000);
  if (ready != WAIT_OBJECT_0 + 1) {
    CancelIoEx(pipe, &operation);
    // OVERLAPPED 与包位于本线程栈上，必须等取消完成才能释放。
    GetOverlappedResult(pipe, &operation, &written, TRUE);
    return false;
  }
  return GetOverlappedResult(pipe, &operation, &written, FALSE) && written == sizeof(packet);
}

}  // namespace

struct ScreenAudioHost::Session {
  std::string id;
  HANDLE stop = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  HANDLE ready = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  ScreenAudioPcmQueue queue;
  std::atomic<bool> done = false;
  std::thread worker;
  mutable std::mutex mutex;
  ScreenAudioSnapshot statistics;

  ~Session() {
    request_stop();
    if (worker.joinable()) worker.join();
    if (ready) CloseHandle(ready);
    if (stop) CloseHandle(stop);
  }

  void request_stop() {
    queue.stop();
    if (stop) SetEvent(stop);
    const std::lock_guard<std::mutex> lock(mutex);
    if (!done) statistics.state = "stopping";
  }

  static void capture(void *parameter, obs_source_t *, const audio_data *audio, bool muted) {
    auto &session = *static_cast<Session *>(parameter);
    if (session.queue.push(reinterpret_cast<const float *>(audio->data[0]),
        reinterpret_cast<const float *>(audio->data[1]), audio->frames, muted)) SetEvent(session.ready);
  }
};

ScreenAudioHost::ScreenAudioHost(std::string module_path, std::string data_path, WindowVideoTarget target,
    bool window, Emit emit)
    : module_path_(std::move(module_path)), data_path_(std::move(data_path)), target_(std::move(target)),
      window_(window), emit_(std::move(emit)) {}

ScreenAudioHost::~ScreenAudioHost() {
  shutdown();
  if (module_apartment_initialized_) CoUninitialize();
}

bool ScreenAudioHost::command(std::string_view command) {
  if (command.starts_with("audioStop:")) {
    const auto id = command.substr(10);
    if (session_ && session_->id == id) {
      session_->request_stop();
      if (session_->done) emit_("audioStopped", id, "", {});
    }
    return true;
  }
  if (!command.starts_with("audioStart:")) return false;
  const auto arguments = command.substr(11);
  const auto separator = arguments.find(':');
  if (separator == std::string_view::npos) return true;
  const auto id = arguments.substr(0, separator);
  const auto mode_and_process = arguments.substr(separator + 1);
  const auto process_separator = mode_and_process.find(':');
  if (!valid_audio_id(id) || process_separator == std::string_view::npos) return true;
  const auto mode = mode_and_process.substr(0, process_separator);
  const auto process_argument = mode_and_process.substr(process_separator + 1);
  DWORD client_process = 0;
  const auto process = std::from_chars(process_argument.data(), process_argument.data() + process_argument.size(), client_process);
  const auto reject = [&](std::string_view code) { emit_("audioFailed", id, code, {}); emit_("audioStopped", id, "", {}); };
  if (process.ec != std::errc{} || process.ptr != process_argument.data() + process_argument.size()
      || !client_process || (mode != "process" && mode != "systemMix")) {
    reject("screenShareAudioUnsupported");
    return true;
  }
  if (session_ && !session_->done) { reject("screenShareAudioAlreadyRunning"); return true; }
  if (session_) { session_->worker.join(); session_.reset(); }
  win_version_info version{};
  get_win_ver(&version);
  const bool process_supported = version.major > 10 || (version.major == 10 && version.build >= 19041);
  if ((mode == "process") != process_supported || version.major < 10 || version.build < 15063) {
    reject("screenShareAudioUnsupported");
    return true;
  }
  uint64_t plugin_load_ms = 0;
  if (!module_loaded_) {
    const auto plugin_started = std::chrono::steady_clock::now();
    // 官方默认设备通知器在加载线程创建 COM 对象，不能只初始化采集线程。
    if (!module_apartment_initialized_) {
      if (FAILED(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED))) { reject("screenShareAudioStartFailed"); return true; }
      module_apartment_initialized_ = true;
    }
    obs_module_t *module = nullptr;
    std::replace(module_path_.begin(), module_path_.end(), '\\', '/');
    if (obs_open_module(&module, module_path_.c_str(), data_path_.c_str()) != MODULE_SUCCESS || !obs_init_module(module)) {
      reject("screenShareAudioStartFailed");
      return true;
    }
    module_loaded_ = true;
    plugin_load_ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - plugin_started).count();
  }
  auto session = std::make_shared<Session>();
  session->id = id;
  session->statistics.state = "starting";
  if (!session->stop || !session->ready) { reject("screenShareAudioStartFailed"); return true; }
  session_ = session;
  session->worker = std::thread([this, session, system_mix = mode == "systemMix", client_process, plugin_load_ms] {
    run(session, system_mix, client_process, plugin_load_ms);
  });
  return true;
}

void ScreenAudioHost::run(const std::shared_ptr<Session> &session, bool system_mix, DWORD client_process, uint64_t plugin_load_ms) {
  const auto capture_started = std::chrono::steady_clock::now();
  const HRESULT apartment = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  HANDLE pipe = INVALID_HANDLE_VALUE;
  HANDLE completed = nullptr;
  obs_source_t *source = nullptr;
  bool callback_added = false;
  std::string failure;
  const auto stopped = [&] { return WaitForSingleObject(session->stop, 0) == WAIT_OBJECT_0; };
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(8);
  do {
    if (FAILED(apartment)) { failure = "screenShareAudioStartFailed"; break; }
    if (stopped()) break;
    const std::wstring pipe_path = L"\\\\.\\pipe\\lycansync-screen-audio-" + std::wstring(session->id.begin(), session->id.end());
    pipe = CreateFileW(pipe_path.c_str(), GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, nullptr);
    completed = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (pipe == INVALID_HANDLE_VALUE || !completed) { failure = "screenShareAudioPipeFailed"; break; }
    if (window_ && !window_video_target_valid(target_)) { failure = "screenShareAudioTargetUnavailable"; break; }
    obs_data_t *settings = obs_data_create();
    if (system_mix) {
      obs_data_set_string(settings, "device_id", "default");
    } else if (window_) {
      std::string property;
      for (const auto character : target_.property_name) property.push_back(static_cast<char>(character));
      obs_data_set_int(settings, "lycansync_window_id", static_cast<long long>(reinterpret_cast<uintptr_t>(target_.window)));
      obs_data_set_string(settings, "lycansync_window_property", property.c_str());
      obs_data_set_int(settings, "lycansync_window_property_value", static_cast<long long>(target_.property_value));
    } else {
      obs_data_set_bool(settings, "lycansync_exclude_process", true);
      obs_data_set_int(settings, "lycansync_process_id", client_process);
    }
    source = obs_source_create_private(system_mix ? "lycansync_system_output_capture" : "lycansync_process_output_capture",
        "LycanSync shared audio", settings);
    obs_data_release(settings);
    if (!source) { failure = "screenShareAudioStartFailed"; break; }
    obs_source_set_monitoring_type(source, OBS_MONITORING_TYPE_NONE);
    obs_source_add_audio_capture_callback(source, Session::capture, session.get());
    callback_added = true;
    bool started = false;
    while (!stopped()) {
      SourceStatus status;
      if (!read_source_status(source, status)) { failure = "screenShareAudioStartFailed"; break; }
      if (window_ && !window_video_target_valid(target_)) { failure = "screenShareAudioTargetUnavailable"; break; }
      {
        const std::lock_guard<std::mutex> lock(session->mutex);
        session->statistics.packets_received = status.packets;
        session->statistics.frames_received = status.frames;
        session->statistics.silent_packets = status.silent;
        if (status.state == 1) {
          session->statistics.sample_rate = status.sample_rate;
          session->statistics.channels = status.channels;
        }
        session->statistics.dropped_chunks = session->queue.dropped();
      }
      if (status.state == 2) { failure = started ? "screenShareAudioFailed" : "screenShareAudioStartFailed"; break; }
      if (!started && status.state == 1) {
        if (!session->queue.start()) break;
        started = true;
        {
          const std::lock_guard<std::mutex> lock(session->mutex);
          if (!stopped()) session->statistics.state = "running";
        }
        // 来源就绪包含管道、来源创建及 Windows 激活，不冒充单个 API 的耗时。
        const auto capture_ready_ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - capture_started).count();
        emit_("audioStarted", session->id, "", {plugin_load_ms, static_cast<uint64_t>(capture_ready_ms)});
      }
      if (!started && std::chrono::steady_clock::now() >= deadline) { failure = "screenShareAudioStartTimedOut"; break; }
      ScreenAudioPacket packet;
      if (started && session->queue.pop(packet)) {
        if (!write_packet(pipe, session->stop, completed, packet)) {
          if (!stopped()) failure = "screenShareAudioPipeFailed";
          break;
        }
      } else {
        const HANDLE signals[] = {session->stop, session->ready};
        WaitForMultipleObjects(2, signals, FALSE, 20);
      }
    }
  } while (false);
  // 先禁止回调交付，再移除回调并销毁来源；阻塞的原生销毁不占用视频命令线程。
  session->request_stop();
  if (!failure.empty()) {
    {
      const std::lock_guard<std::mutex> lock(session->mutex);
      session->statistics.state = "failed";
      session->statistics.last_error = failure;
    }
    emit_("audioFailed", session->id, failure, {});
  }
  if (callback_added) obs_source_remove_audio_capture_callback(source, Session::capture, session.get());
  if (source) { obs_source_remove(source); obs_source_release(source); }
  // libobs 的来源销毁是异步任务，ACK 必须晚于其析构和 WASAPI 线程回收。
  // bool 仅表示等待期间是否处理任务；队列提前清空同样完成清理。
  obs_wait_for_destroy_queue();
  if (pipe != INVALID_HANDLE_VALUE) CloseHandle(pipe);
  if (completed) CloseHandle(completed);
  if (SUCCEEDED(apartment)) CoUninitialize();
  {
    const std::lock_guard<std::mutex> lock(session->mutex);
    session->statistics.state = "idle";
    session->statistics.dropped_chunks = session->queue.dropped();
    session->done = true;
  }
  emit_("audioStopped", session->id, "", {});
}

ScreenAudioSnapshot ScreenAudioHost::snapshot() const {
  if (!session_) return {};
  const std::lock_guard<std::mutex> lock(session_->mutex);
  return session_->statistics;
}

void ScreenAudioHost::shutdown() {
  if (!session_) return;
  session_->request_stop();
  if (session_->worker.joinable()) session_->worker.join();
  session_.reset();
}
