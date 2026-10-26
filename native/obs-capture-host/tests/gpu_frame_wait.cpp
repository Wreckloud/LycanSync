#include "../src/gpu_frame_wait.h"
#include <cstdio>

struct Query {};
struct Context {
  HRESULT result = S_OK;
  int pending = 0;
  int ended = 0;
  int flushed = 0;
  int checked = 0;
  bool valid = true;
  void End(Query *) { ++ended; }
  void Flush() { ++flushed; }
  HRESULT GetData(Query *, void *output, UINT size, UINT flags) {
    ++checked;
    valid = valid && !output && size == 0 && flags == D3D11_ASYNC_GETDATA_DONOTFLUSH;
    return pending-- > 0 ? S_FALSE : result;
  }
};

#define CHECK(condition) do { if (!(condition)) { std::fprintf(stderr, "GPU wait check failed at line %d\n", __LINE__); return 1; } } while (0)
int main() {
  Query query;
  Context ready;
  CHECK(wait_for_gpu_frame(&ready, &query, std::chrono::milliseconds(50)) == S_OK);
  CHECK(ready.ended == 1 && ready.flushed == 1 && ready.checked == 1 && ready.valid);
  Context delayed;
  delayed.pending = 2;
  CHECK(wait_for_gpu_frame(&delayed, &query, std::chrono::milliseconds(1000)) == S_OK);
  CHECK(delayed.checked == 3 && delayed.flushed == 1 && delayed.valid);
  Context timeout;
  timeout.result = S_FALSE;
  CHECK(wait_for_gpu_frame(&timeout, &query, std::chrono::milliseconds(3)) == S_FALSE);
  CHECK(timeout.checked > 0 && timeout.flushed == 1 && timeout.valid);
  Context removed;
  removed.result = DXGI_ERROR_DEVICE_REMOVED;
  CHECK(wait_for_gpu_frame(&removed, &query, std::chrono::milliseconds(50)) == DXGI_ERROR_DEVICE_REMOVED);
  CHECK(removed.checked == 1 && removed.flushed == 1 && removed.valid);
  std::puts("GPU completion, timeout and device-error checks passed");
  return 0;
}
