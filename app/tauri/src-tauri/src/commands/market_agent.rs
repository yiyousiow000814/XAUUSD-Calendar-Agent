use crate::config;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

type LatestMonitorRun = (i64, String, String);
type LatestPayloadRows = (Option<i64>, Option<String>, Vec<Value>);

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

fn timeline_path_for_root(root: &Path) -> PathBuf {
    root.join("market_agent_timeline.sqlite")
}

fn resolve_market_agent_root() -> Option<PathBuf> {
    candidate_roots().into_iter().find(|root| {
        state_path_for_root(root).exists()
            || alerts_path_for_root(root).exists()
            || timeline_path_for_root(root).exists()
    })
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

fn open_timeline_db(root: &Path) -> Result<Connection, String> {
    let timeline_path = timeline_path_for_root(root);
    if !timeline_path.exists() {
        return Err("Market agent timeline store is not available yet.".to_string());
    }
    Connection::open(&timeline_path)
        .map_err(|err| format!("Unable to open market agent timeline store: {err}"))
}

fn table_exists(connection: &Connection, table: &str) -> bool {
    connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1 LIMIT 1",
            [table],
            |_| Ok(()),
        )
        .optional()
        .ok()
        .flatten()
        .is_some()
}

fn parse_json_value(raw: String) -> Option<Value> {
    serde_json::from_str::<Value>(&raw).ok()
}

fn query_payload_rows(
    connection: &Connection,
    sql: &str,
    params: &[&dyn rusqlite::ToSql],
) -> Result<Vec<Value>, rusqlite::Error> {
    let mut statement = connection.prepare(sql)?;
    let rows = statement.query_map(rusqlite::params_from_iter(params.iter()), |row| {
        row.get::<_, String>(0)
    })?;
    let mut payloads = Vec::new();
    for raw in rows.flatten() {
        if let Some(value) = parse_json_value(raw) {
            payloads.push(value);
        }
    }
    Ok(payloads)
}

fn query_latest_monitor_run(
    connection: &Connection,
) -> Result<Option<LatestMonitorRun>, rusqlite::Error> {
    if !table_exists(connection, "monitor_runs") {
        return Ok(None);
    }
    connection
        .query_row(
            "SELECT id, run_started_at, data_mode FROM monitor_runs ORDER BY id DESC LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
}

fn read_provider_health_latest(
    connection: &Connection,
) -> Result<LatestPayloadRows, rusqlite::Error> {
    if !table_exists(connection, "provider_health") {
        return Ok((None, None, vec![]));
    }
    let Some((monitor_run_id, run_started_at, _data_mode)) = query_latest_monitor_run(connection)?
    else {
        return Ok((None, None, vec![]));
    };
    let mut statement = connection.prepare(
        "SELECT provider_key, payload_json FROM provider_health WHERE monitor_run_id = ?1 ORDER BY id",
    )?;
    let rows = statement.query_map([monitor_run_id], |row| {
        let provider_key: String = row.get(0)?;
        let payload_raw: String = row.get(1)?;
        Ok((provider_key, payload_raw))
    })?;
    let mut payloads = vec![];
    for row in rows.flatten() {
        let (provider_key, payload_raw) = row;
        if let Some(mut payload) = parse_json_value(payload_raw) {
            if let Some(object) = payload.as_object_mut() {
                object.insert("provider_key".to_string(), Value::String(provider_key));
                object.insert("monitor_run_id".to_string(), Value::from(monitor_run_id));
                object.insert(
                    "run_started_at".to_string(),
                    Value::String(run_started_at.clone()),
                );
            }
            payloads.push(payload);
        }
    }
    Ok((Some(monitor_run_id), Some(run_started_at), payloads))
}

fn read_driver_attention_latest(
    connection: &Connection,
) -> Result<LatestPayloadRows, rusqlite::Error> {
    if !table_exists(connection, "driver_attention_states") {
        return Ok((None, None, vec![]));
    }
    let Some((monitor_run_id, run_started_at, _data_mode)) = query_latest_monitor_run(connection)?
    else {
        return Ok((None, None, vec![]));
    };
    let payloads = query_payload_rows(
        connection,
        "SELECT payload_json FROM driver_attention_states WHERE monitor_run_id = ?1 ORDER BY id",
        &[&monitor_run_id],
    )?
    .into_iter()
    .map(|mut payload| {
        if let Some(object) = payload.as_object_mut() {
            object.insert("monitor_run_id".to_string(), Value::from(monitor_run_id));
            object.insert(
                "run_started_at".to_string(),
                Value::String(run_started_at.clone()),
            );
        }
        payload
    })
    .collect();
    Ok((Some(monitor_run_id), Some(run_started_at), payloads))
}

fn read_range_payloads(
    connection: &Connection,
    table: &str,
    time_column: &str,
    start: &str,
    end: &str,
) -> Result<Vec<Value>, rusqlite::Error> {
    if !table_exists(connection, table) {
        return Ok(vec![]);
    }
    let sql = format!(
        "SELECT payload_json FROM {table} WHERE {time_column} >= ?1 AND {time_column} <= ?2 ORDER BY {time_column}, id"
    );
    query_payload_rows(connection, &sql, &[&start, &end])
}

fn read_related_assets_map(
    connection: &Connection,
    start: &str,
    end: &str,
) -> Result<Value, rusqlite::Error> {
    let symbols = [
        "dxy", "us10y", "us2y", "wti", "brent", "vix", "spx", "nasdaq",
    ];
    let mut related = serde_json::Map::new();
    for symbol in symbols {
        let rows = if table_exists(connection, "related_asset_bars") {
            query_payload_rows(
                connection,
                "SELECT payload_json FROM related_asset_bars WHERE symbol = ?1 AND data_timestamp >= ?2 AND data_timestamp <= ?3 ORDER BY data_timestamp, id",
                &[&symbol, &start, &end],
            )?
        } else {
            vec![]
        };
        related.insert(symbol.to_string(), Value::Array(rows));
    }
    Ok(Value::Object(related))
}

fn read_timeline_items(
    connection: &Connection,
    start: &str,
    end: &str,
) -> Result<Vec<Value>, rusqlite::Error> {
    if !table_exists(connection, "timeline_events") {
        return Ok(vec![]);
    }
    let mut statement = connection.prepare(
        "SELECT monitor_run_id, event_time, event_type, label, payload_json FROM timeline_events WHERE event_time >= ?1 AND event_time <= ?2 ORDER BY event_time, id",
    )?;
    let rows = statement.query_map(params![start, end], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
        ))
    })?;
    let mut items = vec![];
    for row in rows.flatten() {
        let (monitor_run_id, event_time, event_type, label, payload_raw) = row;
        if let Some(payload) = parse_json_value(payload_raw) {
            items.push(json!({
                "monitor_run_id": monitor_run_id,
                "event_time": event_time,
                "event_type": event_type,
                "label": label,
                "payload": payload,
            }));
        }
    }
    Ok(items)
}

fn read_state_transitions(
    connection: &Connection,
    start: &str,
    end: &str,
) -> Result<Vec<Value>, rusqlite::Error> {
    if !table_exists(connection, "state_transitions") || !table_exists(connection, "monitor_runs") {
        return Ok(vec![]);
    }
    let mut statement = connection.prepare(
        "SELECT state_transitions.monitor_run_id, monitor_runs.run_started_at, state_transitions.payload_json
         FROM state_transitions
         INNER JOIN monitor_runs ON monitor_runs.id = state_transitions.monitor_run_id
         WHERE monitor_runs.run_started_at >= ?1 AND monitor_runs.run_started_at <= ?2
         ORDER BY monitor_runs.run_started_at, state_transitions.id",
    )?;
    let rows = statement.query_map(params![start, end], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let mut items = vec![];
    for row in rows.flatten() {
        let (monitor_run_id, run_started_at, payload_raw) = row;
        if let Some(mut payload) = parse_json_value(payload_raw) {
            if let Some(object) = payload.as_object_mut() {
                object.insert("monitor_run_id".to_string(), Value::from(monitor_run_id));
                object.insert("run_started_at".to_string(), Value::String(run_started_at));
            }
            items.push(payload);
        }
    }
    Ok(items)
}

fn read_alerts(
    connection: &Connection,
    start: &str,
    end: &str,
    should_notify: Option<bool>,
) -> Result<Vec<Value>, rusqlite::Error> {
    if !table_exists(connection, "alerts") || !table_exists(connection, "monitor_runs") {
        return Ok(vec![]);
    }
    let mut items = vec![];
    if let Some(flag) = should_notify {
        let mut statement = connection.prepare(
            "SELECT alerts.monitor_run_id, monitor_runs.run_started_at, alerts.should_notify, alerts.payload_json
             FROM alerts
             INNER JOIN monitor_runs ON monitor_runs.id = alerts.monitor_run_id
             WHERE monitor_runs.run_started_at >= ?1 AND monitor_runs.run_started_at <= ?2
               AND alerts.should_notify = ?3
             ORDER BY monitor_runs.run_started_at, alerts.id",
        )?;
        let rows = statement.query_map(params![start, end, flag], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?;
        for row in rows.flatten() {
            let (monitor_run_id, run_started_at, should_notify_value, payload_raw) = row;
            if let Some(mut payload) = parse_json_value(payload_raw) {
                if let Some(object) = payload.as_object_mut() {
                    object.insert("monitor_run_id".to_string(), Value::from(monitor_run_id));
                    object.insert("run_started_at".to_string(), Value::String(run_started_at));
                    object.insert(
                        "should_notify".to_string(),
                        Value::Bool(should_notify_value != 0),
                    );
                }
                items.push(payload);
            }
        }
    } else {
        let mut statement = connection.prepare(
            "SELECT alerts.monitor_run_id, monitor_runs.run_started_at, alerts.should_notify, alerts.payload_json
             FROM alerts
             INNER JOIN monitor_runs ON monitor_runs.id = alerts.monitor_run_id
             WHERE monitor_runs.run_started_at >= ?1 AND monitor_runs.run_started_at <= ?2
             ORDER BY monitor_runs.run_started_at, alerts.id",
        )?;
        let rows = statement.query_map(params![start, end], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?;
        for row in rows.flatten() {
            let (monitor_run_id, run_started_at, should_notify_value, payload_raw) = row;
            if let Some(mut payload) = parse_json_value(payload_raw) {
                if let Some(object) = payload.as_object_mut() {
                    object.insert("monitor_run_id".to_string(), Value::from(monitor_run_id));
                    object.insert("run_started_at".to_string(), Value::String(run_started_at));
                    object.insert(
                        "should_notify".to_string(),
                        Value::Bool(should_notify_value != 0),
                    );
                }
                items.push(payload);
            }
        }
    }
    Ok(items)
}

fn read_evidence_for_run(
    connection: &Connection,
    monitor_run_id: i64,
) -> Result<Value, rusqlite::Error> {
    let evidence_packet = if table_exists(connection, "evidence_packets") {
        connection
            .query_row(
                "SELECT payload_json FROM evidence_packets WHERE monitor_run_id = ?1 ORDER BY id DESC LIMIT 1",
                [monitor_run_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .and_then(parse_json_value)
    } else {
        None
    };

    let analysis_result = if table_exists(connection, "analysis_results") {
        connection
            .query_row(
                "SELECT payload_json FROM analysis_results WHERE monitor_run_id = ?1 ORDER BY id DESC LIMIT 1",
                [monitor_run_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .and_then(parse_json_value)
    } else {
        None
    };

    let provider_health = if table_exists(connection, "provider_health") {
        let mut statement =
            connection.prepare("SELECT provider_key, payload_json FROM provider_health WHERE monitor_run_id = ?1 ORDER BY id")?;
        let rows = statement.query_map([monitor_run_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut items = vec![];
        for row in rows.flatten() {
            let (provider_key, payload_raw) = row;
            if let Some(mut payload) = parse_json_value(payload_raw) {
                if let Some(object) = payload.as_object_mut() {
                    object.insert("provider_key".to_string(), Value::String(provider_key));
                }
                items.push(payload);
            }
        }
        items
    } else {
        vec![]
    };

    let driver_attention_states = if table_exists(connection, "driver_attention_states") {
        query_payload_rows(
            connection,
            "SELECT payload_json FROM driver_attention_states WHERE monitor_run_id = ?1 ORDER BY id",
            &[&monitor_run_id],
        )?
    } else {
        vec![]
    };

    let alerts = if table_exists(connection, "alerts") {
        read_alerts_for_run(connection, monitor_run_id)?
    } else {
        vec![]
    };

    let state_transition = if table_exists(connection, "state_transitions") {
        connection
            .query_row(
                "SELECT payload_json FROM state_transitions WHERE monitor_run_id = ?1 ORDER BY id DESC LIMIT 1",
                [monitor_run_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .and_then(parse_json_value)
    } else {
        None
    };

    let monitor_run = if table_exists(connection, "monitor_runs") {
        connection
            .query_row(
                "SELECT id, run_started_at, run_type, data_mode, backfill_required, no_news_found, alert_suppressed_reason
                 FROM monitor_runs WHERE id = ?1 LIMIT 1",
                [monitor_run_id],
                |row| {
                    Ok(json!({
                        "monitor_run_id": row.get::<_, i64>(0)?,
                        "run_started_at": row.get::<_, String>(1)?,
                        "run_type": row.get::<_, String>(2)?,
                        "data_mode": row.get::<_, String>(3)?,
                        "backfill_required": row.get::<_, i64>(4)? != 0,
                        "no_news_found": row.get::<_, i64>(5)? != 0,
                        "alert_suppressed_reason": row.get::<_, Option<String>>(6)?,
                    }))
                },
            )
            .optional()?
    } else {
        None
    };

    Ok(json!({
        "monitor_run": monitor_run,
        "evidence_packet": evidence_packet,
        "analysis_result": analysis_result,
        "provider_health": provider_health,
        "driver_attention_states": driver_attention_states,
        "alerts": alerts,
        "state_transition": state_transition,
    }))
}

fn read_alerts_for_run(
    connection: &Connection,
    monitor_run_id: i64,
) -> Result<Vec<Value>, rusqlite::Error> {
    let mut statement = connection.prepare(
        "SELECT should_notify, payload_json FROM alerts WHERE monitor_run_id = ?1 ORDER BY id",
    )?;
    let rows = statement.query_map([monitor_run_id], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut items = vec![];
    for row in rows.flatten() {
        let (should_notify, payload_raw) = row;
        if let Some(mut payload) = parse_json_value(payload_raw) {
            if let Some(object) = payload.as_object_mut() {
                object.insert("should_notify".to_string(), Value::Bool(should_notify != 0));
            }
            items.push(payload);
        }
    }
    Ok(items)
}

fn build_unavailable_payload(message: &str, root: Option<&Path>) -> Value {
    let mut payload = json!({
        "ok": true,
        "available": false,
        "message": message,
    });
    if let Some(root) = root {
        if let Some(object) = payload.as_object_mut() {
            object.insert(
                "timeline_store_path".to_string(),
                Value::String(timeline_path_for_root(root).display().to_string()),
            );
        }
    }
    payload
}

pub(crate) fn read_market_agent_snapshot(root: &Path, limit: usize) -> Value {
    let state_path = state_path_for_root(root);
    let alerts_path = alerts_path_for_root(root);
    let timeline_path = timeline_path_for_root(root);
    let state = read_json_file(&state_path);
    let alerts = read_alert_rows(&alerts_path, limit);
    json!({
        "ok": true,
        "available": state.is_some() || !alerts.is_empty() || timeline_path.exists(),
        "state_path": state_path.display().to_string(),
        "alerts_path": alerts_path.display().to_string(),
        "timeline_store_path": timeline_path.display().to_string(),
        "timeline_available": timeline_path.exists(),
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

#[tauri::command]
pub fn get_market_agent_provider_health(_payload: Value) -> Value {
    let Some(root) = resolve_market_agent_root() else {
        return build_unavailable_payload("Market agent artifacts are not available yet.", None);
    };
    let timeline_path = timeline_path_for_root(&root);
    let connection = match open_timeline_db(&root) {
        Ok(connection) => connection,
        Err(message) => return build_unavailable_payload(&message, Some(&root)),
    };
    match read_provider_health_latest(&connection) {
        Ok((monitor_run_id, run_started_at, items)) => json!({
            "ok": true,
            "available": timeline_path.exists(),
            "timeline_store_path": timeline_path.display().to_string(),
            "monitor_run_id": monitor_run_id,
            "run_started_at": run_started_at,
            "items": items,
        }),
        Err(err) => build_unavailable_payload(
            &format!("Unable to read provider health: {err}"),
            Some(&root),
        ),
    }
}

#[tauri::command]
pub fn get_market_agent_driver_attention(_payload: Value) -> Value {
    let Some(root) = resolve_market_agent_root() else {
        return build_unavailable_payload("Market agent artifacts are not available yet.", None);
    };
    let timeline_path = timeline_path_for_root(&root);
    let connection = match open_timeline_db(&root) {
        Ok(connection) => connection,
        Err(message) => return build_unavailable_payload(&message, Some(&root)),
    };
    match read_driver_attention_latest(&connection) {
        Ok((monitor_run_id, run_started_at, states)) => json!({
            "ok": true,
            "available": timeline_path.exists(),
            "timeline_store_path": timeline_path.display().to_string(),
            "monitor_run_id": monitor_run_id,
            "run_started_at": run_started_at,
            "states": states,
        }),
        Err(err) => build_unavailable_payload(
            &format!("Unable to read driver attention: {err}"),
            Some(&root),
        ),
    }
}

#[tauri::command]
pub fn get_market_agent_timeline(payload: Value) -> Value {
    let start = payload.get("start").and_then(|v| v.as_str()).unwrap_or("");
    let end = payload.get("end").and_then(|v| v.as_str()).unwrap_or("");
    let Some(root) = resolve_market_agent_root() else {
        return build_unavailable_payload("Market agent artifacts are not available yet.", None);
    };
    let timeline_path = timeline_path_for_root(&root);
    let connection = match open_timeline_db(&root) {
        Ok(connection) => connection,
        Err(message) => return build_unavailable_payload(&message, Some(&root)),
    };
    match read_timeline_items(&connection, start, end) {
        Ok(items) => json!({
            "ok": true,
            "available": timeline_path.exists(),
            "timeline_store_path": timeline_path.display().to_string(),
            "start": start,
            "end": end,
            "items": items,
        }),
        Err(err) => build_unavailable_payload(
            &format!("Unable to read market agent timeline: {err}"),
            Some(&root),
        ),
    }
}

#[tauri::command]
pub fn get_market_agent_state_transitions(payload: Value) -> Value {
    let start = payload.get("start").and_then(|v| v.as_str()).unwrap_or("");
    let end = payload.get("end").and_then(|v| v.as_str()).unwrap_or("");
    let Some(root) = resolve_market_agent_root() else {
        return build_unavailable_payload("Market agent artifacts are not available yet.", None);
    };
    let timeline_path = timeline_path_for_root(&root);
    let connection = match open_timeline_db(&root) {
        Ok(connection) => connection,
        Err(message) => return build_unavailable_payload(&message, Some(&root)),
    };
    match read_state_transitions(&connection, start, end) {
        Ok(items) => json!({
            "ok": true,
            "available": timeline_path.exists(),
            "timeline_store_path": timeline_path.display().to_string(),
            "start": start,
            "end": end,
            "items": items,
        }),
        Err(err) => build_unavailable_payload(
            &format!("Unable to read state transitions: {err}"),
            Some(&root),
        ),
    }
}

#[tauri::command]
pub fn get_market_agent_suppressed_alerts(payload: Value) -> Value {
    let start = payload.get("start").and_then(|v| v.as_str()).unwrap_or("");
    let end = payload.get("end").and_then(|v| v.as_str()).unwrap_or("");
    let Some(root) = resolve_market_agent_root() else {
        return build_unavailable_payload("Market agent artifacts are not available yet.", None);
    };
    let timeline_path = timeline_path_for_root(&root);
    let connection = match open_timeline_db(&root) {
        Ok(connection) => connection,
        Err(message) => return build_unavailable_payload(&message, Some(&root)),
    };
    match read_alerts(&connection, start, end, Some(false)) {
        Ok(items) => json!({
            "ok": true,
            "available": timeline_path.exists(),
            "timeline_store_path": timeline_path.display().to_string(),
            "start": start,
            "end": end,
            "items": items,
        }),
        Err(err) => build_unavailable_payload(
            &format!("Unable to read suppressed alerts: {err}"),
            Some(&root),
        ),
    }
}

#[tauri::command]
pub fn get_market_agent_evidence_for_run(payload: Value) -> Value {
    let monitor_run_id = payload
        .get("monitorRunId")
        .or_else(|| payload.get("monitor_run_id"))
        .and_then(|v| v.as_i64())
        .unwrap_or_default();
    let Some(root) = resolve_market_agent_root() else {
        return build_unavailable_payload("Market agent artifacts are not available yet.", None);
    };
    let timeline_path = timeline_path_for_root(&root);
    let connection = match open_timeline_db(&root) {
        Ok(connection) => connection,
        Err(message) => return build_unavailable_payload(&message, Some(&root)),
    };
    match read_evidence_for_run(&connection, monitor_run_id) {
        Ok(payload) => json!({
            "ok": true,
            "available": timeline_path.exists(),
            "timeline_store_path": timeline_path.display().to_string(),
            "monitor_run_id": monitor_run_id,
            "payload": payload,
        }),
        Err(err) => build_unavailable_payload(
            &format!("Unable to read evidence for run: {err}"),
            Some(&root),
        ),
    }
}

#[tauri::command]
pub fn get_market_agent_replay(payload: Value) -> Value {
    let Some(root) = resolve_market_agent_root() else {
        return build_unavailable_payload("Market agent artifacts are not available yet.", None);
    };
    let start = payload.get("start").and_then(|v| v.as_str()).unwrap_or("");
    let end = payload.get("end").and_then(|v| v.as_str()).unwrap_or("");
    read_market_agent_replay(&root, start, end)
}

pub(crate) fn read_market_agent_replay(root: &Path, start: &str, end: &str) -> Value {
    let timeline_path = timeline_path_for_root(root);
    let connection = match open_timeline_db(root) {
        Ok(connection) => connection,
        Err(message) => return build_unavailable_payload(&message, Some(root)),
    };

    let price_series = match read_range_payloads(
        &connection,
        "market_price_bars",
        "data_timestamp",
        start,
        end,
    ) {
        Ok(rows) => rows,
        Err(err) => {
            return build_unavailable_payload(
                &format!("Unable to read market replay price series: {err}"),
                Some(root),
            )
        }
    };
    let related_assets = match read_related_assets_map(&connection, start, end) {
        Ok(rows) => rows,
        Err(err) => {
            return build_unavailable_payload(
                &format!("Unable to read related asset replay series: {err}"),
                Some(root),
            )
        }
    };
    let news_items = read_range_payloads(&connection, "news_items", "published_at", start, end)
        .unwrap_or_default();
    let calendar_events =
        read_range_payloads(&connection, "calendar_events", "scheduled_at", start, end)
            .unwrap_or_default();
    let driver_attention_timeline = if table_exists(&connection, "driver_attention_states")
        && table_exists(&connection, "monitor_runs")
    {
        query_payload_rows(
            &connection,
            "SELECT driver_attention_states.payload_json
             FROM driver_attention_states
             INNER JOIN monitor_runs ON monitor_runs.id = driver_attention_states.monitor_run_id
             WHERE monitor_runs.run_started_at >= ?1 AND monitor_runs.run_started_at <= ?2
             ORDER BY monitor_runs.run_started_at, driver_attention_states.id",
            &[&start, &end],
        )
        .unwrap_or_default()
    } else {
        vec![]
    };
    let timeline_events = read_timeline_items(&connection, start, end).unwrap_or_default();
    let state_transitions = read_state_transitions(&connection, start, end).unwrap_or_default();
    let alerts = read_alerts(&connection, start, end, Some(true)).unwrap_or_default();
    let suppressed_alerts = read_alerts(&connection, start, end, Some(false)).unwrap_or_default();

    json!({
        "ok": true,
        "available": timeline_path.exists(),
        "timeline_store_path": timeline_path.display().to_string(),
        "start": start,
        "end": end,
        "replay": {
            "price_series": price_series,
            "related_assets": related_assets,
            "news_items": news_items,
            "calendar_events": calendar_events,
            "driver_attention_timeline": driver_attention_timeline,
            "timeline_events": timeline_events,
            "state_transitions": state_transitions,
            "alerts": alerts,
            "suppressed_alerts": suppressed_alerts,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::{read_market_agent_replay, read_market_agent_snapshot, timeline_path_for_root};
    use rusqlite::{params, Connection};
    use serde_json::{json, Value};
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

    fn seed_timeline_db(path: &PathBuf) {
        let connection = Connection::open(path).expect("open sqlite");
        connection
            .execute_batch(
                "
                CREATE TABLE monitor_runs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_started_at TEXT NOT NULL,
                    run_type TEXT NOT NULL,
                    data_mode TEXT NOT NULL,
                    backfill_required INTEGER NOT NULL DEFAULT 0,
                    last_successful_run_at TEXT,
                    no_news_found INTEGER NOT NULL DEFAULT 0,
                    alert_suppressed_reason TEXT,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE provider_health (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    monitor_run_id INTEGER NOT NULL,
                    provider_key TEXT NOT NULL,
                    payload_json TEXT NOT NULL
                );
                CREATE TABLE market_price_bars (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    monitor_run_id INTEGER NOT NULL,
                    symbol TEXT NOT NULL,
                    data_timestamp TEXT NOT NULL,
                    payload_json TEXT NOT NULL
                );
                CREATE TABLE related_asset_bars (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    monitor_run_id INTEGER NOT NULL,
                    symbol TEXT NOT NULL,
                    data_timestamp TEXT NOT NULL,
                    payload_json TEXT NOT NULL
                );
                CREATE TABLE news_items (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    monitor_run_id INTEGER NOT NULL,
                    published_at TEXT NOT NULL,
                    payload_json TEXT NOT NULL
                );
                CREATE TABLE calendar_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    monitor_run_id INTEGER NOT NULL,
                    scheduled_at TEXT NOT NULL,
                    payload_json TEXT NOT NULL
                );
                CREATE TABLE driver_attention_states (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    monitor_run_id INTEGER NOT NULL,
                    payload_json TEXT NOT NULL
                );
                CREATE TABLE evidence_packets (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    monitor_run_id INTEGER NOT NULL,
                    payload_json TEXT NOT NULL
                );
                CREATE TABLE analysis_results (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    monitor_run_id INTEGER NOT NULL,
                    payload_json TEXT NOT NULL
                );
                CREATE TABLE alerts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    monitor_run_id INTEGER NOT NULL,
                    should_notify INTEGER NOT NULL,
                    payload_json TEXT NOT NULL
                );
                CREATE TABLE state_transitions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    monitor_run_id INTEGER NOT NULL,
                    payload_json TEXT NOT NULL
                );
                CREATE TABLE timeline_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    monitor_run_id INTEGER NOT NULL,
                    event_time TEXT NOT NULL,
                    event_type TEXT NOT NULL,
                    label TEXT NOT NULL,
                    payload_json TEXT NOT NULL
                );
                ",
            )
            .expect("seed schema");
        connection
            .execute(
                "INSERT INTO monitor_runs (id, run_started_at, run_type, data_mode, backfill_required, no_news_found, alert_suppressed_reason, created_at)
                 VALUES (1, '2026-05-19T08:00:00+08:00', 'recovery', 'backfilled', 1, 0, 'cooldown', '2026-05-19T08:00:00+08:00')",
                [],
            )
            .expect("insert run");
        connection
            .execute(
                "INSERT INTO provider_health (monitor_run_id, provider_key, payload_json) VALUES (?1, ?2, ?3)",
                params![
                    1,
                    "xauusd",
                    json!({
                        "source": "Yahoo Finance",
                        "source_type": "futures_proxy",
                        "data_mode": "proxy",
                        "is_available": true,
                        "is_stale": false,
                        "data_timestamp": "2026-05-19T08:00:00+08:00",
                        "fetched_at": "2026-05-19T08:00:05+08:00"
                    })
                    .to_string()
                ],
            )
            .expect("insert provider health");
        connection
            .execute(
                "INSERT INTO market_price_bars (monitor_run_id, symbol, data_timestamp, payload_json) VALUES (?1, ?2, ?3, ?4)",
                params![
                    1,
                    "GC=F",
                    "2026-05-19T08:00:00+08:00",
                    json!({
                        "symbol": "GC=F",
                        "data_timestamp": "2026-05-19T08:00:00+08:00",
                        "close_price": 4500.2,
                        "source_type": "futures_proxy",
                        "data_mode": "proxy"
                    }).to_string()
                ],
            )
            .expect("insert price row");
        connection
            .execute(
                "INSERT INTO related_asset_bars (monitor_run_id, symbol, data_timestamp, payload_json) VALUES (?1, ?2, ?3, ?4)",
                params![
                    1,
                    "dxy",
                    "2026-05-19T08:00:00+08:00",
                    json!({
                        "symbol": "dxy",
                        "data_timestamp": "2026-05-19T08:00:00+08:00",
                        "change_15m": 0.22,
                        "source_type": "proxy",
                        "data_mode": "live_seen"
                    }).to_string()
                ],
            )
            .expect("insert related row");
        connection
            .execute(
                "INSERT INTO news_items (monitor_run_id, published_at, payload_json) VALUES (?1, ?2, ?3)",
                params![
                    1,
                    "2026-05-19T07:55:00+08:00",
                    json!({
                        "title": "Fed headline",
                        "published_at": "2026-05-19T07:55:00+08:00",
                        "included": true
                    }).to_string()
                ],
            )
            .expect("insert news row");
        connection
            .execute(
                "INSERT INTO calendar_events (monitor_run_id, scheduled_at, payload_json) VALUES (?1, ?2, ?3)",
                params![
                    1,
                    "2026-05-19T08:15:00+08:00",
                    json!({
                        "title": "CPI",
                        "scheduled_at": "2026-05-19T08:15:00+08:00"
                    }).to_string()
                ],
            )
            .expect("insert calendar row");
        connection
            .execute(
                "INSERT INTO driver_attention_states (monitor_run_id, payload_json) VALUES (?1, ?2)",
                params![
                    1,
                    json!({
                        "driver_id": "yields",
                        "current_state": "active",
                        "priority": "core_structural",
                        "data_mode": "backfilled"
                    }).to_string()
                ],
            )
            .expect("insert driver state");
        connection
            .execute(
                "INSERT INTO evidence_packets (monitor_run_id, payload_json) VALUES (?1, ?2)",
                params![
                    1,
                    json!({
                        "allowed_candidate_drivers": ["yields"],
                        "blocked_drivers": {"fed_rates": "no headline"},
                        "provider_health": {"xauusd": {"source_type": "futures_proxy"}},
                    })
                    .to_string()
                ],
            )
            .expect("insert evidence");
        connection
            .execute(
                "INSERT INTO analysis_results (monitor_run_id, payload_json) VALUES (?1, ?2)",
                params![
                    1,
                    json!({
                        "main_driver": "yields",
                        "cause_status": "likely",
                        "confidence": "medium"
                    })
                    .to_string()
                ],
            )
            .expect("insert analysis");
        connection
            .execute(
                "INSERT INTO alerts (monitor_run_id, should_notify, payload_json) VALUES (?1, ?2, ?3)",
                params![
                    1,
                    1,
                    json!({
                        "time": "2026-05-19T08:00:00+08:00",
                        "message": "Gold remains under yields pressure.",
                        "notification_level": "level_3"
                    }).to_string()
                ],
            )
            .expect("insert alert");
        connection
            .execute(
                "INSERT INTO alerts (monitor_run_id, should_notify, payload_json) VALUES (?1, ?2, ?3)",
                params![
                    1,
                    0,
                    json!({
                        "time": "2026-05-19T08:05:00+08:00",
                        "message": "Suppressed duplicate.",
                        "notification_level": "level_1"
                    }).to_string()
                ],
            )
            .expect("insert suppressed alert");
        connection
            .execute(
                "INSERT INTO state_transitions (monitor_run_id, payload_json) VALUES (?1, ?2)",
                params![
                    1,
                    json!({
                        "state_change_reason": "main_driver usd -> yields"
                    })
                    .to_string()
                ],
            )
            .expect("insert transition");
        connection
            .execute(
                "INSERT INTO timeline_events (monitor_run_id, event_time, event_type, label, payload_json) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    1,
                    "2026-05-19T08:00:00+08:00",
                    "recovery_summary",
                    "Recovered move",
                    json!({
                        "monitor_run_id": 1,
                        "data_mode": "backfilled"
                    }).to_string()
                ],
            )
            .expect("insert timeline row");
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

    #[test]
    fn get_market_agent_replay_returns_replay_structure() {
        let dir = unique_temp_dir("replay");
        seed_timeline_db(&timeline_path_for_root(&dir));

        let payload = read_market_agent_replay(
            &dir,
            "2026-05-19T07:00:00+08:00",
            "2026-05-19T09:00:00+08:00",
        );

        assert_eq!(payload.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(
            payload.get("available").and_then(Value::as_bool),
            Some(true)
        );
        let replay = payload.get("replay").expect("replay");
        assert_eq!(
            replay
                .get("price_series")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(1)
        );
        assert_eq!(
            replay.get("alerts").and_then(Value::as_array).map(Vec::len),
            Some(1)
        );
        assert_eq!(
            replay
                .get("suppressed_alerts")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(1)
        );
    }

    #[test]
    fn missing_sqlite_returns_available_false_not_panic() {
        let dir = unique_temp_dir("missing");
        let payload = read_market_agent_replay(
            &dir,
            "2026-05-19T07:00:00+08:00",
            "2026-05-19T09:00:00+08:00",
        );

        assert_eq!(payload.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(
            payload.get("available").and_then(Value::as_bool),
            Some(false)
        );
    }

    #[test]
    fn malformed_timeline_rows_are_ignored_without_panicking() {
        let dir = unique_temp_dir("malformed");
        seed_timeline_db(&timeline_path_for_root(&dir));
        let connection = Connection::open(timeline_path_for_root(&dir)).expect("open sqlite");
        connection
            .execute(
                "INSERT INTO news_items (monitor_run_id, published_at, payload_json) VALUES (?1, ?2, ?3)",
                params![1, "2026-05-19T08:01:00+08:00", "{bad json"],
            )
            .expect("insert malformed row");

        let payload = read_market_agent_replay(
            &dir,
            "2026-05-19T07:00:00+08:00",
            "2026-05-19T09:00:00+08:00",
        );

        assert_eq!(payload.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(
            payload.get("available").and_then(Value::as_bool),
            Some(true)
        );
        let replay = payload.get("replay").expect("replay");
        assert_eq!(
            replay
                .get("news_items")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(1)
        );
    }
}
