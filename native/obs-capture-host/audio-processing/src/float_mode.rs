unsafe extern "C" {
    fn lycan_voice_float_mode_begin() -> u32;
    fn lycan_voice_float_mode_end(previous: u32);
}

// 仅在当前 DSP 调用内处理极小残值，离开作用域后恢复调用线程的浮点模式。
pub(super) struct FloatMode(u32);

impl FloatMode {
    pub(super) fn new() -> Self {
        Self(unsafe { lycan_voice_float_mode_begin() })
    }
}

impl Drop for FloatMode {
    fn drop(&mut self) {
        unsafe { lycan_voice_float_mode_end(self.0) };
    }
}

#[cfg(all(test, target_arch = "x86_64"))]
mod tests {
    use super::*;

    #[test]
    #[allow(deprecated)]
    fn restores_enabled_and_disabled_callers_including_status_flags() {
        use std::arch::x86_64::{_mm_getcsr, _mm_setcsr};

        let original = unsafe { _mm_getcsr() };
        let baseline = original & !0x3f;
        let mut observed = Vec::new();
        for previous in [baseline & !0x8040, baseline | 0x8040] {
            unsafe { _mm_setcsr(previous) };
            let active;
            {
                let _mode = FloatMode::new();
                active = unsafe { _mm_getcsr() };
                unsafe { _mm_setcsr(active | 0x20) };
            }
            observed.push((previous, active, unsafe { _mm_getcsr() }));
        }
        unsafe { _mm_setcsr(original) };

        for (previous, active, restored) in observed {
            assert_eq!(active & 0x8040, 0x8040);
            assert_eq!(restored, previous);
        }
    }
}
