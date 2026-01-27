use chrono::{DateTime, FixedOffset, Local, TimeZone, Utc};

pub fn now_display_time() -> String {
    Local::now().format("%d-%m-%Y %H:%M").to_string()
}

pub fn now_iso_time() -> String {
    Utc::now().to_rfc3339()
}

pub fn format_display_time(dt: DateTime<Utc>, mode: &str, utc_offset_minutes: i32) -> String {
    if mode == "utc" {
        return dt.format("%d-%m-%Y %H:%M").to_string();
    }
    if utc_offset_minutes != 0 {
        let offset = FixedOffset::east_opt(utc_offset_minutes * 60).unwrap_or_else(|| FixedOffset::east_opt(0).unwrap());
        return dt.with_timezone(&offset).format("%d-%m-%Y %H:%M").to_string();
    }
    dt.with_timezone(&Local).format("%d-%m-%Y %H:%M").to_string()
}

pub fn format_countdown(target_utc: DateTime<Utc>) -> String {
    let delta = target_utc - Utc::now();
    if delta.num_seconds() <= 0 {
        return "Now".to_string();
    }
    let minutes = delta.num_minutes();
    let hours = minutes / 60;
    let mins = minutes % 60;
    let days = hours / 24;
    let hours = hours % 24;
    if days > 0 {
        return format!("{days}d {hours}h");
    }
    format!("{hours}h {mins}m")
}

pub fn parse_source_dt_to_utc(date_iso: &str, time_hhmm: &str, source_utc_offset_minutes: i32) -> Option<DateTime<Utc>> {
    let date = chrono::NaiveDate::parse_from_str(date_iso, "%Y-%m-%d").ok()?;
    let time = if time_hhmm.contains(':') {
        chrono::NaiveTime::parse_from_str(time_hhmm, "%H:%M").unwrap_or_else(|_| chrono::NaiveTime::from_hms_opt(0, 0, 0).unwrap())
    } else {
        chrono::NaiveTime::from_hms_opt(0, 0, 0)?
    };
    let naive = chrono::NaiveDateTime::new(date, time);
    let offset = FixedOffset::east_opt(source_utc_offset_minutes * 60)?;
    let source = offset.from_local_datetime(&naive).single()?;
    Some(source.with_timezone(&Utc))
}
