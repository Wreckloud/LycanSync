use sonora::{AudioProcessing, Config, StreamConfig, config::EchoCanceller};

use crate::processor::{FRAMES_PER_CHUNK, SAMPLE_RATE};

unsafe extern "C" {
    fn lycan_voice_float_mode_begin() -> u32;
    fn lycan_voice_float_mode_end(previous: u32);
}

// AEC 的滤波历史同样会产生极小残值；只改变当前调用，不能污染 OBS 音频线程。
struct FloatMode(u32);

impl FloatMode {
    fn new() -> Self {
        Self(unsafe { lycan_voice_float_mode_begin() })
    }
}

impl Drop for FloatMode {
    fn drop(&mut self) {
        unsafe { lycan_voice_float_mode_end(self.0) };
    }
}

// 回声状态只属于当前播放设备；换设备或参考断流后由调用方销毁重建。
pub(super) struct EchoProcessor {
    processing: AudioProcessing,
    delay_ms: i32,
}

impl EchoProcessor {
    pub(super) fn new() -> Self {
        let stream = StreamConfig::new(SAMPLE_RATE, 1);
        Self {
            processing: AudioProcessing::builder()
                .config(Config {
                    echo_canceller: Some(EchoCanceller::default()),
                    ..Config::default()
                })
                .capture_config(stream)
                .render_config(stream)
                .build(),
            delay_ms: 0,
        }
    }

    pub(super) fn set_delay(&mut self, delay_ms: i32) -> bool {
        if !(0..=500).contains(&delay_ms) {
            return false;
        }
        self.delay_ms = delay_ms;
        true
    }

    pub(super) fn render(&mut self, input: &[f32; FRAMES_PER_CHUNK]) {
        let _float_mode = FloatMode::new();
        let mut output = [0.0; FRAMES_PER_CHUNK];
        self.processing
            .process_render_f32(&[&input[..]], &mut [&mut output[..]])
            .expect("fixed 48 kHz mono echo reference format");
    }

    pub(super) fn capture(&mut self, input: &[f32; FRAMES_PER_CHUNK]) -> [f32; FRAMES_PER_CHUNK] {
        let _float_mode = FloatMode::new();
        let mut output = [0.0; FRAMES_PER_CHUNK];
        self.processing
            .set_stream_delay_ms(self.delay_ms)
            .expect("validated echo delay");
        self.processing
            .process_capture_f32(&[&input[..]], &mut [&mut output[..]])
            .expect("fixed 48 kHz mono echo capture format");
        output
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancels_delayed_reference_and_rejects_invalid_delay() {
        let mut echo = EchoProcessor::new();
        assert!(!echo.set_delay(-1));
        assert!(!echo.set_delay(501));
        assert!(echo.set_delay(0));
        let mut history = [[0.0; FRAMES_PER_CHUNK]; 5];
        let mut seed = 17u32;
        let mut input_energy = 0.0f64;
        let mut output_energy = 0.0f64;
        for block in 0..800 {
            let input = std::array::from_fn(|_| {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                ((seed >> 8) as f32 / 16777216.0 - 0.5) * 0.2
            });
            let capture = history[block % 5].map(|sample| sample * 0.6);
            history[block % 5] = input;
            echo.render(&input);
            let output = echo.capture(&capture);
            assert!(output.iter().all(|sample| sample.is_finite()));
            if block >= 600 {
                input_energy += capture
                    .iter()
                    .map(|sample| f64::from(*sample).powi(2))
                    .sum::<f64>();
                output_energy += output
                    .iter()
                    .map(|sample| f64::from(*sample).powi(2))
                    .sum::<f64>();
            }
        }
        assert!(
            output_energy < input_energy * 0.1,
            "echo energy {output_energy} was not suppressed from {input_energy}"
        );
    }
}
