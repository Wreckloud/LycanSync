use crate::protocol::{ErrorCode, VideoSourceKind};
use crate::sources::ThreadCaptureTarget;

#[derive(Clone, Debug, Default)]
pub(super) struct CaptureSnapshot {
    pub(super) source_kind: Option<VideoSourceKind>,
    pub(super) frame_width: Option<u32>,
    pub(super) frame_height: Option<u32>,
    pub(super) frames_received: Option<u64>,
    pub(super) frames_processed: Option<u64>,
    pub(super) dropped_notifications: Option<u64>,
    pub(super) raw_capture_fps: Option<f64>,
    pub(super) probe_processed_fps: Option<f64>,
    pub(super) raw_frame_interval_p50_ms: Option<f64>,
    pub(super) raw_frame_interval_p95_ms: Option<f64>,
    pub(super) raw_frame_interval_p99_ms: Option<f64>,
    pub(super) raw_timestamp_anomalies: Option<u64>,
    pub(super) last_frame_age_ms: Option<u64>,
    pub(super) size_changes: Option<u64>,
    pub(super) frame_pool_recreates: Option<u64>,
    pub(super) last_capture_error: Option<&'static str>,
    pub(super) stop_duration_ms: Option<u64>,
    pub(super) capture_suspended: Option<bool>,
}

#[derive(Default)]
pub(super) struct CaptureManager {
    #[cfg(target_os = "windows")]
    windows: windows::CaptureManager,
}

impl CaptureManager {
    pub(super) fn start(
        &mut self,
        target: ThreadCaptureTarget,
        source_kind: VideoSourceKind,
        session_id: String,
        max_fps: Option<u16>,
    ) -> Result<(), ErrorCode> {
        #[cfg(target_os = "windows")]
        {
            self.windows.start(target, source_kind, session_id, max_fps)
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = (target, source_kind, session_id, max_fps);
            Err(ErrorCode::PlatformUnsupported)
        }
    }

    #[cfg(feature = "shared-texture-output")]
    pub(super) fn release_shared_texture_slot(&mut self, slot_index: u8) -> Result<(), ErrorCode> {
        #[cfg(target_os = "windows")]
        {
            self.windows
                .release_shared_texture_slot(slot_index as usize)
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = slot_index;
            Err(ErrorCode::PlatformUnsupported)
        }
    }

    pub(super) fn stop(&mut self) -> Result<CaptureSnapshot, ErrorCode> {
        #[cfg(target_os = "windows")]
        {
            self.windows.stop()
        }
        #[cfg(not(target_os = "windows"))]
        {
            Err(ErrorCode::PlatformUnsupported)
        }
    }

    pub(super) fn snapshot(&mut self) -> Option<CaptureSnapshot> {
        #[cfg(target_os = "windows")]
        {
            self.windows.snapshot()
        }
        #[cfg(not(target_os = "windows"))]
        {
            None
        }
    }

    pub(super) fn reap_finished(&mut self) -> Option<CaptureSnapshot> {
        #[cfg(target_os = "windows")]
        {
            self.windows.reap_finished()
        }
        #[cfg(not(target_os = "windows"))]
        {
            None
        }
    }
}

#[cfg(target_os = "windows")]
mod windows;
