//! Helper 的 JSON Lines 命令、响应和异步事件定义；stdout 只承载这些协议消息。

use crate::state::SessionState;
use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u16 = 1;
pub const MAX_LINE_BYTES: u64 = 64 * 1024;
const MAX_IDENTIFIER_BYTES: usize = 128;

#[derive(Debug, Deserialize)]
#[serde(
    tag = "command",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CommandEnvelope {
    Hello {
        protocol_version: u16,
        request_id: String,
    },
    Capabilities {
        protocol_version: u16,
        request_id: String,
    },
    Diagnostics {
        protocol_version: u16,
        request_id: String,
    },
    StopVideo {
        protocol_version: u16,
        request_id: String,
        session_id: String,
    },
    Shutdown {
        protocol_version: u16,
        request_id: String,
    },
    ListVideoSources {
        protocol_version: u16,
        request_id: String,
    },
    ReserveVideo {
        protocol_version: u16,
        request_id: String,
        session_id: String,
        source_id: String,
    },
    StartMicrophoneCapture {
        protocol_version: u16,
        request_id: String,
        session_id: String,
        pipe_id: String,
        input_gain: f32,
        noise_suppression: bool,
        auto_gain_control: bool,
        voice_enhancement: bool,
    },
    ConfigureMicrophoneCapture {
        protocol_version: u16,
        request_id: String,
        session_id: String,
        input_gain: f32,
        noise_suppression: bool,
        auto_gain_control: bool,
        voice_enhancement: bool,
    },
    StopMicrophoneCapture {
        protocol_version: u16,
        request_id: String,
        session_id: String,
    },
    SetRemoteControl {
        protocol_version: u16,
        request_id: String,
        session_id: String,
        source_id: String,
        control_session_id: String,
        controller_identity: String,
    },
    RemoteInput {
        protocol_version: u16,
        request_id: String,
        session_id: String,
        control_session_id: String,
        controller_identity: String,
        sequence: u64,
        input: RemoteInputEvent,
    },
    ClearRemoteControl {
        protocol_version: u16,
        request_id: String,
        session_id: String,
        control_session_id: String,
    },
}

impl CommandEnvelope {
    pub fn protocol_version(&self) -> u16 {
        match self {
            Self::Hello {
                protocol_version, ..
            }
            | Self::Capabilities {
                protocol_version, ..
            }
            | Self::Diagnostics {
                protocol_version, ..
            }
            | Self::StopVideo {
                protocol_version, ..
            }
            | Self::ListVideoSources {
                protocol_version, ..
            }
            | Self::ReserveVideo {
                protocol_version, ..
            }
            | Self::StartMicrophoneCapture {
                protocol_version, ..
            }
            | Self::ConfigureMicrophoneCapture {
                protocol_version, ..
            }
            | Self::StopMicrophoneCapture {
                protocol_version, ..
            }
            | Self::SetRemoteControl {
                protocol_version, ..
            }
            | Self::RemoteInput {
                protocol_version, ..
            }
            | Self::ClearRemoteControl {
                protocol_version, ..
            }
            | Self::Shutdown {
                protocol_version, ..
            } => *protocol_version,
        }
    }

    pub fn request_id(&self) -> &str {
        match self {
            Self::Hello { request_id, .. }
            | Self::Capabilities { request_id, .. }
            | Self::Diagnostics { request_id, .. }
            | Self::StopVideo { request_id, .. }
            | Self::ListVideoSources { request_id, .. }
            | Self::ReserveVideo { request_id, .. }
            | Self::StartMicrophoneCapture { request_id, .. }
            | Self::ConfigureMicrophoneCapture { request_id, .. }
            | Self::StopMicrophoneCapture { request_id, .. }
            | Self::SetRemoteControl { request_id, .. }
            | Self::RemoteInput { request_id, .. }
            | Self::ClearRemoteControl { request_id, .. }
            | Self::Shutdown { request_id, .. } => request_id,
        }
    }
}

#[derive(Debug, Deserialize, Clone, Copy, Eq, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RemoteInputEvent {
    Move {
        x: u16,
        y: u16,
    },
    ButtonDown {
        button: RemoteMouseButton,
        x: u16,
        y: u16,
    },
    ButtonUp {
        button: RemoteMouseButton,
        x: u16,
        y: u16,
    },
    Wheel {
        delta: i32,
    },
    KeyDown {
        key: RemoteKey,
    },
    KeyUp {
        key: RemoteKey,
    },
}

#[derive(Debug, Deserialize, Clone, Copy, Eq, PartialEq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum RemoteMouseButton {
    Left,
    Right,
}

#[derive(Debug, Deserialize, Clone, Copy, Eq, PartialEq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum RemoteKey {
    Enter,
    Escape,
    Space,
    Tab,
    Backspace,
    Delete,
    Home,
    End,
    PageUp,
    PageDown,
    Left,
    Right,
    Up,
    Down,
    Shift,
    Control,
    Alt,
    Digit0,
    Digit1,
    Digit2,
    Digit3,
    Digit4,
    Digit5,
    Digit6,
    Digit7,
    Digit8,
    Digit9,
    LetterA,
    LetterB,
    LetterC,
    LetterD,
    LetterE,
    LetterF,
    LetterG,
    LetterH,
    LetterI,
    LetterJ,
    LetterK,
    LetterL,
    LetterM,
    LetterN,
    LetterO,
    LetterP,
    LetterQ,
    LetterR,
    LetterS,
    LetterT,
    LetterU,
    LetterV,
    LetterW,
    LetterX,
    LetterY,
    LetterZ,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    pub available: bool,
    pub reason: &'static str,
}

#[derive(Clone, Copy, Serialize, Debug, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum VideoSourceKind {
    Monitor,
    Window,
}

#[derive(Clone, Serialize, Debug, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MonitorOrigin {
    pub x: i32,
    pub y: i32,
}

#[derive(Clone, Serialize, Debug, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VideoSource {
    pub source_id: String,
    pub kind: VideoSourceKind,
    pub title: String,
    pub width: u32,
    pub height: u32,
    pub primary: bool,
    /// 仅用于缩略图精确匹配；采集仍使用注册表中的 source_id 和窗口身份。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub monitor_origin: Option<MonitorOrigin>,
}

/// 仅通过父子进程协议交接已校验的来源身份，不返回给网页或匿名报告。
#[derive(Serialize, Debug)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ReservedVideoTarget {
    Monitor {
        monitor_name: String,
    },
    Window {
        window_id: String,
        property_name: String,
        property_value: String,
        executable: String,
    },
}

#[derive(Clone, Copy, Serialize, Debug, Default, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ScreenShareAudioState {
    #[default]
    Idle,
}

#[derive(Clone, Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScreenShareAudioDiagnostics {
    pub state: ScreenShareAudioState,
    pub session_id: Option<String>,
    pub source_kind: Option<VideoSourceKind>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u16>,
    pub packets_received: Option<u64>,
    pub frames_received: Option<u64>,
    pub silent_packets: Option<u64>,
    pub dropped_audio_chunks: Option<u64>,
    pub last_error: Option<&'static str>,
}

#[derive(Serialize)]
#[serde(
    tag = "event",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum OutboundEvent {
    Hello {
        protocol_version: u16,
        request_id: String,
        helper_version: &'static str,
        state: SessionState,
    },
    Capabilities {
        protocol_version: u16,
        request_id: String,
        state: SessionState,
        windows_only: bool,
        video_source_discovery: Capability,
        microphone_capture: Capability,
        system_audio_capture: Capability,
        process_audio_capture: Capability,
    },
    Diagnostics {
        protocol_version: u16,
        request_id: String,
        helper_version: &'static str,
        capture_backend: Option<&'static str>,
        state: SessionState,
        session_id: Option<String>,
        available: bool,
        source_kind: Option<VideoSourceKind>,
        frame_width: Option<u32>,
        frame_height: Option<u32>,
        frames_received: Option<u64>,
        frames_processed: Option<u64>,
        capture_suspended: Option<bool>,
        microphone_capture_dropped_chunks: u64,
        screen_share_audio: Box<ScreenShareAudioDiagnostics>,
    },
    VideoSources {
        protocol_version: u16,
        request_id: String,
        revision: u64,
        sources: Vec<VideoSource>,
    },
    VideoReserved {
        protocol_version: u16,
        request_id: String,
        session_id: String,
        source_id: String,
        target: ReservedVideoTarget,
    },
    Acknowledged {
        protocol_version: u16,
        request_id: String,
        command: &'static str,
        state: SessionState,
        changed: bool,
    },
    MicrophoneCaptureStarted {
        protocol_version: u16,
        request_id: String,
        session_id: String,
        state: SessionState,
        sample_rate: u32,
        channels: u16,
        bits_per_sample: u16,
        nominal_chunk_ms: u8,
        changed: bool,
    },
    MicrophoneCaptureEnded {
        protocol_version: u16,
        session_id: String,
        code: ErrorCode,
    },
    Error {
        protocol_version: u16,
        request_id: Option<String>,
        code: ErrorCode,
        message: &'static str,
        recoverable: bool,
        state: SessionState,
    },
}

#[derive(Clone, Copy, Serialize, Debug, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    MalformedJson,
    LineTooLong,
    UnsupportedProtocolVersion,
    InvalidRequest,
    #[cfg_attr(target_os = "windows", allow(dead_code))]
    PlatformUnsupported,
    SourceDiscoveryFailed,
    CaptureStartFailed,
    CaptureSessionMismatch,
    CaptureAlreadyRunning,
    RemoteControlInvalidSession,
    RemoteControlInputFailed,
    RemoteControlTargetUnavailable,
    #[cfg_attr(target_os = "windows", allow(dead_code))]
    AudioPlatformUnsupported,
    AudioDeviceUnavailable,
    MicrophoneCaptureAlreadyRunning,
    MicrophoneCaptureSessionMismatch,
    MicrophoneCaptureStartFailed,
    MicrophoneCaptureStartTimedOut,
    MicrophoneCaptureStopFailed,
    MicrophoneCaptureFailed,
    MicrophoneCapturePipeFailed,
    MicrophoneCaptureFormatUnsupported,
}

impl ErrorCode {
    pub fn public_message(self) -> &'static str {
        match self {
            Self::PlatformUnsupported => "当前平台不支持视频源发现",
            Self::SourceDiscoveryFailed => "视频源发现失败",
            Self::CaptureStartFailed => "视频捕获启动失败",
            Self::CaptureSessionMismatch => "sessionId 与当前捕获会话不匹配",
            Self::CaptureAlreadyRunning => "已有视频捕获会话正在运行",
            Self::RemoteControlInvalidSession => "远程控制会话无效或已过期",
            Self::RemoteControlInputFailed => "远程输入无法应用",
            Self::RemoteControlTargetUnavailable => "共享显示器已不可用",
            Self::AudioPlatformUnsupported => "当前平台不支持音频来源发现",
            Self::AudioDeviceUnavailable => "没有可用的活动音频端点",
            Self::MicrophoneCaptureAlreadyRunning => "麦克风采集已在运行",
            Self::MicrophoneCaptureSessionMismatch => "麦克风采集会话不匹配",
            Self::MicrophoneCaptureStartFailed => "麦克风采集启动失败",
            Self::MicrophoneCaptureStartTimedOut => "麦克风采集启动等待超时",
            Self::MicrophoneCaptureStopFailed => "麦克风采集停止失败",
            Self::MicrophoneCaptureFailed => "麦克风采集运行失败",
            Self::MicrophoneCapturePipeFailed => "麦克风数据通道失败",
            Self::MicrophoneCaptureFormatUnsupported => "麦克风格式暂不支持",
            _ => "请求无法处理",
        }
    }

    pub fn diagnostic_name(self) -> &'static str {
        match self {
            Self::MalformedJson => "malformedJson",
            Self::LineTooLong => "lineTooLong",
            Self::UnsupportedProtocolVersion => "unsupportedProtocolVersion",
            Self::InvalidRequest => "invalidRequest",
            Self::PlatformUnsupported => "platformUnsupported",
            Self::AudioPlatformUnsupported => "audioPlatformUnsupported",
            Self::SourceDiscoveryFailed => "sourceDiscoveryFailed",
            Self::CaptureStartFailed => "captureStartFailed",
            Self::CaptureSessionMismatch => "captureSessionMismatch",
            Self::CaptureAlreadyRunning => "captureAlreadyRunning",
            Self::RemoteControlInvalidSession => "remoteControlInvalidSession",
            Self::RemoteControlInputFailed => "remoteControlInputFailed",
            Self::RemoteControlTargetUnavailable => "remoteControlTargetUnavailable",
            Self::AudioDeviceUnavailable => "audioDeviceUnavailable",
            Self::MicrophoneCaptureAlreadyRunning => "microphoneCaptureAlreadyRunning",
            Self::MicrophoneCaptureSessionMismatch => "microphoneCaptureSessionMismatch",
            Self::MicrophoneCaptureStartFailed => "microphoneCaptureStartFailed",
            Self::MicrophoneCaptureStartTimedOut => "microphoneCaptureStartTimedOut",
            Self::MicrophoneCaptureStopFailed => "microphoneCaptureStopFailed",
            Self::MicrophoneCaptureFailed => "microphoneCaptureFailed",
            Self::MicrophoneCapturePipeFailed => "microphoneCapturePipeFailed",
            Self::MicrophoneCaptureFormatUnsupported => "microphoneCaptureFormatUnsupported",
        }
    }
}

pub fn valid_identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_IDENTIFIER_BYTES && !value.chars().any(char::is_control)
}

pub fn unavailable_capability() -> Capability {
    Capability {
        available: false,
        reason: "notImplemented",
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn removed_capture_commands_are_not_supported_or_aliased() {
        for command in [
            "startVideo",
            "configureVideo",
            "startCaptureProbe",
            "stopCaptureProbe",
            "releaseSharedTextureSlot",
            "startScreenShareAudio",
            "stopScreenShareAudio",
        ] {
            let request = serde_json::json!({ "command": command, "protocolVersion": 1,
                "requestId": "removed", "sessionId": "video", "sourceId": "monitor:1:0",
                "targetWidth": 1920, "targetHeight": 1080, "maxFps": 60,
                "pipeId": "58d00436-8ac2-4d0c-9283-9d5d5f70ed01", "slotIndex": 0 });
            assert!(serde_json::from_value::<super::CommandEnvelope>(request).is_err());
        }
    }

    #[test]
    fn window_reservation_protocol_keeps_pointer_values_as_strings() {
        let command: super::CommandEnvelope = serde_json::from_str(
            r#"{"command":"reserveVideo","protocolVersion":1,"requestId":"request-1","sessionId":"video-1","sourceId":"window:1:0"}"#,
        ).unwrap();
        assert_eq!(command.request_id(), "request-1");
        assert_eq!(command.protocol_version(), 1);
        let event = super::OutboundEvent::VideoReserved {
            protocol_version: 1,
            request_id: "request-1".to_owned(),
            session_id: "video-1".to_owned(),
            source_id: "window:1:0".to_owned(),
            target: super::ReservedVideoTarget::Window {
                window_id: u64::MAX.to_string(),
                property_name: "LycanSync.MediaHelper.Window.1.2.3".to_owned(),
                property_value: u64::MAX.to_string(),
                executable: "C:\\Games\\game.exe".to_owned(),
            },
        };
        let value = serde_json::to_value(event).unwrap();
        assert_eq!(value["target"]["windowId"], u64::MAX.to_string());
        assert_eq!(value["target"]["propertyValue"], u64::MAX.to_string());
        assert_eq!(value["target"]["kind"], "window");
        let monitor = serde_json::to_value(super::ReservedVideoTarget::Monitor {
            monitor_name: "\\\\.\\DISPLAY1".to_owned(),
        })
        .unwrap();
        assert_eq!(monitor["kind"], "monitor");
        assert_eq!(monitor["monitorName"], "\\\\.\\DISPLAY1");
        assert!(monitor.get("windowId").is_none());
        assert!(serde_json::from_str::<super::CommandEnvelope>(
            r#"{"command":"reserveWindowVideo","protocolVersion":1,"requestId":"old","sessionId":"video","sourceId":"window:1:0"}"#
        ).is_err());
    }

    use super::{
        CommandEnvelope, ErrorCode, OutboundEvent, PROTOCOL_VERSION, VideoSource, VideoSourceKind,
    };

    #[test]
    fn deserializes_list_video_sources_request() {
        let request: CommandEnvelope = serde_json::from_str(
            r#"{"protocolVersion":1,"requestId":"sources-1","command":"listVideoSources"}"#,
        )
        .unwrap();
        assert_eq!(request.protocol_version(), PROTOCOL_VERSION);
        assert_eq!(request.request_id(), "sources-1");
        assert!(matches!(request, CommandEnvelope::ListVideoSources { .. }));
    }

    #[test]
    fn deserializes_fixed_remote_input_commands_without_handle_fields() {
        let command: CommandEnvelope = serde_json::from_str(
            r#"{"protocolVersion":1,"requestId":"input-1","command":"remoteInput","sessionId":"share-1","controlSessionId":"control-1","controllerIdentity":"member-1","sequence":7,"input":{"kind":"keyDown","key":"letterA"}}"#,
        ).unwrap();
        assert!(matches!(command, CommandEnvelope::RemoteInput { .. }));
        let serialized = serde_json::to_value(OutboundEvent::Acknowledged {
            protocol_version: PROTOCOL_VERSION,
            request_id: "input-1".to_owned(),
            command: "remoteInput",
            state: crate::state::SessionState::Running,
            changed: true,
        })
        .unwrap();
        let output = serialized.to_string();
        assert!(!output.contains("HWND"));
        assert!(!output.contains("processId"));
    }

    #[test]
    fn active_microphone_device_error_has_a_stable_code() {
        assert_eq!(
            serde_json::to_value(ErrorCode::AudioDeviceUnavailable).unwrap(),
            "audioDeviceUnavailable"
        );
    }

    #[test]
    fn serializes_video_sources_event_with_protocol_fields() {
        let event = OutboundEvent::VideoSources {
            protocol_version: PROTOCOL_VERSION,
            request_id: "sources-1".to_owned(),
            revision: 1,
            sources: vec![
                VideoSource {
                    source_id: "monitor:1:0".to_owned(),
                    kind: VideoSourceKind::Monitor,
                    title: "DISPLAY1".to_owned(),
                    width: 1920,
                    height: 1080,
                    primary: true,
                    window_id: None,
                    monitor_origin: Some(super::MonitorOrigin { x: -1920, y: 0 }),
                },
                VideoSource {
                    source_id: "window:1:0".to_owned(),
                    kind: VideoSourceKind::Window,
                    title: "Game".to_owned(),
                    width: 1280,
                    height: 720,
                    primary: false,
                    window_id: Some(u64::MAX.to_string()),
                    monitor_origin: None,
                },
            ],
        };
        let value = serde_json::to_value(event).unwrap();
        assert_eq!(value["event"], "videoSources");
        assert_eq!(value["protocolVersion"], 1);
        assert_eq!(value["requestId"], "sources-1");
        assert_eq!(value["revision"], 1);
        assert_eq!(value["sources"][0]["kind"], "monitor");
        assert_eq!(value["sources"][0]["sourceId"], "monitor:1:0");
        assert_eq!(value["sources"][0]["monitorOrigin"]["x"], -1920);
        assert!(value["sources"][0].get("windowId").is_none());
        assert_eq!(value["sources"][1]["windowId"], u64::MAX.to_string());
        assert!(value["sources"][1].get("monitorOrigin").is_none());
    }
}
