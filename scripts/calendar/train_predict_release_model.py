"""
Train a small, dependency-light Predict Release model from Economic_Calendar history.

We intentionally keep the model simple and portable:
  - Multinomial (3-way) logistic regression (softmax) trained with plain numpy
  - Features derived from the metric's own recent history (+ Forecast/Previous when available)
  - Three sub-models:
      1) Actual vs Previous (A-P), when Forecast exists for the selected release ("ap_with_forecast")
      2) Actual vs Previous (A-P), when Forecast is missing ("ap_no_forecast")
      3) Actual vs Forecast (A-F), when Forecast exists ("af_with_forecast")

Notes:
  - A-P is the "main" task because it's more stable and applies to no-forecast events.
  - A-F ("expectations surprise") is important for market reactions, but is harder to predict. Treat it as
    lower-confidence unless the model's confidence score is high.

The output JSON is designed to be consumed by the desktop app at runtime.
No price data is required.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import numpy as np
import pandas as pd

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

from scripts.calendar.evaluate_predict_release_accuracy import _load_calendar_rows


def _utc_now_rfc3339() -> str:
    return datetime.now(timezone.utc).isoformat()


def _median_abs(values: np.ndarray) -> float:
    values = values[np.isfinite(values)]
    if values.size == 0:
        return 1.0
    med = float(np.median(np.abs(values)))
    if not np.isfinite(med) or med <= 1e-12:
        return 1.0
    return med


def _robust_loc_scale(values: np.ndarray) -> tuple[float, float]:
    values = values[np.isfinite(values)]
    if values.size == 0:
        return 0.0, 1.0
    med = float(np.median(values))
    mad = float(np.median(np.abs(values - med)))
    if not np.isfinite(mad) or mad <= 1e-12:
        mad = 1.0
    return med, mad


def _softmax(scores: np.ndarray) -> np.ndarray:
    scores = scores - np.max(scores, axis=1, keepdims=True)
    e = np.exp(scores)
    return e / np.sum(e, axis=1, keepdims=True)


def _train_softmax(
    X: np.ndarray,
    y: np.ndarray,
    *,
    l2: float,
    lr: float,
    iters: int,
) -> np.ndarray:
    n, d = X.shape
    k = int(np.max(y)) + 1
    W = np.zeros((d, k), dtype=float)
    Y = np.zeros((n, k), dtype=float)
    Y[np.arange(n), y] = 1.0

    for _ in range(int(iters)):
        P = _softmax(X @ W)
        grad = (X.T @ (P - Y)) / n + float(l2) * W
        W -= float(lr) * grad
    return W


def _acc(y_true: np.ndarray, y_pred: np.ndarray) -> float:
    if y_true.size == 0:
        return 0.0
    return float(np.mean(y_true == y_pred))


def _slope(series: np.ndarray) -> float:
    y = np.asarray(series, dtype=float)
    n = int(y.size)
    if n < 2:
        return 0.0
    x = np.arange(n, dtype=float)
    sx = float(x.sum())
    sy = float(y.sum())
    sxx = float((x * x).sum())
    sxy = float((x * y).sum())
    denom = n * sxx - sx * sx
    if abs(denom) <= 1e-12:
        return 0.0
    return float((n * sxy - sx * sy) / denom)


def _linreg_next(series: np.ndarray) -> float | None:
    """Fit a tiny OLS line on the given series and predict the next point.

    We use this as a proxy for releases without Forecast, because many such
    metrics are highly autocorrelated (levels/trends), and a short trend model
    is often more informative than a raw last-diff feature.
    """
    y = np.asarray(series, dtype=float)
    y = y[np.isfinite(y)]
    n = int(y.size)
    if n < 2:
        return None
    x = np.arange(n, dtype=float)
    sx = float(x.sum())
    sy = float(y.sum())
    sxx = float((x * x).sum())
    sxy = float((x * y).sum())
    denom = n * sxx - sx * sx
    if abs(denom) <= 1e-12:
        return None
    slope = (n * sxy - sx * sy) / denom
    intercept = (sy - slope * sx) / n
    pred = slope * n + intercept
    return float(pred) if np.isfinite(pred) else None


def _label_z(z: float, eq_factor: float) -> int:
    # Class indices are stable: 0="=", 1=">", 2="<"
    if abs(z) <= float(eq_factor):
        return 0
    return 1 if z > 0 else 2


@dataclass(frozen=True)
class Dataset:
    X: np.ndarray
    y: np.ndarray
    t: np.ndarray


def _confidence_score(P: np.ndarray) -> np.ndarray:
    # Same score used in trainer + app: maxProb * (maxProb - secondMaxProb)
    if P.size == 0:
        return np.asarray([], dtype="float64")
    maxp = np.max(P, axis=1)
    sorted_p = np.sort(P, axis=1)
    margin = sorted_p[:, -1] - sorted_p[:, -2]
    return (maxp * margin).astype("float64")


def _build_metric_ap_series(df: pd.DataFrame) -> dict[str, dict[str, Any]]:
    # Build per-metric series used for relationship ("nowcast chain") features.
    #
    # We normalise heterogeneous metrics into a comparable z-space:
    #   z_ap = (Actual - Previous) / median(|Actual - Previous|)
    # and keep timestamps as int64 nanoseconds for fast searchsorted lookup.
    out: dict[str, dict[str, Any]] = {}
    grouped = df.groupby("metric_key", sort=False)
    for metric_key, g in grouped:
        g = g.sort_values("dt_utc").reset_index(drop=True)
        a = g["a"].to_numpy(dtype="float64")
        p = g["p"].to_numpy(dtype="float64")
        dt = g["dt_utc"].to_numpy(dtype="datetime64[ns]")
        mask = np.isfinite(a) & np.isfinite(p)
        if not np.any(mask):
            continue
        diffs = (a - p)[mask]
        scale_ap = _median_abs(diffs)
        z = diffs / float(scale_ap)
        t = dt[mask].astype("int64")
        if t.size != z.size:
            continue
        # Ensure monotonic timestamps for binary search.
        order = np.argsort(t)
        out[str(metric_key)] = {
            "t": t[order],
            "z": z[order],
            "scale_ap": float(scale_ap),
        }
    return out


def _build_metric_af_series(df: pd.DataFrame) -> dict[str, dict[str, Any]]:
    # Build per-metric series for surprise vs Forecast:
    #
    #   z_af = (Actual - Forecast) / median(|Actual - Forecast|)
    #
    # This is used as an additional source signal for relationship ("nowcast chain") learning.
    out: dict[str, dict[str, Any]] = {}
    grouped = df.groupby("metric_key", sort=False)
    for metric_key, g in grouped:
        g = g.sort_values("dt_utc").reset_index(drop=True)
        a = g["a"].to_numpy(dtype="float64")
        f = g["f"].to_numpy(dtype="float64")
        dt = g["dt_utc"].to_numpy(dtype="datetime64[ns]")
        mask = np.isfinite(a) & np.isfinite(f)
        if not np.any(mask):
            continue
        diffs = (a - f)[mask]
        scale_af = _median_abs(diffs)
        z = diffs / float(scale_af)
        t = dt[mask].astype("int64")
        if t.size != z.size:
            continue
        order = np.argsort(t)
        out[str(metric_key)] = {
            "t": t[order],
            "z": z[order],
            "scale_af": float(scale_af),
        }
    return out


def _pair_last_before_within_lookback(
    src_t: np.ndarray,
    src_z: np.ndarray,
    tgt_t: np.ndarray,
    tgt_z: np.ndarray,
    *,
    lookback_days: int,
) -> tuple[np.ndarray, np.ndarray]:
    # For each target time, pick the most recent source release strictly before it,
    # and keep the pair only if it's within lookback window.
    if src_t.size == 0 or tgt_t.size == 0:
        return np.asarray([], dtype="float64"), np.asarray([], dtype="float64")
    if src_t.size != src_z.size or tgt_t.size != tgt_z.size:
        return np.asarray([], dtype="float64"), np.asarray([], dtype="float64")

    idx = np.searchsorted(src_t, tgt_t, side="left") - 1
    ok = idx >= 0
    if not np.any(ok):
        return np.asarray([], dtype="float64"), np.asarray([], dtype="float64")

    src_idx = idx[ok].astype("int64", copy=False)
    tgt_idx = np.nonzero(ok)[0].astype("int64", copy=False)
    delta_ns = tgt_t[tgt_idx] - src_t[src_idx]
    lookback_ns = np.int64(int(lookback_days)) * 24 * 3600 * 1_000_000_000
    within = (delta_ns >= 0) & (delta_ns <= lookback_ns)
    if not np.any(within):
        return np.asarray([], dtype="float64"), np.asarray([], dtype="float64")
    return src_z[src_idx[within]].astype("float64"), tgt_z[tgt_idx[within]].astype("float64")


def _corr(x: np.ndarray, y: np.ndarray, *, min_pairs: int) -> float:
    if x.size < int(min_pairs) or y.size < int(min_pairs):
        return 0.0
    if x.size != y.size:
        n = min(int(x.size), int(y.size))
        x = x[:n]
        y = y[:n]
    if x.size < int(min_pairs):
        return 0.0
    if np.allclose(np.std(x), 0) or np.allclose(np.std(y), 0):
        return 0.0
    c = float(np.corrcoef(x, y)[0, 1])
    if not np.isfinite(c):
        return 0.0
    return max(-1.0, min(1.0, c))


def _dir_assoc(x: np.ndarray, y: np.ndarray, *, min_pairs: int, eq_factor: float) -> float:
    """Directional association for z-space series.

    We care about predicting the 3-way direction (>,=,<), not precise magnitude.
    For two paired z-series (source, target), we compute how much better it is to
    *keep* the sign vs *invert* the sign (to handle negatively-related metrics):

      strength = P(label_x == label_y) - P(invert(label_x) == label_y)

    This yields a signed score in [-1, 1], where negative implies inversion.
    We apply a mild sample-size shrinkage to avoid overfitting on short histories.
    """
    if x.size < int(min_pairs) or y.size < int(min_pairs):
        return 0.0
    if x.size != y.size:
        n = min(int(x.size), int(y.size))
        x = x[:n]
        y = y[:n]
    n = int(x.size)
    if n < int(min_pairs):
        return 0.0

    # Clip outliers before labeling (keeps rare spikes from dominating).
    x = np.clip(x.astype("float64"), -3.0, 3.0)
    y = np.clip(y.astype("float64"), -3.0, 3.0)

    # Map to signed labels: -1 ("<"), 0 ("="), +1 (">") in z-space.
    xl = np.zeros(n, dtype="int8")
    yl = np.zeros(n, dtype="int8")
    xl[x > float(eq_factor)] = 1
    xl[x < -float(eq_factor)] = -1
    yl[y > float(eq_factor)] = 1
    yl[y < -float(eq_factor)] = -1

    same = float(np.mean(xl == yl))
    inv = float(np.mean((-xl) == yl))
    strength = same - inv

    # Shrink short histories a bit.
    shrink = float(np.sqrt(n / (n + 20.0)))
    strength *= shrink
    if not np.isfinite(strength):
        return 0.0
    return max(-1.0, min(1.0, float(strength)))


def _compute_relationships_ap(
    series_by_metric: dict[str, dict[str, Any]],
    series_by_metric_af: dict[str, dict[str, Any]] | None = None,
    *,
    eq_factor: float,
    cutoff_t: np.int64,
    lookback_days: int,
    topk: int,
    min_abs_corr: float,
    min_pairs: int,
    min_metric_points: int,
) -> dict[str, list[dict[str, Any]]]:
    # Learn a lightweight "related metrics" map for each target metric.
    #
    # We only use data strictly before cutoff_t to avoid leaking test-period structure.
    metrics: list[str] = []
    for m, s in series_by_metric.items():
        if int(s.get("t", np.asarray([])).size) >= int(min_metric_points):
            metrics.append(m)

    rel: dict[str, list[dict[str, Any]]] = {}
    for tgt in metrics:
        tgt_s = series_by_metric.get(tgt) or {}
        tgt_t_all = tgt_s.get("t", np.asarray([], dtype="int64"))
        tgt_z_all = tgt_s.get("z", np.asarray([], dtype="float64"))
        tgt_mask = tgt_t_all < cutoff_t
        tgt_t = tgt_t_all[tgt_mask]
        tgt_z = tgt_z_all[tgt_mask]
        if tgt_t.size < int(min_pairs):
            continue

        corrs: list[tuple[str, str, float]] = []
        for src in metrics:
            if src == tgt:
                continue

            # Source signal: Actual vs Previous (A-P)
            src_s = series_by_metric.get(src) or {}
            src_t_all = np.asarray(src_s.get("t", np.asarray([], dtype="int64")), dtype="int64")
            src_z_all = np.asarray(src_s.get("z", np.asarray([], dtype="float64")), dtype="float64")
            src_mask = src_t_all < cutoff_t
            src_t = src_t_all[src_mask]
            src_z = src_z_all[src_mask]
            if src_t.size >= int(min_pairs):
                x, y = _pair_last_before_within_lookback(
                    src_t,
                    src_z,
                    tgt_t,
                    tgt_z,
                    lookback_days=int(lookback_days),
                )
                # Directional association is more aligned with the app task (>,=,<) than raw correlation.
                c = _dir_assoc(x, y, min_pairs=int(min_pairs), eq_factor=float(eq_factor))
                if abs(c) + 1e-12 >= float(min_abs_corr):
                    corrs.append((src, "ap", c))

            # Source signal: Actual vs Forecast (A-F), when available.
            if series_by_metric_af is not None:
                src_f = series_by_metric_af.get(src) or {}
                st_all = np.asarray(src_f.get("t", np.asarray([], dtype="int64")), dtype="int64")
                sz_all = np.asarray(src_f.get("z", np.asarray([], dtype="float64")), dtype="float64")
                sm = st_all < cutoff_t
                st = st_all[sm]
                sz = sz_all[sm]
                if st.size >= int(min_pairs):
                    x, y = _pair_last_before_within_lookback(
                        st,
                        sz,
                        tgt_t,
                        tgt_z,
                        lookback_days=int(lookback_days),
                    )
                    c = _dir_assoc(x, y, min_pairs=int(min_pairs), eq_factor=float(eq_factor))
                    if abs(c) + 1e-12 >= float(min_abs_corr):
                        corrs.append((src, "af", c))

        if not corrs:
            continue
        corrs.sort(key=lambda it: -abs(it[2]))
        picked = corrs[: int(topk)]
        rel[tgt] = [{"metric": m, "kind": kind, "corr": float(c)} for m, kind, c in picked]

    return rel


def _build_dataset_ap(
    df: pd.DataFrame,
    *,
    require_forecast: bool,
    eq_factor: float,
    min_metric_points: int,
    relationships_ap: dict[str, list[dict[str, Any]]] | None = None,
    series_by_metric_ap: dict[str, dict[str, Any]] | None = None,
    rel_windows_days: list[int] | None = None,
) -> Dataset:
    # Build samples across all metrics; features are normalised per-metric.
    #
    # Note: we use per-metric robust scales computed from the full available history for that metric.
    # This keeps runtime simple/fast (the app can compute the same scales from the loaded history points).
    X_rows: list[list[float]] = []
    y_rows: list[int] = []
    t_rows: list[np.datetime64] = []

    grouped = df.groupby("metric_key", sort=False)
    for metric_key, g in grouped:
        g = g.sort_values("dt_utc").reset_index(drop=True)
        if len(g) < int(min_metric_points):
            continue

        a_all = g["a"].to_numpy(dtype="float64")
        f_all = g["f"].to_numpy(dtype="float64")
        p_all = g["p"].to_numpy(dtype="float64")
        dt_all = g["dt_utc"].to_numpy(dtype="datetime64[ns]")

        # Per-metric robust scales (avoid unit issues).
        scale_ap = _median_abs(a_all - p_all)
        scale_fp = _median_abs(f_all - p_all)
        scale_af = _median_abs(a_all - f_all)
        med_a, mad_a = _robust_loc_scale(a_all)

        # Need at least 6 previous points for features.
        for i in range(6, len(g)):
            if not np.isfinite(a_all[i]) or not np.isfinite(p_all[i]):
                continue

            has_forecast = bool(np.isfinite(f_all[i]))
            if bool(require_forecast) != has_forecast:
                continue

            # Feature windows (past only).
            idxs = [i - 1, i - 2, i - 3, i - 4, i - 5, i - 6]
            if not np.all(np.isfinite(a_all[idxs])) or not np.all(np.isfinite(p_all[idxs])):
                continue

            z_ap_1 = float((a_all[i - 1] - p_all[i - 1]) / scale_ap)
            z_ap_3 = float(np.mean((a_all[i - 3 : i] - p_all[i - 3 : i]) / scale_ap))
            z_ap_6 = float(np.mean((a_all[i - 6 : i] - p_all[i - 6 : i]) / scale_ap))
            z_a_level = float((a_all[i - 1] - med_a) / mad_a)
            z_a_slope6 = float(_slope(a_all[i - 6 : i]) / scale_ap)

            # Last surprise (optional when forecast exists for the previous release).
            z_af_1 = (
                float((a_all[i - 1] - f_all[i - 1]) / scale_af) if np.isfinite(f_all[i - 1]) else 0.0
            )
            if require_forecast:
                # Forecast-related features, only when forecast exists for the selected release.
                z_fp = float((f_all[i] - p_all[i]) / scale_fp) if np.isfinite(f_all[i]) else 0.0
                feats = [1.0, z_fp, z_ap_1, z_ap_3, z_ap_6, z_a_level, z_a_slope6, z_af_1]
            else:
                gap_days = float((dt_all[i] - dt_all[i - 1]).astype("timedelta64[D]").astype(int))
                # Proxy next-Actual from a short trend model on the last 6 Actuals.
                # This is a strong baseline for many no-forecast releases.
                a_hat = _linreg_next(a_all[i - 6 : i])
                z_hat_ap = float((a_hat - p_all[i]) / scale_ap) if a_hat is not None else 0.0
                z_hat_da = float((a_hat - a_all[i - 1]) / scale_ap) if a_hat is not None else 0.0
                feats = [1.0, z_ap_1, z_ap_3, z_ap_6, z_a_level, z_a_slope6, z_hat_ap, z_hat_da, gap_days]

            if not np.all(np.isfinite(feats)):
                continue

            z_true = float((a_all[i] - p_all[i]) / scale_ap)
            y = _label_z(z_true, float(eq_factor))

            X_rows.append(feats)
            y_rows.append(int(y))
            t_rows.append(dt_all[i])

    X = np.asarray(X_rows, dtype="float64")
    y = np.asarray(y_rows, dtype="int64")
    t = np.asarray(t_rows)
    order = np.argsort(t)
    return Dataset(X=X[order], y=y[order], t=t[order])


def _build_dataset_af(
    df: pd.DataFrame,
    *,
    eq_factor: float,
    min_metric_points: int,
) -> Dataset:
    """Build samples for Actual vs Forecast (A-F) when Forecast exists.

    This mirrors the app-side feature computation so the UI can run the same model
    without extra dependencies.
    """
    X_rows: list[list[float]] = []
    y_rows: list[int] = []
    t_rows: list[np.datetime64] = []

    grouped = df.groupby("metric_key", sort=False)
    for _metric_key, g in grouped:
        g = g.sort_values("dt_utc").reset_index(drop=True)
        if len(g) < int(min_metric_points):
            continue

        a_all = g["a"].to_numpy(dtype="float64")
        f_all = g["f"].to_numpy(dtype="float64")
        p_all = g["p"].to_numpy(dtype="float64")
        dt_all = g["dt_utc"].to_numpy(dtype="datetime64[ns]")

        scale_ap = _median_abs(a_all - p_all)
        scale_fp = _median_abs(f_all - p_all)
        scale_af = _median_abs(a_all - f_all)
        med_a, mad_a = _robust_loc_scale(a_all)

        for i in range(6, len(g)):
            # Need Actual and Forecast for the label.
            if not np.isfinite(a_all[i]) or not np.isfinite(f_all[i]):
                continue

            # Feature windows (past only): need A/P history.
            idxs = [i - 1, i - 2, i - 3, i - 4, i - 5, i - 6]
            if not np.all(np.isfinite(a_all[idxs])) or not np.all(np.isfinite(p_all[idxs])):
                continue

            z_ap_1 = float((a_all[i - 1] - p_all[i - 1]) / scale_ap)
            z_ap_3 = float(np.mean((a_all[i - 3 : i] - p_all[i - 3 : i]) / scale_ap))
            z_ap_6 = float(np.mean((a_all[i - 6 : i] - p_all[i - 6 : i]) / scale_ap))
            z_a_level = float((a_all[i - 1] - med_a) / mad_a)
            z_a_slope6 = float(_slope(a_all[i - 6 : i]) / scale_ap)

            # Forecast vs Previous for the selected release; if Previous is missing, treat as neutral.
            z_fp = float((f_all[i] - p_all[i]) / scale_fp) if np.isfinite(p_all[i]) else 0.0

            # Last surprise (optional when the previous release had Forecast).
            z_af_1 = (
                float((a_all[i - 1] - f_all[i - 1]) / scale_af) if np.isfinite(f_all[i - 1]) else 0.0
            )

            feats = [1.0, z_fp, z_ap_1, z_ap_3, z_ap_6, z_a_level, z_a_slope6, z_af_1]
            if not np.all(np.isfinite(feats)):
                continue

            z_true = float((a_all[i] - f_all[i]) / scale_af)
            y = _label_z(z_true, float(eq_factor))

            X_rows.append(feats)
            y_rows.append(int(y))
            t_rows.append(dt_all[i])

    X = np.asarray(X_rows, dtype="float64")
    y = np.asarray(y_rows, dtype="int64")
    t = np.asarray(t_rows)
    order = np.argsort(t)
    return Dataset(X=X[order], y=y[order], t=t[order])


def _evaluate_model(
    X: np.ndarray,
    y: np.ndarray,
    W: np.ndarray,
    *,
    thresholds: list[float],
) -> dict[str, Any]:
    P = _softmax(X @ W)
    y_pred = np.argmax(P, axis=1).astype(int)
    # Confidence score (better than raw max-prob for selecting "easy" samples):
    #   score = maxProb * (maxProb - secondMaxProb)
    # This tends to improve coverage for the same target accuracy on no-forecast releases.
    conf = _confidence_score(P)

    out: dict[str, Any] = {
        "acc": _acc(y, y_pred),
        "n": int(y.size),
        "confidence": "maxp*(maxp-second)",
        "thresholds": [],
    }

    for th in thresholds:
        mask = conf >= float(th)
        n_th = int(np.sum(mask))
        if n_th <= 0:
            continue
        out["thresholds"].append(
            {
                "th": float(th),
                "acc": _acc(y[mask], y_pred[mask]),
                "n": n_th,
                "coverage": float(n_th / y.size) if y.size else 0.0,
            }
        )
    return out


def _pick_threshold(th_stats: list[dict[str, Any]], *, min_acc: float, min_coverage: float) -> float:
    # Pick the smallest threshold that meets both constraints (more coverage / smoother UX).
    best = None
    for row in th_stats:
        acc = float(row.get("acc", 0.0))
        cov = float(row.get("coverage", 0.0))
        th = float(row.get("th", 0.0))
        if acc + 1e-12 >= float(min_acc) and cov + 1e-12 >= float(min_coverage):
            best = th if best is None else min(best, th)
    if best is None and th_stats:
        # Fallback: choose the threshold with best accuracy, then highest coverage.
        th_stats_sorted = sorted(th_stats, key=lambda r: (-float(r.get("acc", 0.0)), -float(r.get("coverage", 0.0))))
        best = float(th_stats_sorted[0].get("th", 0.6))
    return float(best) if best is not None else 0.6


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--calendar-dir", type=Path, default=Path("data/Economic_Calendar"))
    ap.add_argument("--currency", type=str, default="USD")
    ap.add_argument("--importance", nargs="*", default=["Medium", "High"])
    ap.add_argument("--eq-factor", type=float, default=0.10)
    ap.add_argument(
        "--min-metric-points",
        type=int,
        default=60,
        help="Only include metrics with at least this many releases (reduces noise/overconfidence).",
    )
    ap.add_argument(
        "--rel-min-metric-points",
        type=int,
        default=24,
        help="Minimum releases for metrics to participate in relationship (nowcast chain) learning/eval.",
    )
    ap.add_argument("--out-json", type=Path, default=Path("data/analysis/predict_release_model_usd.json"))
    args = ap.parse_args()

    df = _load_calendar_rows(Path(args.calendar_dir))
    df = df[
        (df["currency"] == str(args.currency).upper())
        & (df["importance"].isin([s.title() for s in args.importance]))
    ].copy()
    if df.empty:
        raise SystemExit("No calendar rows after filtering.")

    eq_factor = float(args.eq_factor)
    # Thresholds for the confidence score (not raw max-prob).
    #
    # Include 0.00 / 0.05 so we can tune toward higher "reliable" coverage when a sub-model is strong
    # (especially the with-Forecast case), without forcing the UI to hide most outputs.
    thresholds = [0.00, 0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60]

    # Relationship ("nowcast chain") configuration (no-forecast fallback):
    # use other metrics' most recent signals in the last 1-6 months as a lightweight nowcast.
    # Relationship ("nowcast chain") is intentionally lightweight, but we want decent coverage.
    # Wider lookback + slightly lower corr threshold helps bring more metrics into the graph,
    # while per-metric confidence thresholds keep reliability acceptable.
    rel_lookback_days = 90
    rel_recent_days = 180
    rel_topk = 10
    rel_min_abs_corr = 0.08
    rel_min_pairs = 12
    rel_min_metric_points = int(args.rel_min_metric_points)
    rel_min_test_samples = 15  # per-metric test points (post-split) to trust a threshold
    rel_min_shown_samples = 6  # per-metric shown points at a threshold
    rel_target_min_acc = 0.71
    rel_target_min_cov = 0.10

    series_by_metric_ap = _build_metric_ap_series(df)
    series_by_metric_af = _build_metric_af_series(df)

    # Build datasets (logistic models). These are history-only baselines.
    ds_with_f = _build_dataset_ap(
        df,
        require_forecast=True,
        eq_factor=eq_factor,
        min_metric_points=int(args.min_metric_points),
    )
    ds_no_f = _build_dataset_ap(
        df,
        require_forecast=False,
        eq_factor=eq_factor,
        min_metric_points=int(args.min_metric_points),
    )
    ds_af = _build_dataset_af(
        df,
        eq_factor=eq_factor,
        min_metric_points=int(args.min_metric_points),
    )

    # Learn related metrics from the training-time cutoff only (avoid leaking test-period structure).
    n_nf = int(ds_no_f.t.size)
    cut_nf = int(n_nf * 0.8)
    cut_nf = max(0, min(cut_nf, n_nf - 1)) if n_nf else 0
    cutoff_t = ds_no_f.t[cut_nf].astype("int64") if n_nf else np.int64(0)
    relationships_ap = _compute_relationships_ap(
        series_by_metric_ap,
        series_by_metric_af=series_by_metric_af,
        eq_factor=float(eq_factor),
        cutoff_t=cutoff_t,
        lookback_days=int(rel_lookback_days),
        topk=int(rel_topk),
        min_abs_corr=float(rel_min_abs_corr),
        min_pairs=int(rel_min_pairs),
        min_metric_points=int(rel_min_metric_points),
    )

    def split(ds: Dataset) -> tuple[Dataset, Dataset]:
        n = int(ds.y.size)
        cut = int(n * 0.8)
        train = Dataset(X=ds.X[:cut], y=ds.y[:cut], t=ds.t[:cut])
        test = Dataset(X=ds.X[cut:], y=ds.y[cut:], t=ds.t[cut:])
        return train, test

    train_wf, test_wf = split(ds_with_f)
    train_nf, test_nf = split(ds_no_f)
    train_af, test_af = split(ds_af)

    # Train.
    W_wf = _train_softmax(train_wf.X, train_wf.y, l2=2e-2, lr=0.05, iters=1400)
    W_nf = _train_softmax(train_nf.X, train_nf.y, l2=3e-2, lr=0.04, iters=1800)
    W_af = _train_softmax(train_af.X, train_af.y, l2=2e-2, lr=0.05, iters=1600)

    # Evaluate.
    eval_wf = _evaluate_model(test_wf.X, test_wf.y, W_wf, thresholds=thresholds)
    eval_nf = _evaluate_model(test_nf.X, test_nf.y, W_nf, thresholds=thresholds)
    eval_af = _evaluate_model(test_af.X, test_af.y, W_af, thresholds=thresholds)

    # Metric-specific confidence gates for the logistic models.
    #
    # Goal: increase "reliable" coverage for stable metrics without lowering global thresholds.
    # We only enable a metric gate if it has enough test samples, and if there exists a threshold
    # that meets both target accuracy and coverage on the post-split segment.
    def build_metric_gates_ap(
        *,
        require_forecast: bool,
        W: np.ndarray,
        target_min_acc: float,
        target_min_cov: float,
        min_test_samples: int,
        min_shown_samples: int,
    ) -> dict[str, dict[str, Any]]:
        # Metric-specific thresholds for the shared logistic model.
        #
        # Important: do the 80/20 time split *per metric*, not globally across all metrics.
        # Otherwise low-frequency metrics (monthly/quarterly) rarely have enough samples in the
        # global "last 20%" time window, which artificially kills coverage for Medium/High events.
        #
        # We apply a small accuracy shrinkage to avoid enabling a metric just because it got lucky
        # on a tiny test segment.
        min_points_gate = max(24, int(args.rel_min_metric_points))

        grouped = df.groupby("metric_key", sort=False)
        enabled: dict[str, dict[str, Any]] = {}
        for metric_key, g in grouped:
            metric_key = str(metric_key)
            g = g.sort_values("dt_utc").reset_index(drop=True)
            if len(g) < int(min_points_gate):
                continue

            a_all = g["a"].to_numpy(dtype="float64")
            f_all = g["f"].to_numpy(dtype="float64")
            p_all = g["p"].to_numpy(dtype="float64")
            dt_all = g["dt_utc"].to_numpy(dtype="datetime64[ns]")

            scale_ap = _median_abs(a_all - p_all)
            scale_fp = _median_abs(f_all - p_all)
            scale_af = _median_abs(a_all - f_all)
            med_a, mad_a = _robust_loc_scale(a_all)

            rows: list[tuple[int, int, int, float]] = []  # (t_ns, y, pred, score)
            for i in range(6, len(g)):
                if not np.isfinite(a_all[i]) or not np.isfinite(p_all[i]):
                    continue
                has_forecast = bool(np.isfinite(f_all[i]))
                if bool(require_forecast) != has_forecast:
                    continue

                idxs = [i - 1, i - 2, i - 3, i - 4, i - 5, i - 6]
                if not np.all(np.isfinite(a_all[idxs])) or not np.all(np.isfinite(p_all[idxs])):
                    continue

                z_ap_1 = float((a_all[i - 1] - p_all[i - 1]) / scale_ap)
                z_ap_3 = float(np.mean((a_all[i - 3 : i] - p_all[i - 3 : i]) / scale_ap))
                z_ap_6 = float(np.mean((a_all[i - 6 : i] - p_all[i - 6 : i]) / scale_ap))
                z_a_level = float((a_all[i - 1] - med_a) / mad_a)
                z_a_slope6 = float(_slope(a_all[i - 6 : i]) / scale_ap)

                z_af_1 = (
                    float((a_all[i - 1] - f_all[i - 1]) / scale_af) if np.isfinite(f_all[i - 1]) else 0.0
                )

                if require_forecast:
                    z_fp = float((f_all[i] - p_all[i]) / scale_fp) if np.isfinite(f_all[i]) else 0.0
                    feats = [1.0, z_fp, z_ap_1, z_ap_3, z_ap_6, z_a_level, z_a_slope6, z_af_1]
                else:
                    gap_days = float((dt_all[i] - dt_all[i - 1]).astype("timedelta64[D]").astype(int))
                    a_hat = _linreg_next(a_all[i - 6 : i])
                    z_hat_ap = float((a_hat - p_all[i]) / scale_ap) if a_hat is not None else 0.0
                    z_hat_da = float((a_hat - a_all[i - 1]) / scale_ap) if a_hat is not None else 0.0
                    feats = [1.0, z_ap_1, z_ap_3, z_ap_6, z_a_level, z_a_slope6, z_hat_ap, z_hat_da, gap_days]

                if not np.all(np.isfinite(feats)):
                    continue

                P = _softmax(np.asarray([feats], dtype="float64") @ W)
                if P.size < 3:
                    continue
                pred = int(np.argmax(P[0]))
                score = float(_confidence_score(P)[0])
                z_true = float((a_all[i] - p_all[i]) / scale_ap)
                y = int(_label_z(z_true, float(eq_factor)))
                rows.append((int(dt_all[i].astype("int64")), y, pred, score))

            if not rows:
                continue
            rows.sort(key=lambda it: it[0])
            cut = int(len(rows) * 0.8)
            test_rows = rows[cut:]
            total = int(len(test_rows))
            if total < int(min_test_samples):
                continue
            sweep: list[dict[str, Any]] = []
            for th in thresholds:
                shown = [r for r in test_rows if float(r[3]) + 1e-12 >= float(th)]
                if len(shown) < int(min_shown_samples):
                    continue
                ok = sum(1 for _t, y, pred, _s in shown if int(pred) == int(y))
                n_shown = int(len(shown))
                sweep.append(
                    {
                        "th": float(th),
                        "acc": float(ok / n_shown) if n_shown else 0.0,
                        "n": int(n_shown),
                        "coverage": float(n_shown / total) if total else 0.0,
                    }
                )

            candidates = [
                r
                for r in sweep
                if float(r.get("acc") or 0.0) + 1e-12 >= float(target_min_acc)
                and float(r.get("coverage") or 0.0) + 1e-12 >= float(target_min_cov)
            ]
            if not candidates:
                continue
            chosen_th = min(float(r.get("th") or 0.0) for r in candidates)
            chosen_row = next((r for r in candidates if abs(float(r.get("th") or 0.0) - chosen_th) <= 1e-12), None)
            if not chosen_row:
                continue
            enabled[metric_key] = {
                "th": float(chosen_th),
                "acc": float(chosen_row.get("acc") or 0.0),
                "n": int(chosen_row.get("n") or 0),
                "coverage": float(chosen_row.get("coverage") or 0.0),
                "n_test": total,
            }
        return enabled

    metric_gates_wf = build_metric_gates_ap(
        require_forecast=True,
        W=W_wf,
        target_min_acc=0.80,
        target_min_cov=0.50,
        min_test_samples=18,
        min_shown_samples=10,
    )
    metric_gates_nf = build_metric_gates_ap(
        require_forecast=False,
        W=W_nf,
        target_min_acc=0.70,
        target_min_cov=0.25,
        min_test_samples=18,
        min_shown_samples=8,
    )

    # Evaluate relationship ("nowcast chain") predictor on no-forecast test samples, per metric.
    #
    # This is intentionally simple: we only apply it to metrics where it backtests well,
    # to avoid degrading the overall reliability for noisy series.
    #
    # Important: we calibrate it on *all* A-P releases (not just no-forecast), so it can
    # support high-importance macro metrics that often *do* have Forecast.
    def build_rel_samples() -> list[tuple[int, str, int]]:
        out: list[tuple[int, str, int]] = []
        grouped = df.groupby("metric_key", sort=False)
        for metric_key, g in grouped:
            g = g.sort_values("dt_utc").reset_index(drop=True)
            if len(g) < int(rel_min_metric_points):
                continue
            a_all = g["a"].to_numpy(dtype="float64")
            f_all = g["f"].to_numpy(dtype="float64")
            p_all = g["p"].to_numpy(dtype="float64")
            dt_all = g["dt_utc"].to_numpy(dtype="datetime64[ns]")

            scale_ap = _median_abs(a_all - p_all)

            for i in range(6, len(g)):
                if not np.isfinite(a_all[i]) or not np.isfinite(p_all[i]):
                    continue
                idxs = [i - 1, i - 2, i - 3, i - 4, i - 5, i - 6]
                if not np.all(np.isfinite(a_all[idxs])) or not np.all(np.isfinite(p_all[idxs])):
                    continue
                z_true = float((a_all[i] - p_all[i]) / scale_ap)
                y = int(_label_z(z_true, float(eq_factor)))
                out.append((int(dt_all[i].astype("int64")), str(metric_key), y))
        out.sort(key=lambda it: it[0])
        return out

    def rel_vote_predict(metric: str, t_ns: int) -> tuple[int, list[float], float] | None:
        rels = relationships_ap.get(metric) or []
        if not rels:
            return None
        votes = np.zeros(3, dtype="float64")
        used = 0
        recent_ns = int(rel_recent_days) * 24 * 3600 * 1_000_000_000
        for item in rels:
            src_key = str(item.get("metric") or "")
            kind = str(item.get("kind") or "ap").strip().lower()
            c = float(item.get("corr") or 0.0)
            if not src_key or not np.isfinite(c) or abs(c) <= 1e-12:
                continue
            src_s = (series_by_metric_af if kind == "af" else series_by_metric_ap).get(src_key)
            if not src_s:
                continue
            src_t = src_s.get("t", np.asarray([], dtype="int64"))
            src_z = src_s.get("z", np.asarray([], dtype="float64"))
            if src_t.size == 0 or src_t.size != src_z.size:
                continue
            j = int(np.searchsorted(src_t, np.int64(t_ns), side="left") - 1)
            if j < 0:
                continue
            age = int(t_ns) - int(src_t[j])
            if age < 0 or age > recent_ns:
                continue
            z_last = float(src_z[j])
            if not np.isfinite(z_last):
                continue
            lab = int(_label_z(z_last, float(eq_factor)))  # 0="=", 1=">", 2="<"
            if lab == 1 and c < 0:
                lab = 2
            elif lab == 2 and c < 0:
                lab = 1
            w = abs(c) * min(3.0, abs(z_last))
            votes[lab] += w
            used += 1
        if used <= 0 or float(votes.sum()) <= 0:
            return None
        probs = (votes / votes.sum()).astype("float64")
        pred = int(np.argmax(probs))
        # Confidence score aligned with the logistic model's gating:
        # score = maxProb * (maxProb - secondMaxProb)
        sorted_p = np.sort(probs)
        maxp = float(sorted_p[-1])
        second = float(sorted_p[-2]) if probs.size >= 2 else 0.0
        score = maxp * max(0.0, maxp - second)
        return pred, [float(probs[0]), float(probs[1]), float(probs[2])], float(score)

    rel_samples = build_rel_samples()
    rel_enabled: dict[str, dict[str, Any]] = {}
    rel_pred_rows: list[dict[str, Any]] = []
    if rel_samples:
        rel_cut = int(len(rel_samples) * 0.8)
        rel_test = rel_samples[rel_cut:]
        for t_ns, metric, y_true in rel_test:
            res = rel_vote_predict(metric, t_ns)
            if res is None:
                continue
            pred, probs, score = res
            rel_pred_rows.append({"metric": metric, "t": t_ns, "y": y_true, "pred": pred, "score": score})

        # Enable nowcast-chain per metric using a *per-metric* threshold picked from a small sweep.
        # This is much less strict than a single global gate and increases coverage without
        # making low-signal metrics spam predictions.
        by_metric_rows: dict[str, list[dict[str, Any]]] = {}
        for r in rel_pred_rows:
            m = str(r.get("metric") or "")
            if not m:
                continue
            by_metric_rows.setdefault(m, []).append(r)

        for metric, rows in by_metric_rows.items():
            total = int(len(rows))
            if total < int(rel_min_test_samples):
                continue
            sweep: list[dict[str, Any]] = []
            for th in thresholds:
                shown = [r for r in rows if float(r.get("score") or 0.0) + 1e-12 >= float(th)]
                if len(shown) < int(rel_min_shown_samples):
                    continue
                ok = sum(1 for r in shown if int(r.get("pred")) == int(r.get("y")))
                sweep.append(
                    {
                        "th": float(th),
                        "acc": float(ok / len(shown)),
                        "n": int(len(shown)),
                        "coverage": float(len(shown) / total),
                    }
                )

            # Pick the smallest threshold that reaches the target accuracy and coverage.
            candidates = [
                row
                for row in sweep
                if float(row.get("acc") or 0.0) + 1e-12 >= float(rel_target_min_acc)
                and float(row.get("coverage") or 0.0) + 1e-12 >= float(rel_target_min_cov)
            ]
            if not candidates:
                continue
            chosen_th = min(float(r.get("th") or 0.0) for r in candidates)
            chosen_row = next((r for r in candidates if abs(float(r.get("th") or 0.0) - chosen_th) <= 1e-12), None)
            if not chosen_row:
                continue
            rel_enabled[metric] = {
                "acc": float(chosen_row.get("acc") or 0.0),
                "n": int(chosen_row.get("n") or 0),
                "coverage": float(chosen_row.get("coverage") or 0.0),
                "th": float(chosen_th),
                "n_test": total,
            }

    # Recommend a confidence threshold for the enabled metrics so we only show "reasonably reliable" nowcasts.
    rel_th = 0.0
    rel_eval: dict[str, Any] = {"acc": 0.0, "n": 0, "confidence": "maxp*(maxp-second)", "thresholds": []}
    if rel_enabled and rel_pred_rows:
        # Build threshold sweep on enabled-metric predictions.
        enabled_set = set(rel_enabled.keys())
        enabled_rows = [r for r in rel_pred_rows if r.get("metric") in enabled_set]
        total_enabled = len(enabled_rows)
        if total_enabled:
            for th in thresholds:
                shown = [r for r in enabled_rows if float(r.get("score") or 0.0) + 1e-12 >= float(th)]
                if not shown:
                    continue
                ok = sum(1 for r in shown if int(r.get("pred")) == int(r.get("y")))
                rel_eval["thresholds"].append(
                    {"th": float(th), "acc": float(ok / len(shown)), "n": int(len(shown)), "coverage": float(len(shown) / total_enabled)}
                )
            # Target: >=75% accuracy with >=50% coverage on enabled metrics.
            rel_th = _pick_threshold(rel_eval.get("thresholds", []), min_acc=0.75, min_coverage=0.50)
            # Record raw stats at th=0 (if present in sweep).
            hit0 = next((r for r in rel_eval["thresholds"] if abs(float(r.get("th")) - float(thresholds[0])) <= 1e-9), None)
            if hit0:
                rel_eval["acc"] = float(hit0.get("acc") or 0.0)
                rel_eval["n"] = int(hit0.get("n") or 0)

    # Recommend thresholds to meet the UX goal:
    # - With-Forecast: aim for high coverage while keeping "shown" accuracy comfortably above random.
    # - No-Forecast: noisier; keep a stricter gate and let relationship-nowcast fill gaps.
    th_wf = _pick_threshold(eval_wf.get("thresholds", []), min_acc=0.75, min_coverage=0.78)
    # A-P without Forecast is noisy with a single global softmax model.
    # We keep the global gate effectively "off" and rely on:
    #   - per-metric gates for stable series, and/or
    #   - the relationship-based nowcast chain to fill gaps.
    #
    # The UI still shows the model probabilities, but marks most of them as low confidence.
    th_nf = 0.99
    # A-F is harder; pick a slightly looser gate so the UI can still show it often,
    # but keep a reliability hint so users can sanity-check.
    # A-F (Actual vs Forecast) is much harder and often low-confidence.
    # Keep a strict recommended threshold so the UI can treat it as "advisory"
    # and fall back to a simple recent-history baseline when the model isn't confident.
    th_af = 0.60

    payload: dict[str, Any] = {
        "schema": 1,
        "generated_at_utc": _utc_now_rfc3339(),
        "meta": {
            "currency": str(args.currency).upper(),
            "importance": [s.title() for s in args.importance],
            "eq_factor": eq_factor,
            "min_metric_points": int(args.min_metric_points),
            "relationships": {
                "kind": "actual_vs_previous",
                "source_kinds": ["ap", "af"],
                "min_metric_points": int(rel_min_metric_points),
                "min_test_samples": int(rel_min_test_samples),
                "min_shown_samples": int(rel_min_shown_samples),
                "target_min_acc": float(rel_target_min_acc),
                "target_min_cov": float(rel_target_min_cov),
                "lookback_days": int(rel_lookback_days),
                "recent_days": int(rel_recent_days),
                "topk": int(rel_topk),
                "min_abs_corr": float(rel_min_abs_corr),
                "min_pairs": int(rel_min_pairs),
            },
        },
        "classes": ["=", ">", "<"],
        "models": {
            "ap_with_forecast": {
                "task": "actual_vs_previous",
                "requires_forecast": True,
                "features": [
                    "bias",
                    "z_fp",
                    "z_ap_1",
                    "z_ap_3",
                    "z_ap_6",
                    "z_a_level",
                    "z_a_slope6",
                    "z_af_1",
                ],
                "weights": W_wf.tolist(),
                "recommended_threshold": th_wf,
                "metric_gates": {
                    "kind": "per_metric_threshold",
                    "target_min_acc": 0.80,
                    "target_min_cov": 0.50,
                    "min_test_samples": 30,
                    "min_shown_samples": 15,
                    "enabled_metrics": metric_gates_wf,
                },
                "eval": eval_wf,
            },
            "ap_no_forecast": {
                "task": "actual_vs_previous",
                "requires_forecast": False,
                "features": [
                    "bias",
                    "z_ap_1",
                    "z_ap_3",
                    "z_ap_6",
                    "z_a_level",
                    "z_a_slope6",
                    "z_hat_ap",
                    "z_hat_da",
                    "gap_days",
                ],
                "weights": W_nf.tolist(),
                "recommended_threshold": th_nf,
                "metric_gates": {
                    "kind": "per_metric_threshold",
                    "target_min_acc": 0.70,
                    "target_min_cov": 0.25,
                    "min_test_samples": 30,
                    "min_shown_samples": 12,
                    "enabled_metrics": metric_gates_nf,
                },
                "eval": eval_nf,
                "relationships": {
                    "by_metric": relationships_ap,
                    "predictor": {
                        "kind": "vote_last",
                        "confidence": "maxp*(maxp-second)",
                        "recommended_threshold": float(rel_th),
                        "enabled_metrics": rel_enabled,
                        "eval": rel_eval,
                    },
                },
            },
            "af_with_forecast": {
                "task": "actual_vs_forecast",
                "requires_forecast": True,
                "features": [
                    "bias",
                    "z_fp",
                    "z_ap_1",
                    "z_ap_3",
                    "z_ap_6",
                    "z_a_level",
                    "z_a_slope6",
                    "z_af_1",
                ],
                "weights": W_af.tolist(),
                "recommended_threshold": th_af,
                "eval": eval_af,
            },
        },
    }

    out_path = Path(args.out_json).expanduser().resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    # Write with LF so the JSON is stable across Windows/Linux checkouts.
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8", newline="\n")

    print(f"Wrote model: {out_path}")
    print("ap_with_forecast test:", json.dumps(eval_wf, ensure_ascii=False))
    print("ap_no_forecast test:", json.dumps(eval_nf, ensure_ascii=False))
    print("af_with_forecast test:", json.dumps(eval_af, ensure_ascii=False))
    print(f"Recommended thresholds: ap_with_forecast={th_wf:.2f} ap_no_forecast={th_nf:.2f} af_with_forecast={th_af:.2f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
