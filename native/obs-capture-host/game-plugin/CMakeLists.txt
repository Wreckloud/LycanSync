set(LYCANSYNC_OBS_SOURCE "" CACHE PATH "Verified and patched OBS 32.2.2 source directory")
set(LYCANSYNC_OBS_DEPS "" CACHE PATH "Verified OBS 32.2.2 Windows build dependencies")
set(capture_source "${LYCANSYNC_OBS_SOURCE}/plugins/win-capture")
if(NOT EXISTS "${capture_source}/game-capture.c" OR NOT EXISTS "${LYCANSYNC_OBS_DEPS}/lib/jansson.lib")
  message(FATAL_ERROR "Prepare the pinned game plugin with build.ps1")
endif()
file(READ "${capture_source}/game-capture.c" game_capture_source)
if(NOT game_capture_source MATCHES "lycan_game_capture_get_target")
  message(FATAL_ERROR "The exact-window patch must be applied before building the game plugin")
endif()

# 编译固定上游插件及其真实依赖，不复制采集算法，不重编官方图形钩子或注入辅助程序。
add_library(lycansync-bound-win-capture MODULE
  "${capture_source}/app-helpers.c"
  "${capture_source}/audio-helpers.c"
  "${capture_source}/compat-helpers.c"
  "${capture_source}/cursor-capture.c"
  "${capture_source}/dc-capture.c"
  "${capture_source}/duplicator-monitor-capture.c"
  "${capture_source}/game-capture-file-init.c"
  "${capture_source}/game-capture.c"
  "${capture_source}/load-graphics-offsets.c"
  "${capture_source}/monitor-capture.c"
  "${capture_source}/nt-stuff.c"
  "${capture_source}/plugin-main.c"
  "${capture_source}/window-capture.c"
  "${LYCANSYNC_OBS_SOURCE}/libobs/util/windows/obfuscate.c"
  "${LYCANSYNC_OBS_SOURCE}/shared/obs-inject-library/inject-library.c"
  "${LYCANSYNC_OBS_SOURCE}/shared/ipc-util/ipc-util/pipe-windows.c"
  "${LYCANSYNC_OBS_SOURCE}/shared/file-updater/file-updater/file-updater.c"
  ../src/bound_game_target.c)
target_compile_features(lycansync-bound-win-capture PRIVATE c_std_11)
target_compile_options(lycansync-bound-win-capture PRIVATE /utf-8)
target_compile_definitions(lycansync-bound-win-capture PRIVATE
  UNICODE _UNICODE OBS_VERSION="32.2.2" COMPAT_URL="https://obsproject.com/obs2_update/win-capture" ENABLE_COMPAT_UPDATES)
target_include_directories(lycansync-bound-win-capture PRIVATE
  ../src "${LYCANSYNC_OBS_DEPS}/include" "${LYCANSYNC_OBS_SOURCE}/deps/w32-pthreads"
  "${LYCANSYNC_OBS_SOURCE}/libobs-winrt"
  "${LYCANSYNC_OBS_SOURCE}/shared/obs-hook-config" "${LYCANSYNC_OBS_SOURCE}/shared/obs-inject-library"
  "${LYCANSYNC_OBS_SOURCE}/shared/ipc-util" "${LYCANSYNC_OBS_SOURCE}/shared/file-updater")
target_link_libraries(lycansync-bound-win-capture PRIVATE lycansync_libobs
  "${LYCANSYNC_OBS_DEPS}/lib/jansson.lib" "${LYCANSYNC_OBS_DEPS}/lib/libcurl_imp.lib"
  "${LYCANSYNC_OBS_SDK}/lib/w32-pthreads.lib" advapi32 gdi32 shell32 ole32 version)
target_link_options(lycansync-bound-win-capture PRIVATE /IGNORE:4098)
set_target_properties(lycansync-bound-win-capture PROPERTIES
  OUTPUT_NAME "win-capture" PREFIX ""
  LIBRARY_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}/game-plugin")

add_executable(lycansync-bound-game-target-tests EXCLUDE_FROM_ALL ../tests/bound_game_target.c ../src/bound_game_target.c)
target_compile_features(lycansync-bound-game-target-tests PRIVATE c_std_11)
target_compile_options(lycansync-bound-game-target-tests PRIVATE /utf-8)
target_include_directories(lycansync-bound-game-target-tests PRIVATE ../src)
target_link_libraries(lycansync-bound-game-target-tests PRIVATE lycansync_libobs user32)
set_target_properties(lycansync-bound-game-target-tests PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}/test-tools")
