//! OBS 音频滤镜的窄 FFI：复用 Sonora，10 ms 分块，不持有设备或管道。

mod processor;

use processor::{FRAMES_PER_CHUNK, MicrophoneProcessor, ProcessingSettings};

pub struct VoiceProcessor {
    processor: MicrophoneProcessor,
    input: [f32; FRAMES_PER_CHUNK],
    output: [f32; FRAMES_PER_CHUNK],
    cursor: usize,
}

fn settings(gain: f32, noise: u8, agc: u8, high_pass: u8) -> Option<ProcessingSettings> {
    if !gain.is_finite() || !(0.0..=2.0).contains(&gain) || noise > 1 || agc > 1 || high_pass > 1 {
        return None;
    }
    Some(ProcessingSettings {
        input_gain: gain,
        noise_suppression: noise == 1,
        auto_gain_control: agc == 1,
        voice_enhancement: high_pass == 1,
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn lycan_voice_create(
    gain: f32,
    noise: u8,
    agc: u8,
    high_pass: u8,
) -> *mut VoiceProcessor {
    let Some(settings) = settings(gain, noise, agc, high_pass) else {
        return std::ptr::null_mut();
    };
    Box::into_raw(Box::new(VoiceProcessor {
        processor: MicrophoneProcessor::new(settings),
        input: [0.0; FRAMES_PER_CHUNK],
        output: [0.0; FRAMES_PER_CHUNK],
        cursor: 0,
    }))
}

/// # Safety
/// ptr 必须来自 create，调用者串行访问且销毁期间不得使用。
#[unsafe(no_mangle)]
pub unsafe extern "C" fn lycan_voice_configure(
    ptr: *mut VoiceProcessor,
    gain: f32,
    noise: u8,
    agc: u8,
    high_pass: u8,
) -> bool {
    let Some(settings) = settings(gain, noise, agc, high_pass) else {
        return false;
    };
    let Some(state) = (unsafe { ptr.as_mut() }) else {
        return false;
    };
    state.processor.set_settings(settings);
    true
}

/// # Safety
/// samples 是 frames 个可写 f32，ptr 独占有效；双方内存不能重叠。
#[unsafe(no_mangle)]
pub unsafe extern "C" fn lycan_voice_process(
    ptr: *mut VoiceProcessor,
    samples: *mut f32,
    frames: u32,
) -> bool {
    if samples.is_null() || frames == 0 || frames > 48_000 {
        return false;
    }
    let Some(state) = (unsafe { ptr.as_mut() }) else {
        return false;
    };
    let samples = unsafe { std::slice::from_raw_parts_mut(samples, frames as usize) };
    // 固定延迟一块，适配 OBS 的可变块长，既不丢尾块也不改变交付帧数。
    for sample in samples {
        state.input[state.cursor] = *sample;
        *sample = state.output[state.cursor];
        state.cursor += 1;
        if state.cursor == FRAMES_PER_CHUNK {
            state.output = state.processor.process(&state.input);
            state.cursor = 0;
        }
    }
    true
}

/// # Safety
/// ptr 只能销毁一次，调用者已停止所有处理／配置回调。
#[unsafe(no_mangle)]
pub unsafe extern "C" fn lycan_voice_destroy(ptr: *mut VoiceProcessor) {
    if !ptr.is_null() {
        drop(unsafe { Box::from_raw(ptr) });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn variable_blocks_preserve_stream_and_user_gain_with_one_block_delay() {
        let state = lycan_voice_create(0.5, 0, 0, 0);
        assert!(!state.is_null());
        let mut values = vec![0.4; 2048];
        for block in values.chunks_mut(127) {
            assert!(unsafe { lycan_voice_process(state, block.as_mut_ptr(), block.len() as u32) });
        }
        assert!(values[..480].iter().all(|&value| value == 0.0));
        assert!(
            values[480..]
                .iter()
                .all(|&value| (value - 0.2).abs() < 1e-6)
        );
        assert!(!unsafe { lycan_voice_configure(state, f32::NAN, 0, 0, 0) });
        assert!(!unsafe { lycan_voice_process(state, std::ptr::null_mut(), 480) });
        unsafe { lycan_voice_destroy(state) };
    }

    #[test]
    fn invalid_configuration_does_not_create_a_processor() {
        assert!(lycan_voice_create(1.0, 2, 0, 0).is_null());
        assert!(lycan_voice_create(-1.0, 0, 0, 0).is_null());
    }
}
