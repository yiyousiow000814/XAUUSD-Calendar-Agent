use crate::time_util::parse_source_dt_to_utc;
use chrono::{DateTime, Datelike, Utc};
use serde::Deserialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

pub const CALENDAR_SOURCE_UTC_OFFSET_MINUTES: i32 = 0;

#[derive(Clone, Debug)]
pub struct CalendarEvent {
    pub dt_utc: DateTime<Utc>,
    pub time_label: String,
    pub event: String,
    pub currency: String,
    pub importance: String,
    pub actual: String,
    pub forecast: String,
    pub previous: String,
}

#[derive(Deserialize)]
struct RawEvent {
    #[serde(rename = "Date")]
    date: Option<String>,
    #[serde(rename = "Time")]
    time: Option<String>,
    #[serde(rename = "Event")]
    event: Option<String>,
    #[serde(rename = "Cur.")]
    currency: Option<String>,
    #[serde(rename = "Imp.")]
    importance: Option<String>,
    #[serde(rename = "Actual")]
    actual: Option<String>,
    #[serde(rename = "Forecast")]
    forecast: Option<String>,
    #[serde(rename = "Previous")]
    previous: Option<String>,
}

fn read_year_file(path: &Path) -> Vec<RawEvent> {
    let text = fs::read_to_string(path).unwrap_or_default();
    serde_json::from_str::<Vec<RawEvent>>(&text).unwrap_or_default()
}

fn pick_year_files(calendar_root: &Path) -> Vec<PathBuf> {
    let now = chrono::Local::now();
    let current_year = now.year();
    let oldest_needed_year = (now - chrono::Duration::days(31)).year();
    let wanted = [current_year, current_year + 1, oldest_needed_year];

    let mut year_dirs: Vec<i32> = vec![];
    if let Ok(entries) = fs::read_dir(calendar_root) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !entry.path().is_dir() {
                continue;
            }
            if let Ok(y) = name.parse::<i32>() {
                year_dirs.push(y);
            }
        }
    }
    year_dirs.sort();
    year_dirs.dedup();
    if year_dirs.is_empty() {
        return vec![];
    }

    let mut candidates: Vec<i32> = year_dirs
        .iter()
        .copied()
        .filter(|y| wanted.contains(y))
        .collect();
    if candidates.is_empty() {
        candidates.push(*year_dirs.last().unwrap());
    }

    let mut files = vec![];
    for year in candidates {
        let year_path = calendar_root.join(year.to_string());
        let preferred = year_path.join(format!("{year}_calendar.json"));
        if preferred.exists() {
            files.push(preferred);
            continue;
        }
        if let Ok(entries) = fs::read_dir(&year_path) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) == Some("json") {
                    files.push(path);
                    break;
                }
            }
        }
    }
    files
}

pub fn load_calendar_events(repo_path: &Path) -> Vec<CalendarEvent> {
    let calendar_root = repo_path.join("data").join("Economic_Calendar");
    if !calendar_root.exists() {
        return vec![];
    }

    let mut raw_items: Vec<RawEvent> = vec![];
    for file in pick_year_files(&calendar_root) {
        raw_items.extend(read_year_file(&file));
    }

    let mut events: Vec<CalendarEvent> = vec![];
    for item in raw_items {
        let date_raw = item.date.unwrap_or_default();
        let time_raw = item.time.unwrap_or_default().trim().to_string();
        let event_raw = item.event.unwrap_or_default().trim().to_string();
        if date_raw.trim().is_empty() || event_raw.is_empty() {
            continue;
        }
        let currency_raw = item.currency.unwrap_or_default().trim().to_uppercase();
        let importance_raw = item.importance.unwrap_or_default().trim().to_string();
        let time_label = if time_raw.is_empty() {
            "All Day".to_string()
        } else {
            time_raw.clone()
        };

        let dt_utc = match parse_source_dt_to_utc(
            &date_raw,
            &time_raw,
            CALENDAR_SOURCE_UTC_OFFSET_MINUTES,
        ) {
            Some(v) => v,
            None => continue,
        };

        events.push(CalendarEvent {
            dt_utc,
            time_label,
            event: event_raw,
            currency: currency_raw,
            importance: importance_raw,
            actual: item.actual.unwrap_or_default().trim().to_string(),
            forecast: item.forecast.unwrap_or_default().trim().to_string(),
            previous: item.previous.unwrap_or_default().trim().to_string(),
        });
    }

    events.sort_by_key(|e| e.dt_utc);
    events
}

pub fn currency_options() -> Vec<String> {
    vec![
        "ALL", "USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "CNY",
    ]
    .into_iter()
    .map(|s| s.to_string())
    .collect()
}

pub fn to_value(event: &CalendarEvent) -> Value {
    serde_json::json!({
        "dt_utc": event.dt_utc.to_rfc3339(),
        "time_label": event.time_label,
        "event": event.event,
        "currency": event.currency,
        "importance": event.importance,
        "actual": event.actual,
        "forecast": event.forecast,
        "previous": event.previous,
    })
}
