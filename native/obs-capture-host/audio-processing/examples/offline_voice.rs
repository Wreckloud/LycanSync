//! 文件内离线试音：调用正式 FFI，不打开设备、播放声音或连接房间。

use lycansync_obs_audio_processing::{
    lycan_voice_create, lycan_voice_destroy, lycan_voice_process, lycan_voice_render,
    lycan_voice_set_echo, lycan_voice_set_echo_delay,
};
use std::{
    env,
    error::Error,
    fs,
    io::{Read, Write},
    time::Instant,
};

fn main() -> Result<(), Box<dyn Error>> {
    let arguments: Vec<String> = env::args().skip(1).collect();
    if arguments.len() != 6 && arguments.len() != 7 {
        return Err("用法: offline_voice 输入.f32 输出.f32 增益 降噪(0/1) AGC(0/1) 低频过滤(0/1) [播放参考.f32]；输入为 48kHz 单声道 little-endian f32，最多 5 分钟；参考须与输入等长，测试中在同一时钟提交".into());
    }
    let input_file = fs::File::open(&arguments[0])?;
    let size = input_file.metadata()?.len();
    if size == 0 || size % 4 != 0 || size > 48_000 * 4 * 300 {
        return Err("输入必须是非空、完整 f32 采样且不超过 5 分钟".into());
    }
    let mut bytes = Vec::with_capacity(size as usize);
    // 有界读取，文件增长也不能绕过内存预算。
    std::io::Read::take(input_file, size + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 != size {
        return Err("读取期间输入文件尺寸发生变化".into());
    }
    let mut samples: Vec<f32> = bytes
        .as_chunks::<4>()
        .0
        .iter()
        .map(|sample| f32::from_le_bytes(*sample))
        .collect();
    if samples
        .iter()
        .any(|sample| !sample.is_finite() || sample.abs() > 1.0)
    {
        return Err("输入必须是 [-1, 1] 内的有限 PCM 采样".into());
    }
    let mut reference = if arguments.len() == 7 {
        let file = fs::File::open(&arguments[6])?;
        if file.metadata()?.len() != size {
            return Err("参考声音必须与输入等长".into());
        }
        let mut bytes = Vec::with_capacity(size as usize);
        std::io::Read::take(file, size + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 != size {
            return Err("读取期间参考尺寸发生变化".into());
        }
        let values: Vec<f32> = bytes
            .as_chunks::<4>()
            .0
            .iter()
            .map(|bytes| f32::from_le_bytes(*bytes))
            .collect();
        if values
            .iter()
            .any(|value| !value.is_finite() || value.abs() > 1.0)
        {
            return Err("参考必须是 [-1, 1] 内的有限 PCM 采样".into());
        }
        Some(values)
    } else {
        None
    };
    let state = lycan_voice_create(
        arguments[2].parse()?,
        arguments[3].parse()?,
        arguments[4].parse()?,
        arguments[5].parse()?,
    );
    if state.is_null() {
        return Err("处理器创建失败：配置无效或内存分配失败".into());
    }
    let count = samples.len();
    // 排出适配器与 RNNoise 各 10ms 的尾块；不能把首部静音算作降噪收益。
    samples.resize(count + 960, 0.0);
    if let Some(reference) = &mut reference {
        reference.resize(samples.len().div_ceil(480) * 480, 0.0);
        unsafe {
            lycan_voice_set_echo(state, 1);
            lycan_voice_set_echo_delay(state, 0);
        }
    }
    let mut timings = Vec::new();
    let mut failed = false;
    for (index, block) in samples.chunks_mut(480).enumerate() {
        let started = Instant::now();
        if let Some(reference) = &reference {
            if !unsafe { lycan_voice_render(state, reference[index * 480..].as_ptr(), 480) } {
                failed = true;
                break;
            }
        }
        // state 在本线程独占，block 为有效、不重叠的可写样本。
        if !unsafe { lycan_voice_process(state, block.as_mut_ptr(), block.len() as u32) } {
            failed = true;
            break;
        }
        timings.push(started.elapsed().as_secs_f64() * 1_000.0);
    }
    unsafe { lycan_voice_destroy(state) };
    if failed {
        return Err("正式音频处理失败".into());
    }
    let aligned = &samples[960..];
    let peak = aligned
        .iter()
        .map(|sample| sample.abs())
        .fold(0.0_f32, f32::max);
    let rms = (aligned
        .iter()
        .map(|&sample| f64::from(sample).powi(2))
        .sum::<f64>()
        / count as f64)
        .sqrt();
    let full_scale = aligned
        .iter()
        .filter(|sample| sample.abs() >= 0.9999)
        .count();
    let flat_top = aligned
        .windows(2)
        .filter(|pair| pair[0].abs() > 0.9 && (pair[0] - pair[1]).abs() < 1e-7)
        .count();
    let total_ms: f64 = timings.iter().sum();
    timings.sort_by(f64::total_cmp);
    let mut output = fs::File::options()
        .write(true)
        .create_new(true)
        .open(&arguments[1])?;
    for sample in aligned {
        output.write_all(&sample.to_le_bytes())?;
    }
    let echo_enabled = reference.is_some();
    let processing_delay = if echo_enabled { "null" } else { "960" };
    println!(
        "{{\"frames\":{count},\"peak\":{peak},\"rms\":{rms},\"fullScaleSamples\":{full_scale},\"flatTopAdjacentSamples\":{flat_top},\"processingMs\":{total_ms},\"p95BlockMs\":{},\"maxBlockMs\":{},\"adapterDelayFrames\":480,\"noiseDelayFrames\":480,\"processingDelayFrames\":{processing_delay},\"alignmentTrimFrames\":960,\"echoCancellation\":{echo_enabled}}}",
        timings[(timings.len() - 1) * 95 / 100],
        timings.last().unwrap()
    );
    Ok(())
}
