use napi::bindgen_prelude::Buffer;
use napi::{Error, Result, Status};
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Threading::GetCurrentProcessId;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    HOT_KEY_MODIFIERS, MOD_NOREPEAT, RegisterHotKey, UnregisterHotKey,
};
use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

fn owned_window(handle: &Buffer, id: u32) -> Result<HWND> {
    if handle.len() != 8 || !matches!(id, 0x4c01 | 0x4c02) {
        return Err(Error::new(Status::InvalidArg, "audioShortcutInvalid"));
    }
    let address = u64::from_le_bytes(handle.as_ref().try_into().unwrap()) as usize;
    let window = HWND(address as *mut _);
    let mut process_id = 0;
    // HWND 仅来自主进程持有的 BrowserWindow；拒绝跨进程窗口。
    unsafe { GetWindowThreadProcessId(window, Some(&mut process_id)) };
    if address == 0 || process_id != unsafe { GetCurrentProcessId() } {
        return Err(Error::new(Status::InvalidArg, "audioShortcutWindowInvalid"));
    }
    Ok(window)
}

#[napi_derive::napi]
pub fn register_audio_hotkey(handle: Buffer, id: u32, modifiers: u32, key: u32) -> Result<()> {
    let window = owned_window(&handle, id)?;
    let function_key = (0x70..=0x7a).contains(&key);
    let character_key = (0x30..=0x39).contains(&key) || (0x41..=0x5a).contains(&key);
    if modifiers > 7 || (!function_key && (!character_key || modifiers & 3 == 0)) {
        return Err(Error::new(Status::InvalidArg, "audioShortcutInvalid"));
    }
    // 与窗口消息循环在同一主线程注册；NOREPEAT 保证长按只触发一次。
    unsafe {
        RegisterHotKey(
            Some(window),
            id as i32,
            HOT_KEY_MODIFIERS(modifiers) | MOD_NOREPEAT,
            key,
        )
    }
    .map_err(|_| Error::new(Status::GenericFailure, "audioShortcutUnavailable"))
}

#[napi_derive::napi]
pub fn unregister_audio_hotkey(handle: Buffer, id: u32) -> Result<()> {
    let window = owned_window(&handle, id)?;
    unsafe { UnregisterHotKey(Some(window), id as i32) }
        .map_err(|_| Error::new(Status::GenericFailure, "audioShortcutReleaseFailed"))
}
