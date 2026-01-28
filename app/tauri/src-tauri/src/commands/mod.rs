use crate::calendar::{currency_options, load_calendar_events, CALENDAR_SOURCE_UTC_OFFSET_MINUTES};
use crate::config;
use crate::git_ops;
use crate::snapshot::{render_next_events, render_past_events};
use crate::startup;
use crate::state::{CalendarCache, RuntimeState};
use crate::sync_util;
use crate::time_util::{display_time_from_iso, now_display_time, now_iso_time};
use serde_json::{json, Value};
use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

pub(crate) mod history;
pub(crate) mod lifecycle;
pub(crate) mod logs;
pub(crate) mod open;
pub(crate) mod pull;
pub(crate) mod settings;
pub(crate) mod snapshot_cmd;
pub(crate) mod sync;
pub(crate) mod ui;
pub(crate) mod update;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0))
        .as_millis() as i64
}

fn push_log(state: &mut RuntimeState, message: &str, level: &str) {
    state.logs.insert(
        0,
        json!({
            "time": now_display_time(),
            "message": message,
            "level": level,
        }),
    );
    if state.logs.len() > 200 {
        state.logs.truncate(200);
    }
}

fn set_object_string(root: &mut Value, key: &str, subkey: &str, value: &str) {
    if root.get(key).and_then(|v| v.as_object()).is_none() {
        if let Some(obj) = root.as_object_mut() {
            obj.insert(key.to_string(), json!({}));
        }
    }
    if let Some(obj) = root.get_mut(key).and_then(|v| v.as_object_mut()) {
        obj.insert(subkey.to_string(), Value::String(value.to_string()));
    }
}

fn normalize_version_tag(tag: &str) -> String {
    let trimmed = tag.trim();
    if let Some(rest) = trimmed.strip_prefix('v') {
        rest.trim().to_string()
    } else {
        trimmed.to_string()
    }
}

fn parse_version_numbers(v: &str) -> Option<Vec<u32>> {
    let v = v.trim();
    if v.is_empty() {
        return None;
    }
    let core = v.split('-').next().unwrap_or(v);
    let mut nums = vec![];
    for part in core.split('.') {
        let part = part.trim();
        if part.is_empty() {
            return None;
        }
        nums.push(part.parse::<u32>().ok()?);
    }
    Some(nums)
}

fn cmp_versions(a: &str, b: &str) -> Ordering {
    let a = parse_version_numbers(a).unwrap_or_default();
    let b = parse_version_numbers(b).unwrap_or_default();
    let max_len = a.len().max(b.len());
    for i in 0..max_len {
        let ai = *a.get(i).unwrap_or(&0);
        let bi = *b.get(i).unwrap_or(&0);
        match ai.cmp(&bi) {
            Ordering::Equal => continue,
            other => return other,
        }
    }
    Ordering::Equal
}

fn resolve_calendar_repo_path(cfg: &Value) -> Option<PathBuf> {
    // Prefer the working copy (user-writable) so pull/sync never touches the install dir.
    let work_root = config::working_root_dir(cfg);
    if config::path_is_usable_dir(&work_root.join("data").join("Economic_Calendar"))
        && work_root.join("data").join("event_history_index").exists()
    {
        return Some(work_root);
    }

    // Fallback: bundled seed in install dir (read-only).
    let install = config::install_dir();
    if config::path_is_usable_dir(&install.join("data").join("Economic_Calendar"))
        && install.join("data").join("event_history_index").exists()
    {
        return Some(install);
    }

    let explicit = config::get_str(cfg, "repo_path");
    if !explicit.is_empty() {
        let p = PathBuf::from(explicit);
        if config::path_is_usable_dir(&p.join("data").join("Economic_Calendar")) {
            return Some(p);
        }
    }
    None
}

fn ensure_calendar_loaded(
    app: tauri::AppHandle,
    cfg: Value,
    state: tauri::State<'_, Mutex<RuntimeState>>,
) {
    let should_start = {
        let mut runtime = state.lock().expect("runtime lock");
        if runtime.calendar.status.is_empty() {
            runtime.calendar = CalendarCache {
                status: "empty".to_string(),
                last_loaded_at_ms: 0,
                events: Arc::new(vec![]),
            };
        }
        let stale = runtime.calendar.last_loaded_at_ms == 0
            || (now_ms() - runtime.calendar.last_loaded_at_ms) > 90_000;
        let loading = runtime.calendar.status == "loading";
        if loading || !stale {
            return;
        }
        runtime.calendar.status = "loading".to_string();
        true
    };
    if !should_start {
        return;
    }

    tauri::async_runtime::spawn(async move {
        let repo_path = resolve_calendar_repo_path(&cfg);
        let events = repo_path
            .as_deref()
            .map(load_calendar_events)
            .unwrap_or_default();
        let runtime_state = app.state::<Mutex<RuntimeState>>();
        let mut runtime = runtime_state.lock().expect("runtime lock");
        runtime.calendar.last_loaded_at_ms = now_ms();
        if events.is_empty() {
            runtime.calendar.status = "empty".to_string();
            runtime.calendar.events = Arc::new(vec![]);
            return;
        }
        runtime.calendar.status = "loaded".to_string();
        runtime.calendar.events = Arc::new(events);
    });
}

fn get_calendar_settings(cfg: &Value) -> (String, i32) {
    let tz_mode = config::get_str(cfg, "calendar_timezone_mode");
    let tz_mode = if tz_mode == "utc" { "utc" } else { "system" }.to_string();
    let minutes = config::get_i32(cfg, "calendar_utc_offset_minutes", 0);
    (tz_mode, minutes)
}

fn file_mtime_ms(path: &Path) -> Option<i64> {
    let meta = std::fs::metadata(path).ok()?;
    let modified = meta.modified().ok()?;
    let dur = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(dur.as_millis() as i64)
}

fn open_target(target: &str) -> bool {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/c", "start", "", target])
            .spawn()
            .is_ok()
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(target)
            .spawn()
            .is_ok()
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(target)
            .spawn()
            .is_ok()
    }
}
