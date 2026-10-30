use napi::{Error, Result, Status};
use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
use windows::Win32::Foundation::RPC_E_CHANGED_MODE;
use windows::Win32::Media::Audio::{
    DEVICE_STATE_ACTIVE, IMMDeviceEnumerator, MMDeviceEnumerator, eCapture,
};
use windows::Win32::System::Com::StructuredStorage::PropVariantClear;
use windows::Win32::System::Com::{
    CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoTaskMemFree,
    CoUninitialize, STGM_READ,
};
use windows::Win32::System::Variant::VT_LPWSTR;

#[napi_derive::napi(object)]
pub struct MicrophoneDevice {
    pub id: String,
    pub label: String,
}

struct Apartment(bool);
impl Drop for Apartment {
    fn drop(&mut self) {
        if self.0 {
            unsafe { CoUninitialize() };
        }
    }
}

// 只枚举端点元数据，不激活录音客户端；COM 与返回的字符串在本次调用中释放。
#[napi_derive::napi]
pub fn list_microphone_devices() -> Result<Vec<MicrophoneDevice>> {
    unsafe { enumerate() }
        .map_err(|_| Error::new(Status::GenericFailure, "audioDeviceEnumerationFailed"))
}

unsafe fn enumerate() -> windows::core::Result<Vec<MicrophoneDevice>> {
    unsafe {
        let initialized = CoInitializeEx(None, COINIT_MULTITHREADED);
        if initialized.is_err() && initialized != RPC_E_CHANGED_MODE {
            initialized.ok()?;
        }
        let _apartment = Apartment(initialized.is_ok());
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let collection = enumerator.EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE)?;
        let mut devices = Vec::new();
        for index in 0..collection.GetCount()? {
            let device = collection.Item(index)?;
            let id = device.GetId()?;
            let identifier = id.to_string();
            CoTaskMemFree(Some(id.0.cast()));
            let identifier = identifier?;
            let properties = device.OpenPropertyStore(STGM_READ)?;
            let mut name = properties.GetValue(&PKEY_Device_FriendlyName)?;
            let label = if name.Anonymous.Anonymous.vt == VT_LPWSTR {
                name.Anonymous
                    .Anonymous
                    .Anonymous
                    .pwszVal
                    .to_string()
                    .map_err(Into::into)
            } else {
                Err(windows::core::Error::from_hresult(
                    windows::Win32::Foundation::E_UNEXPECTED,
                ))
            };
            PropVariantClear(&mut name)?;
            devices.push(MicrophoneDevice {
                id: identifier,
                label: label?,
            });
        }
        Ok(devices)
    }
}
