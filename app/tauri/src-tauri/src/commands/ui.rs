use super::*;

#[tauri::command]
pub fn frontend_boot_complete(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<RuntimeState>>,
) -> Result<Value, String> {
    let app = app.clone();
    let state = state.clone();
    let should_auto_pull = {
        let mut runtime = state.lock().expect("runtime lock");
        if !runtime.boot_logged {
            runtime.boot_logged = true;
            push_log(&mut runtime, "Boot complete", "INFO");
        }
        !(runtime.auto_pull_started || runtime.pull_active)
    };
    if should_auto_pull {
        {
            let mut runtime = state.lock().expect("runtime lock");
            runtime.auto_pull_started = true;
        }
        super::pull::spawn_pull(app.clone(), state.clone(), "Auto pull started");
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
        let _ = super::update::check_updates(app, state);
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
            super::pull::spawn_pull(app_handle.clone(), state, "Scheduled pull started");
        }
    });

    // Watch config changes (portable `user-data/config.json`) so edits (e.g. github_token) reflect
    // immediately without waiting for a UI snapshot refresh.
    let app_handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let config_path = config::config_path();
        // Also check once at startup if a token exists and hasn't been seen yet.
        {
            let cfg = config::load_config();
            let token = config::get_str(&cfg, "github_token");
            if !token.is_empty() {
                super::update::try_begin_github_token_check(app_handle.clone(), token);
            }
        }
        let mut last_mtime = file_mtime_ms(&config_path).unwrap_or(0);
        loop {
            std::thread::sleep(Duration::from_millis(250));
            let mtime = file_mtime_ms(&config_path).unwrap_or(0);
            if mtime <= 0 || mtime == last_mtime {
                continue;
            }
            last_mtime = mtime;
            let cfg = config::load_config();
            let token = config::get_str(&cfg, "github_token");
            if !token.is_empty() {
                super::update::try_begin_github_token_check(app_handle.clone(), token);
            }
        }
    });
}

#[tauri::command]
pub fn set_ui_state(_payload: Value) -> Result<Value, String> {
    Ok(json!({"ok": true}))
}
