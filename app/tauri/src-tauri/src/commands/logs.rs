use super::*;

#[tauri::command]
pub fn add_log(
    payload: Value,
    state: tauri::State<'_, Mutex<RuntimeState>>,
) -> Result<Value, String> {
    let message = payload
        .get("message")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let level = payload
        .get("level")
        .and_then(|v| v.as_str())
        .unwrap_or("INFO")
        .trim();
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
