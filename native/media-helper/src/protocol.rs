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
    StartVideo {
        protocol_version: u16,
        request_id: String,
        session_id: String,
        source_id: String,
        target_width: u32,
        target_height: u32,
        max_fps: u16,
    },
    StartCaptureProbe {
        protocol_version: u16,
        request_id: String,
        session_id: String,
        source_id: String,
    },
    StopVideo {
        protocol_version: u16,
        request_id: String,
        session_id: String,
    },
    StopCaptureProbe {
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
    StartScreenShareAudio {
        protocol_version: u16,
        request_id: String,
        session_id: String,
        source_id: String,
        pipe_id: String,
    },
    StopScreenShareAudio {
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
    #[cfg(feature = "shared-texture-output")]
    ReleaseSharedTextureSlot {
        protocol_version: u16,
        request_id: String,
        session_id: String,
        slot_index: u8,
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
            | Self::StartVideo {
                protocol_version, ..
            }
            | Self::StartCaptureProbe {
                protocol_version, ..
            }
            | Self::StopVideo {
                protocol_version, ..
            }
            | Self::StopCaptureProbe {
                protocol_version, ..
            }
            | Self::ListVideoSources {
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
            | Self::StartScreenShareAudio {
                protocol_version, ..
            }
            | Self::StopScreenShareAudio {
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
            #[cfg(feature = "shared-texture-output")]
            Self::ReleaseSharedTextureSlot {
                protocol_version, ..
            } => *protocol_version,
        }
    }

    pub fn request_id(&self) -> &str {
        match self {
            Self::Hello { request_id, .. }
            | Self::Capabilities { request_id, .. }
            | Self::Diagnostics { request_id, .. }
            | Self::StartVideo { request_id, .. }
            | Self::StartCaptureProbe { request_id, .. }
            | Self::StopVideo { request_id, .. }
            | Self::StopCaptureProbe { request_id, .. }
            | Self::ListVideoSources { request_id, .. }
            | Self::StartMicrophoneCapture { request_id, .. }
            | Self::ConfigureMicrophoneCapture { request_id, .. }
            | Self::StopMicrophoneCapture { request_id, .. }
            | Self::StartScreenShareAudio { request_id, .. }
            | Self::StopScreenShareAudio { request_id, .. }
            | Self::SetRemoteControl { request_id, .. }
            | Self::RemoteInput { request_id, .. }
            | Self::ClearRemoteControl { request_id, .. }
            | Self::Shutdown { request_id, .. } => request_id,
            #[cfg(feature = "shared-texture-output")]
            Self::ReleaseSharedTextureSlot { request_id, .. } => request_id,
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
pub struct VideoSource {
    pub source_id: String,
    pub kind: VideoSourceKind,
    pub title: String,
    pub width: u32,
    pub height: u32,
    pub primary: bool,
}

#[derive(Clone, Copy, Serialize, Debug, Default, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ScreenShareAudioState {
    #[default]
    Idle,
    Starting,
    Running,
    Stopping,
    Failed,
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
        video_capture: Capability,
        capture_probe: Capability,
        video_source_discovery: Capability,
        microphone_capture: Capability,
        system_audio_capture: Capability,
        process_audio_capture: Capability,
        screen_share_audio_capture: Capability,
    },
    Diagnostics {
        protocol_version: u16,
        request_id: String,
        state: SessionState,
        session_id: Option<String>,
        available: bool,
        source_kind: Option<VideoSourceKind>,
        frame_width: Option<u32>,
        frame_height: Option<u32>,
        frames_received: Option<u64>,
        frames_processed: Option<u64>,
        dropped_notifications: Option<u64>,
        raw_capture_fps: Option<f64>,
        probe_processed_fps: Option<f64>,
        raw_frame_interval_p50_ms: Option<f64>,
        raw_frame_interval_p95_ms: Option<f64>,
        raw_frame_interval_p99_ms: Option<f64>,
        raw_timestamp_anomalies: Option<u64>,
        last_frame_age_ms: Option<u64>,
        size_changes: Option<u64>,
        frame_pool_recreates: Option<u64>,
        last_capture_error: Option<&'static str>,
        stop_duration_ms: Option<u64>,
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
    Acknowledged {
        protocol_version: u16,
        request_id: String,
        command: &'static str,
        state: SessionState,
        changed: bool,
    },
    ScreenShareAudioStarted {
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
    VideoCaptureEnded {
        protocol_version: u16,
        session_id: String,
        code: ErrorCode,
    },
    VideoCaptureSuspended {
        protocol_version: u16,
        session_id: String,
        suspended: bool,
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
    HardwareD3dUnavailable,
    CaptureStartFailed,
    CaptureStopTimedOut,
    CaptureSessionMismatch,
    CaptureAlreadyRunning,
    CaptureTargetClosed,
    CaptureDisplayDisconnected,
    CaptureFramePoolRecreateFailed,
    CaptureFrameProcessingFailed,
    CaptureCleanupFailed,
    RemoteControlInvalidSession,
    RemoteControlInputFailed,
    RemoteControlTargetUnavailable,
    #[cfg_attr(feature = "shared-texture-output", allow(dead_code))]
    VideoOutputUnavailable,
    #[cfg_attr(target_os = "windows", allow(dead_code))]
    AudioPlatformUnsupported,
    AudioDeviceUnavailable,
    ScreenShareAudioAlreadyRunning,
    ScreenShareAudioSessionMismatch,
    ScreenShareAudioStartFailed,
    ScreenShareAudioStartTimedOut,
    ScreenShareAudioUnsupported,
    ScreenShareAudioTargetUnavailable,
    ScreenShareAudioPipeFailed,
    ScreenShareAudioStopFailed,
    ScreenShareAudioFailed,
    ScreenShareAudioFormatUnsupported,
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
            Self::HardwareD3dUnavailable => "硬件 D3D11 设备不可用",
            Self::CaptureStartFailed => "视频捕获启动失败",
            Self::CaptureStopTimedOut => "视频捕获停止超时",
            Self::CaptureSessionMismatch => "sessionId 与当前捕获会话不匹配",
            Self::CaptureAlreadyRunning => "已有视频捕获会话正在运行",
            Self::CaptureTargetClosed => "捕获窗口已关闭",
            Self::CaptureDisplayDisconnected => "捕获显示器已断开",
            Self::CaptureFramePoolRecreateFailed => "视频帧池重建失败",
            Self::CaptureFrameProcessingFailed => "视频帧元数据读取失败",
            Self::CaptureCleanupFailed => "视频捕获资源释放失败",
            Self::RemoteControlInvalidSession => "远程控制会话无效或已过期",
            Self::RemoteControlInputFailed => "远程输入无法应用",
            Self::RemoteControlTargetUnavailable => "共享显示器已不可用",
            Self::VideoOutputUnavailable => {
                "视频输出尚未实现；可使用 startCaptureProbe 查询原始捕获帧"
            }
            Self::AudioPlatformUnsupported => "当前平台不支持音频来源发现",
            Self::AudioDeviceUnavailable => "没有可用的活动音频端点",
            Self::ScreenShareAudioAlreadyRunning => "屏幕共享音频已在运行",
            Self::ScreenShareAudioSessionMismatch => "sessionId 与当前屏幕共享音频会话不匹配",
            Self::ScreenShareAudioStartFailed => "屏幕共享音频启动失败",
            Self::ScreenShareAudioStartTimedOut => "屏幕共享音频启动等待超时",
            Self::ScreenShareAudioUnsupported => "当前 Windows 版本不支持屏幕共享声音捕获",
            Self::ScreenShareAudioTargetUnavailable => "屏幕共享音频目标进程不可用",
            Self::ScreenShareAudioPipeFailed => "屏幕共享音频数据通道失败",
            Self::ScreenShareAudioStopFailed => "屏幕共享音频停止失败",
            Self::ScreenShareAudioFailed => "屏幕共享音频采集失败",
            Self::ScreenShareAudioFormatUnsupported => "当前音频格式暂不支持",
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
            Self::HardwareD3dUnavailable => "hardwareD3dUnavailable",
            Self::CaptureStartFailed => "captureStartFailed",
            Self::CaptureStopTimedOut => "captureStopTimedOut",
            Self::CaptureSessionMismatch => "captureSessionMismatch",
            Self::CaptureAlreadyRunning => "captureAlreadyRunning",
            Self::CaptureTargetClosed => "captureTargetClosed",
            Self::CaptureDisplayDisconnected => "captureDisplayDisconnected",
            Self::CaptureFramePoolRecreateFailed => "captureFramePoolRecreateFailed",
            Self::CaptureFrameProcessingFailed => "captureFrameProcessingFailed",
            Self::CaptureCleanupFailed => "captureCleanupFailed",
            Self::RemoteControlInvalidSession => "remoteControlInvalidSession",
            Self::RemoteControlInputFailed => "remoteControlInputFailed",
            Self::RemoteControlTargetUnavailable => "remoteControlTargetUnavailable",
            Self::VideoOutputUnavailable => "videoOutputUnavailable",
            Self::AudioDeviceUnavailable => "audioDeviceUnavailable",
            Self::ScreenShareAudioAlreadyRunning => "screenShareAudioAlreadyRunning",
            Self::ScreenShareAudioSessionMismatch => "screenShareAudioSessionMismatch",
            Self::ScreenShareAudioStartFailed => "screenShareAudioStartFailed",
            Self::ScreenShareAudioStartTimedOut => "screenShareAudioStartTimedOut",
            Self::ScreenShareAudioUnsupported => "screenShareAudioUnsupported",
            Self::ScreenShareAudioTargetUnavailable => "screenShareAudioTargetUnavailable",
            Self::ScreenShareAudioPipeFailed => "screenShareAudioPipeFailed",
            Self::ScreenShareAudioStopFailed => "screenShareAudioStopFailed",
            Self::ScreenShareAudioFailed => "screenShareAudioFailed",
            Self::ScreenShareAudioFormatUnsupported => "screenShareAudioFormatUnsupported",
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

#[cfg(not(feature = "shared-texture-output"))]
pub fn unavailable_video_output_capability() -> Capability {
    Capability {
        available: false,
        reason: "videoOutputNotImplemented",
    }
}

#[cfg(test)]
mod tests {
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
    fn deserializes_start_and_stop_screen_share_audio_commands() {
        let start: CommandEnvelope = serde_json::from_str(
            r#"{"protocolVersion":1,"requestId":"share-audio-1","command":"startScreenShareAudio","sessionId":"video-1","sourceId":"monitor:2:0","pipeId":"58d00436-8ac2-4d0c-9283-9d5d5f70ed01"}"#,
        ).unwrap();
        assert!(matches!(
            start,
            CommandEnvelope::StartScreenShareAudio { .. }
        ));
        let stop: CommandEnvelope = serde_json::from_str(
            r#"{"protocolVersion":1,"requestId":"share-audio-stop-1","command":"stopScreenShareAudio","sessionId":"video-1"}"#,
        ).unwrap();
        assert!(matches!(stop, CommandEnvelope::StopScreenShareAudio { .. }));
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
    fn serializes_screen_share_audio_format_without_target_process_details() {
        let event = OutboundEvent::ScreenShareAudioStarted {
            protocol_version: PROTOCOL_VERSION,
            request_id: "share-audio-1".to_owned(),
            session_id: "video-1".to_owned(),
            state: crate::state::SessionState::Running,
            sample_rate: 44100,
            channels: 2,
            bits_per_sample: 32,
            nominal_chunk_ms: 10,
            changed: true,
        };
        let value = serde_json::to_value(event).unwrap();
        assert_eq!(value["event"], "screenShareAudioStarted");
        assert_eq!(value["sampleRate"], 44100);
        assert_eq!(value["channels"], 2);
        assert!(value.get("processId").is_none());
        assert!(value.get("pipeId").is_none());
    }

    #[test]
    fn serializes_video_capture_end_with_session_and_stable_error_code() {
        let event = OutboundEvent::VideoCaptureEnded {
            protocol_version: PROTOCOL_VERSION,
            session_id: "video-1".to_owned(),
            code: ErrorCode::CaptureTargetClosed,
        };
        let value = serde_json::to_value(event).unwrap();
        assert_eq!(value["event"], "videoCaptureEnded");
        assert_eq!(value["sessionId"], "video-1");
        assert_eq!(value["code"], "captureTargetClosed");
        assert!(value.get("requestId").is_none());
    }

    #[test]
    fn serializes_video_capture_suspension_without_request_id() {
        let event = OutboundEvent::VideoCaptureSuspended {
            protocol_version: PROTOCOL_VERSION,
            session_id: "video-1".to_owned(),
            suspended: true,
        };
        let value = serde_json::to_value(event).unwrap();
        assert_eq!(value["event"], "videoCaptureSuspended");
        assert_eq!(value["sessionId"], "video-1");
        assert_eq!(value["suspended"], true);
        assert!(value.get("requestId").is_none());
    }

    #[test]
    fn active_microphone_device_error_has_a_stable_code() {
        assert_eq!(
            serde_json::to_value(ErrorCode::AudioDeviceUnavailable).unwrap(),
            "audioDeviceUnavailable"
        );
    }

    #[test]
    fn deserializes_probe_without_quality_limits() {
        let request: CommandEnvelope = serde_json::from_str(
            r#"{"protocolVersion":1,"requestId":"probe-1","command":"startCaptureProbe","sessionId":"capture-1","sourceId":"window:1:0"}"#,
        )
        .unwrap();
        assert_eq!(request.protocol_version(), PROTOCOL_VERSION);
        assert!(matches!(request, CommandEnvelope::StartCaptureProbe { .. }));
    }

    #[cfg(feature = "shared-texture-output")]
    #[test]
    fn deserializes_shared_texture_slot_release_command() {
        let request: CommandEnvelope = serde_json::from_str(
            r#"{"protocolVersion":1,"requestId":"release-1","command":"releaseSharedTextureSlot","sessionId":"smoke-1","slotIndex":2}"#,
        )
        .unwrap();
        assert_eq!(request.protocol_version(), PROTOCOL_VERSION);
        assert_eq!(request.request_id(), "release-1");
        assert!(matches!(
            request,
            CommandEnvelope::ReleaseSharedTextureSlot { slot_index: 2, .. }
        ));
    }

    #[test]
    fn serializes_video_sources_event_with_protocol_fields() {
        let event = OutboundEvent::VideoSources {
            protocol_version: PROTOCOL_VERSION,
            request_id: "sources-1".to_owned(),
            revision: 1,
            sources: vec![VideoSource {
                source_id: "monitor:1:0".to_owned(),
                kind: VideoSourceKind::Monitor,
                title: "DISPLAY1".to_owned(),
                width: 1920,
                height: 1080,
                primary: true,
            }],
        };
        let value = serde_json::to_value(event).unwrap();
        assert_eq!(value["event"], "videoSources");
        assert_eq!(value["protocolVersion"], 1);
        assert_eq!(value["requestId"], "sources-1");
        assert_eq!(value["revision"], 1);
        assert_eq!(value["sources"][0]["kind"], "monitor");
        assert_eq!(value["sources"][0]["sourceId"], "monitor:1:0");
    }
}
