use super::CaptureSnapshot;
use crate::d3d::HardwareD3dDevice;
use crate::protocol::{ErrorCode, VideoSourceKind};
use crate::sources::ThreadCaptureTarget;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use windows::Foundation::{TimeSpan, TypedEventHandler};
use windows::Graphics::Capture::{
    Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession,
};
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Graphics::SizeInt32;
use windows::Win32::Foundation::{HWND, LPARAM, RECT};
use windows::Win32::Graphics::Gdi::{EnumDisplayMonitors, HDC, HMONITOR, MONITORENUMPROC};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize, RoUninitialize};
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
        if self.width != width || self.height != height {
            if self.width.is_some() && self.height.is_some() {
                self.size_changes = self.size_changes.saturating_add(1);
            }
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
    ) -> Result<(), ErrorCode> {
        if self.active.is_some() {
            return Err(ErrorCode::CaptureAlreadyRunning);
        }

        let metrics = Arc::new(Mutex::new(CaptureMetrics::new(source_kind)));
        let dropped_notifications = Arc::new(AtomicU64::new(0));
        let stop_requested = Arc::new(AtomicBool::new(false));
        let (notification_sender, notification_receiver) =
            mpsc::sync_channel(NOTIFICATION_CAPACITY);
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
                    worker_metrics,
                    worker_dropped,
                    worker_stop,
                    worker_sender,
                    notification_receiver,
                    startup_sender,
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
    size: SizeInt32,
    _apartment: WinRtApartment,
}

fn capture_worker(
    target: ThreadCaptureTarget,
    metrics: Arc<Mutex<CaptureMetrics>>,
    dropped_notifications: Arc<AtomicU64>,
    stop_requested: Arc<AtomicBool>,
    notifications: SyncSender<()>,
    notification_receiver: Receiver<()>,
    startup: SyncSender<Result<(), ErrorCode>>,
) {
    let resources = create_resources(
        target.clone(),
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
        &mut resources,
        &metrics,
        &stop_requested,
        &notification_receiver,
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
        size: _,
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
    let size = item.Size().map_err(|_| ErrorCode::CaptureStartFailed)?;
    if size.Width <= 0 || size.Height <= 0 {
        return Err(ErrorCode::CaptureStartFailed);
    }
    lock_metrics(metrics).set_initial_size(size);
    let frame_pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
        &hardware.winrt_device,
        DirectXPixelFormat::B8G8R8A8UIntNormalized,
        FRAME_POOL_BUFFERS,
        size,
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
        size,
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
    resources: &mut CaptureResources,
    metrics: &Mutex<CaptureMetrics>,
    stop_requested: &AtomicBool,
    notifications: &Receiver<()>,
) -> Result<(), ErrorCode> {
    let native = native_target(target.clone())?;
    let mut last_target_check = Instant::now();
    loop {
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
        if current_size.Width <= 0 || current_size.Height <= 0 {
            return Err(if capture_target_is_valid(&target) {
                ErrorCode::CaptureFramePoolRecreateFailed
            } else {
                target_closed_error(native)
            });
        }
        recreate_frame_pool_if_needed(resources, current_size, metrics)?;

        for _ in 0..MAX_FRAMES_PER_WAKE {
            if stop_requested.load(Ordering::Acquire) {
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
            let close_result = frame.Close();
            let (frame_size, frame_time) =
                metadata.map_err(|_| ErrorCode::CaptureFrameProcessingFailed)?;
            close_result.map_err(|_| ErrorCode::CaptureFrameProcessingFailed)?;
            if frame_size.Width <= 0 || frame_size.Height <= 0 {
                return Err(if capture_target_is_valid(&target) {
                    ErrorCode::CaptureFramePoolRecreateFailed
                } else {
                    target_closed_error(native)
                });
            }
            lock_metrics(metrics).record_frame(frame_time, frame_size, Instant::now());
            recreate_frame_pool_if_needed(resources, frame_size, metrics)?;
        }
    }
}

fn is_no_frame_available(error: &windows::core::Error) -> bool {
    error.code().is_ok()
}

fn recreate_frame_pool_if_needed(
    resources: &mut CaptureResources,
    size: SizeInt32,
    metrics: &Mutex<CaptureMetrics>,
) -> Result<(), ErrorCode> {
    if size.Width <= 0 || size.Height <= 0 {
        return Err(ErrorCode::CaptureFramePoolRecreateFailed);
    }
    if resources.size.Width == size.Width && resources.size.Height == size.Height {
        return Ok(());
    }
    resources
        .frame_pool
        .Recreate(
            &resources.hardware.winrt_device,
            DirectXPixelFormat::B8G8R8A8UIntNormalized,
            FRAME_POOL_BUFFERS,
            size,
        )
        .map_err(|_| ErrorCode::CaptureFramePoolRecreateFailed)?;
    resources.size = size;
    lock_metrics(metrics).update_size(size);
    Ok(())
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
        CaptureMetrics, MAX_FRAME_TIMESTAMPS, is_no_frame_available, source_interval_percentile_ms,
    };
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
}
