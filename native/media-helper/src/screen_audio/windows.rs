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
use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows::Win32::Media::Audio::{
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
    AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0,
    AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
    ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
    IActivateAudioInterfaceCompletionHandler, IAudioCaptureClient, IAudioClient,
    PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
    PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
    WAVE_FORMAT_PCM, WAVEFORMATEX,
};
use windows::Win32::System::Com::{
    BLOB,
    StructuredStorage::{PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0},
};
use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx};
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
const MAX_AUDIO_FRAMES_PER_PACKET: u32 = 4096;
const AUDIO_QUEUE_CAPACITY: usize = 2;
const AUDIO_PIPE_PREFIX: &str = r"\\.\pipe\lycansync-screen-audio-";
const CAPTURE_SAMPLE_RATE: u32 = 44_100;
const CAPTURE_CHANNELS: u16 = 2;
const CAPTURE_BITS_PER_SAMPLE: u16 = 16;

pub(super) fn capability() -> Capability {
    let available = windows_build_supports_loopback();
    Capability {
        available,
        reason: if available {
            "windowsApplicationLoopbackProcessTree"
        } else {
            "windowsApplicationLoopbackRequiresBuild20348"
        },
    }
}

pub(super) fn start(
    pipe_id: String,
    source_kind: VideoSourceKind,
    process_identity: Option<(u32, u64)>,
    diagnostics: Arc<Mutex<ScreenShareAudioDiagnostics>>,
) -> Result<StartedAudio, StartFailure> {
    if !windows_build_supports_loopback()
        || (source_kind == VideoSourceKind::Window && process_identity.is_none())
    {
        return Err(StartFailure {
            error: if windows_build_supports_loopback() {
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
    let (client, format) = match activate_process_loopback(target_process_identity, loopback_mode) {
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
    if unsafe {
        client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
            0,
            0,
            &format.wave_format,
            None,
        )
    }
    .is_err()
    {
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
}

fn capture_loop(context: CaptureLoop<'_>) -> Result<(), ErrorCode> {
    let mut assembler = ChunkAssembler::new(context.format.sample_rate)?;
    while !context.stop_requested.load(Ordering::Acquire) {
        if context.writer_failed.load(Ordering::Acquire) {
            return Err(ErrorCode::ScreenShareAudioPipeFailed);
        }
        match unsafe { WaitForSingleObject(context.event, WAIT_INTERVAL_MS) } {
            WAIT_OBJECT_0 => drain_packets(
                context.client,
                context.capture_client,
                context.format,
                &mut assembler,
                context.queue,
                context.diagnostics,
                context.stop_requested,
            )?,
            WAIT_TIMEOUT => {}
            _ => return Err(ErrorCode::ScreenShareAudioFailed),
        }
    }
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
        if received_frames > MAX_AUDIO_FRAMES_PER_PACKET {
            unsafe { capture_client.ReleaseBuffer(received_frames) }
                .map_err(|_| ErrorCode::ScreenShareAudioFailed)?;
            return Err(ErrorCode::ScreenShareAudioFormatUnsupported);
        }
        let silent = flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0;
        let block = match normalize_to_stereo_f32(data, received_frames, format, silent) {
            Ok(block) => block,
            Err(error) => {
                unsafe { capture_client.ReleaseBuffer(received_frames) }
                    .map_err(|_| ErrorCode::ScreenShareAudioFailed)?;
                return Err(error);
            }
        };
        for chunk in assembler.push(&block) {
            queue.push(chunk);
        }
        unsafe { capture_client.ReleaseBuffer(received_frames) }
            .map_err(|_| ErrorCode::ScreenShareAudioFailed)?;
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

struct ChunkAssembler {
    chunk_bytes: usize,
    pending: Vec<u8>,
}

impl ChunkAssembler {
    fn new(sample_rate: u32) -> Result<Self, ErrorCode> {
        let frames_per_chunk = (sample_rate / 100).max(1) as usize;
        let chunk_bytes = frames_per_chunk
            .checked_mul(2 * 4)
            .filter(|size| *size <= MAX_AUDIO_FRAMES_PER_PACKET as usize * 2 * 4)
            .ok_or(ErrorCode::ScreenShareAudioFormatUnsupported)?;
        Ok(Self {
            chunk_bytes,
            pending: Vec::with_capacity(chunk_bytes * 2),
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
    let samples = (frames as usize)
        .checked_mul(2)
        .ok_or(ErrorCode::ScreenShareAudioFormatUnsupported)?;
    let mut output = Vec::with_capacity(samples * 4);
    if silent {
        output.resize(samples * 4, 0);
        return Ok(output);
    }
    if data.is_null() {
        return Err(ErrorCode::ScreenShareAudioFailed);
    }
    for frame in 0..frames as usize {
        for channel in 0..2 {
            let source_channel = channel.min(format.channels as usize - 1);
            let sample_index = frame * format.channels as usize + source_channel;
            let sample = unsafe { sample_as_f32(data, sample_index, format)? };
            output.extend_from_slice(&sample.clamp(-1.0, 1.0).to_le_bytes());
        }
    }
    Ok(output)
}

unsafe fn sample_as_f32(
    data: *mut u8,
    sample_index: usize,
    format: &StreamFormat,
) -> Result<f32, ErrorCode> {
    unsafe {
        match format.bits_per_sample {
            16 => Ok(
                std::ptr::read_unaligned(data.add(sample_index * 2).cast::<i16>()) as f32 / 32768.0,
            ),
            24 => {
                let offset = sample_index * 3;
                let bytes = [
                    *data.add(offset),
                    *data.add(offset + 1),
                    *data.add(offset + 2),
                ];
                let value =
                    ((bytes[2] as i32) << 24 | (bytes[1] as i32) << 16 | (bytes[0] as i32) << 8)
                        >> 8;
                Ok(value as f32 / 8_388_608.0)
            }
            32 => Ok(
                std::ptr::read_unaligned(data.add(sample_index * 4).cast::<i32>()) as f32
                    / 2_147_483_648.0,
            ),
            _ => Err(ErrorCode::ScreenShareAudioFormatUnsupported),
        }
    }
}

struct StreamFormat {
    wave_format: WAVEFORMATEX,
    sample_rate: u32,
    channels: u16,
    bits_per_sample: u16,
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
    }
}

fn activate_process_loopback(
    process_identity: (u32, u64),
    mode: windows::Win32::Media::Audio::PROCESS_LOOPBACK_MODE,
) -> Result<(IAudioClient, StreamFormat), ErrorCode> {
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
    Ok((client, stream))
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

fn windows_build_supports_loopback() -> bool {
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
    unsafe { RtlGetVersion(&mut version) == 0 && version.major >= 10 && version.build >= 20348 }
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
        CAPTURE_SAMPLE_RATE, ChunkAssembler, WAVE_FORMAT_PCM, normalize_to_stereo_f32,
        supported_capture_format,
    };
    use std::sync::atomic::Ordering;

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
        queue.push(vec![1]);
        queue.push(vec![2]);
        queue.push(vec![3]);
        assert_eq!(queue.dropped.load(Ordering::Relaxed), 1);
        let blocks = queue.blocks.lock().unwrap();
        assert_eq!(blocks.len(), AUDIO_QUEUE_CAPACITY);
        assert_eq!(blocks[0], vec![2]);
        assert_eq!(blocks[1], vec![3]);
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
        assert_eq!(tag, WAVE_FORMAT_PCM as u16);
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
}
