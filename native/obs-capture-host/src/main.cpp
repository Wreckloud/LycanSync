#include <obs.h>
#include <obs-module.h>
#include <graphics/graphics.h>
#include <util/base.h>
#include "window_capture.h"
#include "game_capture.h"
#include "screen_audio.h"
#include "gpu_frame_wait.h"

#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <wrl/client.h>

#include <array>
#include <algorithm>
#include <atomic>
#include <charconv>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <iomanip>
#include <iostream>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>

namespace {

static_assert(LIBOBS_API_VER == MAKE_SEMANTIC_VERSION(32, 2, 2), "OBS 32.2.2 headers are required");

constexpr size_t kTextureSlotCount = 3;
constexpr auto kGpuFenceTimeout = std::chrono::milliseconds(250);
constexpr auto kGpuStallTimeout = std::chrono::seconds(5);

struct TextureSlot {
  Microsoft::WRL::ComPtr<ID3D11Texture2D> d3d_texture;
  Microsoft::WRL::ComPtr<IDXGIKeyedMutex> keyed_mutex;
  Microsoft::WRL::ComPtr<ID3D11Query> gpu_ready;
  HANDLE shared_handle = nullptr;
  bool busy = false;
  bool gpu_pending = false;
  std::chrono::steady_clock::time_point gpu_pending_since;
};

struct HostState {
  std::array<TextureSlot, kTextureSlotCount> slots;
  std::string session_id;
  std::string helper_version;
  std::chrono::steady_clock::time_point started_at = std::chrono::steady_clock::now();
  uint64_t rendered_frames = 0;
  uint64_t frame_count = 0;
  uint64_t dropped_frames = 0;
  bool textures_initialized = false;
  bool texture_setup_failed = false;
  bool window_source = false;
  bool game_source = false;
  const char *capture_method = "dxgi";
  std::string requested_method = "auto";
  bool border_allowed = false;
  const char *window_fallback_reason = nullptr;
  bool gpu_wait_reported = false;
  size_t next_slot = 0;
  std::optional<std::chrono::steady_clock::time_point> mutex_wait_started;
  WindowVideoTarget window_target;
  bool suspended = false;
  bool configuration_paused = false;
  bool rendering_reported = false;
  bool source_ready_reported = false;
  uint32_t render_configuration = 0;
  std::chrono::steady_clock::time_point render_statistics_started_at;
  uint32_t output_width = 1920;
  uint32_t output_height = 1080;
  uint32_t content_width = 0;
  uint32_t content_height = 0;
};

HostState g_host;
std::mutex g_slot_mutex;
std::mutex g_output_mutex;
std::mutex g_render_mutex;
std::mutex g_log_mutex;
uint32_t g_adapter_index = 0;
std::atomic<bool> g_dxgi_failure_reported{false};
std::atomic<int> g_dxgi_api{0};

void obs_log_handler(int level, const char *format, va_list args, void *) {
  // libobs 默认会向 stdout 写普通日志；协议通道只能包含本宿主的 JSON。
  const std::string_view log_format(format);
  if (log_format == "lycansyncDxgiApi:DuplicateOutput" || log_format == "lycansyncDxgiApi:DuplicateOutput1") {
    if (g_dxgi_api.exchange(log_format.ends_with("1") ? 1 : 2) == 0) {
      const std::lock_guard<std::mutex> lock(g_log_mutex);
      std::cerr << format << '\n';
    }
    return;
  }
  const bool duplicator_failure = std::string_view(format).starts_with("device_duplicator_create:");
  if (level > LOG_WARNING && !duplicator_failure) return;
  std::array<char, 2000> message{};
  std::vsnprintf(message.data(), message.size(), format, args);
  if (duplicator_failure) {
    if (g_dxgi_failure_reported.exchange(true)) return;
    unsigned long code = 0;
    const auto *details = std::strrchr(message.data(), '(');
    const std::lock_guard<std::mutex> lock(g_log_mutex);
    if (details && std::sscanf(details, "(%8lx)", &code) == 1) {
      std::cerr << "dxgiDuplicatorCreateFailed: 0x" << std::hex << code << std::dec << '\n';
    } else std::cerr << "dxgiDuplicatorCreateFailed\n";
    return;
  }
  const std::lock_guard<std::mutex> lock(g_log_mutex);
  std::cerr << message.data() << '\n';
}

void write_event(std::string_view event) {
  const std::lock_guard<std::mutex> lock(g_output_mutex);
  std::cout << "{\"event\":\"" << event << "\"";
  if (event == "captureTargetClosed") std::cout << ",\"sessionId\":\"" << g_host.session_id << "\"";
  std::cout << "}\n";
  std::cout.flush();
}

void write_capture_evidence(std::string_view stage, uint32_t width = 0, uint32_t height = 0) {
  const std::lock_guard<std::mutex> lock(g_output_mutex);
  std::cout << "{\"event\":\"captureEvidence\",\"sessionId\":\"" << g_host.session_id
            << "\",\"stage\":\"" << stage << "\",\"captureMethod\":\""
            << g_host.capture_method
            << "\",\"adapterIndex\":" << g_adapter_index << ",\"sourceWidth\":" << width
            << ",\"sourceHeight\":" << height;
  if (g_host.window_source) {
    std::cout << ",\"requestedMethod\":\"" << g_host.requested_method << "\",\"borderAllowed\":"
              << (g_host.border_allowed ? "true" : "false") << ",\"clientArea\":"
              << (g_host.game_source ? "false" : "true");
    if (g_host.window_fallback_reason) std::cout << ",\"windowFallbackReason\":\"" << g_host.window_fallback_reason << "\"";
  }
  if (!g_host.window_source) std::cout << ",\"adapterMatched\":true";
  const int dxgi_api = g_dxgi_api.load();
  if (!g_host.window_source && dxgi_api) {
    std::cout << ",\"captureApi\":\"" << (dxgi_api == 1 ? "DuplicateOutput1" : "DuplicateOutput") << "\"";
  }
  std::cout << "}\n";
  std::cout.flush();
}

void write_capture_preparation(std::string_view stage, std::string_view session_id) {
  const std::lock_guard<std::mutex> lock(g_output_mutex);
  std::cout << "{\"event\":\"capturePreparation\",\"sessionId\":\"" << session_id
            << "\",\"stage\":\"" << stage << "\"}\n";
  std::cout.flush();
}

void write_started_event() {
  const std::lock_guard<std::mutex> lock(g_output_mutex);
  std::cout << "{\"event\":\"captureStarted\",\"sessionId\":\"" << g_host.session_id
            << "\",\"helperVersion\":\"" << g_host.helper_version << "\"}\n";
  std::cout.flush();
}

void reset_render_statistics() {
  ++g_host.render_configuration;
  g_host.render_statistics_started_at = std::chrono::steady_clock::now();
}

void write_diagnostics_event(std::string_view request_id, const ScreenAudioSnapshot &audio) {
  const std::lock_guard<std::mutex> render_lock(g_render_mutex);
  const std::lock_guard<std::mutex> output_lock(g_output_mutex);
  const auto render_elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now() - g_host.render_statistics_started_at).count();
  // OBS 均值约每秒更新；重设画布后先隔开旧均值，不把待机或旧画质算进新共享。
  const bool render_statistics_ready = !g_host.configuration_paused && render_elapsed_ms >= 2000;
  std::cout << "{\"event\":\"diagnostics\",\"requestId\":\"" << request_id
            << "\",\"sessionId\":\"" << g_host.session_id << "\",\"renderedFrames\":"
            << g_host.rendered_frames << ",\"bridgeFrames\":" << g_host.frame_count
            << ",\"bridgeDroppedFrames\":" << g_host.dropped_frames
            << ",\"obsRender\":{\"configuration\":" << g_host.render_configuration
            << ",\"elapsedMs\":" << render_elapsed_ms << ",\"totalFrames\":" << obs_get_total_frames()
            << ",\"laggedFrames\":" << obs_get_lagged_frames() << ",\"activeFps\":"
            << (render_statistics_ready ? std::to_string(obs_get_active_fps()) : "null")
            << ",\"averageRenderMs\":"
            << (render_statistics_ready ? std::to_string(obs_get_average_frame_time_ns() / 1'000'000.0) : "null")
            << "},\"screenShareAudio\":{\"state\":\"" << audio.state << "\",\"sampleRate\":"
            << (audio.sample_rate ? std::to_string(audio.sample_rate) : "null") << ",\"channels\":"
            << (audio.channels ? std::to_string(audio.channels) : "null")
            << ",\"packetsReceived\":" << audio.packets_received << ",\"framesReceived\":" << audio.frames_received
            << ",\"silentPackets\":" << audio.silent_packets << ",\"droppedAudioChunks\":" << audio.dropped_chunks
            << ",\"lastError\":" << (audio.last_error.empty() ? "null" : "\"" + audio.last_error + "\"") << "}}\n";
  std::cout.flush();
}

void write_frame_event(size_t slot_index, const TextureSlot &slot, uint64_t timestamp_micros) {
  const auto handle = reinterpret_cast<uintptr_t>(slot.shared_handle);
  const std::lock_guard<std::mutex> lock(g_output_mutex);
  std::cout << "{\"event\":\"sharedTextureFrame\",\"sessionId\":\"" << g_host.session_id
            << "\",\"slotIndex\":" << slot_index << ",\"sourceHandleHex\":\"" << std::hex
            << std::setw(16) << std::setfill('0') << handle << std::dec << "\",\"pixelFormat\":\"bgra\",\"codedSize\":{\"width\":"
            << g_host.output_width << ",\"height\":" << g_host.output_height
            << "},\"contentSize\":{\"width\":" << g_host.content_width << ",\"height\":"
            << g_host.content_height << "},\"timestampMicros\":" << timestamp_micros
            << ",\"renderedFrames\":" << g_host.rendered_frames
            << ",\"bridgeFrames\":" << g_host.frame_count << ",\"bridgeDroppedFrames\":"
            << g_host.dropped_frames << "}\n";
  std::cout.flush();
}

bool gpu_operation_succeeded(HRESULT result, const char *stage) {
  if (result == S_OK) return true;
  const std::lock_guard<std::mutex> lock(g_log_mutex);
  std::cerr << stage << " failed: 0x" << std::hex << std::setw(8) << std::setfill('0')
            << static_cast<uint32_t>(result) << std::dec << '\n';
  return false;
}

bool create_texture_slot(TextureSlot &slot, ID3D11Device *device) {
  const D3D11_TEXTURE2D_DESC description{
      .Width = g_host.output_width,
      .Height = g_host.output_height,
      .MipLevels = 1,
      .ArraySize = 1,
      .Format = DXGI_FORMAT_B8G8R8A8_UNORM,
      .SampleDesc = {1, 0},
      .Usage = D3D11_USAGE_DEFAULT,
      .BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE,
      .CPUAccessFlags = 0,
      .MiscFlags = D3D11_RESOURCE_MISC_SHARED_NTHANDLE | D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX,
  };
  if (!gpu_operation_succeeded(device->CreateTexture2D(&description, nullptr, &slot.d3d_texture), "createTexture")) return false;
  if (!gpu_operation_succeeded(slot.d3d_texture.As(&slot.keyed_mutex), "queryKeyedMutex")) return false;

  Microsoft::WRL::ComPtr<IDXGIResource1> resource;
  if (!gpu_operation_succeeded(slot.d3d_texture.As(&resource), "querySharedResource")) return false;
  if (!gpu_operation_succeeded(resource->CreateSharedHandle(nullptr, DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE,
                                                           nullptr, &slot.shared_handle), "createSharedHandle")) {
    return false;
  }

  const D3D11_QUERY_DESC query_description{D3D11_QUERY_EVENT, 0};
  return gpu_operation_succeeded(device->CreateQuery(&query_description, &slot.gpu_ready), "createGpuQuery");
}

bool initialize_textures() {
  if (gs_get_device_type() != GS_DEVICE_DIRECT3D_11) return false;
  auto *device = static_cast<ID3D11Device *>(gs_get_device_obj());
  if (!device) return false;
  for (auto &slot : g_host.slots) {
    if (!create_texture_slot(slot, device)) return false;
  }
  g_host.textures_initialized = true;
  return true;
}

void record_gpu_wait_timeout() {
  ++g_host.dropped_frames;
  if (!g_host.gpu_wait_reported) {
    g_host.gpu_wait_reported = true;
    write_capture_evidence("gpuDelayed");
  }
}

bool retire_pending_gpu_copies(ID3D11DeviceContext *context, ID3D11Device *device) {
  for (auto &slot : g_host.slots) {
    if (!slot.gpu_pending) continue;
    const HRESULT result = context->GetData(slot.gpu_ready.Get(), nullptr, 0, D3D11_ASYNC_GETDATA_DONOTFLUSH);
    if (result == S_OK) slot.gpu_pending = false;
    else if (result != S_FALSE) {
      gpu_operation_succeeded(result, "gpuQuery");
      gpu_operation_succeeded(device->GetDeviceRemovedReason(), "gpuDevice");
      g_host.texture_setup_failed = true;
      write_event("sharedTextureGpuWaitFailed");
      return false;
    } else if (std::chrono::steady_clock::now() - slot.gpu_pending_since >= kGpuStallTimeout) {
      g_host.texture_setup_failed = true;
      write_event("sharedTextureGpuStalled");
      return false;
    }
  }
  return true;
}

void release_busy_slot(size_t slot_index) {
  const std::lock_guard<std::mutex> lock(g_slot_mutex);
  if (slot_index < g_host.slots.size()) g_host.slots[slot_index].busy = false;
}

bool window_delivery_allowed(obs_source_t *source) {
  if (!g_host.window_source) return true;
  const char *failure = g_host.game_source ? game_video_failure(source, g_host.window_target)
      : window_video_failure(source, g_host.window_target);
  if (failure) {
    g_host.texture_setup_failed = true;
    write_event(failure);
    return false;
  }
  const bool suspended = g_host.game_source
      ? IsIconic(g_host.window_target.window) || !IsWindowVisible(g_host.window_target.window)
      : window_video_suspended(g_host.window_target);
  if (suspended != g_host.suspended) {
    g_host.suspended = suspended;
    const std::lock_guard<std::mutex> lock(g_output_mutex);
    std::cout << "{\"event\":\"captureSuspended\",\"sessionId\":\"" << g_host.session_id
              << "\",\"suspended\":" << (suspended ? "true" : "false") << "}\n";
    std::cout.flush();
  }
  return !suspended;
}

void render_shared_frame(void *parameter) {
  const std::lock_guard<std::mutex> render_lock(g_render_mutex);
  if (g_host.texture_setup_failed || g_host.configuration_paused) return;
  ++g_host.rendered_frames;
  auto *capture_source = static_cast<obs_source_t *>(parameter);
  if (!window_delivery_allowed(capture_source)) return;
  // 初始化时主画布已能渲染，但来源尚未就绪，不能把空画布计作首帧交付。
  const auto source_width = obs_source_get_width(capture_source);
  const auto source_height = obs_source_get_height(capture_source);
  if (!g_host.rendering_reported) {
    g_host.rendering_reported = true;
    write_capture_evidence("rendering", source_width, source_height);
  }
  if (!source_width || !source_height) return;
  if (!g_host.source_ready_reported) {
    g_host.source_ready_reported = true;
    write_capture_evidence("sourceReady", source_width, source_height);
  }
  const auto scale = std::min({1.0, static_cast<double>(g_host.output_width) / source_width,
      static_cast<double>(g_host.output_height) / source_height});
  g_host.content_width = std::max(1u, static_cast<uint32_t>(source_width * scale));
  g_host.content_height = std::max(1u, static_cast<uint32_t>(source_height * scale));
  if (!g_host.textures_initialized && !initialize_textures()) {
    g_host.texture_setup_failed = true;
    write_event("sharedTextureUnavailable");
    return;
  }

  auto *device = static_cast<ID3D11Device *>(gs_get_device_obj());
  Microsoft::WRL::ComPtr<ID3D11DeviceContext> context;
  if (device) device->GetImmediateContext(&context);
  if (!device || !context) {
    g_host.texture_setup_failed = true;
    write_event("sharedTextureDeviceUnavailable");
    return;
  }
  if (!retire_pending_gpu_copies(context.Get(), device)) return;
  size_t slot_index = kTextureSlotCount;
  {
    const std::lock_guard<std::mutex> lock(g_slot_mutex);
    for (size_t offset = 0; offset < g_host.slots.size(); ++offset) {
      const size_t index = (g_host.next_slot + offset) % g_host.slots.size();
      if (!g_host.slots[index].busy && !g_host.slots[index].gpu_pending) {
        slot_index = index;
        g_host.slots[index].busy = true;
        g_host.next_slot = (index + 1) % g_host.slots.size();
        break;
      }
    }
  }
  if (slot_index == kTextureSlotCount) {
    ++g_host.dropped_frames;
    return;
  }

  auto &slot = g_host.slots[slot_index];
  gs_texture_t *rendered_texture = obs_get_main_texture();
  auto *source = rendered_texture ? static_cast<ID3D11Texture2D *>(gs_texture_get_obj(rendered_texture)) : nullptr;
  D3D11_TEXTURE2D_DESC source_description{};
  if (source) source->GetDesc(&source_description);
  const bool bgra_format = source_description.Format == DXGI_FORMAT_B8G8R8A8_UNORM
                       || source_description.Format == DXGI_FORMAT_B8G8R8A8_TYPELESS;
  if (!context || !source || source_description.Width != g_host.output_width || source_description.Height != g_host.output_height || !bgra_format) {
    std::fprintf(stderr, "mainTexture context=%d source=%d size=%ux%u format=%u\n",
                 context != nullptr, source != nullptr, source_description.Width, source_description.Height, source_description.Format);
    release_busy_slot(slot_index);
    g_host.texture_setup_failed = true;
    write_event("sharedTextureSourceInvalid");
    return;
  }
  const HRESULT acquired = slot.keyed_mutex->AcquireSync(0, 0);
  if (acquired == WAIT_TIMEOUT) {
    release_busy_slot(slot_index);
    const auto now = std::chrono::steady_clock::now();
    if (!g_host.mutex_wait_started) g_host.mutex_wait_started = now;
    if (now - *g_host.mutex_wait_started >= kGpuStallTimeout) {
      g_host.texture_setup_failed = true;
      write_event("sharedTextureGpuStalled");
      return;
    }
    record_gpu_wait_timeout();
    return;
  }
  if (!gpu_operation_succeeded(acquired, "acquireTexture")) {
    release_busy_slot(slot_index);
    g_host.texture_setup_failed = true;
    write_event("sharedTextureAcquireFailed");
    return;
  }
  g_host.mutex_wait_started.reset();
  // 直接复制 OBS 已渲染的主纹理；wrap_obj 不会把外部纹理变成可绘制目标。
  context->CopyResource(slot.d3d_texture.Get(), source);
  const HRESULT gpu_ready = wait_for_gpu_frame(context.Get(), slot.gpu_ready.Get(), kGpuFenceTimeout);
  // GPU 完成且互斥量归还后才交付，消费者释放全部引用后再复用此槽。
  const bool mutex_released = gpu_operation_succeeded(slot.keyed_mutex->ReleaseSync(0), "releaseTexture");
  if (!mutex_released) {
    release_busy_slot(slot_index);
    g_host.texture_setup_failed = true;
    write_event("sharedTextureReleaseFailed");
    return;
  }
  if (gpu_ready == S_FALSE) {
    // 该帧未交付；查询完成前保留此槽，不能重写纹理或覆盖仍在执行的查询。
    slot.gpu_pending = true;
    slot.gpu_pending_since = std::chrono::steady_clock::now();
    release_busy_slot(slot_index);
    record_gpu_wait_timeout();
    return;
  }
  if (!gpu_operation_succeeded(gpu_ready, "gpuQuery")) {
    gpu_operation_succeeded(device->GetDeviceRemovedReason(), "gpuDevice");
    release_busy_slot(slot_index);
    g_host.texture_setup_failed = true;
    write_event("sharedTextureGpuWaitFailed");
    return;
  }
  // 复制期间也可能关闭或最小化；交付前复核，绝不按旧 HWND 接管另一个窗口。
  if (!window_delivery_allowed(capture_source)) {
    release_busy_slot(slot_index);
    return;
  }

  const auto elapsed = std::chrono::steady_clock::now() - g_host.started_at;
  const auto timestamp_micros = std::chrono::duration_cast<std::chrono::microseconds>(elapsed).count();
  ++g_host.frame_count;
  write_frame_event(slot_index, slot, static_cast<uint64_t>(timestamp_micros));
}

struct MonitorLookup {
  std::wstring_view expected_name;
  bool found = false;
};

BOOL CALLBACK find_monitor(HMONITOR monitor, HDC, LPRECT, LPARAM parameter) {
  auto *lookup = reinterpret_cast<MonitorLookup *>(parameter);
  MONITORINFOEXW info{};
  info.cbSize = sizeof(info);
  if (!GetMonitorInfoW(monitor, &info)) return TRUE;
  lookup->found = CompareStringOrdinal(info.szDevice, -1, lookup->expected_name.data(),
                                      static_cast<int>(lookup->expected_name.size()), TRUE) == CSTR_EQUAL;
  return lookup->found ? FALSE : TRUE;
}

bool monitor_exists(std::wstring_view expected_name) {
  if (expected_name.empty() || expected_name.size() > 256) return false;
  MonitorLookup lookup{.expected_name = expected_name};
  EnumDisplayMonitors(nullptr, nullptr, find_monitor, reinterpret_cast<LPARAM>(&lookup));
  return lookup.found;
}

struct MonitorAdapter {
  uint32_t index;
  LUID luid;
  HMONITOR monitor;
};

std::optional<MonitorAdapter> find_monitor_adapter(std::wstring_view name) {
  Microsoft::WRL::ComPtr<IDXGIFactory1> factory;
  if (!gpu_operation_succeeded(CreateDXGIFactory1(IID_PPV_ARGS(&factory)), "dxgiFactory")) return std::nullopt;
  for (UINT index = 0; index < 64; ++index) {
    Microsoft::WRL::ComPtr<IDXGIAdapter1> adapter;
    if (factory->EnumAdapters1(index, &adapter) != S_OK) break;
    DXGI_ADAPTER_DESC1 adapter_info{};
    if (adapter->GetDesc1(&adapter_info) != S_OK || (adapter_info.Flags & DXGI_ADAPTER_FLAG_SOFTWARE)) continue;
    for (UINT output_index = 0; ; ++output_index) {
      Microsoft::WRL::ComPtr<IDXGIOutput> output;
      if (adapter->EnumOutputs(output_index, &output) != S_OK) break;
      DXGI_OUTPUT_DESC output_info{};
      if (output->GetDesc(&output_info) != S_OK || !output_info.AttachedToDesktop) continue;
      if (CompareStringOrdinal(output_info.DeviceName, -1, name.data(), static_cast<int>(name.size()), TRUE) == CSTR_EQUAL) {
        return MonitorAdapter{index, adapter_info.AdapterLuid, output_info.Monitor};
      }
    }
  }
  return std::nullopt;
}

bool graphics_matches_monitor(const MonitorAdapter &target) {
  obs_enter_graphics();
  auto *device = static_cast<ID3D11Device *>(gs_get_device_obj());
  Microsoft::WRL::ComPtr<IDXGIDevice> dxgi_device;
  Microsoft::WRL::ComPtr<IDXGIAdapter> adapter;
  DXGI_ADAPTER_DESC description{};
  const bool matched = device && SUCCEEDED(device->QueryInterface(IID_PPV_ARGS(&dxgi_device)))
      && SUCCEEDED(dxgi_device->GetAdapter(&adapter)) && SUCCEEDED(adapter->GetDesc(&description))
      && description.AdapterLuid.HighPart == target.luid.HighPart && description.AdapterLuid.LowPart == target.luid.LowPart
      && gs_duplicator_get_monitor_index(target.monitor) >= 0;
  obs_leave_graphics();
  return matched;
}

std::string to_utf8(std::wstring_view value) {
  const int length = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
                                         static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  if (length <= 0) return {};
  std::string result(static_cast<size_t>(length), '\0');
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()),
                          result.data(), length, nullptr, nullptr) != length) {
    return {};
  }
  return result;
}

bool valid_session_id(std::string_view value) {
  return !value.empty() && value.size() <= 64
      && std::all_of(value.begin(), value.end(), [](unsigned char character) {
           return (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z')
               || (character >= '0' && character <= '9') || character == '-';
         });
}

bool parse_release_command(std::string_view command, size_t &slot_index) {
  const std::string prefix = "release:" + g_host.session_id + ":";
  if (!command.starts_with(prefix)) return false;
  const auto value = command.substr(prefix.size());
  const auto result = std::from_chars(value.data(), value.data() + value.size(), slot_index);
  return result.ec == std::errc{} && result.ptr == value.data() + value.size()
      && slot_index < kTextureSlotCount;
}

bool parse_diagnostics_command(std::string_view command, std::string_view &request_id) {
  constexpr std::string_view prefix = "diagnostics:";
  if (!command.starts_with(prefix)) return false;
  request_id = command.substr(prefix.size());
  return !request_id.empty() && request_id.size() <= 16
      && std::all_of(request_id.begin(), request_id.end(), [](unsigned char character) {
           return character >= '0' && character <= '9';
         });
}

bool valid_frame_rate(uint32_t frame_rate) {
  return frame_rate == 30 || frame_rate == 60 || frame_rate == 120;
}

bool valid_resolution(uint32_t width, uint32_t height) {
  return (height == 720 || height == 1080 || height == 1440) && width == height * 16 / 9;
}

bool parse_configure_command(std::string_view command, std::string_view &request_id, uint32_t &frame_rate,
    uint32_t &width, uint32_t &height) {
  constexpr std::string_view prefix = "configure:";
  if (!command.starts_with(prefix)) return false;
  const auto values = command.substr(prefix.size());
  const auto separator = values.find(':');
  if (separator == std::string_view::npos) return false;
  request_id = values.substr(0, separator);
  if (request_id.empty() || request_id.size() > 16
      || !std::all_of(request_id.begin(), request_id.end(), [](char digit) { return digit >= '0' && digit <= '9'; })) return false;
  auto remaining = values.substr(separator + 1);
  for (auto *number : {&frame_rate, &width, &height}) {
    const auto end = remaining.find(':');
    const auto value = remaining.substr(0, end);
    const auto parsed = std::from_chars(value.data(), value.data() + value.size(), *number);
    if (parsed.ec != std::errc{} || parsed.ptr != value.data() + value.size()) return false;
    if (number == &height) {
      if (end != std::string_view::npos) return false;
    } else {
      if (end == std::string_view::npos) return false;
      remaining.remove_prefix(end + 1);
    }
  }
  return valid_frame_rate(frame_rate) && valid_resolution(width, height);
}

void destroy_textures();

bool configure_video(obs_video_info &video, obs_sceneitem_t *item, std::string_view request_id,
    uint32_t frame_rate, uint32_t width, uint32_t height) {
  bool accepted = true;
  if (video.fps_num != frame_rate || video.base_width != width || video.base_height != height) {
    // 此时三个槽位均已归还，才能销毁旧纹理；来源、声音及房间身份保持不变。
    const bool resize = video.base_width != width || video.base_height != height;
    // 只改帧率保留同设备、同尺寸的纹理槽，减少缩略图与高清切换时的分配。
    if (resize) destroy_textures();
    auto next = video;
    next.fps_num = frame_rate;
    next.base_width = next.output_width = width;
    next.base_height = next.output_height = height;
    accepted = obs_reset_video(&next) == OBS_VIDEO_SUCCESS;
    if (accepted && resize) {
      g_host.output_width = width;
      g_host.output_height = height;
      obs_enter_graphics();
      accepted = initialize_textures();
      obs_leave_graphics();
    }
    if (accepted) video = next;
    else {
      if (resize) destroy_textures();
      if (obs_reset_video(&video) != OBS_VIDEO_SUCCESS) {
        write_event("obsCaptureConfigurationRollbackFailed");
        return false;
      }
      g_host.output_width = video.base_width;
      g_host.output_height = video.base_height;
      if (resize) {
        obs_enter_graphics();
        const bool restored = initialize_textures();
        obs_leave_graphics();
        if (!restored) { write_event("obsCaptureConfigurationRollbackFailed"); return false; }
      }
    }
    const vec2 bounds{static_cast<float>(video.base_width), static_cast<float>(video.base_height)};
    obs_sceneitem_set_bounds(item, &bounds);
    reset_render_statistics();
  }
  const std::lock_guard<std::mutex> output_lock(g_output_mutex);
  std::cout << "{\"event\":\"" << (accepted ? "captureConfigured" : "captureConfigurationRejected")
            << "\",\"requestId\":\"" << request_id << "\",\"sessionId\":\"" << g_host.session_id
            << "\",\"maxFps\":" << video.fps_num << ",\"width\":" << video.base_width
            << ",\"height\":" << video.base_height << "}\n";
  std::cout.flush();
  return true;
}

void destroy_textures() {
  obs_enter_graphics();
  for (auto &slot : g_host.slots) {
    if (slot.shared_handle) {
      CloseHandle(slot.shared_handle);
      slot.shared_handle = nullptr;
    }
    slot.gpu_ready.Reset();
    slot.keyed_mutex.Reset();
    slot.d3d_texture.Reset();
  }
  obs_leave_graphics();
  g_host.textures_initialized = false;
}

}  // namespace

int capture(const std::array<std::string, 12> &arguments, const std::filesystem::path &module_path,
    const std::filesystem::path &data_path, obs_video_info &video) {
  // 目录只在启动时接收；采集命令只允许有界 ASCII 来源身份，不能指定插件或执行路径。
  const auto wide = [&](size_t index) { return std::wstring(arguments[index].begin(), arguments[index].end()); };
  const std::string_view source_kind(arguments[0]);
  const bool game_source = source_kind == "game";
  const bool window_source = source_kind == "window" || game_source;
  const std::string &session_id = arguments[4];
  const std::string &frame_rate_argument = arguments[5];
  uint32_t frame_rate = 0;
  const auto parsed_frame_rate = std::from_chars(frame_rate_argument.data(), frame_rate_argument.data() + frame_rate_argument.size(), frame_rate);
  const auto &width_argument = arguments[8];
  const auto &height_argument = arguments[9];
  uint32_t width = 0, height = 0;
  const auto parsed_width = std::from_chars(width_argument.data(), width_argument.data() + width_argument.size(), width);
  const auto parsed_height = std::from_chars(height_argument.data(), height_argument.data() + height_argument.size(), height);
  const std::string_view capture_cursor_argument(arguments[2]);
  const std::string_view hide_border_argument(arguments[3]);
  const std::string_view window_method(arguments[10]);
  if (capture_cursor_argument.size() != 1
      || (capture_cursor_argument[0] != '0' && capture_cursor_argument[0] != '1')
      || (hide_border_argument != "0" && hide_border_argument != "1")
      || (window_method != "auto" && window_method != "game" && window_method != "bitblt" && window_method != "wgc")
      || (source_kind == "monitor" && window_method != "auto")
      || (source_kind == "window" && window_method == "game")
      || (source_kind == "game" && window_method != "auto" && window_method != "game")
      || (source_kind != "monitor" && !window_source)
      || !valid_session_id(session_id)
      || parsed_frame_rate.ec != std::errc{} || parsed_frame_rate.ptr != frame_rate_argument.data() + frame_rate_argument.size()
      || !valid_frame_rate(frame_rate)
      || parsed_width.ec != std::errc{} || parsed_width.ptr != width_argument.data() + width_argument.size()
      || parsed_height.ec != std::errc{} || parsed_height.ptr != height_argument.data() + height_argument.size()
      || !valid_resolution(width, height)
      || (!window_source && !monitor_exists(wide(1)))) {
    write_event("invalidCaptureArguments");
    return 2;
  }
  g_host = HostState{};
  g_host.helper_version = obs_get_version_string();
  g_host.session_id = session_id;
  g_host.output_width = width;
  g_host.output_height = height;
  g_host.window_source = window_source;
  g_host.game_source = game_source;
  g_host.capture_method = game_source ? "game" : "dxgi";
  g_host.requested_method = window_method;
  g_host.border_allowed = window_source && !game_source && hide_border_argument == "0";
  WindowVideoTarget window_target;
  if (window_source) {
    const auto parse_pointer = [](const std::wstring_view argument, uintptr_t &value) {
      const auto text = to_utf8(argument);
      const auto result = std::from_chars(text.data(), text.data() + text.size(), value);
      return result.ec == std::errc{} && result.ptr == text.data() + text.size() && value != 0;
    };
    uintptr_t window_handle = 0;
    uintptr_t process_id = 0;
    window_target.lifetime_name = arguments[6];
    window_target.process_creation = arguments[11];
    if (!parse_pointer(wide(1), window_handle) || !parse_pointer(wide(7), process_id)
        || process_id > MAXDWORD || !window_target.lifetime_name.starts_with("Local\\LycanSync.WindowLifetime.")
        || window_target.lifetime_name.size() > 128) {
      write_event("invalidCaptureArguments");
      return 2;
    }
    window_target.window = reinterpret_cast<HWND>(window_handle);
    window_target.process_id = static_cast<DWORD>(process_id);
    if (!bind_window_video_target(window_target)) { write_event("captureTargetClosed"); return 2; }
    g_host.window_target = window_target;
  }

  video.fps_num = frame_rate;
  video.fps_den = 1;
  video.base_width = g_host.output_width;
  video.base_height = g_host.output_height;
  video.output_width = g_host.output_width;
  video.output_height = g_host.output_height;
  video.output_format = VIDEO_FORMAT_BGRA;
  video.gpu_conversion = true;
  video.colorspace = VIDEO_CS_SRGB;
  video.range = VIDEO_RANGE_PARTIAL;
  video.scale_type = OBS_SCALE_BICUBIC;
  if (obs_reset_video(&video) != OBS_VIDEO_SUCCESS) {
    write_event("obsVideoInitFailed");
    return 1;
  }
  reset_render_statistics();
  write_capture_preparation("sourceStarting", g_host.session_id);

  obs_source_t *source = nullptr;
  const char *source_error = "obsDisplaySourceUnavailable";
  if (game_source) {
    source = create_game_video_source(window_target, capture_cursor_argument == "0", source_error);
  } else if (window_source) {
    source = create_window_video_source(window_target, capture_cursor_argument == "0",
        hide_border_argument == "1", window_method, source_error, g_host.window_fallback_reason);
    if (source) g_host.capture_method = window_video_method(source);
  } else {
    obs_data_t *settings = obs_data_create();
    // 来源 ID 的尾号不是系统显示器序号；固定版本按设备名匹配 monitor_id。
    const std::string &monitor_name = arguments[1];
    obs_data_set_string(settings, "monitor_id", monitor_name.c_str());
    // 固定版本的 METHOD_DXGI=1；不让自动选择切到可能带黄框的 WGC。
    obs_data_set_int(settings, "method", 1);
    obs_data_set_bool(settings, "capture_cursor", capture_cursor_argument[0] == '1');
    source = obs_source_create("monitor_capture", "LycanSync display", settings, nullptr);
    obs_data_release(settings);
  }
  if (!source) {
    write_event(source_error);
    return 1;
  }

  obs_scene_t *scene = obs_scene_create("LycanSync capture");
  if (!scene) {
    obs_source_release(source);
    write_event("obsSceneUnavailable");
    return 1;
  }
  obs_sceneitem_t *item = obs_scene_add(scene, source);
  if (!item) {
    obs_source_remove(obs_scene_get_source(scene));
    obs_scene_release(scene);
    obs_source_release(source);
    write_event("obsDisplaySceneAddFailed");
    return 1;
  }
  obs_transform_info transform{};
  transform.pos = {0.0f, 0.0f};
  transform.scale = {1.0f, 1.0f};
  transform.alignment = OBS_ALIGN_TOP | OBS_ALIGN_LEFT;
  transform.bounds_type = OBS_BOUNDS_MAX_ONLY;
  transform.bounds_alignment = OBS_ALIGN_TOP | OBS_ALIGN_LEFT;
  transform.bounds = {static_cast<float>(g_host.output_width), static_cast<float>(g_host.output_height)};
  obs_sceneitem_set_info2(item, &transform);
  // scene 持有 add 返回的元素，此处没有额外引用需要释放。
  obs_set_output_source(0, obs_scene_get_source(scene));
  obs_add_main_rendered_callback(render_shared_frame, source);
  write_capture_evidence("configured");
  write_started_event();

  const auto audio_module = module_path.parent_path() / L"win-wasapi.dll";
  auto capture_data = data_path.lexically_normal();
  if (capture_data.filename().empty()) capture_data = capture_data.parent_path();
  const auto audio_data = capture_data.parent_path() / L"win-wasapi";
  ScreenAudioHost screen_audio(to_utf8(audio_module.wstring()), to_utf8(audio_data.wstring()), window_target, window_source,
      [](std::string_view event, std::string_view audio_id, std::string_view code, ScreenAudioStartupTiming timing) {
        const std::lock_guard<std::mutex> output_lock(g_output_mutex);
        std::cout << "{\"event\":\"" << event << "\",\"sessionId\":\"" << g_host.session_id
                  << "\",\"audioId\":\"" << audio_id << "\"";
        if (event == "audioStarted") {
          std::cout << ",\"sampleRate\":48000,\"channels\":2,\"bitsPerSample\":32,\"nominalChunkMs\":10"
                    << ",\"pluginLoadMs\":" << timing.plugin_load_ms << ",\"captureReadyMs\":" << timing.capture_ready_ms;
        }
        if (!code.empty()) std::cout << ",\"code\":\"" << code << "\"";
        std::cout << "}\n";
        std::cout.flush();
      });

  std::string command;
  struct PendingConfiguration { std::string id; uint32_t fps; uint32_t width; uint32_t height; };
  std::optional<PendingConfiguration> pending_configuration;
  bool keep_host = false;
  while (std::getline(std::cin, command)) {
    if (command == "shutdown") break;
    if (command == "stop:" + g_host.session_id) { keep_host = true; break; }
    if (command == "prepare") { write_event("enginePrepared"); continue; }
    if (screen_audio.command(command)) continue;
    size_t slot_index = 0;
    if (parse_release_command(command, slot_index)) {
      const std::lock_guard<std::mutex> lock(g_slot_mutex);
      g_host.slots[slot_index].busy = false;
    }
    std::string_view request_id;
    if (parse_diagnostics_command(command, request_id)) write_diagnostics_event(request_id, screen_audio.snapshot());
    uint32_t next_frame_rate = 0, next_width = 0, next_height = 0;
    if (!pending_configuration && parse_configure_command(command, request_id, next_frame_rate, next_width, next_height)) {
      obs_remove_main_rendered_callback(render_shared_frame, source);
      const std::lock_guard<std::mutex> render_lock(g_render_mutex);
      g_host.configuration_paused = true;
      pending_configuration = PendingConfiguration{std::string(request_id), next_frame_rate, next_width, next_height};
    }
    if (pending_configuration) {
      bool slots_released;
      {
        const std::lock_guard<std::mutex> slot_lock(g_slot_mutex);
        slots_released = std::none_of(g_host.slots.begin(), g_host.slots.end(), [](const auto &slot) { return slot.busy; });
      }
      // 等待期间继续处理 release 命令，不能在命令线程阻塞归还路径。
      if (slots_released) {
        const auto &next = *pending_configuration;
        if (!configure_video(video, item, next.id, next.fps, next.width, next.height)) break;
        pending_configuration.reset();
        {
          const std::lock_guard<std::mutex> render_lock(g_render_mutex);
          g_host.configuration_paused = false;
        }
        obs_add_main_rendered_callback(render_shared_frame, source);
      }
    }
  }

  screen_audio.shutdown();
  obs_remove_main_rendered_callback(render_shared_frame, source);
  {
    const std::lock_guard<std::mutex> render_lock(g_render_mutex);
    obs_set_output_source(0, nullptr);
    // 主画布也持有场景引用，先移出注册表，避免下次采集继承旧来源。
    obs_source_remove(obs_scene_get_source(scene));
    obs_scene_release(scene);
    obs_source_release(source);
    destroy_textures();
  }
  // 等待返回即已排空；bool 表示期间是否执行任务，false 不是清理失败。
  obs_wait_for_destroy_queue();
  g_host.window_target = WindowVideoTarget{};
  window_target = WindowVideoTarget{};
  // 热态仅保留小画布与低频图形循环，不保留采集、共享纹理或声音设备。
  video.base_width = video.output_width = 320;
  video.base_height = video.output_height = 180;
  video.fps_num = 1;
  if (keep_host && obs_reset_video(&video) != OBS_VIDEO_SUCCESS) {
    write_event("obsVideoIdleFailed");
    return 1;
  }
  {
    const std::lock_guard<std::mutex> output_lock(g_output_mutex);
    std::cout << "{\"event\":\"captureStopped\",\"sessionId\":\"" << g_host.session_id << "\"}\n";
    std::cout.flush();
  }
  return keep_host ? 0 : 3;
}

int wmain(int argc, wchar_t **argv) {
  if ((argc != 4 && argc != 5) || !std::filesystem::path(argv[3]).is_absolute()) return 2;
  if (argc == 5) {
    const auto requested = to_utf8(argv[4]);
    const auto parsed = std::from_chars(requested.data(), requested.data() + requested.size(), g_adapter_index);
    if (parsed.ec != std::errc{} || parsed.ptr != requested.data() + requested.size() || g_adapter_index >= 64) return 2;
  } else {
    MONITORINFOEXW primary{};
    primary.cbSize = sizeof(primary);
    if (GetMonitorInfoW(MonitorFromPoint(POINT{}, MONITOR_DEFAULTTOPRIMARY), &primary)) {
      if (const auto adapter = find_monitor_adapter(primary.szDevice)) g_adapter_index = adapter->index;
    }
  }
  base_set_log_handler(obs_log_handler, nullptr);
  if (!obs_startup("en-US", to_utf8(argv[3]).c_str(), nullptr)) { write_event("obsStartupFailed"); return 1; }
  if (std::string_view(obs_get_version_string()) != "32.2.2") {
    write_event("obsCaptureVersionUnsupported");
    obs_shutdown();
    return 1;
  }
  write_event("coreReady");
  bool prepared = false;
  obs_video_info video{};
  video.graphics_module = "libobs-d3d11";
  video.fps_den = 1;
  video.output_format = VIDEO_FORMAT_BGRA;
  video.gpu_conversion = true;
  video.colorspace = VIDEO_CS_SRGB;
  video.range = VIDEO_RANGE_PARTIAL;
  video.scale_type = OBS_SCALE_BICUBIC;
  const auto prepare = [&]() {
    if (prepared) return true;
    video.fps_num = 1;
    video.adapter = g_adapter_index;
    video.base_width = video.output_width = 320;
    video.base_height = video.output_height = 180;
    if (obs_reset_video(&video) != OBS_VIDEO_SUCCESS) { write_event("obsVideoInitFailed"); return false; }
    obs_audio_info audio{};
    audio.samples_per_sec = 48'000;
    audio.speakers = SPEAKERS_STEREO;
    if (!obs_reset_audio(&audio)) { write_event("obsAudioInitFailed"); return false; }
    obs_module_t *module = nullptr;
    auto module_path = to_utf8(argv[1]);
    std::replace(module_path.begin(), module_path.end(), '\\', '/');
    if (obs_open_module(&module, module_path.c_str(), to_utf8(argv[2]).c_str()) != MODULE_SUCCESS
        || !obs_init_module(module)) { write_event("obsCaptureModuleLoadFailed"); return false; }
    obs_post_load_modules();
    prepared = true;
    return true;
  };
  std::string command;
  int result = 0;
  while (std::getline(std::cin, command)) {
    if (command == "shutdown") break;
    if (command == "prepare") {
      if (!prepare()) { result = 1; break; }
      write_event("enginePrepared");
      continue;
    }
    size_t retired_slot = 0;
    // 页面撤销导入后的最后一次归还可能排在 stop 后；空闲时不再持有可修改的槽位。
    if (parse_release_command(command, retired_slot)) continue;
    if (!command.starts_with("start|")) { write_event("invalidCaptureCommand"); result = 1; break; }
    auto remaining = std::string_view(command).substr(6);
    std::array<std::string, 12> arguments;
    bool valid = true;
    for (size_t index = 0; index < arguments.size(); ++index) {
      const auto end = remaining.find('|');
      const auto value = remaining.substr(0, end);
      if (value.size() > 256 || !std::all_of(value.begin(), value.end(), [](unsigned char ch) { return ch >= 32 && ch < 127; })
          || ((index + 1 == arguments.size()) != (end == std::string_view::npos))) { valid = false; break; }
      arguments[index] = value;
      if (end != std::string_view::npos) remaining.remove_prefix(end + 1);
    }
    if (!valid) { write_event("invalidCaptureArguments"); result = 1; break; }
    g_dxgi_failure_reported = false;
    g_dxgi_api = 0;
    if (!valid_session_id(arguments[4])) { write_event("invalidCaptureArguments"); result = 1; break; }
    write_capture_preparation("graphicsStarting", arguments[4]);
    if (arguments[0] == "monitor") {
      const auto target = find_monitor_adapter(std::wstring(arguments[1].begin(), arguments[1].end()));
      if (!target) { write_event("dxgiMonitorUnavailable"); result = 1; break; }
      // obs_reset_video 不会替换已有图形设备；选中另一显卡的显示器时由父进程重建宿主。
      if (prepared && !graphics_matches_monitor(*target)) {
        const std::lock_guard<std::mutex> output_lock(g_output_mutex);
        std::cout << "{\"event\":\"adapterRequired\",\"sessionId\":\"" << arguments[4]
                  << "\",\"adapterIndex\":" << target->index << "}\n";
        std::cout.flush();
        continue;
      }
      g_adapter_index = target->index;
      if (!prepare()) { result = 1; break; }
      if (!graphics_matches_monitor(*target)) { write_event("dxgiAdapterMismatch"); result = 1; break; }
    }
    if (!prepare()) { result = 1; break; }
    write_capture_preparation("graphicsReady", arguments[4]);
    result = capture(arguments, argv[1], argv[2], video);
    if (result != 0) break;
  }
  obs_shutdown();
  return result == 3 ? 0 : result;
}
