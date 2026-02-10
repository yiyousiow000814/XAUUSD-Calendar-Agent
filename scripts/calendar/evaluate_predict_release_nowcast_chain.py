"""
Evaluate the relationship-based "nowcast chain" used by Predict Release (no-forecast fallback).

This mirrors the desktop app logic:
  - Task: predict (Actual - Previous) direction in {>,=,<} for releases where Forecast is missing.
  - Use a learned relationship graph (top-K correlated metrics) stored in the model JSON.
  - At each target release time, sample each source metric's most recent (A-P) z-signal
    within a recent window, apply a weighted vote, then confidence-gate the result.

No price data is used.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Optional

import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

from scripts.calendar.evaluate_predict_release_accuracy import _load_calendar_rows
from scripts.calendar.train_predict_release_model import _build_metric_af_series, _build_metric_ap_series, _label_z


def _rel_vote_predict(
    metric: str,
    t_ns: int,
    *,
    relationships_by_metric: dict[str, list[dict[str, Any]]],
    series_by_metric_ap: dict[str, dict[str, Any]],
    series_by_metric_af: dict[str, dict[str, Any]],
    eq_factor: float,
    recent_ns: int,
) -> Optional[tuple[int, float]]:
    rels = relationships_by_metric.get(metric) or []
    if not rels:
        return None

    votes = np.zeros(3, dtype="float64")
    used = 0


    for item in rels:
        src_key = str(item.get("metric") or "").strip()
        kind = str(item.get("kind") or "ap").strip().lower()
        c = float(item.get("corr") or 0.0)
        if not src_key or not np.isfinite(c) or abs(c) <= 1e-12:
            continue

        src_s = (series_by_metric_af if kind == "af" else series_by_metric_ap).get(src_key) or {}
        src_t = np.asarray(src_s.get("t", np.asarray([], dtype="int64")), dtype="int64")
        src_z = np.asarray(src_s.get("z", np.asarray([], dtype="float64")), dtype="float64")
        if src_t.size == 0 or src_t.size != src_z.size:
            continue

        j = int(np.searchsorted(src_t, np.int64(t_ns), side="left") - 1)
        if j < 0:
            continue
        age = int(t_ns) - int(src_t[j])
        if age < 0 or age > int(recent_ns):
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
        if not np.isfinite(w) or w <= 0:
            continue

        votes[lab] += w
        used += 1

    if used <= 0 or not (float(votes.sum()) > 0):
        return None

    probs = (votes / float(votes.sum())).astype("float64")
    pred = int(np.argmax(probs))

    # Confidence score aligned with the app/trainer:
    # score = maxProb * (maxProb - secondMaxProb)
    sp = np.sort(probs)
    maxp = float(sp[-1])
    second = float(sp[-2]) if probs.size >= 2 else 0.0
    score = maxp * max(0.0, maxp - second)
    return pred, float(score)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--calendar-dir", type=Path, default=Path("data/Economic_Calendar"))
    ap.add_argument("--currency", type=str, default="USD")
    ap.add_argument("--importance", nargs="*", default=["Medium", "High"])
    ap.add_argument("--model-json", type=Path, default=Path("data/analysis/predict_release_model_usd.json"))
    args = ap.parse_args()

    model = json.loads(args.model_json.read_text(encoding="utf-8"))
    if int(model.get("schema") or 0) != 1:
        raise SystemExit("Unsupported model schema.")

    meta = model.get("meta") or {}
    eq_factor = float(meta.get("eq_factor") or 0.10)

    rel_meta = meta.get("relationships") or {}
    recent_days = int(rel_meta.get("recent_days") or 180)
    recent_ns = int(recent_days) * 24 * 3600 * 1_000_000_000

    nf = (model.get("models") or {}).get("ap_no_forecast") or {}
    rel_root = nf.get("relationships") or {}
    relationships_by_metric = rel_root.get("by_metric") or {}
    predictor = rel_root.get("predictor") or {}
    enabled = predictor.get("enabled_metrics") or {}
    global_th = float(predictor.get("recommended_threshold") or 0.10)

    df = _load_calendar_rows(Path(args.calendar_dir))
    df = df[
        (df["currency"] == str(args.currency).upper())
        & (df["importance"].isin([s.title() for s in args.importance]))
    ].copy()
    if df.empty:
        print("No calendar rows after filtering.")
        return 1

    series_by_metric_ap = _build_metric_ap_series(df)
    series_by_metric_af = _build_metric_af_series(df)

    # Build no-forecast samples (needs 6 past points for z history).
    samples: list[tuple[int, str, int]] = []
    for metric_key, g in df.groupby("metric_key", sort=False):
        metric_key = str(metric_key)
        g = g.sort_values("dt_utc").reset_index(drop=True)
        a = g["a"].to_numpy(dtype="float64")
        f = g["f"].to_numpy(dtype="float64")
        p = g["p"].to_numpy(dtype="float64")
        dt = g["dt_utc"].to_numpy(dtype="datetime64[ns]")

        s = series_by_metric_ap.get(metric_key) or {}
        scale_ap = float(s.get("scale_ap") or 1.0)
        if not np.isfinite(scale_ap) or scale_ap <= 1e-12:
            scale_ap = 1.0

        for i in range(6, len(g)):
            if not (np.isfinite(a[i]) and np.isfinite(p[i])):
                continue
            if np.isfinite(f[i]):
                continue
            back = [i - 1, i - 2, i - 3, i - 4, i - 5, i - 6]
            if not np.all(np.isfinite(a[back])) or not np.all(np.isfinite(p[back])):
                continue
            z_true = float((a[i] - p[i]) / scale_ap)
            y = int(_label_z(z_true, float(eq_factor)))
            t_ns = int(dt[i].astype("int64"))
            samples.append((t_ns, metric_key, y))

    samples.sort(key=lambda it: it[0])
    cut = int(len(samples) * 0.8)
    test = samples[cut:]

    total = 0
    enabled_total = 0
    shown = 0
    ok = 0

    for t_ns, metric, y_true in test:
        total += 1
        cfg = enabled.get(metric)
        if not isinstance(cfg, dict):
            continue
        enabled_total += 1

        th = float(cfg.get("th") or global_th)
        res = _rel_vote_predict(
            metric,
            t_ns,
            relationships_by_metric=relationships_by_metric,
            series_by_metric_ap=series_by_metric_ap,
            series_by_metric_af=series_by_metric_af,
            eq_factor=float(eq_factor),
            recent_ns=int(recent_ns),
        )
        if res is None:
            continue
        pred, score = res
        if float(score) + 1e-12 < float(th):
            continue
        shown += 1
        ok += 1 if int(pred) == int(y_true) else 0

    print("Predict Release nowcast chain (no-forecast; time-split 80/20 on all samples):")
    print(f"currency={str(args.currency).upper()} importance={','.join([s.title() for s in args.importance])}")
    print(f"enabled_metrics={len(enabled)} recent_days={recent_days} eq_factor={eq_factor:.2f}")
    print(f"test_samples={total} enabled_metric_samples={enabled_total} enabled_share={(enabled_total/total if total else 0.0):.3f}")
    print(f"shown={shown} coverage={(shown/total if total else 0.0):.3f} acc={(ok/shown if shown else 0.0):.3f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
