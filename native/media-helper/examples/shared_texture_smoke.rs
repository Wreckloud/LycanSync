#[cfg(not(target_os = "windows"))]
fn main() {
    eprintln!("sharedTextureSmokeUnsupported");
    std::process::exit(2);
}

#[cfg(target_os = "windows")]
fn main() {
    if let Err(error) = run() {
        eprintln!("sharedTextureSmokeFailed:{error}");
        std::process::exit(1);
    }
}

#[cfg(target_os = "windows")]
fn run() -> Result<(), Box<dyn std::error::Error>> {
    use std::io::{self, BufRead, Write};
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
    use windows::Win32::Graphics::Direct3D::D3D_FEATURE_LEVEL_11_0;
    use windows::Win32::Graphics::Direct3D11::{
        D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
        D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX, D3D11_RESOURCE_MISC_SHARED_NTHANDLE,
        D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT, D3D11CreateDevice,
        ID3D11Device, ID3D11DeviceContext, ID3D11RenderTargetView, ID3D11Texture2D,
    };
    use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
    use windows::Win32::Graphics::Dxgi::{
        DXGI_SHARED_RESOURCE_READ, DXGI_SHARED_RESOURCE_WRITE, IDXGIAdapter, IDXGIKeyedMutex,
        IDXGIResource1,
    };
    use windows::core::{Interface, PCWSTR};

    struct OwnedHandle(HANDLE);
    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            if !self.0.is_invalid() {
                unsafe {
                    let _ = CloseHandle(self.0);
                }
            }
        }
    }

    if std::env::args().any(|arg| arg == "before-description") {
        std::process::exit(86);
    }
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
        .map_err(|_| "hardwareD3dCreationFailed")?;
    }
    let device: ID3D11Device = device.ok_or("D3D11 device unavailable")?;
    let context: ID3D11DeviceContext = context.ok_or("D3D11 context unavailable")?;
    let desc = D3D11_TEXTURE2D_DESC {
        Width: 2,
        Height: 2,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
        CPUAccessFlags: 0,
        MiscFlags: (D3D11_RESOURCE_MISC_SHARED_NTHANDLE.0 | D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX.0)
            as u32,
    };
    let mut texture = None;
    unsafe {
        device
            .CreateTexture2D(&desc, None, Some(&mut texture))
            .map_err(|_| "sharedTextureCreationFailed")?;
    }
    let texture: ID3D11Texture2D = texture.ok_or("shared texture unavailable")?;
    let mutex: IDXGIKeyedMutex = texture
        .cast()
        .map_err(|_| "sharedTextureMutexUnavailable")?;
    unsafe { mutex.AcquireSync(0, 1000) }.map_err(|_| "sharedTextureMutexAcquireFailed")?;
    let mut target = None;
    unsafe {
        device
            .CreateRenderTargetView(&texture, None, Some(&mut target))
            .map_err(|_| "syntheticTextureRenderTargetFailed")?;
    }
    let target: ID3D11RenderTargetView = target.ok_or("render target unavailable")?;
    unsafe {
        context.ClearRenderTargetView(&target, &[0.12, 0.42, 0.78, 1.0]);
        context.Flush();
        mutex
            .ReleaseSync(0)
            .map_err(|_| "sharedTextureMutexReleaseFailed")?;
    }
    let resource: IDXGIResource1 = texture
        .cast()
        .map_err(|_| "sharedTextureInterfaceUnavailable")?;
    let local_shared = unsafe {
        resource
            .CreateSharedHandle(
                None,
                DXGI_SHARED_RESOURCE_READ.0 | DXGI_SHARED_RESOURCE_WRITE.0,
                PCWSTR::null(),
            )
            .map_err(|_| "ntSharedHandleCreationFailed")?
    };
    let local_shared = OwnedHandle(local_shared);
    let handle_hex = format!("{:016x}", local_shared.0.0 as usize);
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(
        &mut stdout,
        &serde_json::json!({
            "event": "sharedTextureSmoke",
            "pixelFormat": "bgra",
            "codedSize": { "width": 2, "height": 2 },
            "sourceHandleHex": handle_hex
        }),
    )?;
    stdout.write_all(b"\n")?;
    stdout.flush()?;

    let mut release = String::new();
    io::stdin().lock().read_line(&mut release)?;
    if release.trim() == "crash" {
        std::process::exit(87);
    }
    if release.trim() != "release" {
        return Err("shared texture release acknowledgement missing".into());
    }
    drop(local_shared);
    // Keep the source texture and its NT handle alive until main acknowledges release.
    drop(target);
    drop(texture);
    drop(context);
    drop(device);
    Ok(())
}
