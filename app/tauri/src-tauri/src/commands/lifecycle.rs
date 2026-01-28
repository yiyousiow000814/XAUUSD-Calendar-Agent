use super::*;

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
