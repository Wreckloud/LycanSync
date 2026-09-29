use crate::audio_sources::AudioSourceRegistry;
use crate::protocol::{AudioProbeState, ErrorCode, MicrophoneProbeDiagnostics};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub(super) trait ProbeWorker: Send {
    fn request_stop(&self);
    fn is_finished(&self) -> bool;
    fn join(&mut self) -> Result<(), ErrorCode>;
}

pub(super) struct WorkerStartFailure {
    pub(super) error: ErrorCode,
    pub(super) worker: Option<Box<dyn ProbeWorker>>,
    pub(super) pending: bool,
}

pub(super) fn wait_for_worker_start(
    ready: Receiver<Result<(), ErrorCode>>,
    worker: Box<dyn ProbeWorker>,
    timeout: Duration,
) -> Result<Box<dyn ProbeWorker>, WorkerStartFailure> {
    match ready.recv_timeout(timeout) {
        Ok(Ok(())) => Ok(worker),
        Ok(Err(error)) => Err(WorkerStartFailure {
            error,
            worker: Some(worker),
            pending: false,
        }),
        Err(mpsc::RecvTimeoutError::Timeout) => Err(WorkerStartFailure {
            error: ErrorCode::AudioProbeStartTimedOut,
            worker: Some(worker),
            pending: true,
        }),
        Err(mpsc::RecvTimeoutError::Disconnected) => Err(WorkerStartFailure {
            error: ErrorCode::AudioProbeStartFailed,
            worker: Some(worker),
            pending: false,
        }),
    }
}

#[derive(Default)]
pub(super) struct AudioProbeManager {
    diagnostics: Arc<Mutex<MicrophoneProbeDiagnostics>>,
    last_session_id: Option<String>,
    worker: Option<Box<dyn ProbeWorker>>,
}

impl AudioProbeManager {
    pub(super) fn start(
        &mut self,
        sources: &AudioSourceRegistry,
        session_id: &str,
        source_id: &str,
    ) -> Result<(), ErrorCode> {
        self.reap_finished();
        let endpoint_id = sources
            .input_endpoint_id(source_id)
            .ok_or(ErrorCode::AudioDeviceUnavailable)?;

        #[cfg(target_os = "windows")]
        {
            self.start_with_backend(session_id, endpoint_id, windows::start)
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = endpoint_id;
            self.set_starting(session_id);
            self.rollback_start(ErrorCode::AudioProbeUnsupported);
            Err(ErrorCode::AudioProbeUnsupported)
        }
    }

    fn start_with_backend<F>(
        &mut self,
        session_id: &str,
        endpoint_id: String,
        starter: F,
    ) -> Result<(), ErrorCode>
    where
        F: FnOnce(
            String,
            Arc<Mutex<MicrophoneProbeDiagnostics>>,
        ) -> Result<Box<dyn ProbeWorker>, WorkerStartFailure>,
    {
        self.reap_finished();
        if self.worker.is_some() || self.diagnostics().state != AudioProbeState::Idle {
            return Err(ErrorCode::AudioProbeAlreadyRunning);
        }
        self.set_starting(session_id);
        match starter(endpoint_id, Arc::clone(&self.diagnostics)) {
            Ok(worker) => {
                self.worker = Some(worker);
                self.last_session_id = None;
                Ok(())
            }
            Err(failure) => {
                if let Some(worker) = failure.worker {
                    if failure.pending {
                        // Keep the resource owner registered until it exits; a timed-out
                        // startup may still be blocked inside a COM call.
                        worker.request_stop();
                        self.set_pending_start_error(failure.error);
                    } else {
                        self.set_failed_start(failure.error);
                    }
                    self.worker = Some(worker);
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
        if snapshot.state == AudioProbeState::Idle {
            return if self.last_session_id.as_deref() == Some(session_id) {
                Ok(false)
            } else {
                Err(ErrorCode::AudioProbeSessionMismatch)
            };
        }
        if snapshot.session_id.as_deref() != Some(session_id) {
            return Err(ErrorCode::AudioProbeSessionMismatch);
        }

        self.set_state(AudioProbeState::Stopping);
        let result = self.stop_worker();
        self.complete_session(session_id, result.err());
        result.map(|()| true)
    }

    pub(super) fn shutdown(&mut self) -> Result<(), ErrorCode> {
        let session_id = self.diagnostics().session_id;
        if self.worker.is_none() && session_id.is_none() {
            return Ok(());
        }
        self.set_state(AudioProbeState::Stopping);
        let result = self.stop_worker();
        if let Some(session_id) = session_id {
            self.complete_session(&session_id, result.err());
        } else if let Err(error) = result {
            self.set_idle_error(error);
        }
        result
    }

    pub(super) fn snapshot(&mut self) -> MicrophoneProbeDiagnostics {
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

    pub(super) fn reap_finished(&mut self) {
        let finished = self
            .worker
            .as_ref()
            .is_some_and(|worker| worker.is_finished());
        if !finished {
            return;
        }
        // The slot is reusable only after the worker has relinquished its COM resources.
        let result = self
            .worker
            .as_mut()
            .expect("finished worker should remain registered")
            .join();
        let session_id = self.diagnostics().session_id;
        if let Some(session_id) = session_id {
            self.complete_session(&session_id, result.err());
        } else if let Err(error) = result {
            self.set_idle_error(error);
        }
        self.worker = None;
    }

    fn diagnostics(&self) -> MicrophoneProbeDiagnostics {
        self.diagnostics
            .lock()
            .expect("microphone probe diagnostics lock poisoned")
            .clone()
    }

    fn set_starting(&self, session_id: &str) {
        let last_error = self.diagnostics().last_error;
        let mut diagnostics = self
            .diagnostics
            .lock()
            .expect("microphone probe diagnostics lock poisoned");
        *diagnostics = MicrophoneProbeDiagnostics {
            state: AudioProbeState::Starting,
            session_id: Some(session_id.to_owned()),
            last_error,
            ..MicrophoneProbeDiagnostics::default()
        };
    }

    fn set_state(&self, state: AudioProbeState) {
        self.diagnostics
            .lock()
            .expect("microphone probe diagnostics lock poisoned")
            .state = state;
    }

    fn set_pending_start_error(&self, error: ErrorCode) {
        let mut diagnostics = self
            .diagnostics
            .lock()
            .expect("microphone probe diagnostics lock poisoned");
        diagnostics.state = AudioProbeState::Stopping;
        diagnostics.last_error = Some(error.diagnostic_name());
    }

    fn set_failed_start(&self, error: ErrorCode) {
        let mut diagnostics = self
            .diagnostics
            .lock()
            .expect("microphone probe diagnostics lock poisoned");
        diagnostics.state = AudioProbeState::Failed;
        diagnostics.last_error = Some(error.diagnostic_name());
    }

    fn rollback_start(&self, error: ErrorCode) {
        let mut diagnostics = self
            .diagnostics
            .lock()
            .expect("microphone probe diagnostics lock poisoned");
        *diagnostics = MicrophoneProbeDiagnostics {
            last_error: Some(error.diagnostic_name()),
            ..MicrophoneProbeDiagnostics::default()
        };
    }

    fn complete_session(&mut self, session_id: &str, error: Option<ErrorCode>) {
        let mut diagnostics = self
            .diagnostics
            .lock()
            .expect("microphone probe diagnostics lock poisoned");
        diagnostics.state = AudioProbeState::Idle;
        diagnostics.session_id = None;
        if let Some(error) = error {
            diagnostics.last_error = Some(error.diagnostic_name());
        }
        self.last_session_id = Some(session_id.to_owned());
    }

    fn set_idle_error(&self, error: ErrorCode) {
        let mut diagnostics = self
            .diagnostics
            .lock()
            .expect("microphone probe diagnostics lock poisoned");
        diagnostics.state = AudioProbeState::Idle;
        diagnostics.session_id = None;
        diagnostics.last_error = Some(error.diagnostic_name());
    }
}

impl Drop for AudioProbeManager {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

pub(super) fn probe_capability() -> crate::protocol::Capability {
    #[cfg(target_os = "windows")]
    {
        crate::protocol::Capability {
            available: true,
            reason: "attemptable; selected endpoint is validated on start",
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        crate::protocol::Capability {
            available: false,
            reason: "platformUnsupported",
        }
    }
}

#[cfg(target_os = "windows")]
mod windows;

#[cfg(test)]
mod tests {
    use super::{AudioProbeManager, ProbeWorker, WorkerStartFailure, wait_for_worker_start};
    use crate::audio_sources::{
        AudioSourceRegistry, DiscoveredAudioSource, DiscoveredAudioSources,
    };
    use crate::protocol::{AudioProbeState, AudioSource, AudioSourceKind, ErrorCode};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    #[derive(Default)]
    struct FakeWorker {
        finished: Arc<AtomicBool>,
        stop_requested: Arc<AtomicBool>,
        joined: Arc<AtomicBool>,
        dropped_before_finished: Arc<AtomicBool>,
        join_error: Mutex<Option<ErrorCode>>,
    }

    impl ProbeWorker for FakeWorker {
        fn request_stop(&self) {
            self.stop_requested.store(true, Ordering::Release);
        }

        fn is_finished(&self) -> bool {
            self.finished.load(Ordering::Acquire)
        }

        fn join(&mut self) -> Result<(), ErrorCode> {
            self.joined.store(true, Ordering::Release);
            self.finished.store(true, Ordering::Release);
            self.join_error.lock().unwrap().map_or(Ok(()), Err)
        }
    }

    fn registered_input() -> (AudioSourceRegistry, String) {
        let mut registry = AudioSourceRegistry::default();
        let snapshot = registry
            .refresh(DiscoveredAudioSources {
                sources: vec![DiscoveredAudioSource {
                    source: AudioSource {
                        source_id: String::new(),
                        kind: AudioSourceKind::Input,
                        name: "Test microphone".to_owned(),
                        default_roles: Vec::new(),
                    },
                    endpoint_id: "private-device-id".to_owned(),
                }],
                inputs_truncated: false,
                outputs_truncated: false,
            })
            .unwrap();
        (registry, snapshot.inputs[0].source_id.clone())
    }

    fn ready_snapshot(snapshot: &Arc<Mutex<crate::protocol::MicrophoneProbeDiagnostics>>) {
        let mut value = snapshot.lock().unwrap();
        value.state = AudioProbeState::Running;
        value.packets_received = Some(0);
        value.frames_received = Some(0);
    }

    fn running_manager(session_id: &str) -> (AudioProbeManager, Arc<FakeWorker>) {
        let worker = Arc::new(FakeWorker::default());
        worker.finished.store(true, Ordering::Release);
        let mut manager = AudioProbeManager::default();
        manager.set_starting(session_id);
        ready_snapshot(&manager.diagnostics);
        manager.worker = Some(Box::new(FakeWorkerProxy(Arc::clone(&worker))));
        (manager, worker)
    }

    struct FakeWorkerProxy(Arc<FakeWorker>);

    impl Drop for FakeWorkerProxy {
        fn drop(&mut self) {
            if !self.0.finished.load(Ordering::Acquire) {
                self.0
                    .dropped_before_finished
                    .store(true, Ordering::Release);
            }
        }
    }

    impl ProbeWorker for FakeWorkerProxy {
        fn request_stop(&self) {
            self.0.request_stop();
        }

        fn is_finished(&self) -> bool {
            self.0.is_finished()
        }

        fn join(&mut self) -> Result<(), ErrorCode> {
            self.0.joined.store(true, Ordering::Release);
            self.0.finished.store(true, Ordering::Release);
            self.0.join_error.lock().unwrap().map_or(Ok(()), Err)
        }
    }

    #[test]
    fn stale_source_is_rejected_before_worker_creation() {
        let (mut registry, source_id) = registered_input();
        registry
            .refresh(DiscoveredAudioSources {
                sources: Vec::new(),
                inputs_truncated: false,
                outputs_truncated: false,
            })
            .unwrap_err();

        let mut manager = AudioProbeManager::default();
        assert_eq!(
            manager.start(&registry, "mic-session", &source_id),
            Err(ErrorCode::AudioDeviceUnavailable)
        );
        assert_eq!(manager.snapshot().state, AudioProbeState::Idle);
    }

    #[test]
    fn start_failure_rolls_back_without_erasing_its_error() {
        let (registry, source_id) = registered_input();
        let mut manager = AudioProbeManager::default();
        let result = manager.start_with_backend(
            "mic-session",
            registry.input_endpoint_id(&source_id).unwrap(),
            |_, _| {
                Err(WorkerStartFailure {
                    error: ErrorCode::AudioProbeStartFailed,
                    worker: None,
                    pending: false,
                })
            },
        );

        assert_eq!(result, Err(ErrorCode::AudioProbeStartFailed));
        let snapshot = manager.snapshot();
        assert_eq!(snapshot.state, AudioProbeState::Idle);
        assert_eq!(snapshot.session_id, None);
        assert_eq!(snapshot.last_error, Some("audioProbeStartFailed"));
    }

    #[test]
    fn slow_start_timeout_returns_without_join_and_blocks_retry_until_worker_exits() {
        let (registry, source_id) = registered_input();
        let mut manager = AudioProbeManager::default();
        let worker = Arc::new(FakeWorker::default());
        let worker_for_start = Arc::clone(&worker);
        let result = manager.start_with_backend(
            "mic-session",
            registry.input_endpoint_id(&source_id).unwrap(),
            move |_, _| {
                let (_sender, receiver) = mpsc::sync_channel(1);
                wait_for_worker_start(
                    receiver,
                    Box::new(FakeWorkerProxy(worker_for_start)),
                    Duration::from_millis(20),
                )
            },
        );

        assert_eq!(result, Err(ErrorCode::AudioProbeStartTimedOut));
        assert!(worker.stop_requested.load(Ordering::Acquire));
        assert!(!worker.joined.load(Ordering::Acquire));
        assert!(!worker.dropped_before_finished.load(Ordering::Acquire));
        assert_eq!(manager.snapshot().state, AudioProbeState::Stopping);
        assert_eq!(
            manager.snapshot().last_error,
            Some("audioProbeStartTimedOut")
        );
        assert_eq!(
            manager.start_with_backend(
                "retry",
                registry.input_endpoint_id(&source_id).unwrap(),
                |_, _| unreachable!(),
            ),
            Err(ErrorCode::AudioProbeAlreadyRunning)
        );

        worker.finished.store(true, Ordering::Release);
        let snapshot = manager.snapshot();
        assert_eq!(snapshot.state, AudioProbeState::Idle);
        assert_eq!(snapshot.session_id, None);
        assert_eq!(snapshot.last_error, Some("audioProbeStartTimedOut"));
        assert!(worker.joined.load(Ordering::Acquire));
    }

    #[test]
    fn worker_error_survives_reaping_and_allows_a_new_attempt() {
        let (mut manager, worker) = running_manager("mic-session");
        *worker.join_error.lock().unwrap() = Some(ErrorCode::AudioProbeFailed);
        manager.diagnostics.lock().unwrap().last_error = Some("audioProbeFailed");

        let snapshot = manager.snapshot();

        assert_eq!(snapshot.state, AudioProbeState::Idle);
        assert_eq!(snapshot.session_id, None);
        assert_eq!(snapshot.last_error, Some("audioProbeFailed"));
        assert!(worker.joined.load(Ordering::Acquire));
        assert_eq!(manager.stop("mic-session"), Ok(false));

        let retry_worker = Arc::new(FakeWorker::default());
        assert_eq!(
            manager.start_with_backend("retry-session", "private-device-id".to_owned(), {
                let retry_worker = Arc::clone(&retry_worker);
                move |_, diagnostics| {
                    diagnostics.lock().unwrap().state = AudioProbeState::Running;
                    Ok(Box::new(FakeWorkerProxy(retry_worker)))
                }
            }),
            Ok(())
        );
        assert_eq!(manager.stop("retry-session"), Ok(true));
    }

    #[test]
    fn duplicate_stop_is_idempotent_and_wrong_session_does_not_stop() {
        let (mut manager, worker) = running_manager("mic-session");
        worker.finished.store(false, Ordering::Release);
        assert_eq!(
            manager.stop("other-session"),
            Err(ErrorCode::AudioProbeSessionMismatch)
        );
        assert!(!worker.stop_requested.load(Ordering::Acquire));

        assert_eq!(manager.stop("mic-session"), Ok(true));
        assert_eq!(manager.snapshot().state, AudioProbeState::Idle);
        assert_eq!(manager.stop("mic-session"), Ok(false));
        assert!(worker.stop_requested.load(Ordering::Acquire));
        assert!(worker.joined.load(Ordering::Acquire));
    }

    #[test]
    fn shutdown_stops_worker_and_preserves_cleanup_error() {
        let (mut manager, worker) = running_manager("mic-session");
        worker.finished.store(false, Ordering::Release);
        *worker.join_error.lock().unwrap() = Some(ErrorCode::AudioProbeStopFailed);

        assert_eq!(manager.shutdown(), Err(ErrorCode::AudioProbeStopFailed));

        let snapshot = manager.snapshot();
        assert_eq!(snapshot.state, AudioProbeState::Idle);
        assert_eq!(snapshot.session_id, None);
        assert_eq!(snapshot.last_error, Some("audioProbeStopFailed"));
        assert!(worker.stop_requested.load(Ordering::Acquire));
        assert!(worker.joined.load(Ordering::Acquire));
    }
}
