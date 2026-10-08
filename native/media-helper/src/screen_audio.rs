use crate::protocol::{
    Capability, ErrorCode, ScreenShareAudioDiagnostics, ScreenShareAudioState, VideoSourceKind,
};
use crate::sources::{DiscoveryRuntime, SourceRegistry};
use std::sync::{Arc, Mutex};

pub(super) trait ScreenShareAudioWorker: Send {
    fn request_stop(&self);
    fn is_finished(&self) -> bool;
    fn join(&mut self) -> Result<(), ErrorCode>;
}

pub(super) struct StartedAudio {
    pub(super) worker: Box<dyn ScreenShareAudioWorker>,
    pub(super) sample_rate: u32,
    pub(super) channels: u16,
}

pub(super) struct StartFailure {
    pub(super) error: ErrorCode,
    pub(super) worker: Option<Box<dyn ScreenShareAudioWorker>>,
}

#[derive(Default)]
pub(super) struct ScreenShareAudioManager {
    diagnostics: Arc<Mutex<ScreenShareAudioDiagnostics>>,
    worker: Option<Box<dyn ScreenShareAudioWorker>>,
    last_session_id: Option<String>,
}

impl ScreenShareAudioManager {
    pub(super) fn start(
        &mut self,
        sources: &mut SourceRegistry,
        discovery: &mut DiscoveryRuntime,
        session_id: &str,
        source_id: &str,
        pipe_id: &str,
    ) -> Result<(u32, u16), ErrorCode> {
        self.reap_finished();
        let target = sources.target(source_id).ok_or(ErrorCode::InvalidRequest)?;
        let source_kind = sources.kind(source_id).ok_or(ErrorCode::InvalidRequest)?;
        if !discovery.target_is_valid(&target) {
            return Err(ErrorCode::ScreenShareAudioTargetUnavailable);
        }
        #[cfg(target_os = "windows")]
        {
            let process_identity =
                if source_kind == VideoSourceKind::Window && windows::requires_process_identity() {
                    Some(discovery.audio_process_identity(&target)?)
                } else {
                    None
                };
            self.start_with_backend(
                session_id,
                source_kind,
                process_identity,
                pipe_id,
                windows::start,
            )
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = (session_id, source_kind, pipe_id);
            Err(ErrorCode::ScreenShareAudioUnsupported)
        }
    }

    fn start_with_backend<F>(
        &mut self,
        session_id: &str,
        source_kind: VideoSourceKind,
        process_identity: Option<(u32, u64)>,
        pipe_id: &str,
        starter: F,
    ) -> Result<(u32, u16), ErrorCode>
    where
        F: FnOnce(
            String,
            VideoSourceKind,
            Option<(u32, u64)>,
            Arc<Mutex<ScreenShareAudioDiagnostics>>,
        ) -> Result<StartedAudio, StartFailure>,
    {
        self.reap_finished();
        if self.worker.is_some() || self.diagnostics().state != ScreenShareAudioState::Idle {
            return Err(ErrorCode::ScreenShareAudioAlreadyRunning);
        }
        self.set_starting(session_id, source_kind);
        match starter(
            pipe_id.to_owned(),
            source_kind,
            process_identity,
            Arc::clone(&self.diagnostics),
        ) {
            Ok(started) => {
                self.worker = Some(started.worker);
                self.last_session_id = None;
                Ok((started.sample_rate, started.channels))
            }
            Err(failure) => {
                if let Some(worker) = failure.worker {
                    worker.request_stop();
                    self.worker = Some(worker);
                    self.set_failed(failure.error);
                } else {
                    self.rollback_start(failure.error);
                }
                Err(failure.error)
            }
        }
    }

    pub(super) fn stop(&mut self, session_id: &str) -> Result<bool, ErrorCode> {
        self.reap_finished();
        let snapshot = self.diagnostics();
        if snapshot.state == ScreenShareAudioState::Idle {
            return if self.last_session_id.as_deref() == Some(session_id) {
                Ok(false)
            } else {
                Err(ErrorCode::ScreenShareAudioSessionMismatch)
            };
        }
        if snapshot.session_id.as_deref() != Some(session_id) {
            return Err(ErrorCode::ScreenShareAudioSessionMismatch);
        }
        self.set_state(ScreenShareAudioState::Stopping);
        let result = self.stop_worker();
        self.finish_session(session_id, result.err());
        result.map(|()| true)
    }

    pub(super) fn shutdown(&mut self) -> Result<(), ErrorCode> {
        if self.worker.is_none() && self.diagnostics().session_id.is_none() {
            return Ok(());
        }
        let session_id = self.diagnostics().session_id;
        self.set_state(ScreenShareAudioState::Stopping);
        let result = self.stop_worker();
        if let Some(session_id) = session_id {
            self.finish_session(&session_id, result.err());
        }
        result
    }

    pub(super) fn snapshot(&mut self) -> ScreenShareAudioDiagnostics {
        self.reap_finished();
        self.diagnostics()
    }

    fn stop_worker(&mut self) -> Result<(), ErrorCode> {
        let Some(mut worker) = self.worker.take() else {
            return Ok(());
        };
        worker.request_stop();
        worker.join()
    }

    fn reap_finished(&mut self) {
        if !self
            .worker
            .as_ref()
            .is_some_and(|worker| worker.is_finished())
        {
            return;
        }
        let result = self
            .worker
            .as_mut()
            .expect("finished screen-share audio worker")
            .join();
        if let Some(session_id) = self.diagnostics().session_id {
            self.finish_session(&session_id, result.err());
        }
        self.worker = None;
    }

    fn diagnostics(&self) -> ScreenShareAudioDiagnostics {
        self.diagnostics
            .lock()
            .expect("screen audio diagnostics lock poisoned")
            .clone()
    }

    fn set_starting(&self, session_id: &str, source_kind: VideoSourceKind) {
        let last_error = self.diagnostics().last_error;
        *self
            .diagnostics
            .lock()
            .expect("screen audio diagnostics lock poisoned") = ScreenShareAudioDiagnostics {
            state: ScreenShareAudioState::Starting,
            session_id: Some(session_id.to_owned()),
            source_kind: Some(source_kind),
            last_error,
            ..ScreenShareAudioDiagnostics::default()
        };
    }

    fn set_state(&self, state: ScreenShareAudioState) {
        self.diagnostics
            .lock()
            .expect("screen audio diagnostics lock poisoned")
            .state = state;
    }

    fn set_failed(&self, error: ErrorCode) {
        let mut diagnostics = self
            .diagnostics
            .lock()
            .expect("screen audio diagnostics lock poisoned");
        diagnostics.state = ScreenShareAudioState::Failed;
        diagnostics.last_error = Some(error.diagnostic_name());
    }

    fn rollback_start(&self, error: ErrorCode) {
        *self
            .diagnostics
            .lock()
            .expect("screen audio diagnostics lock poisoned") = ScreenShareAudioDiagnostics {
            last_error: Some(error.diagnostic_name()),
            ..ScreenShareAudioDiagnostics::default()
        };
    }

    fn finish_session(&mut self, session_id: &str, error: Option<ErrorCode>) {
        let mut diagnostics = self
            .diagnostics
            .lock()
            .expect("screen audio diagnostics lock poisoned");
        diagnostics.state = ScreenShareAudioState::Idle;
        diagnostics.session_id = None;
        if let Some(error) = error {
            diagnostics.last_error = Some(error.diagnostic_name());
        }
        self.last_session_id = Some(session_id.to_owned());
    }
}

impl Drop for ScreenShareAudioManager {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

pub(super) fn capability() -> Capability {
    #[cfg(target_os = "windows")]
    {
        windows::capability()
    }
    #[cfg(not(target_os = "windows"))]
    {
        Capability {
            available: false,
            reason: "platformUnsupported",
        }
    }
}

#[cfg(target_os = "windows")]
mod windows;

#[cfg(test)]
mod tests {
    use super::{ScreenShareAudioManager, ScreenShareAudioWorker, StartFailure, StartedAudio};
    use crate::protocol::{ErrorCode, ScreenShareAudioState, VideoSourceKind};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    struct FakeWorker(AtomicBool);
    impl ScreenShareAudioWorker for FakeWorker {
        fn request_stop(&self) {
            self.0.store(true, Ordering::Release);
        }
        fn is_finished(&self) -> bool {
            self.0.load(Ordering::Acquire)
        }
        fn join(&mut self) -> Result<(), ErrorCode> {
            self.0.store(true, Ordering::Release);
            Ok(())
        }
    }

    struct DropTrackedWorker(Arc<AtomicUsize>);
    impl ScreenShareAudioWorker for DropTrackedWorker {
        fn request_stop(&self) {}
        fn is_finished(&self) -> bool {
            false
        }
        fn join(&mut self) -> Result<(), ErrorCode> {
            Ok(())
        }
    }
    impl Drop for DropTrackedWorker {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[test]
    fn failed_start_returns_to_idle_and_preserves_reason() {
        let mut manager = ScreenShareAudioManager::default();
        let result = manager.start_with_backend(
            "session",
            VideoSourceKind::Window,
            Some((123, 456)),
            "pipe",
            |_, _, _, _| {
                Err(StartFailure {
                    error: ErrorCode::ScreenShareAudioUnsupported,
                    worker: None,
                })
            },
        );
        assert_eq!(result, Err(ErrorCode::ScreenShareAudioUnsupported));
        let state = manager.snapshot();
        assert_eq!(state.state, ScreenShareAudioState::Idle);
        assert_eq!(state.last_error, Some("screenShareAudioUnsupported"));
    }

    #[test]
    fn stop_is_idempotent_and_rejects_wrong_session() {
        let mut manager = ScreenShareAudioManager::default();
        manager
            .start_with_backend(
                "session",
                VideoSourceKind::Monitor,
                None,
                "pipe",
                |_, _, _, _| {
                    Ok(StartedAudio {
                        worker: Box::new(FakeWorker(AtomicBool::new(false))),
                        sample_rate: 48000,
                        channels: 2,
                    })
                },
            )
            .unwrap();
        assert_eq!(
            manager.stop("other"),
            Err(ErrorCode::ScreenShareAudioSessionMismatch)
        );
        assert_eq!(manager.stop("session"), Ok(true));
        assert_eq!(manager.stop("session"), Ok(false));
        assert_eq!(manager.snapshot().state, ScreenShareAudioState::Idle);
    }

    #[test]
    fn stopping_releases_the_capture_worker_after_joining_it() {
        let released = Arc::new(AtomicUsize::new(0));
        let worker_released = Arc::clone(&released);
        let mut manager = ScreenShareAudioManager::default();
        manager
            .start_with_backend(
                "session",
                VideoSourceKind::Monitor,
                None,
                "pipe",
                move |_, _, _, _| {
                    Ok(StartedAudio {
                        worker: Box::new(DropTrackedWorker(worker_released)),
                        sample_rate: 48_000,
                        channels: 2,
                    })
                },
            )
            .unwrap();

        assert_eq!(manager.stop("session"), Ok(true));
        assert_eq!(released.load(Ordering::SeqCst), 1);
    }
}
