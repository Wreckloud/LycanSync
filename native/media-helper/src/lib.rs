//! Helper 运行时：串行处理来源身份与远控输入；媒体设备由 OBS 宿主持有。

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

pub fn run<R: BufRead, W: Write>(mut input: R, mut output: W) -> io::Result<()> {
    // 命令串行处理；媒体宿主不会向此协议流写入采集事件。
    let mut runtime = Runtime::default();
    loop {
        let Some(line) = read_limited_line(&mut input)? else {
            cleanup_result(runtime.shutdown())?;
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
            screen_share_audio: Box::default(),
        },
        CommandEnvelope::InspectVideoSource {
            request_id,
            source_id,
            ..
        } => match runtime.inspect_video_source(source_id) {
            Ok(target) => OutboundEvent::VideoSourceInspected {
                protocol_version: PROTOCOL_VERSION,
                request_id: request_id.clone(),
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
        CommandEnvelope::Shutdown { request_id, .. } => match runtime.shutdown() {
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
    remote_input: remote_input::RemoteInputManager,
    active_source_id: Option<String>,
    video_target: Option<sources::CaptureTarget>,
}

impl Runtime {
    fn inspect_video_source(
        &self,
        source_id: &str,
    ) -> Result<protocol::ReservedVideoTarget, ErrorCode> {
        if !valid_identifier(source_id) {
            return Err(ErrorCode::InvalidRequest);
        }
        // 选择阶段只读取身份，不占用视频会话，也不改变正在共享的来源。
        // 最小化窗口不在可选列表中，已授权会话仍可只读核验原实例。
        if self.active_source_id.as_deref() == Some(source_id) {
            return self
                .video_target
                .as_ref()
                .ok_or(ErrorCode::InvalidRequest)?
                .video_target();
        }
        self.sources
            .target(source_id)
            .ok_or(ErrorCode::InvalidRequest)?
            .video_target()
    }

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

    fn shutdown(&mut self) -> Result<(), ErrorCode> {
        self.session_id()
            .map(str::to_owned)
            .map_or(Ok(()), |session_id| {
                self.clear_remote_control(&session_id, None).map(|_| ())
            })
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

fn cleanup_result(result: Result<(), ErrorCode>) -> io::Result<()> {
    result.map_err(|code| io::Error::other(code.diagnostic_name()))
}

#[cfg(test)]
mod tests {
    #[test]
    fn source_inspection_never_reserves_or_replaces_a_video_session() {
        let mut runtime = super::Runtime::default();
        assert!(runtime.inspect_video_source("window:1:0").is_err());
        assert_eq!(runtime.state(), super::SessionState::Idle);
        runtime.session.begin("existing".to_owned()).unwrap();
        runtime.session.mark_running().unwrap();
        runtime.active_source_id = Some("window:1:0".to_owned());
        runtime.video_target = Some(super::sources::CaptureTarget::Test(7));
        for source in ["window:1:1", "", "invalid\nsource"] {
            assert!(runtime.inspect_video_source(source).is_err());
            assert_eq!(runtime.session_id(), Some("existing"));
            assert_eq!(runtime.active_source_id.as_deref(), Some("window:1:0"));
            assert!(runtime.video_target.is_some());
        }
    }

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

    use super::{Runtime, cleanup_result, handle_command, run};
    use crate::protocol::{ErrorCode, PROTOCOL_VERSION};
    use serde_json::Value;
    use std::io::Cursor;

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
    fn stdin_eof_returns_success_when_cleanup_succeeds() {
        let mut output = Vec::new();
        assert!(run(Cursor::new(b""), &mut output).is_ok());
        assert!(output.is_empty());
    }

    #[test]
    fn stdin_eof_cleanup_failure_becomes_a_process_error() {
        let error = cleanup_result(Err(ErrorCode::RemoteControlInvalidSession))
            .expect_err("cleanup failure must not be reported as successful EOF");

        assert_eq!(error.kind(), std::io::ErrorKind::Other);
        assert_eq!(error.to_string(), "remoteControlInvalidSession");
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
        assert!(events[1].get("microphoneCapture").is_none());
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
{"protocolVersion":1,"requestId":"capture-start","command":"startMicrophoneCapture","sessionId":"mic-session","pipeId":"12345678-1234-1234-1234-123456789abc","inputGain":1,"noiseSuppression":true,"autoGainControl":true,"voiceEnhancement":true}
{"protocolVersion":1,"requestId":"capture-configure","command":"configureMicrophoneCapture","sessionId":"mic-session","inputGain":1,"noiseSuppression":true,"autoGainControl":true,"voiceEnhancement":true}
{"protocolVersion":1,"requestId":"capture-stop","command":"stopMicrophoneCapture","sessionId":"mic-session"}
{"protocolVersion":1,"requestId":"shutdown","command":"shutdown"}
"#,
        );

        for event in &events[..5] {
            assert_eq!(event["code"], "malformedJson");
            assert_eq!(event["state"], "idle");
        }
        assert_eq!(events[5]["command"], "shutdown");
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
