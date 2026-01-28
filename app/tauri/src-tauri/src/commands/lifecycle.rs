use super::*;

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

    let remove_logs = _payload
        .get("removeLogs")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let remove_output = _payload
        .get("removeOutput")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
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
        // Remove the working data directory (config/logs/working copy).
        let user_data = config::appdata_dir();
        if user_data.exists() {
            match std::fs::remove_dir_all(&user_data) {
                Ok(_) => removed.push(user_data.to_string_lossy().to_string()),
                Err(e) => failed.push(format!("user-data: {e}")),
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
pub fn dismiss_modal(payload: Value, state: tauri::State<'_, Mutex<RuntimeState>>) -> Value {
    let id = payload.get("id").and_then(|v| v.as_str()).unwrap_or("");
    let mut runtime = state.lock().expect("runtime lock");
    let current_id = runtime
        .modal
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if !id.is_empty() && id == current_id {
        runtime.modal = Value::Null;
    }
    json!({"ok": true})
}
