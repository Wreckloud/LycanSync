use super::{DiscoveredAudioSource, DiscoveredAudioSources, MAX_AUDIO_SOURCES};
use crate::protocol::{AudioDefaultRole, AudioSource, AudioSourceKind, ErrorCode};
use std::ffi::c_void;
use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
use windows::Win32::Foundation::ERROR_NOT_FOUND;
use windows::Win32::Media::Audio::{
    DEVICE_STATE_ACTIVE, EDataFlow, IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator, eCapture,
    eCommunications, eConsole, eMultimedia, eRender,
};
use windows::Win32::System::Com::StructuredStorage::{PropVariantClear, PropVariantToStringAlloc};
use windows::Win32::System::Com::{
    CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoTaskMemFree,
    CoUninitialize, STGM_READ,
};
use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
use windows::core::{HRESULT, PWSTR};

const NO_DEFAULT_DEVICE: HRESULT = ERROR_NOT_FOUND.to_hresult();
const AUDIO_ENDPOINTS_PER_KIND: usize = MAX_AUDIO_SOURCES / 2;

struct ComApartment;

impl ComApartment {
    fn initialize() -> Result<Self, ErrorCode> {
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
            .ok()
            .map_err(|_| ErrorCode::AudioSourceDiscoveryFailed)?;
        Ok(Self)
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

pub(super) fn discover() -> Result<DiscoveredAudioSources, ErrorCode> {
    let _apartment = ComApartment::initialize()?;
    let enumerator: IMMDeviceEnumerator = unsafe {
        CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
            .map_err(|_| ErrorCode::AudioSourceDiscoveryFailed)?
    };
    let (inputs, inputs_truncated) = enumerate_flow(&enumerator, eCapture, AudioSourceKind::Input)?;
    let (outputs, outputs_truncated) =
        enumerate_flow(&enumerator, eRender, AudioSourceKind::Output)?;
    let mut sources = Vec::with_capacity(inputs.len() + outputs.len());
    sources.extend(inputs);
    sources.extend(outputs);
    Ok(DiscoveredAudioSources {
        sources,
        inputs_truncated,
        outputs_truncated,
    })
}

fn enumerate_flow(
    enumerator: &IMMDeviceEnumerator,
    flow: EDataFlow,
    kind: AudioSourceKind,
) -> Result<(Vec<DiscoveredAudioSource>, bool), ErrorCode> {
    let defaults = default_endpoint_ids(enumerator, flow)?;
    let endpoints = unsafe { enumerator.EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE) }
        .map_err(|_| ErrorCode::AudioSourceDiscoveryFailed)?;
    let count =
        unsafe { endpoints.GetCount() }.map_err(|_| ErrorCode::AudioSourceDiscoveryFailed)?;
    let limit = count.min(AUDIO_ENDPOINTS_PER_KIND as u32);
    let mut sources = Vec::with_capacity(limit as usize);
    for index in 0..limit {
        let endpoint =
            unsafe { endpoints.Item(index) }.map_err(|_| ErrorCode::AudioSourceDiscoveryFailed)?;
        let endpoint_id = endpoint_id(&endpoint)?;
        let name = endpoint_name(&endpoint)?;
        let default_roles = defaults
            .iter()
            .filter_map(|(role, default_id)| (default_id == &endpoint_id).then_some(*role))
            .collect();
        sources.push(DiscoveredAudioSource {
            source: AudioSource {
                source_id: String::new(),
                kind,
                name,
                default_roles,
            },
            endpoint_id,
        });
    }
    for (_, default_id) in &defaults {
        if sources
            .iter()
            .any(|source| &source.endpoint_id == default_id)
        {
            continue;
        }
        let endpoint_wide = default_id.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
        let endpoint =
            unsafe { enumerator.GetDevice(windows::core::PCWSTR(endpoint_wide.as_ptr())) }
                .map_err(|_| ErrorCode::AudioSourceDiscoveryFailed)?;
        sources.push(DiscoveredAudioSource {
            source: AudioSource {
                source_id: String::new(),
                kind,
                name: endpoint_name(&endpoint)?,
                default_roles: defaults
                    .iter()
                    .filter_map(|(role, id)| (id == default_id).then_some(*role))
                    .collect(),
            },
            endpoint_id: default_id.clone(),
        });
    }
    Ok((sources, count > limit))
}

fn default_endpoint_ids(
    enumerator: &IMMDeviceEnumerator,
    flow: EDataFlow,
) -> Result<Vec<(AudioDefaultRole, String)>, ErrorCode> {
    let mut defaults = Vec::with_capacity(3);
    for (role, public_role) in [
        (eConsole, AudioDefaultRole::Console),
        (eMultimedia, AudioDefaultRole::Multimedia),
        (eCommunications, AudioDefaultRole::Communications),
    ] {
        match unsafe { enumerator.GetDefaultAudioEndpoint(flow, role) } {
            Ok(endpoint) => defaults.push((public_role, endpoint_id(&endpoint)?)),
            Err(error) if error.code() == NO_DEFAULT_DEVICE => {}
            Err(_) => return Err(ErrorCode::AudioSourceDiscoveryFailed),
        }
    }
    Ok(defaults)
}

fn endpoint_id(endpoint: &IMMDevice) -> Result<String, ErrorCode> {
    let id = unsafe { endpoint.GetId() }.map_err(|_| ErrorCode::AudioSourceDiscoveryFailed)?;
    take_task_string(id)
}

fn endpoint_name(endpoint: &IMMDevice) -> Result<String, ErrorCode> {
    let properties: IPropertyStore = unsafe { endpoint.OpenPropertyStore(STGM_READ) }
        .map_err(|_| ErrorCode::AudioSourceDiscoveryFailed)?;
    let mut value = unsafe { properties.GetValue(&PKEY_Device_FriendlyName) }
        .map_err(|_| ErrorCode::AudioSourceDiscoveryFailed)?;
    let name = unsafe { PropVariantToStringAlloc(&value) }
        .map_err(|_| ErrorCode::AudioSourceDiscoveryFailed)
        .and_then(take_task_string);
    unsafe { PropVariantClear(&mut value) }.map_err(|_| ErrorCode::AudioSourceDiscoveryFailed)?;
    name
}

fn take_task_string(value: PWSTR) -> Result<String, ErrorCode> {
    if value.0.is_null() {
        return Err(ErrorCode::AudioSourceDiscoveryFailed);
    }
    let result = unsafe { value.to_string() }.map_err(|_| ErrorCode::AudioSourceDiscoveryFailed);
    unsafe { CoTaskMemFree(Some(value.0.cast::<c_void>())) };
    result
}
