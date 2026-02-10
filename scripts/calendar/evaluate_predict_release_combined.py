"""
Evaluate Predict Release (A vs Previous) using the *same* ingredients the app can use:

  - Global softmax logistic models (with-forecast / no-forecast) from predict_release_model_usd.json
  - Optional relationship-based "nowcast chain" vote predictor (per-metric enabled + thresholds)

This script reports:
  - raw accuracy (always predicting) and confidence-gated accuracy/coverage
  - splits by: Forecast present / Forecast missing, and importance filter

No price data is required.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

from scripts.calendar.evaluate_predict_release_accuracy import _load_calendar_rows
from scripts.calendar.train_predict_release_model import _build_metric_af_series, _build_metric_ap_series, _label_z


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


def _softmax1d(scores: np.ndarray) -> np.ndarray:
    if scores.size == 0:
        return np.asarray([], dtype="float64")
    z = scores - float(np.max(scores))
    e = np.exp(z)
    denom = float(np.sum(e))
    if not np.isfinite(denom) or denom <= 0.0:
        return np.ones_like(scores, dtype="float64") / float(scores.size)
    return e / denom


def _dot_features(weights: np.ndarray, features: list[float]) -> np.ndarray:
    x = np.asarray(features, dtype="float64")
    d = min(int(x.size), int(weights.shape[0]))
    if d <= 0:
        return np.zeros((weights.shape[1],), dtype="float64")
    return x[:d] @ weights[:d, :]


def _slope(series: np.ndarray) -> float:
    y = np.asarray(series, dtype="float64")
    y = y[np.isfinite(y)]
    n = int(y.size)
    if n < 2:
        return 0.0
    x = np.arange(n, dtype="float64")
    sx = float(x.sum())
    sy = float(y.sum())
    sxx = float((x * x).sum())
    sxy = float((x * y).sum())
    denom = n * sxx - sx * sx
    if abs(denom) <= 1e-12:
        return 0.0
    return float((n * sxy - sx * sy) / denom)


def _linreg_next(series: np.ndarray) -> Optional[float]:
    y = np.asarray(series, dtype="float64")
    y = y[np.isfinite(y)]
    n = int(y.size)
    if n < 2:
        return None
    x = np.arange(n, dtype="float64")
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


@dataclass(frozen=True)
class SubModel:
    weights: np.ndarray
    threshold: float
    backtest_acc_at_th: float | None


@dataclass(frozen=True)
class Model:
    eq_factor: float
    ap_with_forecast: SubModel
    ap_no_forecast: SubModel
    model_gate_with_forecast: dict[str, dict[str, Any]]
    model_gate_no_forecast: dict[str, dict[str, Any]]
    relationships_by_metric: dict[str, list[dict[str, Any]]]
    nowcast_enabled: dict[str, dict[str, Any]]
    nowcast_global_th: float
    nowcast_recent_days: int


def _load_model(path: Path) -> Model:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if int(raw.get("schema") or 0) != 1:
        raise SystemExit("Unsupported model schema")
    meta = raw.get("meta") or {}
    eq_factor = float(meta.get("eq_factor") or 0.10)

    def _sub(key: str) -> SubModel:
        m = (raw.get("models") or {}).get(key) or {}
        w = np.asarray(m.get("weights") or [], dtype="float64")
        if w.ndim != 2 or w.shape[1] != 3 or w.shape[0] < 2:
            raise SystemExit(f"Invalid weights for {key}")
        th = float(m.get("recommended_threshold") or 0.0)
        bt = None
        try:
            rows = (m.get("eval") or {}).get("thresholds") or []
            for r in rows:
                if abs(float(r.get("th") or 0.0) - th) <= 1e-9:
                    acc = float(r.get("acc") or 0.0)
                    bt = acc if np.isfinite(acc) else None
                    break
        except Exception:
            bt = None
        return SubModel(weights=w, threshold=th, backtest_acc_at_th=bt)

    wf = _sub("ap_with_forecast")
    nf = _sub("ap_no_forecast")

    wf_gate = ((raw.get("models") or {}).get("ap_with_forecast") or {}).get("metric_gates") or {}
    wf_enabled = wf_gate.get("enabled_metrics") or {}
    if not isinstance(wf_enabled, dict):
        wf_enabled = {}

    nf_gate = ((raw.get("models") or {}).get("ap_no_forecast") or {}).get("metric_gates") or {}
    nf_enabled = nf_gate.get("enabled_metrics") or {}
    if not isinstance(nf_enabled, dict):
        nf_enabled = {}

    rel_root = ((raw.get("models") or {}).get("ap_no_forecast") or {}).get("relationships") or {}
    relationships_by_metric = rel_root.get("by_metric") or {}
    predictor = rel_root.get("predictor") or {}
    nowcast_enabled = predictor.get("enabled_metrics") or {}
    nowcast_global_th = float(predictor.get("recommended_threshold") or 0.10)
    rel_meta = meta.get("relationships") or {}
    nowcast_recent_days = int(rel_meta.get("recent_days") or 180)

    return Model(
        eq_factor=float(eq_factor),
        ap_with_forecast=wf,
        ap_no_forecast=nf,
        model_gate_with_forecast=wf_enabled,
        model_gate_no_forecast=nf_enabled,
        relationships_by_metric=relationships_by_metric,
        nowcast_enabled=nowcast_enabled,
        nowcast_global_th=float(nowcast_global_th),
        nowcast_recent_days=int(nowcast_recent_days),
    )


def _confidence_score(probs: np.ndarray) -> float:
    if probs.size < 3:
        return 0.0
    sp = np.sort(probs)
    maxp = float(sp[-1])
    second = float(sp[-2])
    return float(maxp * max(0.0, maxp - second))


def _predict_model_ap(
    *,
    sub: SubModel,
    threshold: float,
    eq_factor: float,
    a_hist: np.ndarray,
    p_hist: np.ndarray,
    f_hist: np.ndarray,
    dt_hist_ns: np.ndarray,
    i: int,
) -> Optional[tuple[int, np.ndarray, float, bool]]:
    # Build features from past-only history (needs last 6 valid A/P points).
    if i < 6:
        return None
    if not (np.isfinite(a_hist[i]) and np.isfinite(p_hist[i])):
        return None

    # Per-metric robust scales (computed from full series, same as the trainer/app).
    scale_ap = _median_abs(a_hist - p_hist)
    dif_fp = (f_hist - p_hist)[np.isfinite(f_hist) & np.isfinite(p_hist)]
    scale_fp = _median_abs(dif_fp) if dif_fp.size else 1.0
    dif_af = (a_hist - f_hist)[np.isfinite(a_hist) & np.isfinite(f_hist)]
    scale_af = _median_abs(dif_af) if dif_af.size else 1.0
    med_a, mad_a = _robust_loc_scale(a_hist)

    # Past indices with finite A/P.
    idxs: list[int] = []
    j = i - 1
    while j >= 0 and len(idxs) < 6:
        if np.isfinite(a_hist[j]) and np.isfinite(p_hist[j]):
            idxs.append(j)
        j -= 1
    if len(idxs) < 6:
        return None
    idxs = list(reversed(idxs))

    a6 = a_hist[idxs].astype("float64")
    p6 = p_hist[idxs].astype("float64")
    dif6 = (a6 - p6).astype("float64")
    dif3 = dif6[-3:]

    z_ap_1 = float(dif6[-1] / scale_ap)
    z_ap_3 = float(np.mean(dif3) / scale_ap)
    z_ap_6 = float(np.mean(dif6) / scale_ap)
    z_a_level = float((a6[-1] - med_a) / mad_a)
    z_a_slope6 = float(_slope(a6) / scale_ap)

    # Last surprise (A-F) from a past release if available.
    z_af_1 = 0.0
    k = i - 1
    while k >= 0:
        if np.isfinite(a_hist[k]) and np.isfinite(f_hist[k]):
            z_af_1 = float((float(a_hist[k]) - float(f_hist[k])) / scale_af)
            break
        k -= 1

    has_forecast0 = np.isfinite(f_hist[i]) and np.isfinite(p_hist[i])
    if has_forecast0:
        z_fp = float((float(f_hist[i]) - float(p_hist[i])) / scale_fp) if scale_fp > 0 else 0.0
        feats = [1.0, z_fp, z_ap_1, z_ap_3, z_ap_6, z_a_level, z_a_slope6, z_af_1]
    else:
        last_t = int(dt_hist_ns[idxs[-1]])
        gap_days = float((int(dt_hist_ns[i]) - last_t) / (86_400_000_000_000.0))
        a_hat = _linreg_next(a6)
        z_hat_ap = float((float(a_hat) - float(p_hist[i])) / scale_ap) if a_hat is not None else 0.0
        z_hat_da = float((float(a_hat) - float(a6[-1])) / scale_ap) if a_hat is not None else 0.0
        feats = [1.0, z_ap_1, z_ap_3, z_ap_6, z_a_level, z_a_slope6, z_hat_ap, z_hat_da, gap_days]

    scores = _dot_features(sub.weights, feats)
    probs = _softmax1d(scores)
    pred = int(np.argmax(probs))
    score = _confidence_score(probs)
    reliable = score + 1e-12 >= float(threshold)
    return pred, probs, float(score), bool(reliable)


def _rel_vote_predict(
    metric: str,
    t_ns: int,
    *,
    relationships_by_metric: dict[str, list[dict[str, Any]]],
    series_by_metric_ap: dict[str, dict[str, Any]],
    series_by_metric_af: dict[str, dict[str, Any]],
    eq_factor: float,
    recent_ns: int,
) -> Optional[tuple[int, np.ndarray, float]]:
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
    score = _confidence_score(probs)
    return pred, probs, float(score)


@dataclass
class Meter:
    total: int = 0
    correct: int = 0

    def add(self, ok: bool) -> None:
        self.total += 1
        self.correct += 1 if ok else 0

    def acc(self) -> float:
        return (self.correct / self.total) if self.total else 0.0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--calendar-dir", type=Path, default=Path("data/Economic_Calendar"))
    ap.add_argument("--model-json", type=Path, default=Path("data/analysis/predict_release_model_usd.json"))
    ap.add_argument("--currency", type=str, default="USD")
    ap.add_argument("--importance", nargs="*", default=["Medium", "High"])
    ap.add_argument("--time-split", type=float, default=0.8, help="Train/test split ratio by time (default 0.8).")
    args = ap.parse_args()

    model = _load_model(Path(args.model_json))
    eq_factor = float(model.eq_factor)
    recent_ns = int(model.nowcast_recent_days) * 24 * 3600 * 1_000_000_000

    df = _load_calendar_rows(Path(args.calendar_dir))
    df = df[(df["currency"] == str(args.currency).upper()) & (df["importance"].isin([s.title() for s in args.importance]))].copy()
    if df.empty:
        print("No calendar rows after filtering.")
        return 1

    series_by_metric_ap = _build_metric_ap_series(df)
    series_by_metric_af = _build_metric_af_series(df)

    # Build per-metric arrays for feature computation + labels.
    grouped = df.groupby("metric_key", sort=False)
    samples: list[tuple[int, str, int, bool]] = []
    for metric_key, g in grouped:
        metric_key = str(metric_key)
        g = g.sort_values("dt_utc").reset_index(drop=True)
        a = g["a"].to_numpy(dtype="float64")
        f = g["f"].to_numpy(dtype="float64")
        p = g["p"].to_numpy(dtype="float64")
        t_ns = g["dt_utc"].to_numpy(dtype="datetime64[ns]").astype("int64")
        scale_ap = _median_abs(a - p)
        if not np.isfinite(scale_ap) or scale_ap <= 1e-12:
            scale_ap = 1.0
        for i in range(6, len(g)):
            if not (np.isfinite(a[i]) and np.isfinite(p[i])):
                continue
            back = [i - 1, i - 2, i - 3, i - 4, i - 5, i - 6]
            if not np.all(np.isfinite(a[back])) or not np.all(np.isfinite(p[back])):
                continue
            z_true = float((a[i] - p[i]) / float(scale_ap))
            y = int(_label_z(z_true, float(eq_factor)))
            has_f = bool(np.isfinite(f[i]) and np.isfinite(p[i]))
            samples.append((int(t_ns[i]), metric_key, y, has_f))

    samples.sort(key=lambda it: it[0])
    cut = int(len(samples) * float(args.time_split))
    test = samples[cut:]

    # Meters
    model_all = Meter()
    model_rel = Meter()
    now_all = Meter()
    now_rel = Meter()
    combined_all = Meter()
    combined_rel = Meter()

    # Split by forecast availability (in the target release)
    comb_wf = Meter()
    comb_nf = Meter()
    comb_wf_rel = Meter()
    comb_nf_rel = Meter()

    # Build a lookup for per-metric raw arrays (to compute model features).
    by_metric_arrays: dict[str, tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]] = {}
    for metric_key, g in grouped:
        metric_key = str(metric_key)
        g = g.sort_values("dt_utc").reset_index(drop=True)
        by_metric_arrays[metric_key] = (
            g["a"].to_numpy(dtype="float64"),
            g["p"].to_numpy(dtype="float64"),
            g["f"].to_numpy(dtype="float64"),
            g["dt_utc"].to_numpy(dtype="datetime64[ns]").astype("int64"),
        )

    for t_ns, metric, y_true, has_f in test:
        arr = by_metric_arrays.get(metric)
        if arr is None:
            continue
        a_hist, p_hist, f_hist, dt_hist_ns = arr
        # Find the matching index i in the metric series.
        i = int(np.searchsorted(dt_hist_ns, np.int64(t_ns), side="left"))
        if i >= dt_hist_ns.size or int(dt_hist_ns[i]) != int(t_ns):
            continue

        sub = model.ap_with_forecast if bool(has_f) else model.ap_no_forecast
        gate_map = model.model_gate_with_forecast if bool(has_f) else model.model_gate_no_forecast
        gate_cfg = gate_map.get(metric) if isinstance(gate_map, dict) else None
        th_raw = gate_cfg.get("th", None) if isinstance(gate_cfg, dict) else None
        m_th = (
            float(th_raw)
            if isinstance(th_raw, (int, float)) and np.isfinite(float(th_raw))
            else float(sub.threshold)
        )
        mod_acc = None
        acc_raw = gate_cfg.get("acc", None) if isinstance(gate_cfg, dict) else None
        if isinstance(acc_raw, (int, float)) and np.isfinite(float(acc_raw)):
            mod_acc = float(acc_raw)
        elif isinstance(sub.backtest_acc_at_th, (int, float)) and np.isfinite(float(sub.backtest_acc_at_th)):
            mod_acc = float(sub.backtest_acc_at_th)

        m_pred = _predict_model_ap(
            sub=sub,
            threshold=m_th,
            eq_factor=eq_factor,
            a_hist=a_hist,
            p_hist=p_hist,
            f_hist=f_hist,
            dt_hist_ns=dt_hist_ns,
            i=i,
        )
        if m_pred is None:
            continue
        mp, mprobs, mscore, mrel = m_pred
        model_all.add(bool(mp == y_true))
        if mrel:
            model_rel.add(bool(mp == y_true))

        # Nowcast chain (only if enabled for the metric).
        nc_pred: Optional[tuple[int, np.ndarray, float, bool]] = None
        cfg = model.nowcast_enabled.get(metric)
        if isinstance(cfg, dict):
            th_raw = cfg.get("th", None) if isinstance(cfg, dict) else None
            th = (
                float(th_raw)
                if isinstance(th_raw, (int, float)) and np.isfinite(float(th_raw))
                else float(model.nowcast_global_th)
            )
            res = _rel_vote_predict(
                metric,
                int(t_ns),
                relationships_by_metric=model.relationships_by_metric,
                series_by_metric_ap=series_by_metric_ap,
                series_by_metric_af=series_by_metric_af,
                eq_factor=eq_factor,
                recent_ns=int(recent_ns),
            )
            if res is not None:
                npred, nprobs, nscore = res
                nrel = bool(float(nscore) + 1e-12 >= float(th))
                now_all.add(bool(npred == y_true))
                if nrel:
                    now_rel.add(bool(npred == y_true))
                nc_pred = (npred, nprobs, nscore, nrel)

        # Combined selection (app-style): use nowcast to fill gaps only.
        #
        # We intentionally do NOT override a reliable model prediction with nowcast, because:
        #  - the model already conditions on Forecast/Previous and the metric's own recent history
        #  - per-metric nowcast backtests can be optimistic on short test segments
        # This keeps the combined output stable and avoids "flip-flopping" sources.
        final_pred = mp
        final_rel = bool(mrel)
        if nc_pred is not None and bool(nc_pred[3]):
            if bool(has_f):
                # With-Forecast: only use nowcast to fill gaps.
                if not bool(mrel):
                    final_pred = int(nc_pred[0])
                    final_rel = True
            else:
                # No-Forecast: allow nowcast to override the weaker model when it is reliable
                # and has good per-metric backtest performance.
                now_acc = float((model.nowcast_enabled.get(metric) or {}).get("acc") or 0.0)
                mod_acc2 = float(mod_acc) if mod_acc is not None else 0.0
                if (not bool(mrel)) or (now_acc + 1e-12 >= mod_acc2 + 1e-12):
                    final_pred = int(nc_pred[0])
                    final_rel = True

        combined_all.add(bool(final_pred == y_true))
        if final_rel:
            combined_rel.add(bool(final_pred == y_true))

        if bool(has_f):
            comb_wf.add(bool(final_pred == y_true))
            if final_rel:
                comb_wf_rel.add(bool(final_pred == y_true))
        else:
            comb_nf.add(bool(final_pred == y_true))
            if final_rel:
                comb_nf_rel.add(bool(final_pred == y_true))

    print("Predict Release combined evaluation (A vs Previous; time-split 80/20)")
    print(f"currency={str(args.currency).upper()} importance={','.join([s.title() for s in args.importance])} eq_factor={eq_factor:.2f}")
    print(f"model: withF_th={model.ap_with_forecast.threshold:.2f} noF_th={model.ap_no_forecast.threshold:.2f}")
    print(f"nowcast: enabled_metrics={len(model.nowcast_enabled)} recent_days={model.nowcast_recent_days} global_th={model.nowcast_global_th:.2f}")
    print("")
    print(f"MODEL(raw):      acc={model_all.acc():.3f} n={model_all.total}")
    print(f"MODEL(reliable): acc={model_rel.acc():.3f} n={model_rel.total}")
    print(f"NOWCAST(raw):    acc={now_all.acc():.3f} n={now_all.total}")
    print(f"NOWCAST(reliable): acc={now_rel.acc():.3f} n={now_rel.total}")
    print("")
    print(f"COMBINED(raw):      acc={combined_all.acc():.3f} n={combined_all.total}")
    print(f"COMBINED(reliable): acc={combined_rel.acc():.3f} n={combined_rel.total}")
    print("")
    print(f"COMBINED with Forecast:      acc={comb_wf.acc():.3f} n={comb_wf.total}")
    print(f"COMBINED with Forecast (rel): acc={comb_wf_rel.acc():.3f} n={comb_wf_rel.total}")
    print(f"COMBINED no Forecast:        acc={comb_nf.acc():.3f} n={comb_nf.total}")
    print(f"COMBINED no Forecast (rel):   acc={comb_nf_rel.acc():.3f} n={comb_nf_rel.total}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
