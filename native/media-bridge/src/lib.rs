use napi::bindgen_prelude::{Buffer, FnArgs, Function, Unknown};
use napi::{Error, Result, Status};

#[cfg(target_os = "windows")]
mod windows_bridge {
    use super::*;
    use std::path::Path;
    use windows::Win32::Foundation::{CloseHandle, DUPLICATE_SAME_ACCESS, HANDLE, STILL_ACTIVE};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Threading::{
        GetCurrentProcess, GetCurrentProcessId, GetExitCodeProcess, GetProcessHandleCount,
        OpenProcess, PROCESS_DUP_HANDLE, PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_SYNCHRONIZE, QueryFullProcessImageNameW,
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

    #[napi_derive::napi]
    impl SpawnedMediaHelper {
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
