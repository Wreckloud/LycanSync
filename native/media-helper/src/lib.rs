//! Helper 运行时：串行处理命令，并协调来源发现、媒体采集与远控输入管理器。

mod audio_capture;
mod audio_processing;
mod protocol;
mod remote_input;
mod sources;
pub mod state;

use protocol::VideoSource;
use protocol::{
    Capability, CommandEnvelope, ErrorCode, MAX_LINE_BYTES, OutboundEvent, PROTOCOL_VERSION,
    unavailable_capability, valid_identifier,
};
use sources::{DiscoveryRuntime, SourceRegistry};
use state::{SessionMachine, SessionState};
use std::io::{self, BufRead, Write};
use std::sync::Mutex;

pub(crate) static EVENT_OUTPUT_LOCK: Mutex<()> = Mutex::new(());

pub(crate) fn notify_microphone_capture_ended(session_id: &str, code: ErrorCode) {
    write_capture_event(microphone_capture_ended_event(session_id, code));
}

fn microphone_capture_ended_event(session_id: &str, code: ErrorCode) -> OutboundEvent {
    OutboundEvent::MicrophoneCaptureEnded {
        protocol_version: PROTOCOL_VERSION,
        session_id: session_id.to_owned(),
        code,
    }
}

fn microphone_capture_reap_event(
    session_id: &str,
    result: audio_capture::MicrophoneCaptureJoinError,
) -> Option<OutboundEvent> {
    match result {
        // 采集运行错误已由 worker 结束事件上报；回收阶段只补报线程 join 失败。
        audio_capture::MicrophoneCaptureJoinError::Capture(_error) => None,
        audio_capture::MicrophoneCaptureJoinError::JoinFailed => Some(
            microphone_capture_ended_event(session_id, ErrorCode::MicrophoneCaptureStopFailed),
        ),
    }
}

fn write_capture_event(event: OutboundEvent) {
    let _event_lock = EVENT_OUTPUT_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let stdout = io::stdout();
    let mut output = stdout.lock();
    if serde_json::to_writer(&mut output, &event).is_ok() {
        let _ = output.write_all(b"\n").and_then(|()| output.flush());
    }
}

pub fn run<R: BufRead, W: Write>(mut input: R, mut output: W) -> io::Result<()> {
    // 命令在此循环中串行分发；捕获线程的异步事件通过同一输出锁写入协议流。
    let mut runtime = Runtime::default();
    loop {
        let Some(line) = read_limited_line(&mut input)? else {
            audio_shutdown_result(runtime.shutdown_all_audio())?;
            return Ok(());
        };
        let event = match line {
            InputLine::Value(value) => match serde_json::from_str::<CommandEnvelope>(&value) {
                Ok(command) => handle_command(&mut runtime, &command),
                Err(_) => OutboundEvent::Error {
                    protocol_version: PROTOCOL_VERSION,
                    request_id: None,
                    code: ErrorCode::MalformedJson,
                    message: "命令不是有效的 JSON Lines 协议消息",
                    recoverable: true,
                    state: runtime.state(),
                },
            },
            InputLine::TooLong => OutboundEvent::Error {
                protocol_version: PROTOCOL_VERSION,
                request_id: None,
                code: ErrorCode::LineTooLong,
                message: "单条命令超过 64 KiB 限制",
                recoverable: true,
                state: runtime.state(),
            },
        };
        let shutdown = matches!(
            event,
            OutboundEvent::Acknowledged {
                command: "shutdown",
                ..
            }
        );
        let _output_lock = EVENT_OUTPUT_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        serde_json::to_writer(&mut output, &event)?;
        output.write_all(b"\n")?;
        output.flush()?;
        if shutdown {
            return Ok(());
        }
    }
}

fn handle_command(runtime: &mut Runtime, envelope: &CommandEnvelope) -> OutboundEvent {
    if !valid_identifier(envelope.request_id()) {
        return error(runtime, None, ErrorCode::InvalidRequest, "requestId 无效");
    }
    if envelope.protocol_version() != PROTOCOL_VERSION {
        return error(
            runtime,
            Some(envelope.request_id().to_owned()),
            ErrorCode::UnsupportedProtocolVersion,
            "协议版本不受支持",
        );
    }
    runtime.reap_finished_audio();
    match envelope {
        CommandEnvelope::Hello { request_id, .. } => OutboundEvent::Hello {
            protocol_version: PROTOCOL_VERSION,
            request_id: request_id.clone(),
            helper_version: env!("CARGO_PKG_VERSION"),
            state: runtime.state(),
        },
        CommandEnvelope::Capabilities { request_id, .. } => OutboundEvent::Capabilities {
            protocol_version: PROTOCOL_VERSION,
            request_id: request_id.clone(),
            state: runtime.state(),
            windows_only: true,
            video_source_discovery: runtime.discovery_capability(),
            microphone_capture: audio_capture::capability(),
            system_audio_capture: unavailable_capability(),
            process_audio_capture: unavailable_capability(),
        },
        CommandEnvelope::Diagnostics { request_id, .. } => OutboundEvent::Diagnostics {
            protocol_version: PROTOCOL_VERSION,
            request_id: request_id.clone(),
            helper_version: env!("CARGO_PKG_VERSION"),
            capture_backend: None,
            state: runtime.state(),
            session_id: runtime.session_id().map(str::to_owned),
            available: true,
            source_kind: None,
            frame_width: None,
            frame_height: None,
            frames_received: None,
            frames_processed: None,
            capture_suspended: None,
            microphone_capture_dropped_chunks: runtime.microphone_capture.dropped_chunks(),
            screen_share_audio: Box::default(),
        },
        CommandEnvelope::ReserveVideo {
            request_id,
            session_id,
            source_id,
            ..
        } => match runtime.reserve_video(session_id, source_id) {
            Ok(target) => OutboundEvent::VideoReserved {
                protocol_version: PROTOCOL_VERSION,
                request_id: request_id.clone(),
                session_id: session_id.clone(),
                source_id: source_id.clone(),
                target,
            },
            Err(code) => error(
                runtime,
                Some(request_id.clone()),
                code,
                code.public_message(),
            ),
        },
        CommandEnvelope::ListVideoSources { request_id, .. } => match runtime.refresh_sources() {
            Ok((revision, sources)) => OutboundEvent::VideoSources {
                protocol_version: PROTOCOL_VERSION,
                request_id: request_id.clone(),
                revision,
                sources,
            },
            Err(code) => error(
                runtime,
                Some(request_id.clone()),
                code,
                code.public_message(),
            ),
        },
        CommandEnvelope::StartMicrophoneCapture {
            request_id,
            session_id,
            pipe_id,
            input_gain,
            noise_suppression,
            auto_gain_control,
            voice_enhancement,
            ..
        } => {
            if !valid_identifier(session_id) || !valid_pipe_id(pipe_id) {
                return error(
                    runtime,
                    Some(request_id.clone()),
                    ErrorCode::InvalidRequest,
                    "麦克风采集参数无效",
                );
            }
            let settings = audio_processing::ProcessingSettings {
                input_gain: *input_gain,
                noise_suppression: *noise_suppression,
                auto_gain_control: *auto_gain_control,
                voice_enhancement: *voice_enhancement,
            };
            match runtime.microphone_capture.start(
                session_id,
                pipe_id,
                settings,
                audio_capture::start,
            ) {
                Ok(()) => OutboundEvent::MicrophoneCaptureStarted {
                    protocol_version: PROTOCOL_VERSION,
                    request_id: request_id.clone(),
                    session_id: session_id.clone(),
                    state: runtime.state(),
                    sample_rate: audio_processing::SAMPLE_RATE,
                    channels: 1,
                    bits_per_sample: 32,
                    nominal_chunk_ms: 10,
                    changed: true,
                },
                Err(code) => error(
                    runtime,
                    Some(request_id.clone()),
                    code,
                    code.public_message(),
                ),
            }
        }
        CommandEnvelope::ConfigureMicrophoneCapture {
            request_id,
            session_id,
            input_gain,
            noise_suppression,
            auto_gain_control,
            voice_enhancement,
            ..
        } => {
            if !valid_identifier(session_id) {
                return error(
                    runtime,
                    Some(request_id.clone()),
                    ErrorCode::InvalidRequest,
                    "麦克风采集会话无效",
                );
            }
            match runtime.microphone_capture.configure(
                session_id,
                audio_processing::ProcessingSettings {
                    input_gain: *input_gain,
                    noise_suppression: *noise_suppression,
                    auto_gain_control: *auto_gain_control,
                    voice_enhancement: *voice_enhancement,
                },
            ) {
                Ok(()) => OutboundEvent::Acknowledged {
                    protocol_version: PROTOCOL_VERSION,
                    request_id: request_id.clone(),
                    command: "configureMicrophoneCapture",
                    state: runtime.state(),
                    changed: true,
                },
                Err(code) => error(
                    runtime,
                    Some(request_id.clone()),
                    code,
                    code.public_message(),
                ),
            }
        }
        CommandEnvelope::StopMicrophoneCapture {
            request_id,
            session_id,
            ..
        } => {
            if !valid_identifier(session_id) {
                return error(
                    runtime,
                    Some(request_id.clone()),
                    ErrorCode::InvalidRequest,
                    "麦克风采集会话无效",
                );
            }
            match runtime.microphone_capture.stop(session_id) {
                Ok(changed) => OutboundEvent::Acknowledged {
                    protocol_version: PROTOCOL_VERSION,
                    request_id: request_id.clone(),
                    command: "stopMicrophoneCapture",
                    state: runtime.state(),
                    changed,
                },
                Err(code) => error(
                    runtime,
                    Some(request_id.clone()),
                    code,
                    code.public_message(),
                ),
            }
        }
        CommandEnvelope::SetRemoteControl {
            request_id,
            session_id,
            source_id,
            control_session_id,
            controller_identity,
            ..
        } => match runtime.set_remote_control(
            session_id,
            source_id,
            control_session_id,
            controller_identity,
        ) {
            Ok(()) => OutboundEvent::Acknowledged {
                protocol_version: PROTOCOL_VERSION,
                request_id: request_id.clone(),
                command: "setRemoteControl",
                state: runtime.state(),
                changed: true,
            },
            Err(code) => error(
                runtime,
                Some(request_id.clone()),
                code,
                code.public_message(),
            ),
        },
        CommandEnvelope::RemoteInput {
            request_id,
            session_id,
            control_session_id,
            controller_identity,
            sequence,
            input,
            ..
        } => match runtime.apply_remote_input(
            session_id,
            control_session_id,
            controller_identity,
            *sequence,
            *input,
        ) {
            Ok(changed) => OutboundEvent::Acknowledged {
                protocol_version: PROTOCOL_VERSION,
                request_id: request_id.clone(),
                command: "remoteInput",
                state: runtime.state(),
                changed,
            },
            Err(code) => error(
                runtime,
                Some(request_id.clone()),
                code,
                code.public_message(),
            ),
        },
        CommandEnvelope::ClearRemoteControl {
            request_id,
            session_id,
            control_session_id,
            ..
        } => match runtime.clear_remote_control(session_id, Some(control_session_id)) {
            Ok(changed) => OutboundEvent::Acknowledged {
                protocol_version: PROTOCOL_VERSION,
                request_id: request_id.clone(),
                command: "clearRemoteControl",
                state: runtime.state(),
                changed,
            },
            Err(code) => error(
                runtime,
                Some(request_id.clone()),
                code,
                code.public_message(),
            ),
        },
        CommandEnvelope::StopVideo {
            request_id,
            session_id,
            ..
        } => match runtime.stop_video(session_id) {
            Ok(changed) => OutboundEvent::Acknowledged {
                protocol_version: PROTOCOL_VERSION,
                request_id: request_id.clone(),
                command: "stopVideo",
                state: runtime.state(),
                changed,
            },
            Err(code) => error(
                runtime,
                Some(request_id.clone()),
                code,
                code.public_message(),
            ),
        },
        CommandEnvelope::Shutdown { request_id, .. } => match runtime.shutdown_all_audio() {
            Ok(()) => OutboundEvent::Acknowledged {
                protocol_version: PROTOCOL_VERSION,
                request_id: request_id.clone(),
                command: "shutdown",
                state: runtime.state(),
                changed: false,
            },
            Err(code) => error(
                runtime,
                Some(request_id.clone()),
                code,
                code.public_message(),
            ),
        },
    }
}

fn error(
    runtime: &Runtime,
    request_id: Option<String>,
    code: ErrorCode,
    message: &'static str,
) -> OutboundEvent {
    OutboundEvent::Error {
        protocol_version: PROTOCOL_VERSION,
        request_id,
        code,
        message,
        recoverable: true,
        state: runtime.state(),
    }
}

#[derive(Default)]
struct Runtime {
    session: SessionMachine,
    sources: SourceRegistry,
    discovery: DiscoveryRuntime,
    last_completed_session_id: Option<String>,
    microphone_capture: audio_capture::MicrophoneCaptureManager,
    remote_input: remote_input::RemoteInputManager,
    active_source_id: Option<String>,
    video_target: Option<sources::CaptureTarget>,
}

impl Runtime {
    fn reserve_video(
        &mut self,
        session_id: &str,
        source_id: &str,
    ) -> Result<protocol::ReservedVideoTarget, ErrorCode> {
        if !valid_identifier(session_id) || !valid_identifier(source_id) {
            return Err(ErrorCode::InvalidRequest);
        }
        if self.state() != SessionState::Idle {
            return Err(ErrorCode::CaptureAlreadyRunning);
        }
        let target = self
            .sources
            .target(source_id)
            .ok_or(ErrorCode::InvalidRequest)?;
        let identity = target.video_target()?;
        self.session
            .begin(session_id.to_owned())
            .map_err(|_| ErrorCode::CaptureAlreadyRunning)?;
        self.session
            .mark_running()
            .map_err(|_| ErrorCode::CaptureStartFailed)?;
        // 只持有显示器或窗口身份，画面归 OBS；远控仍复用这份会话及既有输入清理。
        self.video_target = Some(target);
        self.active_source_id = Some(source_id.to_owned());
        self.last_completed_session_id = None;
        Ok(identity)
    }

    fn state(&self) -> SessionState {
        self.session.state()
    }

    fn session_id(&self) -> Option<&str> {
        self.session.session_id()
    }

    fn refresh_sources(&mut self) -> Result<(u64, Vec<VideoSource>), ErrorCode> {
        match self.discovery.discover() {
            Ok(discovered) => self.sources.refresh(discovered),
            Err(error) => Err(self.sources.failed_refresh(error)),
        }
    }

    fn discovery_capability(&mut self) -> Capability {
        self.discovery.discovery_capability()
    }

    fn shutdown_all_audio(&mut self) -> Result<(), ErrorCode> {
        // 远控和麦克风各自清理；OBS 画面与共享声音由父进程负责。
        let remote_control_result = self
            .session_id()
            .map(str::to_owned)
            .map_or(Ok(()), |session_id| {
                self.clear_remote_control(&session_id, None).map(|_| ())
            });
        let microphone_result = self.microphone_capture.shutdown();
        remote_control_result.and(microphone_result)
    }

    fn reap_finished_audio(&mut self) {
        if let Some((session_id, error)) = self.microphone_capture.reap_finished_capture() {
            if let Some(event) = microphone_capture_reap_event(&session_id, error) {
                write_capture_event(event);
            }
        }
    }

    fn stop_video(&mut self, session_id: &str) -> Result<bool, ErrorCode> {
        if self.state() == SessionState::Idle {
            return if self.last_completed_session_id.as_deref() == Some(session_id) {
                self.clear_remote_control(session_id, None)?;
                Ok(false)
            } else {
                Err(ErrorCode::CaptureSessionMismatch)
            };
        }
        if self.session_id() != Some(session_id) {
            return Err(ErrorCode::CaptureSessionMismatch);
        }
        let input_cleanup_error = self.clear_remote_control(session_id, None).err();
        if self.state() == SessionState::Running {
            self.session
                .begin_stop(session_id)
                .map_err(|_| ErrorCode::CaptureSessionMismatch)?;
        }
        self.video_target = None;
        self.session
            .finish_stop()
            .map_err(|_| ErrorCode::CaptureSessionMismatch)?;
        self.last_completed_session_id = Some(session_id.to_owned());
        self.active_source_id = None;
        if let Some(error) = input_cleanup_error {
            Err(error)
        } else {
            Ok(true)
        }
    }

    fn set_remote_control(
        &mut self,
        session_id: &str,
        source_id: &str,
        control_session_id: &str,
        controller_identity: &str,
    ) -> Result<(), ErrorCode> {
        if self.session_id() != Some(session_id)
            || self.state() != SessionState::Running
            || self.video_target.is_none()
            || self.active_source_id.as_deref() != Some(source_id)
        {
            return Err(ErrorCode::RemoteControlInvalidSession);
        }
        if !valid_identifier(source_id)
            || !valid_identifier(control_session_id)
            || !valid_identifier(controller_identity)
        {
            return Err(ErrorCode::InvalidRequest);
        }
        let target = self
            .sources
            .target(source_id)
            .ok_or(ErrorCode::InvalidRequest)?;
        if self.sources.kind(source_id) != Some(protocol::VideoSourceKind::Monitor)
            || !self.discovery.target_is_valid(&target)
        {
            return Err(ErrorCode::RemoteControlTargetUnavailable);
        }
        #[cfg(target_os = "windows")]
        {
            let monitor = target
                .monitor_handle()
                .ok_or(ErrorCode::RemoteControlTargetUnavailable)?;
            self.remote_input.grant(
                session_id,
                source_id,
                control_session_id,
                controller_identity,
                monitor,
            )
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = target;
            Err(ErrorCode::PlatformUnsupported)
        }
    }

    fn clear_remote_control(
        &mut self,
        session_id: &str,
        control_session_id: Option<&str>,
    ) -> Result<bool, ErrorCode> {
        self.remote_input
            .revoke(session_id, control_session_id, remote_input::inject)
    }

    fn apply_remote_input(
        &mut self,
        session_id: &str,
        control_session_id: &str,
        controller_identity: &str,
        sequence: u64,
        input: protocol::RemoteInputEvent,
    ) -> Result<bool, ErrorCode> {
        if self.session_id() != Some(session_id)
            || self.state() != SessionState::Running
            || self.video_target.is_none()
        {
            return Err(ErrorCode::RemoteControlInvalidSession);
        }
        let source_id = self
            .remote_input
            .source_id()
            .ok_or(ErrorCode::RemoteControlInvalidSession)?
            .to_owned();
        let target = self
            .sources
            .target(&source_id)
            .ok_or(ErrorCode::RemoteControlTargetUnavailable)?;
        if self.sources.kind(&source_id) != Some(protocol::VideoSourceKind::Monitor)
            || !self.discovery.target_is_valid(&target)
        {
            self.clear_remote_control(session_id, None)?;
            return Err(ErrorCode::RemoteControlTargetUnavailable);
        }
        self.remote_input.apply(
            session_id,
            control_session_id,
            controller_identity,
            sequence,
            input,
            remote_input::inject,
        )
    }
}

enum InputLine {
    Value(String),
    TooLong,
}

fn read_limited_line<R: BufRead>(input: &mut R) -> io::Result<Option<InputLine>> {
    let mut line = String::new();
    let mut limited = std::io::Read::take(&mut *input, MAX_LINE_BYTES + 1);
    let read = limited.read_line(&mut line)?;
    if read == 0 {
        return Ok(None);
    }
    if line.len() as u64 > MAX_LINE_BYTES {
        discard_to_newline(input)?;
        return Ok(Some(InputLine::TooLong));
    }
    Ok(Some(InputLine::Value(
        line.trim_end_matches(['\r', '\n']).to_owned(),
    )))
}

fn discard_to_newline<R: BufRead>(input: &mut R) -> io::Result<()> {
    loop {
        let available = input.fill_buf()?;
        if available.is_empty() {
            return Ok(());
        }
        if let Some(index) = available.iter().position(|value| *value == b'\n') {
            input.consume(index + 1);
            return Ok(());
        }
        let length = available.len();
        input.consume(length);
    }
}

fn audio_shutdown_result(result: Result<(), ErrorCode>) -> io::Result<()> {
    result.map_err(|code| io::Error::other(code.diagnostic_name()))
}

fn valid_pipe_id(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

#[cfg(test)]
mod tests {
    #[test]
    fn external_video_reservation_owns_only_identity_and_uses_normal_stop() {
        let mut runtime = super::Runtime::default();
        assert!(
            runtime
                .reserve_video("window-session", "window:1:0")
                .is_err()
        );
        assert_eq!(runtime.state(), super::SessionState::Idle);
        runtime.session.begin("window-session".to_owned()).unwrap();
        runtime.session.mark_running().unwrap();
        runtime.video_target = Some(super::sources::CaptureTarget::Test(7));
        runtime.active_source_id = Some("window:1:0".to_owned());
        assert_eq!(runtime.state(), super::SessionState::Running);
        assert!(runtime.reserve_video("next", "window:1:1").is_err());
        assert!(runtime.stop_video("old-session").is_err());
        assert!(runtime.video_target.is_some());
        assert!(runtime.stop_video("window-session").unwrap());
        assert!(runtime.video_target.is_none());
        assert_eq!(runtime.state(), super::SessionState::Idle);
        assert!(!runtime.stop_video("window-session").unwrap());
    }

    #[test]
    fn external_monitor_allows_admission_checks_but_invalid_target_never_injects() {
        use crate::protocol::{RemoteInputEvent, VideoSource, VideoSourceKind};
        let mut runtime = super::Runtime::default();
        let (_, sources) = runtime
            .sources
            .refresh(vec![crate::sources::DiscoveredSource {
                source: VideoSource {
                    source_id: String::new(),
                    kind: VideoSourceKind::Monitor,
                    title: "test monitor".to_owned(),
                    width: 1920,
                    height: 1080,
                    primary: true,
                    window_id: None,
                    monitor_origin: None,
                },
                target: crate::sources::CaptureTarget::Test(7),
            }])
            .unwrap();
        let source_id = &sources[0].source_id;
        runtime
            .session
            .begin("external-monitor".to_owned())
            .unwrap();
        runtime.session.mark_running().unwrap();
        runtime.active_source_id = Some(source_id.clone());
        assert_eq!(
            runtime.set_remote_control("external-monitor", source_id, "control", "friend"),
            Err(crate::protocol::ErrorCode::RemoteControlInvalidSession)
        );
        runtime.video_target = Some(crate::sources::CaptureTarget::Test(7));
        assert_eq!(
            runtime.set_remote_control("external-monitor", source_id, "control", "friend"),
            Err(crate::protocol::ErrorCode::RemoteControlTargetUnavailable)
        );
        // 只设置空的受控授权；失效来源在注入前撤销，测试不会发送系统输入。
        runtime
            .remote_input
            .grant("external-monitor", source_id, "control", "friend", 0)
            .unwrap();
        assert_eq!(
            runtime.apply_remote_input(
                "external-monitor",
                "control",
                "friend",
                1,
                RemoteInputEvent::Move { x: 1, y: 1 }
            ),
            Err(crate::protocol::ErrorCode::RemoteControlTargetUnavailable)
        );
        assert!(runtime.remote_input.source_id().is_none());
        runtime.stop_video("external-monitor").unwrap();
    }

    use super::{
        Runtime, audio_shutdown_result, handle_command, microphone_capture_ended_event,
        microphone_capture_reap_event, run,
    };
    use crate::audio_capture::{
        MicrophoneCaptureJoinError, MicrophoneCaptureWorker, StartedCapture,
    };
    use crate::audio_processing::ProcessingSettings;
    use crate::protocol::{ErrorCode, PROTOCOL_VERSION};
    use serde_json::Value;
    use std::io::Cursor;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    fn execute(input: &str) -> Vec<Value> {
        let mut output = Vec::new();
        run(Cursor::new(input.as_bytes()), &mut output).unwrap();
        String::from_utf8(output)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    #[test]
    fn stdin_eof_returns_success_when_audio_cleanup_succeeds() {
        let mut output = Vec::new();
        assert!(run(Cursor::new(b""), &mut output).is_ok());
        assert!(output.is_empty());
    }

    #[test]
    fn stdin_eof_cleanup_failure_becomes_a_process_error() {
        let error = audio_shutdown_result(Err(ErrorCode::MicrophoneCaptureStopFailed))
            .expect_err("cleanup failure must not be reported as successful EOF");

        assert_eq!(error.kind(), std::io::ErrorKind::Other);
        assert_eq!(error.to_string(), "microphoneCaptureStopFailed");
    }

    #[test]
    fn reaped_capture_failure_does_not_block_hello_and_allows_a_new_session() {
        let (mut runtime, joined) = runtime_with_finished_microphone_worker(
            MicrophoneCaptureJoinError::Capture(ErrorCode::MicrophoneCaptureFailed),
        );
        let response = handle_command(
            &mut runtime,
            &crate::protocol::CommandEnvelope::Hello {
                protocol_version: PROTOCOL_VERSION,
                request_id: "hello-after-mic-error".to_owned(),
            },
        );
        let response = serde_json::to_value(response).unwrap();

        assert_eq!(response["event"], "hello");
        assert!(joined.load(Ordering::Acquire));
        assert_eq!(runtime.microphone_capture.stop("failed-session"), Ok(false));

        let next_response = handle_command(
            &mut runtime,
            &crate::protocol::CommandEnvelope::Hello {
                protocol_version: PROTOCOL_VERSION,
                request_id: "hello-after-reap".to_owned(),
            },
        );
        assert_eq!(
            serde_json::to_value(next_response).unwrap()["event"],
            "hello"
        );

        runtime
            .microphone_capture
            .start(
                "next-session",
                "next-pipe",
                ProcessingSettings::default(),
                |_, _, _| {
                    Ok(StartedCapture {
                        worker: Box::new(FinishedMicrophoneWorker {
                            join_error: None,
                            joined: Arc::new(AtomicBool::new(false)),
                        }),
                        dropped_chunks: Arc::new(std::sync::atomic::AtomicU64::new(0)),
                    })
                },
            )
            .unwrap();
        runtime
            .microphone_capture
            .configure("next-session", ProcessingSettings::default())
            .unwrap();
        runtime.microphone_capture.shutdown().unwrap();
    }

    #[test]
    fn reaped_capture_failure_does_not_prevent_shutdown_cleanup() {
        let (mut runtime, joined) = runtime_with_finished_microphone_worker(
            MicrophoneCaptureJoinError::Capture(ErrorCode::MicrophoneCaptureFailed),
        );
        let response = handle_command(
            &mut runtime,
            &crate::protocol::CommandEnvelope::Shutdown {
                protocol_version: PROTOCOL_VERSION,
                request_id: "shutdown-after-mic-error".to_owned(),
            },
        );
        let response = serde_json::to_value(response).unwrap();

        assert_eq!(response["event"], "acknowledged");
        assert_eq!(response["command"], "shutdown");
        assert!(joined.load(Ordering::Acquire));
        assert_eq!(runtime.microphone_capture.stop("failed-session"), Ok(false));
    }

    #[test]
    fn reaped_join_failure_reports_capture_end_without_blocking_hello() {
        let (mut runtime, joined) =
            runtime_with_finished_microphone_worker(MicrophoneCaptureJoinError::JoinFailed);
        let response = handle_command(
            &mut runtime,
            &crate::protocol::CommandEnvelope::Hello {
                protocol_version: PROTOCOL_VERSION,
                request_id: "hello-after-join-failure".to_owned(),
            },
        );

        assert_eq!(serde_json::to_value(response).unwrap()["event"], "hello");
        assert!(joined.load(Ordering::Acquire));
        assert_eq!(runtime.microphone_capture.stop("failed-session"), Ok(false));
    }

    #[test]
    fn microphone_end_event_preserves_runtime_and_join_error_codes() {
        let capture_error = serde_json::to_value(microphone_capture_ended_event(
            "capture-session",
            ErrorCode::MicrophoneCaptureFailed,
        ))
        .unwrap();
        let join_error = serde_json::to_value(microphone_capture_ended_event(
            "capture-session",
            ErrorCode::MicrophoneCaptureStopFailed,
        ))
        .unwrap();

        assert_eq!(capture_error["event"], "microphoneCaptureEnded");
        assert_eq!(capture_error["code"], "microphoneCaptureFailed");
        assert_eq!(join_error["event"], "microphoneCaptureEnded");
        assert_eq!(join_error["code"], "microphoneCaptureStopFailed");
        assert!(
            microphone_capture_reap_event(
                "capture-session",
                MicrophoneCaptureJoinError::Capture(ErrorCode::MicrophoneCaptureFailed)
            )
            .is_none()
        );
        let cleanup_event = serde_json::to_value(
            microphone_capture_reap_event(
                "capture-session",
                MicrophoneCaptureJoinError::JoinFailed,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(cleanup_event["code"], "microphoneCaptureStopFailed");
    }

    fn runtime_with_finished_microphone_worker(
        join_error: MicrophoneCaptureJoinError,
    ) -> (Runtime, Arc<AtomicBool>) {
        let joined = Arc::new(AtomicBool::new(false));
        let worker_joined = Arc::clone(&joined);
        let mut runtime = Runtime::default();
        runtime
            .microphone_capture
            .start(
                "failed-session",
                "failed-pipe",
                ProcessingSettings::default(),
                |_, _, _| {
                    Ok(StartedCapture {
                        worker: Box::new(FinishedMicrophoneWorker {
                            join_error: Some(join_error),
                            joined: worker_joined,
                        }),
                        dropped_chunks: Arc::new(std::sync::atomic::AtomicU64::new(0)),
                    })
                },
            )
            .unwrap();
        (runtime, joined)
    }

    struct FinishedMicrophoneWorker {
        join_error: Option<MicrophoneCaptureJoinError>,
        joined: Arc<AtomicBool>,
    }

    impl MicrophoneCaptureWorker for FinishedMicrophoneWorker {
        fn request_stop(&self) {}

        fn is_finished(&self) -> bool {
            true
        }

        fn join(&mut self) -> Result<(), MicrophoneCaptureJoinError> {
            self.joined.store(true, Ordering::Release);
            self.join_error.take().map_or(Ok(()), Err)
        }
    }

    #[test]
    fn reports_protocol_version_and_real_capabilities() {
        let events = execute(
            r#"{"protocolVersion":1,"requestId":"hello-1","command":"hello"}
{"protocolVersion":1,"requestId":"capabilities-1","command":"capabilities"}
{"protocolVersion":1,"requestId":"shutdown-1","command":"shutdown"}
"#,
        );

        assert_eq!(events[0]["event"], "hello");
        assert_eq!(events[0]["state"], "idle");
        assert!(events[1].get("videoCapture").is_none());
        assert_eq!(events[1]["systemAudioCapture"]["available"], false);
        #[cfg(target_os = "windows")]
        assert_eq!(events[1]["microphoneCapture"]["available"], true);
        #[cfg(not(target_os = "windows"))]
        assert_eq!(events[1]["microphoneCapture"]["available"], false);
        assert_eq!(events[1]["processAudioCapture"]["available"], false);
        assert!(events[1].get("audioSourceDiscovery").is_none());
        assert!(events[1].get("microphoneProbe").is_none());
        assert_eq!(events[2]["event"], "acknowledged");
    }

    #[test]
    fn diagnostics_does_not_expose_removed_video_probe_fields() {
        let events = execute(
            r#"{"protocolVersion":1,"requestId":"diagnostics-1","command":"diagnostics"}
{"protocolVersion":1,"requestId":"shutdown-1","command":"shutdown"}
"#,
        );

        let diagnostics = &events[0];
        assert_eq!(diagnostics["helperVersion"], env!("CARGO_PKG_VERSION"));
        assert_eq!(diagnostics["captureBackend"], serde_json::Value::Null);
        for field in [
            "rawCaptureFps",
            "rawFrameIntervalP50Ms",
            "rawFrameIntervalP95Ms",
            "rawFrameIntervalP99Ms",
            "rawTimestampAnomalies",
            "framePoolRecreates",
        ] {
            assert!(diagnostics.get(field).is_none(), "obsolete {field}");
        }
        assert!(diagnostics.get("probeProcessedFps").is_none());
    }

    #[test]
    fn removed_microphone_commands_follow_unknown_command_protocol_failure() {
        let events = execute(
            r#"{"protocolVersion":1,"requestId":"mic-start","command":"startMicrophoneProbe","sessionId":"mic-session","sourceId":"audioInput:1:0"}
{"protocolVersion":1,"requestId":"mic-stop","command":"stopMicrophoneProbe","sessionId":"mic-session"}
{"protocolVersion":1,"requestId":"shutdown","command":"shutdown"}
"#,
        );

        assert_eq!(events[0]["code"], "malformedJson");
        assert_eq!(events[0]["state"], "idle");
        assert_eq!(events[1]["code"], "malformedJson");
        assert_eq!(events[2]["command"], "shutdown");
    }

    #[test]
    fn repeated_source_queries_keep_one_registry_alive_until_shutdown() {
        let commands = [
            "capabilities",
            "capabilities",
            "listVideoSources",
            "listVideoSources",
            "capabilities",
            "listVideoSources",
            "capabilities",
            "listVideoSources",
            "capabilities",
            "capabilities",
            "listVideoSources",
            "listVideoSources",
            "capabilities",
            "listVideoSources",
            "capabilities",
            "listVideoSources",
            "listVideoSources",
            "capabilities",
            "capabilities",
            "listVideoSources",
        ];
        let mut input = commands
            .iter()
            .enumerate()
            .map(|(index, command)| {
                format!(
                    "{{\"protocolVersion\":1,\"requestId\":\"query-{index}\",\"command\":\"{command}\"}}\n"
                )
            })
            .collect::<String>();
        input.push_str(
            "{\"protocolVersion\":1,\"requestId\":\"shutdown\",\"command\":\"shutdown\"}\n",
        );
        let events = execute(&input);

        assert_eq!(events.len(), commands.len() + 1);
        for (index, command) in commands.iter().enumerate() {
            let expected = match *command {
                "capabilities" => "capabilities",
                "listVideoSources" => {
                    assert!(
                        events[index]["event"] == "videoSources"
                            || events[index]["event"] == "error"
                    );
                    if events[index]["event"] == "error" {
                        assert!(
                            events[index]["code"] == "sourceDiscoveryFailed"
                                || events[index]["code"] == "platformUnsupported"
                        );
                    }
                    continue;
                }
                _ => unreachable!(),
            };
            assert_eq!(events[index]["event"], expected);
        }
        assert_eq!(events[commands.len()]["event"], "acknowledged");
    }

    #[test]
    fn malformed_message_does_not_stop_following_commands() {
        let events = execute(
            "not-json\n{\"protocolVersion\":1,\"requestId\":\"hello-1\",\"command\":\"hello\"}\n",
        );

        assert_eq!(events[0]["code"], "malformedJson");
        assert_eq!(events[1]["event"], "hello");
    }

    #[test]
    fn rejects_oversized_line_and_recovers_at_next_line() {
        let mut input = "x".repeat(64 * 1024 + 1);
        input.push_str(
            "\n{\"protocolVersion\":1,\"requestId\":\"hello-1\",\"command\":\"hello\"}\n",
        );

        let events = execute(&input);

        assert_eq!(events[0]["code"], "lineTooLong");
        assert_eq!(events[1]["event"], "hello");
    }

    #[test]
    fn reports_unsupported_protocol_version_with_request_id() {
        let events =
            execute("{\"protocolVersion\":2,\"requestId\":\"hello-2\",\"command\":\"hello\"}\n");

        assert_eq!(events[0]["code"], "unsupportedProtocolVersion");
        assert_eq!(events[0]["requestId"], "hello-2");
    }
}
