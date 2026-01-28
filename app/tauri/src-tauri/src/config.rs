use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
}

fn portable_data_dir() -> Option<PathBuf> {
    exe_dir().map(|dir| dir.join("user-data"))
}

pub fn install_dir() -> PathBuf {
    exe_dir().unwrap_or_else(|| {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .to_path_buf()
    })
}

pub fn install_data_dir() -> PathBuf {
    install_dir().join("data")
}

pub fn app_root_dir() -> PathBuf {
    if let Ok(override_dir) = std::env::var("XAUUSD_CALENDAR_AGENT_DATA_DIR") {
        let trimmed = override_dir.trim().to_string();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }

    // Portable mode: use a sibling `user-data/` folder next to the running executable.
    if let Some(dir) = portable_data_dir() {
        return dir;
    }

    std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("user-data")
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
