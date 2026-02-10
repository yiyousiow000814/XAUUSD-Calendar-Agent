"""
Estimate the upper bound ("ceiling") of Predict Release for metrics that lack Forecast.

Why this script exists
----------------------
Users often ask for a target like:
  - show predictions for >=70% of events, with >=75% accuracy

For releases without Forecast, our only structured signal is the metric's own history
in Economic_Calendar. This script answers a concrete question with reproducible numbers:

  "Even if we train a dedicated per-metric model (no cross-metric signals),
   can no-forecast releases reach 75%+ accuracy?"

Method
------
- Filter calendar rows by currency + importance
- For each metric_key:
  - keep only releases where Actual and Previous are numeric AND Forecast is missing
  - build samples using only past information (last 6 releases)
  - train a tiny multinomial (3-way) logistic regression for that metric only
  - evaluate on the last 20% releases (walk-forward split by time)

No price data is used.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path
import sys

import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

from scripts.calendar.evaluate_predict_release_accuracy import _load_calendar_rows


def _softmax(scores: np.ndarray) -> np.ndarray:
    scores = scores - np.max(scores, axis=1, keepdims=True)
    e = np.exp(scores)
    return e / np.sum(e, axis=1, keepdims=True)


def _train_softmax(
    X: np.ndarray,
    y: np.ndarray,
    *,
    l2: float = 3e-2,
    lr: float = 0.05,
    iters: int = 2500,
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
    # stable mapping: 0="=", 1=">", 2="<"
    if abs(z) <= float(eq_factor):
        return 0
    return 1 if z > 0 else 2


@dataclass(frozen=True)
class MetricResult:
    metric_key: str
    n_test: int
    acc: float


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--calendar-dir", type=Path, default=Path("data/Economic_Calendar"))
    ap.add_argument("--currency", type=str, default="USD")
    ap.add_argument("--importance", nargs="*", default=["Medium", "High"])
    ap.add_argument("--eq-factor", type=float, default=0.10)
    ap.add_argument("--min-samples", type=int, default=120, help="Minimum no-forecast samples per metric to include.")
    ap.add_argument("--top", type=int, default=20)
    args = ap.parse_args()

    df = _load_calendar_rows(Path(args.calendar_dir))
    df = df[(df["currency"] == str(args.currency).upper()) & (df["importance"].isin([s.title() for s in args.importance]))].copy()
    if df.empty:
        print("No calendar rows after filtering.")
        return 1

    eq_factor = float(args.eq_factor)
    results: list[MetricResult] = []

    for metric_key, g in df.groupby("metric_key", sort=False):
        g = g.sort_values("dt_utc").reset_index(drop=True)
        a = g["a"].to_numpy(dtype="float64")
        f = g["f"].to_numpy(dtype="float64")
        p = g["p"].to_numpy(dtype="float64")
        dt = g["dt_utc"].to_numpy(dtype="datetime64[ns]")

        # valid indices for no-forecast releases (needs 6 past points).
        idx: list[int] = []
        for i in range(6, len(g)):
            if not (np.isfinite(a[i]) and np.isfinite(p[i])):
                continue
            if np.isfinite(f[i]):
                continue
            back = [i - 1, i - 2, i - 3, i - 4, i - 5, i - 6]
            if not np.all(np.isfinite(a[back])) or not np.all(np.isfinite(p[back])):
                continue
            idx.append(i)

        if len(idx) < int(args.min_samples):
            continue

        cut = int(len(idx) * 0.8)
        train_idx = idx[:cut]
        test_idx = idx[cut:]
        if len(test_idx) < 20:
            continue

        # Scales from TRAIN only (avoid leakage).
        scale_ap = _median_abs(a[train_idx] - p[train_idx])
        med_a, mad_a = _robust_loc_scale(a[np.isfinite(a)])

        def feats(i: int) -> np.ndarray:
            z_ap_1 = float((a[i - 1] - p[i - 1]) / scale_ap)
            z_ap_3 = float(np.mean((a[i - 3 : i] - p[i - 3 : i]) / scale_ap))
            z_ap_6 = float(np.mean((a[i - 6 : i] - p[i - 6 : i]) / scale_ap))
            z_a_level = float((a[i - 1] - med_a) / mad_a)
            z_a_slope6 = float(_slope(a[i - 6 : i]) / scale_ap)
            a_hat = _linreg_next(a[i - 6 : i])
            z_hat_ap = float((a_hat - p[i]) / scale_ap) if a_hat is not None else 0.0
            z_hat_da = float((a_hat - a[i - 1]) / scale_ap) if a_hat is not None else 0.0
            gap_days = float((dt[i] - dt[i - 1]).astype("timedelta64[D]").astype(int))
            return np.asarray(
                [1.0, z_ap_1, z_ap_3, z_ap_6, z_a_level, z_a_slope6, z_hat_ap, z_hat_da, gap_days], dtype=float
            )

        def lab(i: int) -> int:
            z_true = float((a[i] - p[i]) / scale_ap)
            return _label_z(z_true, eq_factor)

        X_train = np.vstack([feats(i) for i in train_idx])
        y_train = np.asarray([lab(i) for i in train_idx], dtype="int64")
        X_test = np.vstack([feats(i) for i in test_idx])
        y_test = np.asarray([lab(i) for i in test_idx], dtype="int64")

        W = _train_softmax(X_train, y_train)
        P = _softmax(X_test @ W)
        pred = np.argmax(P, axis=1)
        acc = float(np.mean(pred == y_test)) if y_test.size else 0.0
        results.append(MetricResult(metric_key=str(metric_key), n_test=int(y_test.size), acc=acc))

    results.sort(key=lambda r: (r.acc, r.n_test), reverse=True)

    print("No-forecast per-metric ceiling (Actual vs Previous; 3-way):")
    print(f"currency={str(args.currency).upper()} importance={','.join([s.title() for s in args.importance])} eq_factor={eq_factor:.2f}")
    print(f"metrics_trained={len(results)}")
    print("")
    for r in results[: int(args.top)]:
        print(f"{r.metric_key:40s} n_test={r.n_test:4d} acc={r.acc:.3f}")
    print("")
    hits = [r for r in results if r.acc >= 0.75]
    print(f"metrics_with_acc>=0.75: {len(hits)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
