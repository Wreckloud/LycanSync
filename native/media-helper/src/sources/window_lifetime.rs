//! 在 helper 内观察窗口销毁，通过只读事件通知宿主；不向目标窗口写属性或注入代码。

use crate::protocol::ErrorCode;
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak, mpsc};
use std::thread::{self, JoinHandle};
use windows::Win32::Foundation::{
    CloseHandle, ERROR_ALREADY_EXISTS, GetLastError, HANDLE, HWND, LPARAM, WPARAM,
};
use windows::Win32::System::Threading::{
    CreateEventW, GetCurrentProcess, GetCurrentProcessId, GetCurrentThreadId, GetProcessTimes,
    SetEvent, WaitForSingleObject,
};
use windows::Win32::UI::Accessibility::{HWINEVENTHOOK, SetWinEventHook, UnhookWinEvent};
use windows::Win32::UI::WindowsAndMessaging::{
    EVENT_OBJECT_DESTROY, GetMessageW, MSG, OBJID_WINDOW, PM_NOREMOVE, PeekMessageW,
    PostThreadMessageW, WINEVENT_OUTOFCONTEXT, WM_QUIT,
};
use windows::core::PCWSTR;

type ObservedWindows = Arc<Mutex<HashMap<usize, Vec<Weak<WindowLifetime>>>>>;

thread_local! {
    static OBSERVED: RefCell<Option<ObservedWindows>> = const { RefCell::new(None) };
}

#[derive(Debug)]
pub(super) struct WindowLifetime {
    event: HANDLE,
    pub(super) name: String,
}

// 句柄只用于跨线程置位、零超时读取和最终关闭；目标窗口不参与事件的所有权。
unsafe impl Send for WindowLifetime {}
unsafe impl Sync for WindowLifetime {}

impl WindowLifetime {
    pub(super) fn valid(&self) -> bool {
        (unsafe { WaitForSingleObject(self.event, 0) }) == windows::Win32::Foundation::WAIT_TIMEOUT
    }

    fn invalidate(&self) {
        let _ = unsafe { SetEvent(self.event) };
    }
}

impl Drop for WindowLifetime {
    fn drop(&mut self) {
        self.invalidate();
        let _ = unsafe { CloseHandle(self.event) };
    }
}

pub(super) struct WindowObserver {
    observed: ObservedWindows,
    thread_id: u32,
    worker: Option<JoinHandle<()>>,
    owner_creation: u64,
    sequence: u64,
    alive: Arc<AtomicBool>,
}

unsafe extern "system" fn window_destroyed(
    _hook: HWINEVENTHOOK,
    _event: u32,
    window: HWND,
    object: i32,
    child: i32,
    _thread: u32,
    _time: u32,
) {
    if object != OBJID_WINDOW.0 || child != 0 || window.is_invalid() {
        return;
    }
    OBSERVED.with(|slot| {
        let state = slot.borrow();
        if let Some(observed) = state.as_ref() {
            let mut windows = observed
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(lifetimes) = windows.remove(&(window.0 as usize)) {
                for lifetime in lifetimes.into_iter().filter_map(|entry| entry.upgrade()) {
                    lifetime.invalidate();
                }
            }
        }
    });
}

impl WindowObserver {
    pub(super) fn new() -> Result<Self, ErrorCode> {
        let mut creation = Default::default();
        let mut exit = Default::default();
        let mut kernel = Default::default();
        let mut user = Default::default();
        unsafe {
            GetProcessTimes(
                GetCurrentProcess(),
                &mut creation,
                &mut exit,
                &mut kernel,
                &mut user,
            )
        }
        .map_err(|_| ErrorCode::SourceDiscoveryFailed)?;
        let owner_creation =
            (u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime);
        let observed: ObservedWindows = Default::default();
        let watched = observed.clone();
        let alive = Arc::new(AtomicBool::new(false));
        let worker_alive = alive.clone();
        let (ready, started) = mpsc::sync_channel(1);
        let worker = thread::Builder::new()
            .name("window-lifetime".to_owned())
            .spawn(move || {
                OBSERVED.with(|slot| *slot.borrow_mut() = Some(watched.clone()));
                let mut message = MSG::default();
                // 先建立消息队列，再允许其他线程请求退出。
                let _ = unsafe { PeekMessageW(&mut message, None, 0, 0, PM_NOREMOVE) };
                let hook = unsafe {
                    SetWinEventHook(
                        EVENT_OBJECT_DESTROY,
                        EVENT_OBJECT_DESTROY,
                        None,
                        Some(window_destroyed),
                        0,
                        0,
                        WINEVENT_OUTOFCONTEXT,
                    )
                };
                let available = !hook.is_invalid();
                worker_alive.store(available, Ordering::Release);
                let _ = ready.send((unsafe { GetCurrentThreadId() }, available));
                if available {
                    while unsafe { GetMessageW(&mut message, None, 0, 0) }.0 > 0 {}
                    let _ = unsafe { UnhookWinEvent(hook) };
                }
                let mut windows = watched
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                worker_alive.store(false, Ordering::Release);
                for lifetime in windows.values().flatten().filter_map(Weak::upgrade) {
                    lifetime.invalidate();
                }
                windows.clear();
                OBSERVED.with(|slot| *slot.borrow_mut() = None);
            })
            .map_err(|_| ErrorCode::SourceDiscoveryFailed)?;
        match started.recv() {
            Ok((thread_id, true)) => Ok(Self {
                observed,
                thread_id,
                worker: Some(worker),
                owner_creation,
                sequence: 0,
                alive,
            }),
            _ => {
                let _ = worker.join();
                Err(ErrorCode::SourceDiscoveryFailed)
            }
        }
    }

    pub(super) fn watch(&mut self, window: HWND) -> Option<Arc<WindowLifetime>> {
        self.sequence = self.sequence.checked_add(1)?;
        let name = format!(
            "Local\\LycanSync.WindowLifetime.{}.{}.{}.{}",
            unsafe { GetCurrentProcessId() },
            self.owner_creation,
            self.sequence,
            window.0 as usize
        );
        let wide = name.encode_utf16().chain([0]).collect::<Vec<_>>();
        let event = unsafe { CreateEventW(None, true, false, PCWSTR(wide.as_ptr())) }.ok()?;
        if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
            let _ = unsafe { CloseHandle(event) };
            return None;
        }
        let lifetime = Arc::new(WindowLifetime { event, name });
        let mut windows = self
            .observed
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !self.alive.load(Ordering::Acquire) {
            return None;
        }
        windows.retain(|_, entries| {
            entries.retain(|entry| entry.strong_count() != 0);
            !entries.is_empty()
        });
        // 刷新时最多并存新旧两个来源快照，以及一条正在共享的旧身份。
        if windows.values().map(Vec::len).sum::<usize>() >= super::MAX_VIDEO_SOURCES * 2 + 1 {
            return None;
        }
        windows
            .entry(window.0 as usize)
            .or_default()
            .push(Arc::downgrade(&lifetime));
        Some(lifetime)
    }
}

impl Drop for WindowObserver {
    fn drop(&mut self) {
        let _ = unsafe { PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0)) };
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, SetWindowTextW, WS_OVERLAPPEDWINDOW,
    };
    use windows::core::w;

    #[test]
    fn destroyed_window_and_stopped_observer_permanently_revoke_lifetimes() {
        // 只操作本测试的隐藏窗口，不初始化 OBS、采集设备或改变其他应用。
        let mut observer = WindowObserver::new().unwrap();
        let create = || {
            unsafe {
                CreateWindowExW(
                    Default::default(),
                    w!("STATIC"),
                    w!("lifetime test"),
                    WS_OVERLAPPEDWINDOW,
                    0,
                    0,
                    32,
                    32,
                    None,
                    None,
                    None,
                    None,
                )
            }
            .unwrap()
        };
        let selected = create();
        let other = create();
        let selected_lifetime = observer.watch(selected).unwrap();
        let other_lifetime = observer.watch(other).unwrap();
        assert!(selected_lifetime.valid() && other_lifetime.valid());
        unsafe { SetWindowTextW(selected, w!("renamed")) }.unwrap();
        assert!(selected_lifetime.valid());
        unsafe { DestroyWindow(selected) }.unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while selected_lifetime.valid() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(2));
        }
        assert!(!selected_lifetime.valid());
        assert!(other_lifetime.valid());
        let replacement = create();
        let replacement_lifetime = observer.watch(replacement).unwrap();
        assert!(replacement_lifetime.valid() && !selected_lifetime.valid());
        drop(observer);
        assert!(!other_lifetime.valid() && !replacement_lifetime.valid());
        unsafe { DestroyWindow(other) }.unwrap();
        unsafe { DestroyWindow(replacement) }.unwrap();
    }
}
