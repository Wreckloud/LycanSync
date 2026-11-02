#include "../src/recording.h"
#include <obs-module.h>
#include <graphics/graphics.h>
#include <util/base.h>
#include <atomic>
#include <algorithm>
#include <chrono>
#include <cstdio>
#include <filesystem>
#include <thread>
#include <cstdlib>
#include <windows.h>

namespace {
struct Pattern { std::atomic<uint32_t> width = 1222, height = 787; } pattern;
unsigned main_frames = 0, auxiliary_frames = 0;
void count_frames(void *) {
  if (gs_get_render_target() == obs_get_main_texture()) ++main_frames;
  else ++auxiliary_frames;
}
void draw_pattern(void *, gs_effect_t *) {
  auto *effect = obs_get_base_effect(OBS_EFFECT_SOLID);
  vec4 green{0.05f, 0.8f, 0.15f, 1.0f};
  gs_effect_set_vec4(gs_effect_get_param_by_name(effect, "color"), &green);
  while (gs_effect_loop(effect, "Solid")) gs_draw_sprite(nullptr, 0, pattern.width, pattern.height);
}
std::string utf8(const std::filesystem::path &path) {
  const auto value = path.u8string(); return {value.begin(), value.end()};
}
}

// 仅编码合成色块，不加载捕获插件、创建窗口、读取设备或连接房间。
int wmain(int argc, wchar_t **argv) {
  if (argc != 3 && argc != 4 && argc != 6) return 2;
  const unsigned duration = argc >= 4 ? static_cast<unsigned>(std::wcstoul(argv[3], nullptr, 10)) : 3;
  const unsigned shared_fps = argc == 6 ? static_cast<unsigned>(std::wcstoul(argv[4], nullptr, 10)) : 30;
  const unsigned recording_fps = argc == 6 ? static_cast<unsigned>(std::wcstoul(argv[5], nullptr, 10)) : 30;
  if ((shared_fps != 30 && shared_fps != 60 && shared_fps != 120)
      || (recording_fps != 30 && recording_fps != 60 && recording_fps != 120)) return 2;
  if (duration < 3 || duration > 3600) return 2;
  const auto sdk = std::filesystem::absolute(argv[1]);
  const auto directory = std::filesystem::absolute(argv[2]);
  const auto dll_directory = AddDllDirectory((sdk / "bin/64bit").c_str());
  if (!dll_directory) return 3;
  std::filesystem::create_directories(directory);
  base_set_log_handler([](int level, const char *format, va_list args, void *) {
    if (level > LOG_WARNING) return;
    std::vfprintf(stderr, format, args); std::fputc('\n', stderr);
  }, nullptr);
  if (!obs_startup("en-US", nullptr, nullptr)) return 3;
  obs_add_data_path((utf8(sdk / "data/libobs") + "/").c_str());
  obs_video_info video{};
  const auto graphics = utf8(sdk / "bin/64bit/libobs-d3d11.dll");
  video.graphics_module = graphics.c_str();
  video.base_width = video.output_width = 1920; video.base_height = video.output_height = 1080;
  video.fps_num = std::max(shared_fps, recording_fps); video.fps_den = 1; video.output_format = VIDEO_FORMAT_BGRA;
  video.gpu_conversion = true; video.colorspace = VIDEO_CS_SRGB; video.range = VIDEO_RANGE_PARTIAL;
  obs_audio_info audio{}; audio.samples_per_sec = 48000; audio.speakers = SPEAKERS_STEREO;
  if (obs_reset_video(&video) != OBS_VIDEO_SUCCESS || !obs_reset_audio(&audio)) { obs_shutdown(); return 4; }
  obs_source_info info{};
  info.id = "lycansync_recording_pattern"; info.type = OBS_SOURCE_TYPE_INPUT;
  info.output_flags = OBS_SOURCE_VIDEO | OBS_SOURCE_CUSTOM_DRAW;
  info.get_name = [](void *) { return "Recording pattern"; };
  info.create = [](obs_data_t *, obs_source_t *) -> void * { return &pattern; };
  info.destroy = [](void *) {};
  info.get_width = [](void *) { return pattern.width.load(); };
  info.get_height = [](void *) { return pattern.height.load(); };
  info.video_render = draw_pattern;
  obs_register_source(&info);
  auto *source = obs_source_create_private(info.id, "Recording pattern", nullptr);
  if (!source) { obs_shutdown(); return 5; }
  obs_set_output_source(0, source);
  obs_add_main_rendered_callback(count_frames, nullptr);
  int result = 0;
  {
    bool started = false, stopped = false, failed = false, replay_saved = false;
    RecordingOutput recording(utf8(sdk / "obs-plugins/64bit"), utf8(sdk / "data/obs-plugins"),
        [&](std::string_view event, std::string_view, std::string_view code) {
          std::printf("%.*s %.*s\n", static_cast<int>(event.size()), event.data(), static_cast<int>(code.size()), code.data());
          std::fflush(stdout);
          started |= event == "recordingStarted";
          stopped |= event == "recordingStopped";
          replay_saved |= event == "replaySaved";
          failed |= !code.empty();
        });
    for (unsigned segment = 0; segment < 2 && !result; ++segment) {
      started = stopped = failed = replay_saved = false; pattern.width = 1222; pattern.height = 787;
      if (!recording.start_replay("framing-replay", false, source, "framing-test", 30, 1080, recording_fps)) { result = 10; break; }
      if (!recording.start("framing-test", utf8(directory / ("framing-" + std::to_string(segment) + ".mkv")), false,
          source, "framing-test", 1080, recording_fps)) { result = 6; break; }
      if (recording.width() != 1220 || recording.height() != 786) { result = 7; break; }
      const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(duration);
      while (std::chrono::steady_clock::now() < deadline && !failed) {
        recording.poll();
        if (std::chrono::steady_clock::now() > deadline - std::chrono::seconds(1)) { pattern.width = 800; pattern.height = 800; }
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
      }
      if (!recording.save_replay("framing-save", utf8(directory / ("replay-" + std::to_string(segment) + ".mkv")), "framing-replay")) { result = 11; break; }
      const auto save_deadline = std::chrono::steady_clock::now() + std::chrono::seconds(3);
      while (!replay_saved && !failed && std::chrono::steady_clock::now() < save_deadline) {
        recording.poll();
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
      }
      if (!replay_saved || failed) { result = 12; break; }
      // 第一段沿用主动停止；第二段模拟目标关闭后直接进入宿主收尾。
      if (segment == 0) recording.stop();
      std::printf("shutdown segment=%u\n", segment); std::fflush(stdout);
      if (!recording.shutdown() || !started || !stopped || failed) result = 8;
      std::printf("shutdown complete segment=%u result=%d\n", segment, result); std::fflush(stdout);
    }
  }
  obs_remove_main_rendered_callback(count_frames, nullptr);
  std::printf("mainFrames=%u auxiliaryFrames=%u\n", main_frames, auxiliary_frames);
  if (!main_frames || !auxiliary_frames) result = 9;
  obs_set_output_source(0, nullptr);
  obs_source_release(source);
  obs_wait_for_destroy_queue();
  video.base_width = video.output_width = 320;
  video.base_height = video.output_height = 180;
  video.fps_num = 1;
  if (obs_reset_video(&video) != OBS_VIDEO_SUCCESS) result = 13;
  obs_shutdown();
  RemoveDllDirectory(dll_directory);
  return result;
}
