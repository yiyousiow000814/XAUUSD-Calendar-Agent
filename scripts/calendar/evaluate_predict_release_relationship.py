"""
Relationship-based Predict Release evaluator (walk-forward).

Goal: improve >/=/< prediction of (Actual - Forecast) and (Actual - Previous)
by using *recent 1-6 month* signals from related metrics, not only the metric's own history.

This is a research/evaluation script. It does NOT require price data.

High-level method (per metric):
1) Define label y in {>,=,<} using an approximate "=" tolerance derived from the metric's recent history.
2) Learn related metrics by correlation on training history:
   - For each candidate source metric S, pair each target release with the most recent S release
     within a lookback window (e.g. 45 days) before the target time.
   - Compute correlation between source surprise and target surprise.
3) Predict for the next release using a weighted vote from top-K correlated sources (recent-only).

This script prints overall accuracy and coverage for several parameter settings.
"""

from __future__ import annotations

import argparse
import json
import math
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd

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


def _normalize_metric_key(raw: object) -> str:
    # Mirror app grouping: remove trailing period tokens like "(Jan)" / "(Q1)" but keep "(MoM)/(YoY)" etc.
    text = str(raw or "").strip()
    if not text:
        return ""
    if text.endswith(")"):
        open_idx = text.rfind("(")
        if open_idx >= 0:
            token = text[open_idx + 1 : -1].strip()
            tl = token.lower()
            is_period = False
            if tl in _MONTH_TOKENS:
                is_period = True
            elif tl.startswith("q") and tl[1:] in {"1", "2", "3", "4"}:
                is_period = True
            elif tl.isdigit() and len(tl) == 4:
                is_period = True
            if is_period:
                text = text[:open_idx].rstrip()
    return text


def _parse_numeric(value: object) -> Optional[float]:
    if value is None:
        return None
    text = str(value).strip()
    if not text or text.lower() in {"-", "n/a", "na", "tba", "null"}:
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


def _parse_event_dt_utc(date_str: str, time_str: str) -> Optional[datetime]:
    time_str = (time_str or "").strip()
    if not time_str or time_str in {"All Day", "Tentative"}:
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
    if len(parts) == 3 and len(parts[0]) == 2 and len(parts[2]) == 4:
        dd, mo, yy = int(parts[0]), int(parts[1]), int(parts[2])
    elif len(parts) == 3 and len(parts[0]) == 4:
        yy, mo, dd = int(parts[0]), int(parts[1]), int(parts[2])
    else:
        return None
    try:
        return datetime(yy, mo, dd, hh, mm, tzinfo=timezone.utc)
    except ValueError:
        return None


def _load_calendar_rows(calendar_dir: Path) -> pd.DataFrame:
    frames: list[pd.DataFrame] = []
    for year_dir in sorted(calendar_dir.glob("*")):
        if not year_dir.is_dir():
            continue
        year = year_dir.name
        json_path = year_dir / f"{year}_calendar.json"
        csv_path = year_dir / f"{year}_calendar.csv"
        path = json_path if json_path.exists() else csv_path if csv_path.exists() else None
        if path is None:
            continue
        if path.suffix == ".json":
            with path.open("r", encoding="utf-8") as fh:
                data = json.load(fh)
            df = pd.DataFrame(data)
        else:
            df = pd.read_csv(path)
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
        frames.append(df[list(needed)].copy())

    if not frames:
        return pd.DataFrame(columns=["dt_utc", "currency", "importance", "event_name", "a", "f", "p"])

    out = pd.concat(frames, ignore_index=True).copy()
    out.loc[:, "currency"] = out["currency"].fillna("").astype(str).str.upper()
    out.loc[:, "importance"] = out["importance"].fillna("").astype(str).str.title()
    out.loc[:, "event_name"] = out["event_name"].fillna("").astype(str)
    out.loc[:, "a"] = out["actual_raw"].map(_parse_numeric)
    out.loc[:, "f"] = out["forecast_raw"].map(_parse_numeric)
    out.loc[:, "p"] = out["previous_raw"].map(_parse_numeric)
    out.loc[:, "dt_utc"] = [
        _parse_event_dt_utc(d, t) for d, t in zip(out["Date"].astype(str), out["Time"].astype(str), strict=False)
    ]
    out = out.dropna(subset=["dt_utc", "event_name"]).copy()
    out.loc[:, "dt_utc"] = pd.to_datetime(out["dt_utc"], utc=True, errors="coerce")
    out = out.dropna(subset=["dt_utc"]).copy()
    out = out.sort_values("dt_utc").reset_index(drop=True)
    out = out[["dt_utc", "currency", "importance", "event_name", "a", "f", "p"]].copy()
    out.loc[:, "metric_key"] = out["event_name"].map(_normalize_metric_key)
    return out


def _eps_from_recent(diffs_abs: np.ndarray) -> float:
    if diffs_abs.size == 0:
        return 0.0
    med = float(np.median(diffs_abs))
    return max(1e-9, med * 0.1)

def _scale_from_hist(diffs_abs: np.ndarray) -> float:
    # Robust scale for normalising heterogeneous metrics.
    if diffs_abs.size == 0:
        return 1.0
    med = float(np.median(diffs_abs))
    if not math.isfinite(med) or med <= 1e-12:
        return 1.0
    return med


def _label(d: float, eps: float) -> int:
    # 1 => ">", 0 => "=", -1 => "<"
    if abs(d) <= eps:
        return 0
    return 1 if d > 0 else -1

def _label_z(z: float, eq_factor: float) -> int:
    # Same 3-way label, but in normalised z-space:
    # if z = diff / median_abs_diff, then "approx equal" is abs(z) <= eq_factor.
    if abs(z) <= float(eq_factor):
        return 0
    return 1 if z > 0 else -1


@dataclass(frozen=True)
class PairSeries:
    # Paired series of (source surprise, target surprise) where source precedes target.
    x: np.ndarray
    y: np.ndarray


def _pair_source_to_target(
    src: pd.DataFrame,
    tgt: pd.DataFrame,
    *,
    lookback_days: int,
    kind: str,
) -> PairSeries:
    # For each target release, pick the most recent source release within lookback window.
    # kind: "forecast" uses a-f, "prev" uses a-p.
    src = src.sort_values("dt_utc").reset_index(drop=True)
    tgt = tgt.sort_values("dt_utc").reset_index(drop=True)

    if kind == "forecast":
        src_mask = np.isfinite(src["a"].to_numpy()) & np.isfinite(src["f"].to_numpy())
        tgt_mask = np.isfinite(tgt["a"].to_numpy()) & np.isfinite(tgt["f"].to_numpy())
        src_s = (src["a"] - src["f"]).to_numpy(dtype="float64")
        tgt_s = (tgt["a"] - tgt["f"]).to_numpy(dtype="float64")
    else:
        src_mask = np.isfinite(src["a"].to_numpy()) & np.isfinite(src["p"].to_numpy())
        tgt_mask = np.isfinite(tgt["a"].to_numpy()) & np.isfinite(tgt["p"].to_numpy())
        src_s = (src["a"] - src["p"]).to_numpy(dtype="float64")
        tgt_s = (tgt["a"] - tgt["p"]).to_numpy(dtype="float64")

    src_dt = src["dt_utc"].to_numpy(dtype="datetime64[ns]")
    tgt_dt = tgt["dt_utc"].to_numpy(dtype="datetime64[ns]")

    x_list: list[float] = []
    y_list: list[float] = []
    lookback_ns = np.int64(lookback_days) * 24 * 3600 * 1_000_000_000

    j = 0
    for i in range(len(tgt_dt)):
        if not tgt_mask[i]:
            continue
        # advance src pointer up to target time
        while j < len(src_dt) and src_dt[j] < tgt_dt[i]:
            j += 1
        # candidate is j-1 (last before target)
        k = j - 1
        if k < 0:
            continue
        if not src_mask[k]:
            continue
        delta = tgt_dt[i].astype("int64") - src_dt[k].astype("int64")
        if delta < 0 or delta > lookback_ns:
            continue
        x_list.append(float(src_s[k]))
        y_list.append(float(tgt_s[i]))

    return PairSeries(x=np.asarray(x_list, dtype="float64"), y=np.asarray(y_list, dtype="float64"))


def _corr(x: np.ndarray, y: np.ndarray) -> float:
    if x.size < 10 or y.size < 10:
        return 0.0
    if np.allclose(np.std(x), 0) or np.allclose(np.std(y), 0):
        return 0.0
    c = float(np.corrcoef(x, y)[0, 1])
    if not math.isfinite(c):
        return 0.0
    return max(-1.0, min(1.0, c))


@dataclass
class Totals:
    correct: int = 0
    total: int = 0

    def add(self, ok: bool) -> None:
        self.total += 1
        if ok:
            self.correct += 1

    def acc(self) -> float:
        return (self.correct / self.total) if self.total else 0.0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--calendar-dir", type=Path, default=Path("data/Economic_Calendar"))
    ap.add_argument("--currency", type=str, default="USD")
    ap.add_argument("--importance", nargs="*", default=["Medium", "High"])
    ap.add_argument("--min-releases", type=int, default=24)
    ap.add_argument("--max-releases-per-metric", type=int, default=180)
    ap.add_argument("--lookback-days", type=int, default=45)
    ap.add_argument("--topk", type=int, default=6)
    ap.add_argument("--recent-months", type=int, default=6, help="Use recent months for source signal sampling.")
    ap.add_argument(
        "--eq-factor",
        type=float,
        default=0.1,
        help='Approx "=" tolerance in z-space. If z = diff/median_abs_diff, then "=" is abs(z)<=factor.',
    )
    args = ap.parse_args()

    df = _load_calendar_rows(args.calendar_dir)
    df = df[(df["currency"] == args.currency.upper()) & (df["importance"].isin([s.title() for s in args.importance]))].copy()
    if df.empty:
        print("No rows.")
        return 1

    by_metric = {k: g.sort_values("dt_utc") for k, g in df.groupby("metric_key", sort=False)}

    # Precompute per-metric robust scales so correlations and scores are comparable across metrics.
    # This uses all available history (leaky for research), but significantly reduces unit-mismatch.
    # The production pipeline should compute these scales without leakage (walk-forward / cutoff).
    scales_f: dict[str, float] = {}
    scales_p: dict[str, float] = {}
    for m, g in by_metric.items():
        aa = g["a"].to_numpy(dtype="float64")
        ff = g["f"].to_numpy(dtype="float64")
        pp = g["p"].to_numpy(dtype="float64")
        df_f = np.abs(aa - ff)
        df_f = df_f[np.isfinite(df_f)]
        df_p = np.abs(aa - pp)
        df_p = df_p[np.isfinite(df_p)]
        scales_f[m] = _scale_from_hist(df_f)
        scales_p[m] = _scale_from_hist(df_p)

    totals_f = Totals()
    totals_p = Totals()

    metrics = [m for m, g in by_metric.items() if len(g) >= int(args.min_releases)]
    metrics = sorted(metrics)

    # Walk-forward per metric.
    for m in metrics:
        tgt = by_metric[m].copy()
        if int(args.max_releases_per_metric) > 0 and len(tgt) > int(args.max_releases_per_metric):
            tgt = tgt.tail(int(args.max_releases_per_metric)).copy()

        tgt = tgt.reset_index(drop=True)
        tgt_dt = tgt["dt_utc"].to_numpy(dtype="datetime64[ns]")

        # candidate sources: all other metrics (cheap baseline)
        sources = [s for s in metrics if s != m]

        # Start after some history exists.
        for i in range(12, len(tgt)):
            ref_dt = pd.Timestamp(tgt_dt[i]).tz_localize("UTC")
            # recent window for eps (target)
            recent_start = ref_dt - pd.DateOffset(months=int(args.recent_months))
            hist = tgt.iloc[:i].copy()
            hist_recent = hist[hist["dt_utc"] >= recent_start]

            # Build target label and eps for vs Forecast / Previous separately.
            a = float(hist_recent["a"].dropna().iloc[-1]) if not hist_recent["a"].dropna().empty else None

            # vs Forecast
            if pd.notna(tgt.loc[i, "a"]) and pd.notna(tgt.loc[i, "f"]):
                scale_t = float(scales_f.get(m, 1.0))
                if scale_t <= 0:
                    scale_t = 1.0
                z_true = float(tgt.loc[i, "a"] - tgt.loc[i, "f"]) / scale_t
                y_true = _label_z(z_true, float(args.eq_factor))

                # Learn top correlated sources on history only.
                corrs: list[tuple[str, float]] = []
                for s in sources:
                    src = by_metric[s]
                    # limit to history time for learning
                    src_hist = src[src["dt_utc"] < ref_dt].copy()
                    if len(src_hist) < 12:
                        continue
                    pair = _pair_source_to_target(
                        src_hist, hist, lookback_days=int(args.lookback_days), kind="forecast"
                    )
                    if pair.x.size == 0 or pair.y.size == 0:
                        continue
                    xs = pair.x / float(scales_f.get(s, 1.0))
                    ys = pair.y / float(scales_f.get(m, 1.0))
                    c = _corr(xs, ys)
                    if abs(c) >= 0.12:
                        corrs.append((s, c))
                corrs.sort(key=lambda x: -abs(x[1]))
                corrs = corrs[: int(args.topk)]

                score = 0.0
                wsum = 0.0
                for s, c in corrs:
                    src = by_metric[s]
                    src_recent = src[(src["dt_utc"] >= recent_start) & (src["dt_utc"] < ref_dt)]
                    if src_recent.empty:
                        continue
                    # use last source surprise sign
                    dd = (src_recent["a"] - src_recent["f"]).dropna().to_numpy(dtype="float64")
                    if dd.size == 0:
                        continue
                    ss = float(dd[-1]) / float(scales_f.get(s, 1.0))
                    score += c * ss
                    wsum += abs(c)

                if wsum > 0:
                    pred = _label_z(score / (wsum + 1e-9), float(args.eq_factor))
                    totals_f.add(pred == y_true)

            # vs Previous
            if pd.notna(tgt.loc[i, "a"]) and pd.notna(tgt.loc[i, "p"]):
                scale_t = float(scales_p.get(m, 1.0))
                if scale_t <= 0:
                    scale_t = 1.0
                z_true = float(tgt.loc[i, "a"] - tgt.loc[i, "p"]) / scale_t
                y_true = _label_z(z_true, float(args.eq_factor))

                corrs = []
                for s in sources:
                    src = by_metric[s]
                    src_hist = src[src["dt_utc"] < ref_dt].copy()
                    if len(src_hist) < 12:
                        continue
                    pair = _pair_source_to_target(
                        src_hist, hist, lookback_days=int(args.lookback_days), kind="prev"
                    )
                    if pair.x.size == 0 or pair.y.size == 0:
                        continue
                    xs = pair.x / float(scales_p.get(s, 1.0))
                    ys = pair.y / float(scales_p.get(m, 1.0))
                    c = _corr(xs, ys)
                    if abs(c) >= 0.12:
                        corrs.append((s, c))
                corrs.sort(key=lambda x: -abs(x[1]))
                corrs = corrs[: int(args.topk)]

                score = 0.0
                wsum = 0.0
                for s, c in corrs:
                    src = by_metric[s]
                    src_recent = src[(src["dt_utc"] >= recent_start) & (src["dt_utc"] < ref_dt)]
                    if src_recent.empty:
                        continue
                    dd = (src_recent["a"] - src_recent["p"]).dropna().to_numpy(dtype="float64")
                    if dd.size == 0:
                        continue
                    ss = float(dd[-1]) / float(scales_p.get(s, 1.0))
                    score += c * ss
                    wsum += abs(c)
                if wsum > 0:
                    pred = _label_z(score / (wsum + 1e-9), float(args.eq_factor))
                    totals_p.add(pred == y_true)

    print("Relationship-based (walk-forward)")
    print(f"vs Forecast: acc={totals_f.acc():.3f} n={totals_f.total}")
    print(f"vs Previous: acc={totals_p.acc():.3f} n={totals_p.total}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
