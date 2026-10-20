set(audio_source "${LYCANSYNC_OBS_SOURCE}/plugins/win-wasapi")
if(NOT EXISTS "${audio_source}/win-wasapi.cpp")
  message(FATAL_ERROR "Prepare the pinned audio plugin with build.ps1")
endif()
file(READ "${audio_source}/win-wasapi.cpp" audio_capture_source)
if(NOT audio_capture_source MATCHES "lycansync_audio_status"
   OR audio_capture_source MATCHES "ms_find_window\\(")
  message(FATAL_ERROR "The exact-process audio patch must be applied before building")
endif()

# 固定上游仍负责 WASAPI 初始化、采集和格式交付；自有补丁只约束来源和暴露真实状态。
add_library(lycansync-bound-win-wasapi MODULE
  "${audio_source}/win-wasapi.cpp"
  "${audio_source}/wasapi-notify.cpp"
  "${audio_source}/enum-wasapi.cpp"
  "${audio_source}/plugin-main.cpp"
  ../src/bound_audio_target.cpp)
target_compile_features(lycansync-bound-win-wasapi PRIVATE cxx_std_20)
target_compile_options(lycansync-bound-win-wasapi PRIVATE /utf-8)
target_compile_definitions(lycansync-bound-win-wasapi PRIVATE UNICODE _UNICODE NOMINMAX)
target_include_directories(lycansync-bound-win-wasapi PRIVATE ../src "${LYCANSYNC_OBS_SOURCE}/deps/w32-pthreads")
target_link_libraries(lycansync-bound-win-wasapi PRIVATE lycansync_libobs
  "${LYCANSYNC_OBS_SDK}/lib/w32-pthreads.lib" avrt ole32)
set_target_properties(lycansync-bound-win-wasapi PROPERTIES
  OUTPUT_NAME "win-wasapi" PREFIX ""
  LIBRARY_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}/audio-plugin")

add_executable(lycansync-bound-audio-target-tests EXCLUDE_FROM_ALL
  ../tests/bound_audio_target.cpp ../src/bound_audio_target.cpp)
target_compile_features(lycansync-bound-audio-target-tests PRIVATE cxx_std_20)
target_compile_definitions(lycansync-bound-audio-target-tests PRIVATE UNICODE _UNICODE NOMINMAX)
target_compile_options(lycansync-bound-audio-target-tests PRIVATE /utf-8)
target_include_directories(lycansync-bound-audio-target-tests PRIVATE ../src)
target_link_libraries(lycansync-bound-audio-target-tests PRIVATE lycansync_libobs user32)
set_target_properties(lycansync-bound-audio-target-tests PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}/test-tools")
