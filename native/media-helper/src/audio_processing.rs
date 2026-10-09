use sonora::config::{
    AdaptiveDigital, GainController2, HighPassFilter, MaxProcessingRate, NoiseSuppression,
    NoiseSuppressionLevel, Pipeline,
};
use sonora::{AudioProcessing, Config, StreamConfig};

pub(super) const SAMPLE_RATE: u32 = 48_000;
pub(super) const FRAMES_PER_CHUNK: usize = 480;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct ProcessingSettings {
    pub(super) input_gain: f32,
    pub(super) noise_suppression: bool,
    pub(super) auto_gain_control: bool,
    pub(super) voice_enhancement: bool,
}

impl Default for ProcessingSettings {
    fn default() -> Self {
        Self {
            input_gain: 1.0,
            noise_suppression: true,
            auto_gain_control: true,
            voice_enhancement: true,
        }
    }
}

pub(super) struct MicrophoneProcessor {
    settings: ProcessingSettings,
    audio_processing: AudioProcessing,
}

impl MicrophoneProcessor {
    pub(super) fn new(settings: ProcessingSettings) -> Self {
        let stream = StreamConfig::new(SAMPLE_RATE, 1);
        let audio_processing = AudioProcessing::builder()
            .config(processing_config(settings))
            .capture_config(stream)
            .render_config(stream)
            .build();
        Self {
            settings,
            audio_processing,
        }
    }

    pub(super) fn settings(&self) -> ProcessingSettings {
        self.settings
    }

    pub(super) fn set_settings(&mut self, settings: ProcessingSettings) {
        if self.settings == settings {
            return;
        }
        if self.settings.noise_suppression != settings.noise_suppression
            || self.settings.auto_gain_control != settings.auto_gain_control
            || self.settings.voice_enhancement != settings.voice_enhancement
        {
            self.audio_processing
                .apply_config(processing_config(settings));
        }
        self.settings = settings;
    }

    pub(super) fn process(&mut self, input: &[f32; FRAMES_PER_CHUNK]) -> [f32; FRAMES_PER_CHUNK] {
        let mut clean_input = *input;
        for sample in &mut clean_input {
            if !sample.is_finite() {
                *sample = 0.0;
            }
        }
        let mut output = [0.0_f32; FRAMES_PER_CHUNK];
        let source = [&clean_input[..]];
        let mut destination = [&mut output[..]];
        self.audio_processing
            .process_capture_f32(&source, &mut destination)
            .expect("fixed 48 kHz mono audio processing format");
        for sample in &mut output {
            *sample = if sample.is_finite() {
                // Apply user gain after AGC so automatic gain does not cancel the preference.
                (*sample * self.settings.input_gain).clamp(-1.0, 1.0)
            } else {
                0.0
            };
        }
        output
    }
}

fn processing_config(settings: ProcessingSettings) -> Config {
    Config {
        pipeline: Pipeline {
            maximum_internal_processing_rate: MaxProcessingRate::Rate48kHz,
            ..Pipeline::default()
        },
        high_pass_filter: settings.voice_enhancement.then(HighPassFilter::default),
        noise_suppression: settings.noise_suppression.then(|| NoiseSuppression {
            level: NoiseSuppressionLevel::Moderate,
            ..NoiseSuppression::default()
        }),
        gain_controller2: settings.auto_gain_control.then(|| GainController2 {
            adaptive_digital: Some(AdaptiveDigital::default()),
            ..GainController2::default()
        }),
        ..Config::default()
    }
}

#[cfg(test)]
mod tests {
    use super::{FRAMES_PER_CHUNK, MicrophoneProcessor, ProcessingSettings, SAMPLE_RATE};
    use std::time::Instant;

    fn rms(samples: &[f32]) -> f32 {
        (samples.iter().map(|sample| sample * sample).sum::<f32>() / samples.len() as f32).sqrt()
    }

    fn tone(amplitude: f32, frequency: f32, block: usize) -> [f32; FRAMES_PER_CHUNK] {
        std::array::from_fn(|index| {
            let frame = block * FRAMES_PER_CHUNK + index;
            amplitude
                * (2.0 * std::f32::consts::PI * frequency * frame as f32 / SAMPLE_RATE as f32).sin()
        })
    }

    #[test]
    fn handles_silence_non_finite_values_and_input_gain_without_changing_chunk_size() {
        let mut processor = MicrophoneProcessor::new(ProcessingSettings {
            input_gain: 0.5,
            noise_suppression: false,
            auto_gain_control: false,
            voice_enhancement: false,
        });
        let mut input = [0.0; FRAMES_PER_CHUNK];
        input[0] = f32::NAN;
        input[1] = f32::INFINITY;
        let silence = processor.process(&input);
        assert_eq!(silence.len(), FRAMES_PER_CHUNK);
        assert!(
            silence
                .iter()
                .all(|sample| sample.is_finite() && *sample == 0.0)
        );

        let quiet = processor.process(&[0.2; FRAMES_PER_CHUNK]);
        assert!(quiet.iter().all(|sample| (*sample - 0.1).abs() < 1e-6));
        let mut processor = MicrophoneProcessor::new(ProcessingSettings {
            input_gain: 2.0,
            noise_suppression: false,
            auto_gain_control: false,
            voice_enhancement: false,
        });
        let loud = processor.process(&[0.8; FRAMES_PER_CHUNK]);
        assert!(loud.iter().all(|sample| *sample == 1.0));
    }

    #[test]
    fn noise_suppression_reduces_stationary_noise_while_preserving_voice_energy() {
        let mut processor = MicrophoneProcessor::new(ProcessingSettings {
            input_gain: 1.0,
            noise_suppression: false,
            auto_gain_control: false,
            voice_enhancement: false,
        });
        let mut random_state = 0x5EED_u32;
        let mut noise = [0.0; FRAMES_PER_CHUNK];
        let mut speech = [0.0; FRAMES_PER_CHUNK];
        let mut voice_and_noise = [0.0; FRAMES_PER_CHUNK];
        let mut noise_output = [0.0; FRAMES_PER_CHUNK];
        let mut noise_input = [0.0; FRAMES_PER_CHUNK];
        for block in 0..250 {
            if block == 1 {
                processor.set_settings(ProcessingSettings {
                    noise_suppression: true,
                    ..processor.settings()
                });
            }
            for index in 0..FRAMES_PER_CHUNK {
                random_state = random_state
                    .wrapping_mul(1_664_525)
                    .wrapping_add(1_013_904_223);
                let hiss = ((random_state >> 8) as f32 / 16_777_215.0 - 0.5) * 0.16;
                let frame = block * FRAMES_PER_CHUNK + index;
                let voice = if block >= 150 {
                    let time = frame as f32 / SAMPLE_RATE as f32;
                    synthetic_voice(time)
                } else {
                    0.0
                };
                noise[index] = hiss;
                speech[index] = voice;
                voice_and_noise[index] = voice + hiss;
            }
            if block < 150 {
                let output = processor.process(&noise);
                if block >= 140 {
                    noise_output = output;
                    noise_input = noise;
                }
            } else {
                voice_and_noise = processor.process(&voice_and_noise);
            }
        }
        assert!(
            rms(&noise_output) < rms(&noise_input) * 0.92,
            "noise RMS {} was not reduced from {}",
            rms(&noise_output),
            rms(&noise_input)
        );
        assert!(
            rms(&voice_and_noise) > 0.03,
            "voice output RMS {} lost too much energy from speech {}, noise {}",
            rms(&voice_and_noise),
            rms(&speech),
            rms(&noise)
        );
        assert!(
            voice_and_noise
                .iter()
                .all(|sample| sample.is_finite() && sample.abs() <= 1.0)
        );
    }

    #[test]
    fn processor_instances_reset_and_process_ten_millisecond_blocks_in_real_time() {
        let started = Instant::now();
        for _ in 0..8 {
            let mut processor = MicrophoneProcessor::new(ProcessingSettings::default());
            for block in 0..100 {
                let input = tone(0.1, 180.0, block);
                let output = processor.process(&input);
                assert_eq!(output.len(), FRAMES_PER_CHUNK);
                assert!(output.iter().all(|sample| sample.is_finite()));
            }
            assert_eq!(processor.settings(), ProcessingSettings::default());
        }
        let elapsed = started.elapsed();
        let average_block_ms = elapsed.as_secs_f64() * 1_000.0 / (8.0 * 100.0);
        assert!(
            average_block_ms < 10.0,
            "average 10 ms block took {average_block_ms:.3} ms ({elapsed:?} total)"
        );
    }

    fn synthetic_voice(time: f32) -> f32 {
        let fundamental_hz = 125.0 + 12.0 * (2.0 * std::f32::consts::PI * 4.0 * time).sin();
        let envelope = 0.25 + 0.75 * (2.0 * std::f32::consts::PI * 2.2 * time).sin().abs();
        let mut voiced = 0.0;
        for harmonic in 1..=32 {
            let frequency = fundamental_hz * harmonic as f32;
            let formant = [700.0_f32, 1_400.0, 2_500.0]
                .iter()
                .map(|center| (-((frequency - center) / (center * 0.18)).powi(2)).exp())
                .sum::<f32>();
            let harmonic_amplitude = formant / harmonic as f32;
            voiced += harmonic_amplitude * (2.0 * std::f32::consts::PI * frequency * time).sin();
        }
        envelope * voiced * 1.2
    }

    #[test]
    fn processing_is_continuous_across_adjacent_tone_blocks() {
        let mut processor = MicrophoneProcessor::new(ProcessingSettings::default());
        let first = processor.process(&tone(0.05, 220.0, 30));
        let second = processor.process(&tone(0.05, 220.0, 31));
        let boundary = (second[0] - first[FRAMES_PER_CHUNK - 1]).abs();
        assert!(boundary < 0.05, "boundary discontinuity was {boundary}");
    }

    #[test]
    fn automatic_gain_control_raises_quiet_voice_and_limits_sudden_loud_input() {
        let mut automatic_gain = MicrophoneProcessor::new(ProcessingSettings {
            input_gain: 1.0,
            noise_suppression: false,
            auto_gain_control: true,
            voice_enhancement: false,
        });
        let mut fixed_gain = MicrophoneProcessor::new(ProcessingSettings {
            input_gain: 1.0,
            noise_suppression: false,
            auto_gain_control: false,
            voice_enhancement: false,
        });
        let mut automatic_output = [0.0; FRAMES_PER_CHUNK];
        let mut fixed_output = [0.0; FRAMES_PER_CHUNK];
        for block in 0..500 {
            let quiet = tone(0.003, 220.0, block);
            automatic_output = automatic_gain.process(&quiet);
            fixed_output = fixed_gain.process(&quiet);
        }
        assert!(rms(&automatic_output) > rms(&fixed_output) * 1.5);

        for block in 500..520 {
            automatic_output = automatic_gain.process(&tone(1.5, 220.0, block));
        }
        assert!(
            automatic_output
                .iter()
                .all(|sample| sample.is_finite() && sample.abs() <= 1.0)
        );
    }

    #[test]
    fn automatic_gain_control_toggle_changes_level_and_can_be_restored_during_capture() {
        let initial = ProcessingSettings {
            input_gain: 1.0,
            noise_suppression: false,
            auto_gain_control: false,
            voice_enhancement: false,
        };
        let mut toggled = MicrophoneProcessor::new(initial);
        let mut fixed = MicrophoneProcessor::new(initial);
        let mut auto_output = [0.0; FRAMES_PER_CHUNK];
        let mut fixed_output = [0.0; FRAMES_PER_CHUNK];

        for block in 0..500 {
            if block == 1 {
                toggled.set_settings(ProcessingSettings {
                    auto_gain_control: true,
                    ..initial
                });
            }
            let input = tone(0.003, 220.0, block);
            auto_output = toggled.process(&input);
            fixed_output = fixed.process(&input);
        }
        assert!(rms(&auto_output) > rms(&fixed_output) * 1.5);

        toggled.set_settings(initial);
        let input = tone(0.003, 220.0, 500);
        let restored_output = toggled.process(&input);
        let fixed_output = fixed.process(&input);
        assert_eq!(restored_output.len(), FRAMES_PER_CHUNK);
        assert!(
            restored_output
                .iter()
                .zip(fixed_output)
                .all(|(restored, fixed)| (restored - fixed).abs() < 1e-6)
        );
    }

    #[test]
    fn applying_identical_settings_and_input_gain_keeps_warmed_processing_state() {
        let initial = ProcessingSettings::default();
        let mut updated = MicrophoneProcessor::new(initial);
        let mut unchanged = MicrophoneProcessor::new(initial);
        for block in 0..300 {
            let input = tone(0.01, 220.0, block);
            updated.process(&input);
            unchanged.process(&input);
        }

        updated.set_settings(initial);
        updated.set_settings(ProcessingSettings {
            input_gain: 0.5,
            ..initial
        });
        let input = tone(0.01, 220.0, 300);
        let updated_output = updated.process(&input);
        let unchanged_output = unchanged.process(&input);

        assert_eq!(updated_output.len(), FRAMES_PER_CHUNK);
        assert_eq!(SAMPLE_RATE, 48_000);
        assert_eq!(updated.settings().input_gain, 0.5);
        for (updated, unchanged) in updated_output.iter().zip(unchanged_output) {
            assert!((*updated - unchanged * 0.5).abs() < 1e-6);
        }
    }

    #[test]
    fn processing_options_can_be_toggled_and_restored_without_changing_chunk_format() {
        let initial = ProcessingSettings {
            input_gain: 1.0,
            noise_suppression: false,
            auto_gain_control: false,
            voice_enhancement: false,
        };
        let mut processor = MicrophoneProcessor::new(initial);
        let settings = [
            ProcessingSettings {
                noise_suppression: true,
                ..initial
            },
            ProcessingSettings {
                auto_gain_control: true,
                ..initial
            },
            ProcessingSettings {
                voice_enhancement: true,
                ..initial
            },
            initial,
        ];

        for (block, settings) in settings.into_iter().enumerate() {
            processor.set_settings(settings);
            let output = processor.process(&tone(0.1, 120.0, block));
            assert_eq!(output.len(), FRAMES_PER_CHUNK);
            assert!(output.iter().all(|sample| sample.is_finite()));
            assert_eq!(processor.settings(), settings);
            assert_eq!(output.len(), SAMPLE_RATE as usize / 100);
        }
        assert_eq!(processor.settings(), initial);
    }

    #[test]
    fn voice_enhancement_toggle_applies_the_high_pass_filter() {
        let mut processor = MicrophoneProcessor::new(ProcessingSettings {
            input_gain: 1.0,
            noise_suppression: false,
            auto_gain_control: false,
            voice_enhancement: false,
        });
        let mut without_filter = [0.0; FRAMES_PER_CHUNK];
        let mut with_filter = [0.0; FRAMES_PER_CHUNK];
        for block in 0..260 {
            let input = tone(0.1, 50.0, block);
            let output = processor.process(&input);
            if block == 99 {
                without_filter = output;
            }
            if block == 100 {
                processor.set_settings(ProcessingSettings {
                    voice_enhancement: true,
                    ..processor.settings()
                });
            }
            if block >= 250 {
                with_filter = output;
            }
        }
        assert!(
            rms(&with_filter) < rms(&without_filter) * 0.99,
            "high-pass output RMS {} did not fall below unfiltered RMS {}",
            rms(&with_filter),
            rms(&without_filter)
        );
    }
}
