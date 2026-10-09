use super::{
    MicrophoneCaptureJoinError, MicrophoneCaptureStartFailure, MicrophoneCaptureWorker,
    StartedCapture, wait_for_microphone_capture_start,
};
use crate::audio_processing::{
    FRAMES_PER_CHUNK, MicrophoneProcessor, ProcessingSettings, SAMPLE_RATE,
};
use crate::protocol::ErrorCode;
use crate::screen_audio::windows::{
    StreamFormat, channel_weights, parse_mix_format, sample_as_f32,
};
use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, SyncSender};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows::Win32::Media::Audio::{
    AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY, AUDCLNT_BUFFERFLAGS_SILENT,
    AUDCLNT_E_DEVICE_INVALIDATED, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
    DEVICE_STATE_ACTIVE, IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator,
    MMDeviceEnumerator, WAVEFORMATEX, WAVEFORMATEXTENSIBLE, eCapture, eCommunications,
};
use windows::Win32::System::Com::{
    CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoTaskMemFree,
};
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};

const START_TIMEOUT: Duration = Duration::from_secs(10);
const WAIT_INTERVAL_MS: u32 = 200;
const MAX_PACKETS_PER_WAKE: usize = 32;
const AUDIO_QUEUE_CAPACITY: usize = 12;
const AUDIO_PIPE_PREFIX: &str = r"\\.\pipe\lycansync-microphone-audio-";
const WAVE_FORMAT_EXTENSIBLE_TAG: u16 =
    windows::Win32::Media::KernelStreaming::WAVE_FORMAT_EXTENSIBLE as u16;

pub(super) fn start(
    session_id: String,
    pipe_id: String,
    settings: Arc<Mutex<ProcessingSettings>>,
) -> Result<StartedCapture, MicrophoneCaptureStartFailure> {
    let stop_requested = Arc::new(AtomicBool::new(false));
    let thread_stop = Arc::clone(&stop_requested);
    let dropped_chunks = Arc::new(AtomicU64::new(0));
    let thread_dropped = Arc::clone(&dropped_chunks);
    let capture_started = Arc::new(AtomicBool::new(false));
    let thread_capture_started = Arc::clone(&capture_started);
    let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
    let join = thread::Builder::new()
        .name("lycansync-microphone".to_owned())
        .spawn(move || {
            let result = worker_main(
                session_id.clone(),
                pipe_id,
                settings,
                thread_stop.clone(),
                Arc::clone(&thread_dropped),
                &ready_sender,
                &thread_capture_started,
            );
            if let Err(error) = result {
                if thread_capture_started.load(Ordering::Acquire) {
                    if !thread_stop.load(Ordering::Acquire) {
                        crate::notify_microphone_capture_ended(&session_id, error);
                    }
                } else {
                    let _ = ready_sender.send(Err(error));
                }
            }
            result
        })
        .map_err(|_| MicrophoneCaptureStartFailure {
            error: ErrorCode::MicrophoneCaptureStartFailed,
            worker: None,
        })?;
    let worker = Worker {
        stop_requested,
        join: Some(join),
    };
    debug_assert_eq!(SAMPLE_RATE, 48_000);
    match wait_for_microphone_capture_start(ready_receiver, Box::new(worker), START_TIMEOUT) {
        Ok(worker) => Ok(StartedCapture {
            worker,
            dropped_chunks,
        }),
        Err(failure) => {
            if let Some(worker) = failure.worker.as_ref() {
                worker.request_stop();
            }
            Err(MicrophoneCaptureStartFailure {
                error: failure.error,
                worker: failure.worker,
            })
        }
    }
}

struct Worker {
    stop_requested: Arc<AtomicBool>,
    join: Option<JoinHandle<Result<(), ErrorCode>>>,
}

impl MicrophoneCaptureWorker for Worker {
    fn request_stop(&self) {
        self.stop_requested.store(true, Ordering::Release);
    }

    fn is_finished(&self) -> bool {
        self.join.as_ref().is_none_or(JoinHandle::is_finished)
    }

    fn join(&mut self) -> Result<(), MicrophoneCaptureJoinError> {
        self.join.take().map_or(Ok(()), |join| {
            join.join()
                .map_err(|_| MicrophoneCaptureJoinError::JoinFailed)?
                .map_err(MicrophoneCaptureJoinError::Capture)
        })
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.stop_requested.store(true, Ordering::Release);
        let _ = self.join();
    }
}

fn worker_main(
    _session_id: String,
    pipe_id: String,
    settings: Arc<Mutex<ProcessingSettings>>,
    stop_requested: Arc<AtomicBool>,
    dropped_chunks: Arc<AtomicU64>,
    ready: &SyncSender<Result<(), ErrorCode>>,
    capture_started: &AtomicBool,
) -> Result<(), ErrorCode> {
    let mut pipe = OpenOptions::new()
        .write(true)
        .open(format!("{AUDIO_PIPE_PREFIX}{pipe_id}"))
        .map_err(|_| ErrorCode::MicrophoneCapturePipeFailed)?;
    let _apartment = ComApartment::initialize()?;
    let CaptureSetup {
        enumerator,
        device,
        endpoint_id,
        client,
        capture_client,
        event,
        format,
        buffer_frames,
    } = setup_capture()?;
    if stop_requested.load(Ordering::Acquire) {
        return Err(ErrorCode::MicrophoneCaptureStartFailed);
    }
    let queue = Arc::new(AudioQueue::default());
    let writer_queue = Arc::clone(&queue);
    let writer = thread::Builder::new()
        .name("lycansync-microphone-pipe".to_owned())
        .spawn(move || write_audio_pipe(&mut pipe, writer_queue))
        .map_err(|_| ErrorCode::MicrophoneCapturePipeFailed)?;
    if unsafe { client.Start() }.is_err() {
        queue.close();
        let _ = writer.join();
        return Err(ErrorCode::MicrophoneCaptureStartFailed);
    }
    if ready.send(Ok(())).is_err() {
        let _ = unsafe { client.Stop() };
        queue.close();
        let _ = writer.join();
        return Err(ErrorCode::MicrophoneCaptureStartFailed);
    }
    capture_started.store(true, Ordering::Release);
    let capture_result = capture_loop(CaptureContext {
        enumerator: &enumerator,
        endpoint_id: &endpoint_id,
        device: &device,
        capture_client: &capture_client,
        event: event.0,
        format: &format,
        buffer_frames,
        queue: &queue,
        settings: &settings,
        dropped_chunks: &dropped_chunks,
        stop_requested: &stop_requested,
    });
    let stop_result = unsafe { client.Stop() }.map_err(|_| ErrorCode::MicrophoneCaptureStopFailed);
    drop(capture_client);
    drop(client);
    drop(event);
    queue.close();
    let writer_result = writer
        .join()
        .map_err(|_| ErrorCode::MicrophoneCapturePipeFailed)?;
    if stop_requested.load(Ordering::Acquire) {
        match capture_result {
            Err(ErrorCode::MicrophoneCapturePipeFailed) => Ok(()),
            result => result.and(stop_result),
        }
    } else {
        capture_result.and(stop_result).and(writer_result)
    }
}

struct CaptureSetup {
    enumerator: IMMDeviceEnumerator,
    device: windows::Win32::Media::Audio::IMMDevice,
    endpoint_id: String,
    client: IAudioClient,
    capture_client: IAudioCaptureClient,
    event: EventHandle,
    format: StreamFormat,
    buffer_frames: u32,
}

fn setup_capture() -> Result<CaptureSetup, ErrorCode> {
    let enumerator: IMMDeviceEnumerator = unsafe {
        CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
            .map_err(|_| ErrorCode::MicrophoneCaptureStartFailed)?
    };
    let endpoint = default_capture_endpoint(&enumerator)?;
    let endpoint_id = device_id(&endpoint)?;
    let device_state =
        unsafe { endpoint.GetState() }.map_err(|_| ErrorCode::AudioDeviceUnavailable)?;
    if device_state.0 & DEVICE_STATE_ACTIVE.0 == 0 {
        return Err(ErrorCode::AudioDeviceUnavailable);
    }
    let client: IAudioClient = unsafe { endpoint.Activate(CLSCTX_ALL, None) }
        .map_err(|_| ErrorCode::MicrophoneCaptureStartFailed)?;
    let mix_format = OwnedMixFormat(
        unsafe { client.GetMixFormat() }.map_err(|_| ErrorCode::MicrophoneCaptureStartFailed)?,
    );
    if mix_format.0.is_null() {
        return Err(ErrorCode::MicrophoneCaptureFormatUnsupported);
    }
    let base_format = unsafe { std::ptr::read_unaligned(mix_format.0) };
    let extension = if base_format.wFormatTag == WAVE_FORMAT_EXTENSIBLE_TAG {
        if base_format.cbSize < 22 {
            return Err(ErrorCode::MicrophoneCaptureFormatUnsupported);
        }
        Some(unsafe { std::ptr::read_unaligned(mix_format.0.cast::<WAVEFORMATEXTENSIBLE>()) })
    } else {
        None
    };
    let format = parse_mix_format(base_format, extension)
        .map_err(|_| ErrorCode::MicrophoneCaptureFormatUnsupported)?;
    resampler_frame_counts(format.sample_rate)?;
    let event = EventHandle(
        unsafe { CreateEventW(None, false, false, None) }
            .map_err(|_| ErrorCode::MicrophoneCaptureStartFailed)?,
    );
    unsafe {
        client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
            0,
            0,
            mix_format.0,
            None,
        )
    }
    .map_err(map_audio_error)?;
    unsafe { client.SetEventHandle(event.0) }.map_err(map_audio_error)?;
    let capture_client: IAudioCaptureClient =
        unsafe { client.GetService() }.map_err(|_| ErrorCode::MicrophoneCaptureStartFailed)?;
    let buffer_frames =
        unsafe { client.GetBufferSize() }.map_err(|_| ErrorCode::MicrophoneCaptureStartFailed)?;
    drop(mix_format);
    Ok(CaptureSetup {
        enumerator,
        device: endpoint,
        endpoint_id,
        client,
        capture_client,
        event,
        format,
        buffer_frames,
    })
}

fn default_capture_endpoint(
    enumerator: &IMMDeviceEnumerator,
) -> Result<windows::Win32::Media::Audio::IMMDevice, ErrorCode> {
    unsafe { enumerator.GetDefaultAudioEndpoint(eCapture, eCommunications) }
        .map_err(|_| ErrorCode::AudioDeviceUnavailable)
}

struct CaptureContext<'a> {
    enumerator: &'a IMMDeviceEnumerator,
    endpoint_id: &'a str,
    device: &'a windows::Win32::Media::Audio::IMMDevice,
    capture_client: &'a IAudioCaptureClient,
    event: HANDLE,
    format: &'a StreamFormat,
    buffer_frames: u32,
    queue: &'a Arc<AudioQueue>,
    settings: &'a Arc<Mutex<ProcessingSettings>>,
    dropped_chunks: &'a Arc<AtomicU64>,
    stop_requested: &'a AtomicBool,
}

fn capture_loop(context: CaptureContext<'_>) -> Result<(), ErrorCode> {
    let (source_frames, output_frames) = resampler_frame_counts(context.format.sample_rate)?;
    let mut resampler = sonora_common_audio::push_resampler::PushResampler::<f32>::new(
        source_frames,
        output_frames,
        1,
    );
    let mut source = VecDeque::with_capacity(source_frames * 3);
    let mut processor = MicrophoneProcessor::new(current_settings(context.settings));
    let mut last_endpoint_check = std::time::Instant::now();
    while !context.stop_requested.load(Ordering::Acquire) {
        match unsafe { WaitForSingleObject(context.event, WAIT_INTERVAL_MS) } {
            WAIT_OBJECT_0 => drain_packets(
                &context,
                source_frames,
                &mut source,
                &mut resampler,
                &mut processor,
                output_frames,
            )?,
            WAIT_TIMEOUT => {}
            _ => return Err(ErrorCode::MicrophoneCaptureFailed),
        }
        if last_endpoint_check.elapsed() >= Duration::from_secs(1) {
            let current = default_capture_endpoint(context.enumerator)
                .map_err(|_| ErrorCode::AudioDeviceUnavailable)?;
            if device_id(&current)? != context.endpoint_id {
                return Err(ErrorCode::AudioDeviceUnavailable);
            }
            let state = unsafe { context.device.GetState() }
                .map_err(|_| ErrorCode::AudioDeviceUnavailable)?;
            if state.0 & DEVICE_STATE_ACTIVE.0 == 0 {
                return Err(ErrorCode::AudioDeviceUnavailable);
            }
            last_endpoint_check = std::time::Instant::now();
        }
    }
    Ok(())
}

fn drain_packets(
    context: &CaptureContext<'_>,
    source_frames: usize,
    pending_samples: &mut VecDeque<f32>,
    resampler: &mut sonora_common_audio::push_resampler::PushResampler<f32>,
    processor: &mut MicrophoneProcessor,
    output_frames: usize,
) -> Result<(), ErrorCode> {
    for _ in 0..MAX_PACKETS_PER_WAKE {
        if context.stop_requested.load(Ordering::Acquire) {
            break;
        }
        let frame_count = unsafe { context.capture_client.GetNextPacketSize() }
            .map_err(|_| ErrorCode::MicrophoneCaptureFailed)?;
        if frame_count == 0 {
            break;
        }
        let mut data = std::ptr::null_mut();
        let mut received_frames = 0;
        let mut flags = 0;
        unsafe {
            context.capture_client.GetBuffer(
                &mut data,
                &mut received_frames,
                &mut flags,
                None,
                None,
            )
        }
        .map_err(map_audio_error)?;
        let result = process_packet(
            data,
            received_frames,
            flags,
            context.format,
            context.buffer_frames,
            source_frames,
            pending_samples,
            resampler,
            processor,
            output_frames,
            context.settings,
            context.queue,
            context.dropped_chunks,
        );
        let release = unsafe { context.capture_client.ReleaseBuffer(received_frames) }
            .map_err(|_| ErrorCode::MicrophoneCaptureFailed);
        result?;
        release?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn process_packet(
    data: *mut u8,
    frame_count: u32,
    flags: u32,
    format: &StreamFormat,
    buffer_frames: u32,
    source_frames: usize,
    pending_samples: &mut VecDeque<f32>,
    resampler: &mut sonora_common_audio::push_resampler::PushResampler<f32>,
    processor: &mut MicrophoneProcessor,
    output_frames: usize,
    settings: &Arc<Mutex<ProcessingSettings>>,
    queue: &Arc<AudioQueue>,
    dropped_chunks: &AtomicU64,
) -> Result<(), ErrorCode> {
    if frame_count > buffer_frames {
        return Err(ErrorCode::MicrophoneCaptureFailed);
    }
    let packet_samples = usize::try_from(frame_count)
        .ok()
        .and_then(|frames| frames.checked_mul(usize::from(format.channels)))
        .ok_or(ErrorCode::MicrophoneCaptureFailed)?;
    let packet_bytes = packet_samples
        .checked_mul(usize::from(format.bits_per_sample / 8))
        .ok_or(ErrorCode::MicrophoneCaptureFailed)?;
    let packet_frames =
        usize::try_from(frame_count).map_err(|_| ErrorCode::MicrophoneCaptureFailed)?;
    let pending_limit = usize::try_from(buffer_frames)
        .ok()
        .and_then(|frames| frames.checked_add(source_frames))
        .ok_or(ErrorCode::MicrophoneCaptureFailed)?;
    if packet_bytes == 0
        || pending_samples
            .len()
            .checked_add(packet_frames)
            .is_none_or(|frames| frames > pending_limit)
    {
        return Err(ErrorCode::MicrophoneCaptureFailed);
    }
    if flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.0 as u32 != 0 {
        pending_samples.clear();
        *resampler = sonora_common_audio::push_resampler::PushResampler::<f32>::new(
            source_frames,
            output_frames,
            1,
        );
        *processor = MicrophoneProcessor::new(current_settings(settings));
    }
    if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 {
        pending_samples.extend(std::iter::repeat_n(
            0.0,
            usize::try_from(frame_count).unwrap_or_default(),
        ));
    } else {
        if data.is_null() {
            return Err(ErrorCode::MicrophoneCaptureFailed);
        }
        for frame in
            0..usize::try_from(frame_count).map_err(|_| ErrorCode::MicrophoneCaptureFailed)?
        {
            let mut left = 0.0_f32;
            let mut right = 0.0_f32;
            for channel in 0..usize::from(format.channels) {
                let index = frame
                    .checked_mul(usize::from(format.channels))
                    .and_then(|base| base.checked_add(channel))
                    .ok_or(ErrorCode::MicrophoneCaptureFailed)?;
                let sample = unsafe { sample_as_f32(data, index, format) }
                    .map_err(|_| ErrorCode::MicrophoneCaptureFailed)?;
                let (left_weight, right_weight) = channel_weights(format, channel);
                left += sample * left_weight;
                right += sample * right_weight;
            }
            let mono = (left + right) * 0.5;
            pending_samples.push_back(if mono.is_finite() {
                mono.clamp(-1.0, 1.0)
            } else {
                0.0
            });
        }
    }
    while pending_samples.len() >= source_frames {
        let input = pending_samples.drain(..source_frames).collect::<Vec<_>>();
        let mut normalized = vec![0.0_f32; output_frames];
        resampler.resample_mono(&input, &mut normalized);
        for output_chunk in normalized.as_chunks::<FRAMES_PER_CHUNK>().0 {
            let current = current_settings(settings);
            if processor.settings() != current {
                processor.set_settings(current);
            }
            let output = processor.process(output_chunk);
            let mut bytes = Vec::with_capacity(FRAMES_PER_CHUNK * 4);
            for sample in output {
                bytes.extend_from_slice(&sample.to_le_bytes());
            }
            queue.push(bytes, dropped_chunks);
        }
    }
    Ok(())
}

fn resampler_frame_counts(sample_rate: u32) -> Result<(usize, usize), ErrorCode> {
    for block_ms in [10_u32, 20, 40] {
        let input_frames = sample_rate
            .checked_mul(block_ms)
            .filter(|frames| frames % 1_000 == 0)
            .map(|frames| frames / 1_000);
        let output_frames = FRAMES_PER_CHUNK
            .checked_mul(
                usize::try_from(block_ms / 10)
                    .map_err(|_| ErrorCode::MicrophoneCaptureFormatUnsupported)?,
            )
            .ok_or(ErrorCode::MicrophoneCaptureFormatUnsupported)?;
        if let Some(input_frames) = input_frames {
            return Ok((
                usize::try_from(input_frames)
                    .map_err(|_| ErrorCode::MicrophoneCaptureFormatUnsupported)?,
                output_frames,
            ));
        }
    }
    Err(ErrorCode::MicrophoneCaptureFormatUnsupported)
}

fn current_settings(settings: &Arc<Mutex<ProcessingSettings>>) -> ProcessingSettings {
    *settings
        .lock()
        .expect("microphone capture settings lock poisoned")
}

fn write_audio_pipe(pipe: &mut File, queue: Arc<AudioQueue>) -> Result<(), ErrorCode> {
    while let Some(block) = queue.pop() {
        let frames =
            u32::try_from(block.len() / 4).map_err(|_| ErrorCode::MicrophoneCaptureFailed)?;
        pipe.write_all(&frames.to_le_bytes())
            .and_then(|()| pipe.write_all(&block))
            .map_err(|_| ErrorCode::MicrophoneCapturePipeFailed)?;
    }
    Ok(())
}

struct AudioQueue {
    blocks: Mutex<VecDeque<Vec<u8>>>,
    ready: Condvar,
    closed: AtomicBool,
}

impl Default for AudioQueue {
    fn default() -> Self {
        Self {
            blocks: Mutex::new(VecDeque::with_capacity(AUDIO_QUEUE_CAPACITY)),
            ready: Condvar::new(),
            closed: AtomicBool::new(false),
        }
    }
}

impl AudioQueue {
    fn push(&self, block: Vec<u8>, dropped_chunks: &AtomicU64) {
        let mut blocks = self
            .blocks
            .lock()
            .expect("microphone audio queue lock poisoned");
        if blocks.len() == AUDIO_QUEUE_CAPACITY {
            blocks.pop_front();
            dropped_chunks.fetch_add(1, Ordering::Relaxed);
        }
        blocks.push_back(block);
        self.ready.notify_one();
    }

    fn pop(&self) -> Option<Vec<u8>> {
        self.pop_with_before_wait(|| {})
    }

    fn pop_with_before_wait(&self, mut before_wait: impl FnMut()) -> Option<Vec<u8>> {
        let mut blocks = self
            .blocks
            .lock()
            .expect("microphone audio queue lock poisoned");
        loop {
            if let Some(block) = blocks.pop_front() {
                return Some(block);
            }
            if self.closed.load(Ordering::Acquire) {
                return None;
            }
            before_wait();
            blocks = self
                .ready
                .wait(blocks)
                .expect("microphone audio queue lock poisoned");
        }
    }

    fn close(&self) {
        // Use pop()'s mutex so close cannot notify between its check and wait.
        let blocks = self
            .blocks
            .lock()
            .expect("microphone audio queue lock poisoned");
        self.closed.store(true, Ordering::Release);
        drop(blocks);
        self.ready.notify_all();
    }
}

struct OwnedMixFormat(*mut WAVEFORMATEX);

impl Drop for OwnedMixFormat {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CoTaskMemFree(Some(self.0.cast())) };
        }
    }
}

struct OwnedDeviceId(windows::core::PWSTR);

impl Drop for OwnedDeviceId {
    fn drop(&mut self) {
        unsafe { CoTaskMemFree(Some(self.0.as_ptr().cast())) };
    }
}

fn device_id(device: &windows::Win32::Media::Audio::IMMDevice) -> Result<String, ErrorCode> {
    let id = unsafe { device.GetId() }.map_err(|_| ErrorCode::AudioDeviceUnavailable)?;
    let id = OwnedDeviceId(id);
    unsafe { id.0.to_string() }.map_err(|_| ErrorCode::AudioDeviceUnavailable)
}

fn map_audio_error(error: windows::core::Error) -> ErrorCode {
    if error.code() == AUDCLNT_E_DEVICE_INVALIDATED {
        ErrorCode::AudioDeviceUnavailable
    } else {
        ErrorCode::MicrophoneCaptureFailed
    }
}

struct EventHandle(HANDLE);

impl Drop for EventHandle {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.0) };
    }
}

struct ComApartment;

impl ComApartment {
    fn initialize() -> Result<Self, ErrorCode> {
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
            .ok()
            .map_err(|_| ErrorCode::MicrophoneCaptureStartFailed)?;
        Ok(Self)
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe { windows::Win32::System::Com::CoUninitialize() };
    }
}

#[cfg(test)]
mod tests {
    use super::{AUDIO_QUEUE_CAPACITY, AudioQueue, resampler_frame_counts};
    use crate::protocol::ErrorCode;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, mpsc};
    use std::time::Duration;

    const QUEUE_TEST_TIMEOUT: Duration = Duration::from_secs(2);

    #[test]
    fn resampler_keeps_duration_exact_for_common_integer_and_fractional_ten_ms_rates() {
        assert_eq!(resampler_frame_counts(48_000), Ok((480, 480)));
        assert_eq!(resampler_frame_counts(44_100), Ok((441, 480)));
        assert_eq!(resampler_frame_counts(22_050), Ok((441, 960)));
        assert_eq!(resampler_frame_counts(11_025), Ok((441, 1_920)));
        assert_eq!(
            resampler_frame_counts(12_345),
            Err(ErrorCode::MicrophoneCaptureFormatUnsupported)
        );
    }

    #[test]
    fn microphone_queue_is_bounded_and_drops_oldest_chunks_under_sustained_backpressure() {
        let queue = AudioQueue::default();
        let dropped = AtomicU64::new(0);
        for value in 0..=AUDIO_QUEUE_CAPACITY {
            queue.push(vec![u8::try_from(value).unwrap()], &dropped);
        }
        assert_eq!(dropped.load(std::sync::atomic::Ordering::Relaxed), 1);
        for expected in 1..=AUDIO_QUEUE_CAPACITY {
            assert_eq!(queue.pop(), Some(vec![u8::try_from(expected).unwrap()]));
        }
        queue.close();
        assert_eq!(queue.pop(), None);
    }

    #[test]
    fn close_wakes_empty_consumer_at_the_wait_boundary() {
        let queue = Arc::new(AudioQueue::default());
        let (about_to_wait_tx, about_to_wait_rx) = mpsc::channel();
        let (continue_wait_tx, continue_wait_rx) = mpsc::channel();
        let (result_tx, result_rx) = mpsc::channel();
        let consumer_queue = Arc::clone(&queue);
        let consumer = std::thread::spawn(move || {
            let result = consumer_queue.pop_with_before_wait(|| {
                about_to_wait_tx.send(()).unwrap();
                continue_wait_rx
                    .recv_timeout(QUEUE_TEST_TIMEOUT)
                    .expect("test must release consumer to enter Condvar::wait");
            });
            result_tx.send(result).unwrap();
        });

        about_to_wait_rx
            .recv_timeout(QUEUE_TEST_TIMEOUT)
            .expect("consumer should reach the empty-queue wait boundary");
        let (close_started_tx, close_started_rx) = mpsc::channel();
        let close_queue = Arc::clone(&queue);
        let closer = std::thread::spawn(move || {
            close_started_tx.send(()).unwrap();
            close_queue.close();
        });
        close_started_rx
            .recv_timeout(QUEUE_TEST_TIMEOUT)
            .expect("closer should start while consumer holds the queue lock");
        continue_wait_tx.send(()).unwrap();

        let result = result_rx.recv_timeout(QUEUE_TEST_TIMEOUT);
        let woke = result == Ok(None);
        if !woke {
            // Release a consumer if this regression reappears, then fail the bounded assertion.
            queue.close();
        }
        consumer.join().unwrap();
        closer.join().unwrap();
        assert!(woke, "close should wake an empty-queue consumer");
    }

    #[test]
    fn repeated_close_drains_queued_microphone_blocks_before_returning_none() {
        let queue = AudioQueue::default();
        let dropped = AtomicU64::new(0);
        queue.push(vec![1], &dropped);
        queue.push(vec![2], &dropped);

        queue.close();
        queue.close();

        assert_eq!(queue.pop(), Some(vec![1]));
        assert_eq!(queue.pop(), Some(vec![2]));
        assert_eq!(queue.pop(), None);
        queue.close();
        assert_eq!(queue.pop(), None);
        assert_eq!(dropped.load(Ordering::Relaxed), 0);
    }
}
