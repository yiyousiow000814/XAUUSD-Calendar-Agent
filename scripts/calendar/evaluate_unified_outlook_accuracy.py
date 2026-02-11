"""
Evaluate Unified Outlook P(t) against realized XAUUSD returns.

This mirrors the Rust fallback builder in `commands/analysis.rs::build_unified_outlook_fallback`:
  - Impact model: `data/analysis/xauusd_event_impact_usd.json` (bucket-mixed baseline)
  - Schedule context: use historical release instances from `data/event_history_index/*_event_history_clean.csv`
  - Time grid: -24h..+24h, 15m step
  - Combine contributions in logit space with exp-decay (tau=480m) and delta_scale=6
  - Shrink low-N bucket probabilities toward 0.5 (shrink_k=40)
  - Scale each logit delta by median-move magnitude (p50_all) so tiny moves don't dominate (mag_ref=0.05)

Accuracy definition (directional):
  - For each anchor release and each horizon, we compare:
      predicted direction = sign(P(up) - 0.5)
      realized direction  = sign( return(anchor->horizon) )

This is a *directional* alignment score for a probability path (not a point forecast).
"""

from __future__ import annotations

import argparse
import json
import math
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd


def _parse_numeric(value: object) -> Optional[float]:
    if value is None:
        return None
    text = str(value).strip()
    if (not text) or text.lower() in {"-", "n/a", "na", "tba", "null", "\u2014"}:
        return None
    mult = 1.0
    if text.endswith("%"):
        mult = 0.01
        text = text[:-1]
    suf = text[-1].lower() if text else ""
    if suf in {"k", "m", "b", "t"}:
        text = text[:-1]
        mult *= {
            "k": 1_000,
            "m": 1_000_000,
            "b": 1_000_000_000,
            "t": 1_000_000_000_000,
        }[suf]
    text = text.replace(",", "")
    try:
        return float(text) * mult
    except ValueError:
        return None


def _parse_dt_utc_ddmmyyyy(raw: str) -> Optional[datetime]:
    raw = str(raw or "").strip()
    if not raw:
        return None
    # Examples: "18-10-2016 00:00:00.000"
    for fmt in ("%d-%m-%Y %H:%M:%S.%f", "%d-%m-%Y %H:%M:%S"):
        try:
            return datetime.strptime(raw, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    return None


def _parse_event_dt_utc(date_str: str, time_str: str, *, calendar_offset_minutes: int) -> Optional[datetime]:
    time_str = (time_str or "").strip()
    if (not time_str) or time_str in {"All Day", "Tentative"}:
        return None
    hhmm = time_str.split(":")[:2]
    if len(hhmm) != 2:
        return None
    try:
        hh = int(hhmm[0])
        mm = int(hhmm[1])
    except ValueError:
        return None
    d = str(date_str).strip()
    parts = d.split("-")
    try:
        if len(parts) == 3 and len(parts[0]) == 2 and len(parts[2]) == 4:
            dd, mo, yy = int(parts[0]), int(parts[1]), int(parts[2])
        elif len(parts) == 3 and len(parts[0]) == 4:
            yy, mo, dd = int(parts[0]), int(parts[1]), int(parts[2])
        else:
            return None
        # The Economic_Calendar export stores times in the calendar timezone (commonly UTC+8).
        # Convert to true UTC by subtracting the calendar offset.
        local = datetime(yy, mo, dd, hh, mm, tzinfo=timezone.utc)
        return local - timedelta(minutes=int(calendar_offset_minutes))
    except ValueError:
        return None


def _importance_weight(raw: str) -> float:
    raw = str(raw or "").strip().lower()
    if raw == "high":
        return 1.0
    if raw == "medium":
        return 0.7
    if raw == "low":
        return 0.4
    return 0.5


def _sigmoid(x: float) -> float:
    return 1.0 / (1.0 + np.exp(-x))


def _logit(p: float) -> float:
    p = float(np.clip(p, 1e-6, 1.0 - 1e-6))
    return float(np.log(p / (1.0 - p)))


def _exp_decay_weight(minutes: int, tau_minutes: float) -> float:
    if tau_minutes <= 0.0:
        return 1.0
    return float(np.exp(-abs(minutes) / tau_minutes))


def _interp_piecewise(xs: list[int], ys: list[float], x: int, default: float) -> float:
    if not xs or not ys or len(xs) != len(ys):
        return default
    if x <= xs[0]:
        return ys[0]
    if x >= xs[-1]:
        return ys[-1]
    # linear interpolation
    for i in range(1, len(xs)):
        x1 = xs[i]
        if x <= x1:
            x0 = xs[i - 1]
            y0 = ys[i - 1]
            y1 = ys[i]
            span = float(x1 - x0)
            if span <= 0:
                return y1
            t = float(x - x0) / span
            return float(y0 + (y1 - y0) * t)
    return default


@dataclass(frozen=True)
class ImpactMetric:
    offsets: list[int]
    p_up: list[float]
    p50_all: list[float]
    n: list[float]


@dataclass(frozen=True)
class PredictReleaseSubModel:
    weights: np.ndarray  # shape [d][3] for classes ["="," >", "<"]
    threshold: float
    # Optional per-metric confidence gates (same shape as the app model JSON).
    enabled_metrics: Optional[dict[str, dict]] = None


@dataclass(frozen=True)
class PredictReleaseModel:
    # Actual vs Previous (A-P)
    ap_with_forecast: Optional[PredictReleaseSubModel] = None
    ap_no_forecast: Optional[PredictReleaseSubModel] = None
    # Actual vs Forecast (A-F), used as an optional "expectations surprise" view.
    af_with_forecast: Optional[PredictReleaseSubModel] = None


def _load_predict_release_model(path: Path) -> Optional[PredictReleaseModel]:
    if not path.exists():
        return None
    raw = json.loads(path.read_text(encoding="utf-8"))
    if int(raw.get("schema") or 0) != 1:
        return None

    def _sub(key: str) -> Optional[PredictReleaseSubModel]:
        m = (raw.get("models") or {}).get(key) or {}
        w = np.asarray(m.get("weights") or [], dtype="float64")
        if w.ndim != 2 or w.shape[1] != 3 or w.shape[0] < 2:
            return None
        th = m.get("recommended_threshold")
        try:
            th = float(th) if th is not None else None
        except Exception:
            th = None
        if th is None or (not np.isfinite(th)):
            th = 0.25
        enabled = ((m.get("metric_gates") or {}).get("enabled_metrics")) if isinstance(m, dict) else None
        enabled = enabled if isinstance(enabled, dict) else None
        return PredictReleaseSubModel(weights=w, threshold=float(th), enabled_metrics=enabled)

    ap_wf = _sub("ap_with_forecast")
    ap_nf = _sub("ap_no_forecast")
    af = _sub("af_with_forecast")
    if ap_wf is None and ap_nf is None and af is None:
        return None
    return PredictReleaseModel(ap_with_forecast=ap_wf, ap_no_forecast=ap_nf, af_with_forecast=af)


def _load_impact(
    path: Path,
) -> tuple[
    list[int],  # windows_sorted
    dict[str, dict],  # impact_events_obj
    dict[str, ImpactMetric],  # curves_ap_unconditional
    dict[str, ImpactMetric],  # curves_af_unconditional
]:
    impact = json.loads(path.read_text(encoding="utf-8"))
    if int(impact.get("schema") or 0) != 1:
        raise SystemExit("Unsupported impact schema")
    windows = [int(v) for v in (impact.get("windows_minutes") or [])]
    if len(windows) < 2:
        raise SystemExit("Impact JSON missing windows_minutes")
    windows_sorted = sorted(windows)
    events_obj = impact.get("events") or {}

    # Precompute unconditional p_up curve per metric id by mixing buckets using bucket sample sizes.
    ref_offset = min(windows_sorted, key=lambda v: abs(v))
    ref_key = str(ref_offset)

    def build_uncond_curve(buckets: dict, keys: tuple[str, str, str]) -> Optional[ImpactMetric]:
        bucket_weights: list[tuple[str, float]] = []
        for b in keys:
            n = ((buckets.get(b) or {}).get(ref_key, {}) or {}).get("n", 0.0)
            try:
                n = float(n)
            except Exception:
                n = 0.0
            if n > 0.0:
                bucket_weights.append((b, n))
        denom = sum(w for _, w in bucket_weights)
        if denom <= 0:
            return None
        bucket_weights = [(b, w / denom) for b, w in bucket_weights]

        offs: list[int] = []
        pups: list[float] = []
        p50s: list[float] = []
        ns: list[float] = []
        for off in windows_sorted:
            key = str(off)
            pup = 0.5
            p50 = 0.0
            n_total = 0.0
            used = False
            for b, w in bucket_weights:
                stats = (buckets.get(b) or {}).get(key)
                if not isinstance(stats, dict):
                    continue
                try:
                    n_total += float(stats.get("n") or 0.0)
                except Exception:
                    pass
                p = stats.get("p_up")
                if p is None:
                    d = stats.get("p_down")
                    p = (1.0 - float(d)) if d is not None else None
                if p is None:
                    continue
                pup += (float(p) - 0.5) * float(w)
                # Use weighted average of per-bucket median as a rough "typical move" magnitude proxy.
                try:
                    p50 += float(stats.get("p50_all") or 0.0) * float(w)
                except Exception:
                    pass
                used = True
            if used:
                offs.append(int(off))
                pups.append(float(np.clip(pup, 0.0, 1.0)))
                p50s.append(float(p50))
                ns.append(float(n_total))
        if len(offs) < 2:
            return None
        return ImpactMetric(offsets=offs, p_up=pups, p50_all=p50s, n=ns)

    ap_keys = ("ap_gt_prev", "ap_lt_prev", "ap_eq_prev")
    af_keys = ("af_gt_forecast", "af_lt_forecast", "af_eq_forecast")

    curves_ap: dict[str, ImpactMetric] = {}
    curves_af: dict[str, ImpactMetric] = {}
    for metric_id, buckets in events_obj.items():
        if not isinstance(buckets, dict):
            continue
        ap = build_uncond_curve(buckets, ap_keys)
        if ap is not None:
            curves_ap[metric_id] = ap
        af = build_uncond_curve(buckets, af_keys)
        if af is not None:
            curves_af[metric_id] = af

    return windows_sorted, events_obj, curves_ap, curves_af


def _linreg_hat(last_actuals: list[float], n: int = 6) -> Optional[float]:
    if len(last_actuals) < n:
        return None
    y = np.asarray(last_actuals[-n:], dtype=float)
    m = int(y.shape[0])
    x = np.arange(m, dtype=float)
    sx = float(x.sum())
    sy = float(y.sum())
    sxx = float((x * x).sum())
    sxy = float((x * y).sum())
    denom = m * sxx - sx * sx
    if denom == 0:
        return None
    slope = (m * sxy - sx * sy) / denom
    intercept = (sy - slope * sx) / m
    return float(slope * m + intercept)


def _median(values: list[float]) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    mid = (len(s) - 1) / 2.0
    lo = s[int(math.floor(mid))]
    hi = s[int(math.ceil(mid))]
    return float((lo + hi) / 2.0)


def _median_abs(values: list[float]) -> float:
    vs = [abs(v) for v in values if np.isfinite(v)]
    m = _median(vs)
    if not np.isfinite(m) or m <= 1e-12:
        return 1.0
    return float(m)


def _mad(values: list[float]) -> float:
    if not values:
        return 1.0
    med = _median(values)
    mad = _median([abs(v - med) for v in values if np.isfinite(v)])
    if not np.isfinite(mad) or mad <= 1e-12:
        return 1.0
    return float(mad)


def _softmax1d(scores: np.ndarray) -> np.ndarray:
    if scores.size == 0:
        return np.asarray([], dtype="float64")
    z = scores - float(np.max(scores))
    e = np.exp(z)
    denom = float(np.sum(e))
    if not np.isfinite(denom) or denom <= 0.0:
        return np.ones_like(scores, dtype="float64") / float(scores.size)
    return e / denom


def _confidence_score(probs: np.ndarray) -> float:
    if probs.size < 3:
        return 0.0
    sp = np.sort(probs)
    maxp = float(sp[-1])
    second = float(sp[-2])
    return float(maxp * max(0.0, maxp - second))


def _metric_key_from_impact_metric_id(metric_id: str) -> str:
    # Impact model uses CUR::Metric::freq. Predict Release uses the Metric string as a key.
    parts = str(metric_id or "").split("::")
    if len(parts) >= 2:
        return str(parts[1]).strip()
    return str(metric_id or "").strip()


def _alpha_from_conf(conf: float, *, th: float) -> float:
    # Convert a confidence score into a smooth blend weight:
    # - below threshold -> 0 (pure unconditional)
    # - above threshold -> scale into (0..1]
    if not np.isfinite(conf):
        return 0.0
    th = float(th)
    if not np.isfinite(th):
        th = 0.0
    if conf <= th + 1e-12:
        return 0.0
    if th >= 1.0 - 1e-12:
        return 0.0
    return float(np.clip((float(conf) - th) / (1.0 - th), 0.0, 1.0))


_MONTH_TOKENS = {
    "jan",
    "feb",
    "mar",
    "apr",
    "may",
    "jun",
    "jul",
    "aug",
    "sep",
    "oct",
    "nov",
    "dec",
}


def _detect_frequency(raw: str) -> str:
    lowered = str(raw or "").lower()
    if ("y/y" in lowered) or ("yoy" in lowered):
        return "y/y"
    if ("m/m" in lowered) or ("mom" in lowered):
        return "m/m"
    if ("q/q" in lowered) or ("qoq" in lowered):
        return "q/q"
    if ("w/w" in lowered) or ("wow" in lowered):
        return "w/w"
    return "none"


def _looks_like_period(token: str) -> bool:
    t = str(token or "").strip().lower().replace(".", "")
    if t in _MONTH_TOKENS:
        return True
    if len(t) == 2 and t.startswith("q") and t[1] in {"1", "2", "3", "4"}:
        return True
    return len(t) == 4 and t.isdigit()


def _strip_known_suffixes(raw: str) -> str:
    trimmed = str(raw or "").strip()
    while trimmed.endswith(")"):
        open_idx = trimmed.rfind("(")
        if open_idx < 0:
            break
        token = trimmed[open_idx + 1 : -1].strip()
        normalized = token.lower().replace(".", "")
        is_freq = any(
            x in normalized for x in ("y/y", "yoy", "m/m", "mom", "q/q", "qoq", "w/w", "wow")
        )
        if _looks_like_period(token) or is_freq:
            trimmed = trimmed[:open_idx].rstrip()
            continue
        break
    return " ".join(trimmed.split()).replace("::", " ")


def _build_impact_metric_id(currency: str, event: str) -> str:
    cur = str(currency or "").strip().upper() or "NA"
    metric = _strip_known_suffixes(event)
    freq = _detect_frequency(event)
    return f"{cur}::{metric}::{freq}"


def _load_calendar_events(
    root: Path, *, currency: str = "USD", calendar_offset_minutes: int = 0
) -> pd.DataFrame:
    frames: list[pd.DataFrame] = []
    for year_dir in sorted(root.glob("*")):
        if not year_dir.is_dir():
            continue
        year = year_dir.name
        json_path = year_dir / f"{year}_calendar.json"
        csv_path = year_dir / f"{year}_calendar.csv"
        path = json_path if json_path.exists() else csv_path if csv_path.exists() else None
        if path is None:
            continue
        try:
            if path.suffix == ".json":
                data = json.loads(path.read_text(encoding="utf-8"))
                df = pd.DataFrame(data)
            else:
                df = pd.read_csv(path)
        except Exception:
            continue
        if df.empty:
            continue
        df = df.rename(
            columns={
                "Cur.": "currency",
                "Imp.": "importance",
                "Event": "event_name",
                "Actual": "actual_raw",
                "Forecast": "forecast_raw",
                "Previous": "previous_raw",
            }
        )
        needed = {"Date", "Time", "currency", "importance", "event_name", "actual_raw", "forecast_raw", "previous_raw"}
        if not needed.issubset(df.columns):
            continue
        df = df[list(needed)].copy()
        frames.append(df)

    if not frames:
        return pd.DataFrame(columns=["dt_utc", "event", "impact_metric_id", "importance", "a", "f", "p"])

    out = pd.concat(frames, ignore_index=True)
    out["currency"] = out["currency"].fillna("").astype(str).str.upper()
    out["importance"] = out["importance"].fillna("").astype(str).str.title()
    out["event"] = out["event_name"].fillna("").astype(str)
    out["impact_metric_id"] = out["event_name"].map(lambda s: _build_impact_metric_id(currency.upper(), str(s)))
    out["a"] = out["actual_raw"].map(_parse_numeric)
    out["f"] = out["forecast_raw"].map(_parse_numeric)
    out["p"] = out["previous_raw"].map(_parse_numeric)
    out["dt_utc"] = [
        _parse_event_dt_utc(d, t, calendar_offset_minutes=int(calendar_offset_minutes))
        for d, t in zip(out["Date"].astype(str), out["Time"].astype(str), strict=False)
    ]
    out = out.dropna(subset=["dt_utc"]).copy()
    out["dt_utc"] = pd.to_datetime(out["dt_utc"], utc=True)
    out = out[out["currency"] == currency.upper()].copy()
    out = out.sort_values("dt_utc").reset_index(drop=True)
    return out[["dt_utc", "event", "impact_metric_id", "importance", "a", "f", "p"]].copy()


def _load_price_minutes(path: Path) -> pd.DataFrame:
    df = pd.read_csv(
        path,
        usecols=["bar_open_time_utc", "close"],
        dtype={"bar_open_time_utc": "string", "close": "float64"},
    )
    df["dt_utc"] = df["bar_open_time_utc"].map(_parse_dt_utc_ddmmyyyy)
    df = df.dropna(subset=["dt_utc"]).copy()
    df["dt_utc"] = pd.to_datetime(df["dt_utc"], utc=True)
    df = df.sort_values("dt_utc").drop_duplicates("dt_utc").reset_index(drop=True)
    return df[["dt_utc", "close"]].copy()


def _direction_from_prob(p: float, eps: float = 0.0) -> int:
    if abs(p - 0.5) <= eps:
        return 0
    return 1 if p > 0.5 else -1


def _direction_from_return(r: float, eps: float = 0.0) -> int:
    if abs(r) <= eps:
        return 0
    return 1 if r > 0 else -1


def _compute_unified_path_for_anchor(
    *,
    anchor_dt_utc: datetime,
    events: pd.DataFrame,
    curves_ap: dict[str, ImpactMetric],
    curves_af: dict[str, ImpactMetric],
    impact_events_obj: dict[str, dict],
    grid_minutes: list[int],
    include_half_minutes: int = 2880,
    tau_minutes: float = 480.0,
    tau_pre_scale: float = 0.5,
    pre_factor: float = 0.4,
    delta_scale: float = 6.0,
    mode: str = "logit",
    bucket_family: str = "auto",
    median_scale: float = 120.0,
    top_k: int = 0,
    predict_model: Optional[PredictReleaseModel] = None,
) -> Optional[list[float]]:
    mode = str(mode or "logit").strip().lower()
    if mode not in {"logit", "median"}:
        mode = "logit"

    start = anchor_dt_utc - timedelta(minutes=include_half_minutes)
    end = anchor_dt_utc + timedelta(minutes=include_half_minutes)
    window = events[(events["dt_utc"] >= start) & (events["dt_utc"] <= end)].copy()
    if window.empty:
        return None

    # Build nearby events with per-instance p_up curve.
    # If we can predict the event's bucket (ap_gt_prev/ap_eq_prev/ap_lt_prev) from its own
    # Forecast/Previous (or a tiny model when Forecast is missing), use that bucket curve.
    # This avoids diluting signal by mixing all buckets just by sample size.
    nearby: list[tuple[datetime, float, ImpactMetric]] = []

    # Cache full-history metric frames (we need past samples for Predict Release mixing).
    metric_all_cache: dict[str, pd.DataFrame] = {}

    def pick_curve_for_instance(metric_id: str, ev_dt: datetime) -> Optional[ImpactMetric]:
        buckets = impact_events_obj.get(metric_id)
        base_ap = curves_ap.get(metric_id)
        base_af = curves_af.get(metric_id)
        fam = str(bucket_family or "auto").strip().lower()
        if fam not in {"auto", "ap", "af", "hybrid"}:
            fam = "auto"
        if fam in {"ap", "hybrid"}:
            base = base_ap if base_ap is not None else base_af
        elif fam == "af":
            base = base_af if base_af is not None else base_ap
        else:
            base = base_af if base_af is not None else base_ap
        if not isinstance(buckets, dict):
            return base
        if base is None:
            return None

        g = metric_all_cache.get(metric_id)
        if g is None:
            g = events[events["impact_metric_id"] == metric_id].sort_values("dt_utc").reset_index(drop=True)
            metric_all_cache[metric_id] = g
        if g is None:
            return base

        inst = g[g["dt_utc"] == ev_dt].head(1)
        if inst.empty:
            return base

        def is_finite(v: object) -> bool:
            try:
                return v is not None and np.isfinite(float(v))
            except Exception:
                return False

        a = inst["a"].iloc[0]
        f = inst["f"].iloc[0]
        p = inst["p"].iloc[0]

        has_a = is_finite(a)
        has_f = is_finite(f)
        has_p = is_finite(p)

        # As-of anchor time: only events that already happened can use Actual.
        use_actual = ev_dt <= anchor_dt_utc and has_a

        bucket_key: Optional[str] = None
        if use_actual:
            # Prefer the requested bucket family, but keep a safe fallback when one side is unavailable.
            prefer_af = fam in {"af", "auto", "hybrid"}
            prefer_ap = fam == "ap"

            if prefer_af and has_f and base_af is not None:
                d = float(a) - float(f)
                if d > 0:
                    bucket_key = "af_gt_forecast"
                elif d < 0:
                    bucket_key = "af_lt_forecast"
                else:
                    bucket_key = "af_eq_forecast"

            if bucket_key is None and has_p and base_ap is not None:
                d = float(a) - float(p)
                if d > 0:
                    bucket_key = "ap_gt_prev"
                elif d < 0:
                    bucket_key = "ap_lt_prev"
                else:
                    bucket_key = "ap_eq_prev"

            # If we're explicitly in AP mode but AP curve isn't available, fall back to AF.
            if bucket_key is None and prefer_ap and has_f and base_af is not None:
                d = float(a) - float(f)
                if d > 0:
                    bucket_key = "af_gt_forecast"
                elif d < 0:
                    bucket_key = "af_lt_forecast"
                else:
                    bucket_key = "af_eq_forecast"

        # For future events we intentionally don't guess the surprise sign.
        # We fall back to unconditional mixing unless we can confidently mix buckets.
        if bucket_key is None:
            metric_key = _metric_key_from_impact_metric_id(metric_id)

            def maybe_mix_curve_from_model(
                *,
                sub: PredictReleaseSubModel,
                base_curve: ImpactMetric,
                bucket_keys: tuple[str, str, str],
                features: np.ndarray,
            ) -> Optional[ImpactMetric]:
                # Respect per-metric gates when present.
                if sub.enabled_metrics is not None and metric_key not in sub.enabled_metrics:
                    return None
                w = sub.weights
                if w.shape[0] != features.size:
                    return None
                scores = features @ w
                probs = _softmax1d(scores)
                conf = float(_confidence_score(probs))

                th = float(sub.threshold)
                if sub.enabled_metrics is not None:
                    row = sub.enabled_metrics.get(metric_key) or {}
                    try:
                        th_m = float(row.get("th")) if row.get("th") is not None else None
                    except Exception:
                        th_m = None
                    if th_m is not None and np.isfinite(th_m):
                        th = float(th_m)

                alpha = _alpha_from_conf(conf, th=th)
                if alpha <= 0.0:
                    return None

                shrink_k = 40.0
                offs: list[int] = []
                pups: list[float] = []
                p50s: list[float] = []
                ns: list[float] = []

                weights_by_bucket = {
                    bucket_keys[0]: float(probs[0]),
                    bucket_keys[1]: float(probs[1]),
                    bucket_keys[2]: float(probs[2]),
                }

                for off in base_curve.offsets:
                    key = str(int(off))
                    pup = 0.5
                    p50 = 0.0
                    n_total = 0.0
                    used = False
                    for b, wgt in weights_by_bucket.items():
                        stats = (buckets.get(b) or {}).get(key)
                        if not isinstance(stats, dict):
                            continue
                        p_up = stats.get("p_up")
                        if p_up is None:
                            dwn = stats.get("p_down")
                            p_up = (1.0 - float(dwn)) if dwn is not None else None
                        if p_up is None:
                            continue
                        try:
                            n_b = float(stats.get("n") or 0.0)
                        except Exception:
                            n_b = 0.0
                        n_total += max(0.0, float(n_b))
                        shrink_b = float(n_b) / (float(n_b) + shrink_k) if n_b > 0 else 0.0
                        p_up = 0.5 + (float(p_up) - 0.5) * shrink_b
                        pup += (float(p_up) - 0.5) * float(wgt)
                        try:
                            p50 += float(stats.get("p50_all") or 0.0) * float(wgt)
                        except Exception:
                            pass
                        used = True
                    if not used:
                        continue
                    shrink = n_total / (n_total + shrink_k) if n_total > 0 else 0.0
                    pup = 0.5 + (pup - 0.5) * float(shrink)
                    offs.append(int(off))
                    pups.append(float(np.clip(float(pup), 0.0, 1.0)))
                    p50s.append(float(p50))
                    ns.append(float(n_total))

                if len(offs) < 2:
                    return None

                pred_curve = ImpactMetric(offsets=offs, p_up=pups, p50_all=p50s, n=ns)
                if alpha >= 1.0 - 1e-12:
                    return pred_curve

                blend_p = [
                    float((1.0 - alpha) * float(b) + alpha * float(p))
                    for b, p in zip(base_curve.p_up, pred_curve.p_up, strict=False)
                ]
                blend_m = [
                    float((1.0 - alpha) * float(b) + alpha * float(p))
                    for b, p in zip(base_curve.p50_all, pred_curve.p50_all, strict=False)
                ]
                return ImpactMetric(
                    offsets=list(base_curve.offsets),
                    p_up=blend_p,
                    p50_all=blend_m,
                    n=list(base_curve.n),
                )

            # Mix only for truly future instances (no look-ahead), and only when we have enough history
            # to compute stable, per-metric scales and recent-window features.
            if predict_model is not None and ev_dt > anchor_dt_utc:
                hist = g[g["dt_utc"] < anchor_dt_utc]
                if not hist.empty and has_p:
                    diffs_ap = [
                        float(x)
                        for x in (hist["a"] - hist["p"]).dropna().tolist()
                        if np.isfinite(x)
                    ]
                    diffs_fp = [
                        float(x)
                        for x in (hist["f"] - hist["p"]).dropna().tolist()
                        if np.isfinite(x)
                    ]
                    diffs_af = [
                        float(x)
                        for x in (hist["a"] - hist["f"]).dropna().tolist()
                        if np.isfinite(x)
                    ]
                    actual_series = [float(x) for x in hist["a"].dropna().tolist() if np.isfinite(x)]

                    if len(diffs_ap) >= 12 and len(actual_series) >= 12:
                        scale_ap = _median_abs(diffs_ap)
                        scale_fp = _median_abs(diffs_fp) if diffs_fp else 1.0
                        scale_af = _median_abs(diffs_af) if diffs_af else 1.0
                        med_a = _median(actual_series)
                        mad_a = _mad(actual_series)

                        last_d6 = diffs_ap[-6:]
                        last_d3 = diffs_ap[-3:]
                        last_a6 = actual_series[-6:]
                        last_a = actual_series[-1]

                        z_ap_1 = (last_d6[-1] / scale_ap) if last_d6 else 0.0
                        z_ap_3 = (float(np.mean(last_d3)) / scale_ap) if last_d3 else 0.0
                        z_ap_6 = (float(np.mean(last_d6)) / scale_ap) if last_d6 else 0.0
                        z_a_level = (last_a - med_a) / mad_a if mad_a > 0 else 0.0

                        z_a_slope6 = 0.0
                        if len(last_a6) >= 2:
                            n = len(last_a6)
                            x = np.arange(n, dtype="float64")
                            y = np.asarray(last_a6, dtype="float64")
                            sx = float(x.sum())
                            sy = float(y.sum())
                            sxx = float((x * x).sum())
                            sxy = float((x * y).sum())
                            denom = n * sxx - sx * sx
                            if abs(denom) > 1e-12:
                                slope = (n * sxy - sx * sy) / denom
                                z_a_slope6 = float(slope) / float(scale_ap)

                        z_af_1 = (diffs_af[-1] / scale_af) if diffs_af else 0.0
                        z_fp = ((float(f) - float(p)) / scale_fp) if has_f and scale_fp > 0 else 0.0

                        # Requested bucket family decides which sub-model we can use.
                        if fam == "af" or (fam == "auto" and has_f and base_af is not None):
                            if has_f and base_af is not None and predict_model.af_with_forecast is not None and len(diffs_af) >= 12:
                                features8 = np.asarray(
                                    [1.0, z_fp, z_ap_1, z_ap_3, z_ap_6, z_a_level, z_a_slope6, z_af_1],
                                    dtype="float64",
                                )
                                mixed = maybe_mix_curve_from_model(
                                    sub=predict_model.af_with_forecast,
                                    base_curve=base_af,
                                    bucket_keys=("af_eq_forecast", "af_gt_forecast", "af_lt_forecast"),
                                    features=features8,
                                )
                                if mixed is not None:
                                    return mixed
                        else:
                            # Prefer AP curves for unified prediction unless explicitly asked for AF.
                            if has_f and base_ap is not None and predict_model.ap_with_forecast is not None:
                                features8 = np.asarray(
                                    [1.0, z_fp, z_ap_1, z_ap_3, z_ap_6, z_a_level, z_a_slope6, z_af_1],
                                    dtype="float64",
                                )
                                mixed = maybe_mix_curve_from_model(
                                    sub=predict_model.ap_with_forecast,
                                    base_curve=base_ap,
                                    bucket_keys=("ap_eq_prev", "ap_gt_prev", "ap_lt_prev"),
                                    features=features8,
                                )
                                if mixed is not None:
                                    return mixed

                            if (not has_f) and base_ap is not None and predict_model.ap_no_forecast is not None and len(last_a6) >= 6:
                                a_hat = _linreg_hat(actual_series, n=6)
                                z_hat_ap = ((float(a_hat) - float(p)) / scale_ap) if a_hat is not None else 0.0
                                z_hat_da = ((float(a_hat) - float(last_a)) / scale_ap) if a_hat is not None else 0.0
                                last_dt = pd.Timestamp(hist["dt_utc"].iloc[-1]).to_pydatetime()
                                gap_days = float((ev_dt - last_dt).days) if ev_dt and last_dt else 0.0
                                features9 = np.asarray(
                                    [1.0, z_ap_1, z_ap_3, z_ap_6, z_a_level, z_a_slope6, z_hat_ap, z_hat_da, gap_days],
                                    dtype="float64",
                                )
                                mixed = maybe_mix_curve_from_model(
                                    sub=predict_model.ap_no_forecast,
                                    base_curve=base_ap,
                                    bucket_keys=("ap_eq_prev", "ap_gt_prev", "ap_lt_prev"),
                                    features=features9,
                                )
                                if mixed is not None:
                                    return mixed

            if fam == "af":
                return base_af if base_af is not None else base
            if fam in {"ap", "hybrid"}:
                return base_ap if base_ap is not None else base
            return base_af if has_f and base_af is not None else base
        bucket = buckets.get(bucket_key)
        if not isinstance(bucket, dict):
            return base

        # Shrink p_up toward 0.5 when the sample size is small to reduce noise
        # from low-N buckets (which can look unrealistically extreme).
        shrink_k = 40.0

        offs: list[int] = []
        pups: list[float] = []
        p50s: list[float] = []
        ns: list[float] = []
        for off_s, stats in bucket.items():
            if not isinstance(stats, dict):
                continue
            try:
                off = int(off_s)
            except Exception:
                continue
            p_up = stats.get("p_up")
            if p_up is None:
                dwn = stats.get("p_down")
                p_up = (1.0 - float(dwn)) if dwn is not None else None
            if p_up is None:
                continue
            try:
                n = float(stats.get("n") or 0.0)
            except Exception:
                n = 0.0
            shrink = n / (n + shrink_k) if n > 0 else 0.0
            p_up = 0.5 + (float(p_up) - 0.5) * float(shrink)
            try:
                p50 = float(stats.get("p50_all") or 0.0)
            except Exception:
                p50 = 0.0
            offs.append(off)
            pups.append(float(np.clip(float(p_up), 0.0, 1.0)))
            p50s.append(float(p50))
            ns.append(float(n))
        if len(offs) < 2 or len(p50s) != len(offs) or len(ns) != len(offs):
            return base
        triples = sorted(zip(offs, pups, p50s, ns), key=lambda x: x[0])
        offs = [o for o, _, _, _ in triples]
        pups = [v for _, v, _, _ in triples]
        p50s = [v for _, _, v, _ in triples]
        ns = [v for _, _, _, v in triples]
        return ImpactMetric(offsets=offs, p_up=pups, p50_all=p50s, n=ns)

    for _, r in window.iterrows():
        metric_id = str(r["impact_metric_id"])
        ev_dt = pd.Timestamp(r["dt_utc"]).to_pydatetime()
        curve = pick_curve_for_instance(metric_id, ev_dt)
        if curve is None:
            continue
        w = _importance_weight(str(r["importance"]))
        nearby.append((ev_dt, w, curve))
    if not nearby:
        return None

    # Convert each curve into an anchor-relative logit baseline so P(t) represents the
    # direction from anchor -> t (not "t vs each event's own timestamp").
    nearby_rel: list[tuple[datetime, float, ImpactMetric, float, float]] = []
    for ev_dt, ev_w, curve in nearby:
        rel0 = int(round((anchor_dt_utc - ev_dt).total_seconds() / 60.0))
        pup0 = _interp_piecewise(curve.offsets, curve.p_up, rel0, 0.5)
        base_logit = _logit(pup0)
        base_med = float(_interp_piecewise(curve.offsets, curve.p50_all, rel0, 0.0))
        nearby_rel.append((ev_dt, ev_w, curve, float(base_logit), float(base_med)))

    series: list[float] = []
    # Scale down weak/low-magnitude signals so the aggregate isn't dominated by
    # tiny moves that are effectively noise at the 15m..24h horizons.
    mag_ref = 0.05
    # Pre-release drift (t < event_dt) is usually weaker and more localized than post-release moves.
    # Attenuate future-event contributions so far-away scheduled releases don't dominate the near-term path.
    tau_pre = max(60.0, float(tau_minutes) * float(tau_pre_scale))
    pre_factor = float(pre_factor)

    for t in grid_minutes:
        abs_dt = anchor_dt_utc + timedelta(minutes=int(t))
        items: list[tuple[float, float, float]] = []
        for ev_dt, ev_w, curve, base_logit, base_med in nearby_rel:
            rel = int(round((abs_dt - ev_dt).total_seconds() / 60.0))
            if rel < 0:
                decay = _exp_decay_weight(rel, tau_pre) * float(pre_factor)
            else:
                decay = _exp_decay_weight(rel, tau_minutes)
            w = float(ev_w) * float(decay)
            if w <= 1e-9:
                continue

            med = float(_interp_piecewise(curve.offsets, curve.p50_all, rel, 0.0))
            mag = abs(float(med))
            mag_factor = mag / (mag + mag_ref) if mag_ref > 0 else 1.0

            if mode == "median":
                delta = (med - float(base_med)) * float(mag_factor)
                strength = abs(float(w) * float(delta))
                items.append((strength, float(w), float(delta)))
            else:
                pup = float(_interp_piecewise(curve.offsets, curve.p_up, rel, 0.5))
                logit_delta = (_logit(pup) - float(base_logit)) * float(mag_factor)
                strength = abs(float(w) * float(logit_delta))
                items.append((strength, float(w), float(logit_delta)))

        if top_k and top_k > 0 and len(items) > int(top_k):
            items.sort(key=lambda x: x[0], reverse=True)
            items = items[: int(top_k)]

        sum_w = float(sum(w for _, w, _ in items))
        sum_d = float(sum(w * d for _, w, d in items))
        if sum_w > 0.0:
            scale = float(median_scale) if mode == "median" else float(delta_scale)
            z = (sum_d / sum_w) * float(scale)
            p = float(np.clip(_sigmoid(z), 0.0, 1.0))
        else:
            p = 0.5
        series.append(p)
    return series


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--impact-json", type=Path, default=Path("data/analysis/xauusd_event_impact_usd.json"))
    ap.add_argument("--calendar-dir", type=Path, default=Path("data/Economic_Calendar"))
    ap.add_argument(
        "--calendar-offset-minutes",
        type=int,
        default=480,
        help="Offset minutes of the Economic_Calendar export timezone (default UTC+8 = 480).",
    )
    ap.add_argument("--price-csv", type=Path, default=Path("data/XAUUSD_data/XAUUSD_data.csv"))
    ap.add_argument("--importance", nargs="*", default=["High", "Medium"])
    ap.add_argument("--max-anchors", type=int, default=800, help="Limit anchors for speed (most recent first).")
    ap.add_argument("--years", type=str, default="2017-2026", help="Inclusive year range, e.g. 2019-2025")
    ap.add_argument("--grid-step-minutes", type=int, default=15, help="Time grid step in minutes (default 15).")
    ap.add_argument("--tau-minutes", type=float, default=480.0, help="Exp-decay tau in minutes (default 480).")
    ap.add_argument(
        "--tau-pre-scale",
        type=float,
        default=0.5,
        help="Pre-release tau scale. tau_pre = max(60, tau_minutes * tau_pre_scale).",
    )
    ap.add_argument(
        "--pre-factor",
        type=float,
        default=0.4,
        help="Scale weight for rel<0 contributions (future scheduled events).",
    )
    ap.add_argument("--delta-scale", type=float, default=6.0, help="Logit delta scale (default 6).")
    ap.add_argument(
        "--mode",
        type=str,
        default="logit",
        choices=["logit", "median"],
        help="Unified path mode: combine logit deltas of P(up) (logit) or combine median returns (median).",
    )
    ap.add_argument(
        "--bucket-family",
        type=str,
        default="auto",
        choices=["auto", "ap", "af", "hybrid"],
        help="Which impact buckets to use when Forecast exists. auto=AF if available else AP; hybrid=AF after release, AP before release.",
    )
    ap.add_argument(
        "--median-scale",
        type=float,
        default=120.0,
        help="Scale factor for median mode mapping (z = mean(deltaMedian) * median_scale).",
    )
    ap.add_argument(
        "--top-k",
        type=int,
        default=0,
        help="Only use the top-K strongest event contributions per grid point (0 = use all).",
    )
    ap.add_argument(
        "--use-release-model",
        action="store_true",
        help="Use Predict Release model to mix surprise buckets for future events (no look-ahead).",
    )
    ap.add_argument(
        "--predict-release-model",
        type=Path,
        default=Path("data/analysis/predict_release_model_usd.json"),
        help="Predict Release model JSON (schema=1).",
    )
    ap.add_argument(
        "--eval-from-minutes",
        type=int,
        default=0,
        help="Only evaluate grid points >= this offset (default 0 = future-only).",
    )
    ap.add_argument(
        "--eval-to-minutes",
        type=int,
        default=1440,
        help="Only evaluate grid points <= this offset (default 1440 = +24h).",
    )
    ap.add_argument(
        "--min-edge",
        type=float,
        default=0.0,
        help="Only score predictions where abs(P(up)-0.5) >= min_edge (skip low-edge points).",
    )
    args = ap.parse_args()

    y0, y1 = (int(x) for x in str(args.years).split("-", 1))
    importance = {s.title() for s in args.importance}

    windows_sorted, impact_events_obj, curves_ap, curves_af = _load_impact(args.impact_json)
    predict_model = (
        _load_predict_release_model(Path(args.predict_release_model))
        if bool(args.use_release_model)
        else None
    )
    events = _load_calendar_events(
        args.calendar_dir, currency="USD", calendar_offset_minutes=int(args.calendar_offset_minutes)
    )
    events = events[events["importance"].isin(list(importance))].copy()
    events = events[(events["dt_utc"].dt.year >= y0) & (events["dt_utc"].dt.year <= y1)].copy()
    if events.empty:
        print("No events in the requested range.")
        return 1

    price = _load_price_minutes(args.price_csv)
    if price.empty:
        print("No price rows.")
        return 1
    price = price[(price["dt_utc"].dt.year >= y0) & (price["dt_utc"].dt.year <= y1)].copy()
    price = price.sort_values("dt_utc").reset_index(drop=True)
    ts = price["dt_utc"].to_numpy(dtype="datetime64[ns]")
    close = price["close"].to_numpy(dtype="float64")

    # Grid: -24h..+24h (matches Rust window). Step defaults to 15m.
    step = max(1, int(args.grid_step_minutes))
    grid_minutes = list(range(-1440, 1441, step))
    # Evaluate a few horizons as a human-readable summary.
    horizons = [15, 60, 240, 720, 1440]
    horizon_to_idx = {h: grid_minutes.index(h) for h in horizons}

    anchors = events.sort_values("dt_utc").tail(int(args.max_anchors)).reset_index(drop=True)
    anchors = anchors.iloc[::-1].reset_index(drop=True)  # most recent first

    # Stats accumulators.
    total_grid = 0
    correct_grid = 0
    total_h: dict[int, int] = {h: 0 for h in horizons}
    correct_h: dict[int, int] = {h: 0 for h in horizons}

    used = 0
    for _, arow in anchors.iterrows():
        anchor_dt = pd.Timestamp(arow["dt_utc"]).to_pydatetime()
        if anchor_dt < price["dt_utc"].min().to_pydatetime() or anchor_dt > price["dt_utc"].max().to_pydatetime():
            continue

        path = _compute_unified_path_for_anchor(
            anchor_dt_utc=anchor_dt,
            events=events,
            curves_ap=curves_ap,
            curves_af=curves_af,
            impact_events_obj=impact_events_obj,
            grid_minutes=grid_minutes,
            tau_minutes=float(args.tau_minutes),
            tau_pre_scale=float(args.tau_pre_scale),
            pre_factor=float(args.pre_factor),
            delta_scale=float(args.delta_scale),
            mode=str(args.mode),
            bucket_family=str(args.bucket_family),
            median_scale=float(args.median_scale),
            top_k=int(args.top_k),
            predict_model=predict_model,
        )
        if path is None:
            continue

        # Find closest minute bar at/just before anchor.
        anchor64 = np.datetime64(pd.Timestamp(anchor_dt).to_datetime64())
        i0 = int(np.searchsorted(ts, anchor64, side="right") - 1)
        if i0 < 0 or i0 >= len(ts):
            continue
        p0 = float(close[i0])
        if not np.isfinite(p0) or p0 <= 0:
            continue

        # Evaluate grid points where we have a price bar.
        ok_any = False
        for gi, t in enumerate(grid_minutes):
            if int(t) < int(args.eval_from_minutes) or int(t) > int(args.eval_to_minutes):
                continue
            target_dt = anchor_dt + timedelta(minutes=int(t))
            target64 = np.datetime64(pd.Timestamp(target_dt).to_datetime64())
            it = int(np.searchsorted(ts, target64, side="right") - 1)
            if it < 0 or it >= len(ts):
                continue
            pt = float(close[it])
            if not np.isfinite(pt) or pt <= 0:
                continue
            r = (pt - p0) / p0
            p_pred = float(path[gi])
            if abs(p_pred - 0.5) < float(args.min_edge):
                continue
            pred = _direction_from_prob(p_pred, eps=0.0)
            truth = _direction_from_return(float(r), eps=0.0)
            # ignore perfectly neutral predictions (rare), still count neutrals in truth
            if pred == 0:
                continue
            ok_any = True
            total_grid += 1
            correct_grid += int(pred == truth)

        if not ok_any:
            continue

        # Horizons
        for h in horizons:
            gi = horizon_to_idx[h]
            t = grid_minutes[gi]
            target_dt = anchor_dt + timedelta(minutes=int(t))
            target64 = np.datetime64(pd.Timestamp(target_dt).to_datetime64())
            it = int(np.searchsorted(ts, target64, side="right") - 1)
            if it < 0 or it >= len(ts):
                continue
            pt = float(close[it])
            if not np.isfinite(pt) or pt <= 0:
                continue
            r = (pt - p0) / p0
            p_pred = float(path[gi])
            if abs(p_pred - 0.5) < float(args.min_edge):
                continue
            pred = _direction_from_prob(p_pred, eps=0.0)
            truth = _direction_from_return(float(r), eps=0.0)
            if pred == 0:
                continue
            total_h[h] += 1
            correct_h[h] += int(pred == truth)

        used += 1

    if used <= 0:
        print("No usable anchors (missing impact curves or price alignment).")
        return 2

    acc_grid = (correct_grid / total_grid) if total_grid else 0.0
    print("Unified Outlook P(t) directional accuracy (fallback model)")
    print(
        f"anchors_used={used} | grid_points_eval={total_grid} | acc={acc_grid:.3f} | "
        f"step={step}m tau={float(args.tau_minutes):g}m "
        f"mode={str(args.mode)} bucket_family={str(args.bucket_family)} "
        f"delta_scale={float(args.delta_scale):g} median_scale={float(args.median_scale):g}"
    )
    for h in horizons:
        tot = total_h[h]
        acc = (correct_h[h] / tot) if tot else 0.0
        print(f"  horizon +{h:4d}m: n={tot:5d} acc={acc:.3f}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
