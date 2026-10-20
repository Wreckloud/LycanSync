//! WASAPI 麦克风设备格式解析与采样转换；不创建任何采集会话。

use crate::protocol::ErrorCode;
use windows::Win32::Media::Audio::{WAVE_FORMAT_PCM, WAVEFORMATEX, WAVEFORMATEXTENSIBLE};
use windows::Win32::Media::KernelStreaming::{KSDATAFORMAT_SUBTYPE_PCM, WAVE_FORMAT_EXTENSIBLE};
use windows::Win32::Media::Multimedia::{KSDATAFORMAT_SUBTYPE_IEEE_FLOAT, WAVE_FORMAT_IEEE_FLOAT};

const WAVE_FORMAT_PCM_TAG: u16 = WAVE_FORMAT_PCM as u16;
const WAVE_FORMAT_IEEE_FLOAT_TAG: u16 = WAVE_FORMAT_IEEE_FLOAT as u16;
const WAVE_FORMAT_EXTENSIBLE_TAG: u16 = WAVE_FORMAT_EXTENSIBLE as u16;

pub(crate) unsafe fn sample_as_f32(
    data: *mut u8,
    sample_index: usize,
    format: &StreamFormat,
) -> Result<f32, ErrorCode> {
    unsafe {
        if format.encoding == SampleEncoding::IeeeFloat {
            return match format.bits_per_sample {
                32 => Ok(finite_sample(std::ptr::read_unaligned(
                    data.add(sample_index * 4).cast::<f32>(),
                ))),
                _ => Err(ErrorCode::MicrophoneCaptureFormatUnsupported),
            };
        }
        let bytes_per_sample = usize::from(format.bits_per_sample / 8);
        let offset = sample_index * bytes_per_sample;
        let value = match format.bits_per_sample {
            8 => i64::from(*data.add(offset)) - 128,
            16 => i64::from(std::ptr::read_unaligned(data.add(offset).cast::<i16>())),
            24 => {
                let raw = i32::from(*data.add(offset))
                    | (i32::from(*data.add(offset + 1)) << 8)
                    | (i32::from(*data.add(offset + 2)) << 16);
                i64::from((raw << 8) >> 8)
            }
            32 => i64::from(std::ptr::read_unaligned(data.add(offset).cast::<i32>())),
            _ => return Err(ErrorCode::MicrophoneCaptureFormatUnsupported),
        };
        let padding = format.bits_per_sample - format.valid_bits_per_sample;
        let signed_value = value >> padding;
        let scale = 2_f64.powi(i32::from(format.valid_bits_per_sample) - 1);
        Ok((signed_value as f64 / scale) as f32)
    }
}

fn finite_sample(sample: f32) -> f32 {
    if sample.is_finite() { sample } else { 0.0 }
}

pub(crate) fn channel_weights(format: &StreamFormat, channel: usize) -> (f32, f32) {
    const SPEAKER_FRONT_LEFT: u32 = 0x1;
    const SPEAKER_FRONT_RIGHT: u32 = 0x2;
    const SPEAKER_FRONT_CENTER: u32 = 0x4;
    const SPEAKER_LOW_FREQUENCY: u32 = 0x8;
    const SPEAKER_BACK_LEFT: u32 = 0x10;
    const SPEAKER_BACK_RIGHT: u32 = 0x20;
    const SPEAKER_FRONT_LEFT_OF_CENTER: u32 = 0x40;
    const SPEAKER_FRONT_RIGHT_OF_CENTER: u32 = 0x80;
    const SPEAKER_BACK_CENTER: u32 = 0x100;
    const SPEAKER_SIDE_LEFT: u32 = 0x200;
    const SPEAKER_SIDE_RIGHT: u32 = 0x400;
    const SPEAKER_TOP_CENTER: u32 = 0x800;
    const SPEAKER_TOP_FRONT_LEFT: u32 = 0x1000;
    const SPEAKER_TOP_FRONT_CENTER: u32 = 0x2000;
    const SPEAKER_TOP_FRONT_RIGHT: u32 = 0x4000;
    const SPEAKER_TOP_BACK_LEFT: u32 = 0x8000;
    const SPEAKER_TOP_BACK_CENTER: u32 = 0x10000;
    const SPEAKER_TOP_BACK_RIGHT: u32 = 0x20000;
    const HALF_POWER: f32 = std::f32::consts::FRAC_1_SQRT_2;

    if format.channels == 1 {
        return (1.0, 1.0);
    }
    if format.channel_mask == 0 {
        return match channel {
            0 => (1.0, 0.0),
            1 => (0.0, 1.0),
            _ => (0.0, 0.0),
        };
    }
    let speaker = (0_u32..32)
        .filter(|bit| format.channel_mask & (1_u32 << *bit) != 0)
        .nth(channel)
        .map(|bit| 1_u32 << bit)
        .unwrap_or_default();
    match speaker {
        SPEAKER_FRONT_LEFT => (1.0, 0.0),
        SPEAKER_FRONT_RIGHT => (0.0, 1.0),
        SPEAKER_FRONT_CENTER
        | SPEAKER_TOP_CENTER
        | SPEAKER_TOP_FRONT_CENTER
        | SPEAKER_BACK_CENTER
        | SPEAKER_TOP_BACK_CENTER => (HALF_POWER, HALF_POWER),
        SPEAKER_LOW_FREQUENCY => (0.5, 0.5),
        SPEAKER_BACK_LEFT
        | SPEAKER_SIDE_LEFT
        | SPEAKER_FRONT_LEFT_OF_CENTER
        | SPEAKER_TOP_FRONT_LEFT
        | SPEAKER_TOP_BACK_LEFT => (HALF_POWER, 0.0),
        SPEAKER_BACK_RIGHT
        | SPEAKER_SIDE_RIGHT
        | SPEAKER_FRONT_RIGHT_OF_CENTER
        | SPEAKER_TOP_FRONT_RIGHT
        | SPEAKER_TOP_BACK_RIGHT => (0.0, HALF_POWER),
        _ => (0.0, 0.0),
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SampleEncoding {
    Pcm,
    IeeeFloat,
}

pub(crate) struct StreamFormat {
    pub(crate) sample_rate: u32,
    pub(crate) channels: u16,
    pub(crate) bits_per_sample: u16,
    pub(crate) valid_bits_per_sample: u16,
    pub(crate) channel_mask: u32,
    pub(crate) encoding: SampleEncoding,
}

pub(crate) fn parse_mix_format(
    wave_format: WAVEFORMATEX,
    extensible: Option<WAVEFORMATEXTENSIBLE>,
) -> Result<StreamFormat, ErrorCode> {
    let (encoding, valid_bits_per_sample, channel_mask) = match wave_format.wFormatTag {
        WAVE_FORMAT_PCM_TAG => (SampleEncoding::Pcm, wave_format.wBitsPerSample, 0),
        WAVE_FORMAT_IEEE_FLOAT_TAG => (SampleEncoding::IeeeFloat, wave_format.wBitsPerSample, 0),
        WAVE_FORMAT_EXTENSIBLE_TAG => {
            let extension = extensible.ok_or(ErrorCode::MicrophoneCaptureFormatUnsupported)?;
            let subformat = unsafe { std::ptr::addr_of!(extension.SubFormat).read_unaligned() };
            let (encoding, channel_mask) = if subformat == KSDATAFORMAT_SUBTYPE_PCM {
                (SampleEncoding::Pcm, extension.dwChannelMask)
            } else if subformat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT {
                (SampleEncoding::IeeeFloat, extension.dwChannelMask)
            } else {
                return Err(ErrorCode::MicrophoneCaptureFormatUnsupported);
            };
            let valid_bits = unsafe { extension.Samples.wValidBitsPerSample };
            (encoding, valid_bits, channel_mask)
        }
        _ => return Err(ErrorCode::MicrophoneCaptureFormatUnsupported),
    };
    let bits_per_sample = wave_format.wBitsPerSample;
    let bytes_per_sample = bits_per_sample / 8;
    let channels = wave_format.nChannels;
    let sample_rate = wave_format.nSamplesPerSec;
    let valid_channel_mask = channel_mask == 0 || channel_mask.count_ones() == u32::from(channels);
    if !(1..=8).contains(&channels)
        || !(8_000..=192_000).contains(&sample_rate)
        || !matches!(bits_per_sample, 8 | 16 | 24 | 32)
        || valid_bits_per_sample == 0
        || valid_bits_per_sample > bits_per_sample
        || (channels > 2 && channel_mask == 0)
        || (encoding == SampleEncoding::IeeeFloat
            && (bits_per_sample != 32 || valid_bits_per_sample != 32))
        || wave_format.nBlockAlign != wave_format.nChannels * bytes_per_sample
        || !valid_channel_mask
    {
        return Err(ErrorCode::MicrophoneCaptureFormatUnsupported);
    }
    Ok(StreamFormat {
        sample_rate: wave_format.nSamplesPerSec,
        channels: wave_format.nChannels,
        bits_per_sample,
        valid_bits_per_sample,
        channel_mask,
        encoding,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_pcm_and_float_conversion_keeps_microphone_sample_values() {
        let mut wave = WAVEFORMATEX {
            wFormatTag: WAVE_FORMAT_PCM_TAG,
            nChannels: 2,
            nSamplesPerSec: 44_100,
            nAvgBytesPerSec: 176_400,
            nBlockAlign: 4,
            wBitsPerSample: 16,
            cbSize: 0,
        };
        let format = parse_mix_format(wave, None).unwrap();
        let mut pcm = [i16::MIN, i16::MAX];
        assert_eq!(format.sample_rate, 44_100);
        assert_eq!(channel_weights(&format, 0), (1.0, 0.0));
        assert_eq!(channel_weights(&format, 1), (0.0, 1.0));
        assert_eq!(
            unsafe { sample_as_f32(pcm.as_mut_ptr().cast(), 0, &format) }.unwrap(),
            -1.0
        );
        assert_eq!(
            unsafe { sample_as_f32(pcm.as_mut_ptr().cast(), 1, &format) }.unwrap(),
            32767.0 / 32768.0
        );
        wave.wFormatTag = WAVE_FORMAT_IEEE_FLOAT_TAG;
        wave.wBitsPerSample = 32;
        wave.nBlockAlign = 8;
        wave.nAvgBytesPerSec = 352_800;
        let format = parse_mix_format(wave, None).unwrap();
        let mut samples = [0.25_f32, f32::NAN];
        assert_eq!(
            unsafe { sample_as_f32(samples.as_mut_ptr().cast(), 0, &format) }.unwrap(),
            0.25
        );
        assert_eq!(
            unsafe { sample_as_f32(samples.as_mut_ptr().cast(), 1, &format) }.unwrap(),
            0.0
        );
        wave.nBlockAlign = 1;
        assert!(matches!(
            parse_mix_format(wave, None),
            Err(ErrorCode::MicrophoneCaptureFormatUnsupported)
        ));
    }
}
