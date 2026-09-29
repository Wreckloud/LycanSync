use crate::protocol::{AudioEndpointStatus, AudioSource, AudioSourceKind, ErrorCode};
use crate::sources::clean_title;

pub(super) const MAX_AUDIO_SOURCES: usize = 128;
const MAX_AUDIO_SOURCES_PER_KIND: usize = MAX_AUDIO_SOURCES / 2;

pub(super) struct DiscoveredAudioSource {
    pub(super) source: AudioSource,
    pub(super) endpoint_id: String,
}

pub(super) struct DiscoveredAudioSources {
    pub(super) sources: Vec<DiscoveredAudioSource>,
    pub(super) inputs_truncated: bool,
    pub(super) outputs_truncated: bool,
}

struct RegisteredAudioSource {
    source: AudioSource,
    endpoint_id: String,
}

#[derive(Default)]
pub(super) struct AudioSourceRegistry {
    revision: u64,
    exhausted: bool,
    sources: Vec<RegisteredAudioSource>,
}

#[derive(Debug)]
pub(super) struct AudioSourceSnapshot {
    pub(super) revision: u64,
    pub(super) inputs: Vec<AudioSource>,
    pub(super) outputs: Vec<AudioSource>,
    pub(super) input_status: AudioEndpointStatus,
    pub(super) output_status: AudioEndpointStatus,
    pub(super) inputs_truncated: bool,
    pub(super) outputs_truncated: bool,
}

impl AudioSourceRegistry {
    pub(super) fn refresh(
        &mut self,
        discovered: DiscoveredAudioSources,
    ) -> Result<AudioSourceSnapshot, ErrorCode> {
        self.sources.clear();
        if self.exhausted {
            return Err(ErrorCode::AudioSourceDiscoveryFailed);
        }
        let Some(revision) = self.revision.checked_add(1) else {
            self.exhausted = true;
            return Err(ErrorCode::AudioSourceDiscoveryFailed);
        };
        self.revision = revision;

        let mut cleaned = Vec::with_capacity(discovered.sources.len());
        for mut discovered in discovered.sources {
            discovered.source.name = clean_title(&discovered.source.name);
            if discovered.source.name.is_empty() {
                return Err(ErrorCode::AudioSourceDiscoveryFailed);
            }
            cleaned.push(discovered);
        }

        let mut inputs_truncated = discovered.inputs_truncated;
        let mut outputs_truncated = discovered.outputs_truncated;
        let mut selected = Vec::with_capacity(MAX_AUDIO_SOURCES);
        select_kind(
            &cleaned,
            AudioSourceKind::Input,
            "audioInput",
            revision,
            &mut selected,
            &mut inputs_truncated,
        );
        select_kind(
            &cleaned,
            AudioSourceKind::Output,
            "audioOutput",
            revision,
            &mut selected,
            &mut outputs_truncated,
        );
        self.sources = selected;

        if self.sources.is_empty() {
            return Err(ErrorCode::AudioDeviceUnavailable);
        }
        let inputs = self
            .sources
            .iter()
            .filter(|registered| registered.source.kind == AudioSourceKind::Input)
            .map(|registered| registered.source.clone())
            .collect::<Vec<_>>();
        let outputs = self
            .sources
            .iter()
            .filter(|registered| registered.source.kind == AudioSourceKind::Output)
            .map(|registered| registered.source.clone())
            .collect::<Vec<_>>();

        Ok(AudioSourceSnapshot {
            revision,
            input_status: endpoint_status(&inputs),
            output_status: endpoint_status(&outputs),
            inputs,
            outputs,
            inputs_truncated,
            outputs_truncated,
        })
    }

    pub(super) fn failed_refresh(&mut self, error: ErrorCode) -> ErrorCode {
        self.invalidate();
        error
    }

    fn invalidate(&mut self) {
        self.sources.clear();
        match self.revision.checked_add(1) {
            Some(revision) => self.revision = revision,
            None => self.exhausted = true,
        }
    }

    pub(super) fn input_endpoint_id(&self, source_id: &str) -> Option<String> {
        self.sources
            .iter()
            .find(|registered| {
                registered.source.source_id == source_id
                    && registered.source.kind == AudioSourceKind::Input
            })
            .map(|registered| registered.endpoint_id.clone())
    }

    #[cfg(test)]
    fn contains_source_id(&self, source_id: &str) -> bool {
        self.sources
            .iter()
            .any(|registered| registered.source.source_id == source_id)
    }
}

fn select_kind(
    discovered: &[DiscoveredAudioSource],
    kind: AudioSourceKind,
    kind_name: &str,
    revision: u64,
    selected: &mut Vec<RegisteredAudioSource>,
    truncated: &mut bool,
) {
    let mut endpoint_ids = Vec::<String>::with_capacity(MAX_AUDIO_SOURCES_PER_KIND);
    let mut count = 0;
    for prefer_default in [true, false] {
        for candidate in discovered.iter().filter(|candidate| {
            candidate.source.kind == kind
                && (!candidate.source.default_roles.is_empty()) == prefer_default
        }) {
            if endpoint_ids.contains(&candidate.endpoint_id) {
                continue;
            }
            endpoint_ids.push(candidate.endpoint_id.clone());
            count += 1;
            if count > MAX_AUDIO_SOURCES_PER_KIND {
                *truncated = true;
                continue;
            }
            let mut source = candidate.source.clone();
            source.source_id = format!("{kind_name}:{revision}:{}", count - 1);
            selected.push(RegisteredAudioSource {
                source,
                endpoint_id: candidate.endpoint_id.clone(),
            });
        }
    }
}

fn endpoint_status(sources: &[AudioSource]) -> AudioEndpointStatus {
    if sources.is_empty() {
        AudioEndpointStatus::NoActiveDevice
    } else {
        AudioEndpointStatus::Available
    }
}

pub(super) fn discover() -> Result<DiscoveredAudioSources, ErrorCode> {
    #[cfg(target_os = "windows")]
    {
        windows::discover()
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err(ErrorCode::AudioPlatformUnsupported)
    }
}

#[cfg(target_os = "windows")]
mod windows;

#[cfg(test)]
mod tests {
    use super::{
        AudioSourceRegistry, DiscoveredAudioSource, DiscoveredAudioSources, MAX_AUDIO_SOURCES,
    };
    use crate::protocol::{AudioDefaultRole, AudioEndpointStatus, AudioSource, AudioSourceKind};
    use serde_json::json;

    fn discovered(
        kind: AudioSourceKind,
        endpoint_id: String,
        name: String,
    ) -> DiscoveredAudioSource {
        DiscoveredAudioSource {
            source: AudioSource {
                source_id: String::new(),
                kind,
                name,
                default_roles: vec![AudioDefaultRole::Console],
            },
            endpoint_id,
        }
    }

    fn source_set(sources: Vec<DiscoveredAudioSource>) -> DiscoveredAudioSources {
        DiscoveredAudioSources {
            sources,
            inputs_truncated: false,
            outputs_truncated: false,
        }
    }

    #[test]
    fn ids_are_opaque_refresh_scoped_and_private_endpoint_ids_are_not_serialized() {
        let endpoint_id = "{0.0.0.00000000}.{private-endpoint-id}".to_owned();
        let mut registry = AudioSourceRegistry::default();
        let first = registry
            .refresh(source_set(vec![discovered(
                AudioSourceKind::Input,
                endpoint_id.clone(),
                "Microphone".to_owned(),
            )]))
            .unwrap();
        let old_id = first.inputs[0].source_id.clone();
        assert!(!old_id.contains(&endpoint_id));
        assert!(registry.contains_source_id(&old_id));

        let second = registry
            .refresh(source_set(vec![discovered(
                AudioSourceKind::Input,
                endpoint_id.clone(),
                "Microphone".to_owned(),
            )]))
            .unwrap();
        assert_eq!(second.revision, first.revision + 1);
        assert_ne!(second.inputs[0].source_id, old_id);
        assert!(!registry.contains_source_id(&old_id));

        let serialized = serde_json::to_string(&json!({
            "inputs": second.inputs,
            "outputs": second.outputs,
        }))
        .unwrap();
        assert!(!serialized.contains(&endpoint_id));
    }

    #[test]
    fn missing_endpoint_kind_is_explicit_and_refresh_failure_invalidates_ids() {
        let mut registry = AudioSourceRegistry::default();
        let snapshot = registry
            .refresh(source_set(vec![discovered(
                AudioSourceKind::Output,
                "render-id".to_owned(),
                "Speakers".to_owned(),
            )]))
            .unwrap();
        let old_id = snapshot.outputs[0].source_id.clone();
        assert_eq!(snapshot.input_status, AudioEndpointStatus::NoActiveDevice);
        assert_eq!(snapshot.output_status, AudioEndpointStatus::Available);

        assert_eq!(
            registry.failed_refresh(crate::protocol::ErrorCode::AudioSourceDiscoveryFailed),
            crate::protocol::ErrorCode::AudioSourceDiscoveryFailed
        );
        assert!(!registry.contains_source_id(&old_id));
    }

    #[test]
    fn empty_enumeration_is_an_explicit_device_unavailable_error() {
        let mut registry = AudioSourceRegistry::default();
        let first = registry
            .refresh(source_set(vec![discovered(
                AudioSourceKind::Input,
                "capture-id".to_owned(),
                "Microphone".to_owned(),
            )]))
            .unwrap();
        let stale_id = first.inputs[0].source_id.clone();

        assert_eq!(
            registry.refresh(source_set(Vec::new())).unwrap_err(),
            crate::protocol::ErrorCode::AudioDeviceUnavailable
        );
        assert!(!registry.contains_source_id(&stale_id));
    }

    #[test]
    fn endpoint_without_a_display_name_is_a_discovery_failure() {
        let mut registry = AudioSourceRegistry::default();
        let valid = registry
            .refresh(source_set(vec![discovered(
                AudioSourceKind::Input,
                "old-capture-id".to_owned(),
                "Old microphone".to_owned(),
            )]))
            .unwrap();
        let old_id = valid.inputs[0].source_id.clone();
        assert_eq!(
            registry
                .refresh(source_set(vec![
                    discovered(
                        AudioSourceKind::Input,
                        "new-capture-id".to_owned(),
                        "Valid microphone".to_owned(),
                    ),
                    discovered(
                        AudioSourceKind::Input,
                        "invalid-capture-id".to_owned(),
                        "\u{0001}".to_owned(),
                    )
                ]))
                .unwrap_err(),
            crate::protocol::ErrorCode::AudioSourceDiscoveryFailed
        );
        assert!(!registry.contains_source_id(&old_id));
        assert!(registry.sources.is_empty());
    }

    #[test]
    fn default_role_changes_are_reflected_by_the_next_refresh() {
        let mut registry = AudioSourceRegistry::default();
        let first = registry
            .refresh(source_set(vec![discovered(
                AudioSourceKind::Input,
                "capture-id".to_owned(),
                "Microphone".to_owned(),
            )]))
            .unwrap();
        let stale_id = first.inputs[0].source_id.clone();

        let mut changed_default = discovered(
            AudioSourceKind::Input,
            "capture-id".to_owned(),
            "Microphone".to_owned(),
        );
        changed_default.source.default_roles = vec![AudioDefaultRole::Communications];
        let second = registry.refresh(source_set(vec![changed_default])).unwrap();

        assert_eq!(second.revision, first.revision + 1);
        assert_eq!(
            second.inputs[0].default_roles,
            vec![AudioDefaultRole::Communications]
        );
        assert!(!registry.contains_source_id(&stale_id));
    }

    #[test]
    fn audio_sources_are_bounded_and_names_are_clean_utf8() {
        let sources = (0..MAX_AUDIO_SOURCES + 20)
            .map(|index| {
                discovered(
                    if index % 2 == 0 {
                        AudioSourceKind::Input
                    } else {
                        AudioSourceKind::Output
                    },
                    format!("endpoint-{index}"),
                    format!("{}{}\u{0001}", "音频".repeat(100), index),
                )
            })
            .collect();
        let mut registry = AudioSourceRegistry::default();
        let snapshot = registry.refresh(source_set(sources)).unwrap();
        let total = snapshot.inputs.len() + snapshot.outputs.len();
        assert!(total <= MAX_AUDIO_SOURCES);
        assert!(snapshot.inputs_truncated);
        assert!(snapshot.outputs_truncated);
        assert!(
            snapshot
                .inputs
                .iter()
                .chain(snapshot.outputs.iter())
                .all(
                    |source| source.name.len() <= 128 && !source.name.chars().any(char::is_control)
                )
        );

        let event = serde_json::json!({
            "event": "audioSources",
            "protocolVersion": 1,
            "requestId": "audio-1",
            "revision": snapshot.revision,
            "inputs": snapshot.inputs,
            "outputs": snapshot.outputs,
            "inputStatus": snapshot.input_status,
            "outputStatus": snapshot.output_status,
            "inputsTruncated": snapshot.inputs_truncated,
            "outputsTruncated": snapshot.outputs_truncated,
        });
        let serialized = serde_json::to_vec(&event).unwrap();
        assert!(serialized.len() < 64 * 1024);
    }

    #[test]
    fn defaults_are_kept_when_a_kind_exceeds_its_limit() {
        let mut sources = (0..MAX_AUDIO_SOURCES)
            .map(|index| {
                let mut source = discovered(
                    AudioSourceKind::Input,
                    format!("endpoint-{index}"),
                    format!("Microphone {index}"),
                );
                source.source.default_roles.clear();
                source
            })
            .collect::<Vec<_>>();
        let mut default = discovered(
            AudioSourceKind::Input,
            "default-endpoint".to_owned(),
            "Default microphone".to_owned(),
        );
        default.source.default_roles = vec![AudioDefaultRole::Communications];
        sources.push(default);

        let mut registry = AudioSourceRegistry::default();
        let snapshot = registry.refresh(source_set(sources)).unwrap();

        assert_eq!(snapshot.inputs.len(), MAX_AUDIO_SOURCES / 2);
        assert!(snapshot.inputs_truncated);
        assert!(snapshot.outputs.is_empty());
        assert!(snapshot.inputs.iter().any(|source| {
            source.name == "Default microphone"
                && source.default_roles == vec![AudioDefaultRole::Communications]
        }));
        let serialized = serde_json::to_vec(&serde_json::json!({
            "event": "audioSources",
            "protocolVersion": 1,
            "requestId": "audio-list",
            "revision": snapshot.revision,
            "inputs": snapshot.inputs,
            "outputs": snapshot.outputs,
            "inputsTruncated": snapshot.inputs_truncated,
            "outputsTruncated": snapshot.outputs_truncated,
        }))
        .unwrap();
        assert!(serialized.len() < 64 * 1024);
    }
}
