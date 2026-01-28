use super::*;

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
