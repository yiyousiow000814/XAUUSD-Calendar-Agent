use crate::calendar::{currency_options, load_calendar_events, to_value, CALENDAR_SOURCE_UTC_OFFSET_MINUTES};
use crate::config;
use crate::git_ops;
use crate::snapshot::{render_next_events, render_past_events};
use crate::state::{CalendarCache, RuntimeState};
use crate::startup;
use crate::sync_util;
use crate::time_util::{now_display_time, now_iso_time};
use chrono::Utc;
use serde_json::{json, Value};
use std::cmp::Ordering;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

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

pub fn default_update_state() -> Value {
    json!({
        "ok": true,
        "phase": "idle",
        "message": "",
        "availableVersion": "",
        "progress": 0,
        "downloadedBytes": 0,
        "totalBytes": null,
        "lastCheckedAt": ""
    })
}

fn set_update_state(runtime: &mut RuntimeState, phase: &str, message: &str, ok: bool, available_version: Option<&str>) {
    if runtime.update_state.is_null() {
        runtime.update_state = default_update_state();
    }
    if let Some(obj) = runtime.update_state.as_object_mut() {
        obj.insert("ok".to_string(), Value::Bool(ok));
        obj.insert("phase".to_string(), Value::String(phase.to_string()));
        obj.insert("message".to_string(), Value::String(message.to_string()));
        if let Some(v) = available_version {
            obj.insert("availableVersion".to_string(), Value::String(v.to_string()));
        }
        obj.insert("lastCheckedAt".to_string(), Value::String(now_display_time()));
    }
}

fn resolve_calendar_repo_path(cfg: &Value) -> Option<PathBuf> {
    let explicit = config::get_str(cfg, "repo_path");
    if !explicit.is_empty() {
        let p = PathBuf::from(explicit);
        if config::path_is_usable_dir(&p.join("data").join("Economic_Calendar")) {
            return Some(p);
        }
    }
    let repo = config::repo_dir();
    if config::path_is_usable_dir(&repo.join("data").join("Economic_Calendar")) {
        return Some(repo);
    }
    None
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

fn ensure_calendar_loaded(app: tauri::AppHandle, cfg: Value, state: tauri::State<'_, Mutex<RuntimeState>>) {
    let should_start = {
        let mut runtime = state.lock().expect("runtime lock");
        if runtime.calendar.status.is_empty() {
            runtime.calendar = CalendarCache {
                status: "empty".to_string(),
                last_loaded_at_ms: 0,
                events: vec![],
            };
        }
        let stale =
            runtime.calendar.last_loaded_at_ms == 0 || (now_ms() - runtime.calendar.last_loaded_at_ms) > 90_000;
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
            runtime.calendar.events.clear();
            return;
        }
        runtime.calendar.status = "loaded".to_string();
        runtime.calendar.events = events.iter().map(to_value).collect();
    });
}

fn spawn_pull(app: tauri::AppHandle, state: tauri::State<'_, Mutex<RuntimeState>>, reason: &str) {
    let cfg = config::load_config();
    let repo_slug = config::get_str(&cfg, "github_repo");
    let branch = config::get_str(&cfg, "github_branch");
    let repo_dir = config::repo_dir();
    {
        let mut runtime = state.lock().expect("runtime lock");
        if runtime.pull_active {
            return;
        }
        runtime.pull_active = true;
        push_log(&mut runtime, reason, "INFO");
    }
    tauri::async_runtime::spawn_blocking(move || {
        let result = (|| -> Result<String, String> {
            git_ops::ensure_repo(&repo_dir, &repo_slug, &branch)?;
            git_ops::pull_ff_only(&repo_dir)
        })();
        let runtime_state = app.state::<Mutex<RuntimeState>>();
        let mut runtime = runtime_state.lock().expect("runtime lock");
        runtime.pull_active = false;
        match result {
            Ok(sha) => {
                runtime.last_pull = now_display_time();
                runtime.last_pull_at = now_iso_time();
                let short = sha.chars().take(7).collect::<String>();
                push_log(&mut runtime, &format!("Pull finished ({short})"), "INFO");

                let events = load_calendar_events(&repo_dir);
                runtime.calendar.last_loaded_at_ms = now_ms();
                if events.is_empty() {
                    runtime.calendar.status = "empty".to_string();
                    runtime.calendar.events.clear();
                } else {
                    runtime.calendar.status = "loaded".to_string();
                    runtime.calendar.events = events.iter().map(to_value).collect();
                }
            }
            Err(err) => {
                push_log(&mut runtime, &format!("Pull failed: {err}"), "ERROR");
            }
        }
    });
}

fn get_calendar_settings(cfg: &Value) -> (String, i32) {
    let tz_mode = config::get_str(cfg, "calendar_timezone_mode");
    let tz_mode = if tz_mode == "utc" { "utc" } else { "system" }.to_string();
    let minutes = config::get_i32(cfg, "calendar_utc_offset_minutes", 0);
    (tz_mode, minutes)
}

#[tauri::command]
pub fn get_snapshot(app: tauri::AppHandle, state: tauri::State<'_, Mutex<RuntimeState>>) -> Value {
    let cfg = config::load_config();
    ensure_calendar_loaded(app, cfg.clone(), state.clone());

    let (tz_mode, utc_offset_minutes) = get_calendar_settings(&cfg);
    let currency_opts = currency_options();

    let mut runtime = state.lock().expect("runtime lock");
    if runtime.currency.is_empty() {
        runtime.currency = "USD".to_string();
    }
    if runtime.update_state.is_null() {
        runtime.update_state = default_update_state();
    }
    if runtime.output_dir.is_empty() {
        runtime.output_dir = config::get_str(&cfg, "output_dir");
    }
    if runtime.repo_path.is_empty() {
        runtime.repo_path = config::repo_dir().to_string_lossy().to_string();
    }

    let calendar_events = runtime
        .calendar
        .events
        .iter()
        .filter_map(|v| {
            let dt = v.get("dt_utc").and_then(|s| s.as_str())?;
            let dt = chrono::DateTime::parse_from_rfc3339(dt).ok()?.with_timezone(&Utc);
            Some(crate::calendar::CalendarEvent {
                dt_utc: dt,
                time_label: v.get("time_label").and_then(|s| s.as_str()).unwrap_or("").to_string(),
                event: v.get("event").and_then(|s| s.as_str()).unwrap_or("").to_string(),
                currency: v.get("currency").and_then(|s| s.as_str()).unwrap_or("").to_string(),
                importance: v.get("importance").and_then(|s| s.as_str()).unwrap_or("").to_string(),
                actual: v.get("actual").and_then(|s| s.as_str()).unwrap_or("").to_string(),
                forecast: v.get("forecast").and_then(|s| s.as_str()).unwrap_or("").to_string(),
                previous: v.get("previous").and_then(|s| s.as_str()).unwrap_or("").to_string(),
            })
        })
        .collect::<Vec<_>>();

    let next_events = render_next_events(
        &calendar_events,
        &runtime.currency,
        &tz_mode,
        utc_offset_minutes,
        CALENDAR_SOURCE_UTC_OFFSET_MINUTES,
    );
    let past_events = render_past_events(
        &calendar_events,
        &runtime.currency,
        &tz_mode,
        utc_offset_minutes,
        CALENDAR_SOURCE_UTC_OFFSET_MINUTES,
    );

    let last_pull = if runtime.last_pull.is_empty() {
        "Not yet".to_string()
    } else {
        runtime.last_pull.clone()
    };
    let last_sync = if runtime.last_sync.is_empty() {
        "Not yet".to_string()
    } else {
        runtime.last_sync.clone()
    };
    let calendar_status = if runtime.calendar.status.is_empty() {
        "empty".to_string()
    } else {
        runtime.calendar.status.clone()
    };

    json!({
        "lastPull": last_pull,
        "lastSync": last_sync,
        "lastPullAt": runtime.last_pull_at.clone(),
        "lastSyncAt": runtime.last_sync_at.clone(),
        "outputDir": runtime.output_dir.clone(),
        "repoPath": runtime.repo_path.clone(),
        "currency": runtime.currency.clone(),
        "currencyOptions": currency_opts,
        "events": next_events,
        "pastEvents": past_events,
        "logs": runtime.logs.clone(),
        "version": env!("APP_VERSION"),
        "pullActive": runtime.pull_active,
        "syncActive": runtime.sync_active,
        "calendarStatus": calendar_status,
        "restartInSeconds": 0,
        "modal": null
    })
}

#[tauri::command]
pub fn get_settings(state: tauri::State<'_, Mutex<RuntimeState>>) -> Value {
    let cfg = config::load_config();
    let runtime = state.lock().expect("runtime lock");
    let autostart_launch_mode = {
        let v = config::get_str(&cfg, "autostart_launch_mode");
        if v == "show" { "show" } else { "tray" }.to_string()
    };
    let close_behavior = {
        let v = config::get_str(&cfg, "close_behavior");
        if v == "tray" { "tray" } else { "exit" }.to_string()
    };
    let theme = {
        let v = config::get_str(&cfg, "theme_preference");
        if v == "dark" || v == "light" { v } else { "system".to_string() }
    };
    let calendar_timezone_mode = {
        let v = config::get_str(&cfg, "calendar_timezone_mode");
        if v == "utc" { "utc" } else { "system" }.to_string()
    };
    json!({
        "autoSyncAfterPull": config::get_bool(&cfg, "auto_sync_after_pull", true),
        "autoUpdateEnabled": config::get_bool(&cfg, "auto_update_enabled", true),
        "runOnStartup": config::get_bool(&cfg, "run_on_startup", true),
        "autostartLaunchMode": autostart_launch_mode,
        "closeBehavior": close_behavior,
        "traySupported": true,
        "debug": config::get_bool(&cfg, "debug", false),
        "autoSave": config::get_bool(&cfg, "settings_auto_save", true),
        "splitRatio": cfg.get("split_ratio").and_then(|v| v.as_f64()).unwrap_or(0.66),
        "enableSystemTheme": config::get_bool(&cfg, "enable_system_theme", false),
        "theme": theme,
        "calendarTimezoneMode": calendar_timezone_mode,
        "calendarUtcOffsetMinutes": config::get_i64(&cfg, "calendar_utc_offset_minutes", 0),
        "enableTemporaryPath": config::get_bool(&cfg, "enable_temporary_path", false),
        "temporaryPath": config::get_str(&cfg, "temporary_path"),
        "repoPath": if runtime.repo_path.is_empty() { config::repo_dir().to_string_lossy().to_string() } else { runtime.repo_path.clone() },
        "logPath": config::log_dir().join("app.log").to_string_lossy().to_string(),
        "removeLogs": true,
        "removeOutput": false,
        "removeTemporaryPaths": true,
        "uninstallConfirm": ""
    })
}

#[tauri::command]
pub fn save_settings(payload: Value, state: tauri::State<'_, Mutex<RuntimeState>>) -> Result<Value, String> {
    let mut cfg = config::load_config();
    config::set_bool(&mut cfg, "auto_sync_after_pull", payload.get("autoSyncAfterPull").and_then(|v| v.as_bool()).unwrap_or(true))?;
    config::set_bool(&mut cfg, "auto_update_enabled", payload.get("autoUpdateEnabled").and_then(|v| v.as_bool()).unwrap_or(true))?;
    let run_on_startup = payload.get("runOnStartup").and_then(|v| v.as_bool()).unwrap_or(true);
    config::set_bool(&mut cfg, "run_on_startup", run_on_startup)?;
    config::set_string(&mut cfg, "autostart_launch_mode", payload.get("autostartLaunchMode").and_then(|v| v.as_str()).unwrap_or("tray").to_string())?;
    config::set_string(&mut cfg, "close_behavior", payload.get("closeBehavior").and_then(|v| v.as_str()).unwrap_or("exit").to_string())?;
    config::set_bool(&mut cfg, "debug", payload.get("debug").and_then(|v| v.as_bool()).unwrap_or(false))?;
    config::set_bool(&mut cfg, "settings_auto_save", payload.get("autoSave").and_then(|v| v.as_bool()).unwrap_or(true))?;
    if let Some(v) = payload.get("splitRatio").and_then(|v| v.as_f64()) {
        let obj = cfg.as_object_mut().ok_or("config invalid")?;
        obj.insert("split_ratio".to_string(), json!(v));
    }
    config::set_bool(&mut cfg, "enable_system_theme", payload.get("enableSystemTheme").and_then(|v| v.as_bool()).unwrap_or(false))?;
    config::set_string(&mut cfg, "theme_preference", payload.get("theme").and_then(|v| v.as_str()).unwrap_or("system").to_string())?;
    config::set_string(&mut cfg, "calendar_timezone_mode", payload.get("calendarTimezoneMode").and_then(|v| v.as_str()).unwrap_or("system").to_string())?;
    if let Some(minutes) = payload.get("calendarUtcOffsetMinutes").and_then(|v| v.as_i64()) {
        config::set_number(&mut cfg, "calendar_utc_offset_minutes", minutes)?;
    }
    config::set_bool(&mut cfg, "enable_temporary_path", payload.get("enableTemporaryPath").and_then(|v| v.as_bool()).unwrap_or(false))?;
    config::set_string(&mut cfg, "temporary_path", payload.get("temporaryPath").and_then(|v| v.as_str()).unwrap_or("").to_string())?;
    if let Some(repo_path) = payload.get("repoPath").and_then(|v| v.as_str()) {
        config::set_string(&mut cfg, "repo_path", repo_path.to_string())?;
    }
    if let Some(output_dir) = payload.get("outputDir").and_then(|v| v.as_str()) {
        config::set_string(&mut cfg, "output_dir", output_dir.to_string())?;
    }

    config::save_config(&cfg)?;
    {
        let mut runtime = state.lock().expect("runtime lock");
        runtime.repo_path = config::get_str(&cfg, "repo_path");
        runtime.output_dir = config::get_str(&cfg, "output_dir");
    }
    startup::set_run_on_startup(run_on_startup)?;
    Ok(json!({"ok": true}))
}

#[tauri::command]
pub fn add_log(payload: Value, state: tauri::State<'_, Mutex<RuntimeState>>) -> Result<Value, String> {
    let message = payload.get("message").and_then(|v| v.as_str()).unwrap_or("").trim();
    let level = payload.get("level").and_then(|v| v.as_str()).unwrap_or("INFO").trim();
    if message.is_empty() {
        return Ok(json!({"ok": false, "message": "message is required"}));
    }
    let mut runtime = state.lock().expect("runtime lock");
    push_log(&mut runtime, message, level);
    Ok(json!({"ok": true}))
}

#[tauri::command]
pub fn clear_logs(state: tauri::State<'_, Mutex<RuntimeState>>) -> Result<Value, String> {
    let mut runtime = state.lock().expect("runtime lock");
    runtime.logs.clear();
    Ok(json!({"ok": true}))
}

#[tauri::command]
pub fn set_currency(value: String, state: tauri::State<'_, Mutex<RuntimeState>>) -> Result<Value, String> {
    let value = value.trim().to_string();
    let mut runtime = state.lock().expect("runtime lock");
    runtime.currency = if value.is_empty() { "USD".to_string() } else { value };
    Ok(json!({"ok": true}))
}

#[tauri::command]
pub fn get_update_state(state: tauri::State<'_, Mutex<RuntimeState>>) -> Value {
    let mut runtime = state.lock().expect("runtime lock");
    if runtime.update_state.is_null() {
        runtime.update_state = default_update_state();
    }
    runtime.update_state.clone()
}

#[tauri::command]
pub fn check_updates(app: tauri::AppHandle, state: tauri::State<'_, Mutex<RuntimeState>>) -> Result<Value, String> {
    let cfg = config::load_config();
    let repo_slug = config::get_str(&cfg, "github_repo");
    let asset_name = config::get_str(&cfg, "github_release_asset_name");
    let token = config::get_str(&cfg, "github_token");
    let mut runtime = state.lock().expect("runtime lock");
    set_update_state(&mut runtime, "checking", "Checking for updates...", true, None);
    runtime.update_release_url.clear();
    runtime.update_asset_url.clear();
    drop(runtime);

    tauri::async_runtime::spawn_blocking(move || {
        let parsed: Result<(String, String, String), String> = (|| {
            let url = format!("https://api.github.com/repos/{repo_slug}/releases/latest");
            let mut req = ureq::get(&url)
                .set("User-Agent", "XAUUSDCalendarAgent")
                .set("Accept", "application/vnd.github+json")
                .set("X-GitHub-Api-Version", "2022-11-28");
            if !token.is_empty() {
                req = req.set("Authorization", &format!("Bearer {token}"));
            }
            let resp = req
                .call()
                .map_err(|err| format!("GitHub request failed: {err}"))?;
            let body: serde_json::Value = resp
                .into_json()
                .map_err(|e| format!("failed to parse GitHub response: {e}"))?;
            let tag = body
                .get("tag_name")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let available = normalize_version_tag(tag);
            if available.is_empty() {
                return Err("GitHub release tag_name missing".to_string());
            }
            let release_url = body
                .get("html_url")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let mut asset_url = String::new();
            if let Some(assets) = body.get("assets").and_then(|v| v.as_array()) {
                for a in assets {
                    let name = a.get("name").and_then(|v| v.as_str()).unwrap_or("");
                    if !asset_name.is_empty() && name == asset_name {
                        asset_url = a
                            .get("browser_download_url")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        break;
                    }
                }
            }
            if asset_url.is_empty() && !release_url.is_empty() {
                asset_url = release_url.clone();
            }
            Ok((available, release_url, asset_url))
        })();

        let runtime_state = app.state::<Mutex<RuntimeState>>();
        let mut runtime = runtime_state.lock().expect("runtime lock");
        match parsed {
            Ok((available, release_url, asset_url)) => {
                runtime.update_release_url = release_url.clone();
                runtime.update_asset_url = asset_url.clone();
                let current = env!("APP_VERSION");
                if cmp_versions(&available, current) == Ordering::Greater {
                    set_update_state(
                        &mut runtime,
                        "available",
                        &format!("Update available: {available}"),
                        true,
                        Some(&available),
                    );
                    push_log(&mut runtime, &format!("Update available: {available}"), "INFO");
                } else {
                    set_update_state(&mut runtime, "idle", "Up to date", true, Some(&available));
                }
            }
            Err(msg) => {
                set_update_state(&mut runtime, "error", &msg, false, None);
                push_log(&mut runtime, &format!("Update check failed: {msg}"), "ERROR");
            }
        }
    });

    Ok(json!({"ok": true}))
}

#[tauri::command]
pub fn update_now(state: tauri::State<'_, Mutex<RuntimeState>>) -> Result<Value, String> {
    let url = {
        let runtime = state.lock().expect("runtime lock");
        runtime.update_asset_url.trim().to_string()
    };
    if url.is_empty() {
        return Ok(json!({"ok": false, "message": "Update URL not available"}));
    }
    let ok = open_target(&url);
    if ok {
        Ok(json!({"ok": true}))
    } else {
        Ok(json!({"ok": false, "message": "failed to open update url"}))
    }
}

#[tauri::command]
pub fn pull_now(app: tauri::AppHandle, state: tauri::State<'_, Mutex<RuntimeState>>) -> Result<Value, String> {
    spawn_pull(app, state, "Manual pull started");
    Ok(json!({"ok": true}))
}

#[tauri::command]
pub fn sync_now(app: tauri::AppHandle, state: tauri::State<'_, Mutex<RuntimeState>>) -> Result<Value, String> {
    let cfg = config::load_config();
    let output_dir = config::get_str(&cfg, "output_dir");
    let repo_dir = config::repo_dir();
    {
        let mut runtime = state.lock().expect("runtime lock");
        runtime.sync_active = true;
        push_log(&mut runtime, "Sync started", "INFO");
    }
    tauri::async_runtime::spawn(async move {
        let result = (|| -> Result<sync_util::SyncResult, String> {
            if output_dir.trim().is_empty() {
                return Err("Output dir not configured".to_string());
            }
            let src = repo_dir.join("data").join("Economic_Calendar");
            let dst = PathBuf::from(output_dir)
                .join("data")
                .join("Economic_Calendar");
            sync_util::mirror_sync(&src, &dst)
        })();
        let runtime_state = app.state::<Mutex<RuntimeState>>();
        let mut runtime = runtime_state.lock().expect("runtime lock");
        runtime.sync_active = false;
        match result {
            Ok(res) => {
                runtime.last_sync = now_display_time();
                runtime.last_sync_at = now_iso_time();
                push_log(
                    &mut runtime,
                    &format!(
                        "Sync finished (copied {}, deleted {}, skipped {})",
                        res.copied, res.deleted, res.skipped
                    ),
                    "INFO",
                );
            }
            Err(err) => {
                push_log(&mut runtime, &format!("Sync failed: {err}"), "ERROR");
            }
        }
    });
    Ok(json!({"ok": true}))
}

#[tauri::command]
pub fn frontend_boot_complete(app: tauri::AppHandle, state: tauri::State<'_, Mutex<RuntimeState>>) -> Result<Value, String> {
    let app = app.clone();
    let state = state.clone();
    let should_auto_pull = {
        let mut runtime = state.lock().expect("runtime lock");
        if !runtime.boot_logged {
            runtime.boot_logged = true;
            push_log(&mut runtime, "Boot complete", "INFO");
        }
        if runtime.auto_pull_started || runtime.pull_active {
            false
        } else {
            true
        }
    };
    if should_auto_pull {
        {
            let mut runtime = state.lock().expect("runtime lock");
            runtime.auto_pull_started = true;
        }
        spawn_pull(app.clone(), state.clone(), "Auto pull started");
    }
    let should_check_updates = {
        let mut runtime = state.lock().expect("runtime lock");
        if runtime.auto_update_check_started {
            false
        } else {
            runtime.auto_update_check_started = true;
            true
        }
    };
    if should_check_updates {
        let _ = check_updates(app, state);
    }
    Ok(json!({"ok": true}))
}

pub fn start_background_tasks(app: tauri::AppHandle) {
    let app_handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let interval = Duration::from_secs(60 * 60);
        loop {
            std::thread::sleep(interval);
            let state = app_handle.state::<Mutex<RuntimeState>>();
            spawn_pull(app_handle.clone(), state, "Scheduled pull started");
        }
    });
}

#[tauri::command]
pub fn set_ui_state(_payload: Value) -> Result<Value, String> {
    Ok(json!({"ok": true}))
}

#[tauri::command]
pub fn get_temporary_path_task() -> Value {
    json!({
        "ok": true,
        "active": false,
        "phase": "idle",
        "progress": 0,
        "message": "",
        "path": ""
    })
}

#[tauri::command]
pub fn probe_temporary_path(payload: Value) -> Value {
    let path = payload
        .get("temporaryPath")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    json!({
        "ok": true,
        "status": "ready",
        "ready": true,
        "needsConfirmation": false,
        "canUseAsIs": true,
        "canReset": false,
        "path": path,
        "message": "",
        "details": {},
        "taskActive": false,
        "taskPath": ""
    })
}

#[tauri::command]
pub fn temporary_path_use_as_is(_payload: Value) -> Value {
    json!({"ok": true})
}

#[tauri::command]
pub fn temporary_path_reset(_payload: Value) -> Value {
    json!({"ok": true})
}

#[tauri::command]
pub fn browse_temporary_path(app: tauri::AppHandle) -> Value {
    let picked = app.dialog().file().blocking_pick_folder();
    match picked {
        Some(path) => json!({"ok": true, "path": path.to_string()}),
        None => json!({"ok": true}),
    }
}

#[tauri::command]
pub fn set_temporary_path(path: String, state: tauri::State<'_, Mutex<RuntimeState>>) -> Result<Value, String> {
    let mut cfg = config::load_config();
    config::set_string(&mut cfg, "temporary_path", path.clone())?;
    config::save_config(&cfg)?;
    let _ = state;
    Ok(json!({"ok": true}))
}

#[tauri::command]
pub fn browse_output_dir(app: tauri::AppHandle) -> Value {
    let picked = app.dialog().file().blocking_pick_folder();
    match picked {
        Some(path) => json!({"ok": true, "path": path.to_string()}),
        None => json!({"ok": true}),
    }
}

#[tauri::command]
pub fn set_output_dir(path: String, state: tauri::State<'_, Mutex<RuntimeState>>) -> Result<Value, String> {
    let mut cfg = config::load_config();
    config::set_string(&mut cfg, "output_dir", path.clone())?;
    config::save_config(&cfg)?;
    let mut runtime = state.lock().expect("runtime lock");
    runtime.output_dir = path;
    Ok(json!({"ok": true}))
}

#[tauri::command]
pub fn open_log() -> Value {
    let path = config::log_dir().join("app.log");
    let ok = open_target(&path.to_string_lossy());
    if ok {
        json!({"ok": true})
    } else {
        json!({"ok": false, "message": "failed to open log"})
    }
}

#[tauri::command]
pub fn open_path(path: String) -> Value {
    let path = path.trim().to_string();
    if path.is_empty() {
        return json!({"ok": false, "message": "path is required"});
    }
    let ok = open_target(&path);
    if ok {
        json!({"ok": true})
    } else {
        json!({"ok": false, "message": "failed to open path"})
    }
}

#[tauri::command]
pub fn open_url(url: String) -> Value {
    let url = url.trim().to_string();
    if url.is_empty() {
        return json!({"ok": false, "message": "url is required"});
    }
    let ok = open_target(&url);
    if ok {
        json!({"ok": true})
    } else {
        json!({"ok": false, "message": "failed to open url"})
    }
}

#[tauri::command]
pub fn open_release_notes(state: tauri::State<'_, Mutex<RuntimeState>>) -> Value {
    let url = {
        let runtime = state.lock().expect("runtime lock");
        runtime.update_release_url.trim().to_string()
    };
    if url.is_empty() {
        return json!({"ok": false, "message": "Release notes URL not available"});
    }
    let ok = open_target(&url);
    if ok {
        json!({"ok": true})
    } else {
        json!({"ok": false, "message": "failed to open release notes"})
    }
}

#[tauri::command]
pub fn uninstall(_payload: Value) -> Value {
    let confirm = _payload
        .get("confirm")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_uppercase();
    if confirm != "UNINSTALL" {
        return json!({"ok": false, "message": "Confirm token invalid"});
    }

    let remove_logs = _payload.get("removeLogs").and_then(|v| v.as_bool()).unwrap_or(true);
    let remove_output = _payload.get("removeOutput").and_then(|v| v.as_bool()).unwrap_or(false);
    let remove_temporary = _payload
        .get("removeTemporaryPaths")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);

    let cfg = config::load_config();
    let mut removed = vec![];
    let mut failed = vec![];

    let config_path = config::config_path();
    if config_path.exists() {
        match std::fs::remove_file(&config_path) {
            Ok(_) => removed.push(config_path.to_string_lossy().to_string()),
            Err(e) => failed.push(format!("config: {e}")),
        }
    }

    if remove_logs {
        let repo_dir = config::repo_dir();
        if repo_dir.exists() {
            match std::fs::remove_dir_all(&repo_dir) {
                Ok(_) => removed.push(repo_dir.to_string_lossy().to_string()),
                Err(e) => failed.push(format!("repo: {e}")),
            }
        }

        let log_dir = config::log_dir();
        if log_dir.exists() {
            match std::fs::remove_dir_all(&log_dir) {
                Ok(_) => removed.push(log_dir.to_string_lossy().to_string()),
                Err(e) => failed.push(format!("logs: {e}")),
            }
        }
    }

    if remove_output {
        let output_dir = config::get_str(&cfg, "output_dir");
        if !output_dir.trim().is_empty() {
            let dir = PathBuf::from(output_dir);
            if dir.exists() {
                match std::fs::remove_dir_all(&dir) {
                    Ok(_) => removed.push(dir.to_string_lossy().to_string()),
                    Err(e) => failed.push(format!("output: {e}")),
                }
            }
        }
    }

    if remove_temporary {
        let temp_dir = config::get_str(&cfg, "temporary_path");
        if !temp_dir.trim().is_empty() {
            let dir = PathBuf::from(temp_dir);
            if dir.exists() {
                match std::fs::remove_dir_all(&dir) {
                    Ok(_) => removed.push(dir.to_string_lossy().to_string()),
                    Err(e) => failed.push(format!("temporary: {e}")),
                }
            }
        }
    }

    if failed.is_empty() {
        json!({"ok": true, "removed": removed})
    } else {
        json!({"ok": false, "message": failed.join("; "), "removed": removed})
    }
}

#[tauri::command]
pub fn dismiss_modal(_payload: Value) -> Value {
    json!({"ok": true})
}

#[tauri::command]
pub fn get_event_history(_payload: Value) -> Value {
    let event = _payload.get("event").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let cur = _payload.get("cur").and_then(|v| v.as_str()).unwrap_or("").trim().to_uppercase();
    if event.is_empty() || cur.is_empty() {
        return json!({"ok": false, "message": "event and cur are required"});
    }

    let cfg = config::load_config();
    let repo_path = resolve_calendar_repo_path(&cfg);
    let Some(repo_path) = repo_path else {
        return json!({"ok": false, "message": "Calendar repo is not available yet. Run Pull first."});
    };

    let mut points = vec![];
    for item in load_calendar_events(&repo_path) {
        if item.currency.to_uppercase() != cur {
            continue;
        }
        if item.event.trim() != event {
            continue;
        }
        points.push(json!({
            "date": item.dt_utc.format("%Y-%m-%d").to_string(),
            "time": item.time_label,
            "actual": item.actual,
            "forecast": item.forecast,
            "previous": item.previous
        }));
    }

    if points.is_empty() {
        return json!({
            "ok": false,
            "eventId": format!("{cur}:{event}"),
            "metric": event,
            "cur": cur,
            "message": "No history points found in loaded calendar window."
        });
    }

    json!({
        "ok": true,
        "eventId": format!("{cur}:{event}"),
        "metric": event,
        "frequency": "",
        "period": "",
        "cur": cur,
        "points": points,
        "cached": false
    })
}

fn open_target(target: &str) -> bool {
    #[cfg(target_os = "windows")]
    {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        let operation: Vec<u16> = OsStr::new("open").encode_wide().chain(Some(0)).collect();
        let file: Vec<u16> = OsStr::new(target).encode_wide().chain(Some(0)).collect();

        // ShellExecuteW returns a value greater than 32 if successful.
        let result = unsafe {
            ShellExecuteW(
                0,
                operation.as_ptr(),
                file.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        };
        return (result as isize) > 32;
    }
    #[cfg(target_os = "macos")]
    {
        return std::process::Command::new("open").arg(target).spawn().is_ok();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        return std::process::Command::new("xdg-open").arg(target).spawn().is_ok();
    }
}
