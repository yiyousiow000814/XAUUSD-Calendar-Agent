use super::*;

#[tauri::command]
pub fn get_event_history(_payload: Value) -> Value {
    let event = _payload
        .get("event")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let cur = _payload
        .get("cur")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_uppercase();
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
