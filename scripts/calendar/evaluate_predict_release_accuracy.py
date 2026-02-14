"""
Evaluate Predict Release accuracy against Economic_Calendar history.

This script provides two perspectives:

1) Legacy heuristic predictor (baseline / research):
   - "Recent" window auto-chosen within 1..6 months via a lightweight backtest
   - "=" means approximate (dynamic tolerance = 10% of median abs diff in window)
   - Prediction is argmax of {>,=,<} in that window (tie-break prefers "=")

2) Calendar model predictor (mirrors the app's Predict Release UI):
   - Multinomial logistic regression model stored at data/analysis/predict_release_model_usd.json
   - Task: Actual vs Previous (A-P) in {>,=,<}
- Uses confidence gating: only show predictions when score >= threshold,
     otherwise the UI displays "--" (unable to predict).
   - Confidence score: maxProb * (maxProb - secondMaxProb)

It reports accuracy + a small confusion matrix for:
  - Actual vs Forecast
  - Actual vs Previous

It also reports stronger baselines for Actual vs Previous:
  - Forecast-Previous direction (when Forecast exists)
  - Proxy-Previous direction, where proxy = Forecast if present else a simple
    linreg(10) pseudo-forecast from the last 10 Actual values (per-metric).

No price data is needed.

Note (repo behavior):
  - The desktop app may additionally apply per-metric confidence gates and a relationship-based
    "nowcast chain" to fill gaps for no-forecast releases. For an app-style combined evaluation,
    use: scripts/calendar/evaluate_predict_release_combined.py
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Optional

import pandas as pd
import numpy as np


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
    m1 = d.split("-")
    if len(m1) == 3 and len(m1[0]) == 2 and len(m1[2]) == 4:
        dd, mo, yy = int(m1[0]), int(m1[1]), int(m1[2])
    elif len(m1) == 3 and len(m1[0]) == 4:
        yy, mo, dd = int(m1[0]), int(m1[1]), int(m1[2])
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


def _load_predict_release_model(path: Path) -> Optional[dict]:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    try:
        model = json.loads(text)
    except json.JSONDecodeError:
        return None
    if int(model.get("schema") or 0) != 1:
        return None
    return model


def _find_eval_row(sub: dict) -> Optional[dict]:
    th = sub.get("recommended_threshold")
    rows = (sub.get("eval") or {}).get("thresholds") or []
    if not isinstance(th, (int, float)) or not isinstance(rows, list):
        return None
    for row in rows:
        if not isinstance(row, dict):
            continue
        if abs(float(row.get("th", 0.0)) - float(th)) <= 1e-9:
            return row
    return None


def _subset_months(df: pd.DataFrame, ref_dt: pd.Timestamp, months: int) -> pd.DataFrame:
    months = max(0, min(6, int(months)))
    start = ref_dt - pd.DateOffset(months=months)
    return df[(df["dt_utc"] >= start) & (df["dt_utc"] < ref_dt)]


def _median(values: list[float]) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    mid = (len(s) - 1) / 2.0
    lo = s[int(mid)]
    hi = s[int(mid) + (0 if mid.is_integer() else 1)]
    return (lo + hi) / 2.0


def _linreg_forecast_hat(last_actuals: list[float]) -> Optional[float]:
    # Fit y = a*x + b on the last 6 points and predict the next point (x=n).
    # This is intentionally tiny and dependency-free (no sklearn).
    if len(last_actuals) < 6:
        return None
    y = np.asarray(last_actuals[-6:], dtype=float)
    n = int(y.shape[0])
    x = np.arange(n, dtype=float)
    sum_x = float(x.sum())
    sum_y = float(y.sum())
    sum_xx = float((x * x).sum())
    sum_xy = float((x * y).sum())
    denom = n * sum_xx - sum_x * sum_x
    if denom == 0:
        return None
    slope = (n * sum_xy - sum_x * sum_y) / denom
    intercept = (sum_y - slope * sum_x) / n
    return float(slope * n + intercept)


@dataclass(frozen=True)
class Stats:
    n: int
    p_gt: float
    p_eq: float
    p_lt: float
    eps: float


def _build_stats(window: pd.DataFrame, kind: str) -> Optional[Stats]:
    if window.empty:
        return None
    if kind == "forecast":
        cols = ["a", "f"]
        bcol = "f"
    else:
        cols = ["a", "p"]
        bcol = "p"

    w = window.dropna(subset=cols)
    if w.empty:
        return None
    a = w["a"].astype(float)
    b = w[bcol].astype(float)
    diffs = (a - b).abs().tolist()
    # "Approx equal" tolerance.
    med = _median(diffs)
    eps = max(1e-9, med * float(window.attrs.get("_eq_factor", 0.1)))

    d = a - b
    n = int(d.shape[0])
    if n <= 0:
        return None
    eq = int((d.abs() <= eps).sum())
    gt = int((d > eps).sum())
    lt = max(0, n - gt - eq)
    return Stats(n=n, p_gt=gt / n, p_eq=eq / n, p_lt=lt / n, eps=eps)


def _argmax3(s: Stats) -> str:
    # Match UI: prefer "=" in ties, then ">".
    items = [("=", s.p_eq), (">", s.p_gt), ("<", s.p_lt)]
    items.sort(key=lambda x: (-x[1], x[0]))
    return items[0][0]

def _label_from_diff(d: float, eps: float) -> str:
    if abs(d) <= eps:
        return "="
    return ">" if d > 0 else "<"

def _pred_last(diffs: np.ndarray, eps: float) -> str:
    if diffs.size == 0:
        return "="
    return _label_from_diff(float(diffs[-1]), eps)

def _pred_mean(diffs: np.ndarray, eps: float) -> str:
    if diffs.size == 0:
        return "="
    return _label_from_diff(float(np.nanmean(diffs)), eps)

def _pred_freq(diffs: np.ndarray, eps: float) -> str:
    if diffs.size == 0:
        return "="
    gt = float(np.sum(diffs > eps))
    eq = float(np.sum(np.abs(diffs) <= eps))
    lt = float(np.sum(diffs < -eps))
    total = gt + eq + lt
    if total <= 0:
        return "="
    # tie-break: prefer "=" then ">"
    items = [("=", eq / total), (">", gt / total), ("<", lt / total)]
    items.sort(key=lambda x: (-x[1], x[0]))
    return items[0][0]

def _best_model_for_metric(
    dt: np.ndarray,
    a: np.ndarray,
    b: np.ndarray,
    *,
    kind: str,
    max_eval: int = 36,
    min_hist: int = 8,
) -> str:
    # Choose model by backtesting on the most recent eval points.
    mask = np.isfinite(a) & np.isfinite(b)
    idx = np.nonzero(mask)[0]
    if idx.size < (min_hist + 3):
        return "freq"
    eval_idx = idx[-max_eval:]

    # candidate models
    models = ["freq", "last", "mean"]
    best = "freq"
    best_acc = -1.0

    for m in models:
        correct = 0
        total = 0
        for j in eval_idx:
            ref_dt = pd.Timestamp(dt[j]).tz_localize("UTC")
            # auto-pick recent months window based on small backtest of window only (cheap):
            # here we reuse the simpler pick: smallest months that provides enough history.
            picked_months = 6
            for months in range(1, 7):
                start = ref_dt - pd.DateOffset(months=months)
                lo = int(np.searchsorted(dt, np.datetime64(start.to_datetime64()), side="left"))
                hist_mask = mask[lo:j]
                if int(hist_mask.sum()) >= min_hist:
                    picked_months = months
                    break
            start = ref_dt - pd.DateOffset(months=picked_months)
            lo = int(np.searchsorted(dt, np.datetime64(start.to_datetime64()), side="left"))
            hist_mask = mask[lo:j]
            if int(hist_mask.sum()) < min_hist:
                continue
            diffs = (a[lo:j] - b[lo:j])[hist_mask]
            diffs_abs = np.abs(diffs)
            med = float(np.median(diffs_abs)) if diffs_abs.size else 0.0
            eps = max(1e-9, med * 0.1)
            if m == "freq":
                pred = _pred_freq(diffs, eps)
            elif m == "last":
                pred = _pred_last(diffs, eps)
            else:
                pred = _pred_mean(diffs, eps)
            truth = _label_from_diff(float(a[j] - b[j]), eps)
            total += 1
            if pred == truth:
                correct += 1
        if total < 10:
            continue
        acc = correct / total
        if acc > best_acc + 1e-9:
            best_acc = acc
            best = m
    return best


def _truth(a: float, b: float, eps: float) -> str:
    d = a - b
    if abs(d) <= eps:
        return "="
    return ">" if d > 0 else "<"


def _pick_best_months(hist: pd.DataFrame, kind: str) -> int:
    # Mirror DeepAnalysisView: evaluate last ~36 releases and pick the best months window.
    if kind == "forecast":
        cols = ["a", "f"]
    else:
        cols = ["a", "p"]

    usable = hist.dropna(subset=cols).copy()
    if usable.empty:
        return 6
    eval_rows = usable.tail(36)

    best_m = 6
    best_acc = -1.0
    for m in range(1, 7):
        correct = 0
        total = 0
        for _, row in eval_rows.iterrows():
            ref_dt = pd.Timestamp(row["dt_utc"])
            w = _subset_months(hist, ref_dt, m)
            st = _build_stats(w, kind)
            if st is None or st.n < 8:
                continue
            pred = _argmax3(st)
            if kind == "forecast":
                truth = _truth(float(row["a"]), float(row["f"]), st.eps)
            else:
                truth = _truth(float(row["a"]), float(row["p"]), st.eps)
            total += 1
            if pred == truth:
                correct += 1
        if total < 8:
            continue
        acc = correct / total
        if acc > best_acc + 1e-9 or (abs(acc - best_acc) <= 1e-9 and m < best_m):
            best_acc = acc
            best_m = m
    return best_m


@dataclass
class Confusion:
    gt_gt: int = 0
    gt_eq: int = 0
    gt_lt: int = 0
    eq_gt: int = 0
    eq_eq: int = 0
    eq_lt: int = 0
    lt_gt: int = 0
    lt_eq: int = 0
    lt_lt: int = 0

    def add(self, truth: str, pred: str) -> None:
        key = f"{truth}_{pred}".replace(">", "gt").replace("=", "eq").replace("<", "lt")
        setattr(self, key, getattr(self, key) + 1)

    def total(self) -> int:
        return sum(getattr(self, f) for f in self.__dataclass_fields__)

    def correct(self) -> int:
        return self.gt_gt + self.eq_eq + self.lt_lt


def _fmt_conf(c: Confusion) -> str:
    t = c.total()
    if t <= 0:
        return "no eval samples"
    acc = c.correct() / t
    return (
        f"acc={acc:.3f} n={t} | "
        f"truth>: pred(>)={c.gt_gt} (=)={c.gt_eq} (<)={c.gt_lt} ; "
        f"truth=: pred(>)={c.eq_gt} (=)={c.eq_eq} (<)={c.eq_lt} ; "
        f"truth<: pred(>)={c.lt_gt} (=)={c.lt_eq} (<)={c.lt_lt}"
    )


def _proxy_only_vs_prev(df: pd.DataFrame, eq_factor: float) -> Confusion:
    """
    Proxy-only baseline (no moving window / no sample-size gating).

    pred  = sign(proxy - Previous)
    truth = sign(Actual - Previous)

    proxy = Forecast if present else linreg(10) pseudo-forecast on past Actual (per metric).
    eps is fixed per metric: median(|Actual-Previous|) * eq_factor.
    """
    out = Confusion()
    for _, g in df.groupby("metric_key", sort=False):
        g = g.sort_values("dt_utc").reset_index(drop=True)

        ap = g.dropna(subset=["a", "p"])
        if ap.empty:
            continue
        diffs = np.abs(ap["a"].to_numpy(dtype="float64") - ap["p"].to_numpy(dtype="float64"))
        diffs = diffs[np.isfinite(diffs)]
        if diffs.size == 0:
            continue
        eps = max(1e-9, float(np.median(diffs)) * float(eq_factor))

        # Keep history strictly in the past (do not leak the current Actual into the proxy model).
        past_actuals: list[float] = []
        for _, r in g.iterrows():
            a = r["a"]
            p = r["p"]
            f = r["f"]

            if a is not None and p is not None and np.isfinite(a) and np.isfinite(p):
                proxy = float(f) if (f is not None and np.isfinite(f)) else None
                if proxy is None:
                    proxy = _linreg_forecast_hat(past_actuals)
                if proxy is not None and np.isfinite(proxy):
                    truth = _truth(float(a), float(p), eps)
                    pred = _label3(float(proxy) - float(p), eps)
                    out.add(truth, pred)

            # Advance after scoring.
            if a is not None and np.isfinite(a):
                past_actuals.append(float(a))
    return out


def _label3(d: float, eps: float) -> str:
    if abs(d) <= eps:
        return "="
    return ">" if d > 0 else "<"


def _meta_ensemble_vs_prev(df: pd.DataFrame, eq_factor: float, *, recent_k: int = 24) -> Confusion:
    """
    Meta-ensemble baseline for vs Previous:
      - Define a small set of simple predictors, each producing a 3-way label.
      - At each time i, select the predictor with the best accuracy over the most recent K
        *past* labeled releases for that metric.

    This intentionally avoids heavy ML deps while capturing "recent 1-6m is more informative".
    """
    out = Confusion()

    for _, g in df.groupby("metric_key", sort=False):
        g = g.sort_values("dt_utc").reset_index(drop=True)
        if len(g) < max(12, recent_k + 2):
            continue

        ap = g.dropna(subset=["a", "p"])
        if ap.empty:
            continue
        diffs = np.abs(ap["a"].to_numpy(dtype="float64") - ap["p"].to_numpy(dtype="float64"))
        diffs = diffs[np.isfinite(diffs)]
        if diffs.size == 0:
            continue
        eps = max(1e-9, float(np.median(diffs)) * float(eq_factor))

        # rolling state
        past_actuals: list[float] = []
        past_truth: list[str] = []
        past_proxy_pred: list[str] = []
        past_mom3_pred: list[str] = []
        past_mom5_pred: list[str] = []
        past_meanrev_pred: list[str] = []
        past_trend_pred: list[str] = []

        def _mom_label(diffs_list: list[float], n: int) -> Optional[str]:
            if len(diffs_list) < n:
                return None
            arr = np.asarray(diffs_list[-n:], dtype=float)
            if arr.size == 0:
                return None
            m = float(np.median(arr))
            return _label3(m, eps)

        def _trend_label(actuals: list[float], n: int = 10) -> Optional[str]:
            if len(actuals) < n:
                return None
            hat = _linreg_forecast_hat(actuals[-n:])
            if hat is None:
                return None
            # Compare predicted next actual to last actual as a trend proxy.
            return _label3(float(hat) - float(actuals[-1]), eps)

        diffs_ap_hist: list[float] = []  # (A-P) history

        for idx, r in g.iterrows():
            a = r["a"]
            p = r["p"]
            f = r["f"]

            if a is None or not np.isfinite(a):
                continue
            a = float(a)
            if p is None or not np.isfinite(p):
                # Keep the level series for trend/proxy models, but do not score this point
                # (we don't have a Previous to define the truth label).
                past_actuals.append(a)
                continue
            p = float(p)
            truth = _truth(a, p, eps)

            # Build candidate predictions (using information available up to idx).
            proxy = float(f) if (f is not None and np.isfinite(f)) else None
            if proxy is None:
                proxy = _linreg_forecast_hat(past_actuals)
            pred_proxy = _label3(float(proxy) - p, eps) if (proxy is not None and np.isfinite(proxy)) else None

            # momentum / mean reversion based on (A-P) history up to previous points
            pred_mom3 = _mom_label(diffs_ap_hist, 3)
            pred_mom5 = _mom_label(diffs_ap_hist, 5)
            pred_meanrev = None
            if diffs_ap_hist:
                pred_meanrev = _label3(-float(diffs_ap_hist[-1]), eps)
            pred_trend = _trend_label(past_actuals, 10)

            # Evaluate meta-choice only after we have enough past labeled points.
            if len(past_truth) >= max(10, recent_k):
                lo = max(0, len(past_truth) - int(recent_k))
                hist_truth = past_truth[lo:]

                def score(preds: list[str]) -> float:
                    hp = preds[lo:]
                    if not hp:
                        return -1.0
                    c = sum(int(t == pr) for t, pr in zip(hist_truth, hp, strict=False))
                    return c / len(hp)

                candidates: list[tuple[str, Optional[str], float]] = []
                candidates.append(("proxy", pred_proxy, score(past_proxy_pred)))
                candidates.append(("mom3", pred_mom3, score(past_mom3_pred)))
                candidates.append(("mom5", pred_mom5, score(past_mom5_pred)))
                candidates.append(("meanrev", pred_meanrev, score(past_meanrev_pred)))
                candidates.append(("trend", pred_trend, score(past_trend_pred)))

                # pick best scoring candidate that can produce a prediction for this point
                best = None
                best_s = -1.0
                for _name, pred_now, s in candidates:
                    if pred_now is None:
                        continue
                    if s > best_s + 1e-12:
                        best_s = s
                        best = pred_now
                if best is not None:
                    out.add(truth, best)

            # Append this point's truth/preds for future scoring.
            past_truth.append(truth)
            past_proxy_pred.append(pred_proxy or "=")
            past_mom3_pred.append(pred_mom3 or "=")
            past_mom5_pred.append(pred_mom5 or "=")
            past_meanrev_pred.append(pred_meanrev or "=")
            past_trend_pred.append(pred_trend or "=")
            diffs_ap_hist.append(a - p)

            # Advance the actual series after scoring so proxy/trend never sees the current release.
            past_actuals.append(a)

    return out


@dataclass
class ConfSet:
    c: Confusion
    used: int = 0


def _evaluate_metric(
    df: pd.DataFrame, *, thresholds: list[float]
) -> tuple[Confusion, Confusion, Confusion, Confusion, Confusion, dict[float, ConfSet], dict[float, ConfSet]]:
    df = df.sort_values("dt_utc").reset_index(drop=True).copy()
    c_f = Confusion()
    c_p = Confusion()
    # Alternative: predict (Actual vs Previous) using (Forecast vs Previous) direction.
    c_p_by_fp = Confusion()
    # Alternative: predict (Actual vs Previous) using proxy-previous direction.
    # proxy = Forecast if present else linreg(10) pseudo-forecast from past actuals.
    c_p_by_proxy = Confusion()
    # Same proxy rule, but with a fixed per-metric eps (median(|A-P|) * eq_factor) instead of a moving window eps.
    c_p_by_proxy_fixed = Confusion()
    by_th_f: dict[float, ConfSet] = {t: ConfSet(Confusion(), 0) for t in thresholds}
    by_th_p: dict[float, ConfSet] = {t: ConfSet(Confusion(), 0) for t in thresholds}

    # Use numpy arrays for speed.
    dt = df["dt_utc"].to_numpy(dtype="datetime64[ns]")
    a = df["a"].to_numpy(dtype="float64")
    f = df["f"].to_numpy(dtype="float64")
    p = df["p"].to_numpy(dtype="float64")

    model_f = _best_model_for_metric(dt, a, f, kind="forecast")
    model_p = _best_model_for_metric(dt, a, p, kind="prev")

    # Fixed eps for proxy-vs-previous baseline: eps = median(|A-P|) * eq_factor on this metric slice.
    eq_factor = float(df.attrs.get("_eq_factor", 0.1))
    ap_diffs = np.abs(a - p)
    ap_diffs = ap_diffs[np.isfinite(ap_diffs)]
    med_ap = float(np.median(ap_diffs)) if ap_diffs.size else 0.0
    eps_fixed_ap = max(1e-9, med_ap * eq_factor)

    def start_idx(ref_i: int, months: int) -> int:
        ref_ts = pd.Timestamp(dt[ref_i]).tz_localize("UTC")
        start_ts = ref_ts - pd.DateOffset(months=int(months))
        start64 = np.datetime64(start_ts.to_datetime64())
        return int(np.searchsorted(dt, start64, side="left"))

    def stats_window(lo: int, hi: int, kind: str) -> Optional[Stats]:
        if hi - lo <= 0:
            return None
        if kind == "forecast":
            b = f[lo:hi]
        else:
            b = p[lo:hi]
        aa = a[lo:hi]
        mask = np.isfinite(aa) & np.isfinite(b)
        if mask.sum() < 8:
            return None
        d = aa[mask] - b[mask]
        diffs = np.abs(d)
        med = float(np.median(diffs)) if diffs.size else 0.0
        eq_factor = float(df.attrs.get("_eq_factor", 0.1))
        eps = max(1e-9, med * eq_factor)
        eq = int(np.sum(np.abs(d) <= eps))
        gt = int(np.sum(d > eps))
        n = int(d.size)
        lt = max(0, n - gt - eq)
        return Stats(n=n, p_gt=gt / n, p_eq=eq / n, p_lt=lt / n, eps=eps)

    def pick_best_months_upto(hi: int, kind: str) -> int:
        # Mirror UI: evaluate last ~36 usable releases up to 'hi'.
        if kind == "forecast":
            mask = np.isfinite(a[:hi]) & np.isfinite(f[:hi])
        else:
            mask = np.isfinite(a[:hi]) & np.isfinite(p[:hi])
        idx = np.nonzero(mask)[0]
        if idx.size == 0:
            return 6
        eval_idx = idx[-36:]
        best_m = 6
        best_acc = -1.0
        for m in range(1, 7):
            correct = 0
            total = 0
            for j in eval_idx:
                lo = start_idx(int(j), m)
                st = stats_window(lo, int(j), kind)
                if st is None:
                    continue
                pred = _argmax3(st)
                if kind == "forecast":
                    truth = _truth(float(a[j]), float(f[j]), st.eps)
                else:
                    truth = _truth(float(a[j]), float(p[j]), st.eps)
                total += 1
                if pred == truth:
                    correct += 1
            if total < 8:
                continue
            acc = correct / total
            if acc > best_acc + 1e-9 or (abs(acc - best_acc) <= 1e-9 and m < best_m):
                best_acc = acc
                best_m = m
        return best_m

    # Keep a rolling list of past actuals for the proxy model (per metric).
    past_actuals: list[float] = []
    for j in range(min(10, len(df))):
        if np.isfinite(a[j]):
            past_actuals.append(float(a[j]))

    for i in range(10, len(df)):
        has_forecast = bool(np.isfinite(f[:i]).any())
        best_f = pick_best_months_upto(i, "forecast") if has_forecast else 6
        best_p = pick_best_months_upto(i, "prev") if bool(np.isfinite(p[:i]).any()) else 6
        recent_m = best_f if has_forecast else best_p
        lo = start_idx(i, recent_m)

        if np.isfinite(a[i]) and np.isfinite(f[i]):
            st = stats_window(lo, i, "forecast")
            if st is not None:
                diffs = (a[lo:i] - f[lo:i])
                msk = np.isfinite(diffs) & np.isfinite(a[lo:i]) & np.isfinite(f[lo:i])
                diffs = diffs[msk]
                if model_f == "last":
                    pred = _pred_last(diffs, st.eps)
                elif model_f == "mean":
                    pred = _pred_mean(diffs, st.eps)
                else:
                    pred = _argmax3(st)
                truth = _truth(float(a[i]), float(f[i]), st.eps)
                c_f.add(truth, pred)
                conf = max(st.p_gt, st.p_eq, st.p_lt)
                for t in thresholds:
                    if conf >= t:
                        by_th_f[t].c.add(truth, pred)
                        by_th_f[t].used += 1

        if np.isfinite(a[i]) and np.isfinite(p[i]):
            st = stats_window(lo, i, "prev")
            if st is not None:
                diffs = (a[lo:i] - p[lo:i])
                msk = np.isfinite(diffs) & np.isfinite(a[lo:i]) & np.isfinite(p[lo:i])
                diffs = diffs[msk]
                if model_p == "last":
                    pred = _pred_last(diffs, st.eps)
                elif model_p == "mean":
                    pred = _pred_mean(diffs, st.eps)
                else:
                    pred = _argmax3(st)
                truth = _truth(float(a[i]), float(p[i]), st.eps)
                c_p.add(truth, pred)
                conf = max(st.p_gt, st.p_eq, st.p_lt)
                for t in thresholds:
                    if conf >= t:
                        by_th_p[t].c.add(truth, pred)
                        by_th_p[t].used += 1

                # Alt predictor: use forecast vs previous when forecast exists.
                if np.isfinite(f[i]):
                    pred_fp = _label3(float(f[i] - p[i]), st.eps)
                    c_p_by_fp.add(truth, pred_fp)

                # Alt predictor: use proxy vs previous (Forecast if available, else linreg hat).
                proxy = float(f[i]) if np.isfinite(f[i]) else None
                if proxy is None:
                    proxy = _linreg_forecast_hat(past_actuals)
                if proxy is not None and np.isfinite(proxy):
                    pred_proxy = _label3(float(proxy - p[i]), st.eps)
                    c_p_by_proxy.add(truth, pred_proxy)

                    # Fixed-eps variant.
                    truth_fixed = _truth(float(a[i]), float(p[i]), eps_fixed_ap)
                    pred_fixed = _label3(float(proxy - p[i]), eps_fixed_ap)
                    c_p_by_proxy_fixed.add(truth_fixed, pred_fixed)

        # Advance the proxy model state after using index i (do not leak a[i] into prediction at i).
        if np.isfinite(a[i]):
            past_actuals.append(float(a[i]))

    return c_f, c_p, c_p_by_fp, c_p_by_proxy, c_p_by_proxy_fixed, by_th_f, by_th_p


def main(argv: Optional[Iterable[str]] = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--calendar-dir", type=Path, default=Path("data/Economic_Calendar"))
    ap.add_argument("--currency", type=str, default="USD")
    ap.add_argument("--importance", nargs="*", default=["Medium", "High"])
    ap.add_argument(
        "--model-json",
        type=Path,
        default=Path("data/analysis/predict_release_model_usd.json"),
        help="Predict Release model JSON to report app-like backtest stats.",
    )
    ap.add_argument("--min-releases", type=int, default=18, help="Only evaluate metrics with at least N releases.")
    ap.add_argument(
        "--max-releases-per-metric",
        type=int,
        default=140,
        help="Limit evaluation to the most recent N releases per metric for speed (mirrors recent focus).",
    )
    ap.add_argument(
        "--eq-factor",
        type=float,
        default=0.10,
        help='Approx "=" tolerance factor: eps = median(abs(diff)) * factor',
    )
    ap.add_argument(
        "--report-per-metric",
        action="store_true",
        help="Print per-metric accuracies (top/bottom) to help debug gating.",
    )
    ap.add_argument(
        "--thresholds",
        type=str,
        default="0.55,0.60,0.65,0.70",
        help="Comma-separated confidence thresholds for 'predict only when confident' evaluation.",
    )
    ap.add_argument(
        "--metric-gate",
        type=str,
        default="",
        help="Comma-separated backtest thresholds (0..1). Only include metrics whose recent backtest >= threshold.",
    )
    ap.add_argument(
        "--metric-min-n",
        type=int,
        default=30,
        help="When using --metric-gate, require at least this many evaluated samples per metric.",
    )
    args = ap.parse_args(list(argv) if argv is not None else None)

    thresholds: list[float] = []
    for raw in str(args.thresholds).split(","):
        raw = raw.strip()
        if not raw:
            continue
        try:
            thresholds.append(float(raw))
        except ValueError:
            continue
    thresholds = sorted({t for t in thresholds if 0.0 < t < 1.0})

    metric_gates: list[float] = []
    for raw in str(args.metric_gate).split(","):
        raw = raw.strip()
        if not raw:
            continue
        try:
            metric_gates.append(float(raw))
        except ValueError:
            continue
    metric_gates = sorted({t for t in metric_gates if 0.0 < t < 1.0})

    df = _load_calendar_rows(args.calendar_dir)
    if df.empty:
        print("No calendar rows found.")
        return 1

    df = df[df["currency"] == args.currency.upper()].copy()
    df = df[df["importance"].isin([s.title() for s in args.importance])].copy()

    # A stronger, always-available baseline for vs Previous (does not depend on the moving-window stats logic).
    proxy_only = _proxy_only_vs_prev(df, float(args.eq_factor))
    meta_ens = _meta_ensemble_vs_prev(df, float(args.eq_factor), recent_k=24)

    total_f = Confusion()
    total_p = Confusion()
    total_p_by_fp = Confusion()
    total_p_by_proxy = Confusion()
    total_p_by_proxy_fixed = Confusion()
    total_by_th_f: dict[float, ConfSet] = {t: ConfSet(Confusion(), 0) for t in thresholds}
    total_by_th_p: dict[float, ConfSet] = {t: ConfSet(Confusion(), 0) for t in thresholds}
    gated_total_f: dict[float, Confusion] = {t: Confusion() for t in metric_gates}
    gated_total_p: dict[float, Confusion] = {t: Confusion() for t in metric_gates}
    gated_metrics_used_f: dict[float, int] = {t: 0 for t in metric_gates}
    gated_metrics_used_p: dict[float, int] = {t: 0 for t in metric_gates}

    grouped = df.groupby("metric_key", sort=False)
    per_metric_rows: list[tuple[str, float, int, float, int]] = []
    for name, g in grouped:
        if len(g) < int(args.min_releases):
            continue
        if int(args.max_releases_per_metric) > 0 and len(g) > int(args.max_releases_per_metric):
            g = g.sort_values("dt_utc").tail(int(args.max_releases_per_metric))
        g = g.copy()
        g.attrs["_eq_factor"] = float(args.eq_factor)
        c_f, c_p, c_p_by_fp, c_p_by_proxy, c_p_by_proxy_fixed, by_th_f, by_th_p = _evaluate_metric(g, thresholds=thresholds)
        for k in total_p_by_fp.__dataclass_fields__:
            setattr(total_p_by_fp, k, getattr(total_p_by_fp, k) + getattr(c_p_by_fp, k))
        for k in total_p_by_proxy.__dataclass_fields__:
            setattr(total_p_by_proxy, k, getattr(total_p_by_proxy, k) + getattr(c_p_by_proxy, k))
        for k in total_p_by_proxy_fixed.__dataclass_fields__:
            setattr(total_p_by_proxy_fixed, k, getattr(total_p_by_proxy_fixed, k) + getattr(c_p_by_proxy_fixed, k))
        for k in total_f.__dataclass_fields__:
            setattr(total_f, k, getattr(total_f, k) + getattr(c_f, k))
        for k in total_p.__dataclass_fields__:
            setattr(total_p, k, getattr(total_p, k) + getattr(c_p, k))
        for t in thresholds:
            for k in total_by_th_f[t].c.__dataclass_fields__:
                setattr(
                    total_by_th_f[t].c,
                    k,
                    getattr(total_by_th_f[t].c, k) + getattr(by_th_f[t].c, k),
                )
            total_by_th_f[t].used += by_th_f[t].used
            for k in total_by_th_p[t].c.__dataclass_fields__:
                setattr(
                    total_by_th_p[t].c,
                    k,
                    getattr(total_by_th_p[t].c, k) + getattr(by_th_p[t].c, k),
                )
            total_by_th_p[t].used += by_th_p[t].used

        # Metric-level gate: include only metrics with good recent backtest.
        if metric_gates:
            def _acc(conf: Confusion) -> float:
                tot = conf.total()
                return (conf.correct() / tot) if tot else 0.0

            metric_score_f = _acc(c_f)
            metric_score_p = _acc(c_p)
            metric_n_f = c_f.total()
            metric_n_p = c_p.total()

            for gate in metric_gates:
                if metric_n_f >= int(args.metric_min_n) and metric_score_f >= gate:
                    for k in gated_total_f[gate].__dataclass_fields__:
                        setattr(
                            gated_total_f[gate],
                            k,
                            getattr(gated_total_f[gate], k) + getattr(c_f, k),
                        )
                    gated_metrics_used_f[gate] += 1
                if metric_n_p >= int(args.metric_min_n) and metric_score_p >= gate:
                    for k in gated_total_p[gate].__dataclass_fields__:
                        setattr(
                            gated_total_p[gate],
                            k,
                            getattr(gated_total_p[gate], k) + getattr(c_p, k),
                        )
                    gated_metrics_used_p[gate] += 1

        if args.report_per_metric:
            def _acc(c: Confusion) -> float:
                tot = c.total()
                return (c.correct() / tot) if tot else 0.0
            per_metric_rows.append((name, _acc(c_f), c_f.total(), _acc(c_p), c_p.total()))

    print("Predict Release evaluation (baselines + app model backtest)")
    print(f"currency={args.currency.upper()} importance={','.join([s.title() for s in args.importance])}")
    print("")
    print("Actual vs Forecast:", _fmt_conf(total_f))
    print("Actual vs Previous:", _fmt_conf(total_p))
    print("Alt vs Previous (predict by Forecast-Previous):", _fmt_conf(total_p_by_fp))
    print("Alt vs Previous (predict by Proxy-Previous):", _fmt_conf(total_p_by_proxy))
    print("Alt vs Previous (proxy, fixed eps):", _fmt_conf(total_p_by_proxy_fixed))
    print("Proxy-only vs Previous (no gating):", _fmt_conf(proxy_only))
    print("Meta-ensemble vs Previous (no gating):", _fmt_conf(meta_ens))
    print(f'Approx "=" tolerance: eq_factor={float(args.eq_factor):.2f}')

    # Report the actual model used by the app (if available).
    model = _load_predict_release_model(Path(args.model_json))
    if model:
        wf = (model.get("models") or {}).get("ap_with_forecast") or {}
        nf = (model.get("models") or {}).get("ap_no_forecast") or {}
        wf_row = _find_eval_row(wf)
        nf_row = _find_eval_row(nf)

        wf_n = int((wf.get("eval") or {}).get("n") or 0)
        nf_n = int((nf.get("eval") or {}).get("n") or 0)
        wf_th = float(wf.get("recommended_threshold") or 0.0)
        nf_th = float(nf.get("recommended_threshold") or 0.0)
        wf_raw = float((wf.get("eval") or {}).get("acc") or 0.0)
        nf_raw = float((nf.get("eval") or {}).get("acc") or 0.0)

        wf_shown_n = int(wf_row.get("n") or 0) if wf_row else 0
        nf_shown_n = int(nf_row.get("n") or 0) if nf_row else 0
        wf_shown_acc = float(wf_row.get("acc") or 0.0) if wf_row else 0.0
        nf_shown_acc = float(nf_row.get("acc") or 0.0) if nf_row else 0.0
        wf_cov = float(wf_row.get("coverage") or 0.0) if wf_row else 0.0
        nf_cov = float(nf_row.get("coverage") or 0.0) if nf_row else 0.0

        denom = wf_shown_n + nf_shown_n
        shown_acc = ((wf_shown_n * wf_shown_acc + nf_shown_n * nf_shown_acc) / denom) if denom else 0.0
        shown_cov = (denom / (wf_n + nf_n)) if (wf_n + nf_n) else 0.0

        print("")
        print("Calendar model backtest (Actual vs Previous; time-split 80/20):")
        conf_desc = (wf.get("eval") or {}).get("confidence") or (nf.get("eval") or {}).get("confidence") or ""
        if conf_desc:
            print(f"  - confidence score: {conf_desc}")
        print(
            f"  - with Forecast: raw acc={wf_raw:.3f} n={wf_n} | "
            f"shown th={wf_th:.2f} acc={wf_shown_acc:.3f} cov={wf_cov:.3f}"
        )
        if nf_th >= 0.95:
            print(
                f"  - no Forecast:  raw acc={nf_raw:.3f} n={nf_n} | "
                f"global gate disabled (th={nf_th:.2f}); see combined eval for app-style output"
            )
        else:
            print(
                f"  - no Forecast:  raw acc={nf_raw:.3f} n={nf_n} | "
                f"shown th={nf_th:.2f} acc={nf_shown_acc:.3f} cov={nf_cov:.3f}"
            )
        print(f"  - combined shown: acc={shown_acc:.3f} cov={shown_cov:.3f}")
    if thresholds:
        print("")
        print("Confident-only (coverage/accuracy):")
        for t in thresholds:
            cf = total_by_th_f[t].c
            cp = total_by_th_p[t].c
            f_tot = cf.total()
            p_tot = cp.total()
            f_acc = (cf.correct() / f_tot) if f_tot else 0.0
            p_acc = (cp.correct() / p_tot) if p_tot else 0.0
            print(
                f"  - th>={t:.2f}: vsF acc={f_acc:.3f} n={f_tot} | vsP acc={p_acc:.3f} n={p_tot}"
            )

    if metric_gates:
        print("")
        print("Metric-gated (by metric score) totals:")
        for gate in metric_gates:
            cf = gated_total_f[gate]
            cp = gated_total_p[gate]
            f_tot = cf.total()
            p_tot = cp.total()
            f_acc = (cf.correct() / f_tot) if f_tot else 0.0
            p_acc = (cp.correct() / p_tot) if p_tot else 0.0
            print(
                f"  - gate>={gate:.2f}: vsF acc={f_acc:.3f} n={f_tot} metrics={gated_metrics_used_f[gate]} | "
                f"vsP acc={p_acc:.3f} n={p_tot} metrics={gated_metrics_used_p[gate]}"
            )

    if args.report_per_metric and per_metric_rows:
        pm = pd.DataFrame(per_metric_rows, columns=["metric", "acc_f", "n_f", "acc_p", "n_p"])
        pm = pm.sort_values(["acc_f", "n_f"], ascending=[False, False]).reset_index(drop=True)
        print("")
        print("Top 12 metrics by vs Forecast accuracy:")
        print(pm.head(12).to_string(index=False))
        print("")
        print("Top 12 metrics by vs Previous accuracy:")
        pm2 = pm.sort_values(["acc_p", "n_p"], ascending=[False, False]).reset_index(drop=True)
        print(pm2.head(12).to_string(index=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
