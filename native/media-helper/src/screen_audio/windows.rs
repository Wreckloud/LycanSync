use super::{ScreenShareAudioWorker, StartFailure, StartedAudio};
use crate::protocol::{
    Capability, ErrorCode, ScreenShareAudioDiagnostics, ScreenShareAudioState, VideoSourceKind,
};
use std::collections::VecDeque;
use std::fs::OpenOptions;
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, mpsc};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use std::time::Instant;
use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows::Win32::Media::Audio::{
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
    AUDCLNT_STREAMFLAGS_LOOPBACK, AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0,
    AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
    ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
    IActivateAudioInterfaceCompletionHandler, IAudioCaptureClient, IAudioClient,
    IMMDeviceEnumerator, MMDeviceEnumerator, PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
    PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
    WAVE_FORMAT_PCM, WAVEFORMATEX, WAVEFORMATEXTENSIBLE,
};
use windows::Win32::Media::KernelStreaming::{KSDATAFORMAT_SUBTYPE_PCM, WAVE_FORMAT_EXTENSIBLE};
use windows::Win32::Media::Multimedia::{KSDATAFORMAT_SUBTYPE_IEEE_FLOAT, WAVE_FORMAT_IEEE_FLOAT};
use windows::Win32::System::Com::{
    BLOB,
    StructuredStorage::{PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0},
};
use windows::Win32::System::Com::{
    CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoTaskMemFree,
};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{
    CreateEventW, GetCurrentProcessId, GetProcessTimes, OpenProcess,
    PROCESS_QUERY_LIMITED_INFORMATION, WaitForSingleObject,
};
use windows::Win32::System::Variant::VT_BLOB;
use windows::core::{IUnknown, Interface, Ref};

const START_TIMEOUT: Duration = Duration::from_secs(10);
const WAIT_INTERVAL_MS: u32 = 100;
const MAX_PACKETS_PER_WAKE: usize = 32;
const AUDIO_QUEUE_CAPACITY: usize = 12; // 120 ms at the existing 10 ms chunk size.
const AUDIO_PIPE_PREFIX: &str = r"\\.\pipe\lycansync-screen-audio-";
const CAPTURE_SAMPLE_RATE: u32 = 44_100;
const CAPTURE_CHANNELS: u16 = 2;
const CAPTURE_BITS_PER_SAMPLE: u16 = 16;
const MAX_CAPTURE_SAMPLE_RATE: u32 = 192_000;
const WAVE_FORMAT_PCM_TAG: u16 = WAVE_FORMAT_PCM as u16;
const WAVE_FORMAT_IEEE_FLOAT_TAG: u16 = WAVE_FORMAT_IEEE_FLOAT as u16;
const WAVE_FORMAT_EXTENSIBLE_TAG: u16 = WAVE_FORMAT_EXTENSIBLE as u16;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CaptureMode {
    ProcessLoopback,
    SystemMixLoopback,
    Unsupported,
}

pub(super) fn capability() -> Capability {
    let mode = capture_mode(windows_version());
    Capability {
        available: mode != CaptureMode::Unsupported,
        reason: match mode {
            CaptureMode::ProcessLoopback => "windowsApplicationLoopbackProcessTree",
            CaptureMode::SystemMixLoopback => "windowsSystemMixLoopback",
            CaptureMode::Unsupported => "windowsEventDrivenLoopbackRequiresBuild15063",
        },
    }
}

pub(super) fn requires_process_identity() -> bool {
    capture_mode(windows_version()) == CaptureMode::ProcessLoopback
}

pub(super) fn start(
    pipe_id: String,
    source_kind: VideoSourceKind,
    process_identity: Option<(u32, u64)>,
    diagnostics: Arc<Mutex<ScreenShareAudioDiagnostics>>,
) -> Result<StartedAudio, StartFailure> {
    let mode = capture_mode(windows_version());
    if mode == CaptureMode::Unsupported
        || (mode == CaptureMode::ProcessLoopback
            && source_kind == VideoSourceKind::Window
            && process_identity.is_none())
    {
        return Err(StartFailure {
            error: if mode != CaptureMode::Unsupported {
                ErrorCode::ScreenShareAudioTargetUnavailable
            } else {
                ErrorCode::ScreenShareAudioUnsupported
            },
            worker: None,
        });
    }

    let stop_requested = Arc::new(AtomicBool::new(false));
    let worker_stop = Arc::clone(&stop_requested);
    let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
    let worker_diagnostics = Arc::clone(&diagnostics);
    let thread = match thread::Builder::new()
        .name("lycansync-screen-audio".to_owned())
        .spawn(move || {
            worker_main(
                pipe_id,
                mode,
                source_kind,
                process_identity,
                worker_diagnostics,
                worker_stop,
                ready_sender,
            )
        }) {
        Ok(thread) => thread,
        Err(_) => {
            return Err(StartFailure {
                error: ErrorCode::ScreenShareAudioStartFailed,
                worker: None,
            });
        }
    };
    let mut worker = Worker {
        stop_requested,
        join: Some(thread),
    };
    match ready_receiver.recv_timeout(START_TIMEOUT) {
        Ok(Ok((sample_rate, channels))) => Ok(StartedAudio {
            worker: Box::new(worker),
            sample_rate,
            channels,
        }),
        Ok(Err(error)) => {
            let _ = worker.join();
            Err(StartFailure {
                error,
                worker: None,
            })
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            worker.request_stop();
            Err(StartFailure {
                error: ErrorCode::ScreenShareAudioStartTimedOut,
                worker: Some(Box::new(worker)),
            })
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            let _ = worker.join();
            Err(StartFailure {
                error: ErrorCode::ScreenShareAudioStartFailed,
                worker: None,
            })
        }
    }
}

struct Worker {
    stop_requested: Arc<AtomicBool>,
    join: Option<JoinHandle<Result<(), ErrorCode>>>,
}

impl ScreenShareAudioWorker for Worker {
    fn request_stop(&self) {
        self.stop_requested.store(true, Ordering::Release);
    }
    fn is_finished(&self) -> bool {
        self.join.as_ref().is_none_or(JoinHandle::is_finished)
    }
    fn join(&mut self) -> Result<(), ErrorCode> {
        self.join.take().map_or(Ok(()), |join| {
            join.join()
                .map_err(|_| ErrorCode::ScreenShareAudioStopFailed)?
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
    pipe_id: String,
    mode: CaptureMode,
    source_kind: VideoSourceKind,
    process_identity: Option<(u32, u64)>,
    diagnostics: Arc<Mutex<ScreenShareAudioDiagnostics>>,
    stop_requested: Arc<AtomicBool>,
    ready: mpsc::SyncSender<Result<(u32, u16), ErrorCode>>,
) -> Result<(), ErrorCode> {
    let pipe_path = format!("{AUDIO_PIPE_PREFIX}{pipe_id}");
    let mut pipe = match OpenOptions::new().write(true).open(pipe_path) {
        Ok(pipe) => pipe,
        Err(_) => {
            set_start_error(&diagnostics, ErrorCode::ScreenShareAudioPipeFailed);
            let _ = ready.send(Err(ErrorCode::ScreenShareAudioPipeFailed));
            return Err(ErrorCode::ScreenShareAudioPipeFailed);
        }
    };
    let _apartment = match ComApartment::initialize() {
        Ok(apartment) => apartment,
        Err(error) => {
            set_start_error(&diagnostics, error);
            let _ = ready.send(Err(error));
            return Err(error);
        }
    };
    let activated = match mode {
        CaptureMode::ProcessLoopback => {
            let target_process_identity = match source_kind {
                VideoSourceKind::Window => match process_identity {
                    Some(identity) => identity,
                    None => {
                        set_start_error(&diagnostics, ErrorCode::ScreenShareAudioTargetUnavailable);
                        let _ = ready.send(Err(ErrorCode::ScreenShareAudioTargetUnavailable));
                        return Err(ErrorCode::ScreenShareAudioTargetUnavailable);
                    }
                },
                VideoSourceKind::Monitor => match parent_process_id() {
                    Some(process_id) => match process_creation_time(process_id) {
                        Ok(creation_time) => (process_id, creation_time),
                        Err(_) => {
                            let _ = ready.send(Err(ErrorCode::ScreenShareAudioTargetUnavailable));
                            return Err(ErrorCode::ScreenShareAudioTargetUnavailable);
                        }
                    },
                    None => {
                        set_start_error(&diagnostics, ErrorCode::ScreenShareAudioTargetUnavailable);
                        let _ = ready.send(Err(ErrorCode::ScreenShareAudioTargetUnavailable));
                        return Err(ErrorCode::ScreenShareAudioTargetUnavailable);
                    }
                },
            };
            let loopback_mode = if source_kind == VideoSourceKind::Window {
                PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
            } else {
                PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE
            };
            activate_process_loopback(target_process_identity, loopback_mode)
        }
        CaptureMode::SystemMixLoopback => activate_default_endpoint_loopback(),
        CaptureMode::Unsupported => Err(ErrorCode::ScreenShareAudioUnsupported),
    };
    let (client, format, endpoint_watch) = match activated {
        Ok(value) => value,
        Err(error) => {
            set_start_error(&diagnostics, error);
            let _ = ready.send(Err(error));
            return Err(error);
        }
    };
    let event = EventHandle(match unsafe { CreateEventW(None, false, false, None) } {
        Ok(event) => event,
        Err(_) => {
            let _ = ready.send(Err(ErrorCode::ScreenShareAudioStartFailed));
            return Err(ErrorCode::ScreenShareAudioStartFailed);
        }
    });
    let initialized = if mode == CaptureMode::SystemMixLoopback {
        Ok(())
    } else {
        unsafe {
            client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                0,
                0,
                &format.wave_format,
                None,
            )
        }
    };
    if initialized.is_err() {
        set_start_error(&diagnostics, ErrorCode::ScreenShareAudioStartFailed);
        let _ = ready.send(Err(ErrorCode::ScreenShareAudioStartFailed));
        return Err(ErrorCode::ScreenShareAudioStartFailed);
    }
    if unsafe { client.SetEventHandle(event.0) }.is_err() {
        set_start_error(&diagnostics, ErrorCode::ScreenShareAudioStartFailed);
        let _ = ready.send(Err(ErrorCode::ScreenShareAudioStartFailed));
        return Err(ErrorCode::ScreenShareAudioStartFailed);
    }
    let capture_client: IAudioCaptureClient = match unsafe { client.GetService() } {
        Ok(value) => value,
        Err(_) => {
            let _ = ready.send(Err(ErrorCode::ScreenShareAudioStartFailed));
            return Err(ErrorCode::ScreenShareAudioStartFailed);
        }
    };
    let queue = Arc::new(AudioQueue::default());
    let writer_queue = Arc::clone(&queue);
    let writer_failed = Arc::new(AtomicBool::new(false));
    let writer_failed_state = Arc::clone(&writer_failed);
    let writer = thread::Builder::new()
        .name("lycansync-audio-pipe".to_owned())
        .spawn(move || {
            let result = write_audio_pipe(&mut pipe, writer_queue);
            if result.is_err() {
                writer_failed_state.store(true, Ordering::Release);
            }
            result
        })
        .map_err(|_| ErrorCode::ScreenShareAudioPipeFailed)?;
    if unsafe { client.Start() }.is_err() {
        queue.close();
        let _ = writer.join();
        set_start_error(&diagnostics, ErrorCode::ScreenShareAudioStartFailed);
        let _ = ready.send(Err(ErrorCode::ScreenShareAudioStartFailed));
        return Err(ErrorCode::ScreenShareAudioStartFailed);
    }
    {
        let mut snapshot = diagnostics
            .lock()
            .expect("screen audio diagnostics lock poisoned");
        snapshot.state = ScreenShareAudioState::Running;
        snapshot.sample_rate = Some(format.sample_rate);
        snapshot.channels = Some(format.channels);
        snapshot.packets_received = Some(0);
        snapshot.frames_received = Some(0);
        snapshot.silent_packets = Some(0);
        snapshot.dropped_audio_chunks = Some(0);
    }
    let _ = ready.send(Ok((format.sample_rate, format.channels)));
    let capture_result = capture_loop(CaptureLoop {
        client: &client,
        capture_client: &capture_client,
        event: event.0,
        format: &format,
        queue: &queue,
        diagnostics: &diagnostics,
        stop_requested: &stop_requested,
        writer_failed: &writer_failed,
        endpoint_watch: endpoint_watch.as_ref(),
    });
    let stop_result = unsafe { client.Stop() }.map_err(|_| ErrorCode::ScreenShareAudioStopFailed);
    drop(capture_client);
    drop(client);
    drop(event);
    queue.close();
    let writer_result = writer
        .join()
        .map_err(|_| ErrorCode::ScreenShareAudioPipeFailed)?;
    let result = if stop_requested.load(Ordering::Acquire) {
        let capture_result = match capture_result {
            Err(ErrorCode::ScreenShareAudioPipeFailed) => Ok(()),
            result => result,
        };
        capture_result.and(stop_result)
    } else {
        capture_result.and(stop_result).and(writer_result)
    };
    let mut snapshot = diagnostics
        .lock()
        .expect("screen audio diagnostics lock poisoned");
    match result {
        Ok(()) => {
            if stop_requested.load(Ordering::Acquire) {
                snapshot.state = ScreenShareAudioState::Idle;
                snapshot.session_id = None;
            }
        }
        Err(error) => {
            snapshot.state = ScreenShareAudioState::Failed;
            snapshot.last_error = Some(error.diagnostic_name());
        }
    }
    result
}

struct AudioQueue {
    blocks: Mutex<VecDeque<Vec<u8>>>,
    ready: Condvar,
    closed: AtomicBool,
    dropped: std::sync::atomic::AtomicU64,
}

impl Default for AudioQueue {
    fn default() -> Self {
        Self {
            blocks: Mutex::new(VecDeque::with_capacity(AUDIO_QUEUE_CAPACITY)),
            ready: Condvar::new(),
            closed: AtomicBool::new(false),
            dropped: std::sync::atomic::AtomicU64::new(0),
        }
    }
}

impl AudioQueue {
    fn push(&self, block: Vec<u8>) {
        let mut blocks = self.blocks.lock().expect("audio queue lock poisoned");
        if blocks.len() == AUDIO_QUEUE_CAPACITY {
            blocks.pop_front();
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
        blocks.push_back(block);
        self.ready.notify_one();
    }

    fn pop(&self) -> Option<Vec<u8>> {
        let mut blocks = self.blocks.lock().expect("audio queue lock poisoned");
        loop {
            if let Some(block) = blocks.pop_front() {
                return Some(block);
            }
            if self.closed.load(Ordering::Acquire) {
                return None;
            }
            blocks = self.ready.wait(blocks).expect("audio queue lock poisoned");
        }
    }

    fn close(&self) {
        self.closed.store(true, Ordering::Release);
        self.ready.notify_all();
    }
}

fn write_audio_pipe(pipe: &mut std::fs::File, queue: Arc<AudioQueue>) -> Result<(), ErrorCode> {
    while let Some(block) = queue.pop() {
        let frame_count = (block.len() / 4 / queue_channels(&block)).min(u32::MAX as usize) as u32;
        pipe.write_all(&frame_count.to_le_bytes())
            .and_then(|()| pipe.write_all(&block))
            .map_err(|_| ErrorCode::ScreenShareAudioPipeFailed)?;
    }
    Ok(())
}

// Stereo Float32 is the transport contract; the helper normalizes supported Core Audio mixes.
fn queue_channels(_block: &[u8]) -> usize {
    2
}

struct CaptureLoop<'a> {
    client: &'a IAudioClient,
    capture_client: &'a IAudioCaptureClient,
    event: HANDLE,
    format: &'a StreamFormat,
    queue: &'a Arc<AudioQueue>,
    diagnostics: &'a Arc<Mutex<ScreenShareAudioDiagnostics>>,
    stop_requested: &'a AtomicBool,
    writer_failed: &'a AtomicBool,
    endpoint_watch: Option<&'a DefaultEndpointWatch>,
}

fn capture_loop(context: CaptureLoop<'_>) -> Result<(), ErrorCode> {
    let mut assembler = ChunkAssembler::new(context.format.sample_rate)?;
    let mut endpoint_check = Instant::now();
    while !context.stop_requested.load(Ordering::Acquire) {
        if context.writer_failed.load(Ordering::Acquire) {
            return Err(ErrorCode::ScreenShareAudioPipeFailed);
        }
        match unsafe { WaitForSingleObject(context.event, WAIT_INTERVAL_MS) } {
            WAIT_OBJECT_0 => {
                drain_packets(
                    context.client,
                    context.capture_client,
                    context.format,
                    &mut assembler,
                    context.queue,
                    context.diagnostics,
                    context.stop_requested,
                )?;
                check_default_endpoint(context.endpoint_watch, &mut endpoint_check)?;
            }
            WAIT_TIMEOUT => check_default_endpoint(context.endpoint_watch, &mut endpoint_check)?,
            _ => return Err(ErrorCode::ScreenShareAudioFailed),
        }
    }
    Ok(())
}

fn check_default_endpoint(
    endpoint_watch: Option<&DefaultEndpointWatch>,
    last_check: &mut Instant,
) -> Result<(), ErrorCode> {
    let Some(watch) = endpoint_watch else {
        return Ok(());
    };
    if last_check.elapsed() < Duration::from_secs(1) {
        return Ok(());
    }
    if current_default_endpoint_id(&watch.enumerator)? != watch.id {
        return Err(ErrorCode::ScreenShareAudioTargetUnavailable);
    }
    *last_check = Instant::now();
    Ok(())
}

fn drain_packets(
    client: &IAudioClient,
    capture_client: &IAudioCaptureClient,
    format: &StreamFormat,
    assembler: &mut ChunkAssembler,
    queue: &Arc<AudioQueue>,
    diagnostics: &Arc<Mutex<ScreenShareAudioDiagnostics>>,
    stop_requested: &AtomicBool,
) -> Result<(), ErrorCode> {
    for _ in 0..MAX_PACKETS_PER_WAKE {
        if stop_requested.load(Ordering::Acquire) {
            break;
        }
        let frame_count = unsafe { capture_client.GetNextPacketSize() }
            .map_err(|_| ErrorCode::ScreenShareAudioFailed)?;
        if frame_count == 0 {
            break;
        }
        let mut data = std::ptr::null_mut();
        let mut received_frames = 0;
        let mut flags = 0;
        unsafe {
            capture_client.GetBuffer(&mut data, &mut received_frames, &mut flags, None, None)
        }
        .map_err(|_| ErrorCode::ScreenShareAudioFailed)?;
        let silent = flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0;
        let packet_result = process_capture_packet(
            data,
            received_frames,
            format,
            silent,
            assembler,
            queue,
            stop_requested,
        );
        unsafe { capture_client.ReleaseBuffer(received_frames) }
            .map_err(|_| ErrorCode::ScreenShareAudioFailed)?;
        packet_result?;
        let mut snapshot = diagnostics
            .lock()
            .expect("screen audio diagnostics lock poisoned");
        snapshot.packets_received = Some(
            snapshot
                .packets_received
                .unwrap_or_default()
                .saturating_add(1),
        );
        snapshot.frames_received = Some(
            snapshot
                .frames_received
                .unwrap_or_default()
                .saturating_add(received_frames as u64),
        );
        if silent {
            snapshot.silent_packets = Some(
                snapshot
                    .silent_packets
                    .unwrap_or_default()
                    .saturating_add(1),
            );
        }
        snapshot.dropped_audio_chunks = Some(queue.dropped.load(Ordering::Relaxed));
    }
    let _ = client;
    Ok(())
}

fn process_capture_packet(
    data: *mut u8,
    received_frames: u32,
    format: &StreamFormat,
    silent: bool,
    assembler: &mut ChunkAssembler,
    queue: &Arc<AudioQueue>,
    stop_requested: &AtomicBool,
) -> Result<(), ErrorCode> {
    if received_frames == 0 || format.wave_format.nBlockAlign == 0 {
        return Err(ErrorCode::ScreenShareAudioFailed);
    }
    let input_bytes = usize::try_from(received_frames)
        .ok()
        .and_then(|frames| frames.checked_mul(usize::from(format.wave_format.nBlockAlign)))
        .ok_or(ErrorCode::ScreenShareAudioFailed)?;
    if !silent && data.is_null() {
        return Err(ErrorCode::ScreenShareAudioFailed);
    }

    let frames_per_chunk = assembler.chunk_bytes / (2 * 4);
    if frames_per_chunk == 0 {
        return Err(ErrorCode::ScreenShareAudioFailed);
    }
    let mut processed_frames = 0_usize;
    let total_frames =
        usize::try_from(received_frames).map_err(|_| ErrorCode::ScreenShareAudioFailed)?;
    while processed_frames < total_frames && !stop_requested.load(Ordering::Acquire) {
        let frames = (total_frames - processed_frames).min(frames_per_chunk);
        let input_offset = processed_frames
            .checked_mul(usize::from(format.wave_format.nBlockAlign))
            .ok_or(ErrorCode::ScreenShareAudioFailed)?;
        if input_offset >= input_bytes {
            return Err(ErrorCode::ScreenShareAudioFailed);
        }
        let input = if silent {
            std::ptr::null_mut()
        } else {
            unsafe { data.add(input_offset) }
        };
        let block = normalize_to_stereo_f32(
            input,
            u32::try_from(frames).map_err(|_| ErrorCode::ScreenShareAudioFailed)?,
            format,
            silent,
        )?;
        for chunk in assembler.push(&block) {
            queue.push(chunk);
        }
        processed_frames += frames;
    }
    Ok(())
}

struct ChunkAssembler {
    chunk_bytes: usize,
    pending: Vec<u8>,
}

impl ChunkAssembler {
    fn new(sample_rate: u32) -> Result<Self, ErrorCode> {
        let frames_per_chunk = (sample_rate / 100).max(1) as usize;
        let chunk_bytes = frames_per_chunk
            .checked_mul(2 * 4)
            .filter(|size| *size <= (MAX_CAPTURE_SAMPLE_RATE / 100) as usize * 2 * 4)
            .ok_or(ErrorCode::ScreenShareAudioFormatUnsupported)?;
        let pending_capacity = chunk_bytes
            .checked_mul(2)
            .ok_or(ErrorCode::ScreenShareAudioFormatUnsupported)?;
        Ok(Self {
            chunk_bytes,
            pending: Vec::with_capacity(pending_capacity),
        })
    }

    fn push(&mut self, input: &[u8]) -> Vec<Vec<u8>> {
        self.pending.extend_from_slice(input);
        let count = self.pending.len() / self.chunk_bytes;
        let mut chunks = Vec::with_capacity(count);
        for _ in 0..count {
            chunks.push(self.pending.drain(..self.chunk_bytes).collect());
        }
        chunks
    }
}

fn normalize_to_stereo_f32(
    data: *mut u8,
    frames: u32,
    format: &StreamFormat,
    silent: bool,
) -> Result<Vec<u8>, ErrorCode> {
    let samples = usize::try_from(frames)
        .map_err(|_| ErrorCode::ScreenShareAudioFailed)?
        .checked_mul(2)
        .ok_or(ErrorCode::ScreenShareAudioFailed)?;
    let output_bytes = samples
        .checked_mul(4)
        .ok_or(ErrorCode::ScreenShareAudioFailed)?;
    let mut output = Vec::with_capacity(output_bytes);
    if silent {
        output.resize(output_bytes, 0);
        return Ok(output);
    }
    if data.is_null() {
        return Err(ErrorCode::ScreenShareAudioFailed);
    }
    let channel_weights = (0..format.channels as usize)
        .map(|channel| channel_weights(format, channel))
        .collect::<Vec<_>>();
    for frame in 0..frames as usize {
        let mut left = 0.0_f32;
        let mut right = 0.0_f32;
        for (channel, (left_weight, right_weight)) in channel_weights.iter().copied().enumerate() {
            let sample_index = frame * format.channels as usize + channel;
            let sample = unsafe { sample_as_f32(data, sample_index, format)? };
            left += sample * left_weight;
            right += sample * right_weight;
        }
        output.extend_from_slice(&finite_sample(left).clamp(-1.0, 1.0).to_le_bytes());
        output.extend_from_slice(&finite_sample(right).clamp(-1.0, 1.0).to_le_bytes());
    }
    Ok(output)
}

unsafe fn sample_as_f32(
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
                _ => Err(ErrorCode::ScreenShareAudioFormatUnsupported),
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
            _ => return Err(ErrorCode::ScreenShareAudioFormatUnsupported),
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

fn channel_weights(format: &StreamFormat, channel: usize) -> (f32, f32) {
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
enum SampleEncoding {
    Pcm,
    IeeeFloat,
}

struct StreamFormat {
    wave_format: WAVEFORMATEX,
    sample_rate: u32,
    channels: u16,
    bits_per_sample: u16,
    valid_bits_per_sample: u16,
    channel_mask: u32,
    encoding: SampleEncoding,
}

fn supported_capture_format() -> StreamFormat {
    let block_align = CAPTURE_CHANNELS * (CAPTURE_BITS_PER_SAMPLE / 8);
    StreamFormat {
        wave_format: WAVEFORMATEX {
            wFormatTag: WAVE_FORMAT_PCM as u16,
            nChannels: CAPTURE_CHANNELS,
            nSamplesPerSec: CAPTURE_SAMPLE_RATE,
            nAvgBytesPerSec: CAPTURE_SAMPLE_RATE * u32::from(block_align),
            nBlockAlign: block_align,
            wBitsPerSample: CAPTURE_BITS_PER_SAMPLE,
            cbSize: 0,
        },
        sample_rate: CAPTURE_SAMPLE_RATE,
        channels: CAPTURE_CHANNELS,
        bits_per_sample: CAPTURE_BITS_PER_SAMPLE,
        valid_bits_per_sample: CAPTURE_BITS_PER_SAMPLE,
        channel_mask: 0,
        encoding: SampleEncoding::Pcm,
    }
}

fn parse_mix_format(
    wave_format: WAVEFORMATEX,
    extensible: Option<WAVEFORMATEXTENSIBLE>,
) -> Result<StreamFormat, ErrorCode> {
    let (encoding, valid_bits_per_sample, channel_mask) = match wave_format.wFormatTag {
        WAVE_FORMAT_PCM_TAG => (SampleEncoding::Pcm, wave_format.wBitsPerSample, 0),
        WAVE_FORMAT_IEEE_FLOAT_TAG => (SampleEncoding::IeeeFloat, wave_format.wBitsPerSample, 0),
        WAVE_FORMAT_EXTENSIBLE_TAG => {
            let extension = extensible.ok_or(ErrorCode::ScreenShareAudioFormatUnsupported)?;
            let subformat = unsafe { std::ptr::addr_of!(extension.SubFormat).read_unaligned() };
            let (encoding, channel_mask) = if subformat == KSDATAFORMAT_SUBTYPE_PCM {
                (SampleEncoding::Pcm, extension.dwChannelMask)
            } else if subformat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT {
                (SampleEncoding::IeeeFloat, extension.dwChannelMask)
            } else {
                return Err(ErrorCode::ScreenShareAudioFormatUnsupported);
            };
            let valid_bits = unsafe { extension.Samples.wValidBitsPerSample };
            (encoding, valid_bits, channel_mask)
        }
        _ => return Err(ErrorCode::ScreenShareAudioFormatUnsupported),
    };
    let bits_per_sample = wave_format.wBitsPerSample;
    let bytes_per_sample = bits_per_sample / 8;
    let channels = wave_format.nChannels;
    let sample_rate = wave_format.nSamplesPerSec;
    let valid_channel_mask = channel_mask == 0 || channel_mask.count_ones() == u32::from(channels);
    if channels < 1
        || channels > 8
        || sample_rate < 8_000
        || sample_rate > 192_000
        || !matches!(bits_per_sample, 8 | 16 | 24 | 32)
        || valid_bits_per_sample == 0
        || valid_bits_per_sample > bits_per_sample
        || (channels > 2 && channel_mask == 0)
        || (encoding == SampleEncoding::IeeeFloat
            && (bits_per_sample != 32 || valid_bits_per_sample != 32))
        || wave_format.nBlockAlign != wave_format.nChannels * bytes_per_sample
        || !valid_channel_mask
    {
        return Err(ErrorCode::ScreenShareAudioFormatUnsupported);
    }
    Ok(StreamFormat {
        wave_format,
        sample_rate: wave_format.nSamplesPerSec,
        channels: wave_format.nChannels,
        bits_per_sample,
        valid_bits_per_sample,
        channel_mask,
        encoding,
    })
}

struct OwnedMixFormat(*mut WAVEFORMATEX);
impl Drop for OwnedMixFormat {
    fn drop(&mut self) {
        unsafe { CoTaskMemFree(Some(self.0.cast())) };
    }
}

fn activate_default_endpoint_loopback()
-> Result<(IAudioClient, StreamFormat, Option<DefaultEndpointWatch>), ErrorCode> {
    let enumerator: IMMDeviceEnumerator =
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
            .map_err(|_| ErrorCode::ScreenShareAudioTargetUnavailable)?;
    let endpoint_id = current_default_endpoint_id(&enumerator)?;
    let device = unsafe {
        enumerator.GetDefaultAudioEndpoint(
            windows::Win32::Media::Audio::eRender,
            windows::Win32::Media::Audio::eConsole,
        )
    }
    .map_err(|_| ErrorCode::ScreenShareAudioTargetUnavailable)?;
    let client: IAudioClient = unsafe { device.Activate(CLSCTX_ALL, None) }
        .map_err(|_| ErrorCode::ScreenShareAudioStartFailed)?;
    let mix_format = OwnedMixFormat(
        unsafe { client.GetMixFormat() }.map_err(|_| ErrorCode::ScreenShareAudioStartFailed)?,
    );
    if mix_format.0.is_null() {
        return Err(ErrorCode::ScreenShareAudioFormatUnsupported);
    }
    let base_format = unsafe { std::ptr::read_unaligned(mix_format.0) };
    let extensible = if base_format.wFormatTag == WAVE_FORMAT_EXTENSIBLE_TAG {
        if base_format.cbSize < 22 {
            return Err(ErrorCode::ScreenShareAudioFormatUnsupported);
        }
        Some(unsafe { std::ptr::read_unaligned(mix_format.0.cast::<WAVEFORMATEXTENSIBLE>()) })
    } else {
        None
    };
    let format = parse_mix_format(base_format, extensible)?;
    unsafe {
        client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_LOOPBACK,
            0,
            0,
            mix_format.0,
            None,
        )
    }
    .map_err(|_| ErrorCode::ScreenShareAudioStartFailed)?;
    drop(mix_format);
    Ok((
        client,
        format,
        Some(DefaultEndpointWatch {
            enumerator,
            id: endpoint_id,
        }),
    ))
}

struct DefaultEndpointWatch {
    enumerator: IMMDeviceEnumerator,
    id: String,
}

struct OwnedDeviceId(windows::core::PWSTR);
impl Drop for OwnedDeviceId {
    fn drop(&mut self) {
        unsafe { CoTaskMemFree(Some(self.0.as_ptr().cast())) };
    }
}

fn current_default_endpoint_id(enumerator: &IMMDeviceEnumerator) -> Result<String, ErrorCode> {
    let device = unsafe {
        enumerator.GetDefaultAudioEndpoint(
            windows::Win32::Media::Audio::eRender,
            windows::Win32::Media::Audio::eConsole,
        )
    }
    .map_err(|_| ErrorCode::ScreenShareAudioTargetUnavailable)?;
    let id = OwnedDeviceId(
        unsafe { device.GetId() }.map_err(|_| ErrorCode::ScreenShareAudioTargetUnavailable)?,
    );
    unsafe { id.0.to_string() }.map_err(|_| ErrorCode::ScreenShareAudioFailed)
}

fn activate_process_loopback(
    process_identity: (u32, u64),
    mode: windows::Win32::Media::Audio::PROCESS_LOOPBACK_MODE,
) -> Result<(IAudioClient, StreamFormat, Option<DefaultEndpointWatch>), ErrorCode> {
    if process_creation_time(process_identity.0)? != process_identity.1 {
        return Err(ErrorCode::ScreenShareAudioTargetUnavailable);
    }
    let params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: process_identity.0,
                ProcessLoopbackMode: mode,
            },
        },
    };
    let mut property = PROPVARIANT::default();
    property.Anonymous = PROPVARIANT_0 {
        Anonymous: std::mem::ManuallyDrop::new(PROPVARIANT_0_0 {
            vt: VT_BLOB,
            wReserved1: 0,
            wReserved2: 0,
            wReserved3: 0,
            Anonymous: PROPVARIANT_0_0_0 {
                blob: BLOB {
                    cbSize: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
                    pBlobData: (&params as *const AUDIOCLIENT_ACTIVATION_PARAMS)
                        .cast_mut()
                        .cast(),
                },
            },
        }),
    };
    let (sender, receiver) = mpsc::sync_channel(1);
    let handler: IActivateAudioInterfaceCompletionHandler = ActivationHandler {
        sender: Mutex::new(Some(sender)),
    }
    .into();
    unsafe {
        ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IAudioClient::IID,
            Some(&property),
            &handler,
        )
    }
    .map_err(|_| ErrorCode::ScreenShareAudioUnsupported)?;
    let client = receiver
        .recv_timeout(START_TIMEOUT)
        .map_err(|_| ErrorCode::ScreenShareAudioStartTimedOut)??;
    // Process Loopback is a virtual client; use the supported explicit PCM format from
    // Microsoft's Application Loopback sample instead of asking it for a mix format.
    let stream = supported_capture_format();
    Ok((client, stream, None))
}

#[windows::core::implement(IActivateAudioInterfaceCompletionHandler)]
struct ActivationHandler {
    sender: Mutex<Option<mpsc::SyncSender<Result<IAudioClient, ErrorCode>>>>,
}

impl windows::Win32::Media::Audio::IActivateAudioInterfaceCompletionHandler_Impl
    for ActivationHandler_Impl
{
    fn ActivateCompleted(
        &self,
        operation: Ref<IActivateAudioInterfaceAsyncOperation>,
    ) -> windows::core::Result<()> {
        let operation = operation.as_ref().ok_or(windows::core::Error::from(
            windows::Win32::Foundation::E_POINTER,
        ))?;
        let mut activation_result = windows::core::HRESULT(0);
        let mut activated: Option<IUnknown> = None;
        let result = unsafe { operation.GetActivateResult(&mut activation_result, &mut activated) };
        let outcome = if result.is_err() || activation_result.is_err() {
            Err(ErrorCode::ScreenShareAudioStartFailed)
        } else {
            activated
                .ok_or(ErrorCode::ScreenShareAudioStartFailed)
                .and_then(|unknown| {
                    unknown
                        .cast::<IAudioClient>()
                        .map_err(|_| ErrorCode::ScreenShareAudioStartFailed)
                })
        };
        if let Some(sender) = self
            .sender
            .lock()
            .expect("audio activation sender poisoned")
            .take()
        {
            let _ = sender.send(outcome);
        }
        Ok(())
    }
}

fn parent_process_id() -> Option<u32> {
    use windows::Win32::Foundation::INVALID_HANDLE_VALUE;
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }.ok()?;
    struct Snapshot(HANDLE);
    impl Drop for Snapshot {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
    if snapshot == INVALID_HANDLE_VALUE {
        return None;
    }
    let _snapshot = Snapshot(snapshot);
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let current_pid = unsafe { GetCurrentProcessId() };
    if unsafe { Process32FirstW(snapshot, &mut entry) }.is_err() {
        return None;
    }
    loop {
        if entry.th32ProcessID == current_pid {
            return (entry.th32ParentProcessID != 0).then_some(entry.th32ParentProcessID);
        }
        if unsafe { Process32NextW(snapshot, &mut entry) }.is_err() {
            break;
        }
    }
    None
}

fn process_creation_time(process_id: u32) -> Result<u64, ErrorCode> {
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id) }
        .map_err(|_| ErrorCode::ScreenShareAudioTargetUnavailable)?;
    struct ProcessHandle(HANDLE);
    impl Drop for ProcessHandle {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
    let _process = ProcessHandle(process);
    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    unsafe { GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user) }
        .map_err(|_| ErrorCode::ScreenShareAudioTargetUnavailable)?;
    Ok((u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime))
}

fn windows_version() -> (u32, u32) {
    #[repr(C)]
    struct VersionInfo {
        size: u32,
        major: u32,
        minor: u32,
        build: u32,
        platform: u32,
        service_pack: [u16; 128],
    }
    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn RtlGetVersion(info: *mut VersionInfo) -> i32;
    }
    let mut version = VersionInfo {
        size: std::mem::size_of::<VersionInfo>() as u32,
        major: 0,
        minor: 0,
        build: 0,
        platform: 0,
        service_pack: [0; 128],
    };
    if unsafe { RtlGetVersion(&mut version) } == 0 {
        (version.major, version.build)
    } else {
        (0, 0)
    }
}

fn capture_mode((major, build): (u32, u32)) -> CaptureMode {
    if major < 10 {
        CaptureMode::Unsupported
    } else if build >= 19_041 {
        CaptureMode::ProcessLoopback
    } else if build >= 15_063 {
        CaptureMode::SystemMixLoopback
    } else {
        CaptureMode::Unsupported
    }
}

fn set_start_error(diagnostics: &Arc<Mutex<ScreenShareAudioDiagnostics>>, error: ErrorCode) {
    let mut snapshot = diagnostics
        .lock()
        .expect("screen audio diagnostics lock poisoned");
    snapshot.state = ScreenShareAudioState::Failed;
    snapshot.last_error = Some(error.diagnostic_name());
}

struct EventHandle(HANDLE);
impl Drop for EventHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

struct ComApartment;
impl ComApartment {
    fn initialize() -> Result<Self, ErrorCode> {
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
            .ok()
            .map_err(|_| ErrorCode::ScreenShareAudioStartFailed)?;
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
    use super::{
        AUDIO_QUEUE_CAPACITY, AudioQueue, CAPTURE_BITS_PER_SAMPLE, CAPTURE_CHANNELS,
        CAPTURE_SAMPLE_RATE, CaptureMode, ChunkAssembler, SampleEncoding, StreamFormat,
        WAVE_FORMAT_EXTENSIBLE_TAG, WAVE_FORMAT_IEEE_FLOAT_TAG, WAVE_FORMAT_PCM_TAG, WAVEFORMATEX,
        WAVEFORMATEXTENSIBLE, capture_mode, normalize_to_stereo_f32, parse_mix_format,
        process_capture_packet, supported_capture_format,
    };
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use windows::Win32::Media::KernelStreaming::KSDATAFORMAT_SUBTYPE_PCM;
    use windows::Win32::Media::Multimedia::KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;

    fn format(
        encoding: SampleEncoding,
        channels: u16,
        bits: u16,
        channel_mask: u32,
    ) -> StreamFormat {
        let block_align = channels * (bits / 8);
        StreamFormat {
            wave_format: WAVEFORMATEX {
                wFormatTag: if encoding == SampleEncoding::Pcm {
                    WAVE_FORMAT_PCM_TAG
                } else {
                    WAVE_FORMAT_IEEE_FLOAT_TAG
                },
                nChannels: channels,
                nSamplesPerSec: 48_000,
                nAvgBytesPerSec: 48_000 * u32::from(block_align),
                nBlockAlign: block_align,
                wBitsPerSample: bits,
                cbSize: 0,
            },
            sample_rate: 48_000,
            channels,
            bits_per_sample: bits,
            valid_bits_per_sample: bits,
            channel_mask,
            encoding,
        }
    }

    fn output_samples(output: &[u8]) -> Vec<f32> {
        output
            .chunks_exact(4)
            .map(|sample| f32::from_le_bytes(sample.try_into().unwrap()))
            .collect()
    }

    #[test]
    fn windows_build_selects_process_loopback_or_explicit_legacy_system_mix() {
        assert_eq!(capture_mode((10, 19045)), CaptureMode::ProcessLoopback);
        assert_eq!(capture_mode((10, 19041)), CaptureMode::ProcessLoopback);
        assert_eq!(capture_mode((10, 19040)), CaptureMode::SystemMixLoopback);
        assert_eq!(capture_mode((10, 15063)), CaptureMode::SystemMixLoopback);
        assert_eq!(capture_mode((10, 15062)), CaptureMode::Unsupported);
        assert_eq!(capture_mode((10, 20348)), CaptureMode::ProcessLoopback);
        assert_eq!(capture_mode((10, 22631)), CaptureMode::ProcessLoopback);
        assert_eq!(capture_mode((6, 19045)), CaptureMode::Unsupported);
    }

    #[test]
    fn valid_capture_packets_larger_than_4096_frames_are_queued_without_loss() {
        let format = format(SampleEncoding::Pcm, 2, 16, 0);
        let frames = 5_280;
        let mut input = vec![0_u8; frames * usize::from(format.wave_format.nBlockAlign)];
        let mut assembler = ChunkAssembler::new(format.sample_rate).unwrap();
        let queue = Arc::new(AudioQueue::default());

        process_capture_packet(
            input.as_mut_ptr(),
            frames as u32,
            &format,
            false,
            &mut assembler,
            &queue,
            &AtomicBool::new(false),
        )
        .unwrap();

        queue.close();
        let blocks = std::iter::from_fn(|| queue.pop()).collect::<Vec<_>>();
        assert_eq!(blocks.len(), 11);
        assert!(blocks.iter().all(|block| block.len() == 480 * 2 * 4));
        assert!(assembler.pending.is_empty());
        assert_eq!(queue.dropped.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn malformed_capture_packets_report_capture_failure_instead_of_format_failure() {
        let format = format(SampleEncoding::Pcm, 2, 16, 0);
        let mut assembler = ChunkAssembler::new(format.sample_rate).unwrap();
        let queue = Arc::new(AudioQueue::default());
        let result = process_capture_packet(
            std::ptr::null_mut(),
            1,
            &format,
            false,
            &mut assembler,
            &queue,
            &AtomicBool::new(false),
        );
        assert!(matches!(
            result,
            Err(super::ErrorCode::ScreenShareAudioFailed)
        ));
    }

    #[test]
    fn assembler_outputs_fixed_ten_millisecond_stereo_blocks() {
        let mut assembler = ChunkAssembler::new(48_000).unwrap();
        let first = assembler.push(&vec![1; 480 * 8]);
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].len(), 480 * 8);
        let next = assembler.push(&vec![2; 480 * 8 * 3 + 40]);
        assert_eq!(next.len(), 3);
        assert!(next.iter().all(|block| block.len() == 480 * 8));
        assert_eq!(assembler.pending.len(), 40);
    }

    #[test]
    fn bounded_queue_drops_oldest_pcm_chunk_on_overload() {
        let queue = AudioQueue::default();
        for value in 0..AUDIO_QUEUE_CAPACITY + 3 {
            queue.push(vec![value as u8]);
        }
        assert_eq!(queue.dropped.load(Ordering::Relaxed), 3);
        queue.close();
        let blocks = std::iter::from_fn(|| queue.pop()).collect::<Vec<_>>();
        assert_eq!(blocks.len(), AUDIO_QUEUE_CAPACITY);
        assert_eq!(blocks.first(), Some(&vec![3]));
        assert_eq!(blocks.last(), Some(&vec![(AUDIO_QUEUE_CAPACITY + 2) as u8]));
    }

    #[test]
    fn process_loopback_uses_explicit_stereo_pcm16_format() {
        let format = supported_capture_format();
        let tag = format.wave_format.wFormatTag;
        let sample_rate = format.wave_format.nSamplesPerSec;
        let channels = format.wave_format.nChannels;
        let bits_per_sample = format.wave_format.wBitsPerSample;
        let block_align = format.wave_format.nBlockAlign;
        let bytes_per_second = format.wave_format.nAvgBytesPerSec;
        assert_eq!(tag, super::WAVE_FORMAT_PCM_TAG);
        assert_eq!(sample_rate, CAPTURE_SAMPLE_RATE);
        assert_eq!(channels, CAPTURE_CHANNELS);
        assert_eq!(bits_per_sample, CAPTURE_BITS_PER_SAMPLE);
        assert_eq!(block_align, 4);
        assert_eq!(bytes_per_second, 176_400);
        assert_eq!(format.sample_rate, CAPTURE_SAMPLE_RATE);
        assert_eq!(format.channels, CAPTURE_CHANNELS);
    }

    #[test]
    fn pcm16_conversion_keeps_the_reported_rate_and_stereo_channel_layout() {
        let format = supported_capture_format();
        let mut input = [i16::MIN, i16::MAX, 0, 16_384];
        let output = normalize_to_stereo_f32(input.as_mut_ptr().cast(), 2, &format, false).unwrap();
        let (samples, remainder) = output.as_chunks::<4>();
        assert!(remainder.is_empty());
        let samples = samples
            .iter()
            .map(|sample| f32::from_le_bytes(*sample))
            .collect::<Vec<_>>();
        assert_eq!(format.sample_rate, CAPTURE_SAMPLE_RATE);
        assert_eq!(format.channels, CAPTURE_CHANNELS);
        assert_eq!(samples, [-1.0, 32767.0 / 32768.0, 0.0, 0.5]);
    }

    #[test]
    fn ieee_float_mix_is_read_as_float_and_non_finite_samples_become_silence() {
        let format = format(SampleEncoding::IeeeFloat, 2, 32, 0);
        let mut input = [0.25_f32, -0.5, f32::NAN, f32::INFINITY];
        let output = normalize_to_stereo_f32(input.as_mut_ptr().cast(), 2, &format, false).unwrap();
        assert_eq!(output_samples(&output), [0.25, -0.5, 0.0, 0.0]);
    }

    #[test]
    fn extensible_mix_parses_pcm_and_downmixes_center_channel() {
        let wave = WAVEFORMATEX {
            wFormatTag: WAVE_FORMAT_EXTENSIBLE_TAG,
            nChannels: 3,
            nSamplesPerSec: 48_000,
            nAvgBytesPerSec: 48_000 * 6,
            nBlockAlign: 6,
            wBitsPerSample: 16,
            cbSize: 22,
        };
        let extensible = WAVEFORMATEXTENSIBLE {
            Format: wave,
            Samples: windows::Win32::Media::Audio::WAVEFORMATEXTENSIBLE_0 {
                wValidBitsPerSample: 16,
            },
            dwChannelMask: 0x7,
            SubFormat: KSDATAFORMAT_SUBTYPE_PCM,
        };
        let format = parse_mix_format(wave, Some(extensible)).unwrap();
        let mut input = [0_i16, 0_i16, i16::MAX];
        let output = normalize_to_stereo_f32(input.as_mut_ptr().cast(), 1, &format, false).unwrap();
        let samples = output_samples(&output);
        assert!(samples[0] > 0.70 && samples[0] < 0.71);
        assert!(samples[1] > 0.70 && samples[1] < 0.71);
    }

    #[test]
    fn extensible_ieee_float_mix_is_supported() {
        let wave = WAVEFORMATEX {
            wFormatTag: WAVE_FORMAT_EXTENSIBLE_TAG,
            nChannels: 2,
            nSamplesPerSec: 48_000,
            nAvgBytesPerSec: 48_000 * 8,
            nBlockAlign: 8,
            wBitsPerSample: 32,
            cbSize: 22,
        };
        let extensible = WAVEFORMATEXTENSIBLE {
            Format: wave,
            Samples: windows::Win32::Media::Audio::WAVEFORMATEXTENSIBLE_0 {
                wValidBitsPerSample: 32,
            },
            dwChannelMask: 3,
            SubFormat: KSDATAFORMAT_SUBTYPE_IEEE_FLOAT,
        };
        let format = parse_mix_format(wave, Some(extensible)).unwrap();
        assert_eq!(format.encoding, SampleEncoding::IeeeFloat);
        let mut input = [0.75_f32, -0.125_f32];
        let output = normalize_to_stereo_f32(input.as_mut_ptr().cast(), 1, &format, false).unwrap();
        assert_eq!(output_samples(&output), [0.75, -0.125]);
    }

    #[test]
    fn unsupported_mix_subformat_and_invalid_block_alignment_are_rejected() {
        let wave = WAVEFORMATEX {
            wFormatTag: WAVE_FORMAT_EXTENSIBLE_TAG,
            nChannels: 2,
            nSamplesPerSec: 48_000,
            nAvgBytesPerSec: 192_000,
            nBlockAlign: 8,
            wBitsPerSample: 32,
            cbSize: 22,
        };
        let unsupported = WAVEFORMATEXTENSIBLE {
            Format: wave,
            Samples: windows::Win32::Media::Audio::WAVEFORMATEXTENSIBLE_0 {
                wValidBitsPerSample: 32,
            },
            dwChannelMask: 3,
            SubFormat: windows::core::GUID::zeroed(),
        };
        assert!(matches!(
            parse_mix_format(wave, Some(unsupported)),
            Err(super::ErrorCode::ScreenShareAudioFormatUnsupported),
        ));
        let mut malformed = wave;
        malformed.wFormatTag = WAVE_FORMAT_PCM_TAG;
        malformed.cbSize = 0;
        malformed.nBlockAlign = 4;
        assert!(matches!(
            parse_mix_format(malformed, None),
            Err(super::ErrorCode::ScreenShareAudioFormatUnsupported),
        ));
        let mut unknown_layout = malformed;
        unknown_layout.nChannels = 3;
        unknown_layout.nBlockAlign = 12;
        assert!(matches!(
            parse_mix_format(unknown_layout, None),
            Err(super::ErrorCode::ScreenShareAudioFormatUnsupported),
        ));
    }

    #[test]
    fn silent_capture_packet_always_emits_zeroed_stereo_float() {
        let format = format(SampleEncoding::IeeeFloat, 2, 32, 0);
        let output = normalize_to_stereo_f32(std::ptr::null_mut(), 2, &format, true).unwrap();
        assert_eq!(output_samples(&output), [0.0; 4]);
    }
}
