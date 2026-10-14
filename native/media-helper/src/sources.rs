//! 来源注册表用 revision 管理可见 ID，并保存后续采集所需的目标身份。

use crate::protocol::{ErrorCode, VideoSource, VideoSourceKind};

pub const MAX_VIDEO_SOURCES: usize = 128;
pub const MAX_TITLE_BYTES: usize = 128;

#[derive(Clone)]
pub(super) enum CaptureTarget {
    #[cfg(target_os = "windows")]
    Monitor(windows::NativeHmonitor),
    #[cfg(target_os = "windows")]
    Window(windows::NativeHwnd, windows::WindowIdentity),
    #[cfg(test)]
    Test(u64),
}

#[derive(Clone)]
pub(super) enum ThreadCaptureTarget {
    #[cfg(target_os = "windows")]
    Monitor(usize),
    #[cfg(target_os = "windows")]
    Window(usize, windows::WindowIdentity),
    #[cfg(test)]
    Test,
}

pub(super) struct DiscoveredSource {
    pub(super) source: VideoSource,
    pub(super) target: CaptureTarget,
}

struct RegisteredSource {
    source: VideoSource,
    target: CaptureTarget,
}

#[derive(Default)]
pub struct SourceRegistry {
    revision: u64,
    exhausted: bool,
    sources: Vec<RegisteredSource>,
}

impl SourceRegistry {
    pub(super) fn refresh(
        &mut self,
        discovered: Vec<DiscoveredSource>,
    ) -> Result<(u64, Vec<VideoSource>), ErrorCode> {
        // 刷新时仅复用身份仍匹配的目标；窗口标题和可复用的 HWND 都不足以单独确认窗口。
        if self.exhausted {
            return Err(ErrorCode::SourceDiscoveryFailed);
        }
        let Some(revision) = self.revision.checked_add(1) else {
            self.exhausted = true;
            return Err(ErrorCode::SourceDiscoveryFailed);
        };
        self.revision = revision;
        let mut previous = std::mem::take(&mut self.sources)
            .into_iter()
            .map(Some)
            .collect::<Vec<_>>();
        let mut monitor_index = 0;
        let mut window_index = 0;
        self.sources = discovered
            .into_iter()
            .filter_map(|mut discovered| {
                discovered.source.title = clean_title(&discovered.source.title);
                if discovered.source.title.is_empty() {
                    return None;
                }
                let retained = previous.iter_mut().find_map(|registered| {
                    let current = registered.as_ref()?;
                    if same_target(&current.target, &discovered.target) {
                        registered.take()
                    } else {
                        None
                    }
                });
                let Some(mut registered) = retained else {
                    let (kind, index) = match discovered.source.kind {
                        VideoSourceKind::Monitor => {
                            let index = monitor_index;
                            monitor_index += 1;
                            ("monitor", index)
                        }
                        VideoSourceKind::Window => {
                            let index = window_index;
                            window_index += 1;
                            ("window", index)
                        }
                    };
                    discovered.source.source_id = format!("{kind}:{revision}:{index}");
                    return Some(RegisteredSource {
                        source: discovered.source,
                        target: discovered.target,
                    });
                };
                discovered.source.source_id = registered.source.source_id.clone();
                registered.source = discovered.source;
                registered.target = discovered.target;
                Some(registered)
            })
            .take(MAX_VIDEO_SOURCES)
            .collect();
        Ok((revision, self.public_sources()))
    }

    fn invalidate(&mut self) {
        self.sources.clear();
        match self.revision.checked_add(1) {
            Some(revision) => self.revision = revision,
            None => self.exhausted = true,
        }
    }

    pub(super) fn failed_refresh(&mut self, error: ErrorCode) -> ErrorCode {
        self.invalidate();
        error
    }

    fn public_sources(&self) -> Vec<VideoSource> {
        self.sources
            .iter()
            .map(|registered| registered.source.clone())
            .collect()
    }

    pub(super) fn target(&self, source_id: &str) -> Option<CaptureTarget> {
        self.sources
            .iter()
            .find(|registered| registered.source.source_id == source_id)
            .map(|registered| registered.target.clone())
    }

    pub(super) fn kind(&self, source_id: &str) -> Option<VideoSourceKind> {
        self.sources
            .iter()
            .find(|registered| registered.source.source_id == source_id)
            .map(|registered| registered.source.kind)
    }
}

impl CaptureTarget {
    #[cfg(target_os = "windows")]
    pub(super) fn monitor_handle(&self) -> Option<usize> {
        match self {
            Self::Monitor(monitor) => Some(monitor.0 as usize),
            _ => None,
        }
    }

    pub(super) fn thread_target(self) -> ThreadCaptureTarget {
        match self {
            #[cfg(target_os = "windows")]
            Self::Monitor(monitor) => ThreadCaptureTarget::Monitor(monitor.0 as usize),
            #[cfg(target_os = "windows")]
            Self::Window(window, identity) => {
                ThreadCaptureTarget::Window(window.0 as usize, identity)
            }
            #[cfg(test)]
            Self::Test(_) => ThreadCaptureTarget::Test,
        }
    }
}

fn same_target(left: &CaptureTarget, right: &CaptureTarget) -> bool {
    match (left, right) {
        #[cfg(target_os = "windows")]
        (CaptureTarget::Monitor(left), CaptureTarget::Monitor(right)) => left == right,
        #[cfg(target_os = "windows")]
        (
            CaptureTarget::Window(left_window, left_identity),
            CaptureTarget::Window(right_window, _),
        ) => {
            left_window == right_window
                && windows::window_matches_identity(*right_window, left_identity)
        }
        #[cfg(test)]
        (CaptureTarget::Test(left), CaptureTarget::Test(right)) => left == right,
        _ => false,
    }
}

pub fn clean_title(title: &str) -> String {
    let mut cleaned = String::with_capacity(title.len().min(MAX_TITLE_BYTES));
    for character in title.chars().filter(|character| !character.is_control()) {
        if cleaned.len() + character.len_utf8() > MAX_TITLE_BYTES {
            break;
        }
        cleaned.push(character);
    }
    cleaned
}

#[derive(Default)]
pub(super) struct DiscoveryRuntime {
    #[cfg(target_os = "windows")]
    windows: Option<Result<windows::WindowsDiscovery, ErrorCode>>,
}

impl DiscoveryRuntime {
    pub(super) fn discovery_capability(&mut self) -> crate::protocol::Capability {
        #[cfg(target_os = "windows")]
        {
            match self.windows_discovery() {
                Ok(discovery) => discovery.capability(),
                Err(_) => crate::protocol::Capability {
                    available: false,
                    reason: "sourceDiscoveryFailed",
                },
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

    pub(super) fn video_capture_capability(&mut self) -> crate::protocol::Capability {
        #[cfg(target_os = "windows")]
        {
            match self.windows_discovery() {
                Ok(discovery) => discovery.video_capture_capability(),
                Err(_) => crate::protocol::Capability {
                    available: false,
                    reason: "sourceDiscoveryFailed",
                },
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

    pub(super) fn discover(&mut self) -> Result<Vec<DiscoveredSource>, ErrorCode> {
        #[cfg(target_os = "windows")]
        {
            self.windows_discovery()?.discover()
        }
        #[cfg(not(target_os = "windows"))]
        {
            Err(ErrorCode::PlatformUnsupported)
        }
    }

    pub(super) fn target_is_valid(&mut self, target: &CaptureTarget) -> bool {
        #[cfg(target_os = "windows")]
        {
            self.windows_discovery()
                .map(|discovery| discovery.target_is_valid(target))
                .unwrap_or(false)
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = target;
            false
        }
    }

    pub(super) fn audio_process_identity(
        &mut self,
        target: &CaptureTarget,
    ) -> Result<(u32, u64), ErrorCode> {
        #[cfg(target_os = "windows")]
        {
            self.windows_discovery()?.audio_process_identity(target)
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = target;
            Err(ErrorCode::AudioPlatformUnsupported)
        }
    }

    #[cfg(target_os = "windows")]
    fn windows_discovery(&mut self) -> Result<&mut windows::WindowsDiscovery, ErrorCode> {
        if self.windows.is_none() {
            self.windows = Some(windows::WindowsDiscovery::new());
        }
        match self.windows.as_mut().expect("discovery initialized") {
            Ok(discovery) => Ok(discovery),
            Err(error) => Err(*error),
        }
    }
}

#[cfg(target_os = "windows")]
pub(super) mod windows;

#[cfg(test)]
mod tests {
    use super::{
        CaptureTarget, DiscoveredSource, MAX_TITLE_BYTES, MAX_VIDEO_SOURCES, SourceRegistry,
        clean_title,
    };
    use crate::protocol::{OutboundEvent, PROTOCOL_VERSION, VideoSource, VideoSourceKind};

    fn discovered(kind: VideoSourceKind, title: &str) -> DiscoveredSource {
        discovered_target(kind, title, 1)
    }

    fn discovered_target(kind: VideoSourceKind, title: &str, target_key: u64) -> DiscoveredSource {
        DiscoveredSource {
            source: VideoSource {
                source_id: String::new(),
                kind,
                title: title.to_owned(),
                width: 640,
                height: 480,
                primary: false,
                window_id: None,
                monitor_origin: None,
            },
            target: CaptureTarget::Test(target_key),
        }
    }

    #[test]
    fn refresh_preserves_ids_for_live_targets_and_expires_removed_targets() {
        let mut registry = SourceRegistry::default();
        let (first_revision, first) = registry
            .refresh(vec![discovered(VideoSourceKind::Window, "window")])
            .unwrap();
        let old_id = first[0].source_id.clone();
        assert_eq!(old_id, "window:1:0");
        assert!(registry.target(&old_id).is_some());
        let (second_revision, _) = registry
            .refresh(vec![discovered(VideoSourceKind::Window, "window")])
            .unwrap();
        assert_eq!((first_revision, second_revision), (1, 2));
        assert!(registry.target(&old_id).is_some());
        let (_, without_window) = registry.refresh(Vec::new()).unwrap();
        assert!(without_window.is_empty());
        assert!(registry.target(&old_id).is_none());
        let (_, reappeared) = registry
            .refresh(vec![discovered(VideoSourceKind::Window, "window")])
            .unwrap();
        assert_ne!(old_id, reappeared[0].source_id);
    }

    #[test]
    fn new_targets_get_new_ids_while_existing_targets_keep_their_ids() {
        let mut registry = SourceRegistry::default();
        let (_, first) = registry
            .refresh(vec![discovered(VideoSourceKind::Window, "existing")])
            .unwrap();
        let existing_id = first[0].source_id.clone();
        let (_, refreshed) = registry
            .refresh(vec![
                discovered(VideoSourceKind::Window, "existing renamed"),
                discovered_target(VideoSourceKind::Window, "new", 2),
            ])
            .unwrap();
        assert_eq!(refreshed[0].source_id, existing_id);
        assert_ne!(refreshed[1].source_id, existing_id);
        assert!(registry.target(&existing_id).is_some());
    }

    #[test]
    fn failed_refresh_invalidates_the_previous_snapshot() {
        let mut registry = SourceRegistry::default();
        let (_, sources) = registry
            .refresh(vec![discovered(VideoSourceKind::Monitor, "DISPLAY1")])
            .unwrap();
        let old_id = sources[0].source_id.clone();
        assert_eq!(
            registry.failed_refresh(crate::protocol::ErrorCode::SourceDiscoveryFailed),
            crate::protocol::ErrorCode::SourceDiscoveryFailed
        );
        assert!(registry.target(&old_id).is_none());
        let (revision, next) = registry
            .refresh(vec![discovered(VideoSourceKind::Monitor, "DISPLAY1")])
            .unwrap();
        assert_eq!(revision, 3);
        assert_ne!(old_id, next[0].source_id);
    }

    #[test]
    fn utf8_title_limit_does_not_split_a_character() {
        let title = format!("{}z", "界".repeat(100));
        let cleaned = clean_title(&title);
        assert!(cleaned.len() <= MAX_TITLE_BYTES);
        assert_eq!(cleaned.len() % "界".len(), 0);
        assert!(!cleaned.chars().any(char::is_control));
    }

    #[test]
    fn maximum_source_event_stays_within_the_line_limit() {
        let title = "\\\"".repeat(MAX_TITLE_BYTES / 2);
        let mut registry = SourceRegistry::default();
        let (_, sources) = registry
            .refresh(
                (0..MAX_VIDEO_SOURCES)
                    .map(|_| {
                        let mut source = discovered(VideoSourceKind::Window, &title);
                        source.source.window_id = Some(u64::MAX.to_string());
                        source
                    })
                    .collect(),
            )
            .unwrap();
        let event = OutboundEvent::VideoSources {
            protocol_version: PROTOCOL_VERSION,
            request_id: "r".repeat(128),
            revision: u64::MAX,
            sources,
        };
        let encoded = serde_json::to_vec(&event).unwrap();
        assert!(encoded.len() < crate::protocol::MAX_LINE_BYTES as usize);
    }
}
