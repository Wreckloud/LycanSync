#include "rnnoise.h"

#if defined(_M_X64) || defined(__x86_64__)
#include <xmmintrin.h>
#endif

unsigned int lycan_voice_float_mode_begin(void)
{
#if defined(_M_X64) || defined(__x86_64__)
    // FTZ / DAZ 将静音后的极小残值归零，避免慢速浮点运算；结束后恢复调用线程。
    unsigned int previous = _mm_getcsr();
    _mm_setcsr(previous | 0x8040u);
    return previous;
#else
    return 0;
#endif
}

void lycan_voice_float_mode_end(unsigned int previous)
{
#if defined(_M_X64) || defined(__x86_64__)
    _mm_setcsr(previous);
#else
    (void)previous;
#endif
}

float lycan_rnnoise_process_frame(DenoiseState *state, float *output, const float *input)
{
    unsigned int previous = lycan_voice_float_mode_begin();
    float probability = rnnoise_process_frame(state, output, input);
    lycan_voice_float_mode_end(previous);
    return probability;
}
