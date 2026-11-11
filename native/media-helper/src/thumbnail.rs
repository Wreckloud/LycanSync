//! 单次窗口预览在独立进程中执行；PrintWindow 不可取消，由父进程限时回收。
use serde::Deserialize;
use std::io::{Read, Write};
use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE, HWND, RECT, WAIT_TIMEOUT};
use windows::Win32::Graphics::Gdi::{
    BI_RGB, BITMAPINFO, BITMAPINFOHEADER, CreateCompatibleDC, CreateDIBSection, DIB_RGB_COLORS,
    DeleteDC, DeleteObject, GdiFlush, HALFTONE, HBITMAP, HDC, HGDIOBJ, SRCCOPY, SelectObject,
    SetStretchBltMode, StretchBlt,
};
use windows::Win32::Storage::Xps::{PRINT_WINDOW_FLAGS, PrintWindow};
use windows::Win32::System::Threading::{
    GetProcessTimes, OpenEventW, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    SYNCHRONIZATION_SYNCHRONIZE, WaitForSingleObject,
};
use windows::Win32::UI::HiDpi::{
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetThreadDpiAwarenessContext,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowRect, GetWindowThreadProcessId, IsIconic, IsWindow,
};
use windows::core::PCWSTR;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Target {
    window_id: String,
    lifetime_name: String,
    process_id: u32,
    process_creation_time: String,
}

struct OwnedHandle(HANDLE);
impl Drop for OwnedHandle {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.0) };
    }
}

struct Bitmap {
    dc: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
    bits: *mut u8,
    width: i32,
    height: i32,
}
impl Bitmap {
    fn new(width: i32, height: i32) -> Result<Self, &'static str> {
        let dc = unsafe { CreateCompatibleDC(None) };
        if dc.is_invalid() {
            return Err("thumbnailBitmapFailed");
        }
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits = std::ptr::null_mut();
        let bitmap = match unsafe {
            CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0)
        } {
            Ok(bitmap) => bitmap,
            Err(_) => {
                let _ = unsafe { DeleteDC(dc) };
                return Err("thumbnailBitmapFailed");
            }
        };
        let previous = unsafe { SelectObject(dc, bitmap.into()) };
        if previous.is_invalid() || previous.0 as isize == -1 || bits.is_null() {
            unsafe {
                let _ = DeleteObject(bitmap.into());
                let _ = DeleteDC(dc);
            }
            return Err("thumbnailBitmapFailed");
        }
        Ok(Self {
            dc,
            bitmap,
            previous,
            bits: bits.cast(),
            width,
            height,
        })
    }
}
impl Drop for Bitmap {
    fn drop(&mut self) {
        unsafe {
            SelectObject(self.dc, self.previous);
            let _ = DeleteObject(self.bitmap.into());
            let _ = DeleteDC(self.dc);
        }
    }
}

pub fn run() -> Result<(), &'static str> {
    let mut input = String::new();
    std::io::stdin()
        .take(4097)
        .read_to_string(&mut input)
        .map_err(|_| "thumbnailTargetInvalid")?;
    if input.len() > 4096 {
        return Err("thumbnailTargetInvalid");
    }
    let target: Target = serde_json::from_str(&input).map_err(|_| "thumbnailTargetInvalid")?;
    let window_value: usize = target
        .window_id
        .parse()
        .map_err(|_| "thumbnailTargetInvalid")?;
    let creation: u64 = target
        .process_creation_time
        .parse()
        .map_err(|_| "thumbnailTargetInvalid")?;
    if window_value == 0
        || creation == 0
        || target.process_id == 0
        || !target
            .lifetime_name
            .starts_with("Local\\LycanSync.WindowLifetime.")
        || !target
            .lifetime_name
            .ends_with(&format!(".{}", target.window_id))
    {
        return Err("thumbnailTargetInvalid");
    }
    let window = HWND(window_value as *mut _);
    let lifetime_name: Vec<u16> = target.lifetime_name.encode_utf16().chain(Some(0)).collect();
    let lifetime = OwnedHandle(
        unsafe {
            OpenEventW(
                SYNCHRONIZATION_SYNCHRONIZE,
                false,
                PCWSTR(lifetime_name.as_ptr()),
            )
        }
        .map_err(|_| "thumbnailSourceExpired")?,
    );
    let process = OwnedHandle(
        unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, target.process_id) }
            .map_err(|_| "thumbnailSourceExpired")?,
    );
    let matches = || {
        let mut pid = 0;
        let mut created = FILETIME::default();
        let mut exited = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        unsafe {
            GetWindowThreadProcessId(window, Some(&mut pid));
            IsWindow(Some(window)).as_bool()
                && pid == target.process_id
                && WaitForSingleObject(lifetime.0, 0) == WAIT_TIMEOUT
                && GetProcessTimes(process.0, &mut created, &mut exited, &mut kernel, &mut user)
                    .is_ok()
                && ((created.dwHighDateTime as u64) << 32 | created.dwLowDateTime as u64)
                    == creation
        }
    };
    if !matches() || unsafe { IsIconic(window) }.as_bool() {
        return Err("thumbnailSourceExpired");
    }
    // 仅此短生命周期进程使用像素坐标；不能读取桌面背景替代目标窗口内容。
    unsafe {
        SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    let mut rect = RECT::default();
    unsafe { GetWindowRect(window, &mut rect) }.map_err(|_| "thumbnailSourceExpired")?;
    let width = rect.right.saturating_sub(rect.left);
    let height = rect.bottom.saturating_sub(rect.top);
    if width < 2 || height < 2 || i64::from(width) * i64::from(height) > 16_777_216 {
        return Err("thumbnailSizeUnsupported");
    }
    let source = Bitmap::new(width, height)?;
    unsafe {
        std::ptr::write_bytes(source.bits, 0, (width * height * 4) as usize);
    }
    // 与 Chromium 的普通窗口预览相同，仅请求应用绘制；不钩取游戏或启动持续采集。
    if !unsafe { PrintWindow(window, source.dc, PRINT_WINDOW_FLAGS(2)) }.as_bool() {
        return Err("thumbnailCaptureFailed");
    }
    if !matches() {
        return Err("thumbnailSourceExpired");
    }
    let ratio = (256.0 / f64::from(width))
        .min(144.0 / f64::from(height))
        .min(1.0);
    let preview = Bitmap::new(
        (f64::from(width) * ratio).round().max(1.0) as i32,
        (f64::from(height) * ratio).round().max(1.0) as i32,
    )?;
    unsafe {
        SetStretchBltMode(preview.dc, HALFTONE);
        if !StretchBlt(
            preview.dc,
            0,
            0,
            preview.width,
            preview.height,
            Some(source.dc),
            0,
            0,
            width,
            height,
            SRCCOPY,
        )
        .as_bool()
        {
            return Err("thumbnailCaptureFailed");
        }
        let _ = GdiFlush();
    }
    // DIB 的内存由 preview 持有，写入 stdout 前补齐不透明 alpha；离开作用域再释放。
    let bytes = unsafe {
        std::slice::from_raw_parts_mut(preview.bits, (preview.width * preview.height * 4) as usize)
    };
    for pixel in bytes.chunks_exact_mut(4) {
        pixel[3] = 255;
    }
    if !matches() {
        return Err("thumbnailSourceExpired");
    }
    let mut output = std::io::stdout().lock();
    output
        .write_all(&(preview.width as u32).to_le_bytes())
        .map_err(|_| "thumbnailWriteFailed")?;
    output
        .write_all(&(preview.height as u32).to_le_bytes())
        .map_err(|_| "thumbnailWriteFailed")?;
    output.write_all(bytes).map_err(|_| "thumbnailWriteFailed")
}
