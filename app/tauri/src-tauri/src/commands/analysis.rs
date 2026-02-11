use crate::config;
use crate::state::RuntimeState;
use chrono::{DateTime, Duration, Utc};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::sync::Mutex;

fn parse_numeric(raw: &str) -> Option<f64> {
    let text = raw.trim();
    if text.is_empty() {
        return None;
    }
    let lowered = text.to_lowercase();
    if matches!(
        lowered.as_str(),
        "--" | "—" | "-" | "tba" | "n/a" | "na" | "null"
    ) {
        return None;
    }

    // Support "1,234", "1.23%", and suffix "k/m/b/t".
    let mut s = text.replace(',', "");
    let mut mult = 1.0_f64;
    if let Some(stripped) = s.strip_suffix('%') {
        s = stripped.to_string();
        mult *= 0.01;
    }
    if let Some(last) = s.chars().last() {
        let suf = last.to_ascii_lowercase();
        if suf == 'k' || suf == 'm' || suf == 'b' || suf == 't' {
            s.pop();
            mult *= match suf {
                'k' => 1_000.0,
                'm' => 1_000_000.0,
                'b' => 1_000_000_000.0,
                't' => 1_000_000_000_000.0,
                _ => 1.0,
            };
        }
    }
    let base: f64 = s.parse().ok()?;
    if !base.is_finite() {
        return None;
    }
    Some(base * mult)
}

fn parse_anchor_dt_utc(payload: &Value) -> DateTime<Utc> {
    payload
        .get("anchorDtUtc")
        .and_then(|v| v.as_str())
        .and_then(|raw| DateTime::parse_from_rfc3339(raw).ok())
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or_else(Utc::now)
}

fn detect_frequency(raw: &str) -> &'static str {
    let lowered = raw.to_lowercase();
    if lowered.contains("y/y") || lowered.contains("yoy") {
        return "y/y";
    }
    if lowered.contains("m/m") || lowered.contains("mom") {
        return "m/m";
    }
    if lowered.contains("q/q") || lowered.contains("qoq") {
        return "q/q";
    }
    if lowered.contains("w/w") || lowered.contains("wow") {
        return "w/w";
    }
    ""
}

fn looks_like_period(token: &str) -> bool {
    let t = token.trim().to_lowercase().replace('.', "");
    match t.as_str() {
        "jan" | "feb" | "mar" | "apr" | "may" | "jun" | "jul" | "aug" | "sep" | "oct" | "nov"
        | "dec" => true,
        _ => {
            if t.starts_with('q') && t.len() == 2 {
                matches!(t.as_bytes()[1], b'1' | b'2' | b'3' | b'4')
            } else {
                t.len() == 4 && t.chars().all(|ch| ch.is_ascii_digit())
            }
        }
    }
}

fn strip_known_suffixes(raw: &str) -> String {
    let mut trimmed = raw.trim().to_string();
    loop {
        let end = trimmed.trim_end();
        if !end.ends_with(')') {
            break;
        }
        let Some(open_idx) = end.rfind('(') else {
            break;
        };
        let token = end[open_idx + 1..end.len().saturating_sub(1)].trim();
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

fn build_impact_metric_id(currency: &str, event: &str) -> String {
    let cur = currency.trim().to_uppercase();
    let raw = event.trim();
    let freq = detect_frequency(raw);
    let metric = strip_known_suffixes(raw)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .replace("::", " ");
    let freq_token = if freq.is_empty() {
        "none".to_string()
    } else {
        freq.to_string()
    };
    format!("{cur}::{metric}::{freq_token}")
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

#[derive(Clone, Debug)]
struct MetricPoint {
    dt_utc: DateTime<Utc>,
    a: Option<f64>,
    f: Option<f64>,
    p: Option<f64>,
}

#[derive(Clone, Debug)]
struct Softmax3Model {
    weights: Vec<[f64; 3]>, // features x classes ["=", ">", "<"]
}

#[derive(Clone, Debug)]
struct PrWfCtx {
    scale_fp: f64,
    z_ap_1: f64,
    z_ap_3: f64,
    z_ap_6: f64,
    z_a_level: f64,
    z_a_slope6: f64,
    z_af_1: f64,
}

fn median(mut values: Vec<f64>) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(|a, b| a.total_cmp(b));
    let n = values.len();
    let mid = n / 2;
    if n % 2 == 1 {
        Some(values[mid])
    } else if mid > 0 {
        Some((values[mid - 1] + values[mid]) / 2.0)
    } else {
        Some(values[0])
    }
}

fn median_abs(values: &[f64]) -> f64 {
    let abs: Vec<f64> = values
        .iter()
        .copied()
        .filter(|v| v.is_finite())
        .map(|v| v.abs())
        .collect();
    let m = median(abs).unwrap_or(1.0);
    if !m.is_finite() || m <= 1e-12 {
        1.0
    } else {
        m
    }
}

fn mad(values: &[f64]) -> f64 {
    let finite: Vec<f64> = values.iter().copied().filter(|v| v.is_finite()).collect();
    if finite.is_empty() {
        return 1.0;
    }
    let med = median(finite.clone()).unwrap_or(0.0);
    let dev: Vec<f64> = finite.iter().map(|v| (v - med).abs()).collect();
    let m = median(dev).unwrap_or(1.0);
    if !m.is_finite() || m <= 1e-12 {
        1.0
    } else {
        m
    }
}

fn mean(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let s: f64 = values.iter().copied().sum();
    s / (values.len() as f64)
}

fn slope_linreg(y: &[f64]) -> f64 {
    let n = y.len();
    if n < 2 {
        return 0.0;
    }
    let n_f = n as f64;
    let mut sx = 0.0;
    let mut sy = 0.0;
    let mut sxx = 0.0;
    let mut sxy = 0.0;
    for (i, v) in y.iter().copied().enumerate() {
        let x = i as f64;
        sx += x;
        sy += v;
        sxx += x * x;
        sxy += x * v;
    }
    let denom = n_f * sxx - sx * sx;
    if denom.abs() <= 1e-12 {
        return 0.0;
    }
    (n_f * sxy - sx * sy) / denom
}

fn dot_features3(weights: &[[f64; 3]], features: &[f64]) -> Option<[f64; 3]> {
    if weights.is_empty() {
        return None;
    }
    let d = weights.len().min(features.len());
    let mut out = [0.0_f64; 3];
    for i in 0..d {
        let x = features[i];
        let w = weights[i];
        out[0] += x * w[0];
        out[1] += x * w[1];
        out[2] += x * w[2];
    }
    Some(out)
}

fn softmax3(scores: [f64; 3]) -> [f64; 3] {
    let m = scores.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let e0 = (scores[0] - m).exp();
    let e1 = (scores[1] - m).exp();
    let e2 = (scores[2] - m).exp();
    let denom = e0 + e1 + e2;
    if !denom.is_finite() || denom <= 0.0 {
        return [1.0 / 3.0; 3];
    }
    [e0 / denom, e1 / denom, e2 / denom]
}

fn confidence_score(probs: [f64; 3]) -> f64 {
    let mut p = [probs[0], probs[1], probs[2]];
    p.sort_by(|a, b| a.total_cmp(b));
    let maxp = p[2];
    let second = p[1];
    maxp * (maxp - second).max(0.0)
}

fn build_pr_wf_ctx(points: &[MetricPoint], as_of_utc: DateTime<Utc>) -> Option<PrWfCtx> {
    let mut diffs_ap: Vec<f64> = vec![];
    let mut diffs_fp: Vec<f64> = vec![];
    let mut diffs_af: Vec<f64> = vec![];
    let mut actual_series: Vec<f64> = vec![];

    for pt in points.iter() {
        if pt.dt_utc >= as_of_utc {
            continue;
        }
        if let Some(a) = pt.a {
            if a.is_finite() {
                actual_series.push(a);
            }
        }
        if let (Some(a), Some(p)) = (pt.a, pt.p) {
            if a.is_finite() && p.is_finite() {
                diffs_ap.push(a - p);
            }
        }
        if let (Some(f), Some(p)) = (pt.f, pt.p) {
            if f.is_finite() && p.is_finite() {
                diffs_fp.push(f - p);
            }
        }
        if let (Some(a), Some(f)) = (pt.a, pt.f) {
            if a.is_finite() && f.is_finite() {
                diffs_af.push(a - f);
            }
        }
    }

    // For A vs Previous, we only need a stable A-P and Actual level history. A-F is optional.
    if diffs_ap.len() < 12 || actual_series.len() < 12 {
        return None;
    }

    let scale_ap = median_abs(&diffs_ap);
    let scale_fp = if diffs_fp.is_empty() {
        1.0
    } else {
        median_abs(&diffs_fp)
    };
    let scale_af = if diffs_af.is_empty() {
        1.0
    } else {
        median_abs(&diffs_af)
    };

    let med_a = median(actual_series.clone()).unwrap_or(0.0);
    let mad_a = mad(&actual_series);

    let last_d6 = {
        let start = diffs_ap.len().saturating_sub(6);
        diffs_ap[start..].to_vec()
    };
    let last_d3 = {
        let start = diffs_ap.len().saturating_sub(3);
        diffs_ap[start..].to_vec()
    };
    let last_a6 = {
        let start = actual_series.len().saturating_sub(6);
        actual_series[start..].to_vec()
    };
    let last_a = *actual_series.last().unwrap_or(&0.0);

    let z_ap_1 = last_d6.last().copied().unwrap_or(0.0) / scale_ap;
    let z_ap_3 = mean(&last_d3) / scale_ap;
    let z_ap_6 = mean(&last_d6) / scale_ap;
    let z_a_level = if mad_a > 0.0 {
        (last_a - med_a) / mad_a
    } else {
        0.0
    };

    let slope6 = slope_linreg(&last_a6);
    let z_a_slope6 = slope6 / scale_ap;

    let z_af_1 = if diffs_af.is_empty() {
        0.0
    } else {
        diffs_af.last().copied().unwrap_or(0.0) / scale_af
    };

    Some(PrWfCtx {
        scale_fp,
        z_ap_1,
        z_ap_3,
        z_ap_6,
        z_a_level,
        z_a_slope6,
        z_af_1,
    })
}

fn predict_wf_probs(ctx: &PrWfCtx, f0: f64, p0: f64, model: &Softmax3Model) -> Option<[f64; 3]> {
    if !f0.is_finite() || !p0.is_finite() {
        return None;
    }
    let scale_fp = if ctx.scale_fp.is_finite() && ctx.scale_fp > 1e-12 {
        ctx.scale_fp
    } else {
        1.0
    };
    let z_fp = (f0 - p0) / scale_fp;
    let features: [f64; 8] = [
        1.0,
        z_fp,
        ctx.z_ap_1,
        ctx.z_ap_3,
        ctx.z_ap_6,
        ctx.z_a_level,
        ctx.z_a_slope6,
        ctx.z_af_1,
    ];
    let scores = dot_features3(&model.weights, &features)?;
    let probs = softmax3(scores);
    let conf = confidence_score(probs);
    // Unified Outlook uses the confidence score as a *soft* blend factor elsewhere,
    // so we don't hard-gate here.
    if conf.is_finite() {
        Some(probs)
    } else {
        None
    }
}

fn parse_softmax3_model(model: &Value, key: &str) -> Option<Softmax3Model> {
    let sub = model.get("models").and_then(|v| v.get(key))?;
    let weights_val = sub.get("weights").and_then(|v| v.as_array())?;
    let mut weights: Vec<[f64; 3]> = vec![];
    for row in weights_val.iter() {
        let arr = row.as_array()?;
        if arr.len() != 3 {
            return None;
        }
        let w0 = arr[0].as_f64()?;
        let w1 = arr[1].as_f64()?;
        let w2 = arr[2].as_f64()?;
        weights.push([w0, w1, w2]);
    }
    if weights.len() < 2 {
        return None;
    }
    Some(Softmax3Model { weights })
}

fn metric_key_from_impact_metric_id(metric_id: &str) -> Option<String> {
    let mut it = metric_id.split("::");
    let _cur = it.next()?;
    let metric = it.next()?.trim();
    if metric.is_empty() {
        None
    } else {
        Some(metric.to_string())
    }
}

fn parse_gate_thresholds(model: &Value, key: &str) -> HashMap<String, f64> {
    let Some(enabled) = model
        .get("models")
        .and_then(|v| v.get(key))
        .and_then(|v| v.get("metric_gates"))
        .and_then(|v| v.get("enabled_metrics"))
        .and_then(|v| v.as_object())
    else {
        return HashMap::new();
    };
    let mut out: HashMap<String, f64> = HashMap::new();
    for (metric, cfg) in enabled.iter() {
        let th = cfg.get("th").and_then(|v| v.as_f64()).unwrap_or(f64::NAN);
        if th.is_finite() {
            out.insert(metric.clone(), th);
        }
    }
    out
}

fn alpha_from_conf(conf: f64, th: f64) -> f64 {
    if !conf.is_finite() {
        return 0.0;
    }
    let th = if th.is_finite() { th } else { 0.0 };
    if conf <= th + 1e-12 {
        return 0.0;
    }
    if th >= 1.0 - 1e-12 {
        return 0.0;
    }
    ((conf - th) / (1.0 - th)).clamp(0.0, 1.0)
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

#[tauri::command]
pub fn get_predict_release_model_usd() -> Value {
    // Allow updating the model by pulling the calendar repo (no app rebuild required),
    // but keep appdata + bundled seed fallbacks.
    let cfg = config::load_config();
    let repo_path = super::resolve_calendar_repo_path(&cfg);
    let repo_path_json = repo_path.as_deref().map(|p| {
        p.join("data")
            .join("analysis")
            .join("predict_release_model_usd.json")
    });

    let analysis_dir = config::analysis_dir();
    let path = analysis_dir.join("predict_release_model_usd.json");
    let install_path = config::install_dir()
        .join("data")
        .join("analysis")
        .join("predict_release_model_usd.json");

    let (text, source) = match repo_path_json
        .as_ref()
        .and_then(|p| fs::read_to_string(p).ok())
        .map(|t| (t, "repo"))
        .or_else(|| fs::read_to_string(&path).ok().map(|t| (t, "appdata")))
        .or_else(|| {
            fs::read_to_string(&install_path)
                .ok()
                .map(|t| (t, "install"))
        }) {
        Some(v) => v,
        None => {
            return json!({
                "ok": false,
                "message": format!(
                    "Predict release model not found at {} or {}.",
                    path.display(),
                    install_path.display()
                )
            })
        }
    };

    let parsed: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => return json!({"ok": false, "message": format!("Invalid model JSON: {e}")}),
    };
    if parsed.get("schema").and_then(|v| v.as_i64()).unwrap_or(0) != 1 {
        return json!({"ok": false, "message": "Unsupported model JSON schema"});
    }

    json!({
        "ok": true,
        "source": source,
        "data": parsed
    })
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

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum BucketMode {
        Actual,
        Forecast,
        Unconditional,
    }

    struct NearbyEvent {
        id: String,
        label: String,
        dt_utc: DateTime<Utc>,
        weight: f64,
        bucket_mode: BucketMode,
        offsets: Vec<i64>,
        p50_all: Vec<f64>,
        base_med: f64,
        in_display_window: bool,
        w_by_grid: Vec<f64>,
        delta_by_grid: Vec<f64>,
    }

    let runtime = state.lock().ok()?;
    if runtime.calendar.events.is_empty() {
        return None;
    }
    let now_utc = Utc::now();
    // Avoid look-ahead bias when the user anchors the view in the past.
    // - If anchor is in the future: we can use all information up to "now".
    // - If anchor is in the past: use only what was known as-of anchor time.
    let as_of_utc = if anchor_dt_utc < now_utc {
        anchor_dt_utc
    } else {
        now_utc
    };

    // Optional: use the Predict Release models to mix buckets for future events.
    // This makes the unified path depend on recent history (less template-like).
    //
    // - ap_with_forecast: predicts A vs Previous, used to mix AP buckets.
    // - af_with_forecast: predicts A vs Forecast (surprise), used to mix AF buckets.
    struct ReleaseMixModels {
        ap_wf_model: Option<Softmax3Model>,
        ap_wf_th_by_metric: HashMap<String, f64>,
        af_wf_model: Option<Softmax3Model>,
        af_wf_th_by_metric: HashMap<String, f64>,
    }

    let ReleaseMixModels {
        ap_wf_model,
        ap_wf_th_by_metric,
        af_wf_model,
        af_wf_th_by_metric,
    } = {
        let res = get_predict_release_model_usd();
        if res.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
            let data = res.get("data").unwrap_or(&Value::Null);
            ReleaseMixModels {
                ap_wf_model: parse_softmax3_model(data, "ap_with_forecast"),
                ap_wf_th_by_metric: parse_gate_thresholds(data, "ap_with_forecast"),
                af_wf_model: parse_softmax3_model(data, "af_with_forecast"),
                af_wf_th_by_metric: parse_gate_thresholds(data, "af_with_forecast"),
            }
        } else {
            ReleaseMixModels {
                ap_wf_model: None,
                ap_wf_th_by_metric: HashMap::new(),
                af_wf_model: None,
                af_wf_th_by_metric: HashMap::new(),
            }
        }
    };

    // Build metric history series for the small Predict Release feature set.
    // Keyed by impact metric id "USD::<metric>::none".
    let mut hist_by_metric: HashMap<String, Vec<MetricPoint>> = HashMap::new();
    for ev in runtime.calendar.events.iter() {
        if ev.currency.trim().to_uppercase() != "USD" {
            continue;
        }
        let metric_id = build_impact_metric_id("USD", &ev.event);
        if !events_obj.contains_key(&metric_id) {
            continue;
        }
        hist_by_metric
            .entry(metric_id)
            .or_default()
            .push(MetricPoint {
                dt_utc: ev.dt_utc,
                a: parse_numeric(&ev.actual),
                f: parse_numeric(&ev.forecast),
                p: parse_numeric(&ev.previous),
            });
    }
    for pts in hist_by_metric.values_mut() {
        pts.sort_by_key(|p| p.dt_utc);
    }
    let mut pr_wf_ctx_cache: HashMap<String, Option<PrWfCtx>> = HashMap::new();

    let mut build_nearby = |use_actual: bool| -> Vec<NearbyEvent> {
        let mut nearby: Vec<NearbyEvent> = vec![];
        for e in runtime.calendar.events.iter() {
            if e.dt_utc < start || e.dt_utc > end {
                continue;
            }
            if e.currency.trim().to_uppercase() != "USD" {
                continue;
            }
            // Impact JSON uses metric-level ids like "USD::Foo::none" (not per-release instance).
            let metric_id = build_impact_metric_id("USD", &e.event);
            let Some(metric_entry) = events_obj.get(&metric_id) else {
                continue;
            };
            let Some(buckets) = metric_entry.as_object() else {
                continue;
            };

            // Prefer a per-instance bucket curve based on this release's own A-P direction:
            // - before release: use Forecast vs Previous as a prior (if both exist)
            // - after release: use Actual vs Previous (if enabled and Actual exists)
            // This makes the unified path react to realized outcomes, instead of looking template-like.
            let mut bucket_mode = BucketMode::Unconditional;
            let mut bucket_choice: Option<&'static str> = None;
            let mut mixed_by_model = false;
            let has_forecast = parse_numeric(&e.forecast).is_some();

            let classify = |d: f64, gt: &'static str, lt: &'static str, eq: &'static str| {
                if d > 0.0 {
                    gt
                } else if d < 0.0 {
                    lt
                } else {
                    eq
                }
            };
            let classify_ap = |d: f64| classify(d, "ap_gt_prev", "ap_lt_prev", "ap_eq_prev");
            let classify_af =
                |d: f64| classify(d, "af_gt_forecast", "af_lt_forecast", "af_eq_forecast");

            // Prefer surprise buckets (A vs Forecast) when Forecast exists.
            //
            // - After release: use Actual vs Forecast for forecastable metrics.
            // - Before release: do not guess a surprise sign from Forecast/Previous; instead fall back to
            //   unconditional mixing across surprise buckets (if available).
            if use_actual && e.dt_utc <= as_of_utc {
                if let Some(a) = parse_numeric(&e.actual) {
                    if let Some(f) = parse_numeric(&e.forecast) {
                        bucket_choice = Some(classify_af(a - f));
                        bucket_mode = BucketMode::Actual;
                    } else if let Some(p) = parse_numeric(&e.previous) {
                        bucket_choice = Some(classify_ap(a - p));
                        bucket_mode = BucketMode::Actual;
                    }
                } else if let Some(p) = parse_numeric(&e.previous) {
                    // If actual is missing but we do have a forecast+previous, keep the old prior.
                    // This only applies to odd cases in calendar data where the release is "past"
                    // but Actual isn't filled in yet.
                    if let Some(f) = parse_numeric(&e.forecast) {
                        bucket_choice = Some(classify_ap(f - p));
                        bucket_mode = BucketMode::Forecast;
                    }
                }
            } else if !use_actual {
                // Prior path: only Forecast/Previous information is available. Keep bucket_choice unset so
                // we use an unconditional mixture (AF if available, otherwise AP).
                if has_forecast {
                    bucket_mode = BucketMode::Forecast;
                }
            }

            // Fallback: unconditional P(up) by mixing buckets using bucket sample sizes.
            // We pick a reference offset (closest to 0) to estimate bucket weights.
            let fallback_bucket_weights = |preferred_keys: [&'static str; 3]| {
                let ref_offset = windows_sorted
                    .iter()
                    .copied()
                    .min_by_key(|v| v.abs())
                    .unwrap_or(windows_sorted[0]);
                let ref_key = ref_offset.to_string();

                let mut bucket_weights: Vec<(String, f64)> = vec![];
                for b in preferred_keys {
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
                    return None;
                }
                for (_, w) in bucket_weights.iter_mut() {
                    *w /= denom;
                }
                Some(bucket_weights)
            };

            let ap_keys = ["ap_eq_prev", "ap_gt_prev", "ap_lt_prev"];
            let af_keys = ["af_eq_forecast", "af_gt_forecast", "af_lt_forecast"];
            // Hybrid family:
            // - After release: use A vs Forecast buckets when available (true surprise vs expectations).
            // - Before release: use A vs Previous buckets (more predictable and always available).
            let prefer_af = has_forecast && e.dt_utc <= as_of_utc;
            let ap_uncond = fallback_bucket_weights(ap_keys);
            let af_uncond = fallback_bucket_weights(af_keys);
            let has_af_uncond = af_uncond.is_some();
            let family_is_af = prefer_af && has_af_uncond;
            let mut bucket_weights_preferred = if family_is_af {
                af_uncond.clone().or_else(|| ap_uncond.clone())
            } else {
                ap_uncond.clone().or_else(|| af_uncond.clone())
            };

            // For future events with Forecast, try to mix A-F buckets using Predict Release (A vs Forecast).
            if bucket_choice.is_none() && has_forecast && has_af_uncond && e.dt_utc > as_of_utc {
                if let (Some(model), Some(f0), Some(p0)) = (
                    af_wf_model.as_ref(),
                    parse_numeric(&e.forecast),
                    parse_numeric(&e.previous),
                ) {
                    if let Some(metric_key) = metric_key_from_impact_metric_id(&metric_id) {
                        if let Some(th) = af_wf_th_by_metric.get(&metric_key).copied() {
                            let ctx_opt =
                                pr_wf_ctx_cache.entry(metric_id.clone()).or_insert_with(|| {
                                    hist_by_metric
                                        .get(&metric_id)
                                        .and_then(|pts| build_pr_wf_ctx(pts, as_of_utc))
                                });
                            if let Some(ctx) = ctx_opt.as_ref() {
                                if let Some(probs) = predict_wf_probs(ctx, f0, p0, model) {
                                    let alpha = alpha_from_conf(confidence_score(probs), th);
                                    if alpha > 0.0 {
                                        // Base weights from unconditional AF mix (by sample size).
                                        let mut base = [0.0_f64; 3]; // ["=", ">", "<"]
                                        if let Some(uncond) = af_uncond.as_ref() {
                                            for (k, w) in uncond.iter() {
                                                match k.as_str() {
                                                    "af_eq_forecast" => base[0] = *w,
                                                    "af_gt_forecast" => base[1] = *w,
                                                    "af_lt_forecast" => base[2] = *w,
                                                    _ => {}
                                                }
                                            }
                                        }
                                        let base_sum = base.iter().copied().sum::<f64>();
                                        if base_sum > 0.0 {
                                            for v in base.iter_mut() {
                                                *v /= base_sum;
                                            }
                                        } else {
                                            base = [1.0 / 3.0; 3];
                                        }

                                        // If a bucket has no unconditional support, don't allocate probability to it.
                                        let mut pred = [probs[0], probs[1], probs[2]];
                                        let mut pred_sum = 0.0;
                                        for i in 0..3 {
                                            if base[i] > 0.0 {
                                                pred_sum += pred[i];
                                            } else {
                                                pred[i] = 0.0;
                                            }
                                        }
                                        if pred_sum > 0.0 {
                                            for v in pred.iter_mut() {
                                                *v /= pred_sum;
                                            }
                                        } else {
                                            pred = base;
                                        }

                                        let mix = [
                                            (1.0 - alpha) * base[0] + alpha * pred[0],
                                            (1.0 - alpha) * base[1] + alpha * pred[1],
                                            (1.0 - alpha) * base[2] + alpha * pred[2],
                                        ];
                                        bucket_weights_preferred = Some(vec![
                                            ("af_eq_forecast".to_string(), mix[0]),
                                            ("af_gt_forecast".to_string(), mix[1]),
                                            ("af_lt_forecast".to_string(), mix[2]),
                                        ]);
                                        bucket_mode = BucketMode::Forecast;
                                        mixed_by_model = true;
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // For future events with Forecast, try to mix A-P buckets using Predict Release (A vs Previous).
            if bucket_choice.is_none() && !mixed_by_model && !family_is_af && e.dt_utc > as_of_utc {
                if let (Some(model), Some(f0), Some(p0)) = (
                    ap_wf_model.as_ref(),
                    parse_numeric(&e.forecast),
                    parse_numeric(&e.previous),
                ) {
                    if let Some(metric_key) = metric_key_from_impact_metric_id(&metric_id) {
                        if let Some(th) = ap_wf_th_by_metric.get(&metric_key).copied() {
                            let ctx_opt =
                                pr_wf_ctx_cache.entry(metric_id.clone()).or_insert_with(|| {
                                    hist_by_metric
                                        .get(&metric_id)
                                        .and_then(|pts| build_pr_wf_ctx(pts, as_of_utc))
                                });
                            if let Some(ctx) = ctx_opt.as_ref() {
                                if let Some(probs) = predict_wf_probs(ctx, f0, p0, model) {
                                    let alpha = alpha_from_conf(confidence_score(probs), th);
                                    if alpha > 0.0 {
                                        // Base weights from unconditional AP mix (by sample size).
                                        let mut base = [0.0_f64; 3]; // ["=", ">", "<"]
                                        if let Some(uncond) = ap_uncond.as_ref() {
                                            for (k, w) in uncond.iter() {
                                                match k.as_str() {
                                                    "ap_eq_prev" => base[0] = *w,
                                                    "ap_gt_prev" => base[1] = *w,
                                                    "ap_lt_prev" => base[2] = *w,
                                                    _ => {}
                                                }
                                            }
                                        }
                                        let base_sum = base.iter().copied().sum::<f64>();
                                        if base_sum > 0.0 {
                                            for v in base.iter_mut() {
                                                *v /= base_sum;
                                            }
                                        } else {
                                            base = [1.0 / 3.0; 3];
                                        }

                                        // If a bucket has no unconditional support, don't allocate probability to it.
                                        let mut pred = [probs[0], probs[1], probs[2]];
                                        let mut pred_sum = 0.0;
                                        for i in 0..3 {
                                            if base[i] > 0.0 {
                                                pred_sum += pred[i];
                                            } else {
                                                pred[i] = 0.0;
                                            }
                                        }
                                        if pred_sum > 0.0 {
                                            for v in pred.iter_mut() {
                                                *v /= pred_sum;
                                            }
                                        } else {
                                            pred = base;
                                        }

                                        let mix = [
                                            (1.0 - alpha) * base[0] + alpha * pred[0],
                                            (1.0 - alpha) * base[1] + alpha * pred[1],
                                            (1.0 - alpha) * base[2] + alpha * pred[2],
                                        ];
                                        bucket_weights_preferred = Some(vec![
                                            ("ap_eq_prev".to_string(), mix[0]),
                                            ("ap_gt_prev".to_string(), mix[1]),
                                            ("ap_lt_prev".to_string(), mix[2]),
                                        ]);
                                        bucket_mode = BucketMode::Forecast;
                                        mixed_by_model = true;
                                    }
                                }
                            }
                        }
                    }
                }
            }

            let mut offsets: Vec<i64> = vec![];
            let mut p50_all: Vec<f64> = vec![];
            for off in windows_sorted.iter().copied() {
                let key = off.to_string();
                // Selected bucket first.
                if let Some(bk) = bucket_choice {
                    if let Some(stats) = buckets.get(bk).and_then(|v| v.get(&key)) {
                        if let Some(med) = stats.get("p50_all").and_then(|v| v.as_f64()) {
                            offsets.push(off);
                            p50_all.push(med);
                            continue;
                        }
                    }
                }

                // Otherwise: unconditional mix.
                let Some(bucket_weights) = bucket_weights_preferred.as_ref() else {
                    break;
                };
                let mut p50 = 0.0;
                let mut used = false;
                for (b, w) in bucket_weights.iter() {
                    let stats = buckets.get(b).and_then(|v| v.get(&key));
                    let Some(stats) = stats else {
                        continue;
                    };
                    if let Some(m) = stats.get("p50_all").and_then(|v| v.as_f64()) {
                        p50 += m * *w;
                        used = true;
                    }
                }
                if used {
                    offsets.push(off);
                    p50_all.push(p50);
                }
            }
            if offsets.len() < 2 || p50_all.len() != offsets.len() {
                continue;
            }

            // If we failed to pick a bucket, or if we had to fall back to unconditional mixing,
            // expose it as Unconditional for meta counting.
            if bucket_choice.is_none() && !mixed_by_model {
                bucket_mode = BucketMode::Unconditional;
            }

            let w = importance_weight(&e.importance);
            // Per-release instance id (unique) for contributions highlighting.
            let instance_id = format!("{metric_id}@{}", e.dt_utc.to_rfc3339());
            let in_display_window =
                (e.dt_utc - anchor_dt_utc).num_minutes().abs() <= display_half_minutes;
            let rel0 = (anchor_dt_utc - e.dt_utc).num_minutes();
            let base_med = interp_piecewise(&offsets, &p50_all, rel0, 0.0);
            nearby.push(NearbyEvent {
                id: instance_id,
                label: e.event.clone(),
                dt_utc: e.dt_utc,
                weight: w,
                bucket_mode,
                offsets,
                p50_all,
                base_med,
                in_display_window,
                w_by_grid: vec![0.0; grid.len()],
                delta_by_grid: vec![0.0; grid.len()],
            });
        }
        nearby
    };

    // Make the fallback less "flat" by focusing on near-term events and combining median-move deltas.
    // If we average too many weak signals over +/-24h, it collapses toward ~0.5 (which looks like a dead-flat market).
    // A longer tau improves directional alignment across the forward window (0..+24h).
    // It keeps "macro regime" signals from nearby events around longer, instead of decaying too quickly.
    let tau_minutes: f64 = 480.0; // ~8h decay
    let tau_pre_minutes = (tau_minutes / 2.0).max(60.0);
    let pre_factor = 0.4;
    let median_scale = 120.0; // map expected return deltas into a visible P(up) curve
    let mag_ref = 0.05; // typical median move magnitude where signal starts to matter

    let mut nearby = build_nearby(true);
    if nearby.is_empty() {
        return None;
    }

    let mut used_actual_events = 0usize;
    let mut used_forecast_events = 0usize;
    let mut used_unconditional_events = 0usize;
    for e in nearby.iter() {
        match e.bucket_mode {
            BucketMode::Actual => used_actual_events += 1,
            BucketMode::Forecast => used_forecast_events += 1,
            BucketMode::Unconditional => used_unconditional_events += 1,
        }
    }
    let adjusted_by_actual = used_actual_events > 0;

    let mut sum_w_by_grid: Vec<f64> = vec![0.0; grid.len()];
    let mut sum_delta_by_grid: Vec<f64> = vec![0.0; grid.len()];

    let mut series: Vec<f64> = vec![];
    for (idx, t) in grid.iter().copied().enumerate() {
        let abs = anchor_dt_utc + Duration::minutes(t);
        let mut sum_w = 0.0;
        let mut sum_delta = 0.0;
        for e in nearby.iter_mut() {
            let rel = (abs - e.dt_utc).num_minutes();
            // Pre-release drift is usually weaker than post-release moves.
            // Attenuate future-event contributions so far-away scheduled events don't dominate.
            let decay = if rel < 0 {
                exp_decay_weight(rel, tau_pre_minutes) * pre_factor
            } else {
                exp_decay_weight(rel, tau_minutes)
            };
            let w = e.weight * decay;
            if w <= 1e-9 {
                continue;
            }
            let med = interp_piecewise(&e.offsets, &e.p50_all, rel, 0.0);
            let mag = med.abs();
            let mag_factor = if mag_ref > 0.0 {
                mag / (mag + mag_ref)
            } else {
                1.0
            };
            let delta = (med - e.base_med) * mag_factor;
            sum_w += w;
            sum_delta += w * delta;
            e.w_by_grid[idx] = w;
            e.delta_by_grid[idx] = delta;
        }
        let p = if sum_w > 0.0 {
            sigmoid((sum_delta / sum_w) * median_scale).clamp(0.0, 1.0)
        } else {
            0.5
        };
        sum_w_by_grid[idx] = sum_w;
        sum_delta_by_grid[idx] = sum_delta;
        series.push(p);
    }

    let prior_series = if adjusted_by_actual {
        let mut prior_nearby = build_nearby(false);
        if prior_nearby.is_empty() {
            None
        } else {
            // Compute only the prior series (no need for contributions); reuse the same transform as the main path.
            let mut prior: Vec<f64> = vec![];
            for t in grid.iter().copied() {
                let abs = anchor_dt_utc + Duration::minutes(t);
                let mut sum_w = 0.0;
                let mut sum_delta = 0.0;
                for e in prior_nearby.iter_mut() {
                    let rel = (abs - e.dt_utc).num_minutes();
                    let decay = if rel < 0 {
                        exp_decay_weight(rel, tau_pre_minutes) * pre_factor
                    } else {
                        exp_decay_weight(rel, tau_minutes)
                    };
                    let w = e.weight * decay;
                    if w <= 1e-9 {
                        continue;
                    }
                    let med = interp_piecewise(&e.offsets, &e.p50_all, rel, 0.0);
                    let mag = med.abs();
                    let mag_factor = if mag_ref > 0.0 {
                        mag / (mag + mag_ref)
                    } else {
                        1.0
                    };
                    let delta = (med - e.base_med) * mag_factor;
                    sum_w += w;
                    sum_delta += w * delta;
                }
                let p = if sum_w > 0.0 {
                    sigmoid((sum_delta / sum_w) * median_scale).clamp(0.0, 1.0)
                } else {
                    0.5
                };
                prior.push(p);
            }
            Some(prior)
        }
    } else {
        None
    };

    let contributions: Vec<Value> = nearby
        .iter()
        .filter(|e| e.in_display_window)
        .map(|e| {
            let mut delta_p_up: Vec<f64> = vec![0.0; grid.len()];
            for (idx, _t) in grid.iter().copied().enumerate() {
                let sw = sum_w_by_grid[idx] - e.w_by_grid[idx];
                let sd = sum_delta_by_grid[idx] - e.w_by_grid[idx] * e.delta_by_grid[idx];
                let p_without = if sw > 1e-9 {
                    sigmoid((sd / sw) * median_scale).clamp(0.0, 1.0)
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
            "offsetsMinutes": &grid,
            "pUp": series
        },
        "unifiedPathPrior": prior_series.map(|p| json!({
            "offsetsMinutes": &grid,
            "pUp": p
        })),
        "contributions": contributions,
        "unifiedMeta": {
            "source": "schedule+impact",
            "anchorEventId": event_id,
            "anchorDtUtc": anchor_dt_utc.to_rfc3339(),
            "asOfUtc": as_of_utc.to_rfc3339(),
            "displayWindowMinutes": display_half_minutes,
            "includeWindowMinutes": include_half_minutes,
            "stepMinutes": step_minutes,
            "nearbyEvents": nearby.len(),
            "displayEvents": contributions.len(),
            "usedActualEvents": used_actual_events,
            "usedForecastEvents": used_forecast_events,
            "usedUnconditionalEvents": used_unconditional_events,
            "adjustedByActual": adjusted_by_actual,
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
    let predict_market_ctx =
        build_unified_outlook_fallback(&event_id, anchor_dt_utc, state.inner());

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
                // Deep JSON is present for this metric.
                //
                // Important: Unified Outlook is instance-sensitive (depends on the anchor time and which nearby
                // events have released Actuals). Deep JSON is metric-level, so we always attach a context-aware
                // Unified Outlook computed from the current schedule window.
                let mut out_event = event.clone();
                if let Some(ctx) = predict_market_ctx {
                    if let Some(ev_obj) = out_event.as_object_mut() {
                        let pm_val = ev_obj.entry("predictMarket").or_insert_with(|| json!({}));
                        if !pm_val.is_object() {
                            *pm_val = json!({});
                        }
                        if let Some(pm_obj) = pm_val.as_object_mut() {
                            if let Some(ctx_obj) = ctx.as_object() {
                                for (k, v) in ctx_obj.iter() {
                                    pm_obj.insert(k.to_string(), v.clone());
                                }
                            }
                        }

                        // Ensure we surface the additional signal in the "How it's computed" modal.
                        if let Some(arr) =
                            ev_obj.get_mut("signalsUsed").and_then(|v| v.as_array_mut())
                        {
                            arr.push(json!({
                                "id": "unified_outlook_context",
                                "title": "Unified Outlook context (scheduled nearby events + impact buckets)"
                            }));
                        }
                    }
                }
                return json!({
                    "ok": true,
                    "eventId": event_id,
                    "generatedAtUtc": parsed.get("generated_at_utc").cloned().unwrap_or(Value::Null),
                    "meta": parsed.get("meta").cloned().unwrap_or(json!({})),
                    "data": out_event
                });
            }
        }
    }

    // Fallback: build a unified outlook window from scheduled nearby events + impact model buckets.
    let predict_market = build_unified_outlook_fallback(&event_id, anchor_dt_utc, state.inner())
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
