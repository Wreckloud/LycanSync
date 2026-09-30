mod audio_probe;
mod audio_sources;
mod capture;
#[cfg(target_os = "windows")]
mod d3d;
mod protocol;
mod sources;
pub mod state;

use protocol::VideoSource;
#[cfg(not(feature = "shared-texture-output"))]
use protocol::unavailable_video_output_capability;
use protocol::{
    Capability, CommandEnvelope, ErrorCode, MAX_LINE_BYTES, OutboundEvent, PROTOCOL_VERSION,
    audio_source_discovery_capability, unavailable_capability, valid_identifier,
};
use sources::{DiscoveryRuntime, SourceRegistry};
use state::{SessionMachine, SessionState};
use std::io::{self, BufRead, Write};
use std::sync::Mutex;

pub(crate) static EVENT_OUTPUT_LOCK: Mutex<()> = Mutex::new(());

pub fn run<R: BufRead, W: Write>(mut input: R, mut output: W) -> io::Result<()> {
    let mut runtime = Runtime::default();
    loop {
        let Some(line) = read_limited_line(&mut input)? else {
            audio_probe_shutdown_result(runtime.shutdown_audio_probe())?;
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
    runtime.reap_finished_capture();
    runtime.reap_finished_audio_probe();
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
            video_capture: runtime.video_capture_capability(),
            capture_probe: runtime.capture_probe_capability(),
            video_source_discovery: runtime.discovery_capability(),
            microphone_capture: unavailable_capability(),
            system_audio_capture: unavailable_capability(),
            process_audio_capture: unavailable_capability(),
            audio_source_discovery: audio_source_discovery_capability(),
            microphone_probe: audio_probe::probe_capability(),
        },
        CommandEnvelope::Diagnostics { request_id, .. } => {
            let snapshot = runtime.capture.snapshot();
            OutboundEvent::Diagnostics {
                protocol_version: PROTOCOL_VERSION,
                request_id: request_id.clone(),
                state: runtime.state(),
                session_id: runtime.session_id().map(str::to_owned),
                available: true,
                source_kind: snapshot.as_ref().and_then(|value| value.source_kind),
                frame_width: snapshot.as_ref().and_then(|value| value.frame_width),
                frame_height: snapshot.as_ref().and_then(|value| value.frame_height),
                frames_received: snapshot.as_ref().and_then(|value| value.frames_received),
                frames_processed: snapshot.as_ref().and_then(|value| value.frames_processed),
                dropped_notifications: snapshot
                    .as_ref()
                    .and_then(|value| value.dropped_notifications),
                raw_capture_fps: snapshot.as_ref().and_then(|value| value.raw_capture_fps),
                probe_processed_fps: snapshot
                    .as_ref()
                    .and_then(|value| value.probe_processed_fps),
                raw_frame_interval_p50_ms: snapshot
                    .as_ref()
                    .and_then(|value| value.raw_frame_interval_p50_ms),
                raw_frame_interval_p95_ms: snapshot
                    .as_ref()
                    .and_then(|value| value.raw_frame_interval_p95_ms),
                raw_frame_interval_p99_ms: snapshot
                    .as_ref()
                    .and_then(|value| value.raw_frame_interval_p99_ms),
                raw_timestamp_anomalies: snapshot
                    .as_ref()
                    .and_then(|value| value.raw_timestamp_anomalies),
                last_frame_age_ms: snapshot.as_ref().and_then(|value| value.last_frame_age_ms),
                size_changes: snapshot.as_ref().and_then(|value| value.size_changes),
                frame_pool_recreates: snapshot
                    .as_ref()
                    .and_then(|value| value.frame_pool_recreates),
                last_capture_error: snapshot.as_ref().and_then(|value| value.last_capture_error),
                stop_duration_ms: snapshot.as_ref().and_then(|value| value.stop_duration_ms),
                microphone_probe: runtime.audio_probe.snapshot(),
            }
        }
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
        CommandEnvelope::ListAudioSources { request_id, .. } => {
            match runtime.refresh_audio_sources() {
                Ok(snapshot) => OutboundEvent::AudioSources {
                    protocol_version: PROTOCOL_VERSION,
                    request_id: request_id.clone(),
                    revision: snapshot.revision,
                    inputs: snapshot.inputs,
                    outputs: snapshot.outputs,
                    input_status: snapshot.input_status,
                    output_status: snapshot.output_status,
                    inputs_truncated: snapshot.inputs_truncated,
                    outputs_truncated: snapshot.outputs_truncated,
                },
                Err(code) => error(
                    runtime,
                    Some(request_id.clone()),
                    code,
                    code.public_message(),
                ),
            }
        }
        CommandEnvelope::StartMicrophoneProbe {
            request_id,
            session_id,
            source_id,
            ..
        } => {
            if !valid_identifier(session_id) || !valid_identifier(source_id) {
                return error(
                    runtime,
                    Some(request_id.clone()),
                    ErrorCode::InvalidRequest,
                    "探针参数无效",
                );
            }
            match runtime
                .audio_probe
                .start(&runtime.audio_sources, session_id, source_id)
            {
                Ok(()) => OutboundEvent::Acknowledged {
                    protocol_version: PROTOCOL_VERSION,
                    request_id: request_id.clone(),
                    command: "startMicrophoneProbe",
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
        CommandEnvelope::StopMicrophoneProbe {
            request_id,
            session_id,
            ..
        } => {
            if !valid_identifier(session_id) {
                return error(
                    runtime,
                    Some(request_id.clone()),
                    ErrorCode::InvalidRequest,
                    "sessionId 无效",
                );
            }
            match runtime.audio_probe.stop(session_id) {
                Ok(changed) => OutboundEvent::Acknowledged {
                    protocol_version: PROTOCOL_VERSION,
                    request_id: request_id.clone(),
                    command: "stopMicrophoneProbe",
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
        #[cfg(feature = "shared-texture-output")]
        CommandEnvelope::ReleaseSharedTextureSlot {
            request_id,
            session_id,
            slot_index,
            ..
        } => match runtime.release_shared_texture_slot(session_id, *slot_index) {
            Ok(()) => OutboundEvent::Acknowledged {
                protocol_version: PROTOCOL_VERSION,
                request_id: request_id.clone(),
                command: "releaseSharedTextureSlot",
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
        CommandEnvelope::StartVideo {
            request_id,
            session_id,
            source_id,
            target_width,
            target_height,
            max_fps,
            ..
        } => {
            if !valid_identifier(session_id)
                || !valid_identifier(source_id)
                || !(1..=8192).contains(target_width)
                || !(1..=8192).contains(target_height)
                || !(1..=60).contains(max_fps)
            {
                return error(
                    runtime,
                    Some(request_id.clone()),
                    ErrorCode::InvalidRequest,
                    "视频参数无效",
                );
            }
            match runtime.start_video(session_id, source_id, *max_fps) {
                Ok(()) => OutboundEvent::Acknowledged {
                    protocol_version: PROTOCOL_VERSION,
                    request_id: request_id.clone(),
                    command: "startVideo",
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
        CommandEnvelope::StartCaptureProbe {
            request_id,
            session_id,
            source_id,
            ..
        } => {
            if !valid_identifier(session_id) || !valid_identifier(source_id) {
                return error(
                    runtime,
                    Some(request_id.clone()),
                    ErrorCode::InvalidRequest,
                    "探针参数无效",
                );
            }
            match runtime.start_probe(session_id, source_id) {
                Ok(()) => OutboundEvent::Acknowledged {
                    protocol_version: PROTOCOL_VERSION,
                    request_id: request_id.clone(),
                    command: "startCaptureProbe",
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
        CommandEnvelope::StopVideo {
            request_id,
            session_id,
            ..
        } => match runtime.stop_probe(session_id) {
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
        CommandEnvelope::StopCaptureProbe {
            request_id,
            session_id,
            ..
        } => {
            if !valid_identifier(session_id) {
                return error(
                    runtime,
                    Some(request_id.clone()),
                    ErrorCode::InvalidRequest,
                    "sessionId 无效",
                );
            }
            match runtime.stop_probe(session_id) {
                Ok(changed) => OutboundEvent::Acknowledged {
                    protocol_version: PROTOCOL_VERSION,
                    request_id: request_id.clone(),
                    command: "stopCaptureProbe",
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
        CommandEnvelope::Shutdown { request_id, .. } => match runtime.shutdown_audio_probe() {
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
    capture: capture::CaptureManager,
    discovery: DiscoveryRuntime,
    last_completed_session_id: Option<String>,
    audio_sources: audio_sources::AudioSourceRegistry,
    audio_probe: audio_probe::AudioProbeManager,
}

impl Runtime {
    fn state(&self) -> SessionState {
        self.session.state()
    }

    fn session_id(&self) -> Option<&str> {
        self.session.session_id()
    }

    fn refresh_sources(&mut self) -> Result<(u64, Vec<VideoSource>), ErrorCode> {
        self.reap_finished_capture();
        match self.discovery.discover() {
            Ok(discovered) => self.sources.refresh(discovered),
            Err(error) => Err(self.sources.failed_refresh(error)),
        }
    }

    fn discovery_capability(&mut self) -> Capability {
        self.discovery.discovery_capability()
    }

    fn refresh_audio_sources(&mut self) -> Result<audio_sources::AudioSourceSnapshot, ErrorCode> {
        match audio_sources::discover() {
            Ok(discovered) => self.audio_sources.refresh(discovered),
            Err(error) => Err(self.audio_sources.failed_refresh(error)),
        }
    }

    fn shutdown_audio_probe(&mut self) -> Result<(), ErrorCode> {
        self.audio_probe.shutdown()
    }

    fn reap_finished_audio_probe(&mut self) {
        self.audio_probe.reap_finished();
    }

    fn video_capture_capability(&mut self) -> Capability {
        #[cfg(feature = "shared-texture-output")]
        {
            self.discovery.video_capture_capability()
        }
        #[cfg(not(feature = "shared-texture-output"))]
        {
            unavailable_video_output_capability()
        }
    }

    fn capture_probe_capability(&mut self) -> Capability {
        self.discovery.video_capture_capability()
    }

    fn start_probe(&mut self, session_id: &str, source_id: &str) -> Result<(), ErrorCode> {
        self.start_capture_session(session_id, source_id, None)
    }

    fn start_video(
        &mut self,
        session_id: &str,
        source_id: &str,
        max_fps: u16,
    ) -> Result<(), ErrorCode> {
        #[cfg(feature = "shared-texture-output")]
        {
            self.start_capture_session(session_id, source_id, Some(max_fps))
        }
        #[cfg(not(feature = "shared-texture-output"))]
        {
            let _ = (session_id, source_id, max_fps);
            Err(ErrorCode::VideoOutputUnavailable)
        }
    }

    fn start_capture_session(
        &mut self,
        session_id: &str,
        source_id: &str,
        max_fps: Option<u16>,
    ) -> Result<(), ErrorCode> {
        self.reap_finished_capture();
        if self.state() != SessionState::Idle {
            return Err(ErrorCode::CaptureAlreadyRunning);
        }
        let target = self
            .sources
            .target(source_id)
            .ok_or(ErrorCode::InvalidRequest)?;
        let source_kind = self
            .sources
            .kind(source_id)
            .ok_or(ErrorCode::InvalidRequest)?;
        if !self.discovery.target_is_valid(&target) {
            return Err(ErrorCode::InvalidRequest);
        }
        self.session
            .begin(session_id.to_owned())
            .map_err(|_| ErrorCode::CaptureAlreadyRunning)?;
        if let Err(error) = self.capture.start(
            target.thread_target(),
            source_kind,
            session_id.to_owned(),
            max_fps,
        ) {
            let _ = self.session.fail_start();
            return Err(error);
        }
        if self.session.mark_running().is_err() {
            let _ = self.session.fail_start();
            let _ = self.capture.stop();
            return Err(ErrorCode::CaptureStartFailed);
        }
        self.last_completed_session_id = None;
        Ok(())
    }

    #[cfg(feature = "shared-texture-output")]
    fn release_shared_texture_slot(
        &mut self,
        session_id: &str,
        slot_index: u8,
    ) -> Result<(), ErrorCode> {
        if self.session_id() != Some(session_id) {
            return Err(ErrorCode::CaptureSessionMismatch);
        }
        self.capture.release_shared_texture_slot(slot_index)
    }

    fn stop_probe(&mut self, session_id: &str) -> Result<bool, ErrorCode> {
        self.reap_finished_capture();
        if self.state() == SessionState::Idle {
            return if self.last_completed_session_id.as_deref() == Some(session_id) {
                Ok(false)
            } else {
                Err(ErrorCode::CaptureSessionMismatch)
            };
        }
        if self.session_id() != Some(session_id) {
            return Err(ErrorCode::CaptureSessionMismatch);
        }
        if self.state() == SessionState::Running {
            self.session
                .begin_stop(session_id)
                .map_err(|_| ErrorCode::CaptureSessionMismatch)?;
        }
        self.capture.stop()?;
        self.session
            .finish_stop()
            .map_err(|_| ErrorCode::CaptureSessionMismatch)?;
        self.last_completed_session_id = Some(session_id.to_owned());
        Ok(true)
    }

    fn reap_finished_capture(&mut self) {
        if self.capture.reap_finished().is_none() {
            return;
        }
        if let Some(session_id) = self.session_id().map(str::to_owned) {
            if self.state() == SessionState::Running {
                let _ = self.session.begin_stop(&session_id);
            }
            if self.state() == SessionState::Stopping && self.session.finish_stop().is_ok() {
                self.last_completed_session_id = Some(session_id);
            }
        }
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

fn audio_probe_shutdown_result(result: Result<(), ErrorCode>) -> io::Result<()> {
    result.map_err(|code| io::Error::other(code.diagnostic_name()))
}

#[cfg(test)]
mod tests {
    use super::{audio_probe_shutdown_result, run};
    use crate::protocol::ErrorCode;
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
    fn stdin_eof_returns_success_when_audio_probe_cleanup_succeeds() {
        let mut output = Vec::new();
        assert!(run(Cursor::new(b""), &mut output).is_ok());
        assert!(output.is_empty());
    }

    #[test]
    fn stdin_eof_cleanup_failure_becomes_a_process_error() {
        let error = audio_probe_shutdown_result(Err(ErrorCode::AudioProbeStopFailed))
            .expect_err("cleanup failure must not be reported as successful EOF");

        assert_eq!(error.kind(), std::io::ErrorKind::Other);
        assert_eq!(error.to_string(), "audioProbeStopFailed");
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
        assert!(events[1]["videoCapture"]["available"].is_boolean());
        #[cfg(not(feature = "shared-texture-output"))]
        assert_eq!(events[1]["videoCapture"]["available"], false);
        assert!(events[1]["captureProbe"]["available"].is_boolean());
        assert_eq!(events[1]["systemAudioCapture"]["available"], false);
        assert_eq!(events[1]["microphoneCapture"]["available"], false);
        assert!(events[1]["microphoneProbe"]["available"].is_boolean());
        assert_eq!(events[1]["processAudioCapture"]["available"], false);
        assert!(events[1]["audioSourceDiscovery"]["available"].is_boolean());
        assert_eq!(events[2]["event"], "acknowledged");
    }

    #[test]
    fn distinguishes_video_output_from_the_capture_probe() {
        let events = execute(
            r#"{"protocolVersion":1,"requestId":"start-1","command":"startVideo","sessionId":"capture-1","sourceId":"window-1","targetWidth":1920,"targetHeight":1080,"maxFps":60}
{"protocolVersion":1,"requestId":"probe-1","command":"startCaptureProbe","sessionId":"capture-1","sourceId":"window-1"}
{"protocolVersion":1,"requestId":"diagnostics-1","command":"diagnostics"}
"#,
        );

        #[cfg(feature = "shared-texture-output")]
        assert_eq!(events[0]["code"], "invalidRequest");
        #[cfg(not(feature = "shared-texture-output"))]
        assert_eq!(events[0]["code"], "videoOutputUnavailable");
        assert_eq!(events[0]["state"], "idle");
        assert_eq!(events[1]["code"], "invalidRequest");
        assert_eq!(events[2]["available"], true);
        assert_eq!(events[2]["state"], "idle");
    }

    #[test]
    fn diagnostics_exposes_distinct_rate_and_interval_fields_as_unavailable_when_idle() {
        let events = execute(
            r#"{"protocolVersion":1,"requestId":"diagnostics-1","command":"diagnostics"}
{"protocolVersion":1,"requestId":"shutdown-1","command":"shutdown"}
"#,
        );

        let diagnostics = &events[0];
        for field in [
            "rawCaptureFps",
            "probeProcessedFps",
            "rawFrameIntervalP50Ms",
            "rawFrameIntervalP95Ms",
            "rawFrameIntervalP99Ms",
            "rawTimestampAnomalies",
            "framePoolRecreates",
        ] {
            assert!(diagnostics.get(field).is_some(), "missing {field}");
        }
        assert_eq!(diagnostics["rawCaptureFps"], serde_json::Value::Null);
        assert_eq!(diagnostics["probeProcessedFps"], serde_json::Value::Null);
        assert_eq!(diagnostics["framePoolRecreates"], serde_json::Value::Null);
        assert_eq!(
            diagnostics["rawFrameIntervalP50Ms"],
            serde_json::Value::Null
        );
        assert_eq!(
            diagnostics["rawFrameIntervalP95Ms"],
            serde_json::Value::Null
        );
        assert_eq!(
            diagnostics["rawFrameIntervalP99Ms"],
            serde_json::Value::Null
        );
        assert_eq!(
            diagnostics["rawTimestampAnomalies"],
            serde_json::Value::Null
        );
        assert_eq!(diagnostics["microphoneProbe"]["state"], "idle");
        assert_eq!(
            diagnostics["microphoneProbe"]["packetsReceived"],
            serde_json::Value::Null
        );
    }

    #[test]
    fn microphone_probe_commands_are_parsed_without_opening_a_device() {
        let events = execute(
            r#"{"protocolVersion":1,"requestId":"mic-start","command":"startMicrophoneProbe","sessionId":"mic-session","sourceId":"audioInput:1:0"}
{"protocolVersion":1,"requestId":"mic-stop","command":"stopMicrophoneProbe","sessionId":"mic-session"}
{"protocolVersion":1,"requestId":"shutdown","command":"shutdown"}
"#,
        );

        assert_eq!(events[0]["code"], "audioDeviceUnavailable");
        assert_eq!(events[0]["state"], "idle");
        assert_eq!(events[1]["code"], "audioProbeSessionMismatch");
        assert_eq!(events[2]["command"], "shutdown");
    }

    #[test]
    fn repeated_winrt_queries_keep_one_runtime_alive_until_shutdown() {
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
