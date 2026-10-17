use crate::detection::WindowSnapshot;
use std::collections::HashSet;

#[cfg(target_os = "windows")]
pub fn snapshot(wanted_pids: &HashSet<u32>) -> Result<Vec<WindowSnapshot>, String> {
    use windows::Win32::Foundation::{HWND, LPARAM, RECT};
    use windows::Win32::Graphics::Dwm::{DWMWA_CLOAKED, DwmGetWindowAttribute};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GWL_EXSTYLE, GetClassNameW, GetWindowLongPtrW, GetWindowRect, GetWindowTextW,
        GetWindowThreadProcessId, IsIconic, IsWindowVisible,
    };
    use windows::core::BOOL;
    struct Enumeration<'a> {
        wanted_pids: &'a HashSet<u32>,
        windows: Vec<WindowSnapshot>,
    }
    unsafe extern "system" fn collect(window: HWND, parameter: LPARAM) -> BOOL {
        let mut pid = 0;
        let mut title = [0_u16; 512];
        // EnumWindows 同步调用，参数只在本次枚举期间指向栈上的窗口列表。
        unsafe {
            GetWindowThreadProcessId(window, Some(&mut pid));
            let enumeration = &mut *(parameter.0 as *mut Enumeration<'_>);
            if !enumeration.wanted_pids.contains(&pid) {
                return BOOL(1);
            }
            let mut class_name = [0_u16; 256];
            let class_length = GetClassNameW(window, &mut class_name);
            let mut cloaked = 0_u32;
            let cloak_known = DwmGetWindowAttribute(
                window,
                DWMWA_CLOAKED,
                &mut cloaked as *mut u32 as *mut _,
                std::mem::size_of_val(&cloaked) as u32,
            )
            .is_ok();
            let visible = IsWindowVisible(window).as_bool()
                && is_application_window(
                    GetWindowLongPtrW(window, GWL_EXSTYLE),
                    &String::from_utf16_lossy(&class_name[..class_length as usize]),
                );
            let mut bounds = RECT::default();
            // 与共享选择器采用相同的有效窗口原则；已登记游戏最小化后仍保留 visible。
            let selectable = visible
                && cloak_known
                && cloaked == 0
                && !IsIconic(window).as_bool()
                && GetWindowRect(window, &mut bounds).is_ok()
                && bounds.right - bounds.left > 1
                && bounds.bottom - bounds.top > 1;
            let length = GetWindowTextW(window, &mut title);
            if pid != 0 {
                enumeration.windows.push(WindowSnapshot {
                    pid,
                    title: String::from_utf16_lossy(&title[..length as usize]),
                    visible,
                    selectable,
                });
            }
        }
        BOOL(1)
    }
    let mut enumeration = Enumeration {
        wanted_pids,
        windows: Vec::new(),
    };
    unsafe {
        EnumWindows(
            Some(collect),
            LPARAM(&mut enumeration as *mut Enumeration<'_> as isize),
        )
        .map_err(|_| "window enumeration failed".to_owned())?;
    }
    Ok(enumeration.windows)
}

#[cfg(target_os = "windows")]
fn is_application_window(extended_style: isize, class_name: &str) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW};
    extended_style & (WS_EX_TOOLWINDOW.0 as isize | WS_EX_NOACTIVATE.0 as isize) == 0
        && !matches!(
            class_name,
            "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd"
        )
}

#[cfg(not(target_os = "windows"))]
pub fn snapshot(_wanted_pids: &HashSet<u32>) -> Result<Vec<WindowSnapshot>, String> {
    Err("activity detection is only available on Windows".to_owned())
}

#[cfg(target_os = "windows")]
pub fn steam_directory() -> Option<std::path::PathBuf> {
    use windows::Win32::System::Registry::{HKEY_CURRENT_USER, RRF_RT_REG_SZ, RegGetValueW};
    let mut buffer = [0_u16; 1024];
    let mut size = std::mem::size_of_val(&buffer) as u32;
    // 只读取 Steam 自身安装位置，不枚举注册表或修改系统配置。
    unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            windows::core::w!("Software\\Valve\\Steam"),
            windows::core::w!("SteamPath"),
            RRF_RT_REG_SZ,
            None,
            Some(buffer.as_mut_ptr().cast()),
            Some(&mut size),
        )
        .ok()
        .ok()?;
    }
    let length = buffer.iter().position(|value| *value == 0)?;
    (length > 0).then(|| std::path::PathBuf::from(String::from_utf16_lossy(&buffer[..length])))
}

#[cfg(not(target_os = "windows"))]
pub fn steam_directory() -> Option<std::path::PathBuf> {
    None
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::is_application_window;
    use windows::Win32::UI::WindowsAndMessaging::{WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW};

    #[test]
    fn picker_excludes_tool_desktop_and_shell_windows() {
        assert!(is_application_window(0, "Chrome_WidgetWin_1"));
        assert!(!is_application_window(
            WS_EX_TOOLWINDOW.0 as isize,
            "Overlay"
        ));
        assert!(!is_application_window(
            WS_EX_NOACTIVATE.0 as isize,
            "InputWindow"
        ));
        assert!(!is_application_window(0, "WorkerW"));
        assert!(!is_application_window(0, "Shell_TrayWnd"));
    }
}
