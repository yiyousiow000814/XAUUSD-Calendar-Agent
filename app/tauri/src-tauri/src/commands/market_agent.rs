use crate::config;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

fn repo_root_from_manifest() -> Option<PathBuf> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest.parent()?.parent()?.parent().map(Path::to_path_buf)
}

fn candidate_roots() -> Vec<PathBuf> {
    let cfg = config::load_config();
    let mut roots = vec![config::appdata_dir(), config::working_root_dir(&cfg)];
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd.clone());
        roots.push(cwd.join("user-data"));
    }
    roots.push(config::install_dir());
    roots.push(config::install_dir().join("user-data"));
    if let Some(repo_root) = repo_root_from_manifest() {
        roots.push(repo_root.clone());
        roots.push(repo_root.join("user-data"));
    }
    let mut unique = vec![];
    for root in roots {
        if !unique.iter().any(|existing: &PathBuf| existing == &root) {
            unique.push(root);
        }
    }
    unique
}

fn state_path_for_root(root: &Path) -> PathBuf {
    root.join("market_agent_state.json")
}

fn alerts_path_for_root(root: &Path) -> PathBuf {
    root.join("market_agent_alerts.ndjson")
}

fn resolve_market_agent_root() -> Option<PathBuf> {
    candidate_roots()
        .into_iter()
        .find(|root| state_path_for_root(root).exists() || alerts_path_for_root(root).exists())
}

fn read_json_file(path: &Path) -> Option<Value> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str::<Value>(&text).ok()
}

fn read_alert_rows(path: &Path, limit: usize) -> Vec<Value> {
    let mut rows: Vec<Value> = fs::read_to_string(path)
        .ok()
        .map(|text| {
            text.lines()
                .filter_map(|line| {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        return None;
                    }
                    serde_json::from_str::<Value>(trimmed).ok()
                })
                .collect()
        })
        .unwrap_or_default();
    rows.sort_by(|a, b| {
        let av = a.get("time").and_then(|v| v.as_str()).unwrap_or("");
        let bv = b.get("time").and_then(|v| v.as_str()).unwrap_or("");
        bv.cmp(av)
    });
    if rows.len() > limit {
        rows.truncate(limit);
    }
    rows
}

pub(crate) fn read_market_agent_snapshot(root: &Path, limit: usize) -> Value {
    let state_path = state_path_for_root(root);
    let alerts_path = alerts_path_for_root(root);
    let state = read_json_file(&state_path);
    let alerts = read_alert_rows(&alerts_path, limit);
    json!({
        "ok": true,
        "available": state.is_some() || !alerts.is_empty(),
        "state_path": state_path.display().to_string(),
        "alerts_path": alerts_path.display().to_string(),
        "state": state.unwrap_or(Value::Null),
        "alerts": alerts,
    })
}

#[tauri::command]
pub fn get_market_agent_snapshot(payload: Value) -> Value {
    let limit = payload
        .get("limit")
        .and_then(|v| v.as_u64())
        .map(|v| v as usize)
        .unwrap_or(5)
        .clamp(1, 50);
    let Some(root) = resolve_market_agent_root() else {
        return json!({
            "ok": true,
            "available": false,
            "state": Value::Null,
            "alerts": [],
            "message": "Market agent artifacts are not available yet."
        });
    };
    read_market_agent_snapshot(&root, limit)
}

#[cfg(test)]
mod tests {
    use super::read_market_agent_snapshot;
    use serde_json::json;
    use std::fs;
    use std::path::PathBuf;

    fn unique_temp_dir(name: &str) -> PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "xauusd-market-agent-test-{}-{}",
            name,
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("create temp dir");
        path
    }

    #[test]
    fn reads_market_agent_state_and_latest_alerts() {
        let dir = unique_temp_dir("snapshot");
        fs::write(
            dir.join("market_agent_state.json"),
            serde_json::to_string_pretty(&json!({
                "current_bias": "bearish_gold",
                "main_driver": "yields",
                "secondary_driver": "usd",
                "risk_driver": null,
                "confidence": "high",
                "cause_status": "confirmed",
                "last_alert_time": "2026-05-19T08:00:00+08:00",
                "last_alert_summary": "Gold remains under pressure.",
                "last_analysis_time": "2026-05-19T08:05:00+08:00",
                "last_notification_level": "level_3",
                "state_change_reason": "main_driver usd -> yields",
                "invalidation_triggered": false,
                "invalidation_triggered_by": [],
                "invalidation_conditions": ["US10Y drops more than 7 bps"]
            }))
            .expect("serialize state"),
        )
        .expect("write state");
        fs::write(
            dir.join("market_agent_alerts.ndjson"),
            [
                json!({
                    "time": "2026-05-19T08:00:00+08:00",
                    "notification_level": "level_3",
                    "message": "Gold remains under pressure.",
                    "main_driver": "yields",
                    "bias": "bearish_gold"
                })
                .to_string(),
                json!({
                    "time": "2026-05-19T07:00:00+08:00",
                    "notification_level": "level_1",
                    "message": "Earlier ping",
                    "main_driver": "unknown",
                    "bias": "unknown"
                })
                .to_string(),
            ]
            .join("\n"),
        )
        .expect("write alerts");

        let payload = read_market_agent_snapshot(&dir, 1);

        assert_eq!(payload.get("ok").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(
            payload.get("available").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            payload
                .get("state")
                .and_then(|v| v.get("main_driver"))
                .and_then(|v| v.as_str()),
            Some("yields")
        );
        let alerts = payload
            .get("alerts")
            .and_then(|v| v.as_array())
            .expect("alerts array");
        assert_eq!(alerts.len(), 1);
        assert_eq!(
            alerts[0].get("message").and_then(|v| v.as_str()),
            Some("Gold remains under pressure.")
        );
    }
}
