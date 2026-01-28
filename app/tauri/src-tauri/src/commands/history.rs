use super::*;
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::Path;

const MONTH_ALIASES: &[(&str, &str)] = &[
    ("january", "jan"),
    ("february", "feb"),
    ("march", "mar"),
    ("april", "apr"),
    ("june", "jun"),
    ("july", "jul"),
    ("august", "aug"),
    ("sept", "sep"),
    ("september", "sep"),
    ("october", "oct"),
    ("november", "nov"),
    ("december", "dec"),
];

const MONTHS: &[&str] = &[
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
];

fn normalize_period(raw: &str) -> String {
    let token = raw.trim();
    if token.is_empty() {
        return String::new();
    }
    let lowered = token.to_lowercase().replace('.', "");
    if MONTHS.contains(&lowered.as_str()) {
        return lowered;
    }
    for (alias, normalized) in MONTH_ALIASES {
        if lowered == *alias {
            return normalized.to_string();
        }
    }
    if lowered.len() == 2 {
        let bytes = lowered.as_bytes();
        if (bytes[0] == b'q' || bytes[0] == b'h') && bytes[1].is_ascii_digit() {
            return lowered;
        }
    }
    lowered
}

fn looks_like_period(token: &str) -> bool {
    let normalized = normalize_period(token);
    if normalized.is_empty() {
        return false;
    }
    if MONTHS.contains(&normalized.as_str()) {
        return true;
    }
    if normalized.len() == 2 {
        let bytes = normalized.as_bytes();
        return (bytes[0] == b'q' || bytes[0] == b'h') && bytes[1].is_ascii_digit();
    }
    false
}

fn detect_frequency(raw: &str) -> String {
    let lowered = raw.to_lowercase();
    if lowered.contains("y/y") || lowered.contains("yoy") {
        return "y/y".to_string();
    }
    if lowered.contains("m/m") || lowered.contains("mom") {
        return "m/m".to_string();
    }
    if lowered.contains("q/q") || lowered.contains("qoq") {
        return "q/q".to_string();
    }
    if lowered.contains("w/w") || lowered.contains("wow") {
        return "w/w".to_string();
    }
    String::new()
}

fn strip_known_suffixes(raw: &str) -> String {
    let mut trimmed = raw.trim().to_string();
    loop {
        let end = trimmed.trim_end();
        if !end.ends_with(')') {
            break;
        }
        let open_idx = end.rfind('(');
        let Some(open_idx) = open_idx else {
            break;
        };
        let token = end[open_idx + 1..end.len() - 1].trim();
        let normalized = token.to_lowercase().replace('.', "");
        let is_freq = normalized.contains("y/y")
            || normalized.contains("yoy")
            || normalized.contains("m/m")
            || normalized.contains("mom")
            || normalized.contains("q/q")
            || normalized.contains("qoq")
            || normalized.contains("w/w")
            || normalized.contains("wow");
        if looks_like_period(token) || is_freq {
            trimmed = end[..open_idx].trim_end().to_string();
            continue;
        }
        break;
    }
    trimmed
}

fn build_event_id(cur: &str, event: &str) -> (String, String, String) {
    let currency = {
        let c = cur.trim().to_uppercase();
        if c.is_empty() || c == "--" || c == "-" {
            "NA".to_string()
        } else {
            c
        }
    };
    let raw = event.trim();
    let frequency = detect_frequency(raw);
    let period = {
        let end = raw.rfind(')').and_then(|idx| raw[..=idx].rfind('('));
        if let Some(open_idx) = end {
            let token = raw[open_idx + 1..].trim();
            if let Some(stripped) = token.strip_suffix(')') {
                let token = stripped.trim();
                if looks_like_period(token) {
                    token.to_string()
                } else {
                    String::new()
                }
            } else {
                String::new()
            }
        } else {
            String::new()
        }
    };
    let metric = strip_known_suffixes(raw)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .replace("::", " ");
    let freq_token = if frequency.is_empty() {
        "none".to_string()
    } else {
        frequency.clone()
    };
    let event_id = format!("{currency}::{metric}::{freq_token}");
    (event_id, metric, period)
}

fn normalize_metric_key(value: &str) -> String {
    let lowered = value.to_lowercase();
    let mut normalized = String::with_capacity(lowered.len());
    let mut last_was_space = false;
    for ch in lowered.chars() {
        let is_keep = ch.is_ascii_alphanumeric() || ch == '/' || ch == '%';
        if is_keep {
            normalized.push(ch);
            last_was_space = false;
        } else if !last_was_space {
            normalized.push(' ');
            last_was_space = true;
        }
    }
    normalized.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn normalize_event_id(value: &str) -> String {
    let mut parts = value.split("::");
    let cur = parts.next().unwrap_or("").trim().to_lowercase();
    let metric = parts.next().unwrap_or("").trim();
    let freq = parts.next().unwrap_or("").trim().to_lowercase();
    if cur.is_empty() || metric.is_empty() || freq.is_empty() {
        return value.trim().to_lowercase();
    }
    let metric_norm = normalize_metric_key(metric);
    format!("{cur}::{metric_norm}::{freq}")
}

fn load_event_history_index(path: &Path) -> Option<HashMap<String, u64>> {
    let text = std::fs::read_to_string(path).ok()?;
    let payload: Value = serde_json::from_str(&text).ok()?;
    let index = payload.get("index")?.as_object()?;
    let mut map = HashMap::new();
    for (key, value) in index {
        let offset = value.as_u64()?;
        let raw_key = key.to_string();
        insert_index_variants(&mut map, &raw_key, offset);
    }
    Some(map)
}

fn insert_index_variants(map: &mut HashMap<String, u64>, key: &str, offset: u64) {
    map.entry(key.to_string()).or_insert(offset);
    map.entry(key.to_lowercase()).or_insert(offset);
    let normalized = normalize_event_id(key);
    map.entry(normalized).or_insert(offset);
}

fn build_index_from_ndjson(path: &Path) -> Option<HashMap<String, u64>> {
    let file = File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut map = HashMap::new();
    let mut offset: u64 = 0;
    loop {
        let mut line = String::new();
        let bytes = reader.read_line(&mut line).ok()?;
        if bytes == 0 {
            break;
        }
        if line.trim().is_empty() {
            offset = offset.saturating_add(bytes as u64);
            continue;
        }
        match serde_json::from_str::<Value>(&line) {
            Ok(payload) => {
                if let Some(event_id) = payload.get("eventId").and_then(|v| v.as_str()) {
                    insert_index_variants(&mut map, event_id, offset);
                }
            }
            Err(err) => {
                eprintln!("Invalid event history line at offset {offset}: {err}");
            }
        }
        offset = offset.saturating_add(bytes as u64);
    }
    Some(map)
}

fn write_index_file(path: &Path, index: &HashMap<String, u64>) -> std::io::Result<()> {
    let mut entries: Vec<(&String, &u64)> = index.iter().collect();
    entries.sort_by(|a, b| a.0.cmp(b.0));
    let payload = json!({
        "generated_at": chrono::Utc::now().format("%d-%m-%Y %H:%M").to_string(),
        "version": 3,
        "index": entries
            .into_iter()
            .map(|(k, v)| (k.clone(), json!(v)))
            .collect::<serde_json::Map<String, Value>>()
    });
    std::fs::write(
        path,
        serde_json::to_string_pretty(&payload).unwrap_or_default(),
    )
}

fn rebuild_index_and_persist(
    ndjson_path: &Path,
    index_path: &Path,
) -> Option<HashMap<String, u64>> {
    let index = build_index_from_ndjson(ndjson_path)?;
    if let Err(err) = write_index_file(index_path, &index) {
        eprintln!("Failed to write event history index: {err}");
    }
    Some(index)
}

fn read_ndjson_line(path: &Path, offset: u64) -> Option<String> {
    let mut file = File::open(path).ok()?;
    file.seek(SeekFrom::Start(offset)).ok()?;
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    if line.trim().is_empty() {
        return None;
    }
    Some(line)
}

fn read_payload_at_offset(path: &Path, offset: u64, candidates: &[String]) -> Option<Value> {
    let line = read_ndjson_line(path, offset)?;
    let payload = serde_json::from_str::<Value>(&line).ok()?;
    if payload_event_id_matches(&payload, candidates) {
        return Some(payload);
    }
    None
}

fn points_from_payload(payload: &Value) -> Vec<Value> {
    let mut points = vec![];
    let Some(rows) = payload.get("points").and_then(|v| v.as_array()) else {
        return points;
    };
    for row in rows {
        let Some(items) = row.as_array() else {
            continue;
        };
        if items.len() < 5 {
            continue;
        }
        let to_text = |idx: usize| -> String {
            items
                .get(idx)
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string()
        };
        let date = to_text(0);
        let time = to_text(1);
        let actual = to_text(2);
        let forecast = to_text(3);
        let previous = to_text(4);
        let actual_raw = if items.len() >= 7 {
            to_text(5)
        } else {
            String::new()
        };
        let previous_raw = if items.len() >= 7 {
            to_text(6)
        } else {
            String::new()
        };
        let (previous_revised_from, period) = if items.len() >= 9 {
            (to_text(items.len() - 2), to_text(items.len() - 1))
        } else if items.len() >= 8 {
            (String::new(), to_text(items.len() - 1))
        } else {
            (String::new(), String::new())
        };
        points.push(json!({
            "date": date,
            "time": time,
            "actual": actual,
            "actualRaw": if actual_raw.is_empty() { Value::Null } else { Value::String(actual_raw) },
            "forecast": forecast,
            "previous": previous,
            "previousRaw": if previous_raw.is_empty() { Value::Null } else { Value::String(previous_raw) },
            "previousRevisedFrom": if previous_revised_from.is_empty() { Value::Null } else { Value::String(previous_revised_from) },
            "period": if period.is_empty() { Value::Null } else { Value::String(period) }
        }));
    }
    points
}

fn event_id_matches(candidate: &str, actual: &str) -> bool {
    if candidate == actual {
        return true;
    }
    if candidate.eq_ignore_ascii_case(actual) {
        return true;
    }
    normalize_event_id(candidate) == normalize_event_id(actual)
}

fn payload_event_id_matches(payload: &Value, candidates: &[String]) -> bool {
    let Some(actual) = payload.get("eventId").and_then(|v| v.as_str()) else {
        return false;
    };
    candidates
        .iter()
        .any(|candidate| event_id_matches(candidate, actual))
}

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

    let (event_id, metric, period) = build_event_id(&cur, &event);
    let history_dir = repo_path.join("data").join("event_history_index");
    let index_path = history_dir.join("event_history_by_event.index.json");
    let ndjson_path = history_dir.join("event_history_by_event.ndjson");
    let mut candidates = vec![event_id.clone(), event_id.to_lowercase()];
    candidates.push(normalize_event_id(&event_id));
    if ndjson_path.exists() {
        let mut index = if index_path.exists() {
            load_event_history_index(&index_path)
        } else {
            None
        };
        if index.is_none() {
            index = rebuild_index_and_persist(&ndjson_path, &index_path);
        }
        if let Some(index) = index {
            if let Some(offset) = candidates.iter().find_map(|key| index.get(key).copied()) {
                if let Some(payload) = read_payload_at_offset(&ndjson_path, offset, &candidates) {
                    let points = points_from_payload(&payload);
                    if !points.is_empty() {
                        return json!({
                            "ok": true,
                            "eventId": payload.get("eventId").and_then(|v| v.as_str()).unwrap_or(&event_id),
                            "metric": metric,
                            "frequency": detect_frequency(&event),
                            "period": period,
                            "cur": cur,
                            "points": points,
                            "cached": true
                        });
                    }
                } else if let Some(fresh_index) =
                    rebuild_index_and_persist(&ndjson_path, &index_path)
                {
                    if let Some(offset) = candidates
                        .iter()
                        .find_map(|key| fresh_index.get(key).copied())
                    {
                        if let Some(payload) =
                            read_payload_at_offset(&ndjson_path, offset, &candidates)
                        {
                            let points = points_from_payload(&payload);
                            if !points.is_empty() {
                                return json!({
                                    "ok": true,
                                    "eventId": payload.get("eventId").and_then(|v| v.as_str()).unwrap_or(&event_id),
                                    "metric": metric,
                                    "frequency": detect_frequency(&event),
                                    "period": period,
                                    "cur": cur,
                                    "points": points,
                                    "cached": true
                                });
                            }
                        }
                    }
                }
            }
        }
    }

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
            "eventId": event_id,
            "metric": event,
            "cur": cur,
            "message": "No history points found in the event history index or loaded calendar window."
        });
    }

    json!({
        "ok": true,
        "eventId": event_id,
        "metric": event,
        "frequency": detect_frequency(&event),
        "period": period,
        "cur": cur,
        "points": points,
        "cached": false
    })
}
