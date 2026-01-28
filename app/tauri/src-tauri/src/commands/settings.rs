use super::*;

#[tauri::command]
pub fn get_settings(_state: tauri::State<'_, Mutex<RuntimeState>>) -> Value {
    let cfg = config::load_config();
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
        if v == "dark" || v == "light" {
            v
        } else {
            "system".to_string()
        }
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
        "repoPath": config::install_dir().to_string_lossy().to_string(),
        "logPath": config::log_dir().join("app.log").to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub fn save_settings(
    payload: Value,
    state: tauri::State<'_, Mutex<RuntimeState>>,
) -> Result<Value, String> {
    let mut cfg = config::load_config();
    config::set_bool(
        &mut cfg,
        "auto_sync_after_pull",
        payload
            .get("autoSyncAfterPull")
            .and_then(|v| v.as_bool())
            .unwrap_or(true),
    )?;
    config::set_bool(
        &mut cfg,
        "auto_update_enabled",
        payload
            .get("autoUpdateEnabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(true),
    )?;
    let run_on_startup = payload
        .get("runOnStartup")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    config::set_bool(&mut cfg, "run_on_startup", run_on_startup)?;
    config::set_string(
        &mut cfg,
        "autostart_launch_mode",
        payload
            .get("autostartLaunchMode")
            .and_then(|v| v.as_str())
            .unwrap_or("tray")
            .to_string(),
    )?;
    config::set_string(
        &mut cfg,
        "close_behavior",
        payload
            .get("closeBehavior")
            .and_then(|v| v.as_str())
            .unwrap_or("exit")
            .to_string(),
    )?;
    config::set_bool(
        &mut cfg,
        "debug",
        payload
            .get("debug")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
    )?;
    config::set_bool(
        &mut cfg,
        "settings_auto_save",
        payload
            .get("autoSave")
            .and_then(|v| v.as_bool())
            .unwrap_or(true),
    )?;
    if let Some(v) = payload.get("splitRatio").and_then(|v| v.as_f64()) {
        let obj = cfg.as_object_mut().ok_or("config invalid")?;
        obj.insert("split_ratio".to_string(), json!(v));
    }
    config::set_bool(
        &mut cfg,
        "enable_system_theme",
        payload
            .get("enableSystemTheme")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
    )?;
    config::set_string(
        &mut cfg,
        "theme_preference",
        payload
            .get("theme")
            .and_then(|v| v.as_str())
            .unwrap_or("system")
            .to_string(),
    )?;
    config::set_string(
        &mut cfg,
        "calendar_timezone_mode",
        payload
            .get("calendarTimezoneMode")
            .and_then(|v| v.as_str())
            .unwrap_or("system")
            .to_string(),
    )?;
    if let Some(minutes) = payload
        .get("calendarUtcOffsetMinutes")
        .and_then(|v| v.as_i64())
    {
        config::set_number(&mut cfg, "calendar_utc_offset_minutes", minutes)?;
    }
    config::set_bool(
        &mut cfg,
        "enable_temporary_path",
        payload
            .get("enableTemporaryPath")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
    )?;
    config::set_string(
        &mut cfg,
        "temporary_path",
        payload
            .get("temporaryPath")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
    )?;
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
pub fn set_currency(
    value: String,
    state: tauri::State<'_, Mutex<RuntimeState>>,
) -> Result<Value, String> {
    let value = value.trim().to_string();
    let mut runtime = state.lock().expect("runtime lock");
    runtime.currency = if value.is_empty() {
        "USD".to_string()
    } else {
        value
    };
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
pub fn set_temporary_path(
    path: String,
    state: tauri::State<'_, Mutex<RuntimeState>>,
) -> Result<Value, String> {
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
pub fn set_output_dir(
    path: String,
    state: tauri::State<'_, Mutex<RuntimeState>>,
) -> Result<Value, String> {
    let mut cfg = config::load_config();
    config::set_string(&mut cfg, "output_dir", path.clone())?;
    config::save_config(&cfg)?;
    let mut runtime = state.lock().expect("runtime lock");
    runtime.output_dir = path;
    Ok(json!({"ok": true}))
}
