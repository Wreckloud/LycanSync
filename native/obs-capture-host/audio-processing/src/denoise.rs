use std::{ffi::c_void, ptr::NonNull, sync::Once};

use crate::processor::FRAMES_PER_CHUNK;

static INITIALIZE_TABLES: Once = Once::new();

unsafe extern "C" {
    fn rnnoise_create(model: *mut c_void) -> *mut c_void;
    fn rnnoise_destroy(state: *mut c_void);
    fn lycan_rnnoise_process_frame(state: *mut c_void, output: *mut f32, input: *const f32) -> f32;
}

pub(super) struct Denoiser {
    state: NonNull<c_void>,
    previous_input: [f32; FRAMES_PER_CHUNK],
    mix: f32,
}

impl Denoiser {
    pub(super) fn new(enabled: bool) -> Option<Self> {
        // 空模型参数使用随源静态编译的默认模型；实例只由此处理器串行持有。
        let state = NonNull::new(unsafe { rnnoise_create(std::ptr::null_mut()) })?;
        // 上游首次处理会写入共享 FFT 表；完成一次静音初始化后才允许并行实例处理。
        INITIALIZE_TABLES.call_once(|| {
            let silence = [0.0; FRAMES_PER_CHUNK];
            let mut output = silence;
            unsafe {
                lycan_rnnoise_process_frame(state.as_ptr(), output.as_mut_ptr(), silence.as_ptr());
            }
        });
        Some(Self {
            state,
            previous_input: [0.0; FRAMES_PER_CHUNK],
            mix: f32::from(enabled),
        })
    }

    pub(super) fn process(
        &mut self,
        input: &[f32; FRAMES_PER_CHUNK],
        enabled: bool,
    ) -> [f32; FRAMES_PER_CHUNK] {
        let scaled = input.map(|sample| sample * 32768.0);
        let mut output = [0.0; FRAMES_PER_CHUNK];
        // 关闭时也保持模型历史，避免重新开启带出旧声音；干声延迟一帧与 RNNoise 对齐。
        unsafe {
            lycan_rnnoise_process_frame(self.state.as_ptr(), output.as_mut_ptr(), scaled.as_ptr());
        }
        let target = f32::from(enabled);
        let start = self.mix;
        for (index, sample) in output.iter_mut().enumerate() {
            let mix = start + (target - start) * (index + 1) as f32 / FRAMES_PER_CHUNK as f32;
            *sample = self.previous_input[index] * (1.0 - mix) + *sample / 32768.0 * mix;
        }
        self.previous_input = *input;
        self.mix = target;
        output
    }
}

impl Drop for Denoiser {
    fn drop(&mut self) {
        // 调用方停止处理后销毁，C 状态及内部缓冲在同一处释放。
        unsafe {
            rnnoise_destroy(self.state.as_ptr());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_arch = "x86_64")]
    #[test]
    #[allow(deprecated)]
    fn processing_restores_the_callers_floating_point_control_flags() {
        let before = unsafe { std::arch::x86_64::_mm_getcsr() };
        let mut denoiser = Denoiser::new(true).unwrap();
        denoiser.process(&[0.1; FRAMES_PER_CHUNK], true);
        let after = unsafe { std::arch::x86_64::_mm_getcsr() };
        // 忽略计算本身产生的异常状态位，只核对线程控制模式。
        assert_eq!(before & 0xffc0, after & 0xffc0);
    }

    #[test]
    fn bypass_preserves_every_sample_with_one_frame_delay() {
        let mut denoiser = Denoiser::new(false).unwrap();
        let mut previous = [0.0; FRAMES_PER_CHUNK];
        for block in 0..30 {
            let input = std::array::from_fn(|index| {
                ((block * FRAMES_PER_CHUNK + index) as f32 * 0.03).sin() * 0.1
            });
            assert_eq!(denoiser.process(&input, false), previous);
            previous = input;
        }
        assert_eq!(denoiser.process(&[0.0; FRAMES_PER_CHUNK], false), previous);
    }

    #[test]
    fn toggling_keeps_history_and_reaches_the_current_signal_without_a_reset() {
        let mut toggled = Denoiser::new(false).unwrap();
        let mut continuous = Denoiser::new(true).unwrap();
        let mut previous = [0.0; FRAMES_PER_CHUNK];
        for block in 0..100 {
            let input = std::array::from_fn(|index| {
                ((block * FRAMES_PER_CHUNK + index) as f32 * 0.04).sin() * 0.1
            });
            let enabled = block % 4 < 2;
            let output = toggled.process(&input, enabled);
            let wet = continuous.process(&input, true);
            let target = if enabled { wet } else { previous };
            assert_eq!(output[FRAMES_PER_CHUNK - 1], target[FRAMES_PER_CHUNK - 1]);
            if block % 2 == 1 {
                assert_eq!(output, target);
            }
            assert!(output.iter().all(|sample| sample.is_finite()));
            previous = input;
        }
    }
}
