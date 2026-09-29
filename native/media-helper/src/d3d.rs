use crate::protocol::ErrorCode;
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_0};
use windows::Win32::Graphics::Direct3D11::{
    D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_SDK_VERSION, D3D11CreateDevice, ID3D11Device,
    ID3D11DeviceContext,
};
use windows::Win32::Graphics::Dxgi::{IDXGIAdapter, IDXGIDevice};
use windows::Win32::System::WinRT::Direct3D11::CreateDirect3D11DeviceFromDXGIDevice;
use windows::Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize, RoUninitialize};
use windows::core::{IInspectable, Interface};

pub(super) struct HardwareD3dDevice {
    pub(super) winrt_device: IDirect3DDevice,
    _context: ID3D11DeviceContext,
    _device: ID3D11Device,
}

impl HardwareD3dDevice {
    pub(super) fn create() -> Result<Self, ErrorCode> {
        let mut device = None;
        let mut context = None;
        let mut feature_level = D3D_FEATURE_LEVEL_11_0;
        unsafe {
            D3D11CreateDevice(
                None::<&IDXGIAdapter>,
                D3D_DRIVER_TYPE_HARDWARE,
                Default::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                Some(&[D3D_FEATURE_LEVEL_11_0]),
                D3D11_SDK_VERSION,
                Some(&mut device),
                Some(&mut feature_level),
                Some(&mut context),
            )
        }
        .map_err(|_| ErrorCode::HardwareD3dUnavailable)?;
        let device = device.ok_or(ErrorCode::HardwareD3dUnavailable)?;
        let context = context.ok_or(ErrorCode::HardwareD3dUnavailable)?;
        let dxgi_device = device
            .cast::<IDXGIDevice>()
            .map_err(|_| ErrorCode::HardwareD3dUnavailable)?;
        let inspectable: IInspectable = unsafe {
            CreateDirect3D11DeviceFromDXGIDevice(&dxgi_device)
                .map_err(|_| ErrorCode::HardwareD3dUnavailable)?
        };
        let winrt_device = inspectable
            .cast::<IDirect3DDevice>()
            .map_err(|_| ErrorCode::HardwareD3dUnavailable)?;
        Ok(Self {
            winrt_device,
            _context: context,
            _device: device,
        })
    }
}

struct WinRtApartment;

impl WinRtApartment {
    fn initialize() -> Result<Self, ErrorCode> {
        unsafe { RoInitialize(RO_INIT_MULTITHREADED) }
            .map_err(|_| ErrorCode::HardwareD3dUnavailable)?;
        Ok(Self)
    }
}

impl Drop for WinRtApartment {
    fn drop(&mut self) {
        unsafe { RoUninitialize() };
    }
}

pub(super) fn probe_hardware_device() -> Result<(), ErrorCode> {
    std::thread::Builder::new()
        .name("media-d3d-probe".to_owned())
        .spawn(|| {
            let _apartment = WinRtApartment::initialize()?;
            let device = HardwareD3dDevice::create()?;
            drop(device);
            Ok(())
        })
        .map_err(|_| ErrorCode::HardwareD3dUnavailable)?
        .join()
        .map_err(|_| ErrorCode::HardwareD3dUnavailable)?
}
