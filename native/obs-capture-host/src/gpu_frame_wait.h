#pragma once

#include <d3d11.h>
#include <chrono>

// 类型参数仅用于隔离 GPU 查询回归；正式调用仍直接使用 D3D11 接口，不增加运行时回调。
template <typename Context, typename Query>
HRESULT wait_for_gpu_frame(Context *context, Query *query, std::chrono::milliseconds timeout) {
  context->End(query);
  context->Flush();
  const auto deadline = std::chrono::steady_clock::now() + timeout;
  while (true) {
    const HRESULT result = context->GetData(query, nullptr, 0, D3D11_ASYNC_GETDATA_DONOTFLUSH);
    if (result != S_FALSE) return result;
    if (std::chrono::steady_clock::now() >= deadline) return S_FALSE;
    Sleep(1);
  }
}
