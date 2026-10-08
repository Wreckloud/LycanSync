use crate::audio_probe::{ProbeWorker, WorkerStartFailure};
use crate::audio_processing::ProcessingSettings;
use crate::protocol::{Capability, ErrorCode};
use std::sync::{Arc, Mutex};

pub(super) struct StartedCapture {
    pub(super) worker: Box<dyn ProbeWorker>,
    pub(super) dropped_chunks: Arc<std::sync::atomic::AtomicU64>,
}

#[derive(Default)]
pub(super) struct MicrophoneCaptureManager {
    session_id: Option<String>,
    last_session_id: Option<String>,
    settings: Option<Arc<Mutex<ProcessingSettings>>>,
    worker: Option<Box<dyn ProbeWorker>>,
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
        ) -> Result<StartedCapture, WorkerStartFailure>,
    {
        self.reap_finished();
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
        *self
            .settings
            .as_ref()
            .expect("active microphone capture settings")
            .lock()
            .expect("microphone capture settings lock poisoned") = settings;
        Ok(())
    }

    pub(super) fn stop(&mut self, session_id: &str) -> Result<bool, ErrorCode> {
        self.reap_finished();
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
        self.stop_worker()?;
        self.finish_session(session_id);
        Ok(true)
    }

    pub(super) fn shutdown(&mut self) -> Result<(), ErrorCode> {
        let Some(session_id) = self.session_id.clone() else {
            return Ok(());
        };
        let result = self.stop_worker();
        self.finish_session(&session_id);
        result
    }

    pub(super) fn dropped_chunks(&self) -> u64 {
        self.dropped_chunks
            .as_ref()
            .map_or(self.last_dropped_chunks, |count| {
                count.load(std::sync::atomic::Ordering::Relaxed)
            })
    }

    pub(super) fn reap_finished_capture(&mut self) {
        self.reap_finished();
    }

    fn stop_worker(&mut self) -> Result<(), ErrorCode> {
        let Some(mut worker) = self.worker.take() else {
            return Ok(());
        };
        worker.request_stop();
        worker
            .join()
            .map_err(|_| ErrorCode::MicrophoneCaptureStopFailed)
    }

    fn finish_session(&mut self, session_id: &str) {
        self.last_dropped_chunks = self.dropped_chunks();
        self.session_id = None;
        self.settings = None;
        self.worker = None;
        self.last_session_id = Some(session_id.to_owned());
    }

    fn reap_finished(&mut self) {
        if !self
            .worker
            .as_ref()
            .is_some_and(|worker| worker.is_finished())
        {
            return;
        }
        if let Some(mut worker) = self.worker.take() {
            let _ = worker.join();
        }
        if let Some(session_id) = self.session_id.clone() {
            self.finish_session(&session_id);
        }
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
) -> Result<StartedCapture, WorkerStartFailure> {
    #[cfg(target_os = "windows")]
    {
        windows::start(session_id, pipe_id, settings)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (session_id, pipe_id, settings);
        Err(WorkerStartFailure {
            error: ErrorCode::MicrophoneCaptureFailed,
            worker: None,
            pending: false,
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
    use super::{MicrophoneCaptureManager, StartedCapture};
    use crate::audio_probe::{ProbeWorker, WorkerStartFailure};
    use crate::audio_processing::ProcessingSettings;
    use crate::protocol::ErrorCode;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

    struct TestWorker(Arc<AtomicBool>);

    impl ProbeWorker for TestWorker {
        fn request_stop(&self) {
            self.0.store(true, Ordering::Release);
        }

        fn is_finished(&self) -> bool {
            self.0.load(Ordering::Acquire)
        }

        fn join(&mut self) -> Result<(), ErrorCode> {
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
                    Err(WorkerStartFailure {
                        error: ErrorCode::MicrophoneCaptureFormatUnsupported,
                        worker: None,
                        pending: false,
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
}

#[cfg(target_os = "windows")]
mod windows;
