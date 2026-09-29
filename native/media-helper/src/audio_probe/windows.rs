use super::{Arc, Mutex, ProbeWorker, WorkerStartFailure, wait_for_worker_start};
use crate::protocol::{AudioProbeState, ErrorCode, MicrophoneProbeDiagnostics};
use ::windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
use ::windows::Win32::Media::Audio::{
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_E_DEVICE_INVALIDATED, AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_EVENTCALLBACK, DEVICE_STATE_ACTIVE, IAudioCaptureClient, IAudioClient,
    IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator, WAVEFORMATEX,
};
use ::windows::Win32::System::Com::{
    CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoTaskMemFree,
    CoUninitialize,
};
use ::windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};
use ::windows::core::PCWSTR;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, SyncSender};
use std::thread::{self, JoinHandle};
use std::time::Duration;

const WAIT_INTERVAL_MS: u32 = 200;
const MAX_PACKETS_PER_WAKE: usize = 32;

pub(super) struct Worker {
    stop_requested: Arc<AtomicBool>,
    join: Option<JoinHandle<Result<(), ErrorCode>>>,
}

impl Worker {
    fn is_finished(&self) -> bool {
        self.join.as_ref().is_none_or(JoinHandle::is_finished)
    }

    fn join_thread(&mut self) -> Result<(), ErrorCode> {
        if let Some(join) = self.join.take() {
            return join.join().map_err(|_| ErrorCode::AudioProbeStopFailed)?;
        }
        Ok(())
    }
}

impl ProbeWorker for Worker {
    fn request_stop(&self) {
        self.stop_requested.store(true, Ordering::Release);
    }

    fn is_finished(&self) -> bool {
        Worker::is_finished(self)
    }

    fn join(&mut self) -> Result<(), ErrorCode> {
        self.join_thread()
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        // Rust cannot safely force-stop this thread; joining may wait on a stuck COM call.
        self.stop_requested.store(true, Ordering::Release);
        let _ = self.join_thread();
    }
}

pub(super) fn start(
    endpoint_id: String,
    diagnostics: Arc<Mutex<MicrophoneProbeDiagnostics>>,
) -> Result<Box<dyn ProbeWorker>, WorkerStartFailure> {
    let stop_requested = Arc::new(AtomicBool::new(false));
    let thread_stop = Arc::clone(&stop_requested);
    let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
    let thread_diagnostics = Arc::clone(&diagnostics);
    let join = thread::Builder::new()
        .name("lycansync-mic-probe".to_owned())
        .spawn(move || {
            let result = worker_main(endpoint_id, thread_diagnostics, thread_stop, &ready_sender);
            if let Err(error) = result {
                let _ = ready_sender.send(Err(error));
            }
            result
        })
        .map_err(|_| WorkerStartFailure {
            error: ErrorCode::AudioProbeStartFailed,
            worker: None,
            pending: false,
        })?;
    let worker = Worker {
        stop_requested,
        join: Some(join),
    };

    wait_for_worker_start(ready_receiver, Box::new(worker), Duration::from_secs(10))
}

fn worker_main(
    endpoint_id: String,
    diagnostics: Arc<Mutex<MicrophoneProbeDiagnostics>>,
    stop_requested: Arc<AtomicBool>,
    ready: &SyncSender<Result<(), ErrorCode>>,
) -> Result<(), ErrorCode> {
    let _apartment = match ComApartment::initialize() {
        Ok(apartment) => apartment,
        Err(error) => {
            set_start_error(&diagnostics, error);
            return Err(error);
        }
    };
    let setup = setup_capture(&endpoint_id);
    let (device, client, capture_client, event, format) = match setup {
        Ok(resources) => resources,
        Err(error) => {
            set_start_error(&diagnostics, error);
            return Err(error);
        }
    };

    if stop_requested.load(Ordering::Acquire) {
        return Err(ErrorCode::AudioProbeStartTimedOut);
    }

    if let Err(error) = unsafe { client.Start() } {
        let error = map_audio_error(error);
        set_start_error(&diagnostics, error);
        return Err(error);
    }
    {
        let mut snapshot = diagnostics
            .lock()
            .expect("microphone probe diagnostics lock poisoned");
        snapshot.state = AudioProbeState::Running;
        snapshot.sample_rate = Some(format.sample_rate);
        snapshot.channels = Some(format.channels);
        snapshot.bits_per_sample = Some(format.bits_per_sample);
        snapshot.packets_received = Some(0);
        snapshot.frames_received = Some(0);
        snapshot.silent_flag_packets = Some(0);
    }
    if ready.send(Ok(())).is_err() {
        let stop_result = unsafe { client.Stop() };
        drop(capture_client);
        drop(client);
        drop(device);
        drop(event);
        return match stop_result {
            Ok(()) => Err(ErrorCode::AudioProbeStartTimedOut),
            Err(error) => {
                let error = map_audio_error(error);
                set_start_error(&diagnostics, error);
                Err(error)
            }
        };
    }

    let result = capture_loop(
        &device,
        &capture_client,
        event.0,
        &diagnostics,
        &stop_requested,
    );
    let stop_result = unsafe { client.Stop() };
    drop(capture_client);
    drop(client);
    drop(device);
    drop(event);

    let mut snapshot = diagnostics
        .lock()
        .expect("microphone probe diagnostics lock poisoned");
    let outcome = result.and(stop_result.map_err(map_audio_error));
    match outcome {
        Ok(()) => {
            if !stop_requested.load(Ordering::Acquire) {
                snapshot.state = AudioProbeState::Idle;
                snapshot.session_id = None;
            }
        }
        Err(error) => {
            snapshot.state = AudioProbeState::Failed;
            snapshot.last_error = Some(error.diagnostic_name());
        }
    }
    outcome
}

fn setup_capture(
    endpoint_id: &str,
) -> Result<
    (
        IMMDevice,
        IAudioClient,
        IAudioCaptureClient,
        EventHandle,
        StreamFormat,
    ),
    ErrorCode,
> {
    let enumerator: IMMDeviceEnumerator = unsafe {
        CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
            .map_err(|_| ErrorCode::AudioProbeStartFailed)?
    };
    let endpoint_wide = endpoint_id
        .encode_utf16()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let endpoint = unsafe { enumerator.GetDevice(PCWSTR(endpoint_wide.as_ptr())) }
        .map_err(|_| ErrorCode::AudioDeviceUnavailable)?;
    let state = unsafe { endpoint.GetState() }.map_err(|_| ErrorCode::AudioDeviceUnavailable)?;
    if state.0 & DEVICE_STATE_ACTIVE.0 == 0 {
        return Err(ErrorCode::AudioDeviceUnavailable);
    }
    let client: IAudioClient = unsafe { endpoint.Activate(CLSCTX_ALL, None) }
        .map_err(|_| ErrorCode::AudioProbeStartFailed)?;
    let format_pointer =
        TaskFormat(unsafe { client.GetMixFormat() }.map_err(|_| ErrorCode::AudioProbeStartFailed)?);
    if format_pointer.0.is_null() {
        return Err(ErrorCode::AudioProbeStartFailed);
    }
    let format = unsafe {
        StreamFormat {
            sample_rate: (*format_pointer.0).nSamplesPerSec,
            channels: (*format_pointer.0).nChannels,
            bits_per_sample: (*format_pointer.0).wBitsPerSample,
        }
    };
    let event = EventHandle(
        unsafe { CreateEventW(None, false, false, None) }
            .map_err(|_| ErrorCode::AudioProbeStartFailed)?,
    );
    let initialize_result = unsafe {
        client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
            0,
            0,
            format_pointer.0,
            None,
        )
    };
    initialize_result.map_err(map_audio_error)?;
    // WASAPI requires the event handle after Initialize and before Start.
    unsafe { client.SetEventHandle(event.0) }.map_err(map_audio_error)?;
    let capture_client: IAudioCaptureClient =
        unsafe { client.GetService() }.map_err(|_| ErrorCode::AudioProbeStartFailed)?;
    Ok((endpoint, client, capture_client, event, format))
}

fn capture_loop(
    device: &IMMDevice,
    capture_client: &IAudioCaptureClient,
    event: HANDLE,
    diagnostics: &Arc<Mutex<MicrophoneProbeDiagnostics>>,
    stop_requested: &AtomicBool,
) -> Result<(), ErrorCode> {
    while !stop_requested.load(Ordering::Acquire) {
        match unsafe { WaitForSingleObject(event, WAIT_INTERVAL_MS) } {
            WAIT_OBJECT_0 => drain_packets(capture_client, diagnostics, stop_requested)?,
            WAIT_TIMEOUT => {
                let state =
                    unsafe { device.GetState() }.map_err(|_| ErrorCode::AudioDeviceUnavailable)?;
                if state.0 & DEVICE_STATE_ACTIVE.0 == 0 {
                    return Err(ErrorCode::AudioDeviceUnavailable);
                }
            }
            _ => return Err(ErrorCode::AudioProbeFailed),
        }
    }
    Ok(())
}

fn drain_packets(
    capture_client: &IAudioCaptureClient,
    diagnostics: &Arc<Mutex<MicrophoneProbeDiagnostics>>,
    stop_requested: &AtomicBool,
) -> Result<(), ErrorCode> {
    for _ in 0..MAX_PACKETS_PER_WAKE {
        if stop_requested.load(Ordering::Acquire) {
            break;
        }
        let frames = unsafe { capture_client.GetNextPacketSize() }.map_err(map_audio_error)?;
        if frames == 0 {
            break;
        }
        let mut data = std::ptr::null_mut();
        let mut frame_count = 0;
        let mut flags = 0;
        unsafe {
            capture_client
                .GetBuffer(&mut data, &mut frame_count, &mut flags, None, None)
                .map_err(map_audio_error)?;
        }
        let _ = data;
        {
            let mut snapshot = diagnostics
                .lock()
                .expect("microphone probe diagnostics lock poisoned");
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
                    .saturating_add(frame_count as u64),
            );
            if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 {
                snapshot.silent_flag_packets = Some(
                    snapshot
                        .silent_flag_packets
                        .unwrap_or_default()
                        .saturating_add(1),
                );
            }
        }
        unsafe { capture_client.ReleaseBuffer(frame_count) }.map_err(map_audio_error)?;
    }
    Ok(())
}

fn set_start_error(diagnostics: &Arc<Mutex<MicrophoneProbeDiagnostics>>, error: ErrorCode) {
    let mut snapshot = diagnostics
        .lock()
        .expect("microphone probe diagnostics lock poisoned");
    snapshot.state = AudioProbeState::Failed;
    snapshot.last_error = Some(error.diagnostic_name());
}

fn map_audio_error(error: ::windows::core::Error) -> ErrorCode {
    if error.code() == AUDCLNT_E_DEVICE_INVALIDATED {
        ErrorCode::AudioDeviceUnavailable
    } else {
        ErrorCode::AudioProbeFailed
    }
}

#[derive(Clone, Copy)]
struct StreamFormat {
    sample_rate: u32,
    channels: u16,
    bits_per_sample: u16,
}

struct ComApartment;

impl ComApartment {
    fn initialize() -> Result<Self, ErrorCode> {
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
            .ok()
            .map_err(|_| ErrorCode::AudioProbeStartFailed)?;
        Ok(Self)
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

struct EventHandle(HANDLE);

impl Drop for EventHandle {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.0) };
    }
}

struct TaskFormat(*mut WAVEFORMATEX);

impl Drop for TaskFormat {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CoTaskMemFree(Some(self.0.cast())) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Worker;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::thread;
    use std::time::Duration;

    struct DropFlag(Arc<AtomicBool>);

    impl Drop for DropFlag {
        fn drop(&mut self) {
            self.0.store(true, Ordering::Release);
        }
    }

    #[test]
    fn dropping_worker_requests_stop_and_joins_resource_owner() {
        let stop_requested = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop_requested);
        let resources_dropped = Arc::new(AtomicBool::new(false));
        let thread_resources = Arc::clone(&resources_dropped);
        let join = thread::spawn(move || {
            let _resources = DropFlag(thread_resources);
            while !thread_stop.load(Ordering::Acquire) {
                thread::park_timeout(Duration::from_millis(10));
            }
            Ok::<(), crate::protocol::ErrorCode>(())
        });
        let worker = Worker {
            stop_requested: Arc::clone(&stop_requested),
            join: Some(join),
        };

        drop(worker);

        assert!(stop_requested.load(Ordering::Acquire));
        assert!(resources_dropped.load(Ordering::Acquire));
    }
}
