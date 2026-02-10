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


def _load_impact(path: Path) -> tuple[list[int], dict[str, dict], dict[str, ImpactMetric]]:
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

    curves: dict[str, ImpactMetric] = {}
    for metric_id, buckets in events_obj.items():
        if not isinstance(buckets, dict):
            continue
        bucket_weights: list[tuple[str, float]] = []
        for b in ("ap_gt_prev", "ap_lt_prev", "ap_eq_prev"):
            n = (
                (buckets.get(b) or {})
                .get(ref_key, {})
                .get("n", 0.0)
            )
            try:
                n = float(n)
            except Exception:
                n = 0.0
            if n > 0.0:
                bucket_weights.append((b, n))
        denom = sum(w for _, w in bucket_weights)
        if denom <= 0:
            continue
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
        if len(offs) >= 2:
            curves[metric_id] = ImpactMetric(offsets=offs, p_up=pups, p50_all=p50s, n=ns)

    return windows_sorted, events_obj, curves


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
        return pd.DataFrame(columns=["dt_utc", "event", "importance", "a", "f", "p"])

    out = pd.concat(frames, ignore_index=True)
    out["currency"] = out["currency"].fillna("").astype(str).str.upper()
    out["importance"] = out["importance"].fillna("").astype(str).str.title()
    out["event"] = out["event_name"].fillna("").astype(str)
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
    return out[["dt_utc", "event", "importance", "a", "f", "p"]].copy()


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
    curves: dict[str, ImpactMetric],
    impact_events_obj: dict[str, dict],
    grid_minutes: list[int],
    include_half_minutes: int = 2880,
    tau_minutes: float = 480.0,
    delta_scale: float = 6.0,
) -> Optional[list[float]]:
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

    by_metric: dict[str, pd.DataFrame] = {}
    for ev, g in window.groupby("event", sort=False):
        by_metric[str(ev)] = g.sort_values("dt_utc").reset_index(drop=True)

    def pick_curve_for_instance(ev_name: str, ev_dt: datetime) -> Optional[ImpactMetric]:
        metric_id = f"USD::{ev_name.strip()}::none"
        base = curves.get(metric_id)
        buckets = impact_events_obj.get(metric_id)
        if base is None or not isinstance(buckets, dict):
            return base
        g = by_metric.get(ev_name)
        if g is None:
            return base

        inst = g[g["dt_utc"] == ev_dt].head(1)
        if inst.empty:
            return base
        p = inst["p"].iloc[0]
        if p is None or (isinstance(p, float) and not np.isfinite(p)):
            return base
        f = inst["f"].iloc[0]

        past = g[g["dt_utc"] < ev_dt]
        last_actuals = [float(x) for x in past["a"].dropna().tolist() if np.isfinite(x)]
        proxy = f if (f is not None and np.isfinite(f)) else _linreg_hat(last_actuals, 6)
        if proxy is None or (isinstance(proxy, float) and not np.isfinite(proxy)):
            return base

        d = float(proxy) - float(p)
        if d > 0:
            bucket_key = "ap_gt_prev"
        elif d < 0:
            bucket_key = "ap_lt_prev"
        else:
            bucket_key = "ap_eq_prev"
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
        ev_name = str(r["event"])
        ev_dt = pd.Timestamp(r["dt_utc"]).to_pydatetime()
        curve = pick_curve_for_instance(ev_name, ev_dt)
        if curve is None:
            continue
        w = _importance_weight(str(r["importance"]))
        nearby.append((ev_dt, w, curve))
    if not nearby:
        return None

    series: list[float] = []
    logit_05 = _logit(0.5)
    # Scale down weak/low-magnitude signals so the aggregate isn't dominated by
    # tiny moves that are effectively noise at the 15m..24h horizons.
    mag_ref = 0.05
    for t in grid_minutes:
        abs_dt = anchor_dt_utc + timedelta(minutes=int(t))
        sum_w = 0.0
        sum_logit = 0.0
        for ev_dt, ev_w, curve in nearby:
            rel = int(round((abs_dt - ev_dt).total_seconds() / 60.0))
            pup = _interp_piecewise(curve.offsets, curve.p_up, rel, 0.5)
            decay = _exp_decay_weight(rel, tau_minutes)
            w = float(ev_w) * float(decay)
            if w <= 1e-9:
                continue
            med = _interp_piecewise(curve.offsets, curve.p50_all, rel, 0.0)
            mag = abs(float(med))
            mag_factor = mag / (mag + mag_ref) if mag_ref > 0 else 1.0
            logit_delta = (_logit(pup) - logit_05) * float(mag_factor)
            sum_w += w
            sum_logit += w * logit_delta
        if sum_w > 0.0:
            z = (sum_logit / sum_w) * float(delta_scale)
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
    ap.add_argument("--delta-scale", type=float, default=6.0, help="Logit delta scale (default 6).")
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
    args = ap.parse_args()

    y0, y1 = (int(x) for x in str(args.years).split("-", 1))
    importance = {s.title() for s in args.importance}

    windows_sorted, impact_events_obj, curves = _load_impact(args.impact_json)
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
            curves=curves,
            impact_events_obj=impact_events_obj,
            grid_minutes=grid_minutes,
            tau_minutes=float(args.tau_minutes),
            delta_scale=float(args.delta_scale),
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
            pred = _direction_from_prob(float(path[gi]), eps=0.0)
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
            pred = _direction_from_prob(float(path[gi]), eps=0.0)
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
        f"step={step}m tau={float(args.tau_minutes):g}m delta_scale={float(args.delta_scale):g}"
    )
    for h in horizons:
        tot = total_h[h]
        acc = (correct_h[h] / tot) if tot else 0.0
        print(f"  horizon +{h:4d}m: n={tot:5d} acc={acc:.3f}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
