#[cfg(target_os = "windows")]
use std::ffi::OsStr;

#[cfg(target_os = "windows")]
use std::os::windows::ffi::OsStrExt;

#[cfg(target_os = "windows")]
use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};

#[cfg(target_os = "windows")]
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyW, RegDeleteValueW, RegSetValueExW, HKEY, HKEY_CURRENT_USER,
    REG_SZ,
};

#[cfg(target_os = "windows")]
fn to_wide_null(s: &str) -> Vec<u16> {
    OsStr::new(s).encode_wide().chain(Some(0)).collect()
}

#[cfg(target_os = "windows")]
fn reg_err(code: u32, context: &str) -> String {
    format!("{context} failed (code={code})")
}

#[cfg(target_os = "windows")]
fn open_or_create_run_key() -> Result<HKEY, String> {
    let subkey = to_wide_null("Software\\Microsoft\\Windows\\CurrentVersion\\Run");
    let mut hkey: HKEY = 0;
    let status = unsafe { RegCreateKeyW(HKEY_CURRENT_USER, subkey.as_ptr(), &mut hkey) };
    if status != ERROR_SUCCESS {
        return Err(reg_err(status, "RegCreateKeyW"));
    }
    Ok(hkey)
}

#[cfg(target_os = "windows")]
pub fn set_run_on_startup(enabled: bool) -> Result<(), String> {
    const VALUE_NAME: &str = "XAUUSDCalendarAgent";
    let value_name = to_wide_null(VALUE_NAME);

    let hkey = open_or_create_run_key()?;
    let result = if enabled {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let exe = exe.to_string_lossy().to_string();
        let command = format!("\"{exe}\" --autostart");
        let data = to_wide_null(&command);
        let byte_len = (data.len() * 2) as u32;
        let status = unsafe {
            RegSetValueExW(
                hkey,
                value_name.as_ptr(),
                0,
                REG_SZ,
                data.as_ptr() as *const u8,
                byte_len,
            )
        };
        if status != ERROR_SUCCESS {
            Err(reg_err(status, "RegSetValueExW"))
        } else {
            Ok(())
        }
    } else {
        let status = unsafe { RegDeleteValueW(hkey, value_name.as_ptr()) };
        if status == ERROR_SUCCESS || status == ERROR_FILE_NOT_FOUND {
            Ok(())
        } else {
            Err(reg_err(status, "RegDeleteValueW"))
        }
    };
    unsafe {
        RegCloseKey(hkey);
    }
    result
}

#[cfg(not(target_os = "windows"))]
pub fn set_run_on_startup(_enabled: bool) -> Result<(), String> {
    Ok(())
}
