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
    ListAudioSources {
        protocol_version: u16,
        request_id: String,
    },
    StartMicrophoneProbe {
        protocol_version: u16,
        request_id: String,
        session_id: String,
        source_id: String,
    },
    StopMicrophoneProbe {
        protocol_version: u16,
        request_id: String,
        session_id: String,
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
            | Self::ListAudioSources {
                protocol_version, ..
            }
            | Self::StartMicrophoneProbe {
                protocol_version, ..
            }
            | Self::StopMicrophoneProbe {
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
            | Self::StartVideo { request_id, .. }
            | Self::StartCaptureProbe { request_id, .. }
            | Self::StopVideo { request_id, .. }
            | Self::StopCaptureProbe { request_id, .. }
            | Self::ListVideoSources { request_id, .. }
            | Self::ListAudioSources { request_id, .. }
            | Self::StartMicrophoneProbe { request_id, .. }
            | Self::StopMicrophoneProbe { request_id, .. }
            | Self::Shutdown { request_id, .. } => request_id,
        }
    }
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

#[derive(Clone, Copy, Serialize, Debug, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum AudioSourceKind {
    Input,
    Output,
}

#[derive(Clone, Copy, Serialize, Debug, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum AudioDefaultRole {
    Console,
    Multimedia,
    Communications,
}

#[derive(Clone, Copy, Serialize, Debug, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum AudioEndpointStatus {
    Available,
    NoActiveDevice,
}

#[derive(Clone, Serialize, Debug, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AudioSource {
    pub source_id: String,
    pub kind: AudioSourceKind,
    pub name: String,
    pub default_roles: Vec<AudioDefaultRole>,
}

#[derive(Clone, Copy, Serialize, Debug, Default, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum AudioProbeState {
    #[default]
    Idle,
    Starting,
    Running,
    Stopping,
    Failed,
}

#[derive(Clone, Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct MicrophoneProbeDiagnostics {
    pub state: AudioProbeState,
    pub session_id: Option<String>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u16>,
    pub bits_per_sample: Option<u16>,
    pub packets_received: Option<u64>,
    pub frames_received: Option<u64>,
    pub silent_flag_packets: Option<u64>,
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
        audio_source_discovery: Capability,
        microphone_probe: Capability,
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
        last_capture_error: Option<&'static str>,
        stop_duration_ms: Option<u64>,
        microphone_probe: MicrophoneProbeDiagnostics,
    },
    VideoSources {
        protocol_version: u16,
        request_id: String,
        revision: u64,
        sources: Vec<VideoSource>,
    },
    AudioSources {
        protocol_version: u16,
        request_id: String,
        revision: u64,
        inputs: Vec<AudioSource>,
        outputs: Vec<AudioSource>,
        input_status: AudioEndpointStatus,
        output_status: AudioEndpointStatus,
        inputs_truncated: bool,
        outputs_truncated: bool,
    },
    Acknowledged {
        protocol_version: u16,
        request_id: String,
        command: &'static str,
        state: SessionState,
        changed: bool,
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
    VideoOutputUnavailable,
    #[cfg_attr(target_os = "windows", allow(dead_code))]
    AudioPlatformUnsupported,
    AudioSourceDiscoveryFailed,
    AudioDeviceUnavailable,
    AudioProbeAlreadyRunning,
    AudioProbeSessionMismatch,
    AudioProbeStartFailed,
    AudioProbeStartTimedOut,
    AudioProbeStopFailed,
    AudioProbeFailed,
    #[cfg_attr(target_os = "windows", allow(dead_code))]
    AudioProbeUnsupported,
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
            Self::VideoOutputUnavailable => {
                "视频输出尚未实现；可使用 startCaptureProbe 查询原始捕获帧"
            }
            Self::AudioPlatformUnsupported => "当前平台不支持音频来源发现",
            Self::AudioSourceDiscoveryFailed => "音频来源发现失败",
            Self::AudioDeviceUnavailable => "没有可用的活动音频端点",
            Self::AudioProbeAlreadyRunning => "麦克风探针已在运行",
            Self::AudioProbeSessionMismatch => "sessionId 与当前麦克风探针不匹配",
            Self::AudioProbeStartFailed => "麦克风元数据探针启动失败",
            Self::AudioProbeStartTimedOut => "麦克风元数据探针启动等待超时；后台清理仍在进行",
            Self::AudioProbeStopFailed => "麦克风元数据探针停止失败",
            Self::AudioProbeFailed => "麦克风元数据探针运行失败",
            Self::AudioProbeUnsupported => "当前平台不支持麦克风元数据探针",
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
            Self::VideoOutputUnavailable => "videoOutputUnavailable",
            Self::AudioPlatformUnsupported => "audioPlatformUnsupported",
            Self::AudioSourceDiscoveryFailed => "audioSourceDiscoveryFailed",
            Self::AudioDeviceUnavailable => "audioDeviceUnavailable",
            Self::AudioProbeAlreadyRunning => "audioProbeAlreadyRunning",
            Self::AudioProbeSessionMismatch => "audioProbeSessionMismatch",
            Self::AudioProbeStartFailed => "audioProbeStartFailed",
            Self::AudioProbeStartTimedOut => "audioProbeStartTimedOut",
            Self::AudioProbeStopFailed => "audioProbeStopFailed",
            Self::AudioProbeFailed => "audioProbeFailed",
            Self::AudioProbeUnsupported => "audioProbeUnsupported",
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

pub fn unavailable_video_output_capability() -> Capability {
    Capability {
        available: false,
        reason: "videoOutputNotImplemented",
    }
}

pub fn audio_source_discovery_capability() -> Capability {
    #[cfg(target_os = "windows")]
    {
        Capability {
            available: true,
            reason: "windowsCoreAudioEndpointEnumeration",
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
        AudioDefaultRole, AudioEndpointStatus, AudioSource, AudioSourceKind, CommandEnvelope,
        ErrorCode, OutboundEvent, PROTOCOL_VERSION, VideoSource, VideoSourceKind,
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
    fn deserializes_list_audio_sources_request() {
        let request: CommandEnvelope = serde_json::from_str(
            r#"{"protocolVersion":1,"requestId":"audio-1","command":"listAudioSources"}"#,
        )
        .unwrap();
        assert_eq!(request.protocol_version(), PROTOCOL_VERSION);
        assert_eq!(request.request_id(), "audio-1");
        assert!(matches!(request, CommandEnvelope::ListAudioSources { .. }));
    }

    #[test]
    fn audio_discovery_errors_have_stable_codes() {
        assert_eq!(
            serde_json::to_value(ErrorCode::AudioPlatformUnsupported).unwrap(),
            "audioPlatformUnsupported"
        );
        assert_eq!(
            serde_json::to_value(ErrorCode::AudioSourceDiscoveryFailed).unwrap(),
            "audioSourceDiscoveryFailed"
        );
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

    #[test]
    fn serializes_audio_sources_with_default_roles_and_endpoint_status() {
        let event = OutboundEvent::AudioSources {
            protocol_version: PROTOCOL_VERSION,
            request_id: "audio-1".to_owned(),
            revision: 2,
            inputs: vec![AudioSource {
                source_id: "audioInput:2:0".to_owned(),
                kind: AudioSourceKind::Input,
                name: "Microphone".to_owned(),
                default_roles: vec![AudioDefaultRole::Communications],
            }],
            outputs: vec![],
            input_status: AudioEndpointStatus::Available,
            output_status: AudioEndpointStatus::NoActiveDevice,
            inputs_truncated: false,
            outputs_truncated: false,
        };

        let value = serde_json::to_value(event).unwrap();
        assert_eq!(value["event"], "audioSources");
        assert_eq!(value["revision"], 2);
        assert_eq!(value["inputs"][0]["kind"], "input");
        assert_eq!(value["inputs"][0]["defaultRoles"][0], "communications");
        assert_eq!(value["outputs"], serde_json::json!([]));
        assert_eq!(value["outputStatus"], "noActiveDevice");
    }
}
