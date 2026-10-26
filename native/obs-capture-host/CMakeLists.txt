cmake_minimum_required(VERSION 3.28)
project(lycansync_obs_capture_host LANGUAGES C CXX)

if(NOT WIN32 OR NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
  message(FATAL_ERROR "The OBS capture host currently targets Windows x64 only")
endif()

set(LYCANSYNC_OBS_SDK "" CACHE PATH "Verified OBS 32.2.2 Windows x64 SDK prepared by build.ps1")
if(NOT EXISTS "${LYCANSYNC_OBS_SDK}/include/obs.h"
   OR NOT EXISTS "${LYCANSYNC_OBS_SDK}/lib/obs.lib"
   OR NOT EXISTS "${LYCANSYNC_OBS_SDK}/bin/64bit/obs.dll"
   OR NOT EXISTS "${LYCANSYNC_OBS_SDK}/sdk-version.txt")
  message(FATAL_ERROR "Run native/obs-capture-host/build.ps1 to prepare the pinned OBS SDK")
endif()
file(READ "${LYCANSYNC_OBS_SDK}/sdk-version.txt" obs_sdk_version)
string(STRIP "${obs_sdk_version}" obs_sdk_version)
if(NOT obs_sdk_version STREQUAL "32.2.2")
  message(FATAL_ERROR "The capture host requires OBS 32.2.2 exactly")
endif()

# 官方发布包不附带开发包；只使用同版头文件及真实 DLL 导出生成的导入库。
set(OBS_RELEASE_CANDIDATE 0)
set(OBS_BETA 0)
configure_file("${LYCANSYNC_OBS_SDK}/include/obsconfig.h.in" generated/obsconfig.h @ONLY)
add_library(lycansync_libobs SHARED IMPORTED)
set_target_properties(lycansync_libobs PROPERTIES
  IMPORTED_IMPLIB "${LYCANSYNC_OBS_SDK}/lib/obs.lib"
  IMPORTED_LOCATION "${LYCANSYNC_OBS_SDK}/bin/64bit/obs.dll"
  INTERFACE_INCLUDE_DIRECTORIES "${LYCANSYNC_OBS_SDK}/include;${CMAKE_CURRENT_BINARY_DIR}/generated")

add_executable(lycansync-obs-capture-host src/main.cpp src/window_capture.cpp src/game_capture.cpp
  src/screen_audio.cpp src/screen_audio_pcm.cpp src/bound_game_target.c)
target_compile_features(lycansync-obs-capture-host PRIVATE cxx_std_20)
target_compile_definitions(lycansync-obs-capture-host PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)
target_link_libraries(lycansync-obs-capture-host PRIVATE lycansync_libobs d3d11 dxgi windowsapp ole32)
target_compile_options(lycansync-obs-capture-host PRIVATE /utf-8)

# 仅供显式设备测试创建色块窗口，不进入宿主运行包或默认构建。
add_executable(lycansync-obs-test-windows EXCLUDE_FROM_ALL tests/window_fixture.cpp)
target_compile_features(lycansync-obs-test-windows PRIVATE cxx_std_20)
target_compile_definitions(lycansync-obs-test-windows PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)
target_compile_options(lycansync-obs-test-windows PRIVATE /utf-8)
target_link_libraries(lycansync-obs-test-windows PRIVATE user32 gdi32)
set_target_properties(lycansync-obs-test-windows PROPERTIES RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}/test-tools")

add_executable(lycansync-obs-test-d3d EXCLUDE_FROM_ALL tests/d3d_fixture.cpp)
target_compile_features(lycansync-obs-test-d3d PRIVATE cxx_std_20)
target_compile_definitions(lycansync-obs-test-d3d PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)
target_compile_options(lycansync-obs-test-d3d PRIVATE /utf-8)
target_link_libraries(lycansync-obs-test-d3d PRIVATE user32 d3d11 dxgi)
set_target_properties(lycansync-obs-test-d3d PROPERTIES RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}/test-tools")

add_subdirectory(game-plugin)
add_subdirectory(audio-plugin)
add_subdirectory(graphics-module)

# 只替换查询边界验证结束判定，不初始化 OBS、创建窗口或加载捕获插件。
add_executable(lycansync-game-failure-tests EXCLUDE_FROM_ALL tests/game_failure.cpp)
target_compile_features(lycansync-game-failure-tests PRIVATE cxx_std_20)
target_compile_options(lycansync-game-failure-tests PRIVATE /utf-8)
target_link_libraries(lycansync-game-failure-tests PRIVATE lycansync_libobs user32)
set_target_properties(lycansync-game-failure-tests PROPERTIES RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}/test-tools")

# 只替换身份与插件查询，不初始化 OBS、加载采集插件或操作真实窗口。
add_executable(lycansync-window-failure-tests EXCLUDE_FROM_ALL tests/window_failure.cpp)
target_compile_features(lycansync-window-failure-tests PRIVATE cxx_std_20)
target_compile_options(lycansync-window-failure-tests PRIVATE /utf-8)
target_link_libraries(lycansync-window-failure-tests PRIVATE lycansync_libobs user32 windowsapp)
set_target_properties(lycansync-window-failure-tests PROPERTIES RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}/test-tools")

# 仅执行合成查询结果，不创建 D3D 设备、OBS 来源或真实纹理。
add_executable(lycansync-gpu-frame-wait-tests EXCLUDE_FROM_ALL tests/gpu_frame_wait.cpp)
target_compile_features(lycansync-gpu-frame-wait-tests PRIVATE cxx_std_20)
target_compile_definitions(lycansync-gpu-frame-wait-tests PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX)
target_compile_options(lycansync-gpu-frame-wait-tests PRIVATE /utf-8)
set_target_properties(lycansync-gpu-frame-wait-tests PROPERTIES RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}/test-tools")

# 只测试合成 PCM 的分块与背压，不链接或初始化 OBS/WASAPI。
add_executable(lycansync-screen-audio-pcm-tests EXCLUDE_FROM_ALL tests/screen_audio_pcm.cpp src/screen_audio_pcm.cpp)
target_compile_features(lycansync-screen-audio-pcm-tests PRIVATE cxx_std_20)
target_compile_options(lycansync-screen-audio-pcm-tests PRIVATE /utf-8)
target_include_directories(lycansync-screen-audio-pcm-tests PRIVATE src)
set_target_properties(lycansync-screen-audio-pcm-tests PROPERTIES RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}/test-tools")
