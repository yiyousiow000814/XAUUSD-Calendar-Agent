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
    n_af: usize,
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
    let n_af = diffs_af.len();

    Some(PrWfCtx {
        scale_fp,
        z_ap_1,
        z_ap_3,
        z_ap_6,
        z_a_level,
        z_a_slope6,
        z_af_1,
        n_af,
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

fn has_metric_gate(model: &Value, key: &str) -> bool {
    model
        .get("models")
        .and_then(|v| v.get(key))
        .and_then(|v| v.get("metric_gates"))
        .and_then(|v| v.get("enabled_metrics"))
        .and_then(|v| v.as_object())
        .is_some()
}

fn parse_recommended_threshold(model: &Value, key: &str, default: f64) -> f64 {
    let th = model
        .get("models")
        .and_then(|v| v.get(key))
        .and_then(|v| v.get("recommended_threshold"))
        .and_then(|v| v.as_f64())
        .unwrap_or(default);
    if th.is_finite() {
        th.clamp(0.0, 1.0)
    } else {
        default.clamp(0.0, 1.0)
    }
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

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum ClusterMode {
        None,
        Metric,
        Relationships,
    }

    #[derive(Default)]
    struct Dsu {
        parent: HashMap<String, String>,
    }

    impl Dsu {
        fn find(&mut self, x: &str) -> String {
            let x = x.trim();
            if x.is_empty() {
                return String::new();
            }
            let p = self.parent.get(x).cloned();
            match p {
                None => {
                    self.parent.insert(x.to_string(), x.to_string());
                    x.to_string()
                }
                Some(p) if p == x => x.to_string(),
                Some(p) => {
                    let root = self.find(&p);
                    self.parent.insert(x.to_string(), root.clone());
                    root
                }
            }
        }

        fn union(&mut self, a: &str, b: &str) {
            let ra = self.find(a);
            let rb = self.find(b);
            if ra.is_empty() || rb.is_empty() || ra == rb {
                return;
            }
            // Deterministic root so cluster ids stay stable across runs.
            if ra < rb {
                self.parent.insert(rb, ra);
            } else {
                self.parent.insert(ra, rb);
            }
        }
    }

    struct NearbyEvent {
        id: String,
        label: String,
        dt_utc: DateTime<Utc>,
        weight: f64,
        // Only used for pre-release weighting (rel < 0). For future scheduled events, this
        // captures how confidently we could mix buckets (0..1). For all other events we keep it 0
        // so historic pre-release drift remains unchanged.
        pre_alpha: f64,
        bucket_mode: BucketMode,
        offsets: Vec<i64>,
        mu: Vec<f64>,
        mag: Vec<f64>,
        base_mu: f64,
        in_display_window: bool,
        cluster_id: usize,
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
    // Note: we intentionally avoid mixing A vs Forecast (surprise) buckets pre-release because
    // it's substantially harder/noisier than A vs Previous and tends to destabilize the curve.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum RelKind {
        Ap,
        Af,
    }

    #[derive(Clone, Debug)]
    struct RelEdge {
        metric: String,
        kind: RelKind,
        corr: f64,
        // Optional learned conditional mapping:
        //   P(target_label | source_label), labels in order ["=", ">", "<"].
        // This keeps the nowcast-chain aligned with the offline trainer / UI.
        cond: Option<[[f64; 3]; 3]>,
    }

    struct NowcastCfg {
        edges_by_target: HashMap<String, Vec<RelEdge>>,
        eq_factor: f64,
        recent_seconds: i64,
        half_life_seconds: f64,
        tail_limit: usize,
        th_global_nf: f64,
        th_by_metric_nf: HashMap<String, f64>,
        th_global_wf: f64,
        th_by_metric_wf: HashMap<String, f64>,
    }

    struct ReleaseMixModels {
        ap_wf_model: Option<Softmax3Model>,
        ap_wf_gate_present: bool,
        ap_wf_th_global: f64,
        ap_wf_th_by_metric: HashMap<String, f64>,
        af_wf_model: Option<Softmax3Model>,
        af_wf_gate_present: bool,
        af_wf_th_global: f64,
        af_wf_th_by_metric: HashMap<String, f64>,
        rel_dsu: Option<Dsu>,
        nowcast: Option<NowcastCfg>,
        cluster_top_n: usize,
    }

    let ReleaseMixModels {
        ap_wf_model,
        ap_wf_gate_present,
        ap_wf_th_global,
        ap_wf_th_by_metric,
        af_wf_model,
        af_wf_gate_present,
        af_wf_th_global,
        af_wf_th_by_metric,
        rel_dsu,
        nowcast,
        cluster_top_n,
    } = {
        let res = get_predict_release_model_usd();
        if res.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
            let data = res.get("data").unwrap_or(&Value::Null);

            let parse_enabled_thresholds = |node: &Value| -> HashMap<String, f64> {
                let Some(obj) = node.as_object() else {
                    return HashMap::new();
                };
                let mut out: HashMap<String, f64> = HashMap::new();
                for (metric, cfg) in obj.iter() {
                    let th = cfg.get("th").and_then(|v| v.as_f64()).unwrap_or(f64::NAN);
                    if th.is_finite() {
                        out.insert(metric.clone(), th);
                    }
                }
                out
            };

            // Build a lightweight relationships-based clustering DSU to avoid double-counting
            // highly correlated metrics in the unified outlook window.
            //
            // Backtested default (for clustering only): corr >= 0.25 and min_pairs >= 10.
            //
            // Note: this clustering threshold is intentionally stricter than the relationships
            // graph generation threshold (which can be looser to support nowcast coverage).
            let mut rel_dsu: Option<Dsu> = None;
            let meta = data.get("meta").unwrap_or(&Value::Null);
            let rel_meta = meta.get("relationships").unwrap_or(&Value::Null);
            let cluster_corr_th: f64 = rel_meta
                .get("cluster_min_abs_corr")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.25)
                .clamp(0.0, 1.0);
            let cluster_min_pairs: i64 = rel_meta
                .get("cluster_min_pairs")
                .and_then(|v| v.as_i64())
                .unwrap_or(10)
                .max(1);
            let cluster_top_n: usize = rel_meta
                .get("cluster_top_n")
                .and_then(|v| v.as_i64())
                .unwrap_or(2)
                .clamp(1, 2) as usize;
            // Keep the nowcast edges filter aligned with the relationships graph generation threshold.
            let corr_th: f64 = rel_meta
                .get("min_abs_corr")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.30)
                .clamp(0.0, 1.0);
            let min_pairs: i64 = rel_meta
                .get("min_pairs")
                .and_then(|v| v.as_i64())
                .unwrap_or(24)
                .max(1);
            if let Some(by_metric) = data
                .get("models")
                .and_then(|v| v.get("ap_no_forecast"))
                .and_then(|v| v.get("relationships"))
                .and_then(|v| v.get("by_metric"))
                .and_then(|v| v.as_object())
            {
                let mut tmp = Dsu::default();
                for (src, rels) in by_metric.iter() {
                    let Some(arr) = rels.as_array() else { continue };
                    for it in arr.iter() {
                        let Some(obj) = it.as_object() else { continue };
                        let dst = obj
                            .get("metric")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .trim();
                        if dst.is_empty() {
                            continue;
                        }
                        let corr = obj.get("corr").and_then(|v| v.as_f64()).unwrap_or(0.0);
                        let n_pairs = obj.get("n_pairs").and_then(|v| v.as_i64()).unwrap_or(0);
                        if corr.is_finite()
                            && corr.abs() >= cluster_corr_th
                            && n_pairs >= cluster_min_pairs
                        {
                            tmp.union(src, dst);
                        }
                    }
                }
                if !tmp.parent.is_empty() {
                    rel_dsu = Some(tmp);
                }
            }

            let nowcast = {
                let eq_factor: f64 = meta
                    .get("eq_factor")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.10);
                let recent_days: i64 = rel_meta
                    .get("recent_days")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(180)
                    .max(1);
                let vote_half_life_days: i64 = rel_meta
                    .get("vote_half_life_days")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(60)
                    .max(1);
                let tail_limit: usize = rel_meta
                    .get("tail_limit")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(32)
                    .clamp(1, 256) as usize;
                let recent_seconds: i64 = recent_days.saturating_mul(24 * 3600);
                let half_life_seconds: f64 = (vote_half_life_days as f64) * 24.0 * 3600.0;

                let rel_root = data
                    .get("models")
                    .and_then(|v| v.get("ap_no_forecast"))
                    .and_then(|v| v.get("relationships"))
                    .unwrap_or(&Value::Null);

                let pred_nf = rel_root.get("predictor").unwrap_or(&Value::Null);
                let pred_wf = rel_root.get("predictor_with_forecast").unwrap_or(pred_nf);

                let th_global_nf: f64 = pred_nf
                    .get("recommended_threshold")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.10);
                let th_by_metric_nf = parse_enabled_thresholds(
                    pred_nf.get("enabled_metrics").unwrap_or(&Value::Null),
                );

                let th_global_wf: f64 = pred_wf
                    .get("recommended_threshold")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(th_global_nf);
                let mut th_by_metric_wf = parse_enabled_thresholds(
                    pred_wf.get("enabled_metrics").unwrap_or(&Value::Null),
                );
                if th_by_metric_wf.is_empty() && !th_by_metric_nf.is_empty() {
                    th_by_metric_wf = th_by_metric_nf.clone();
                }

                let mut edges_by_target: HashMap<String, Vec<RelEdge>> = HashMap::new();
                if let Some(by_metric) = rel_root.get("by_metric").and_then(|v| v.as_object()) {
                    for (tgt, rels) in by_metric.iter() {
                        let Some(arr) = rels.as_array() else { continue };
                        for it in arr.iter() {
                            let Some(obj) = it.as_object() else { continue };
                            let src = obj
                                .get("metric")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .trim();
                            if src.is_empty() {
                                continue;
                            }
                            let kind = obj
                                .get("kind")
                                .and_then(|v| v.as_str())
                                .unwrap_or("ap")
                                .trim()
                                .to_lowercase();
                            let kind = if kind == "af" {
                                RelKind::Af
                            } else {
                                RelKind::Ap
                            };
                            let corr = obj.get("corr").and_then(|v| v.as_f64()).unwrap_or(0.0);
                            let n_pairs = obj.get("n_pairs").and_then(|v| v.as_i64()).unwrap_or(0);
                            if !corr.is_finite() || corr.abs() < corr_th || n_pairs < min_pairs {
                                continue;
                            }
                            let cond =
                                obj.get("cond").and_then(|v| v.as_array()).and_then(|rows| {
                                    if rows.len() != 3 {
                                        return None;
                                    }
                                    let mut out = [[0.0_f64; 3]; 3];
                                    for (ri, row) in rows.iter().enumerate() {
                                        let arr = row.as_array()?;
                                        if arr.len() != 3 {
                                            return None;
                                        }
                                        for (ci, cell) in arr.iter().enumerate() {
                                            out[ri][ci] = cell.as_f64().unwrap_or(0.0);
                                        }
                                    }
                                    Some(out)
                                });
                            edges_by_target
                                .entry(tgt.clone())
                                .or_default()
                                .push(RelEdge {
                                    metric: src.to_string(),
                                    kind,
                                    corr,
                                    cond,
                                });
                        }
                    }
                }

                if edges_by_target.is_empty() {
                    None
                } else {
                    Some(NowcastCfg {
                        edges_by_target,
                        eq_factor,
                        recent_seconds,
                        half_life_seconds,
                        tail_limit,
                        th_global_nf,
                        th_by_metric_nf,
                        th_global_wf,
                        th_by_metric_wf,
                    })
                }
            };

            ReleaseMixModels {
                ap_wf_model: parse_softmax3_model(data, "ap_with_forecast"),
                ap_wf_gate_present: has_metric_gate(data, "ap_with_forecast"),
                ap_wf_th_global: parse_recommended_threshold(data, "ap_with_forecast", 0.25),
                ap_wf_th_by_metric: parse_gate_thresholds(data, "ap_with_forecast"),
                af_wf_model: parse_softmax3_model(data, "af_with_forecast"),
                af_wf_gate_present: has_metric_gate(data, "af_with_forecast"),
                af_wf_th_global: parse_recommended_threshold(data, "af_with_forecast", 0.60),
                af_wf_th_by_metric: parse_gate_thresholds(data, "af_with_forecast"),
                rel_dsu,
                nowcast,
                cluster_top_n,
            }
        } else {
            ReleaseMixModels {
                ap_wf_model: None,
                ap_wf_gate_present: false,
                ap_wf_th_global: 0.25,
                ap_wf_th_by_metric: HashMap::new(),
                af_wf_model: None,
                af_wf_gate_present: false,
                af_wf_th_global: 0.60,
                af_wf_th_by_metric: HashMap::new(),
                rel_dsu: None,
                nowcast: None,
                cluster_top_n: 2,
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

    #[derive(Clone, Debug)]
    struct ZSeries {
        t_sec: Vec<i64>,
        z: Vec<f64>,
    }

    // Relationship-based "nowcast chain" signals (Predict Release, no-forecast fallback).
    // These are used to mix A-P buckets for future events when the per-metric softmax model is not confident.
    let mut z_series_ap: HashMap<String, ZSeries> = HashMap::new();
    let mut z_series_af: HashMap<String, ZSeries> = HashMap::new();
    if nowcast.is_some() {
        let mut ap_raw: HashMap<String, Vec<(i64, f64)>> = HashMap::new();
        let mut af_raw: HashMap<String, Vec<(i64, f64)>> = HashMap::new();

        for ev in runtime.calendar.events.iter() {
            if ev.currency.trim().to_uppercase() != "USD" {
                continue;
            }
            if ev.dt_utc >= as_of_utc {
                continue;
            }
            let metric_id = build_impact_metric_id("USD", &ev.event);
            if !events_obj.contains_key(&metric_id) {
                continue;
            }
            let metric_key = metric_key_from_impact_metric_id(&metric_id).unwrap_or_default();
            if metric_key.is_empty() {
                continue;
            }
            let t_sec = ev.dt_utc.timestamp();
            let a = parse_numeric(&ev.actual);
            let f = parse_numeric(&ev.forecast);
            let p = parse_numeric(&ev.previous);

            if let (Some(a0), Some(p0)) = (a, p) {
                if a0.is_finite() && p0.is_finite() {
                    ap_raw
                        .entry(metric_key.clone())
                        .or_default()
                        .push((t_sec, a0 - p0));
                }
            }
            if let (Some(a0), Some(f0)) = (a, f) {
                if a0.is_finite() && f0.is_finite() {
                    af_raw.entry(metric_key).or_default().push((t_sec, a0 - f0));
                }
            }
        }

        for (metric_key, mut rows) in ap_raw.into_iter() {
            rows.sort_by_key(|(t, _)| *t);
            let diffs: Vec<f64> = rows.iter().map(|(_, d)| *d).collect();
            if diffs.is_empty() {
                continue;
            }
            let scale = median_abs(&diffs);
            let t_sec: Vec<i64> = rows.iter().map(|(t, _)| *t).collect();
            let z: Vec<f64> = diffs.iter().map(|d| *d / scale).collect();
            z_series_ap.insert(metric_key, ZSeries { t_sec, z });
        }
        for (metric_key, mut rows) in af_raw.into_iter() {
            rows.sort_by_key(|(t, _)| *t);
            let diffs: Vec<f64> = rows.iter().map(|(_, d)| *d).collect();
            if diffs.is_empty() {
                continue;
            }
            let scale = median_abs(&diffs);
            let t_sec: Vec<i64> = rows.iter().map(|(t, _)| *t).collect();
            let z: Vec<f64> = diffs.iter().map(|d| *d / scale).collect();
            z_series_af.insert(metric_key, ZSeries { t_sec, z });
        }
    }

    let nowcast_predict = |metric_key: &str, has_forecast: bool| -> Option<([f64; 3], f64, f64)> {
        let cfg = nowcast.as_ref()?;
        let rels = cfg.edges_by_target.get(metric_key)?;

        let t_sec = as_of_utc.timestamp();
        let mut votes = [0.0_f64; 3]; // ["=", ">", "<"]
        let mut used = 0usize; // number of source metrics that contributed (not number of points)
        let tail_limit: usize = cfg.tail_limit.max(1);

        for edge in rels.iter() {
            let series_map = match edge.kind {
                RelKind::Af => &z_series_af,
                RelKind::Ap => &z_series_ap,
            };
            let Some(src) = series_map.get(&edge.metric) else {
                continue;
            };

            // Strictly before (searchsorted side="left" - 1), then walk backward within the
            // recent window so the nowcast reflects recent 1-6 months, not only the last print.
            let ins = match src.t_sec.binary_search(&t_sec) {
                Ok(i) => i,
                Err(i) => i,
            };
            if ins == 0 {
                continue;
            }
            let mut j = ins - 1;
            let mut taken = 0usize;
            let mut edge_used = false;

            while taken < tail_limit {
                let src_t = src.t_sec.get(j).copied().unwrap_or(0);
                let mut z_last = src.z.get(j).copied().unwrap_or(0.0);
                let age = t_sec - src_t;
                if age < 0 {
                    if j == 0 {
                        break;
                    }
                    j -= 1;
                    continue;
                }
                if age > cfg.recent_seconds {
                    break;
                }

                z_last = z_last.clamp(-3.0, 3.0);
                if !z_last.is_finite() {
                    if j == 0 {
                        break;
                    }
                    j -= 1;
                    taken += 1;
                    continue;
                }

                let src_lab = if z_last.abs() <= cfg.eq_factor {
                    0
                } else if z_last > 0.0 {
                    1
                } else {
                    2
                };

                let hl = cfg.half_life_seconds.max(1.0);
                let w_time = (-(age as f64) / hl).exp();
                let w = edge.corr.abs() * z_last.abs().min(3.0) * w_time;
                if w.is_finite() && w > 0.0 {
                    // Prefer learned conditional mapping when available:
                    //   P(target_label | source_label)
                    if let Some(cond) = edge.cond {
                        let row = cond[src_lab];
                        // Add the full conditional distribution to avoid overconfident "winner-take-all" votes.
                        for (k, &p) in row.iter().enumerate() {
                            let v = w * p.max(0.0);
                            if v.is_finite() {
                                votes[k] += v;
                            }
                        }
                    } else {
                        // Back-compat fallback: treat corr sign as a hard inversion for ">" / "<".
                        let mut lab = src_lab;
                        if edge.corr < 0.0 {
                            if lab == 1 {
                                lab = 2;
                            } else if lab == 2 {
                                lab = 1;
                            }
                        }
                        votes[lab] += w;
                    }
                    edge_used = true;
                }

                if j == 0 {
                    break;
                }
                j -= 1;
                taken += 1;
            }

            if edge_used {
                used += 1;
            }
        }

        if used == 0 {
            return None;
        }
        let sum: f64 = votes.iter().copied().sum();
        if !sum.is_finite() || sum <= 0.0 {
            return None;
        }
        let probs = [votes[0] / sum, votes[1] / sum, votes[2] / sum];
        let score = confidence_score(probs);

        let (th_map, th_global) = if has_forecast {
            (&cfg.th_by_metric_wf, cfg.th_global_wf)
        } else {
            (&cfg.th_by_metric_nf, cfg.th_global_nf)
        };
        // Do not hard-gate nowcast-chain on "enabled metrics" only: the relationships graph is
        // still informative for many metrics. Metrics without an explicit per-metric threshold
        // simply fall back to the global recommended threshold.
        let th = th_map.get(metric_key).copied().unwrap_or(th_global);
        if score + 1e-12 < th {
            return None;
        }
        Some((probs, score, th))
    };

    // Cluster similar metrics so the unified outlook doesn't double-count highly correlated signals.
    //
    // - Relationships: use Predict Release relationships graph when available.
    // - Metric: safe fallback that mostly affects duplicate metrics (rare) but keeps behavior stable.
    let cluster_mode = if rel_dsu.is_some() {
        ClusterMode::Relationships
    } else {
        ClusterMode::Metric
    };
    let mut rel_dsu = rel_dsu;

    let mut cluster_id_by_root: HashMap<String, usize> = HashMap::new();
    if cluster_mode != ClusterMode::None {
        for e in runtime.calendar.events.iter() {
            if e.dt_utc < start || e.dt_utc > end {
                continue;
            }
            if e.currency.trim().to_uppercase() != "USD" {
                continue;
            }
            // Unified Outlook focuses on Medium/High events to reduce noise/dilution.
            let w = importance_weight(&e.importance);
            if w < 0.7 {
                continue;
            }
            let metric_id = build_impact_metric_id("USD", &e.event);
            if !events_obj.contains_key(&metric_id) {
                continue;
            }
            let metric_key = metric_key_from_impact_metric_id(&metric_id).unwrap_or_default();
            if metric_key.is_empty() {
                continue;
            }
            let root = match cluster_mode {
                ClusterMode::Relationships => rel_dsu
                    .as_mut()
                    .map(|d| d.find(&metric_key))
                    .filter(|s| !s.is_empty())
                    .unwrap_or(metric_key),
                ClusterMode::Metric => metric_key,
                ClusterMode::None => metric_key,
            };
            if !cluster_id_by_root.contains_key(&root) {
                let id = cluster_id_by_root.len();
                cluster_id_by_root.insert(root, id);
            }
        }
    }
    let cluster_count = cluster_id_by_root.len();

    // Recent-window empirical baseline (time-decayed):
    // If the predictive models / nowcast chain can't confidently mix future buckets, we can still
    // make the unified outlook less "template-like" by mixing buckets using the metric's own recent
    // A-F / A-P outcomes (no extra data sources required).
    let recent_mix_seconds: i64 = nowcast
        .as_ref()
        .map(|cfg| cfg.recent_seconds)
        .unwrap_or(180 * 24 * 3600);
    let recent_mix_half_life_seconds: f64 = nowcast
        .as_ref()
        .map(|cfg| cfg.half_life_seconds)
        .unwrap_or(60.0 * 24.0 * 3600.0)
        .max(1.0);
    let recent_mix_eq_factor: f64 = nowcast.as_ref().map(|cfg| cfg.eq_factor).unwrap_or(0.10);
    let recent_alpha_k: f64 = 12.0;
    let recent_alpha_min: f64 = 0.15;

    let compute_recent_mix = |metric_id: &str, kind: RelKind| -> Option<([f64; 3], f64)> {
        let pts = hist_by_metric.get(metric_id)?;
        let mut diffs: Vec<(i64, f64)> = vec![]; // (age_seconds, diff)
        for pt in pts.iter() {
            if pt.dt_utc > as_of_utc {
                continue;
            }
            let age = (as_of_utc - pt.dt_utc).num_seconds();
            if age < 0 || age > recent_mix_seconds {
                continue;
            }
            let diff = match kind {
                RelKind::Af => match (pt.a, pt.f) {
                    (Some(a), Some(f)) => a - f,
                    _ => continue,
                },
                RelKind::Ap => match (pt.a, pt.p) {
                    (Some(a), Some(p)) => a - p,
                    _ => continue,
                },
            };
            if diff.is_finite() {
                diffs.push((age, diff));
            }
        }
        // Keep this conservative: we only want this baseline when we have enough signal.
        if diffs.len() < 12 {
            return None;
        }
        let values: Vec<f64> = diffs.iter().map(|(_, d)| *d).collect();
        let scale = median_abs(&values);
        let eps = (scale * recent_mix_eq_factor).abs();

        let mut votes = [0.0_f64; 3]; // ["=", ">", "<"]
        for (age, diff) in diffs.iter() {
            let w_time = (-(*age as f64) / recent_mix_half_life_seconds).exp();
            if !w_time.is_finite() || w_time <= 0.0 {
                continue;
            }
            let lab: usize = if diff.abs() <= eps {
                0
            } else if *diff > 0.0 {
                1
            } else {
                2
            };
            votes[lab] += w_time;
        }
        let sum: f64 = votes.iter().copied().sum();
        if !sum.is_finite() || sum <= 0.0 {
            return None;
        }
        let probs = [votes[0] / sum, votes[1] / sum, votes[2] / sum];
        // Smooth alpha: small recent sample => tiny influence; large sample => stronger.
        let alpha = sum / (sum + recent_alpha_k);
        Some((probs, alpha))
    };

    let mut build_nearby = |use_actual: bool| -> Vec<NearbyEvent> {
        let mut nearby: Vec<NearbyEvent> = vec![];
        for e in runtime.calendar.events.iter() {
            if e.dt_utc < start || e.dt_utc > end {
                continue;
            }
            if e.currency.trim().to_uppercase() != "USD" {
                continue;
            }
            let w = importance_weight(&e.importance);
            if w < 0.7 {
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
            let mut pre_alpha = 0.0_f64;
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

            // Before release, we normally use A-P buckets (more predictable).
            // However, if we can confidently predict the surprise direction for a forecastable metric,
            // mix A-F buckets to make the unified path more trade-relevant (expectations-driven moves).

            // For future events with Forecast, try to mix A-F buckets using Predict Release (A vs Forecast).
            if bucket_choice.is_none()
                && !mixed_by_model
                && !family_is_af
                && e.dt_utc > as_of_utc
                && has_forecast
                && has_af_uncond
            {
                if let (Some(model), Some(f0), Some(p0)) = (
                    af_wf_model.as_ref(),
                    parse_numeric(&e.forecast),
                    parse_numeric(&e.previous),
                ) {
                    if let Some(metric_key) = metric_key_from_impact_metric_id(&metric_id) {
                        let th_opt = af_wf_th_by_metric.get(&metric_key).copied();
                        let th = if af_wf_gate_present {
                            // If metric gating is present, only mix when the metric is explicitly enabled.
                            th_opt.unwrap_or(f64::NAN)
                        } else {
                            th_opt.unwrap_or(af_wf_th_global)
                        };
                        if th.is_finite() {
                            let ctx_opt =
                                pr_wf_ctx_cache.entry(metric_id.clone()).or_insert_with(|| {
                                    hist_by_metric
                                        .get(&metric_id)
                                        .and_then(|pts| build_pr_wf_ctx(pts, as_of_utc))
                                });
                            if let Some(ctx) = ctx_opt.as_ref() {
                                // Require enough A-F history to keep this stable.
                                if ctx.n_af >= 12 {
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
                                            pre_alpha = alpha;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // If the A-F model isn't confident, fall back to a recent-window empirical A-F mix.
            if bucket_choice.is_none()
                && !mixed_by_model
                && !family_is_af
                && e.dt_utc > as_of_utc
                && has_forecast
                && has_af_uncond
            {
                if let Some((probs, alpha)) = compute_recent_mix(&metric_id, RelKind::Af) {
                    if alpha >= recent_alpha_min {
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
                        pre_alpha = alpha;
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
                        let th_opt = ap_wf_th_by_metric.get(&metric_key).copied();
                        let th = if ap_wf_gate_present {
                            // If metric gating is present, only mix when the metric is explicitly enabled.
                            th_opt.unwrap_or(f64::NAN)
                        } else {
                            th_opt.unwrap_or(ap_wf_th_global)
                        };
                        if th.is_finite() {
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
                                        pre_alpha = alpha;
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // For future events, if the per-metric softmax models didn't fire, try the
            // relationships-based nowcast chain (Predict Release no-forecast fallback).
            if bucket_choice.is_none() && !mixed_by_model && e.dt_utc > as_of_utc {
                if let Some(metric_key) = metric_key_from_impact_metric_id(&metric_id) {
                    if let Some((probs, score, th)) = nowcast_predict(&metric_key, has_forecast) {
                        let alpha = alpha_from_conf(score, th);
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
                            pre_alpha = alpha;
                        }
                    }
                }
            }

            // Last resort: if nothing confidently mixed future buckets, use a recent-window empirical AP mix.
            // This keeps the path instance-sensitive even for no-forecast metrics.
            if bucket_choice.is_none() && !mixed_by_model && e.dt_utc > as_of_utc {
                if let Some((probs, alpha)) = compute_recent_mix(&metric_id, RelKind::Ap) {
                    if alpha >= recent_alpha_min {
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
                        mixed_by_model = true;
                        pre_alpha = alpha;
                    }
                }
            }

            let mut offsets: Vec<i64> = vec![];
            let mut mu: Vec<f64> = vec![];
            let mut mag: Vec<f64> = vec![];

            let mu_mag_from_stats = |stats: &Value| -> Option<(f64, f64)> {
                let n = stats.get("n").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let shrink_k = 40.0;
                let shrink = if n.is_finite() && n > 0.0 {
                    n / (n + shrink_k)
                } else {
                    0.0
                };

                let mut p_up = stats.get("p_up").and_then(|v| v.as_f64());
                if p_up.is_none() {
                    p_up = stats
                        .get("p_down")
                        .and_then(|v| v.as_f64())
                        .map(|d| 1.0 - d);
                }
                let p_up = p_up.filter(|v| v.is_finite()).map(|v| v.clamp(0.0, 1.0));

                let up_p50 = stats
                    .get("up_p50")
                    .and_then(|v| v.as_f64())
                    .filter(|v| v.is_finite());
                let down_p50 = stats
                    .get("down_p50")
                    .and_then(|v| v.as_f64())
                    .filter(|v| v.is_finite());

                let (mut mu, mut mag) =
                    if let (Some(p), Some(u), Some(d)) = (p_up, up_p50, down_p50) {
                        let mu = p * u + (1.0 - p) * d;
                        let mag = p * u.abs() + (1.0 - p) * d.abs();
                        (mu, mag)
                    } else if let Some(m) = stats
                        .get("p50_all")
                        .and_then(|v| v.as_f64())
                        .filter(|v| v.is_finite())
                        .or_else(|| {
                            stats
                                .get("p50")
                                .and_then(|v| v.as_f64())
                                .filter(|v| v.is_finite())
                        })
                    {
                        (m, m.abs())
                    } else {
                        return None;
                    };

                // Shrink low-N estimates to reduce noisy curves from tiny buckets.
                mu *= shrink;
                mag *= shrink;
                Some((mu, mag))
            };
            for off in windows_sorted.iter().copied() {
                let key = off.to_string();
                // Selected bucket first.
                if let Some(bk) = bucket_choice {
                    if let Some(stats) = buckets.get(bk).and_then(|v| v.get(&key)) {
                        if let Some((m, g)) = mu_mag_from_stats(stats) {
                            offsets.push(off);
                            mu.push(m);
                            mag.push(g);
                            continue;
                        }
                    }
                }

                // Otherwise: unconditional mix.
                let Some(bucket_weights) = bucket_weights_preferred.as_ref() else {
                    break;
                };
                let mut mu_mix = 0.0;
                let mut mag_mix = 0.0;
                let mut used = false;
                for (b, w) in bucket_weights.iter() {
                    let stats = buckets.get(b).and_then(|v| v.get(&key));
                    let Some(stats) = stats else {
                        continue;
                    };
                    if let Some((m, g)) = mu_mag_from_stats(stats) {
                        mu_mix += m * *w;
                        mag_mix += g * *w;
                        used = true;
                    }
                }
                if used {
                    offsets.push(off);
                    mu.push(mu_mix);
                    mag.push(mag_mix);
                }
            }
            if offsets.len() < 2 || mu.len() != offsets.len() || mag.len() != offsets.len() {
                continue;
            }

            // If we failed to pick a bucket, or if we had to fall back to unconditional mixing,
            // expose it as Unconditional for meta counting.
            if bucket_choice.is_none() && !mixed_by_model {
                bucket_mode = BucketMode::Unconditional;
            }

            // Per-release instance id (unique) for contributions highlighting.
            let instance_id = format!("{metric_id}@{}", e.dt_utc.to_rfc3339());
            let in_display_window =
                (e.dt_utc - anchor_dt_utc).num_minutes().abs() <= display_half_minutes;
            let rel0 = (anchor_dt_utc - e.dt_utc).num_minutes();
            // Impact JSON stores negative offsets as "past -> event" drift.
            // Convert to a time-cumulative curve centered at the event timestamp ("event -> past")
            // so per-event deltas represent anchor -> t moves instead of "t -> event" remaining drift.
            let base_mu_raw = interp_piecewise(&offsets, &mu, rel0, 0.0);
            let base_mu = if rel0 < 0 { -base_mu_raw } else { base_mu_raw };

            let metric_key = metric_key_from_impact_metric_id(&metric_id).unwrap_or_default();
            let root = match cluster_mode {
                ClusterMode::Relationships => rel_dsu
                    .as_mut()
                    .map(|d| d.find(&metric_key))
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| metric_key.clone()),
                ClusterMode::Metric => metric_key.clone(),
                ClusterMode::None => metric_key.clone(),
            };
            let cluster_id = cluster_id_by_root.get(&root).copied().unwrap_or(0);
            nearby.push(NearbyEvent {
                id: instance_id,
                label: e.event.clone(),
                dt_utc: e.dt_utc,
                weight: w,
                pre_alpha: if e.dt_utc > as_of_utc {
                    pre_alpha.clamp(0.0, 1.0)
                } else {
                    0.0
                },
                bucket_mode,
                offsets,
                mu,
                mag,
                base_mu,
                in_display_window,
                cluster_id,
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
    // A longer tau improves directional alignment across the full 0..+24h window by
    // keeping nearby macro context "alive" longer (less over-decay).
    // Tuned via `scripts/calendar/evaluate_unified_outlook_accuracy.py` to favor near-term
    // usefulness (+60m..+12h) without over-smoothing into a flat ~0.5 line.
    let tau_minutes: f64 = 1440.0; // ~24h decay
    let tau_pre_minutes = (tau_minutes / 2.0).max(60.0);
    let pre_factor = 0.05;
    let pre_factor_max = 0.40;
    let median_scale = 120.0; // map expected return deltas into a visible P(up) curve
                              // Typical move magnitude where signal starts to matter.
                              // Slightly higher ref keeps tiny/low-signal drifts from dominating the mixture.
    let mag_ref = 0.07;
    let top_k: usize = 10; // only keep the strongest clusters per grid point (reduces dilution)

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
    let mut sum_cluster_z_by_grid: Vec<f64> = vec![0.0; grid.len()];
    let mut n_clusters_by_grid: Vec<usize> = vec![0; grid.len()];

    let use_clusters = cluster_mode != ClusterMode::None && cluster_count > 0;
    // Cache top-2 per cluster per grid point for fast delta computation (used by UI highlighting).
    let mut top_idx_by_grid: Vec<Vec<usize>> = vec![];
    let mut second_idx_by_grid: Vec<Vec<usize>> = vec![];
    let mut top_w_by_grid: Vec<Vec<f64>> = vec![];
    let mut top_wdelta_by_grid: Vec<Vec<f64>> = vec![];
    let mut second_w_by_grid: Vec<Vec<f64>> = vec![];
    let mut second_wdelta_by_grid: Vec<Vec<f64>> = vec![];
    let mut selected_clusters_by_grid: Vec<Vec<usize>> = vec![];

    let mut series: Vec<f64> = Vec::with_capacity(grid.len());
    if use_clusters {
        top_idx_by_grid = vec![vec![usize::MAX; cluster_count]; grid.len()];
        second_idx_by_grid = vec![vec![usize::MAX; cluster_count]; grid.len()];
        top_w_by_grid = vec![vec![0.0; cluster_count]; grid.len()];
        top_wdelta_by_grid = vec![vec![0.0; cluster_count]; grid.len()];
        second_w_by_grid = vec![vec![0.0; cluster_count]; grid.len()];
        second_wdelta_by_grid = vec![vec![0.0; cluster_count]; grid.len()];
        selected_clusters_by_grid = vec![Vec::new(); grid.len()];

        let mut top_strength: Vec<f64> = vec![f64::NEG_INFINITY; cluster_count];
        let mut second_strength: Vec<f64> = vec![f64::NEG_INFINITY; cluster_count];
        let mut top_idx: Vec<usize> = vec![usize::MAX; cluster_count];
        let mut second_idx: Vec<usize> = vec![usize::MAX; cluster_count];
        let mut top_w: Vec<f64> = vec![0.0; cluster_count];
        let mut top_wdelta: Vec<f64> = vec![0.0; cluster_count];
        let mut second_w: Vec<f64> = vec![0.0; cluster_count];
        let mut second_wdelta: Vec<f64> = vec![0.0; cluster_count];

        for (idx, t) in grid.iter().copied().enumerate() {
            let abs = anchor_dt_utc + Duration::minutes(t);
            for c in 0..cluster_count {
                top_strength[c] = f64::NEG_INFINITY;
                second_strength[c] = f64::NEG_INFINITY;
                top_idx[c] = usize::MAX;
                second_idx[c] = usize::MAX;
                top_w[c] = 0.0;
                top_wdelta[c] = 0.0;
                second_w[c] = 0.0;
                second_wdelta[c] = 0.0;
            }

            for (e_idx, e) in nearby.iter_mut().enumerate() {
                let rel = (abs - e.dt_utc).num_minutes();
                // Pre-release drift is usually weaker than post-release moves.
                // Attenuate future-event contributions so far-away scheduled events don't dominate.
                let decay = if rel < 0 {
                    let pf = lerp(pre_factor, pre_factor_max, e.pre_alpha);
                    exp_decay_weight(rel, tau_pre_minutes) * pf
                } else {
                    exp_decay_weight(rel, tau_minutes)
                };
                let w = e.weight * decay;
                e.w_by_grid[idx] = w;
                if w <= 1e-9 {
                    e.delta_by_grid[idx] = 0.0;
                    continue;
                }
                let mu_raw = interp_piecewise(&e.offsets, &e.mu, rel, 0.0);
                let mu = if rel < 0 { -mu_raw } else { mu_raw };
                let mag = interp_piecewise(&e.offsets, &e.mag, rel, 0.0).abs();
                let mag_factor = if mag_ref > 0.0 {
                    mag / (mag + mag_ref)
                } else {
                    1.0
                };
                let delta = (mu - e.base_mu) * mag_factor;
                e.delta_by_grid[idx] = delta;
                let wdelta = w * delta;
                let strength = wdelta.abs();
                let cid = e.cluster_id;
                if cid >= cluster_count {
                    continue;
                }

                if strength > top_strength[cid] {
                    second_strength[cid] = top_strength[cid];
                    second_idx[cid] = top_idx[cid];
                    second_w[cid] = top_w[cid];
                    second_wdelta[cid] = top_wdelta[cid];
                    top_strength[cid] = strength;
                    top_idx[cid] = e_idx;
                    top_w[cid] = w;
                    top_wdelta[cid] = wdelta;
                } else if strength > second_strength[cid] {
                    second_strength[cid] = strength;
                    second_idx[cid] = e_idx;
                    second_w[cid] = w;
                    second_wdelta[cid] = wdelta;
                }
            }

            let mut cluster_rows: Vec<(f64, f64, usize)> = Vec::with_capacity(cluster_count);
            for c in 0..cluster_count {
                top_idx_by_grid[idx][c] = top_idx[c];
                second_idx_by_grid[idx][c] = second_idx[c];
                top_w_by_grid[idx][c] = top_w[c];
                top_wdelta_by_grid[idx][c] = top_wdelta[c];
                second_w_by_grid[idx][c] = second_w[c];
                second_wdelta_by_grid[idx][c] = second_wdelta[c];
                if top_idx[c] != usize::MAX && top_w[c] > 1e-9 {
                    let (sw, sd) = if cluster_top_n >= 2
                        && second_idx[c] != usize::MAX
                        && second_w[c] > 1e-9
                    {
                        (top_w[c] + second_w[c], top_wdelta[c] + second_wdelta[c])
                    } else {
                        (top_w[c], top_wdelta[c])
                    };
                    if sw <= 1e-9 {
                        continue;
                    }
                    let z = sd / sw;
                    let strength = sd.abs();
                    if z.is_finite() && strength.is_finite() {
                        cluster_rows.push((strength, z, c));
                    }
                }
            }

            cluster_rows.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
            if top_k > 0 && cluster_rows.len() > top_k {
                cluster_rows.truncate(top_k);
            }
            selected_clusters_by_grid[idx] = cluster_rows.iter().map(|r| r.2).collect();

            let z_n = cluster_rows.len();
            let sum_z: f64 = cluster_rows.iter().map(|r| r.1).sum();
            let sum_w: f64 = cluster_rows
                .iter()
                .map(|r| {
                    let c = r.2;
                    let mut sw = top_w[c];
                    if cluster_top_n >= 2 && second_idx[c] != usize::MAX && second_w[c] > 1e-9 {
                        sw += second_w[c];
                    }
                    sw
                })
                .sum();
            let sum_delta: f64 = cluster_rows
                .iter()
                .map(|r| {
                    let c = r.2;
                    let mut sd = top_wdelta[c];
                    if cluster_top_n >= 2 && second_idx[c] != usize::MAX && second_w[c] > 1e-9 {
                        sd += second_wdelta[c];
                    }
                    sd
                })
                .sum();

            let p = if z_n > 0 && sum_z.is_finite() {
                sigmoid((sum_z / (z_n as f64)) * median_scale).clamp(0.0, 1.0)
            } else {
                0.5
            };
            sum_w_by_grid[idx] = sum_w;
            sum_delta_by_grid[idx] = sum_delta;
            sum_cluster_z_by_grid[idx] = sum_z;
            n_clusters_by_grid[idx] = z_n;
            series.push(p);
        }
    } else {
        for (idx, t) in grid.iter().copied().enumerate() {
            let abs = anchor_dt_utc + Duration::minutes(t);
            let mut sum_w = 0.0;
            let mut sum_delta = 0.0;
            for e in nearby.iter_mut() {
                let rel = (abs - e.dt_utc).num_minutes();
                let decay = if rel < 0 {
                    let pf = lerp(pre_factor, pre_factor_max, e.pre_alpha);
                    exp_decay_weight(rel, tau_pre_minutes) * pf
                } else {
                    exp_decay_weight(rel, tau_minutes)
                };
                let w = e.weight * decay;
                if w <= 1e-9 {
                    continue;
                }
                let mu_raw = interp_piecewise(&e.offsets, &e.mu, rel, 0.0);
                let mu = if rel < 0 { -mu_raw } else { mu_raw };
                let mag = interp_piecewise(&e.offsets, &e.mag, rel, 0.0).abs();
                let mag_factor = if mag_ref > 0.0 {
                    mag / (mag + mag_ref)
                } else {
                    1.0
                };
                let delta = (mu - e.base_mu) * mag_factor;
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
    }

    let prior_series = if adjusted_by_actual {
        let mut prior_nearby = build_nearby(false);
        if prior_nearby.is_empty() {
            None
        } else {
            // Compute only the prior series (no need for contributions); reuse the same transform as the main path.
            let mut prior: Vec<f64> = vec![];
            if use_clusters {
                let mut top_strength: Vec<f64> = vec![f64::NEG_INFINITY; cluster_count];
                let mut top_w: Vec<f64> = vec![0.0; cluster_count];
                let mut top_wdelta: Vec<f64> = vec![0.0; cluster_count];
                for t in grid.iter().copied() {
                    let abs = anchor_dt_utc + Duration::minutes(t);
                    for c in 0..cluster_count {
                        top_strength[c] = f64::NEG_INFINITY;
                        top_w[c] = 0.0;
                        top_wdelta[c] = 0.0;
                    }
                    for e in prior_nearby.iter_mut() {
                        let rel = (abs - e.dt_utc).num_minutes();
                        let decay = if rel < 0 {
                            let pf = lerp(pre_factor, pre_factor_max, e.pre_alpha);
                            exp_decay_weight(rel, tau_pre_minutes) * pf
                        } else {
                            exp_decay_weight(rel, tau_minutes)
                        };
                        let w = e.weight * decay;
                        if w <= 1e-9 {
                            continue;
                        }
                        let mu_raw = interp_piecewise(&e.offsets, &e.mu, rel, 0.0);
                        let mu = if rel < 0 { -mu_raw } else { mu_raw };
                        let mag = interp_piecewise(&e.offsets, &e.mag, rel, 0.0).abs();
                        let mag_factor = if mag_ref > 0.0 {
                            mag / (mag + mag_ref)
                        } else {
                            1.0
                        };
                        let delta = (mu - e.base_mu) * mag_factor;
                        let wdelta = w * delta;
                        let strength = wdelta.abs();
                        let cid = e.cluster_id;
                        if cid >= cluster_count {
                            continue;
                        }
                        if strength > top_strength[cid] {
                            top_strength[cid] = strength;
                            top_w[cid] = w;
                            top_wdelta[cid] = wdelta;
                        }
                    }
                    let mut cluster_rows: Vec<(f64, usize)> = Vec::with_capacity(cluster_count);
                    for c in 0..cluster_count {
                        if top_strength[c] > f64::NEG_INFINITY / 2.0 && top_w[c] > 1e-9 {
                            let strength = top_wdelta[c].abs();
                            if strength.is_finite() {
                                cluster_rows.push((strength, c));
                            }
                        }
                    }
                    cluster_rows
                        .sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
                    if top_k > 0 && cluster_rows.len() > top_k {
                        cluster_rows.truncate(top_k);
                    }
                    // Recompute using the same aggregation as the main path (simple mean of cluster deltas).
                    let z_n = cluster_rows.len();
                    let sum_z: f64 = cluster_rows
                        .iter()
                        .map(|r| {
                            let c = r.1;
                            if top_w[c] > 1e-9 {
                                top_wdelta[c] / top_w[c]
                            } else {
                                0.0
                            }
                        })
                        .sum();
                    let p = if z_n > 0 && sum_z.is_finite() {
                        sigmoid((sum_z / (z_n as f64)) * median_scale).clamp(0.0, 1.0)
                    } else {
                        0.5
                    };
                    prior.push(p);
                }
            } else {
                for t in grid.iter().copied() {
                    let abs = anchor_dt_utc + Duration::minutes(t);
                    let mut sum_w = 0.0;
                    let mut sum_delta = 0.0;
                    for e in prior_nearby.iter_mut() {
                        let rel = (abs - e.dt_utc).num_minutes();
                        let decay = if rel < 0 {
                            let pf = lerp(pre_factor, pre_factor_max, e.pre_alpha);
                            exp_decay_weight(rel, tau_pre_minutes) * pf
                        } else {
                            exp_decay_weight(rel, tau_minutes)
                        };
                        let w = e.weight * decay;
                        if w <= 1e-9 {
                            continue;
                        }
                        let mu_raw = interp_piecewise(&e.offsets, &e.mu, rel, 0.0);
                        let mu = if rel < 0 { -mu_raw } else { mu_raw };
                        let mag = interp_piecewise(&e.offsets, &e.mag, rel, 0.0).abs();
                        let mag_factor = if mag_ref > 0.0 {
                            mag / (mag + mag_ref)
                        } else {
                            1.0
                        };
                        let delta = (mu - e.base_mu) * mag_factor;
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
            }
            Some(prior)
        }
    } else {
        None
    };

    let recompute_cluster_p =
        |idx: usize, override_cid: usize, override_row: Option<(f64, f64)>| -> f64 {
            let mut rows: Vec<(f64, f64)> = Vec::with_capacity(cluster_count); // (strength, z)
            for c in 0..cluster_count {
                let (sw, sd) = if c == override_cid {
                    match override_row {
                        Some(v) => v,
                        None => continue,
                    }
                } else {
                    let mut sw = top_w_by_grid[idx][c];
                    let mut sd = top_wdelta_by_grid[idx][c];
                    if cluster_top_n >= 2 && second_idx_by_grid[idx][c] != usize::MAX {
                        let w2 = second_w_by_grid[idx][c];
                        if w2 > 1e-9 {
                            sw += w2;
                            sd += second_wdelta_by_grid[idx][c];
                        }
                    }
                    (sw, sd)
                };
                if sw <= 1e-9 {
                    continue;
                }
                let z = sd / sw;
                let strength = sd.abs();
                if z.is_finite() && strength.is_finite() {
                    rows.push((strength, z));
                }
            }
            rows.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
            if top_k > 0 && rows.len() > top_k {
                rows.truncate(top_k);
            }
            let n = rows.len();
            if n > 0 {
                let sum_z: f64 = rows.iter().map(|r| r.1).sum();
                sigmoid((sum_z / (n as f64)) * median_scale).clamp(0.0, 1.0)
            } else {
                0.5
            }
        };

    let contributions: Vec<Value> = nearby
        .iter()
        .enumerate()
        .filter(|(_i, e)| e.in_display_window)
        .map(|(e_idx, e)| {
            let mut delta_p_up: Vec<f64> = vec![0.0; grid.len()];
            for (idx, _t) in grid.iter().copied().enumerate() {
                let p_without = if use_clusters && e.cluster_id < cluster_count {
                    let cid = e.cluster_id;
                    let top_idx = top_idx_by_grid[idx][cid];
                    let second_idx = second_idx_by_grid[idx][cid];
                    let is_top = top_idx == e_idx;
                    let is_second = second_idx == e_idx;
                    // In cluster-mean mode, only the top-N items per cluster affect the path.
                    if is_top || (cluster_top_n >= 2 && is_second) {
                        let mut sw = top_w_by_grid[idx][cid];
                        let mut sd = top_wdelta_by_grid[idx][cid];
                        if cluster_top_n >= 2 && second_idx != usize::MAX {
                            let w2 = second_w_by_grid[idx][cid];
                            if w2 > 1e-9 {
                                sw += w2;
                                sd += second_wdelta_by_grid[idx][cid];
                            }
                        }
                        // If this cluster isn't in the top-K set, removing the top item can't affect the path.
                        if top_k > 0 && !selected_clusters_by_grid[idx].contains(&cid) {
                            series[idx]
                        } else {
                            let (w_rm, d_rm) = if is_top {
                                (top_w_by_grid[idx][cid], top_wdelta_by_grid[idx][cid])
                            } else {
                                (second_w_by_grid[idx][cid], second_wdelta_by_grid[idx][cid])
                            };
                            let sw2 = (sw - w_rm).max(0.0);
                            let sd2 = sd - d_rm;
                            if sw2 > 1e-9 {
                                recompute_cluster_p(idx, cid, Some((sw2, sd2)))
                            } else {
                                // No remaining candidate: drop the cluster entirely.
                                recompute_cluster_p(idx, cid, None)
                            }
                        }
                    } else {
                        series[idx]
                    }
                } else {
                    let sw = sum_w_by_grid[idx] - e.w_by_grid[idx];
                    let sd = sum_delta_by_grid[idx] - e.w_by_grid[idx] * e.delta_by_grid[idx];
                    if sw > 1e-9 {
                        sigmoid((sd / sw) * median_scale).clamp(0.0, 1.0)
                    } else {
                        0.5
                    }
                };
                delta_p_up[idx] = (series[idx] - p_without).clamp(-1.0, 1.0);
            }
            let dt_key = e.dt_utc.format("%d-%m-%Y %H:%M").to_string();
            json!({
                "eventId": e.id,
                "dtKey": dt_key,
                "label": format!("{} · {}", e.label.trim(), dt_key),
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
            "tauMinutes": tau_minutes,
            "preFactor": pre_factor,
            "magRef": mag_ref,
            "medianScale": median_scale,
            "topK": top_k,
            "clusterMode": match cluster_mode {
                ClusterMode::None => "none",
                ClusterMode::Metric => "metric",
                ClusterMode::Relationships => "relationships",
            },
            "clusters": cluster_count,
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
                if let Some(ctx) = predict_market_ctx.as_ref() {
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
    let predict_market = predict_market_ctx.unwrap_or_else(|| json!({}));

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
