use crate::config;
use crate::state::RuntimeState;
use chrono::{DateTime, Duration, Utc};
use serde_json::{json, Value};
use std::fs;
use std::sync::Mutex;

fn parse_anchor_dt_utc(payload: &Value) -> DateTime<Utc> {
    payload
        .get("anchorDtUtc")
        .and_then(|v| v.as_str())
        .and_then(|raw| DateTime::parse_from_rfc3339(raw).ok())
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or_else(Utc::now)
}

fn importance_weight(raw: &str) -> f64 {
    match raw.trim().to_lowercase().as_str() {
        "high" => 1.0,
        "medium" => 0.7,
        "low" => 0.4,
        _ => 0.5,
    }
}

fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

fn sigmoid(x: f64) -> f64 {
    1.0 / (1.0 + (-x).exp())
}

fn logit(p: f64) -> f64 {
    let p = p.clamp(1e-6, 1.0 - 1e-6);
    (p / (1.0 - p)).ln()
}

fn exp_decay_weight(minutes: i64, tau_minutes: f64) -> f64 {
    if tau_minutes <= 0.0 {
        return 1.0;
    }
    (-(minutes.abs() as f64) / tau_minutes).exp()
}

fn interp_piecewise(offsets: &[i64], values: &[f64], x: i64, default: f64) -> f64 {
    if offsets.len() < 2 || offsets.len() != values.len() {
        return default;
    }
    if x <= offsets[0] {
        return values[0];
    }
    if x >= offsets[offsets.len() - 1] {
        return values[values.len() - 1];
    }
    for i in 1..offsets.len() {
        let x1 = offsets[i];
        if x <= x1 {
            let x0 = offsets[i - 1];
            let y0 = values[i - 1];
            let y1 = values[i];
            let span = (x1 - x0) as f64;
            if span <= 0.0 {
                return y1;
            }
            let t = (x - x0) as f64 / span;
            return lerp(y0, y1, t);
        }
    }
    default
}

fn read_impact_json() -> Option<Value> {
    let analysis_dir = config::analysis_dir();
    let path = analysis_dir.join("xauusd_event_impact_usd.json");
    let install_path = config::install_dir()
        .join("data")
        .join("analysis")
        .join("xauusd_event_impact_usd.json");
    let text = fs::read_to_string(&path)
        .or_else(|_| fs::read_to_string(&install_path))
        .ok()?;
    serde_json::from_str(&text).ok()
}

fn build_unified_outlook_fallback(
    event_id: &str,
    anchor_dt_utc: DateTime<Utc>,
    state: &Mutex<RuntimeState>,
) -> Option<Value> {
    let impact = read_impact_json()?;
    if impact.get("schema").and_then(|v| v.as_i64()).unwrap_or(0) != 1 {
        return None;
    }
    let windows: Vec<i64> = impact
        .get("windows_minutes")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_i64()).collect::<Vec<i64>>())
        .unwrap_or_default();
    if windows.len() < 2 {
        return None;
    }
    let windows_sorted = {
        let mut w = windows.clone();
        w.sort();
        w
    };

    // Compute P(t) for the +/-24h display window, but include a wider buffer of events so a
    // 1-hour shift of the anchor doesn't drastically change the event set.
    let display_half_minutes: i64 = 1440;
    let include_half_minutes: i64 = 2880; // +/-48h for stability

    // Use a uniform time grid so that moving the anchor by 1 hour shifts the window
    // smoothly (overlapping segments stay consistent).
    let step_minutes: i64 = 15;
    let mut grid: Vec<i64> =
        Vec::with_capacity(((display_half_minutes * 2) / step_minutes + 1) as usize);
    let mut t = -display_half_minutes;
    while t <= display_half_minutes {
        grid.push(t);
        t += step_minutes;
    }

    let events_obj = impact.get("events").and_then(|v| v.as_object())?;

    let start = anchor_dt_utc - Duration::minutes(include_half_minutes);
    let end = anchor_dt_utc + Duration::minutes(include_half_minutes);
    struct NearbyEvent {
        id: String,
        label: String,
        dt_utc: DateTime<Utc>,
        weight: f64,
        offsets: Vec<i64>,
        p_up: Vec<f64>,
        in_display_window: bool,
        w_by_grid: Vec<f64>,
        logit_delta_by_grid: Vec<f64>,
    }

    let mut nearby: Vec<NearbyEvent> = vec![];
    let runtime = state.lock().ok()?;
    if runtime.calendar.events.is_empty() {
        return None;
    }
    for e in runtime.calendar.events.iter() {
        if e.dt_utc < start || e.dt_utc > end {
            continue;
        }
        if e.currency.trim().to_uppercase() != "USD" {
            continue;
        }
        // Impact JSON uses metric-level ids like "USD::Foo::none" (not per-release instance).
        let metric_id = format!("USD::{}::none", e.event.trim());
        let Some(metric_entry) = events_obj.get(&metric_id) else {
            continue;
        };
        let Some(buckets) = metric_entry.as_object() else {
            continue;
        };

        // Derive unconditional P(up) by mixing buckets using bucket sample sizes.
        // We pick a reference offset (closest to 0) to estimate bucket weights.
        let ref_offset = windows_sorted
            .iter()
            .copied()
            .min_by_key(|v| v.abs())
            .unwrap_or(windows_sorted[0]);
        let ref_key = ref_offset.to_string();

        let mut bucket_weights: Vec<(String, f64)> = vec![];
        for b in ["ap_gt_prev", "ap_lt_prev", "ap_eq_prev"] {
            let n = buckets
                .get(b)
                .and_then(|v| v.get(&ref_key))
                .and_then(|v| v.get("n"))
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);
            if n > 0.0 {
                bucket_weights.push((b.to_string(), n));
            }
        }
        let denom: f64 = bucket_weights.iter().map(|(_, w)| *w).sum();
        if denom <= 0.0 {
            continue;
        }
        for (_, w) in bucket_weights.iter_mut() {
            *w /= denom;
        }

        let mut offsets: Vec<i64> = vec![];
        let mut p_up: Vec<f64> = vec![];
        for off in windows_sorted.iter().copied() {
            let key = off.to_string();
            let mut pup = 0.5;
            let mut used = false;
            for (b, w) in bucket_weights.iter() {
                let stats = buckets.get(b).and_then(|v| v.get(&key));
                let Some(stats) = stats else {
                    continue;
                };
                let p = stats.get("p_up").and_then(|v| v.as_f64()).or_else(|| {
                    stats
                        .get("p_down")
                        .and_then(|v| v.as_f64())
                        .map(|d| 1.0 - d)
                });
                if let Some(p) = p {
                    pup += (p - 0.5) * *w;
                    used = true;
                }
            }
            if used {
                offsets.push(off);
                p_up.push(pup.clamp(0.0, 1.0));
            }
        }
        if offsets.len() < 2 {
            continue;
        }

        let w = importance_weight(&e.importance);
        // Per-release instance id (unique) for contributions highlighting.
        let instance_id = format!("{metric_id}@{}", e.dt_utc.to_rfc3339());
        let in_display_window =
            (e.dt_utc - anchor_dt_utc).num_minutes().abs() <= display_half_minutes;
        nearby.push(NearbyEvent {
            id: instance_id,
            label: e.event.clone(),
            dt_utc: e.dt_utc,
            weight: w,
            offsets,
            p_up,
            in_display_window,
            w_by_grid: vec![0.0; grid.len()],
            logit_delta_by_grid: vec![0.0; grid.len()],
        });
    }

    if nearby.is_empty() {
        return None;
    }

    // Make the fallback less "flat" by focusing on near-term events and combining deltas in logit-space.
    // If we average too many weak signals over +/-24h, it collapses toward ~0.5 (which looks like a dead-flat market).
    let tau_minutes = 180.0; // focus on the nearer schedule window (~3h decay)
    let delta_scale = 6.0; // amplify small deltas so the path has visible curvature

    let mut sum_w_by_grid: Vec<f64> = vec![0.0; grid.len()];
    let mut sum_logit_by_grid: Vec<f64> = vec![0.0; grid.len()];

    let mut series: Vec<f64> = vec![];
    for (idx, t) in grid.iter().copied().enumerate() {
        let abs = anchor_dt_utc + Duration::minutes(t);
        let mut sum_w = 0.0;
        let mut sum_logit = 0.0;
        for e in nearby.iter_mut() {
            let rel = (abs - e.dt_utc).num_minutes();
            let pup = interp_piecewise(&e.offsets, &e.p_up, rel, 0.5);
            let decay = exp_decay_weight(rel, tau_minutes);
            let w = e.weight * decay;
            if w <= 1e-9 {
                continue;
            }
            let logit_delta = logit(pup) - logit(0.5);
            sum_w += w;
            sum_logit += w * logit_delta;
            e.w_by_grid[idx] = w;
            e.logit_delta_by_grid[idx] = logit_delta;
        }
        let p = if sum_w > 0.0 {
            // Base is 0.5 -> logit 0; combine relative logits, then map back to probability.
            let z = (sum_logit / sum_w) * delta_scale;
            sigmoid(z).clamp(0.0, 1.0)
        } else {
            0.5
        };
        sum_w_by_grid[idx] = sum_w;
        sum_logit_by_grid[idx] = sum_logit;
        series.push(p);
    }

    let contributions: Vec<Value> = nearby
        .iter()
        .filter(|e| e.in_display_window)
        .map(|e| {
            let mut delta_p_up: Vec<f64> = vec![0.0; grid.len()];
            for (idx, _t) in grid.iter().copied().enumerate() {
                let sw = sum_w_by_grid[idx] - e.w_by_grid[idx];
                let sl = sum_logit_by_grid[idx] - e.w_by_grid[idx] * e.logit_delta_by_grid[idx];
                let p_without = if sw > 1e-9 {
                    sigmoid((sl / sw) * delta_scale).clamp(0.0, 1.0)
                } else {
                    0.5
                };
                delta_p_up[idx] = (series[idx] - p_without).clamp(-1.0, 1.0);
            }
            json!({
                "eventId": e.id,
                "label": format!("{} · {}", e.label.trim(), e.dt_utc.format("%d-%m-%Y %H:%M")),
                "weight": e.weight,
                // For UI: dashed path shows P(t) without this event (base - delta).
                "deltaPUp": delta_p_up
            })
        })
        .collect();

    Some(json!({
        "unifiedPath": {
            "offsetsMinutes": grid,
            "pUp": series
        },
        "contributions": contributions,
        "fallback": {
            "anchorEventId": event_id,
            "nearbyEvents": contributions.len()
        }
    }))
}

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

    // Prefer user-writable cache in appdata, but allow a bundled seed in the install dir so
    // users can view the analysis without generating it locally.
    let analysis_dir = config::analysis_dir();
    let path = analysis_dir.join("xauusd_event_impact_usd.json");
    let install_path = config::install_dir()
        .join("data")
        .join("analysis")
        .join("xauusd_event_impact_usd.json");

    let text = match fs::read_to_string(&path).or_else(|_| fs::read_to_string(&install_path)) {
        Ok(v) => v,
        Err(_) => {
            return json!({
                "ok": false,
                "message": format!(
                    "Impact analysis data not found at {} or {}. Generate it locally first.",
                    path.display(),
                    install_path.display()
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
        "generatedAtUtc": parsed.get("generated_at_utc").cloned().unwrap_or(Value::Null),
        "meta": parsed.get("meta").cloned().unwrap_or(Value::Null),
        "windowsMinutes": parsed.get("windows_minutes").cloned().unwrap_or(Value::Null),
        "data": data.clone()
    })
}

#[tauri::command]
pub fn get_event_deep_analysis_usd(
    payload: Value,
    state: tauri::State<'_, Mutex<RuntimeState>>,
) -> Value {
    let event_id = payload
        .get("eventId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if event_id.is_empty() {
        return json!({"ok": false, "message": "eventId is required"});
    }
    let anchor_dt_utc = parse_anchor_dt_utc(&payload);

    // Lookup policy:
    // - Prefer the working calendar repo data/analysis so users can get updated deep JSON
    //   by pulling the calendar repo (no app rebuild needed).
    // - Fall back to appdata cache, then bundled seed file.
    let cfg = config::load_config();
    let repo_path = super::resolve_calendar_repo_path(&cfg);

    let repo_path_json = repo_path.as_deref().map(|p| {
        p.join("data")
            .join("analysis")
            .join("xauusd_event_deep_analysis_usd.json")
    });

    let analysis_dir = config::analysis_dir();
    let path = analysis_dir.join("xauusd_event_deep_analysis_usd.json");
    let install_path = config::install_dir()
        .join("data")
        .join("analysis")
        .join("xauusd_event_deep_analysis_usd.json");

    let text = repo_path_json
        .as_ref()
        .and_then(|p| fs::read_to_string(p).ok())
        .or_else(|| fs::read_to_string(&path).ok())
        .or_else(|| fs::read_to_string(&install_path).ok());
    let parsed: Option<Value> = text
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .filter(|v| v.get("schema").and_then(|v| v.as_i64()).unwrap_or(0) == 1);

    if let Some(parsed) = parsed {
        if let Some(events) = parsed.get("events").and_then(|v| v.as_object()) {
            if let Some(event) = events.get(&event_id) {
                // Deep JSON is present for this metric; return as-is.
                return json!({
                    "ok": true,
                    "eventId": event_id,
                    "generatedAtUtc": parsed.get("generated_at_utc").cloned().unwrap_or(Value::Null),
                    "meta": parsed.get("meta").cloned().unwrap_or(json!({})),
                    "data": event.clone()
                });
            }
        }
    }

    // Fallback: build a unified outlook window from scheduled nearby events + impact model buckets.
    let predict_market = build_unified_outlook_fallback(&event_id, anchor_dt_utc, &state)
        .unwrap_or_else(|| json!({}));

    json!({
        "ok": true,
        "eventId": event_id,
        "generatedAtUtc": Utc::now().to_rfc3339(),
        "meta": {
            "source": "fallback",
            "anchorDtUtc": anchor_dt_utc.to_rfc3339()
        },
        "data": {
            "predictMarket": predict_market,
            "method": {
                "name": "fallback-unified-outlook",
                "version": "1",
                "summary": "Fallback unified outlook computed from scheduled nearby events and the impact model. Deep JSON will replace this when available."
            },
            "signalsUsed": [
                { "id": "joint_event_context", "title": "Joint-event context (schedule window)" },
                { "id": "impact_model", "title": "Impact model (bucket-mixed baseline)" }
            ]
        }
    })
}
