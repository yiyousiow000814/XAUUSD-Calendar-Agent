use crate::calendar::CalendarEvent;
use crate::time_util::{format_countdown, format_display_time};
use chrono::{DateTime, Duration, Utc};
use serde_json::json;
use sha1::{Digest, Sha1};

fn format_time_text(
    dt_utc: DateTime<Utc>,
    time_label: &str,
    source_date_label: Option<&str>,
    tz_mode: &str,
    utc_offset_minutes: i32,
) -> String {
    let time_text = format_display_time(dt_utc, tz_mode, utc_offset_minutes);
    let label = time_label.trim();
    if label.eq_ignore_ascii_case("all day") {
        let date_label = source_date_label
            .map(|s| s.to_string())
            .unwrap_or_else(|| dt_utc.format("%d-%m-%Y").to_string());
        return format!("{date_label} All Day");
    }
    if !label.is_empty() && !label.contains(':') {
        return format!("{} {}", dt_utc.format("%d-%m-%Y"), label);
    }
    time_text
}

pub fn render_next_events(
    events: &[CalendarEvent],
    currency: &str,
    tz_mode: &str,
    utc_offset_minutes: i32,
    source_utc_offset_minutes: i32,
) -> Vec<serde_json::Value> {
    let now_utc = Utc::now();
    let grace_window = Duration::minutes(3);
    let selected = currency.trim().to_uppercase();
    if events.is_empty() {
        return vec![];
    }

    let mut visible: Vec<&CalendarEvent> = events
        .iter()
        .filter(|e| e.dt_utc >= now_utc - grace_window)
        .collect();

    visible.sort_by(|a, b| {
        let a_current = a.dt_utc <= now_utc;
        let b_current = b.dt_utc <= now_utc;
        match (a_current, b_current) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => {
                if a_current {
                    b.dt_utc.cmp(&a.dt_utc)
                } else {
                    a.dt_utc.cmp(&b.dt_utc)
                }
            }
        }
    });

    let mut seen: std::collections::HashMap<String, i32> = std::collections::HashMap::new();
    let mut rendered = vec![];
    for e in visible {
        let cur = e.currency.to_uppercase();
        if selected != "ALL" && cur != selected {
            continue;
        }
        let cur_display = if cur.is_empty() {
            "--".to_string()
        } else {
            cur.clone()
        };
        let impact_display = {
            let impact = e.importance.trim();
            if impact.is_empty() {
                "--".to_string()
            } else {
                impact.to_string()
            }
        };
        let source_date_label = {
            let source = e.dt_utc + Duration::minutes(source_utc_offset_minutes as i64);
            source.format("%d-%m-%Y").to_string()
        };
        let time_text = format_time_text(
            e.dt_utc,
            &e.time_label,
            Some(&source_date_label),
            tz_mode,
            utc_offset_minutes,
        );
        let is_current = e.dt_utc <= now_utc && (now_utc - e.dt_utc) <= grace_window;
        let raw_id = format!(
            "{}|{}|{}|{}|{}",
            e.dt_utc.to_rfc3339(),
            cur,
            e.time_label.trim(),
            e.importance.trim(),
            e.event.trim()
        );
        let digest = format!("{:x}", Sha1::digest(raw_id.as_bytes()));
        let seq = seen.get(&digest).copied().unwrap_or(0) + 1;
        seen.insert(digest.clone(), seq);
        let id = if seq == 1 {
            format!("evt-{digest}")
        } else {
            format!("evt-{digest}-{seq}")
        };

        rendered.push(json!({
            "id": id,
            "state": if is_current { "current" } else { "upcoming" },
            "time": time_text,
            "cur": cur_display,
            "impact": impact_display,
            "event": e.event.clone(),
            "countdown": if is_current { "Current".to_string() } else { format_countdown(e.dt_utc) },
        }));
        if rendered.len() >= 240 {
            break;
        }
    }
    rendered
}

pub fn render_past_events(
    events: &[CalendarEvent],
    currency: &str,
    tz_mode: &str,
    utc_offset_minutes: i32,
    source_utc_offset_minutes: i32,
) -> Vec<serde_json::Value> {
    let now_utc = Utc::now();
    // Keep "current" items out of History until the same grace window used by Next Events passes.
    let grace_window = Duration::minutes(3);
    let cutoff = now_utc - Duration::days(31);
    let selected = currency.trim().to_uppercase();
    if events.is_empty() {
        return vec![];
    }
    let max_items = if selected == "ALL" { 6000 } else { 300 };

    let mut rendered = vec![];
    for e in events.iter().rev() {
        if e.dt_utc >= now_utc || e.dt_utc < cutoff {
            continue;
        }
        // Exclude items still considered "Current" in Next Events.
        if (now_utc - e.dt_utc) <= grace_window {
            continue;
        }
        let cur = e.currency.to_uppercase();
        if selected != "ALL" && cur != selected {
            continue;
        }
        let cur_display = if cur.is_empty() {
            "--".to_string()
        } else {
            cur.clone()
        };
        let impact_display = {
            let impact = e.importance.trim();
            if impact.is_empty() {
                "--".to_string()
            } else {
                impact.to_string()
            }
        };
        let actual_display = {
            let actual = e.actual.trim();
            if actual.is_empty() {
                "--".to_string()
            } else {
                actual.to_string()
            }
        };
        let forecast_display = {
            let forecast = e.forecast.trim();
            if forecast.is_empty() {
                "--".to_string()
            } else {
                forecast.to_string()
            }
        };
        let previous_display = {
            let previous = e.previous.trim();
            if previous.is_empty() {
                "--".to_string()
            } else {
                previous.to_string()
            }
        };
        let source_date_label = {
            let source = e.dt_utc + Duration::minutes(source_utc_offset_minutes as i64);
            source.format("%d-%m-%Y").to_string()
        };
        let time_text = format_time_text(
            e.dt_utc,
            &e.time_label,
            Some(&source_date_label),
            tz_mode,
            utc_offset_minutes,
        );

        rendered.push(json!({
            "time": time_text,
            "cur": cur_display,
            "impact": impact_display,
            "event": e.event.clone(),
            "actual": actual_display,
            "forecast": forecast_display,
            "previous": previous_display,
        }));
        if rendered.len() >= max_items {
            break;
        }
    }
    rendered
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calendar::CalendarEvent;
    use chrono::Utc;

    fn make_event(dt_utc: DateTime<Utc>) -> CalendarEvent {
        CalendarEvent {
            dt_utc,
            time_label: "01:30".to_string(),
            event: "Test".to_string(),
            currency: "USD".to_string(),
            importance: "High".to_string(),
            actual: "1".to_string(),
            forecast: "1".to_string(),
            previous: "1".to_string(),
        }
    }

    #[test]
    fn past_events_excludes_current_grace_window() {
        let now = Utc::now();
        let current_like = make_event(now - Duration::minutes(1));
        let past = make_event(now - Duration::minutes(10));

        let events = vec![past.clone(), current_like.clone()];
        let rendered = render_past_events(&events, "USD", "utc", 0, 0);

        // Only the older item should appear.
        assert_eq!(rendered.len(), 1);
        assert_eq!(
            rendered[0].get("event").and_then(|v| v.as_str()),
            Some("Test")
        );
        assert_eq!(rendered[0].get("cur").and_then(|v| v.as_str()), Some("USD"));
    }
}
