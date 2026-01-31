use crate::config;
use serde_json::{json, Value};
use std::fs;

#[tauri::command]
pub fn get_event_impact_usd(payload: Value) -> Value {
    let event_id = payload
        .get("eventId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let bucket = payload
        .get("bucket")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if event_id.is_empty() || bucket.is_empty() {
        return json!({"ok": false, "message": "eventId and bucket are required"});
    }

    // Stored locally (not committed). The generator script writes this file.
    let analysis_dir = config::analysis_dir();
    let path = analysis_dir.join("xauusd_event_impact_usd.json");
    let text = match fs::read_to_string(&path) {
        Ok(v) => v,
        Err(_) => {
            return json!({
                "ok": false,
                "message": format!(
                    "Impact analysis data not found at {}. Generate it locally first.",
                    path.display()
                )
            })
        }
    };
    let parsed: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => return json!({"ok": false, "message": format!("Invalid analysis JSON: {e}")}),
    };
    if parsed.get("schema").and_then(|v| v.as_i64()).unwrap_or(0) != 1 {
        return json!({"ok": false, "message": "Unsupported analysis JSON schema"});
    }
    let events = parsed.get("events").and_then(|v| v.as_object());
    let Some(events) = events else {
        return json!({"ok": false, "message": "Analysis JSON missing events"});
    };
    let Some(event) = events.get(&event_id) else {
        return json!({"ok": false, "message": "No analysis for this eventId"});
    };
    let Some(buckets) = event.as_object() else {
        return json!({"ok": false, "message": "Analysis JSON invalid event payload"});
    };
    let Some(data) = buckets.get(&bucket) else {
        return json!({"ok": false, "message": "No analysis for this bucket"});
    };

    json!({
        "ok": true,
        "eventId": event_id,
        "bucket": bucket,
        "windowsMinutes": parsed.get("windows_minutes").cloned().unwrap_or(Value::Null),
        "data": data.clone()
    })
}
