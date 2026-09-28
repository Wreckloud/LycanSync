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
            | Self::StopVideo {
                protocol_version, ..
            }
            | Self::ListVideoSources {
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
            | Self::StopVideo { request_id, .. }
            | Self::ListVideoSources { request_id, .. }
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
        video_source_discovery: Capability,
        microphone_capture: Capability,
        system_audio_capture: Capability,
        process_audio_capture: Capability,
    },
    Diagnostics {
        protocol_version: u16,
        request_id: String,
        state: SessionState,
        session_id: Option<String>,
        available: bool,
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
    CapabilityUnavailable,
    #[cfg_attr(target_os = "windows", allow(dead_code))]
    PlatformUnsupported,
    SourceDiscoveryFailed,
}

impl ErrorCode {
    pub fn public_message(self) -> &'static str {
        match self {
            Self::PlatformUnsupported => "当前平台不支持视频源发现",
            Self::SourceDiscoveryFailed => "视频源发现失败",
            _ => "请求无法处理",
        }
    }
}

pub fn valid_identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_IDENTIFIER_BYTES && !value.chars().any(char::is_control)
}

pub fn valid_video_request(width: u32, height: u32, max_fps: u16) -> bool {
    (1..=8192).contains(&width) && (1..=8192).contains(&height) && (1..=240).contains(&max_fps)
}

pub fn unavailable_capability() -> Capability {
    Capability {
        available: false,
        reason: "notImplemented",
    }
}

#[cfg(test)]
mod tests {
    use super::{CommandEnvelope, OutboundEvent, PROTOCOL_VERSION, VideoSource, VideoSourceKind};

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
