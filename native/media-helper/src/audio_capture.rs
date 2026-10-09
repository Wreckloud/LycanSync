use crate::audio_processing::ProcessingSettings;
use crate::protocol::{Capability, ErrorCode};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub(super) trait MicrophoneCaptureWorker: Send {
    fn request_stop(&self);
    fn is_finished(&self) -> bool;
    fn join(&mut self) -> Result<(), MicrophoneCaptureJoinError>;
}

pub(super) enum MicrophoneCaptureJoinError {
    Capture(ErrorCode),
    JoinFailed,
}

pub(super) struct MicrophoneCaptureStartFailure {
    pub(super) error: ErrorCode,
    pub(super) worker: Option<Box<dyn MicrophoneCaptureWorker>>,
}

pub(super) fn wait_for_microphone_capture_start(
    ready: Receiver<Result<(), ErrorCode>>,
    worker: Box<dyn MicrophoneCaptureWorker>,
    timeout: Duration,
) -> Result<Box<dyn MicrophoneCaptureWorker>, MicrophoneCaptureStartFailure> {
    match ready.recv_timeout(timeout) {
        Ok(Ok(())) => Ok(worker),
        Ok(Err(error)) => Err(MicrophoneCaptureStartFailure {
            error,
            worker: Some(worker),
        }),
        Err(mpsc::RecvTimeoutError::Timeout) => Err(MicrophoneCaptureStartFailure {
            error: ErrorCode::MicrophoneCaptureStartTimedOut,
            worker: Some(worker),
        }),
        Err(mpsc::RecvTimeoutError::Disconnected) => Err(MicrophoneCaptureStartFailure {
            error: ErrorCode::MicrophoneCaptureStartFailed,
            worker: Some(worker),
        }),
    }
}

pub(super) struct StartedCapture {
    pub(super) worker: Box<dyn MicrophoneCaptureWorker>,
    pub(super) dropped_chunks: Arc<std::sync::atomic::AtomicU64>,
}

#[derive(Default)]
pub(super) struct MicrophoneCaptureManager {
    session_id: Option<String>,
    last_session_id: Option<String>,
    settings: Option<Arc<Mutex<ProcessingSettings>>>,
    worker: Option<Box<dyn MicrophoneCaptureWorker>>,
    dropped_chunks: Option<Arc<std::sync::atomic::AtomicU64>>,
    last_dropped_chunks: u64,
}

impl MicrophoneCaptureManager {
    pub(super) fn start<F>(
        &mut self,
        session_id: &str,
        pipe_id: &str,
        settings: ProcessingSettings,
        starter: F,
    ) -> Result<(), ErrorCode>
    where
        F: FnOnce(
            String,
            String,
            Arc<Mutex<ProcessingSettings>>,
        ) -> Result<StartedCapture, MicrophoneCaptureStartFailure>,
    {
        if self.worker.is_some() || self.session_id.is_some() {
            return Err(ErrorCode::MicrophoneCaptureAlreadyRunning);
        }
        if !settings.input_gain.is_finite() || !(0.0..=2.0).contains(&settings.input_gain) {
            return Err(ErrorCode::InvalidRequest);
        }
        self.dropped_chunks = None;
        self.last_dropped_chunks = 0;
        let settings = Arc::new(Mutex::new(settings));
        match starter(
            session_id.to_owned(),
            pipe_id.to_owned(),
            Arc::clone(&settings),
        ) {
            Ok(started) => {
                self.session_id = Some(session_id.to_owned());
                self.settings = Some(settings);
                self.worker = Some(started.worker);
                self.dropped_chunks = Some(started.dropped_chunks);
                Ok(())
            }
            Err(failure) => {
                if let Some(worker) = failure.worker {
                    worker.request_stop();
                    self.session_id = Some(session_id.to_owned());
                    self.settings = Some(settings);
                    self.worker = Some(worker);
                }
                Err(failure.error)
            }
        }
    }

    pub(super) fn configure(
        &mut self,
        session_id: &str,
        settings: ProcessingSettings,
    ) -> Result<(), ErrorCode> {
        if !settings.input_gain.is_finite() || !(0.0..=2.0).contains(&settings.input_gain) {
            return Err(ErrorCode::InvalidRequest);
        }
        if self.session_id.as_deref() != Some(session_id) {
            return Err(ErrorCode::MicrophoneCaptureSessionMismatch);
        }
        let mut current_settings = self
            .settings
            .as_ref()
            .expect("active microphone capture settings")
            .lock()
            .expect("microphone capture settings lock poisoned");
        if *current_settings != settings {
            *current_settings = settings;
        }
        Ok(())
    }

    pub(super) fn stop(&mut self, session_id: &str) -> Result<bool, ErrorCode> {
        if self.session_id.is_none() {
            return if self.last_session_id.as_deref() == Some(session_id) {
                Ok(false)
            } else {
                Err(ErrorCode::MicrophoneCaptureSessionMismatch)
            };
        }
        if self.session_id.as_deref() != Some(session_id) {
            return Err(ErrorCode::MicrophoneCaptureSessionMismatch);
        }
        let result = self.stop_worker();
        self.finish_session(session_id);
        result.map(|()| true)
    }

    pub(super) fn shutdown(&mut self) -> Result<(), ErrorCode> {
        if self.session_id.is_none() && self.worker.is_none() {
            return Ok(());
        }
        let session_id = self.session_id.clone();
        let result = self.stop_worker();
        if let Some(session_id) = session_id {
            self.finish_session(&session_id);
        }
        result
    }

    pub(super) fn dropped_chunks(&self) -> u64 {
        self.dropped_chunks
            .as_ref()
            .map_or(self.last_dropped_chunks, |count| {
                count.load(std::sync::atomic::Ordering::Relaxed)
            })
    }

    pub(super) fn reap_finished_capture(&mut self) -> Option<(String, MicrophoneCaptureJoinError)> {
        self.reap_finished()
    }

    fn stop_worker(&mut self) -> Result<(), ErrorCode> {
        let Some(mut worker) = self.worker.take() else {
            return Ok(());
        };
        worker.request_stop();
        match worker.join() {
            Ok(()) => Ok(()),
            Err(MicrophoneCaptureJoinError::Capture(error)) => Err(error),
            Err(MicrophoneCaptureJoinError::JoinFailed) => {
                Err(ErrorCode::MicrophoneCaptureStopFailed)
            }
        }
    }

    fn finish_session(&mut self, session_id: &str) {
        self.last_dropped_chunks = self.dropped_chunks();
        self.session_id = None;
        self.settings = None;
        self.worker = None;
        self.last_session_id = Some(session_id.to_owned());
    }

    fn reap_finished(&mut self) -> Option<(String, MicrophoneCaptureJoinError)> {
        if !self
            .worker
            .as_ref()
            .is_some_and(|worker| worker.is_finished())
        {
            return None;
        }
        let result = self.worker.as_mut().and_then(|worker| worker.join().err());
        self.worker = None;
        let session_id = self.session_id.clone()?;
        self.finish_session(&session_id);
        result.map(|error| (session_id, error))
    }
}

impl Drop for MicrophoneCaptureManager {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

pub(super) fn start(
    session_id: String,
    pipe_id: String,
    settings: Arc<Mutex<ProcessingSettings>>,
) -> Result<StartedCapture, MicrophoneCaptureStartFailure> {
    #[cfg(target_os = "windows")]
    {
        windows::start(session_id, pipe_id, settings)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (session_id, pipe_id, settings);
        Err(MicrophoneCaptureStartFailure {
            error: ErrorCode::MicrophoneCaptureFailed,
            worker: None,
        })
    }
}

pub(super) fn capability() -> Capability {
    #[cfg(target_os = "windows")]
    {
        Capability {
            available: true,
            reason: "windowsWasapiSharedModeSonora",
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        Capability {
            available: false,
            reason: "platformUnsupported",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        MicrophoneCaptureJoinError, MicrophoneCaptureManager, MicrophoneCaptureStartFailure,
        MicrophoneCaptureWorker, StartedCapture, wait_for_microphone_capture_start,
    };
    use crate::audio_processing::ProcessingSettings;
    use crate::protocol::ErrorCode;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::time::Duration;

    struct TestWorker(Arc<AtomicBool>);

    impl MicrophoneCaptureWorker for TestWorker {
        fn request_stop(&self) {
            self.0.store(true, Ordering::Release);
        }

        fn is_finished(&self) -> bool {
            self.0.load(Ordering::Acquire)
        }

        fn join(&mut self) -> Result<(), MicrophoneCaptureJoinError> {
            Ok(())
        }
    }

    #[test]
    fn capture_session_validates_settings_and_scopes_configure_and_stop_to_its_id() {
        let mut manager = MicrophoneCaptureManager::default();
        let stopped = Arc::new(AtomicBool::new(false));
        let started_settings = ProcessingSettings::default();
        manager
            .start("session-a", "pipe-a", started_settings, |_, _, _| {
                Ok(StartedCapture {
                    worker: Box::new(TestWorker(Arc::clone(&stopped))),
                    dropped_chunks: Arc::new(AtomicU64::new(2)),
                })
            })
            .unwrap();

        assert_eq!(manager.dropped_chunks(), 2);
        assert_eq!(
            manager.configure("session-b", started_settings),
            Err(ErrorCode::MicrophoneCaptureSessionMismatch)
        );
        let next_settings = ProcessingSettings {
            input_gain: 0.6,
            noise_suppression: false,
            auto_gain_control: true,
            voice_enhancement: false,
        };
        manager.configure("session-a", next_settings).unwrap();
        assert_eq!(
            manager.stop("session-b"),
            Err(ErrorCode::MicrophoneCaptureSessionMismatch)
        );
        assert_eq!(manager.stop("session-a"), Ok(true));
        assert!(stopped.load(Ordering::Acquire));
        assert_eq!(manager.dropped_chunks(), 2);
        assert_eq!(manager.stop("session-a"), Ok(false));
    }

    #[test]
    fn invalid_gain_and_start_failure_leave_the_manager_available_for_a_new_session() {
        let mut manager = MicrophoneCaptureManager::default();
        let invalid = ProcessingSettings {
            input_gain: f32::NAN,
            ..ProcessingSettings::default()
        };
        let mut called = false;
        assert_eq!(
            manager.start("session-a", "pipe-a", invalid, |_, _, _| {
                called = true;
                unreachable!()
            }),
            Err(ErrorCode::InvalidRequest)
        );
        assert!(!called);
        assert_eq!(
            manager.start(
                "session-b",
                "pipe-b",
                ProcessingSettings::default(),
                |_, _, _| {
                    Err(MicrophoneCaptureStartFailure {
                        error: ErrorCode::MicrophoneCaptureFormatUnsupported,
                        worker: None,
                    })
                }
            ),
            Err(ErrorCode::MicrophoneCaptureFormatUnsupported)
        );

        manager
            .start(
                "session-c",
                "pipe-c",
                ProcessingSettings::default(),
                |_, _, _| {
                    Ok(StartedCapture {
                        worker: Box::new(TestWorker(Arc::new(AtomicBool::new(false)))),
                        dropped_chunks: Arc::new(AtomicU64::new(0)),
                    })
                },
            )
            .unwrap();
        manager.shutdown().unwrap();
    }

    #[test]
    fn configure_accepts_gain_boundaries_and_rejects_out_of_range_values() {
        let mut manager = MicrophoneCaptureManager::default();
        manager
            .start(
                "session-a",
                "pipe-a",
                ProcessingSettings::default(),
                |_, _, _| {
                    Ok(StartedCapture {
                        worker: Box::new(TestWorker(Arc::new(AtomicBool::new(false)))),
                        dropped_chunks: Arc::new(AtomicU64::new(0)),
                    })
                },
            )
            .unwrap();

        for input_gain in [0.0, 2.0] {
            manager
                .configure(
                    "session-a",
                    ProcessingSettings {
                        input_gain,
                        ..ProcessingSettings::default()
                    },
                )
                .unwrap();
        }
        for input_gain in [-0.01, 2.01, f32::NAN, f32::INFINITY] {
            assert_eq!(
                manager.configure(
                    "session-a",
                    ProcessingSettings {
                        input_gain,
                        ..ProcessingSettings::default()
                    }
                ),
                Err(ErrorCode::InvalidRequest)
            );
        }
        manager.shutdown().unwrap();
    }

    #[test]
    fn timed_out_start_requests_stop_and_retains_worker_until_it_finishes() {
        let mut manager = MicrophoneCaptureManager::default();
        let stopped = Arc::new(AtomicBool::new(false));
        let finished = Arc::new(AtomicBool::new(false));
        let stopped_for_worker = Arc::clone(&stopped);
        let finished_for_worker = Arc::clone(&finished);
        let (ready_sender, ready_receiver) = std::sync::mpsc::sync_channel(1);

        assert_eq!(
            manager.start(
                "session-a",
                "pipe-a",
                ProcessingSettings::default(),
                move |_, _, _| {
                    let worker = PendingWorker {
                        finished: finished_for_worker,
                        stopped: stopped_for_worker,
                    };
                    wait_for_microphone_capture_start(
                        ready_receiver,
                        Box::new(worker),
                        Duration::ZERO,
                    )
                    .map(|worker| StartedCapture {
                        worker,
                        dropped_chunks: Arc::new(AtomicU64::new(0)),
                    })
                    .map_err(|failure| failure)
                }
            ),
            Err(ErrorCode::MicrophoneCaptureStartTimedOut)
        );
        drop(ready_sender);
        assert!(stopped.load(Ordering::Acquire));
        assert!(!finished.load(Ordering::Acquire));
        assert_eq!(
            manager.start(
                "session-b",
                "pipe-b",
                ProcessingSettings::default(),
                |_, _, _| unreachable!()
            ),
            Err(ErrorCode::MicrophoneCaptureAlreadyRunning)
        );

        finished.store(true, Ordering::Release);
        assert!(manager.reap_finished_capture().is_none());
        assert!(manager.worker.is_none());
        assert_eq!(manager.stop("session-a"), Ok(false));
    }

    #[test]
    fn disconnected_start_reports_microphone_error_and_keeps_worker_owner() {
        let (ready_sender, ready_receiver) = std::sync::mpsc::sync_channel(1);
        drop(ready_sender);
        let result = wait_for_microphone_capture_start(
            ready_receiver,
            Box::new(TestWorker(Arc::new(AtomicBool::new(false)))),
            Duration::from_secs(1),
        );

        match result {
            Err(failure) => {
                assert_eq!(failure.error, ErrorCode::MicrophoneCaptureStartFailed);
                assert!(failure.worker.is_some());
            }
            Ok(_) => panic!("a disconnected startup signal must fail"),
        }
    }

    struct PendingWorker {
        finished: Arc<AtomicBool>,
        stopped: Arc<AtomicBool>,
    }

    impl MicrophoneCaptureWorker for PendingWorker {
        fn request_stop(&self) {
            self.stopped.store(true, Ordering::Release);
        }

        fn is_finished(&self) -> bool {
            self.finished.load(Ordering::Acquire)
        }

        fn join(&mut self) -> Result<(), MicrophoneCaptureJoinError> {
            Ok(())
        }
    }

    #[test]
    fn completed_worker_join_failure_is_reported_during_reaping() {
        let mut manager = MicrophoneCaptureManager::default();
        manager
            .start(
                "session-a",
                "pipe-a",
                ProcessingSettings::default(),
                |_, _, _| {
                    Ok(StartedCapture {
                        worker: Box::new(JoinFailureWorker),
                        dropped_chunks: Arc::new(AtomicU64::new(0)),
                    })
                },
            )
            .unwrap();

        let (session_id, error) = manager.reap_finished_capture().unwrap();
        assert_eq!(session_id, "session-a");
        assert!(matches!(error, MicrophoneCaptureJoinError::JoinFailed));
        assert_eq!(manager.stop("session-a"), Ok(false));
    }

    #[test]
    fn shutdown_requests_stop_and_reports_capture_failure() {
        let mut manager = MicrophoneCaptureManager::default();
        let stop_requested = Arc::new(AtomicBool::new(false));
        let worker_stop_requested = Arc::clone(&stop_requested);
        manager
            .start(
                "session-a",
                "pipe-a",
                ProcessingSettings::default(),
                move |_, _, _| {
                    Ok(StartedCapture {
                        worker: Box::new(StopFailureWorker(worker_stop_requested)),
                        dropped_chunks: Arc::new(AtomicU64::new(0)),
                    })
                },
            )
            .unwrap();

        assert_eq!(manager.shutdown(), Err(ErrorCode::MicrophoneCaptureFailed));
        assert!(stop_requested.load(Ordering::Acquire));
        assert_eq!(manager.shutdown(), Ok(()));
    }

    #[test]
    fn stop_reports_join_failure_and_still_releases_the_session() {
        let mut manager = MicrophoneCaptureManager::default();
        manager
            .start(
                "session-a",
                "pipe-a",
                ProcessingSettings::default(),
                |_, _, _| {
                    Ok(StartedCapture {
                        worker: Box::new(JoinFailureWorker),
                        dropped_chunks: Arc::new(AtomicU64::new(0)),
                    })
                },
            )
            .unwrap();

        assert_eq!(
            manager.stop("session-a"),
            Err(ErrorCode::MicrophoneCaptureStopFailed)
        );
        assert_eq!(manager.stop("session-a"), Ok(false));
    }

    struct JoinFailureWorker;

    impl MicrophoneCaptureWorker for JoinFailureWorker {
        fn request_stop(&self) {}

        fn is_finished(&self) -> bool {
            true
        }

        fn join(&mut self) -> Result<(), MicrophoneCaptureJoinError> {
            Err(MicrophoneCaptureJoinError::JoinFailed)
        }
    }

    struct StopFailureWorker(Arc<AtomicBool>);

    impl MicrophoneCaptureWorker for StopFailureWorker {
        fn request_stop(&self) {
            self.0.store(true, Ordering::Release);
        }

        fn is_finished(&self) -> bool {
            false
        }

        fn join(&mut self) -> Result<(), MicrophoneCaptureJoinError> {
            Err(MicrophoneCaptureJoinError::Capture(
                ErrorCode::MicrophoneCaptureFailed,
            ))
        }
    }
}

#[cfg(target_os = "windows")]
mod windows;
