use chrono::NaiveDateTime;
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

#[cfg(not(target_os = "windows"))]
use directories::ProjectDirs;

fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
}

fn portable_data_dir() -> Option<PathBuf> {
    // Opt-in portable mode:
    // - If `user-data/` exists next to the executable, we treat it as portable.
    // - Or explicitly force portable via env var (useful for dev / zipped builds).
    if std::env::var("XAUUSD_CALENDAR_AGENT_PORTABLE")
        .ok()
        .as_deref()
        == Some("1")
    {
        return exe_dir().map(|dir| dir.join("user-data"));
    }

    exe_dir()
        .map(|dir| dir.join("user-data"))
        .filter(|p| p.exists())
}

pub fn install_dir() -> PathBuf {
    exe_dir().unwrap_or_else(|| {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .to_path_buf()
    })
}

#[cfg(target_os = "windows")]
fn platform_appdata_dir() -> Option<PathBuf> {
    legacy_roaming_dir()
}

#[cfg(not(target_os = "windows"))]
fn platform_appdata_dir() -> Option<PathBuf> {
    // macOS: ~/Library/Application Support/<app>/
    // Linux: ~/.local/share/<app>/
    ProjectDirs::from("com", "xauusd", "XAUUSDCalendarAgent")
        .map(|p| p.data_local_dir().to_path_buf())
}

pub fn app_root_dir() -> PathBuf {
    if let Ok(override_dir) = std::env::var("XAUUSD_CALENDAR_AGENT_DATA_DIR") {
        let trimmed = override_dir.trim().to_string();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }

    // Portable mode: use a sibling `user-data/` folder next to the running executable (opt-in).
    if let Some(dir) = portable_data_dir() {
        return dir;
    }

    platform_appdata_dir().unwrap_or_else(|| {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("user-data")
    })
}

fn legacy_roaming_dir() -> Option<PathBuf> {
    std::env::var("APPDATA").ok().and_then(|appdata| {
        let trimmed = appdata.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(PathBuf::from(trimmed).join("XAUUSDCalendar"))
        }
    })
}

pub fn appdata_dir() -> PathBuf {
    app_root_dir()
}

const APPDATA_MARKER: &str = ".xauusdcalendar.marker";

pub fn ensure_appdata_marker() -> Result<(), String> {
    let Some(roaming) = legacy_roaming_dir() else {
        return Ok(());
    };
    if appdata_dir() != roaming {
        return Ok(());
    }
    fs::create_dir_all(&roaming).map_err(|e| e.to_string())?;
    fs::write(roaming.join(APPDATA_MARKER), "XAUUSDCalendarAgent")
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn parse_generated_at(value: &str) -> Option<NaiveDateTime> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    NaiveDateTime::parse_from_str(trimmed, "%d-%m-%Y %H:%M").ok()
}

fn read_generated_at(path: &Path) -> Option<NaiveDateTime> {
    let text = fs::read_to_string(path).ok()?;
    let parsed: Value = serde_json::from_str(&text).ok()?;
    let value = parsed.get("generated_at")?.as_str()?;
    parse_generated_at(value)
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    if !src.exists() {
        return Err(format!("source not found: {}", src.display()));
    }
    if !dst.exists() {
        fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    }
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            if let Some(parent) = dst_path.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::copy(&src_path, &dst_path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub fn maybe_seed_data_from_install() -> Result<bool, String> {
    let install_data = install_dir().join("data");
    let app_data = appdata_dir().join("data");
    let install_index = install_data
        .join("event_history_index")
        .join("event_history_by_event.index.json");
    let app_index = app_data
        .join("event_history_index")
        .join("event_history_by_event.index.json");

    if !install_index.exists() {
        return Ok(false);
    }
    if !app_index.exists() {
        let _ = fs::remove_dir_all(&app_data);
        copy_dir_recursive(&install_data, &app_data)?;
        return Ok(true);
    }

    let install_time = read_generated_at(&install_index);
    let app_time = read_generated_at(&app_index);
    let should_copy = match (install_time, app_time) {
        (Some(install_dt), Some(app_dt)) => install_dt > app_dt,
        (Some(_), None) => true,
        _ => false,
    };
    if should_copy {
        let _ = fs::remove_dir_all(&app_data);
        copy_dir_recursive(&install_data, &app_data)?;
        return Ok(true);
    }

    Ok(false)
}

pub fn working_root_dir(cfg: &Value) -> PathBuf {
    if get_bool(cfg, "enable_temporary_path", false) {
        let temp = get_str(cfg, "temporary_path");
        if !temp.is_empty() {
            return PathBuf::from(temp);
        }
    }
    appdata_dir()
}

pub fn working_data_dir(cfg: &Value) -> PathBuf {
    working_root_dir(cfg).join("data")
}

pub fn config_path() -> PathBuf {
    appdata_dir().join("config.json")
}

pub fn log_dir() -> PathBuf {
    appdata_dir().join("logs")
}

pub fn load_config() -> Value {
    let defaults = default_config();
    let path = config_path();

    // If we're using `user-data/` but it doesn't have config yet, migrate from the legacy roaming
    // AppData location once (best-effort), then try to clean it up so data only lives in user-data.
    if !path.exists() {
        if let Some(portable_dir) = portable_data_dir() {
            if path.starts_with(&portable_dir) {
                if let Some(roaming) = legacy_roaming_dir() {
                    if roaming.exists() && roaming != portable_dir {
                        let from = roaming.join("config.json");
                        if from.exists() {
                            if let Some(parent) = path.parent() {
                                let _ = fs::create_dir_all(parent);
                            }
                            let _ = fs::copy(&from, &path);
                        }
                    }
                }
            }
        }
    }

    let text = fs::read_to_string(&path).unwrap_or_default();
    let parsed: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({}));
    let merged = merge_objects(defaults, parsed);

    if !path.exists() {
        let _ = save_config(&merged);
    }
    merged
}

pub fn save_config(value: &Value) -> Result<(), String> {
    let path = config_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    fs::write(&tmp, text).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

fn merge_objects(base: Value, overlay: Value) -> Value {
    match (base, overlay) {
        (Value::Object(mut b), Value::Object(o)) => {
            for (k, v) in o {
                b.insert(k, v);
            }
            Value::Object(b)
        }
        (b, _) => b,
    }
}

pub fn get_str(cfg: &Value, key: &str) -> String {
    cfg.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

pub fn get_bool(cfg: &Value, key: &str, fallback: bool) -> bool {
    cfg.get(key).and_then(|v| v.as_bool()).unwrap_or(fallback)
}

pub fn get_i64(cfg: &Value, key: &str, fallback: i64) -> i64 {
    cfg.get(key).and_then(|v| v.as_i64()).unwrap_or(fallback)
}

pub fn get_i32(cfg: &Value, key: &str, fallback: i32) -> i32 {
    cfg.get(key)
        .and_then(|v| v.as_i64())
        .map(|v| v as i32)
        .unwrap_or(fallback)
}

pub fn set_string(cfg: &mut Value, key: &str, value: String) -> Result<(), String> {
    let obj = cfg.as_object_mut().ok_or("config invalid")?;
    obj.insert(key.to_string(), Value::String(value));
    Ok(())
}

pub fn set_bool(cfg: &mut Value, key: &str, value: bool) -> Result<(), String> {
    let obj = cfg.as_object_mut().ok_or("config invalid")?;
    obj.insert(key.to_string(), Value::Bool(value));
    Ok(())
}

pub fn set_number(cfg: &mut Value, key: &str, value: i64) -> Result<(), String> {
    let obj = cfg.as_object_mut().ok_or("config invalid")?;
    obj.insert(key.to_string(), Value::Number(value.into()));
    Ok(())
}

fn default_config() -> Value {
    let mut base = Map::<String, Value>::new();
    base.insert("schema_version".to_string(), Value::Number(2.into()));
    // `repo_path` is only used as an internal git cache (if enabled).
    // The app reads calendar data from the install-root `data/` folder.
    base.insert("repo_path".to_string(), Value::String("".to_string()));
    base.insert("sync_repo_path".to_string(), Value::String("".to_string()));
    base.insert("temporary_path".to_string(), Value::String("".to_string()));
    base.insert("enable_sync_repo".to_string(), Value::Bool(false));
    base.insert(
        "sync_repo_confirmed_path".to_string(),
        Value::String("".to_string()),
    );
    base.insert(
        "sync_repo_confirmed_repo".to_string(),
        Value::String("".to_string()),
    );
    base.insert(
        "sync_repo_confirmed_mode".to_string(),
        Value::String("".to_string()),
    );
    base.insert(
        "sync_repo_confirmed_at".to_string(),
        Value::String("".to_string()),
    );
    base.insert("repo_path_history".to_string(), json!([]));
    base.insert("sync_repo_path_history".to_string(), json!([]));
    base.insert("output_dir_history".to_string(), json!([]));
    base.insert("temporary_path_history".to_string(), json!([]));
    base.insert("successful_repo_paths".to_string(), json!([]));
    base.insert("created_paths".to_string(), json!([]));
    base.insert("output_dir".to_string(), Value::String("".to_string()));
    base.insert("output_dir_last_sync_at".to_string(), json!({}));
    base.insert("repo_path_last_pull_at".to_string(), json!({}));
    base.insert("repo_path_last_pull_sha".to_string(), json!({}));
    base.insert("auto_pull_days".to_string(), Value::Number(1.into()));
    base.insert(
        "check_interval_minutes".to_string(),
        Value::Number(360.into()),
    );
    base.insert("enable_temporary_path".to_string(), Value::Bool(false));
    base.insert(
        "ui_min_interval_minutes".to_string(),
        Value::Number(10.into()),
    );
    base.insert(
        "ui_calendar_tick_seconds".to_string(),
        Value::Number(60.into()),
    );
    base.insert(
        "ui_settings_autosave_ms".to_string(),
        Value::Number(400.into()),
    );
    base.insert(
        "background_max_workers".to_string(),
        Value::Number(4.into()),
    );
    base.insert("auto_sync_after_pull".to_string(), Value::Bool(true));
    base.insert("debug".to_string(), Value::Bool(false));
    base.insert("last_pull_at".to_string(), Value::String("".to_string()));
    base.insert("last_sync_at".to_string(), Value::String("".to_string()));
    base.insert("last_pull_sha".to_string(), Value::String("".to_string()));
    base.insert("auto_update_enabled".to_string(), Value::Bool(true));
    base.insert(
        "auto_update_interval_minutes".to_string(),
        Value::Number(60.into()),
    );
    base.insert(
        "last_update_check_at".to_string(),
        Value::String("".to_string()),
    );
    base.insert(
        "github_repo".to_string(),
        Value::String("yiyousiow000814/XAUUSD-Calendar-Agent".to_string()),
    );
    base.insert(
        "github_branch".to_string(),
        Value::String("main".to_string()),
    );
    base.insert(
        "github_release_asset_name".to_string(),
        Value::String("Setup.exe".to_string()),
    );
    base.insert("github_token".to_string(), Value::String("".to_string()));
    base.insert(
        "github_token_last_seen".to_string(),
        Value::String("".to_string()),
    );
    base.insert("run_on_startup".to_string(), Value::Bool(true));
    base.insert(
        "autostart_launch_mode".to_string(),
        Value::String("tray".to_string()),
    );
    base.insert(
        "close_behavior".to_string(),
        Value::String("exit".to_string()),
    );
    base.insert("settings_auto_save".to_string(), Value::Bool(true));
    base.insert(
        "theme_preference".to_string(),
        Value::String("system".to_string()),
    );
    base.insert("enable_system_theme".to_string(), Value::Bool(false));
    base.insert("split_ratio".to_string(), json!(0.66));
    base.insert(
        "calendar_timezone_mode".to_string(),
        Value::String("system".to_string()),
    );
    base.insert(
        "calendar_utc_offset_minutes".to_string(),
        Value::Number(0.into()),
    );
    Value::Object(base)
}

pub fn path_is_usable_dir(path: &Path) -> bool {
    path.exists() && path.is_dir()
}
