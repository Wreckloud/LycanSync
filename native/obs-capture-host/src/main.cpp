#include <obs.h>
#include <obs-module.h>
#include <graphics/graphics.h>
#include <util/base.h>
#include "window_capture.h"
#include "game_capture.h"

#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <wrl/client.h>

#include <array>
#include <algorithm>
#include <charconv>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <filesystem>
#include <iomanip>
#include <iostream>
#include <mutex>
#include <string>
#include <string_view>

namespace {

static_assert(LIBOBS_API_VER == MAKE_SEMANTIC_VERSION(32, 2, 2), "OBS 32.2.2 headers are required");

constexpr uint32_t kOutputWidth = 1920;
constexpr uint32_t kOutputHeight = 1080;
constexpr size_t kTextureSlotCount = 3;
constexpr auto kGpuFenceTimeout = std::chrono::milliseconds(250);

struct TextureSlot {
  Microsoft::WRL::ComPtr<ID3D11Texture2D> d3d_texture;
  Microsoft::WRL::ComPtr<IDXGIKeyedMutex> keyed_mutex;
  Microsoft::WRL::ComPtr<ID3D11Query> gpu_ready;
  HANDLE shared_handle = nullptr;
  bool busy = false;
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
  WindowVideoTarget window_target;
  bool suspended = false;
};

HostState g_host;
std::mutex g_slot_mutex;
std::mutex g_output_mutex;
std::mutex g_render_mutex;
std::mutex g_log_mutex;

void obs_log_handler(int level, const char *format, va_list args, void *) {
  // libobs 默认会向 stdout 写普通日志；协议通道只能包含本宿主的 JSON。
  if (level > LOG_WARNING) return;
  std::array<char, 2000> message{};
  std::vsnprintf(message.data(), message.size(), format, args);
  const std::lock_guard<std::mutex> lock(g_log_mutex);
  std::cerr << message.data() << '\n';
}

void write_event(std::string_view event) {
  const std::lock_guard<std::mutex> lock(g_output_mutex);
  std::cout << "{\"event\":\"" << event << "\"}\n";
  std::cout.flush();
}

void write_started_event() {
  const std::lock_guard<std::mutex> lock(g_output_mutex);
  std::cout << "{\"event\":\"captureStarted\",\"helperVersion\":\"" << g_host.helper_version << "\"}\n";
  std::cout.flush();
}

void write_diagnostics_event(std::string_view request_id) {
  const std::lock_guard<std::mutex> render_lock(g_render_mutex);
  const std::lock_guard<std::mutex> output_lock(g_output_mutex);
  std::cout << "{\"event\":\"diagnostics\",\"requestId\":\"" << request_id
            << "\",\"sessionId\":\"" << g_host.session_id << "\",\"renderedFrames\":"
            << g_host.rendered_frames << ",\"bridgeFrames\":" << g_host.frame_count
            << ",\"bridgeDroppedFrames\":" << g_host.dropped_frames << "}\n";
  std::cout.flush();
}

void write_frame_event(size_t slot_index, const TextureSlot &slot, uint64_t timestamp_micros) {
  const auto handle = reinterpret_cast<uintptr_t>(slot.shared_handle);
  const std::lock_guard<std::mutex> lock(g_output_mutex);
  std::cout << "{\"event\":\"sharedTextureFrame\",\"sessionId\":\"" << g_host.session_id
            << "\",\"slotIndex\":" << slot_index << ",\"sourceHandleHex\":\"" << std::hex
            << std::setw(16) << std::setfill('0') << handle << std::dec << "\",\"pixelFormat\":\"bgra\",\"codedSize\":{\"width\":"
            << kOutputWidth << ",\"height\":" << kOutputHeight
            << "},\"contentSize\":{\"width\":" << kOutputWidth << ",\"height\":"
            << kOutputHeight << "},\"timestampMicros\":" << timestamp_micros
            << ",\"renderedFrames\":" << g_host.rendered_frames
            << ",\"bridgeFrames\":" << g_host.frame_count << ",\"bridgeDroppedFrames\":"
            << g_host.dropped_frames << "}\n";
  std::cout.flush();
}

bool gpu_operation_succeeded(HRESULT result, const char *stage) {
  if (result == S_OK) return true;
  const std::lock_guard<std::mutex> lock(g_log_mutex);
  std::cerr << stage << " failed: 0x" << std::hex << static_cast<uint32_t>(result) << std::dec << '\n';
  return false;
}

bool create_texture_slot(TextureSlot &slot, ID3D11Device *device) {
  const D3D11_TEXTURE2D_DESC description{
      .Width = kOutputWidth,
      .Height = kOutputHeight,
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

bool wait_for_gpu_frame(ID3D11DeviceContext *context, ID3D11Query *query) {
  context->End(query);
  context->Flush();
  const auto deadline = std::chrono::steady_clock::now() + kGpuFenceTimeout;
  while (std::chrono::steady_clock::now() < deadline) {
    const HRESULT result = context->GetData(query, nullptr, 0, 0);
    if (result == S_OK) return true;
    if (result != S_FALSE) return false;
    Sleep(1);
  }
  return false;
}

void release_busy_slot(size_t slot_index) {
  const std::lock_guard<std::mutex> lock(g_slot_mutex);
  if (slot_index < g_host.slots.size()) g_host.slots[slot_index].busy = false;
}

bool window_delivery_allowed(obs_source_t *source) {
  if (!g_host.window_source) return true;
  const char *failure = g_host.game_source ? game_video_failure(source, g_host.window_target) : window_video_failure();
  if (failure) {
    g_host.texture_setup_failed = true;
    write_event(failure);
    return false;
  }
  const bool suspended = g_host.game_source
      ? IsIconic(g_host.window_target.window) || !IsWindowVisible(g_host.window_target.window)
      : window_video_suspended();
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
  if (g_host.texture_setup_failed) return;
  ++g_host.rendered_frames;
  auto *capture_source = static_cast<obs_source_t *>(parameter);
  if (!window_delivery_allowed(capture_source)) return;
  // 初始化时主画布已能渲染，但来源尚未就绪，不能把空画布计作首帧交付。
  if (!obs_source_get_width(capture_source) || !obs_source_get_height(capture_source)) return;
  if (!g_host.textures_initialized && !initialize_textures()) {
    g_host.texture_setup_failed = true;
    write_event("sharedTextureUnavailable");
    return;
  }

  size_t slot_index = kTextureSlotCount;
  {
    const std::lock_guard<std::mutex> lock(g_slot_mutex);
    for (size_t index = 0; index < g_host.slots.size(); ++index) {
      if (!g_host.slots[index].busy) {
        slot_index = index;
        g_host.slots[index].busy = true;
        break;
      }
    }
  }
  if (slot_index == kTextureSlotCount) {
    ++g_host.dropped_frames;
    return;
  }

  auto &slot = g_host.slots[slot_index];
  auto *device = static_cast<ID3D11Device *>(gs_get_device_obj());
  if (!device) {
    release_busy_slot(slot_index);
    g_host.texture_setup_failed = true;
    write_event("sharedTextureDeviceUnavailable");
    return;
  }
  Microsoft::WRL::ComPtr<ID3D11DeviceContext> context;
  device->GetImmediateContext(&context);
  gs_texture_t *rendered_texture = obs_get_main_texture();
  auto *source = rendered_texture ? static_cast<ID3D11Texture2D *>(gs_texture_get_obj(rendered_texture)) : nullptr;
  D3D11_TEXTURE2D_DESC source_description{};
  if (source) source->GetDesc(&source_description);
  const bool bgra_format = source_description.Format == DXGI_FORMAT_B8G8R8A8_UNORM
                       || source_description.Format == DXGI_FORMAT_B8G8R8A8_TYPELESS;
  if (!context || !source || source_description.Width != kOutputWidth || source_description.Height != kOutputHeight || !bgra_format) {
    std::fprintf(stderr, "mainTexture context=%d source=%d size=%ux%u format=%u\n",
                 context != nullptr, source != nullptr, source_description.Width, source_description.Height, source_description.Format);
    release_busy_slot(slot_index);
    g_host.texture_setup_failed = true;
    write_event("sharedTextureSourceInvalid");
    return;
  }
  if (!gpu_operation_succeeded(slot.keyed_mutex->AcquireSync(0, static_cast<DWORD>(kGpuFenceTimeout.count())), "acquireTexture")) {
    release_busy_slot(slot_index);
    g_host.texture_setup_failed = true;
    write_event("sharedTextureAcquireFailed");
    return;
  }
  // 直接复制 OBS 已渲染的主纹理；wrap_obj 不会把外部纹理变成可绘制目标。
  context->CopyResource(slot.d3d_texture.Get(), source);
  const bool gpu_ready = wait_for_gpu_frame(context.Get(), slot.gpu_ready.Get());
  // GPU 完成且互斥量归还后才交付，消费者释放全部引用后再复用此槽。
  const bool mutex_released = gpu_operation_succeeded(slot.keyed_mutex->ReleaseSync(0), "releaseTexture");
  if (!gpu_ready || !mutex_released) {
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
  constexpr std::string_view prefix = "release:";
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

bool parse_configure_command(std::string_view command, std::string_view &request_id, uint32_t &frame_rate) {
  constexpr std::string_view prefix = "configure:";
  if (!command.starts_with(prefix)) return false;
  const auto values = command.substr(prefix.size());
  const auto separator = values.find(':');
  if (separator == std::string_view::npos) return false;
  request_id = values.substr(0, separator);
  if (request_id.empty() || request_id.size() > 16
      || !std::all_of(request_id.begin(), request_id.end(), [](char digit) { return digit >= '0' && digit <= '9'; })) return false;
  const auto value = values.substr(separator + 1);
  const auto parsed = std::from_chars(value.data(), value.data() + value.size(), frame_rate);
  return parsed.ec == std::errc{} && parsed.ptr == value.data() + value.size() && valid_frame_rate(frame_rate);
}

bool configure_video(obs_video_info &video, obs_source_t *source, std::string_view request_id, uint32_t frame_rate) {
  bool accepted = true;
  if (video.fps_num != frame_rate) {
    // 重置 OBS 渲染节奏，不在页面重复限帧，也不更换采集来源、纹理槽或轨道。
    obs_remove_main_rendered_callback(render_shared_frame, source);
    auto next = video;
    next.fps_num = frame_rate;
    if (obs_reset_video(&next) == OBS_VIDEO_SUCCESS) video = next;
    else {
      accepted = false;
      if (obs_reset_video(&video) != OBS_VIDEO_SUCCESS) {
        write_event("obsCaptureConfigurationRollbackFailed");
        return false;
      }
    }
    obs_add_main_rendered_callback(render_shared_frame, source);
  }
  const std::lock_guard<std::mutex> output_lock(g_output_mutex);
  std::cout << "{\"event\":\"" << (accepted ? "captureConfigured" : "captureConfigurationRejected")
            << "\",\"requestId\":\"" << request_id << "\",\"sessionId\":\"" << g_host.session_id
            << "\",\"maxFps\":" << video.fps_num << "}\n";
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
}

}  // namespace

int wmain(int argc, wchar_t **argv) {
  if (argc != 12) {
    std::wcerr << L"usage: lycansync-obs-capture-host <win-capture.dll> <module-data-dir> <monitor|window|game> <target> <capture-cursor:0|1> <hide-border:0|1> <session-id> <module-config-dir> <max-fps:30|60|120> <window-property> <window-property-value>\n";
    return 2;
  }

  const std::wstring_view source_kind(argv[3]);
  const bool game_source = source_kind == L"game";
  const bool window_source = source_kind == L"window" || game_source;
  const std::string session_id = to_utf8(argv[7]);
  const std::string config_path = to_utf8(argv[8]);
  const std::string frame_rate_argument = to_utf8(argv[9]);
  uint32_t frame_rate = 0;
  const auto parsed_frame_rate = std::from_chars(frame_rate_argument.data(), frame_rate_argument.data() + frame_rate_argument.size(), frame_rate);
  const std::wstring_view capture_cursor_argument(argv[5]);
  const std::wstring_view hide_border_argument(argv[6]);
  if (capture_cursor_argument.size() != 1
      || (capture_cursor_argument[0] != L'0' && capture_cursor_argument[0] != L'1')
      || (hide_border_argument != L"0" && hide_border_argument != L"1")
      || (source_kind != L"monitor" && !window_source)
      || !valid_session_id(session_id)
      || config_path.empty() || !std::filesystem::path(argv[8]).is_absolute()
      || parsed_frame_rate.ec != std::errc{} || parsed_frame_rate.ptr != frame_rate_argument.data() + frame_rate_argument.size()
      || !valid_frame_rate(frame_rate)
      || (!window_source && !monitor_exists(argv[4]))) {
    write_event("invalidCaptureArguments");
    return 2;
  }
  g_host.session_id = session_id;
  g_host.window_source = window_source;
  g_host.game_source = game_source;
  WindowVideoTarget window_target;
  if (window_source) {
    const auto parse_pointer = [](const std::wstring_view argument, uintptr_t &value) {
      const auto text = to_utf8(argument);
      const auto result = std::from_chars(text.data(), text.data() + text.size(), value);
      return result.ec == std::errc{} && result.ptr == text.data() + text.size() && value != 0;
    };
    uintptr_t window_handle = 0;
    window_target.property_name = argv[10];
    if (!parse_pointer(argv[4], window_handle) || !parse_pointer(argv[11], window_target.property_value)
        || !window_target.property_name.starts_with(L"LycanSync.MediaHelper.Window.")
        || window_target.property_name.size() > 128) {
      write_event("invalidCaptureArguments");
      return 2;
    }
    window_target.window = reinterpret_cast<HWND>(window_handle);
    if (!window_video_target_valid(window_target)) { write_event("captureTargetClosed"); return 2; }
    g_host.window_target = window_target;
  }

  base_set_log_handler(obs_log_handler, nullptr);
  // 插件兼容列表等可写缓存归用户目录，不污染固定运行依赖或安装目录。
  if (!obs_startup("en-US", config_path.c_str(), nullptr)) {
    write_event("obsStartupFailed");
    return 1;
  }
  const char *helper_version = obs_get_version_string();
  if (!helper_version || std::string_view(helper_version) != "32.2.2") {
    write_event("obsCaptureVersionUnsupported");
    obs_shutdown();
    return 1;
  }
  g_host.helper_version = helper_version;

  obs_video_info video{};
  video.graphics_module = "libobs-d3d11";
  video.fps_num = frame_rate;
  video.fps_den = 1;
  video.base_width = kOutputWidth;
  video.base_height = kOutputHeight;
  video.output_width = kOutputWidth;
  video.output_height = kOutputHeight;
  video.output_format = VIDEO_FORMAT_BGRA;
  video.gpu_conversion = true;
  video.colorspace = VIDEO_CS_SRGB;
  video.range = VIDEO_RANGE_PARTIAL;
  video.scale_type = OBS_SCALE_BICUBIC;
  if (obs_reset_video(&video) != OBS_VIDEO_SUCCESS) {
    write_event("obsVideoInitFailed");
    obs_shutdown();
    return 1;
  }

  obs_audio_info audio{};
  audio.samples_per_sec = 48'000;
  audio.speakers = SPEAKERS_STEREO;
  if (!obs_reset_audio(&audio)) {
    write_event("obsAudioInitFailed");
    obs_shutdown();
    return 1;
  }

  obs_module_t *module = nullptr;
  std::string module_path = to_utf8(argv[1]);
  const std::string data_path = to_utf8(argv[2]);
  // libobs 用正斜杠提取模块名，否则会把 Windows 绝对路径拼进缓存目录。
  std::replace(module_path.begin(), module_path.end(), '\\', '/');
  if ((!window_source || game_source) && (module_path.empty() || data_path.empty()
      || obs_open_module(&module, module_path.c_str(), data_path.c_str()) != MODULE_SUCCESS
      || !obs_init_module(module))) {
    write_event("obsCaptureModuleLoadFailed");
    obs_shutdown();
    return 1;
  }
  if (!window_source || game_source) obs_post_load_modules();

  obs_source_t *source = nullptr;
  const char *source_error = "obsDisplaySourceUnavailable";
  if (game_source) {
    source = create_game_video_source(window_target, capture_cursor_argument == L"0", source_error);
  } else if (window_source) {
    source = create_window_video_source(window_target, std::filesystem::path(argv[0]).parent_path().wstring(),
        capture_cursor_argument == L"0", hide_border_argument == L"1", source_error);
  } else {
    obs_data_t *settings = obs_data_create();
    // 来源 ID 的尾号不是系统显示器序号；固定版本按设备名匹配 monitor_id。
    const std::string monitor_name = to_utf8(argv[4]);
    obs_data_set_string(settings, "monitor_id", monitor_name.c_str());
    obs_data_set_bool(settings, "capture_cursor", capture_cursor_argument[0] == L'1');
    source = obs_source_create("monitor_capture", "LycanSync display", settings, nullptr);
    obs_data_release(settings);
  }
  if (!source) {
    write_event(source_error);
    obs_shutdown();
    return 1;
  }

  obs_scene_t *scene = obs_scene_create("LycanSync capture");
  if (!scene) {
    obs_source_release(source);
    write_event("obsSceneUnavailable");
    obs_shutdown();
    return 1;
  }
  obs_sceneitem_t *item = obs_scene_add(scene, source);
  if (!item) {
    obs_source_remove(obs_scene_get_source(scene));
    obs_scene_release(scene);
    obs_source_release(source);
    write_event("obsDisplaySceneAddFailed");
    obs_shutdown();
    return 1;
  }
  obs_transform_info transform{};
  transform.pos = {static_cast<float>(kOutputWidth) / 2.0f, static_cast<float>(kOutputHeight) / 2.0f};
  transform.scale = {1.0f, 1.0f};
  transform.alignment = OBS_ALIGN_CENTER;
  transform.bounds_type = OBS_BOUNDS_SCALE_INNER;
  transform.bounds_alignment = OBS_ALIGN_CENTER;
  transform.bounds = {static_cast<float>(kOutputWidth), static_cast<float>(kOutputHeight)};
  obs_sceneitem_set_info2(item, &transform);
  // scene 持有 add 返回的元素，此处没有额外引用需要释放。
  obs_set_output_source(0, obs_scene_get_source(scene));
  obs_add_main_rendered_callback(render_shared_frame, source);
  write_started_event();

  std::string command;
  while (std::getline(std::cin, command)) {
    if (command == "shutdown") break;
    size_t slot_index = 0;
    if (parse_release_command(command, slot_index)) {
      const std::lock_guard<std::mutex> lock(g_slot_mutex);
      g_host.slots[slot_index].busy = false;
    }
    std::string_view request_id;
    if (parse_diagnostics_command(command, request_id)) write_diagnostics_event(request_id);
    uint32_t next_frame_rate = 0;
    if (parse_configure_command(command, request_id, next_frame_rate)
        && !configure_video(video, source, request_id, next_frame_rate)) break;
  }

  obs_remove_main_rendered_callback(render_shared_frame, source);
  const std::lock_guard<std::mutex> render_lock(g_render_mutex);
  obs_set_output_source(0, nullptr);
  // 主画布也持有场景引用，先移出注册表，避免 shutdown 再次销毁。
  obs_source_remove(obs_scene_get_source(scene));
  obs_scene_release(scene);
  obs_source_release(source);
  destroy_textures();
  obs_shutdown();
  write_event("captureStopped");
  return 0;
}
