//! Windows 来源发现及窗口身份校验；采集前再次核对身份，防止 HWND 重用指向别的窗口。

use super::{CaptureTarget, DiscoveredSource, MAX_VIDEO_SOURCES, clean_title};
use crate::protocol::{Capability, ErrorCode, VideoSource, VideoSourceKind};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use windows::Graphics::Capture::GraphicsCaptureSession;
use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, INVALID_HANDLE_VALUE, LPARAM, RECT};
use windows::Win32::Graphics::Dwm::{DWMWA_CLOAKED, DwmGetWindowAttribute};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORENUMPROC, MONITORINFOEXW,
};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{
    GetCurrentProcessId, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize, RoUninitialize};
use windows::Win32::UI::HiDpi::{
    DPI_AWARENESS_CONTEXT, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetThreadDpiAwarenessContext,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GCW_ATOM, GWL_EXSTYLE, GWL_STYLE, GetClassLongPtrW, GetClassNameW, GetPropW,
    GetWindowLongPtrW, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindow,
    IsWindowVisible, MONITORINFOF_PRIMARY, RemovePropW, SetPropW, WNDENUMPROC, WS_EX_NOACTIVATE,
    WS_EX_TOOLWINDOW, WS_MAXIMIZE, WS_MINIMIZE,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
};
use windows::core::{BOOL, PCWSTR};

pub(super) use windows::Win32::Foundation::HWND as NativeHwnd;
pub(super) use windows::Win32::Graphics::Gdi::HMONITOR as NativeHmonitor;

pub(crate) fn monitor_and_virtual_bounds(handle: usize) -> Option<(RECT, RECT)> {
    let _dpi_context = ThreadDpiAwarenessContext::per_monitor_v2().ok()?;
    let monitor = HMONITOR(handle as *mut std::ffi::c_void);
    if monitor.is_invalid() {
        return None;
    }
    let mut info = MONITORINFOEXW::default();
    info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
    if !unsafe { GetMonitorInfoW(monitor, &mut info.monitorInfo) }.as_bool() {
        return None;
    }
    let x = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) };
    let y = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) };
    let width = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) };
    let height = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) };
    if width <= 1 || height <= 1 {
        return None;
    }
    Some((
        info.monitorInfo.rcMonitor,
        RECT {
            left: x,
            top: y,
            right: x.saturating_add(width),
            bottom: y.saturating_add(height),
        },
    ))
}

#[derive(Clone, Debug)]
pub(crate) struct WindowIdentity {
    marker: Arc<WindowIdentityMarker>,
    process_id: u32,
    thread_id: u32,
    process_creation_time: u64,
    class_atom: usize,
    class_name: String,
    style: isize,
    extended_style: isize,
}

#[derive(Debug)]
struct WindowIdentityMarker {
    window: HWND,
    property_name: Vec<u16>,
}

// 标记只跨线程调用 User32 属性 API，身份字段创建后不变，因此包装可跨线程共享。
unsafe impl Send for WindowIdentityMarker {}
unsafe impl Sync for WindowIdentityMarker {}

impl Drop for WindowIdentityMarker {
    fn drop(&mut self) {
        let _ = unsafe { RemovePropW(self.window, PCWSTR(self.property_name.as_ptr())) };
    }
}

static NEXT_WINDOW_IDENTITY: AtomicU64 = AtomicU64::new(1);
static WINDOW_PROPERTY_MARKER: u8 = 0;

fn window_property_value() -> HANDLE {
    HANDLE(std::ptr::addr_of!(WINDOW_PROPERTY_MARKER).cast_mut().cast())
}

const MAX_CALLBACK_SOURCES: usize = MAX_VIDEO_SOURCES;

pub(super) struct WindowsDiscovery {
    _apartment: WinRtApartment,
    supported: bool,
    hardware_d3d_available: bool,
    client_process_id: u32,
}

impl WindowsDiscovery {
    pub(super) fn new() -> Result<Self, ErrorCode> {
        let apartment = initialize_winrt()?;
        let supported =
            GraphicsCaptureSession::IsSupported().map_err(|_| ErrorCode::SourceDiscoveryFailed)?;
        let hardware_d3d_available = crate::d3d::probe_hardware_device().is_ok();
        let client_process_id = parent_process_id().ok_or(ErrorCode::SourceDiscoveryFailed)?;
        Ok(Self {
            _apartment: apartment,
            supported,
            hardware_d3d_available,
            client_process_id,
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

    pub(super) fn video_capture_capability(&self) -> Capability {
        let reason = if !self.supported {
            "wgcUnavailable"
        } else if !self.hardware_d3d_available {
            "hardwareD3dUnavailable"
        } else {
            "available"
        };
        Capability {
            available: self.supported && self.hardware_d3d_available,
            reason,
        }
    }

    pub(super) fn discover(&self) -> Result<Vec<DiscoveredSource>, ErrorCode> {
        if !self.supported {
            return Err(ErrorCode::SourceDiscoveryFailed);
        }
        let _dpi_awareness = ThreadDpiAwarenessContext::per_monitor_v2()?;
        let mut context = DiscoveryContext {
            sources: Vec::new(),
            helper_process_id: unsafe { GetCurrentProcessId() },
            client_process_id: self.client_process_id,
        };
        let context_pointer = &mut context as *mut DiscoveryContext;
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

    pub(super) fn target_is_valid(&self, target: &CaptureTarget) -> bool {
        if !self.supported {
            return false;
        }
        match target {
            CaptureTarget::Window(window, identity) => window_matches_identity(*window, identity),
            CaptureTarget::Monitor(monitor) => is_live_monitor(*monitor),
            #[cfg(test)]
            CaptureTarget::Test(_) => false,
        }
    }

    pub(super) fn audio_process_identity(
        &self,
        target: &CaptureTarget,
    ) -> Result<(u32, u64), ErrorCode> {
        match target {
            CaptureTarget::Window(window, identity)
                if window_matches_identity(*window, identity) =>
            {
                let mut process_id = 0;
                unsafe { GetWindowThreadProcessId(*window, Some(&mut process_id)) };
                (process_id != 0 && process_id == identity.process_id)
                    .then_some((process_id, identity.process_creation_time))
                    .ok_or(ErrorCode::ScreenShareAudioTargetUnavailable)
            }
            _ => Err(ErrorCode::ScreenShareAudioTargetUnavailable),
        }
    }
}

struct WinRtApartment;
impl Drop for WinRtApartment {
    fn drop(&mut self) {
        // Discovery 持有 apartment 到所有 WinRT 查询结束后，再平衡初始化引用。
        unsafe { RoUninitialize() };
    }
}

struct ThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT);

impl ThreadDpiAwarenessContext {
    fn per_monitor_v2() -> Result<Self, ErrorCode> {
        let previous =
            unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
        if previous.0.is_null() {
            return Err(ErrorCode::SourceDiscoveryFailed);
        }
        Ok(Self(previous))
    }
}

impl Drop for ThreadDpiAwarenessContext {
    fn drop(&mut self) {
        unsafe { SetThreadDpiAwarenessContext(self.0) };
    }
}

fn initialize_winrt() -> Result<WinRtApartment, ErrorCode> {
    unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.map_err(|_| ErrorCode::SourceDiscoveryFailed)?;
    Ok(WinRtApartment)
}

struct DiscoveryContext {
    sources: Vec<DiscoveredSource>,
    helper_process_id: u32,
    client_process_id: u32,
}

unsafe extern "system" fn enumerate_monitor(
    monitor: HMONITOR,
    _device_context: HDC,
    _monitor_rect: *mut RECT,
    parameter: LPARAM,
) -> BOOL {
    let context = unsafe { &mut *(parameter.0 as *mut DiscoveryContext) };
    if context.sources.len() >= MAX_CALLBACK_SOURCES {
        return BOOL(1);
    }
    let mut info = MONITORINFOEXW::default();
    info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
    if !unsafe { GetMonitorInfoW(monitor, &mut info.monitorInfo) }.as_bool() {
        return BOOL(1);
    }
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
            monitor_origin: Some(crate::protocol::MonitorOrigin {
                x: info.monitorInfo.rcMonitor.left,
                y: info.monitorInfo.rcMonitor.top,
            }),
        },
        target: CaptureTarget::Monitor(monitor),
    });
    BOOL(1)
}

unsafe extern "system" fn enumerate_window(window: HWND, parameter: LPARAM) -> BOOL {
    let context = unsafe { &mut *(parameter.0 as *mut DiscoveryContext) };
    if context.sources.len() >= MAX_CALLBACK_SOURCES {
        return BOOL(1);
    }
    if !unsafe { IsWindowVisible(window) }.as_bool() || unsafe { IsIconic(window) }.as_bool() {
        return BOOL(1);
    }
    let mut process_id = 0;
    unsafe { GetWindowThreadProcessId(window, Some(&mut process_id)) };
    let extended_style = unsafe { GetWindowLongPtrW(window, GWL_EXSTYLE) };
    if should_exclude_window(
        process_id,
        context.helper_process_id,
        context.client_process_id,
    ) || is_helper_window_style(extended_style)
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
    let Some(identity) = window_identity(window) else {
        return BOOL(1);
    };
    let mut rect = RECT::default();
    if unsafe { GetWindowRect(window, &mut rect) }.is_err() {
        return BOOL(1);
    }
    let width = rect.right.saturating_sub(rect.left);
    let height = rect.bottom.saturating_sub(rect.top);
    if width <= 0 || height <= 0 {
        return BOOL(1);
    }
    context.sources.push(DiscoveredSource {
        source: VideoSource {
            source_id: String::new(),
            kind: VideoSourceKind::Window,
            title,
            width: width as u32,
            height: height as u32,
            primary: false,
            monitor_origin: None,
        },
        target: CaptureTarget::Window(window, identity),
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

pub(crate) fn window_identity(window: HWND) -> Option<WindowIdentity> {
    let fingerprint = read_window_fingerprint(window)?;
    let property = format!(
        "LycanSync.MediaHelper.Window.{}.{}.{}",
        unsafe { GetCurrentProcessId() },
        fingerprint.process_creation_time,
        NEXT_WINDOW_IDENTITY.fetch_add(1, Ordering::Relaxed)
    );
    let mut property_name = property.encode_utf16().collect::<Vec<_>>();
    property_name.push(0);
    let marker = Arc::new(WindowIdentityMarker {
        window,
        property_name,
    });
    if unsafe {
        SetPropW(
            window,
            PCWSTR(marker.property_name.as_ptr()),
            Some(window_property_value()),
        )
    }
    .is_err()
    {
        return None;
    }
    Some(WindowIdentity {
        marker,
        process_id: fingerprint.process_id,
        thread_id: fingerprint.thread_id,
        process_creation_time: fingerprint.process_creation_time,
        class_atom: fingerprint.class_atom,
        class_name: fingerprint.class_name,
        style: stable_window_style(fingerprint.style),
        extended_style: fingerprint.extended_style,
    })
}

pub(crate) fn window_matches_identity(window: HWND, identity: &WindowIdentity) -> bool {
    if !unsafe { IsWindow(Some(window)) }.as_bool()
        || unsafe { GetPropW(window, PCWSTR(identity.marker.property_name.as_ptr())) }
            != window_property_value()
    {
        return false;
    }
    read_window_fingerprint(window).is_some_and(|current| {
        current.process_id == identity.process_id
            && current.thread_id == identity.thread_id
            && current.process_creation_time == identity.process_creation_time
            && current.class_atom == identity.class_atom
            && current.class_name == identity.class_name
            && stable_window_style(current.style) == identity.style
            && current.extended_style == identity.extended_style
    })
}

fn stable_window_style(style: isize) -> isize {
    style & !(WS_MINIMIZE.0 as isize | WS_MAXIMIZE.0 as isize)
}

fn should_exclude_window(process_id: u32, helper_process_id: u32, client_process_id: u32) -> bool {
    process_id == helper_process_id || process_id == client_process_id
}

fn is_helper_window_style(extended_style: isize) -> bool {
    let helper_style_bits = WS_EX_TOOLWINDOW.0 as isize | WS_EX_NOACTIVATE.0 as isize;
    extended_style & helper_style_bits != 0
}

fn parent_process_id() -> Option<u32> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }.ok()?;
    if snapshot == INVALID_HANDLE_VALUE {
        return None;
    }
    struct Snapshot(HANDLE);
    impl Drop for Snapshot {
        fn drop(&mut self) {
            let _ = unsafe { CloseHandle(self.0) };
        }
    }
    let _snapshot = Snapshot(snapshot);
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let helper_process_id = unsafe { GetCurrentProcessId() };
    if unsafe { Process32FirstW(snapshot, &mut entry) }.is_err() {
        return None;
    }
    loop {
        if entry.th32ProcessID == helper_process_id {
            return (entry.th32ParentProcessID != 0).then_some(entry.th32ParentProcessID);
        }
        if unsafe { Process32NextW(snapshot, &mut entry) }.is_err() {
            return None;
        }
    }
}

pub(crate) fn window_is_minimized(window: HWND) -> bool {
    unsafe { IsWindow(Some(window)).as_bool() && IsIconic(window).as_bool() }
}

struct WindowFingerprint {
    process_id: u32,
    thread_id: u32,
    process_creation_time: u64,
    class_atom: usize,
    class_name: String,
    style: isize,
    extended_style: isize,
}

fn read_window_fingerprint(window: HWND) -> Option<WindowFingerprint> {
    if !unsafe { IsWindow(Some(window)) }.as_bool() {
        return None;
    }
    let mut process_id = 0;
    let thread_id = unsafe { GetWindowThreadProcessId(window, Some(&mut process_id)) };
    if process_id == 0 || thread_id == 0 {
        return None;
    }
    let process =
        unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id) }.ok()?;
    let mut creation = Default::default();
    let mut exit = Default::default();
    let mut kernel = Default::default();
    let mut user = Default::default();
    let process_time_ok =
        unsafe { GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user) }
            .is_ok();
    unsafe { windows::Win32::Foundation::CloseHandle(process) }.ok()?;
    if !process_time_ok {
        return None;
    }

    let mut class_buffer = [0u16; 256];
    let class_length = unsafe { GetClassNameW(window, &mut class_buffer) };
    if class_length <= 0 {
        return None;
    }
    Some(WindowFingerprint {
        process_id,
        thread_id,
        process_creation_time: (u64::from(creation.dwHighDateTime) << 32)
            | u64::from(creation.dwLowDateTime),
        class_atom: unsafe { GetClassLongPtrW(window, GCW_ATOM) },
        class_name: String::from_utf16_lossy(&class_buffer[..class_length as usize]),
        style: unsafe { GetWindowLongPtrW(window, GWL_STYLE) },
        extended_style: unsafe { GetWindowLongPtrW(window, GWL_EXSTYLE) },
    })
}

#[cfg(test)]
mod tests {
    use super::{
        WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_MAXIMIZE, WS_MINIMIZE, is_helper_window_style,
        should_exclude_window, stable_window_style,
    };

    #[test]
    fn window_identity_style_ignores_minimize_and_maximize_bits() {
        let base = 0x1000isize;
        let volatile = WS_MINIMIZE.0 as isize | WS_MAXIMIZE.0 as isize;
        assert_eq!(
            stable_window_style(base),
            stable_window_style(base | volatile)
        );
        assert_ne!(
            stable_window_style(base),
            stable_window_style(base | 0x0004_0000)
        );
    }

    #[test]
    fn excludes_helper_and_parent_client_windows_without_title_matching() {
        assert!(should_exclude_window(20, 10, 20));
        assert!(should_exclude_window(10, 10, 20));
        assert!(!should_exclude_window(30, 10, 20));
    }

    #[test]
    fn classifies_tool_and_non_activatable_windows_as_helpers() {
        assert!(is_helper_window_style(WS_EX_TOOLWINDOW.0 as isize));
        assert!(is_helper_window_style(WS_EX_NOACTIVATE.0 as isize));
        assert!(!is_helper_window_style(0));
        // 分层和置顶样式本身不用于判定窗口是否为辅助窗口。
        assert!(!is_helper_window_style(0x0008_0000 | 0x0000_0008));
    }
}
