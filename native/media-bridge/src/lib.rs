//! Electron 原生桥：验证 helper 身份与纹理句柄，读取进程指标并注册受限音频热键。

use napi::bindgen_prelude::{Buffer, FnArgs, Function, Unknown};
use napi::{Error, Result, Status};

#[cfg(target_os = "windows")]
mod audio_hotkeys;

#[cfg(target_os = "windows")]
mod audio_devices;

#[cfg(target_os = "windows")]
mod windows_bridge {
    use super::*;
    use std::collections::HashMap;
    use std::path::Path;
    use windows::Win32::Foundation::{
        CloseHandle, DUPLICATE_SAME_ACCESS, FILETIME, HANDLE, STILL_ACTIVE,
    };
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
    };
    use windows::Win32::System::RemoteDesktop::ProcessIdToSessionId;
    use windows::Win32::System::Threading::{
        GetCurrentProcess, GetCurrentProcessId, GetExitCodeProcess, GetProcessHandleCount,
        GetProcessIoCounters, GetProcessTimes, IO_COUNTERS, OpenProcess, PROCESS_DUP_HANDLE,
        PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
        QueryFullProcessImageNameW,
    };
    use windows::core::PWSTR;

    struct OwnedHandle(HANDLE);

    impl OwnedHandle {
        fn new(handle: HANDLE) -> Self {
            Self(handle)
        }

        fn raw(&self) -> HANDLE {
            self.0
        }

        fn close(&mut self) {
            if !self.0.is_invalid() {
                unsafe {
                    let _ = CloseHandle(self.0);
                }
                self.0 = HANDLE::default();
            }
        }
    }

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            self.close();
        }
    }

    #[napi_derive::napi]
    pub struct SpawnedMediaHelper {
        process: Option<OwnedHandle>,
    }

    #[napi_derive::napi(object)]
    pub struct NativeProcessMetrics {
        pub working_set_bytes: f64,
        pub private_commit_bytes: f64,
        pub cpu_seconds: Option<f64>,
        pub io_read_bytes: Option<f64>,
        pub io_write_bytes: Option<f64>,
    }

    #[napi_derive::napi]
    impl SpawnedMediaHelper {
        #[napi_derive::napi]
        pub fn read_metrics(&self) -> Result<NativeProcessMetrics> {
            let process = self
                .process
                .as_ref()
                .ok_or_else(|| error("spawnedMediaHelperReleased"))?;
            if !process_is_running(process.raw()) {
                return Err(error("spawnedMediaHelperExited"));
            }
            let mut counters = PROCESS_MEMORY_COUNTERS_EX::default();
            let size = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
            counters.cb = size;
            // 仅读取已验证子进程的固定句柄，避免 PID 重用和每次采样重新枚举进程。
            unsafe {
                GetProcessMemoryInfo(
                    process.raw(),
                    &mut counters as *mut _ as *mut PROCESS_MEMORY_COUNTERS,
                    size,
                )
            }
            .map_err(|_| error("processMemoryUnavailable"))?;
            let (mut created, mut exited, mut kernel, mut user) = (
                FILETIME::default(),
                FILETIME::default(),
                FILETIME::default(),
                FILETIME::default(),
            );
            let seconds = |time: FILETIME| {
                ((u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime)) as f64
                    / 10_000_000.0
            };
            // CPU 与 I/O 各自可用；读取失败不抹掉已取得的内存，也不伪报零。
            let cpu_seconds = unsafe {
                GetProcessTimes(
                    process.raw(),
                    &mut created,
                    &mut exited,
                    &mut kernel,
                    &mut user,
                )
            }
            .ok()
            .map(|_| seconds(kernel) + seconds(user));
            let mut io = IO_COUNTERS::default();
            let io_available = unsafe { GetProcessIoCounters(process.raw(), &mut io) }.is_ok();
            Ok(NativeProcessMetrics {
                working_set_bytes: counters.WorkingSetSize as f64,
                private_commit_bytes: counters.PrivateUsage as f64,
                cpu_seconds,
                io_read_bytes: io_available.then_some(io.ReadTransferCount as f64),
                io_write_bytes: io_available.then_some(io.WriteTransferCount as f64),
            })
        }

        #[napi_derive::napi]
        pub fn duplicate_shared_texture(
            &self,
            local_handle_hex: String,
        ) -> Result<OwnedSharedTexture> {
            let process = self
                .process
                .as_ref()
                .ok_or_else(|| error("spawnedMediaHelperReleased"))?;
            if !process_is_running(process.raw()) {
                return Err(error("spawnedMediaHelperExited"));
            }
            let value = parse_handle(&local_handle_hex)?;
            let source = HANDLE(value as *mut _);
            let mut duplicate = HANDLE::default();
            unsafe {
                windows::Win32::Foundation::DuplicateHandle(
                    process.raw(),
                    source,
                    GetCurrentProcess(),
                    &mut duplicate,
                    0,
                    false,
                    DUPLICATE_SAME_ACCESS,
                )
                .map_err(|_| error("sharedTextureHandleCopyFailed"))?;
            }
            if duplicate.is_invalid() {
                return Err(error("sharedTextureHandleCopyFailed"));
            }
            Ok(OwnedSharedTexture {
                handle: Some(OwnedHandle::new(duplicate)),
            })
        }

        #[napi_derive::napi]
        pub fn release(&mut self) {
            self.process.take();
        }
    }

    #[napi_derive::napi]
    pub struct OwnedSharedTexture {
        handle: Option<OwnedHandle>,
    }

    #[napi_derive::napi]
    impl OwnedSharedTexture {
        #[napi_derive::napi]
        pub fn with_import_handle<'scope>(
            &mut self,
            callback: Function<'scope, FnArgs<(Buffer,)>, Unknown<'scope>>,
        ) -> Result<Unknown<'scope>> {
            let handle = self
                .handle
                .as_ref()
                .ok_or_else(|| error("sharedTextureHandleAlreadyReleased"))?
                .raw();
            let value = handle.0 as usize as u64;
            let bytes = Buffer::from(value.to_le_bytes().to_vec());
            // 句柄仅在同步导入回调期间有效，成功或失败返回后都释放本地副本。
            let result = callback.call(FnArgs { data: (bytes,) });
            self.release();
            result
        }

        #[napi_derive::napi]
        pub fn release(&mut self) {
            self.handle.take();
        }
    }

    impl Drop for OwnedSharedTexture {
        fn drop(&mut self) {
            self.release();
        }
    }

    #[napi_derive::napi]
    pub fn open_spawned_media_helper(
        pid: u32,
        expected_image_path: String,
    ) -> Result<SpawnedMediaHelper> {
        let expected_path = std::fs::canonicalize(&expected_image_path)
            .map_err(|_| error("spawnedMediaHelperIdentityMismatch"))?;
        let access = PROCESS_DUP_HANDLE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE;
        let process = unsafe { OpenProcess(access, false, pid) }
            .map_err(|_| error("spawnedMediaHelperUnavailable"))?;
        let process = OwnedHandle::new(process);
        // 只接受当前 Electron 启动且路径匹配的 helper，不能按任意 PID 复制纹理句柄。
        if parent_process_id(pid)? != unsafe { GetCurrentProcessId() }
            || !same_path(&process_image_path(process.raw())?, &expected_path)
            || !process_is_running(process.raw())
        {
            return Err(error("spawnedMediaHelperIdentityMismatch"));
        }
        Ok(SpawnedMediaHelper {
            process: Some(process),
        })
    }

    #[napi_derive::napi]
    pub fn current_process_handle_count() -> Result<u32> {
        let mut count = 0;
        unsafe { GetProcessHandleCount(GetCurrentProcess(), &mut count) }
            .map_err(|_| error("processHandleCountUnavailable"))?;
        Ok(count)
    }

    fn parse_handle(value: &str) -> Result<usize> {
        let digits = value.strip_prefix("0x").unwrap_or(value);
        if digits.is_empty() || digits.len() > 16 || !digits.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(error("invalidSharedTextureHandleDescription"));
        }
        let parsed = u64::from_str_radix(digits, 16)
            .map_err(|_| error("invalidSharedTextureHandleDescription"))?;
        usize::try_from(parsed).map_err(|_| error("invalidSharedTextureHandleDescription"))
    }

    fn process_is_running(process: HANDLE) -> bool {
        let mut exit_code = 0;
        unsafe {
            GetExitCodeProcess(process, &mut exit_code).is_ok()
                && exit_code == STILL_ACTIVE.0 as u32
        }
    }

    fn process_image_path(process: HANDLE) -> Result<std::path::PathBuf> {
        let mut buffer = vec![0u16; 32_768];
        let mut length = buffer.len() as u32;
        unsafe {
            QueryFullProcessImageNameW(
                process,
                PROCESS_NAME_FORMAT(0),
                PWSTR(buffer.as_mut_ptr()),
                &mut length,
            )
        }
        .map_err(|_| error("spawnedMediaHelperIdentityMismatch"))?;
        buffer.truncate(length as usize);
        let path =
            String::from_utf16(&buffer).map_err(|_| error("spawnedMediaHelperIdentityMismatch"))?;
        std::fs::canonicalize(path).map_err(|_| error("spawnedMediaHelperIdentityMismatch"))
    }

    fn same_path(left: &Path, right: &Path) -> bool {
        left.to_string_lossy()
            .replace('/', "\\")
            .eq_ignore_ascii_case(&right.to_string_lossy().replace('/', "\\"))
    }

    #[napi_derive::napi(object)]
    pub struct ApplicationAudioProcess {
        pub executable: String,
        pub pid: u32,
        pub creation: String,
        pub window_title: Option<String>,
    }

    // EnumWindows 按窗口前后次序枚举，每个候选进程只读取最前面的可见标题。
    unsafe extern "system" fn read_application_window(
        window: windows::Win32::Foundation::HWND,
        param: windows::Win32::Foundation::LPARAM,
    ) -> windows::core::BOOL {
        use windows::Win32::UI::WindowsAndMessaging::{
            GW_OWNER, GetWindow, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
        };
        let titles = unsafe { &mut *(param.0 as *mut HashMap<u32, Option<String>>) };
        let mut pid = 0;
        unsafe { GetWindowThreadProcessId(window, Some(&mut pid)) };
        if let Some(title) = titles.get_mut(&pid)
            && title.is_none()
            && unsafe { IsWindowVisible(window) }.as_bool()
            && unsafe { GetWindow(window, GW_OWNER) }.is_err()
        {
            let mut text = [0u16; 256];
            let length = unsafe { GetWindowTextW(window, &mut text) };
            if length > 0 {
                *title = Some(String::from_utf16_lossy(&text[..length as usize]));
            }
        }
        true.into()
    }

    #[napi_derive::napi]
    pub fn list_application_audio_processes(
        executables: Vec<String>,
    ) -> Result<Vec<ApplicationAudioProcess>> {
        let snapshot = OwnedHandle::new(
            unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }
                .map_err(|_| error("applicationAudioSourcesUnavailable"))?,
        );
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        unsafe { Process32FirstW(snapshot.raw(), &mut entry) }
            .map_err(|_| error("applicationAudioSourcesUnavailable"))?;
        let mut desktop_session = 0;
        unsafe { ProcessIdToSessionId(GetCurrentProcessId(), &mut desktop_session) }
            .map_err(|_| error("applicationAudioSourcesUnavailable"))?;
        let mut candidates = std::collections::HashMap::new();
        loop {
            let len = entry
                .szExeFile
                .iter()
                .position(|c| *c == 0)
                .unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(&entry.szExeFile[..len]).to_ascii_lowercase();
            let mut session = 0;
            if executables.contains(&name)
                && unsafe { ProcessIdToSessionId(entry.th32ProcessID, &mut session) }.is_ok()
                && session == desktop_session
            {
                candidates.insert(entry.th32ProcessID, (entry.th32ParentProcessID, name));
            }
            if let Err(err) = unsafe { Process32NextW(snapshot.raw(), &mut entry) } {
                if err.code() != windows::Win32::Foundation::ERROR_NO_MORE_FILES.to_hresult() {
                    return Err(error("applicationAudioSourcesUnavailable"));
                }
                break;
            }
        }
        let mut titles: HashMap<u32, Option<String>> =
            candidates.keys().map(|&pid| (pid, None)).collect();
        unsafe {
            windows::Win32::UI::WindowsAndMessaging::EnumWindows(
                Some(read_application_window),
                windows::Win32::Foundation::LPARAM(
                    (&mut titles as *mut HashMap<u32, Option<String>>) as isize,
                ),
            )
        }
        .map_err(|_| error("applicationAudioSourcesUnavailable"))?;
        let mut result = Vec::new();
        for (&pid, (parent, name)) in &candidates {
            // 浏览器的渲染和音频子进程随根进程一起采集。
            if candidates
                .get(parent)
                .is_some_and(|(_, parent_name)| parent_name == name)
            {
                continue;
            }
            let Ok(handle) =
                (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) })
            else {
                continue;
            };
            let process = OwnedHandle::new(handle);
            let Ok(path) = process_image_path(process.raw()) else {
                continue;
            };
            if !path
                .file_name()
                .and_then(|v| v.to_str())
                .is_some_and(|v| v.eq_ignore_ascii_case(name))
            {
                continue;
            }
            let (mut creation, mut exit, mut kernel, mut user) = Default::default();
            if unsafe {
                GetProcessTimes(
                    process.raw(),
                    &mut creation,
                    &mut exit,
                    &mut kernel,
                    &mut user,
                )
            }
            .is_err()
            {
                continue;
            }
            let birth =
                (u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime);
            result.push(ApplicationAudioProcess {
                pid,
                executable: name.clone(),
                creation: birth.to_string(),
                window_title: titles.remove(&pid).flatten(),
            });
        }
        result.sort_by_key(|p| p.pid);
        Ok(result)
    }

    fn parent_process_id(pid: u32) -> Result<u32> {
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }
            .map_err(|_| error("spawnedMediaHelperIdentityMismatch"))?;
        let snapshot = OwnedHandle::new(snapshot);
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..PROCESSENTRY32W::default()
        };
        unsafe { Process32FirstW(snapshot.raw(), &mut entry) }
            .map_err(|_| error("spawnedMediaHelperIdentityMismatch"))?;
        loop {
            if entry.th32ProcessID == pid {
                return Ok(entry.th32ParentProcessID);
            }
            if unsafe { Process32NextW(snapshot.raw(), &mut entry) }.is_err() {
                break;
            }
        }
        Err(error("spawnedMediaHelperIdentityMismatch"))
    }

    fn error(message: &'static str) -> Error {
        Error::new(Status::GenericFailure, message)
    }
}

#[cfg(target_os = "windows")]
pub use windows_bridge::{
    OwnedSharedTexture, SpawnedMediaHelper, current_process_handle_count, open_spawned_media_helper,
};

#[cfg(not(target_os = "windows"))]
#[napi_derive::napi]
pub fn open_spawned_media_helper(_pid: u32, _expected_image_path: String) -> Result<()> {
    Err(Error::new(Status::GenericFailure, "platformUnsupported"))
}
