set(graphics_source "${LYCANSYNC_OBS_SOURCE}/libobs-d3d11")
if(NOT EXISTS "${graphics_source}/d3d11-duplicator.cpp")
  message(FATAL_ERROR "Prepare the pinned DXGI module with build.ps1")
endif()
file(READ "${graphics_source}/d3d11-duplicator.cpp" duplicator_source)
if(NOT duplicator_source MATCHES "lycansyncDxgiApi")
  message(FATAL_ERROR "Apply the DXGI compatibility patch before building")
endif()

# 沿用固定 OBS 图形模块，仅补齐同一 DXGI 路径的接口兼容边界。
add_library(lycansync-obs-d3d11 MODULE
  "${graphics_source}/d3d11-duplicator.cpp"
  "${graphics_source}/d3d11-indexbuffer.cpp"
  "${graphics_source}/d3d11-rebuild.cpp"
  "${graphics_source}/d3d11-samplerstate.cpp"
  "${graphics_source}/d3d11-shader.cpp"
  "${graphics_source}/d3d11-shaderprocessor.cpp"
  "${graphics_source}/d3d11-stagesurf.cpp"
  "${graphics_source}/d3d11-subsystem.cpp"
  "${graphics_source}/d3d11-texture2d.cpp"
  "${graphics_source}/d3d11-texture3d.cpp"
  "${graphics_source}/d3d11-vertexbuffer.cpp"
  "${graphics_source}/d3d11-zstencilbuffer.cpp")
target_compile_features(lycansync-obs-d3d11 PRIVATE cxx_std_17)
target_compile_options(lycansync-obs-d3d11 PRIVATE /utf-8)
target_compile_definitions(lycansync-obs-d3d11 PRIVATE UNICODE _UNICODE NOMINMAX GPU_PRIORITY_VAL=0)
target_link_libraries(lycansync-obs-d3d11 PRIVATE lycansync_libobs d3d9 d3d11 d3dcompiler dxgi shcore)
set_target_properties(lycansync-obs-d3d11 PROPERTIES
  OUTPUT_NAME "libobs-d3d11" PREFIX ""
  LIBRARY_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}/graphics-module")
