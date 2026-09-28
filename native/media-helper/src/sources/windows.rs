use super::{CaptureTarget, DiscoveredSource, MAX_VIDEO_SOURCES, clean_title};
use crate::protocol::{Capability, ErrorCode, VideoSource, VideoSourceKind};
use windows::Graphics::Capture::{GraphicsCaptureItem, GraphicsCaptureSession};
use windows::Win32::Foundation::{HWND, LPARAM, RECT};
use windows::Win32::Graphics::Dwm::{DWMWA_CLOAKED, DwmGetWindowAttribute};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORENUMPROC, MONITORINFOEXW,
};
use windows::Win32::System::Threading::GetCurrentProcessId;
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize, RoUninitialize};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, IsIconic,
    IsWindow, IsWindowVisible, MONITORINFOF_PRIMARY, WNDENUMPROC,
};
use windows::core::{BOOL, factory};

pub(super) use windows::Win32::Foundation::HWND as NativeHwnd;
pub(super) use windows::Win32::Graphics::Gdi::HMONITOR as NativeHmonitor;

const MAX_CALLBACK_SOURCES: usize = MAX_VIDEO_SOURCES;

pub(super) struct WindowsDiscovery {
    interop: IGraphicsCaptureItemInterop,
    _apartment: WinRtApartment,
    supported: bool,
}

impl WindowsDiscovery {
    pub(super) fn new() -> Result<Self, ErrorCode> {
        let apartment = initialize_winrt()?;
        let interop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()
            .map_err(|_| ErrorCode::SourceDiscoveryFailed)?;
        let supported =
            GraphicsCaptureSession::IsSupported().map_err(|_| ErrorCode::SourceDiscoveryFailed)?;
        Ok(Self {
            interop,
            _apartment: apartment,
            supported,
        })
    }

    pub(super) fn capability(&self) -> Capability {
        Capability {
            available: self.supported,
            reason: if self.supported {
                "available"
            } else {
                "wgcUnavailable"
            },
        }
    }

    pub(super) fn discover(&self) -> Result<Vec<DiscoveredSource>, ErrorCode> {
        if !self.supported {
            return Err(ErrorCode::SourceDiscoveryFailed);
        }
        let mut context = DiscoveryContext {
            sources: Vec::new(),
            interop: &self.interop,
        };
        let context_pointer = &mut context as *mut DiscoveryContext<'_>;
        let monitors: MONITORENUMPROC = Some(enumerate_monitor);
        unsafe {
            if !EnumDisplayMonitors(None, None, monitors, LPARAM(context_pointer as isize))
                .as_bool()
            {
                return Err(ErrorCode::SourceDiscoveryFailed);
            }
        }
        let windows: WNDENUMPROC = Some(enumerate_window);
        unsafe {
            EnumWindows(windows, LPARAM(context_pointer as isize))
                .map_err(|_| ErrorCode::SourceDiscoveryFailed)?;
        }
        Ok(context.sources)
    }

    pub(super) fn target_is_valid(&self, target: CaptureTarget) -> bool {
        if !self.supported {
            return false;
        }
        match target {
            CaptureTarget::Window(window) => {
                if !unsafe { IsWindow(Some(window)) }.as_bool() {
                    return false;
                }
                unsafe { self.interop.CreateForWindow::<GraphicsCaptureItem>(window) }.is_ok()
            }
            CaptureTarget::Monitor(monitor) => {
                if !is_live_monitor(monitor) {
                    return false;
                }
                unsafe {
                    self.interop
                        .CreateForMonitor::<GraphicsCaptureItem>(monitor)
                }
                .is_ok()
            }
            #[cfg(test)]
            CaptureTarget::Test => false,
        }
    }
}

struct WinRtApartment;
impl Drop for WinRtApartment {
    fn drop(&mut self) {
        unsafe { RoUninitialize() };
    }
}
fn initialize_winrt() -> Result<WinRtApartment, ErrorCode> {
    unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.map_err(|_| ErrorCode::SourceDiscoveryFailed)?;
    Ok(WinRtApartment)
}

struct DiscoveryContext<'a> {
    sources: Vec<DiscoveredSource>,
    interop: &'a IGraphicsCaptureItemInterop,
}

unsafe extern "system" fn enumerate_monitor(
    monitor: HMONITOR,
    _device_context: HDC,
    _monitor_rect: *mut RECT,
    parameter: LPARAM,
) -> BOOL {
    let context = unsafe { &mut *(parameter.0 as *mut DiscoveryContext<'_>) };
    if context.sources.len() >= MAX_CALLBACK_SOURCES {
        return BOOL(1);
    }
    let mut info = MONITORINFOEXW::default();
    info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
    if !unsafe { GetMonitorInfoW(monitor, &mut info.monitorInfo) }.as_bool() {
        return BOOL(1);
    }
    let Ok(item) = (unsafe {
        context
            .interop
            .CreateForMonitor::<GraphicsCaptureItem>(monitor)
    }) else {
        return BOOL(1);
    };
    drop(item);
    let width = info
        .monitorInfo
        .rcMonitor
        .right
        .saturating_sub(info.monitorInfo.rcMonitor.left);
    let height = info
        .monitorInfo
        .rcMonitor
        .bottom
        .saturating_sub(info.monitorInfo.rcMonitor.top);
    if width <= 0 || height <= 0 {
        return BOOL(1);
    }
    let device_name = String::from_utf16_lossy(&info.szDevice);
    context.sources.push(DiscoveredSource {
        source: VideoSource {
            source_id: String::new(),
            kind: VideoSourceKind::Monitor,
            title: clean_title(device_name.trim_end_matches('\0')),
            width: width as u32,
            height: height as u32,
            primary: info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY != 0,
        },
        target: CaptureTarget::Monitor(monitor),
    });
    BOOL(1)
}

unsafe extern "system" fn enumerate_window(window: HWND, parameter: LPARAM) -> BOOL {
    let context = unsafe { &mut *(parameter.0 as *mut DiscoveryContext<'_>) };
    if context.sources.len() >= MAX_CALLBACK_SOURCES {
        return BOOL(1);
    }
    if !unsafe { IsWindowVisible(window) }.as_bool() || unsafe { IsIconic(window) }.as_bool() {
        return BOOL(1);
    }
    let mut process_id = 0;
    unsafe { GetWindowThreadProcessId(window, Some(&mut process_id)) };
    if process_id == unsafe { GetCurrentProcessId() }
        || is_shell_window(window)
        || is_cloaked(window)
    {
        return BOOL(1);
    }
    let mut title_buffer = [0u16; 1024];
    let title_length = unsafe { GetWindowTextW(window, &mut title_buffer) };
    if title_length <= 0 {
        return BOOL(1);
    }
    let title = clean_title(&String::from_utf16_lossy(
        &title_buffer[..title_length as usize],
    ));
    if title.is_empty() {
        return BOOL(1);
    }
    let mut rect = RECT::default();
    if unsafe { GetWindowRect(window, &mut rect) }.is_err() {
        return BOOL(1);
    }
    let width = rect.right.saturating_sub(rect.left);
    let height = rect.bottom.saturating_sub(rect.top);
    if width <= 0 || height <= 0 {
        return BOOL(1);
    }
    let Ok(item) = (unsafe {
        context
            .interop
            .CreateForWindow::<GraphicsCaptureItem>(window)
    }) else {
        return BOOL(1);
    };
    drop(item);
    context.sources.push(DiscoveredSource {
        source: VideoSource {
            source_id: String::new(),
            kind: VideoSourceKind::Window,
            title,
            width: width as u32,
            height: height as u32,
            primary: false,
        },
        target: CaptureTarget::Window(window),
    });
    BOOL(1)
}

struct MonitorCheck {
    target: HMONITOR,
    found: bool,
}
fn is_live_monitor(target: HMONITOR) -> bool {
    let mut context = MonitorCheck {
        target,
        found: false,
    };
    let callback: MONITORENUMPROC = Some(find_monitor);
    unsafe {
        EnumDisplayMonitors(
            None,
            None,
            callback,
            LPARAM(&mut context as *mut _ as isize),
        )
        .as_bool()
            && context.found
    }
}
unsafe extern "system" fn find_monitor(
    monitor: HMONITOR,
    _device_context: HDC,
    _monitor_rect: *mut RECT,
    parameter: LPARAM,
) -> BOOL {
    let context = unsafe { &mut *(parameter.0 as *mut MonitorCheck) };
    if monitor == context.target {
        context.found = true;
        return BOOL(1);
    }
    BOOL(1)
}

fn is_shell_window(window: HWND) -> bool {
    let mut class_name = [0u16; 256];
    let length = unsafe { GetClassNameW(window, &mut class_name) };
    if length <= 0 {
        return false;
    }
    matches!(
        String::from_utf16_lossy(&class_name[..length as usize]).as_str(),
        "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd"
    )
}
fn is_cloaked(window: HWND) -> bool {
    let mut cloaked = 0u32;
    unsafe {
        DwmGetWindowAttribute(
            window,
            DWMWA_CLOAKED,
            &mut cloaked as *mut u32 as *mut _,
            std::mem::size_of_val(&cloaked) as u32,
        )
    }
    .map(|_| cloaked != 0)
    .unwrap_or(true)
}
