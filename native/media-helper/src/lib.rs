mod protocol;
mod sources;
pub mod state;

use protocol::VideoSource;
use protocol::{
    Capability, CommandEnvelope, ErrorCode, MAX_LINE_BYTES, OutboundEvent, PROTOCOL_VERSION,
    unavailable_capability, valid_identifier, valid_video_request,
};
use sources::{DiscoveryRuntime, SourceRegistry};
use state::{SessionMachine, SessionState};
use std::io::{self, BufRead, Write};

pub fn run<R: BufRead, W: Write>(mut input: R, mut output: W) -> io::Result<()> {
    let mut runtime = Runtime::default();
    loop {
        let Some(line) = read_limited_line(&mut input)? else {
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
            video_capture: unavailable_capability(),
            video_source_discovery: runtime.discovery_capability(),
            microphone_capture: unavailable_capability(),
            system_audio_capture: unavailable_capability(),
            process_audio_capture: unavailable_capability(),
        },
        CommandEnvelope::Diagnostics { request_id, .. } => OutboundEvent::Diagnostics {
            protocol_version: PROTOCOL_VERSION,
            request_id: request_id.clone(),
            state: runtime.state(),
            session_id: runtime.session_id().map(str::to_owned),
            available: false,
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
                || !valid_video_request(*target_width, *target_height, *max_fps)
            {
                return error(
                    runtime,
                    Some(request_id.clone()),
                    ErrorCode::InvalidRequest,
                    "视频采集参数无效",
                );
            }
            if !runtime.source_is_valid(source_id) {
                return error(
                    runtime,
                    Some(request_id.clone()),
                    ErrorCode::InvalidRequest,
                    "sourceId 无效或已过期",
                );
            }
            error(
                runtime,
                Some(request_id.clone()),
                ErrorCode::CapabilityUnavailable,
                "原生视频采集将在 Phase 1 启用",
            )
        }
        CommandEnvelope::StopVideo {
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
            OutboundEvent::Acknowledged {
                protocol_version: PROTOCOL_VERSION,
                request_id: request_id.clone(),
                command: "stopVideo",
                state: runtime.state(),
                changed: false,
            }
        }
        CommandEnvelope::Shutdown { request_id, .. } => OutboundEvent::Acknowledged {
            protocol_version: PROTOCOL_VERSION,
            request_id: request_id.clone(),
            command: "shutdown",
            state: runtime.state(),
            changed: false,
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
}

impl Runtime {
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

    fn source_is_valid(&mut self, source_id: &str) -> bool {
        self.sources
            .target(source_id)
            .is_some_and(|target| self.discovery.target_is_valid(target))
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

#[cfg(test)]
mod tests {
    use super::run;
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
    fn reports_protocol_version_and_real_capabilities() {
        let events = execute(
            r#"{"protocolVersion":1,"requestId":"hello-1","command":"hello"}
{"protocolVersion":1,"requestId":"capabilities-1","command":"capabilities"}
{"protocolVersion":1,"requestId":"shutdown-1","command":"shutdown"}
"#,
        );

        assert_eq!(events[0]["event"], "hello");
        assert_eq!(events[0]["state"], "idle");
        assert_eq!(events[1]["videoCapture"]["available"], false);
        assert_eq!(events[1]["systemAudioCapture"]["available"], false);
        assert_eq!(events[2]["event"], "acknowledged");
    }

    #[test]
    fn rejects_unimplemented_capture_without_changing_state() {
        let events = execute(
            r#"{"protocolVersion":1,"requestId":"start-1","command":"startVideo","sessionId":"capture-1","sourceId":"window-1","targetWidth":1920,"targetHeight":1080,"maxFps":60}
{"protocolVersion":1,"requestId":"diagnostics-1","command":"diagnostics"}
"#,
        );

        assert_eq!(events[0]["code"], "invalidRequest");
        assert_eq!(events[0]["state"], "idle");
        assert_eq!(events[1]["available"], false);
        assert_eq!(events[1]["state"], "idle");
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
