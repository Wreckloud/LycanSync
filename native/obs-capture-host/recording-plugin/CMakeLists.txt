set(ffmpeg_source "${LYCANSYNC_OBS_SOURCE}/plugins/obs-ffmpeg")
set(playback_source "${LYCANSYNC_OBS_SOURCE}/shared/media-playback")
set(options_source "${LYCANSYNC_OBS_SOURCE}/shared/opts-parser")
file(READ "${ffmpeg_source}/obs-ffmpeg-mux.c" mux_source)
if(NOT mux_source MATCHES "video_t \\*video = obs_encoder_video\\(vencoder\\)")
  message(FATAL_ERROR "Apply the encoder-video mux patch before building")
endif()

# 重建同一官方模块；只修正封装参数来源，不保留另一套输出或编码实现。
add_library(lycansync-obs-ffmpeg MODULE
  "${ffmpeg_source}/obs-ffmpeg.c"
  "${ffmpeg_source}/obs-ffmpeg-audio-encoders.c"
  "${ffmpeg_source}/obs-ffmpeg-av1.c"
  "${ffmpeg_source}/obs-ffmpeg-openh264.c"
  "${ffmpeg_source}/obs-ffmpeg-hls-mux.c"
  "${ffmpeg_source}/obs-ffmpeg-mux.c"
  "${ffmpeg_source}/obs-ffmpeg-output.c"
  "${ffmpeg_source}/obs-ffmpeg-source.c"
  "${ffmpeg_source}/obs-ffmpeg-video-encoders.c"
  "${ffmpeg_source}/texture-amf.cpp"
  "${playback_source}/media-playback/cache.c"
  "${playback_source}/media-playback/decode.c"
  "${playback_source}/media-playback/media.c"
  "${playback_source}/media-playback/media-playback.c"
  "${options_source}/opts-parser.c")
target_compile_features(lycansync-obs-ffmpeg PRIVATE c_std_11 cxx_std_17)
target_compile_options(lycansync-obs-ffmpeg PRIVATE /utf-8)
target_compile_definitions(lycansync-obs-ffmpeg PRIVATE UNICODE _UNICODE NOMINMAX)
target_include_directories(lycansync-obs-ffmpeg PRIVATE
  "${LYCANSYNC_OBS_DEPS}/include" "${LYCANSYNC_OBS_SOURCE}/deps/w32-pthreads"
  "${playback_source}" "${options_source}")
target_link_libraries(lycansync-obs-ffmpeg PRIVATE lycansync_libobs
  "${LYCANSYNC_OBS_SDK}/lib/w32-pthreads.lib"
  "${LYCANSYNC_OBS_DEPS}/lib/avcodec.lib" "${LYCANSYNC_OBS_DEPS}/lib/avformat.lib"
  "${LYCANSYNC_OBS_DEPS}/lib/avutil.lib" "${LYCANSYNC_OBS_DEPS}/lib/avfilter.lib"
  "${LYCANSYNC_OBS_DEPS}/lib/avdevice.lib" "${LYCANSYNC_OBS_DEPS}/lib/swscale.lib"
  "${LYCANSYNC_OBS_DEPS}/lib/swresample.lib" ws2_32 d3d11 dxgi)
set_target_properties(lycansync-obs-ffmpeg PROPERTIES OUTPUT_NAME "obs-ffmpeg" PREFIX ""
  LIBRARY_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}/recording-plugin")
