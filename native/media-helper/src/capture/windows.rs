use super::CaptureSnapshot;
use crate::d3d::HardwareD3dDevice;
use crate::protocol::{ErrorCode, VideoSourceKind};
use crate::sources::ThreadCaptureTarget;
use std::collections::VecDeque;
#[cfg(feature = "shared-texture-output")]
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use windows::Foundation::{TimeSpan, TypedEventHandler};
#[cfg(feature = "shared-texture-output")]
use windows::Graphics::Capture::Direct3D11CaptureFrame;
use windows::Graphics::Capture::{
    Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession,
};
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Graphics::SizeInt32;
#[cfg(feature = "shared-texture-output")]
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Foundation::{HWND, LPARAM, RECT};
#[cfg(feature = "shared-texture-output")]
use windows::Win32::Graphics::Direct3D11::{
    D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_BOX, D3D11_QUERY_DESC,
    D3D11_QUERY_EVENT, D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX, D3D11_RESOURCE_MISC_SHARED_NTHANDLE,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT, ID3D11Query, ID3D11Texture2D,
};
#[cfg(feature = "shared-texture-output")]
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
#[cfg(feature = "shared-texture-output")]
use windows::Win32::Graphics::Dxgi::{
    DXGI_SHARED_RESOURCE_READ, DXGI_SHARED_RESOURCE_WRITE, IDXGIKeyedMutex, IDXGIResource1,
};
use windows::Win32::Graphics::Gdi::{EnumDisplayMonitors, HDC, HMONITOR, MONITORENUMPROC};
#[cfg(feature = "shared-texture-output")]
use windows::Win32::System::WinRT::Direct3D11::IDirect3DDxgiInterfaceAccess;
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize, RoUninitialize};
#[cfg(feature = "shared-texture-output")]
use windows::core::HRESULT;
#[cfg(feature = "shared-texture-output")]
use windows::core::Interface;
use windows::core::{BOOL, IInspectable, factory};

const NOTIFICATION_CAPACITY: usize = 1;
const FRAME_POOL_BUFFERS: i32 = 2;
const STOP_TIMEOUT: Duration = Duration::from_millis(1_800);
const START_TIMEOUT: Duration = Duration::from_secs(10);
const FRAME_TIME_WINDOW: i64 = 10_000_000;
const MAX_FRAME_TIMESTAMPS: usize = 256;
const WORKER_POLL_INTERVAL: Duration = Duration::from_millis(100);
const TARGET_CHECK_INTERVAL: Duration = Duration::from_millis(500);
const CALLBACK_DRAIN_TIMEOUT: Duration = Duration::from_millis(200);
const MAX_FRAMES_PER_WAKE: usize = 8;
// Coarse growth and no shrinking keep window drags from rebuilding the pool per pixel.
const FRAME_POOL_SIZE_ALIGNMENT: i32 = 64;
const SHARED_TEXTURE_POOL_CAPACITY: usize = 3;
#[cfg(feature = "shared-texture-output")]
const GPU_COPY_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(Default)]
pub(super) struct CaptureManager {
    active: Option<ActiveCapture>,
    last_snapshot: Option<CaptureSnapshot>,
}

struct ActiveCapture {
    stop_requested: Arc<AtomicBool>,
    notifications: SyncSender<()>,
    done: Receiver<()>,
    worker: Option<JoinHandle<()>>,
    metrics: Arc<Mutex<CaptureMetrics>>,
    dropped_notifications: Arc<AtomicU64>,
    #[cfg(feature = "shared-texture-output")]
    shared_slot_releases: SyncSender<usize>,
}

#[derive(Default)]
struct CaptureMetrics {
    source_kind: Option<VideoSourceKind>,
    width: Option<u32>,
    height: Option<u32>,
    received: u64,
    processed: u64,
    // WGC source timestamps use 100 ns units; only strictly increasing values are retained.
    raw_frame_times: VecDeque<i64>,
    // Local monotonic timestamps are recorded after frame metadata has been handled.
    processed_frame_times: VecDeque<Instant>,
    last_frame_at: Option<Instant>,
    last_source_time_at: Option<Instant>,
    last_source_time: Option<i64>,
    raw_timestamp_anomalies: u64,
    size_changes: u64,
    frame_pool_recreates: u64,
    content_size_initialized: bool,
    last_error: Option<&'static str>,
    stop_duration_ms: Option<u64>,
}

impl CaptureMetrics {
    fn new(source_kind: VideoSourceKind) -> Self {
        Self {
            source_kind: Some(source_kind),
            raw_frame_times: VecDeque::with_capacity(MAX_FRAME_TIMESTAMPS),
            processed_frame_times: VecDeque::with_capacity(MAX_FRAME_TIMESTAMPS),
            ..Self::default()
        }
    }

    fn set_initial_size(&mut self, size: SizeInt32) {
        self.width = positive_dimension(size.Width);
        self.height = positive_dimension(size.Height);
    }

    fn update_size(&mut self, size: SizeInt32) {
        let width = positive_dimension(size.Width);
        let height = positive_dimension(size.Height);
        if width.is_none() || height.is_none() {
            self.last_error = Some("invalidFrameSize");
            return;
        }
        if !self.content_size_initialized {
            self.width = width;
            self.height = height;
            self.content_size_initialized = true;
        } else if self.width != width || self.height != height {
            self.size_changes = self.size_changes.saturating_add(1);
            self.width = width;
            self.height = height;
        }
    }

    fn record_frame(&mut self, time: TimeSpan, size: SizeInt32, completed_at: Instant) {
        self.update_size(size);
        let timestamp = time.Duration;
        match self.last_source_time {
            Some(previous) if timestamp == previous => {
                self.raw_timestamp_anomalies = self.raw_timestamp_anomalies.saturating_add(1);
            }
            Some(previous) if timestamp < previous => {
                self.raw_timestamp_anomalies = self.raw_timestamp_anomalies.saturating_add(1);
                self.raw_frame_times.clear();
                push_frame_time(&mut self.raw_frame_times, timestamp);
                self.last_source_time = Some(timestamp);
                self.last_source_time_at = Some(completed_at);
            }
            _ => {
                push_frame_time(&mut self.raw_frame_times, timestamp);
                self.last_source_time = Some(timestamp);
                self.last_source_time_at = Some(completed_at);
                self.prune_source_times(timestamp);
            }
        }
        push_processed_time(&mut self.processed_frame_times, completed_at);
        self.prune_processed_times(completed_at);
        self.last_frame_at = Some(completed_at);
        self.processed = self.processed.saturating_add(1);
    }

    fn prune_source_times(&mut self, timestamp: i64) {
        let cutoff = timestamp.saturating_sub(FRAME_TIME_WINDOW);
        prune_times(&mut self.raw_frame_times, cutoff);
    }

    fn prune_processed_times(&mut self, now: Instant) {
        while self
            .processed_frame_times
            .front()
            .is_some_and(|oldest| now.saturating_duration_since(*oldest) > Duration::from_secs(1))
        {
            self.processed_frame_times.pop_front();
        }
    }

    fn snapshot(&self, dropped_notifications: u64) -> CaptureSnapshot {
        self.snapshot_at(dropped_notifications, Instant::now())
    }

    fn snapshot_at(&self, dropped_notifications: u64, now: Instant) -> CaptureSnapshot {
        let raw_is_fresh = self
            .last_source_time_at
            .is_some_and(|last| now.saturating_duration_since(last) <= Duration::from_secs(1));
        let processed_is_fresh = self
            .last_frame_at
            .is_some_and(|last| now.saturating_duration_since(last) <= Duration::from_secs(1));
        let raw_capture_fps = raw_is_fresh
            .then(|| recent_source_fps(&self.raw_frame_times))
            .flatten();
        let probe_processed_fps = processed_is_fresh
            .then(|| recent_processed_fps(&self.processed_frame_times, now))
            .flatten();
        let (raw_frame_interval_p50_ms, raw_frame_interval_p95_ms, raw_frame_interval_p99_ms) =
            if raw_is_fresh {
                (
                    source_interval_percentile_ms(&self.raw_frame_times, 50),
                    source_interval_percentile_ms(&self.raw_frame_times, 95),
                    source_interval_percentile_ms(&self.raw_frame_times, 99),
                )
            } else {
                (None, None, None)
            };
        CaptureSnapshot {
            source_kind: self.source_kind,
            frame_width: self.width,
            frame_height: self.height,
            frames_received: Some(self.received),
            frames_processed: Some(self.processed),
            dropped_notifications: Some(dropped_notifications),
            raw_capture_fps,
            probe_processed_fps,
            raw_frame_interval_p50_ms,
            raw_frame_interval_p95_ms,
            raw_frame_interval_p99_ms,
            raw_timestamp_anomalies: Some(self.raw_timestamp_anomalies),
            last_frame_age_ms: self.last_frame_at.map(|last_frame| {
                now.saturating_duration_since(last_frame)
                    .as_millis()
                    .min(u64::MAX as u128) as u64
            }),
            size_changes: Some(self.size_changes),
            frame_pool_recreates: Some(self.frame_pool_recreates),
            last_capture_error: self.last_error,
            stop_duration_ms: self.stop_duration_ms,
        }
    }
}

fn push_frame_time(times: &mut VecDeque<i64>, timestamp: i64) {
    if times.len() == MAX_FRAME_TIMESTAMPS {
        times.pop_front();
    }
    times.push_back(timestamp);
}

fn push_processed_time(times: &mut VecDeque<Instant>, timestamp: Instant) {
    if times.len() == MAX_FRAME_TIMESTAMPS {
        times.pop_front();
    }
    times.push_back(timestamp);
}

fn prune_times(times: &mut VecDeque<i64>, cutoff: i64) {
    while times.front().is_some_and(|oldest| *oldest < cutoff) {
        times.pop_front();
    }
}

fn recent_source_fps(times: &VecDeque<i64>) -> Option<f64> {
    if times.len() < 2 {
        return None;
    }
    let first = *times.front()?;
    let last = *times.back()?;
    let elapsed = last.checked_sub(first)?;
    (elapsed > 0).then(|| (times.len() - 1) as f64 * 10_000_000.0 / elapsed as f64)
}

fn recent_processed_fps(times: &VecDeque<Instant>, now: Instant) -> Option<f64> {
    let mut recent = times
        .iter()
        .filter(|time| now.saturating_duration_since(**time) <= Duration::from_secs(1));
    let first = *recent.next()?;
    let (last, count) = recent.fold((first, 1usize), |(_, count), time| (*time, count + 1));
    if count < 2 {
        return None;
    }
    let elapsed = last.saturating_duration_since(first).as_secs_f64();
    (elapsed > 0.0).then_some((count - 1) as f64 / elapsed)
}

fn source_interval_percentile_ms(times: &VecDeque<i64>, percentile: usize) -> Option<f64> {
    let mut intervals = [0_u64; MAX_FRAME_TIMESTAMPS];
    let mut count = 0;
    let mut previous = None;
    for timestamp in times {
        if let Some(interval) = previous
            .and_then(|value: i64| timestamp.checked_sub(value))
            .filter(|value| *value > 0)
        {
            intervals[count] = interval as u64;
            count += 1;
        }
        previous = Some(*timestamp);
    }
    if count == 0 {
        return None;
    }
    let values = &mut intervals[..count];
    values.sort_unstable();
    let rank = (percentile * count).div_ceil(100).clamp(1, count) - 1;
    Some(values[rank] as f64 / 10_000.0)
}

fn positive_dimension(value: i32) -> Option<u32> {
    (value > 0).then_some(value as u32)
}

fn lock_metrics(metrics: &Mutex<CaptureMetrics>) -> MutexGuard<'_, CaptureMetrics> {
    metrics
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl CaptureManager {
    pub(super) fn start(
        &mut self,
        target: ThreadCaptureTarget,
        source_kind: VideoSourceKind,
        session_id: String,
        max_fps: Option<u16>,
    ) -> Result<(), ErrorCode> {
        if self.active.is_some() {
            return Err(ErrorCode::CaptureAlreadyRunning);
        }

        let metrics = Arc::new(Mutex::new(CaptureMetrics::new(source_kind)));
        let dropped_notifications = Arc::new(AtomicU64::new(0));
        let stop_requested = Arc::new(AtomicBool::new(false));
        let (notification_sender, notification_receiver) =
            mpsc::sync_channel(NOTIFICATION_CAPACITY);
        let (shared_slot_release_sender, shared_slot_release_receiver) =
            mpsc::sync_channel(SHARED_TEXTURE_POOL_CAPACITY);
        #[cfg(not(feature = "shared-texture-output"))]
        drop(shared_slot_release_sender);
        let (startup_sender, startup_receiver) = mpsc::sync_channel(1);
        let (done_sender, done_receiver) = mpsc::channel();
        let worker_metrics = Arc::clone(&metrics);
        let worker_dropped = Arc::clone(&dropped_notifications);
        let worker_stop = Arc::clone(&stop_requested);
        let worker_sender = notification_sender.clone();

        let worker = thread::Builder::new()
            .name("lycansync-wgc-capture".to_owned())
            .spawn(move || {
                capture_worker(
                    target,
                    CaptureWorkerContext {
                        session_id,
                        max_fps,
                        metrics: worker_metrics,
                        dropped_notifications: worker_dropped,
                        stop_requested: worker_stop,
                        notifications: worker_sender,
                        notification_receiver,
                        shared_slot_release_receiver,
                        startup: startup_sender,
                    },
                );
                let _ = done_sender.send(());
            })
            .map_err(|_| ErrorCode::CaptureStartFailed)?;

        match startup_receiver.recv_timeout(START_TIMEOUT) {
            Ok(Ok(())) => {
                self.active = Some(ActiveCapture {
                    stop_requested,
                    notifications: notification_sender,
                    done: done_receiver,
                    worker: Some(worker),
                    metrics,
                    dropped_notifications,
                    #[cfg(feature = "shared-texture-output")]
                    shared_slot_releases: shared_slot_release_sender,
                });
                Ok(())
            }
            Ok(Err(error)) => match done_receiver.recv_timeout(STOP_TIMEOUT) {
                Ok(()) => {
                    let _ = worker.join();
                    self.last_snapshot = Some(snapshot(&metrics, &dropped_notifications));
                    Err(error)
                }
                Err(_) => {
                    self.active = Some(ActiveCapture {
                        stop_requested,
                        notifications: notification_sender,
                        done: done_receiver,
                        worker: Some(worker),
                        metrics,
                        dropped_notifications,
                        #[cfg(feature = "shared-texture-output")]
                        shared_slot_releases: shared_slot_release_sender,
                    });
                    Err(ErrorCode::CaptureStopTimedOut)
                }
            },
            Err(_) => {
                stop_requested.store(true, Ordering::Release);
                let _ = notification_sender.try_send(());
                match done_receiver.recv_timeout(STOP_TIMEOUT) {
                    Ok(()) => {
                        let _ = worker.join();
                        self.last_snapshot = Some(snapshot(&metrics, &dropped_notifications));
                        Err(ErrorCode::CaptureStartFailed)
                    }
                    Err(_) => {
                        self.active = Some(ActiveCapture {
                            stop_requested,
                            notifications: notification_sender,
                            done: done_receiver,
                            worker: Some(worker),
                            metrics,
                            dropped_notifications,
                            #[cfg(feature = "shared-texture-output")]
                            shared_slot_releases: shared_slot_release_sender,
                        });
                        Err(ErrorCode::CaptureStopTimedOut)
                    }
                }
            }
        }
    }

    pub(super) fn stop(&mut self) -> Result<CaptureSnapshot, ErrorCode> {
        let Some(active) = self.active.as_mut() else {
            return Err(ErrorCode::CaptureSessionMismatch);
        };
        let started_at = Instant::now();
        active.stop_requested.store(true, Ordering::Release);
        let _ = active.notifications.try_send(());
        if active.done.recv_timeout(STOP_TIMEOUT).is_err() {
            return Err(ErrorCode::CaptureStopTimedOut);
        }
        if let Some(worker) = active.worker.take() {
            let _ = worker.join();
        }
        let mut result = snapshot(&active.metrics, &active.dropped_notifications);
        result.stop_duration_ms =
            Some(started_at.elapsed().as_millis().min(u64::MAX as u128) as u64);
        self.last_snapshot = Some(result.clone());
        self.active = None;
        Ok(result)
    }

    #[cfg(feature = "shared-texture-output")]
    pub(super) fn release_shared_texture_slot(
        &mut self,
        slot_index: usize,
    ) -> Result<(), ErrorCode> {
        let active = self
            .active
            .as_ref()
            .ok_or(ErrorCode::CaptureSessionMismatch)?;
        if slot_index >= SHARED_TEXTURE_POOL_CAPACITY {
            return Err(ErrorCode::InvalidRequest);
        }
        active
            .shared_slot_releases
            .try_send(slot_index)
            .map_err(|_| ErrorCode::CaptureSessionMismatch)
    }

    pub(super) fn snapshot(&mut self) -> Option<CaptureSnapshot> {
        self.active
            .as_ref()
            .map(|active| snapshot(&active.metrics, &active.dropped_notifications))
            .or_else(|| self.last_snapshot.clone())
    }

    pub(super) fn reap_finished(&mut self) -> Option<CaptureSnapshot> {
        let active = self.active.as_mut()?;
        if active.done.try_recv().is_err() {
            return None;
        }
        if let Some(worker) = active.worker.take() {
            let _ = worker.join();
        }
        let result = snapshot(&active.metrics, &active.dropped_notifications);
        self.last_snapshot = Some(result.clone());
        self.active = None;
        Some(result)
    }
}

impl Drop for CaptureManager {
    fn drop(&mut self) {
        if self.active.is_some() {
            let _ = self.stop();
        }
    }
}

fn snapshot(metrics: &Mutex<CaptureMetrics>, dropped_notifications: &AtomicU64) -> CaptureSnapshot {
    lock_metrics(metrics).snapshot(dropped_notifications.load(Ordering::Relaxed))
}

struct WinRtApartment;

impl WinRtApartment {
    fn initialize() -> Result<Self, ErrorCode> {
        unsafe { RoInitialize(RO_INIT_MULTITHREADED) }
            .map_err(|_| ErrorCode::CaptureStartFailed)?;
        Ok(Self)
    }
}

impl Drop for WinRtApartment {
    fn drop(&mut self) {
        unsafe { RoUninitialize() };
    }
}

struct CaptureResources {
    capture_session: GraphicsCaptureSession,
    frame_pool: Direct3D11CaptureFramePool,
    item: GraphicsCaptureItem,
    frame_token: i64,
    _frame_handler: TypedEventHandler<Direct3D11CaptureFramePool, IInspectable>,
    callback_count: Arc<AtomicUsize>,
    hardware: HardwareD3dDevice,
    frame_pool_size: FramePoolSizing,
    #[cfg(feature = "shared-texture-output")]
    shared_textures: SharedTexturePool,
    _apartment: WinRtApartment,
}

struct CaptureWorkerContext {
    session_id: String,
    max_fps: Option<u16>,
    metrics: Arc<Mutex<CaptureMetrics>>,
    dropped_notifications: Arc<AtomicU64>,
    stop_requested: Arc<AtomicBool>,
    notifications: SyncSender<()>,
    notification_receiver: Receiver<()>,
    shared_slot_release_receiver: Receiver<usize>,
    startup: SyncSender<Result<(), ErrorCode>>,
}

fn capture_worker(target: ThreadCaptureTarget, context: CaptureWorkerContext) {
    let CaptureWorkerContext {
        session_id,
        max_fps,
        metrics,
        dropped_notifications,
        stop_requested,
        notifications,
        notification_receiver,
        shared_slot_release_receiver,
        startup,
    } = context;
    let resources = create_resources(
        target.clone(),
        max_fps,
        &metrics,
        notifications.clone(),
        &dropped_notifications,
    );
    let mut resources = match resources {
        Ok(resources) => {
            let _ = startup.send(Ok(()));
            resources
        }
        Err(error) => {
            lock_metrics(&metrics).last_error = Some(error.diagnostic_name());
            let _ = startup.send(Err(error));
            return;
        }
    };

    let loop_result = run_capture_loop(
        target,
        &session_id,
        &mut resources,
        &metrics,
        &stop_requested,
        &notification_receiver,
        &shared_slot_release_receiver,
    );
    if let Err(error) = loop_result {
        lock_metrics(&metrics).last_error = Some(error.diagnostic_name());
    }

    let mut cleanup_failed = false;
    if resources
        .frame_pool
        .RemoveFrameArrived(resources.frame_token)
        .is_err()
    {
        cleanup_failed = true;
    }
    let callback_deadline = Instant::now() + CALLBACK_DRAIN_TIMEOUT;
    while resources.callback_count.load(Ordering::Acquire) != 0
        && Instant::now() < callback_deadline
    {
        thread::yield_now();
    }
    if resources.callback_count.load(Ordering::Acquire) != 0 {
        cleanup_failed = true;
    }
    if resources.capture_session.Close().is_err() {
        cleanup_failed = true;
    }
    for _ in 0..FRAME_POOL_BUFFERS {
        match resources.frame_pool.TryGetNextFrame() {
            Ok(frame) => {
                let mut metrics = lock_metrics(&metrics);
                metrics.received = metrics.received.saturating_add(1);
                drop(metrics);
                if frame.Close().is_err() {
                    cleanup_failed = true;
                }
            }
            Err(error) if is_no_frame_available(&error) => break,
            Err(_) => {
                cleanup_failed = true;
                break;
            }
        }
    }
    if resources.frame_pool.Close().is_err() {
        cleanup_failed = true;
    }
    if cleanup_failed {
        lock_metrics(&metrics).last_error = Some(ErrorCode::CaptureCleanupFailed.diagnostic_name());
    }
    // Release every WinRT/D3D reference before balancing RoInitialize on this worker.
    let CaptureResources {
        capture_session,
        frame_pool,
        item,
        frame_token: _,
        _frame_handler,
        callback_count: _,
        hardware,
        frame_pool_size: _,
        #[cfg(feature = "shared-texture-output")]
            shared_textures: _,
        _apartment,
    } = resources;
    drop(capture_session);
    drop(frame_pool);
    drop(item);
    drop(_frame_handler);
    drop(hardware);
    drop(_apartment);
}

fn create_resources(
    target: ThreadCaptureTarget,
    _max_fps: Option<u16>,
    metrics: &Mutex<CaptureMetrics>,
    notifications: SyncSender<()>,
    dropped_notifications: &Arc<AtomicU64>,
) -> Result<CaptureResources, ErrorCode> {
    let apartment = WinRtApartment::initialize()?;
    let native = native_target(target.clone())?;
    if !capture_target_is_valid(&target) {
        return Err(target_closed_error(native));
    }
    let interop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()
        .map_err(|_| ErrorCode::CaptureStartFailed)?;
    let item = create_capture_item(&interop, native)?;
    if let ThreadCaptureTarget::Window(value, identity) = &target {
        let window = HWND(*value as *mut _);
        if !super::super::sources::windows::window_matches_identity(window, identity) {
            drop(item);
            return Err(ErrorCode::CaptureTargetClosed);
        }
    }
    let hardware = HardwareD3dDevice::create()?;
    let item_size = item.Size().map_err(|_| ErrorCode::CaptureStartFailed)?;
    if !valid_size(item_size) {
        return Err(ErrorCode::CaptureStartFailed);
    }
    lock_metrics(metrics).set_initial_size(item_size);
    let frame_pool_size = FramePoolSizing::new(item_size)?;
    #[cfg(feature = "shared-texture-output")]
    let shared_textures = SharedTexturePool::new(&hardware, frame_pool_size.allocated, _max_fps)?;
    let frame_pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
        &hardware.winrt_device,
        DirectXPixelFormat::B8G8R8A8UIntNormalized,
        FRAME_POOL_BUFFERS,
        frame_pool_size.allocated,
    )
    .map_err(|_| ErrorCode::CaptureStartFailed)?;
    let capture_session = match frame_pool.CreateCaptureSession(&item) {
        Ok(session) => session,
        Err(_) => {
            let _ = frame_pool.Close();
            return Err(ErrorCode::CaptureStartFailed);
        }
    };

    let frame_sender = notifications.clone();
    let callback_dropped = Arc::clone(dropped_notifications);
    let callback_count = Arc::new(AtomicUsize::new(0));
    let callback_activity = Arc::clone(&callback_count);
    let frame_handler =
        TypedEventHandler::<Direct3D11CaptureFramePool, IInspectable>::new(move |_, _| {
            callback_activity.fetch_add(1, Ordering::AcqRel);
            if let Err(TrySendError::Full(())) = frame_sender.try_send(()) {
                // This counts a saturated wake-up queue, not frames lost by WGC.
                callback_dropped.fetch_add(1, Ordering::Relaxed);
            }
            callback_activity.fetch_sub(1, Ordering::AcqRel);
            Ok(())
        });
    let frame_token = match frame_pool.FrameArrived(&frame_handler) {
        Ok(token) => token,
        Err(_) => {
            let _ = capture_session.Close();
            let _ = frame_pool.Close();
            return Err(ErrorCode::CaptureStartFailed);
        }
    };
    if capture_session.StartCapture().is_err() {
        let _ = frame_pool.RemoveFrameArrived(frame_token);
        let _ = capture_session.Close();
        let _ = frame_pool.Close();
        return Err(ErrorCode::CaptureStartFailed);
    }
    Ok(CaptureResources {
        _apartment: apartment,
        hardware,
        item,
        frame_pool,
        capture_session,
        frame_token,
        _frame_handler: frame_handler,
        callback_count,
        frame_pool_size,
        #[cfg(feature = "shared-texture-output")]
        shared_textures,
    })
}

#[derive(Clone, Copy)]
enum NativeTarget {
    Window(HWND),
    Monitor(HMONITOR),
}

fn native_target(target: ThreadCaptureTarget) -> Result<NativeTarget, ErrorCode> {
    match target {
        ThreadCaptureTarget::Window(value, _) => Ok(NativeTarget::Window(HWND(value as *mut _))),
        ThreadCaptureTarget::Monitor(value) => Ok(NativeTarget::Monitor(HMONITOR(value as *mut _))),
        #[cfg(test)]
        ThreadCaptureTarget::Test => Err(ErrorCode::CaptureStartFailed),
    }
}

fn create_capture_item(
    interop: &IGraphicsCaptureItemInterop,
    target: NativeTarget,
) -> Result<GraphicsCaptureItem, ErrorCode> {
    match target {
        NativeTarget::Window(window) => {
            unsafe { interop.CreateForWindow::<GraphicsCaptureItem>(window) }
                .map_err(|_| ErrorCode::CaptureStartFailed)
        }
        NativeTarget::Monitor(monitor) => {
            unsafe { interop.CreateForMonitor::<GraphicsCaptureItem>(monitor) }
                .map_err(|_| ErrorCode::CaptureStartFailed)
        }
    }
}

fn capture_target_is_valid(target: &ThreadCaptureTarget) -> bool {
    match target {
        ThreadCaptureTarget::Window(value, identity) => {
            let window = HWND(*value as *mut _);
            super::super::sources::windows::window_matches_identity(window, identity)
        }
        ThreadCaptureTarget::Monitor(value) => is_live_monitor(HMONITOR(*value as *mut _)),
        #[cfg(test)]
        ThreadCaptureTarget::Test => false,
    }
}

fn target_closed_error(target: NativeTarget) -> ErrorCode {
    match target {
        NativeTarget::Window(_) => ErrorCode::CaptureTargetClosed,
        NativeTarget::Monitor(_) => ErrorCode::CaptureDisplayDisconnected,
    }
}

fn run_capture_loop(
    target: ThreadCaptureTarget,
    session_id: &str,
    resources: &mut CaptureResources,
    metrics: &Mutex<CaptureMetrics>,
    stop_requested: &AtomicBool,
    notifications: &Receiver<()>,
    shared_slot_release_receiver: &Receiver<usize>,
) -> Result<(), ErrorCode> {
    #[cfg(not(feature = "shared-texture-output"))]
    let _ = session_id;
    let native = native_target(target.clone())?;
    let mut last_target_check = Instant::now();
    loop {
        #[cfg(feature = "shared-texture-output")]
        {
            for slot_index in shared_slot_release_receiver.try_iter() {
                resources.shared_textures.release(slot_index);
            }
            if stop_requested.load(Ordering::Acquire) {
                while resources.shared_textures.in_flight() > 0 {
                    match shared_slot_release_receiver.recv_timeout(Duration::from_millis(10)) {
                        Ok(slot_index) => resources.shared_textures.release(slot_index),
                        Err(mpsc::RecvTimeoutError::Timeout) => continue,
                        Err(mpsc::RecvTimeoutError::Disconnected) => {
                            return Err(ErrorCode::CaptureCleanupFailed);
                        }
                    }
                }
                return Ok(());
            }
        }
        #[cfg(not(feature = "shared-texture-output"))]
        let _ = shared_slot_release_receiver;
        if stop_requested.load(Ordering::Acquire) {
            return Ok(());
        }
        let _ = notifications.recv_timeout(WORKER_POLL_INTERVAL);
        if stop_requested.load(Ordering::Acquire) {
            return Ok(());
        }
        if last_target_check.elapsed() >= TARGET_CHECK_INTERVAL {
            if !capture_target_is_valid(&target) {
                return Err(target_closed_error(native));
            }
            last_target_check = Instant::now();
        }

        let current_size = match resources.item.Size() {
            Ok(size) => size,
            Err(_) if !capture_target_is_valid(&target) => {
                return Err(target_closed_error(native));
            }
            Err(_) => return Err(ErrorCode::CaptureFrameProcessingFailed),
        };
        if !valid_size(current_size) {
            return Err(if capture_target_is_valid(&target) {
                ErrorCode::CaptureFramePoolRecreateFailed
            } else {
                target_closed_error(native)
            });
        }
        recreate_frame_pool_if_needed(
            resources,
            current_size,
            current_size,
            metrics,
            stop_requested,
        )?;

        for _ in 0..MAX_FRAMES_PER_WAKE {
            if stop_requested.load(Ordering::Acquire) {
                #[cfg(feature = "shared-texture-output")]
                break;
                #[cfg(not(feature = "shared-texture-output"))]
                return Ok(());
            }
            let frame = match resources.frame_pool.TryGetNextFrame() {
                Ok(frame) => frame,
                Err(error) if is_no_frame_available(&error) => break,
                Err(_) => return Err(ErrorCode::CaptureFrameProcessingFailed),
            };
            {
                let mut metrics = lock_metrics(metrics);
                metrics.received = metrics.received.saturating_add(1);
            }
            let metadata = frame
                .ContentSize()
                .and_then(|size| frame.SystemRelativeTime().map(|time| (size, time)));
            let (frame_size, frame_time) = match metadata {
                Ok(metadata) => metadata,
                Err(_) => {
                    let _ = frame.Close();
                    return Err(ErrorCode::CaptureFrameProcessingFailed);
                }
            };
            if !valid_size(frame_size) {
                let _ = frame.Close();
                return Err(if capture_target_is_valid(&target) {
                    ErrorCode::CaptureFramePoolRecreateFailed
                } else {
                    target_closed_error(native)
                });
            }
            #[cfg(feature = "shared-texture-output")]
            let shared_frame_result = if stop_requested.load(Ordering::Acquire) {
                Ok(None)
            } else {
                resources.shared_textures.prepare_frame(
                    &frame,
                    &resources.hardware,
                    frame_size,
                    frame_time,
                )
            };
            let close_result = frame.Close();
            if close_result.is_err() {
                #[cfg(feature = "shared-texture-output")]
                if let Ok(Some(shared_frame)) = shared_frame_result {
                    resources.shared_textures.release(shared_frame.slot_index);
                }
                return Err(ErrorCode::CaptureFrameProcessingFailed);
            }
            #[cfg(feature = "shared-texture-output")]
            let shared_frame = shared_frame_result?;
            #[cfg(feature = "shared-texture-output")]
            if stop_requested.load(Ordering::Acquire) {
                if let Some(shared_frame) = shared_frame {
                    resources.shared_textures.discard(shared_frame.slot_index);
                }
                break;
            }
            lock_metrics(metrics).record_frame(frame_time, frame_size, Instant::now());
            #[cfg(feature = "shared-texture-output")]
            if let Some(shared_frame) = shared_frame
                && let Err(error) = shared_frame.write_to_stdout(session_id)
            {
                resources.shared_textures.release(shared_frame.slot_index);
                return Err(error);
            }
            recreate_frame_pool_if_needed(
                resources,
                current_size,
                frame_size,
                metrics,
                stop_requested,
            )?;
        }
    }
}

fn is_no_frame_available(error: &windows::core::Error) -> bool {
    error.code().is_ok()
}

fn recreate_frame_pool_if_needed(
    resources: &mut CaptureResources,
    item_size: SizeInt32,
    content_size: SizeInt32,
    metrics: &Mutex<CaptureMetrics>,
    stop_requested: &AtomicBool,
) -> Result<(), ErrorCode> {
    let Some(target_size) = resources
        .frame_pool_size
        .growth_target(item_size, content_size)?
    else {
        return Ok(());
    };
    if stop_requested.load(Ordering::Acquire) {
        return Ok(());
    }
    discard_pending_frames(&resources.frame_pool, metrics)?;
    if stop_requested.load(Ordering::Acquire) {
        return Ok(());
    }
    if perform_frame_pool_recreate(
        &mut resources.frame_pool_size,
        target_size,
        stop_requested.load(Ordering::Acquire),
        |size| {
            resources
                .frame_pool
                .Recreate(
                    &resources.hardware.winrt_device,
                    DirectXPixelFormat::B8G8R8A8UIntNormalized,
                    FRAME_POOL_BUFFERS,
                    size,
                )
                .map_err(|_| ())
        },
    )? {
        let mut metrics = lock_metrics(metrics);
        metrics.frame_pool_recreates = metrics.frame_pool_recreates.saturating_add(1);
        drop(metrics);
        #[cfg(feature = "shared-texture-output")]
        let _ = resources
            .shared_textures
            .ensure_capacity(&resources.hardware, target_size)?;
    }
    Ok(())
}

fn discard_pending_frames(
    frame_pool: &Direct3D11CaptureFramePool,
    metrics: &Mutex<CaptureMetrics>,
) -> Result<(), ErrorCode> {
    for _ in 0..FRAME_POOL_BUFFERS {
        match frame_pool.TryGetNextFrame() {
            Ok(frame) => {
                let mut metrics = lock_metrics(metrics);
                metrics.received = metrics.received.saturating_add(1);
                drop(metrics);
                frame
                    .Close()
                    .map_err(|_| ErrorCode::CaptureFrameProcessingFailed)?;
            }
            Err(error) if is_no_frame_available(&error) => break,
            Err(_) => return Err(ErrorCode::CaptureFrameProcessingFailed),
        }
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct FramePoolSizing {
    allocated: SizeInt32,
}

impl FramePoolSizing {
    fn new(initial: SizeInt32) -> Result<Self, ErrorCode> {
        Ok(Self {
            allocated: aligned_size(initial)?,
        })
    }

    fn growth_target(
        self,
        item_size: SizeInt32,
        content_size: SizeInt32,
    ) -> Result<Option<SizeInt32>, ErrorCode> {
        if !valid_size(item_size) || !valid_size(content_size) {
            return Err(ErrorCode::CaptureFramePoolRecreateFailed);
        }
        let required = SizeInt32 {
            Width: item_size.Width.max(content_size.Width),
            Height: item_size.Height.max(content_size.Height),
        };
        let target = aligned_size(required)?;
        if target.Width <= self.allocated.Width && target.Height <= self.allocated.Height {
            Ok(None)
        } else {
            Ok(Some(SizeInt32 {
                Width: target.Width.max(self.allocated.Width),
                Height: target.Height.max(self.allocated.Height),
            }))
        }
    }
}

fn valid_size(size: SizeInt32) -> bool {
    size.Width > 0 && size.Height > 0
}

fn aligned_size(size: SizeInt32) -> Result<SizeInt32, ErrorCode> {
    if !valid_size(size) {
        return Err(ErrorCode::CaptureFramePoolRecreateFailed);
    }
    let align = |dimension: i32| {
        let aligned = (i64::from(dimension) + i64::from(FRAME_POOL_SIZE_ALIGNMENT - 1))
            / i64::from(FRAME_POOL_SIZE_ALIGNMENT)
            * i64::from(FRAME_POOL_SIZE_ALIGNMENT);
        i32::try_from(aligned).map_err(|_| ErrorCode::CaptureFramePoolRecreateFailed)
    };
    Ok(SizeInt32 {
        Width: align(size.Width)?,
        Height: align(size.Height)?,
    })
}

fn perform_frame_pool_recreate(
    sizing: &mut FramePoolSizing,
    target: SizeInt32,
    stop_requested: bool,
    recreate: impl FnOnce(SizeInt32) -> Result<(), ()>,
) -> Result<bool, ErrorCode> {
    if stop_requested {
        return Ok(false);
    }
    recreate(target).map_err(|_| ErrorCode::CaptureFramePoolRecreateFailed)?;
    sizing.allocated = target;
    Ok(true)
}

#[cfg(feature = "shared-texture-output")]
struct OwnedSharedHandle(HANDLE);

#[cfg(feature = "shared-texture-output")]
impl Drop for OwnedSharedHandle {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

#[cfg(feature = "shared-texture-output")]
struct SharedTextureSlot {
    texture: ID3D11Texture2D,
    mutex: IDXGIKeyedMutex,
    handle: OwnedSharedHandle,
    completion_query: ID3D11Query,
    busy: bool,
}

#[cfg(feature = "shared-texture-output")]
struct SharedTexturePool {
    allocated: SizeInt32,
    slots: Vec<SharedTextureSlot>,
    next_slot: usize,
    frames: u64,
    dropped_frames: u64,
    max_fps: Option<u16>,
    last_output_at: Option<Instant>,
    recent_output_times: VecDeque<Instant>,
}

#[cfg(feature = "shared-texture-output")]
struct SharedTextureFrame {
    slot_index: usize,
    source_handle_hex: String,
    coded_size: SizeInt32,
    content_size: SizeInt32,
    timestamp_micros: i64,
    output_fps: Option<f64>,
    frames: u64,
    dropped_frames: u64,
    in_flight: usize,
}

#[cfg(feature = "shared-texture-output")]
impl SharedTexturePool {
    fn new(
        hardware: &HardwareD3dDevice,
        allocated: SizeInt32,
        max_fps: Option<u16>,
    ) -> Result<Self, ErrorCode> {
        Ok(Self {
            allocated,
            slots: create_shared_texture_slots(hardware, allocated)?,
            next_slot: 0,
            frames: 0,
            dropped_frames: 0,
            max_fps,
            last_output_at: None,
            recent_output_times: VecDeque::with_capacity(64),
        })
    }

    fn release(&mut self, slot_index: usize) {
        if let Some(slot) = self.slots.get_mut(slot_index) {
            slot.busy = false;
        }
    }

    fn discard(&mut self, slot_index: usize) {
        self.release(slot_index);
        self.dropped_frames = self.dropped_frames.saturating_add(1);
    }

    fn in_flight(&self) -> usize {
        self.slots.iter().filter(|slot| slot.busy).count()
    }

    fn ensure_capacity(
        &mut self,
        hardware: &HardwareD3dDevice,
        required: SizeInt32,
    ) -> Result<bool, ErrorCode> {
        if !valid_size(required) {
            return Err(ErrorCode::CaptureFramePoolRecreateFailed);
        }
        if required.Width <= self.allocated.Width && required.Height <= self.allocated.Height {
            return Ok(true);
        }
        if self.in_flight() != 0 {
            return Ok(false);
        }
        let allocated = aligned_size(required)?;
        let slots = create_shared_texture_slots(hardware, allocated)?;
        self.slots = slots;
        self.allocated = allocated;
        self.next_slot = 0;
        Ok(true)
    }

    fn prepare_frame(
        &mut self,
        frame: &Direct3D11CaptureFrame,
        hardware: &HardwareD3dDevice,
        content_size: SizeInt32,
        frame_time: TimeSpan,
    ) -> Result<Option<SharedTextureFrame>, ErrorCode> {
        if !valid_size(content_size) {
            return Err(ErrorCode::CaptureFrameProcessingFailed);
        }
        if !self.ensure_capacity(hardware, content_size)? {
            self.dropped_frames = self.dropped_frames.saturating_add(1);
            return Ok(None);
        }
        let now = Instant::now();
        if self.max_fps.is_some_and(|max_fps| {
            self.last_output_at.is_some_and(|last| {
                now.saturating_duration_since(last) < Duration::from_secs_f64(1.0 / max_fps as f64)
            })
        }) {
            self.dropped_frames = self.dropped_frames.saturating_add(1);
            return Ok(None);
        }
        let Some(slot_index) = next_free_shared_slot(self.slots.len(), self.next_slot, |index| {
            self.slots[index].busy
        }) else {
            self.dropped_frames = self.dropped_frames.saturating_add(1);
            return Ok(None);
        };

        let surface = frame
            .Surface()
            .map_err(|_| ErrorCode::CaptureFrameProcessingFailed)?;
        let access = surface
            .cast::<IDirect3DDxgiInterfaceAccess>()
            .map_err(|_| ErrorCode::CaptureFrameProcessingFailed)?;
        let source = unsafe { access.GetInterface::<ID3D11Texture2D>() }
            .map_err(|_| ErrorCode::CaptureFrameProcessingFailed)?;
        let box_ = frame_copy_region(self.allocated, content_size)?;
        let slot = &self.slots[slot_index];
        let acquired = unsafe {
            (Interface::vtable(&slot.mutex).AcquireSync)(
                Interface::as_raw(&slot.mutex),
                0,
                GPU_COPY_TIMEOUT.as_millis() as u32,
            )
        };
        if acquired != HRESULT(0) {
            return Err(ErrorCode::CaptureFrameProcessingFailed);
        }
        unsafe {
            hardware.context.CopySubresourceRegion(
                &slot.texture,
                0,
                0,
                0,
                0,
                &source,
                0,
                Some(&box_),
            );
        }
        let copy_result = wait_for_gpu_copy(hardware, &slot.completion_query);
        let release_result = unsafe { slot.mutex.ReleaseSync(0) };
        copy_result?;
        release_result.map_err(|_| ErrorCode::CaptureFrameProcessingFailed)?;

        self.slots[slot_index].busy = true;
        self.next_slot = (slot_index + 1) % self.slots.len();
        self.frames = self.frames.saturating_add(1);
        self.recent_output_times.push_back(now);
        while self.recent_output_times.len() > 64
            || self.recent_output_times.front().is_some_and(|oldest| {
                now.saturating_duration_since(*oldest) > Duration::from_secs(1)
            })
        {
            self.recent_output_times.pop_front();
        }
        let output_fps = self.recent_output_times.front().and_then(|first| {
            let elapsed = now.saturating_duration_since(*first).as_secs_f64();
            (self.recent_output_times.len() > 1 && elapsed > 0.0)
                .then_some((self.recent_output_times.len() - 1) as f64 / elapsed)
        });
        let source_handle_hex = format!("{:016x}", self.slots[slot_index].handle.0.0 as usize);
        self.last_output_at = Some(now);
        Ok(Some(SharedTextureFrame {
            slot_index,
            source_handle_hex,
            coded_size: self.allocated,
            content_size,
            timestamp_micros: frame_time.Duration / 10,
            output_fps,
            frames: self.frames,
            dropped_frames: self.dropped_frames,
            in_flight: self.in_flight(),
        }))
    }
}

#[cfg(feature = "shared-texture-output")]
fn next_free_shared_slot(
    slot_count: usize,
    start: usize,
    mut is_busy: impl FnMut(usize) -> bool,
) -> Option<usize> {
    if slot_count == 0 {
        return None;
    }
    (0..slot_count)
        .map(|offset| (start + offset) % slot_count)
        .find(|index| !is_busy(*index))
}

#[cfg(feature = "shared-texture-output")]
fn frame_copy_region(allocated: SizeInt32, content: SizeInt32) -> Result<D3D11_BOX, ErrorCode> {
    if !valid_size(allocated)
        || !valid_size(content)
        || content.Width > allocated.Width
        || content.Height > allocated.Height
    {
        return Err(ErrorCode::CaptureFramePoolRecreateFailed);
    }
    Ok(D3D11_BOX {
        left: 0,
        top: 0,
        front: 0,
        right: content.Width as u32,
        bottom: content.Height as u32,
        back: 1,
    })
}

#[cfg(feature = "shared-texture-output")]
impl SharedTextureFrame {
    fn write_to_stdout(&self, session_id: &str) -> Result<(), ErrorCode> {
        let event = serde_json::json!({
            "event": "sharedTextureFrame",
            "protocolVersion": crate::protocol::PROTOCOL_VERSION,
            "sessionId": session_id,
            "slotIndex": self.slot_index,
            "sourceHandleHex": self.source_handle_hex,
            "pixelFormat": "bgra",
            "codedSize": { "width": self.coded_size.Width, "height": self.coded_size.Height },
            "contentSize": { "width": self.content_size.Width, "height": self.content_size.Height },
            "timestampMicros": self.timestamp_micros,
            "bridgeFrames": self.frames,
            "bridgeDroppedFrames": self.dropped_frames,
            "bridgeOutputFps": self.output_fps,
            "inFlightTextures": self.in_flight,
            "lastFrameAgeMs": 0
        });
        let _event_lock = crate::EVENT_OUTPUT_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let stdout = std::io::stdout();
        let mut output = stdout.lock();
        serde_json::to_writer(&mut output, &event)
            .map_err(|_| ErrorCode::CaptureFrameProcessingFailed)?;
        output
            .write_all(b"\n")
            .and_then(|()| output.flush())
            .map_err(|_| ErrorCode::CaptureFrameProcessingFailed)
    }
}

#[cfg(feature = "shared-texture-output")]
fn create_shared_texture_slots(
    hardware: &HardwareD3dDevice,
    size: SizeInt32,
) -> Result<Vec<SharedTextureSlot>, ErrorCode> {
    if !valid_size(size) {
        return Err(ErrorCode::CaptureFramePoolRecreateFailed);
    }
    let desc = D3D11_TEXTURE2D_DESC {
        Width: size.Width as u32,
        Height: size.Height as u32,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
        CPUAccessFlags: 0,
        MiscFlags: (D3D11_RESOURCE_MISC_SHARED_NTHANDLE.0 | D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX.0)
            as u32,
    };
    let mut slots = Vec::with_capacity(SHARED_TEXTURE_POOL_CAPACITY);
    for _ in 0..SHARED_TEXTURE_POOL_CAPACITY {
        let mut texture = None;
        unsafe {
            hardware
                .device
                .CreateTexture2D(&desc, None, Some(&mut texture))
                .map_err(|_| ErrorCode::CaptureStartFailed)?;
        }
        let texture: ID3D11Texture2D = texture.ok_or(ErrorCode::CaptureStartFailed)?;
        let mutex: IDXGIKeyedMutex = texture.cast().map_err(|_| ErrorCode::CaptureStartFailed)?;
        let resource: IDXGIResource1 = texture.cast().map_err(|_| ErrorCode::CaptureStartFailed)?;
        let handle = unsafe {
            resource
                .CreateSharedHandle(
                    None,
                    DXGI_SHARED_RESOURCE_READ.0 | DXGI_SHARED_RESOURCE_WRITE.0,
                    windows::core::PCWSTR::null(),
                )
                .map_err(|_| ErrorCode::CaptureStartFailed)?
        };
        let query_desc = D3D11_QUERY_DESC {
            Query: D3D11_QUERY_EVENT,
            MiscFlags: 0,
        };
        let mut completion_query = None;
        unsafe {
            hardware
                .device
                .CreateQuery(&query_desc, Some(&mut completion_query))
                .map_err(|_| ErrorCode::CaptureStartFailed)?;
        }
        slots.push(SharedTextureSlot {
            texture,
            mutex,
            handle: OwnedSharedHandle(handle),
            completion_query: completion_query.ok_or(ErrorCode::CaptureStartFailed)?,
            busy: false,
        });
    }
    Ok(slots)
}

#[cfg(feature = "shared-texture-output")]
fn wait_for_gpu_copy(hardware: &HardwareD3dDevice, query: &ID3D11Query) -> Result<(), ErrorCode> {
    unsafe {
        hardware.context.End(query);
        hardware.context.Flush();
    }
    let deadline = Instant::now() + GPU_COPY_TIMEOUT;
    loop {
        let mut completed = BOOL(0);
        unsafe {
            hardware
                .context
                .GetData(
                    query,
                    Some((&mut completed as *mut BOOL).cast()),
                    std::mem::size_of::<BOOL>() as u32,
                    0,
                )
                .map_err(|_| ErrorCode::CaptureFrameProcessingFailed)?;
        }
        if completed.as_bool() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(ErrorCode::CaptureFrameProcessingFailed);
        }
        thread::sleep(Duration::from_millis(1));
    }
}

struct MonitorCheck {
    target: HMONITOR,
    found: bool,
}

fn is_live_monitor(target: HMONITOR) -> bool {
    let mut context = MonitorCheck {
        target,
        found: false,
    };
    let callback: MONITORENUMPROC = Some(find_monitor);
    unsafe {
        EnumDisplayMonitors(
            None,
            None,
            callback,
            LPARAM(&mut context as *mut _ as isize),
        )
        .as_bool()
            && context.found
    }
}

unsafe extern "system" fn find_monitor(
    monitor: HMONITOR,
    _device_context: HDC,
    _monitor_rect: *mut RECT,
    parameter: LPARAM,
) -> BOOL {
    let context = unsafe { &mut *(parameter.0 as *mut MonitorCheck) };
    if monitor == context.target {
        context.found = true;
    }
    BOOL(1)
}
#[cfg(test)]
mod tests {
    use super::{
        CaptureMetrics, FramePoolSizing, MAX_FRAME_TIMESTAMPS, aligned_size, is_no_frame_available,
        perform_frame_pool_recreate, source_interval_percentile_ms,
    };
    #[cfg(feature = "shared-texture-output")]
    use super::{SHARED_TEXTURE_POOL_CAPACITY, frame_copy_region, next_free_shared_slot};
    use std::collections::VecDeque;
    use std::time::{Duration, Instant};
    use windows::Foundation::TimeSpan;
    use windows::Graphics::SizeInt32;
    use windows::core::{Error, HRESULT};

    fn frame_time(ticks: i64) -> TimeSpan {
        TimeSpan { Duration: ticks }
    }

    fn frame_size() -> SizeInt32 {
        SizeInt32 {
            Width: 1920,
            Height: 1080,
        }
    }

    fn size(width: i32, height: i32) -> SizeInt32 {
        SizeInt32 {
            Width: width,
            Height: height,
        }
    }

    #[test]
    fn smaller_fixed_content_size_does_not_recreate_pool_or_count_a_size_change() {
        let item_size = size(1199, 963);
        let content_size = size(1179, 953);
        let pool = FramePoolSizing::new(item_size).unwrap();
        let mut metrics = CaptureMetrics::new(crate::protocol::VideoSourceKind::Window);
        metrics.set_initial_size(item_size);

        for _ in 0..20_328 {
            assert_eq!(pool.growth_target(item_size, content_size).unwrap(), None);
            metrics.update_size(content_size);
        }

        assert_eq!(metrics.size_changes, 0);
        assert_eq!(metrics.width, Some(1179));
        assert_eq!(metrics.height, Some(953));
    }

    #[test]
    fn pool_growth_is_aligned_and_shrinks_do_not_recreate() {
        let mut pool = FramePoolSizing::new(size(640, 480)).unwrap();
        let growth = pool
            .growth_target(size(641, 481), size(641, 481))
            .unwrap()
            .unwrap();
        assert_eq!(growth, size(704, 512));
        assert!(perform_frame_pool_recreate(&mut pool, growth, false, |_| Ok(())).unwrap());
        assert_eq!(pool.allocated, growth);

        assert_eq!(
            pool.growth_target(size(600, 400), size(590, 390)).unwrap(),
            None
        );
        assert_eq!(pool.allocated, growth);
        assert_eq!(
            pool.growth_target(size(700, 500), size(680, 490)).unwrap(),
            None
        );
    }

    #[test]
    fn continuous_resize_reuses_aligned_pool_until_capacity_is_exceeded() {
        let mut pool = FramePoolSizing::new(size(640, 480)).unwrap();
        let mut recreates = 0;
        for width in 641..=704 {
            if let Some(target) = pool
                .growth_target(size(width, 481), size(width, 481))
                .unwrap()
            {
                assert!(perform_frame_pool_recreate(&mut pool, target, false, |_| Ok(())).unwrap());
                recreates += 1;
            }
        }
        assert_eq!(recreates, 1);
        assert_eq!(pool.allocated, size(704, 512));
        assert_eq!(
            pool.growth_target(size(705, 481), size(705, 481)).unwrap(),
            Some(size(768, 512))
        );
    }

    #[test]
    fn invalid_size_recreate_failure_and_stop_request_preserve_pool_state() {
        let mut pool = FramePoolSizing::new(size(640, 480)).unwrap();
        assert!(FramePoolSizing::new(size(0, 480)).is_err());
        assert!(pool.growth_target(size(640, 480), size(640, -1)).is_err());
        assert!(aligned_size(size(i32::MAX, 1)).is_err());

        let original = pool.allocated;
        let target = size(704, 512);
        let failed = perform_frame_pool_recreate(&mut pool, target, false, |_| Err(()));
        assert!(failed.is_err());
        assert_eq!(pool.allocated, original);

        let called = std::cell::Cell::new(false);
        let stopped = perform_frame_pool_recreate(&mut pool, target, true, |_| {
            called.set(true);
            Ok(())
        });
        assert!(!stopped.unwrap());
        assert!(!called.get());
        assert_eq!(pool.allocated, original);
    }

    #[test]
    fn size_changes_count_actual_content_dimension_transitions() {
        let mut metrics = CaptureMetrics::new(crate::protocol::VideoSourceKind::Window);
        metrics.set_initial_size(size(1199, 963));
        metrics.update_size(size(1179, 953));
        assert_eq!(metrics.size_changes, 0);
        metrics.update_size(size(1178, 953));
        metrics.update_size(size(1178, 952));
        assert_eq!(metrics.size_changes, 2);
    }

    #[test]
    fn treats_successful_null_frame_result_as_no_pending_frame() {
        assert!(is_no_frame_available(&Error::from_hresult(HRESULT(0))));
        assert!(!is_no_frame_available(&Error::from_hresult(HRESULT(
            0x80004005_u32 as i32
        ))));
    }

    #[test]
    fn first_frame_has_no_rate_or_interval_percentiles() {
        let now = Instant::now();
        let mut metrics = CaptureMetrics::new(crate::protocol::VideoSourceKind::Monitor);
        metrics.record_frame(frame_time(1_000), frame_size(), now);

        let snapshot = metrics.snapshot_at(0, now);
        assert_eq!(snapshot.raw_capture_fps, None);
        assert_eq!(snapshot.probe_processed_fps, None);
        assert_eq!(snapshot.raw_frame_interval_p50_ms, None);
        assert_eq!(snapshot.raw_frame_interval_p95_ms, None);
        assert_eq!(snapshot.raw_frame_interval_p99_ms, None);
        assert_eq!(snapshot.raw_timestamp_anomalies, Some(0));
    }

    #[test]
    fn source_fps_and_probe_throughput_use_distinct_clocks() {
        let now = Instant::now();
        let mut metrics = CaptureMetrics::new(crate::protocol::VideoSourceKind::Monitor);
        metrics.record_frame(frame_time(0), frame_size(), now);
        metrics.record_frame(
            frame_time(100_000),
            frame_size(),
            now + Duration::from_millis(50),
        );

        let snapshot = metrics.snapshot_at(0, now + Duration::from_millis(50));
        assert_eq!(snapshot.raw_capture_fps, Some(100.0));
        assert_eq!(snapshot.probe_processed_fps, Some(20.0));
        assert_eq!(snapshot.raw_frame_interval_p50_ms, Some(10.0));
    }

    #[test]
    fn rates_and_intervals_expire_after_one_second_without_progress() {
        let now = Instant::now();
        let mut metrics = CaptureMetrics::new(crate::protocol::VideoSourceKind::Monitor);
        metrics.record_frame(frame_time(0), frame_size(), now);
        metrics.record_frame(
            frame_time(100_000),
            frame_size(),
            now + Duration::from_millis(10),
        );

        let snapshot = metrics.snapshot_at(0, now + Duration::from_secs(2));
        assert_eq!(snapshot.raw_capture_fps, None);
        assert_eq!(snapshot.probe_processed_fps, None);
        assert_eq!(snapshot.raw_frame_interval_p50_ms, None);
    }

    #[test]
    fn duplicate_and_backwards_source_timestamps_are_counted_and_rebased() {
        let now = Instant::now();
        let mut metrics = CaptureMetrics::new(crate::protocol::VideoSourceKind::Monitor);
        metrics.record_frame(frame_time(100_000), frame_size(), now);
        metrics.record_frame(
            frame_time(100_000),
            frame_size(),
            now + Duration::from_millis(10),
        );
        let duplicate = metrics.snapshot_at(0, now + Duration::from_millis(10));
        assert_eq!(duplicate.raw_timestamp_anomalies, Some(1));
        assert_eq!(duplicate.raw_capture_fps, None);

        metrics.record_frame(
            frame_time(50_000),
            frame_size(),
            now + Duration::from_millis(20),
        );
        metrics.record_frame(
            frame_time(150_000),
            frame_size(),
            now + Duration::from_millis(30),
        );
        let rebased = metrics.snapshot_at(0, now + Duration::from_millis(30));
        assert_eq!(rebased.raw_timestamp_anomalies, Some(2));
        assert_eq!(rebased.raw_capture_fps, Some(100.0));
        assert_eq!(rebased.raw_frame_interval_p50_ms, Some(10.0));
    }

    #[test]
    fn interval_percentiles_use_nearest_rank_on_bounded_samples() {
        let times = VecDeque::from([0, 100_000, 300_000, 1_300_000, 3_300_000]);

        assert_eq!(source_interval_percentile_ms(&times, 50), Some(20.0));
        assert_eq!(source_interval_percentile_ms(&times, 95), Some(200.0));
        assert_eq!(source_interval_percentile_ms(&times, 99), Some(200.0));
    }

    #[test]
    fn timestamp_windows_never_exceed_capacity() {
        let now = Instant::now();
        let mut metrics = CaptureMetrics::new(crate::protocol::VideoSourceKind::Monitor);
        for index in 0..(MAX_FRAME_TIMESTAMPS + 44) {
            metrics.record_frame(
                frame_time(index as i64 * 1_000),
                frame_size(),
                now + Duration::from_micros(index as u64 * 100),
            );
        }

        assert_eq!(metrics.raw_frame_times.len(), MAX_FRAME_TIMESTAMPS);
        assert_eq!(metrics.processed_frame_times.len(), MAX_FRAME_TIMESTAMPS);
        assert!(metrics.raw_frame_times.capacity() <= MAX_FRAME_TIMESTAMPS);
        assert!(metrics.processed_frame_times.capacity() <= MAX_FRAME_TIMESTAMPS);
    }

    #[cfg(feature = "shared-texture-output")]
    #[test]
    fn shared_texture_pool_drops_when_full_and_reuses_only_released_slots() {
        let mut busy = [true; SHARED_TEXTURE_POOL_CAPACITY];
        assert_eq!(
            next_free_shared_slot(busy.len(), 1, |index| busy[index]),
            None
        );

        busy[1] = false;
        assert_eq!(
            next_free_shared_slot(busy.len(), 2, |index| busy[index]),
            Some(1)
        );
        busy[1] = true;
        assert_eq!(
            next_free_shared_slot(busy.len(), 0, |index| busy[index]),
            None
        );
    }

    #[cfg(feature = "shared-texture-output")]
    #[test]
    fn shared_texture_copy_uses_content_rect_and_rejects_crop_on_growth() {
        let region = frame_copy_region(size(1216, 1024), size(1179, 953)).unwrap();
        assert_eq!(region.left, 0);
        assert_eq!(region.top, 0);
        assert_eq!(region.right, 1179);
        assert_eq!(region.bottom, 953);
        assert!(frame_copy_region(size(1179, 953), size(1180, 953)).is_err());
        assert!(frame_copy_region(size(1216, 1024), size(0, 953)).is_err());
    }
}
