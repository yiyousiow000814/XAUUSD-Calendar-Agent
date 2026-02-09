"""Export Stage A/B/C calendar outputs into xauusd_event_deep_analysis_usd.json (schema=1).

Key goals:
1) Use the *same* eventId keys as the desktop app (CUR::Metric::freq_token).
2) Keep the JSON small enough to commit to GitHub (no per-release instance blobs).
3) Surface Stage B/C signals (preheat/trend/components/path/priority/uncertainty) as a
   first-class, reproducible deep JSON source for Deep Analysis.

Missing Stage outputs are tolerated (the app still has a runtime fallback unified outlook).
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import pandas as pd

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

from scripts.calendar.table_io import read_table  # noqa: E402


DEFAULT_ALIGNMENT_PATH = Path(
    "data/calendar_outputs/event_price_alignment/event_price_alignment.parquet"
)

MONTH_ALIASES: dict[str, str] = {
    "january": "jan",
    "february": "feb",
    "march": "mar",
    "april": "apr",
    "june": "jun",
    "july": "jul",
    "august": "aug",
    "sept": "sep",
    "september": "sep",
    "october": "oct",
    "november": "nov",
    "december": "dec",
}

MONTHS: set[str] = {
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


@dataclass(frozen=True)
class Paths:
    alignment: Path
    preheat_summary: Path
    trend_summary: Path
    component_breakdown: Path
    path_summary: Path
    priority_scores: Path
    priority_rules: Path
    uncertainty_intervals: Path
    uncertainty_event_predictions: Path


def _utc_now_rfc3339() -> str:
    return datetime.now(timezone.utc).isoformat()


def _read_table_if_exists(path: Path, *, parse_dates: tuple[str, ...] = ()) -> Optional[pd.DataFrame]:
    path = Path(path)
    if not path.exists():
        return None
    df = read_table(path, parse_dates=parse_dates)
    if df is None or getattr(df, "empty", True):
        return None
    return df


def _normalize_period(raw: str) -> str:
    token = str(raw or "").strip()
    if not token:
        return ""
    lowered = token.lower().replace(".", "")
    if lowered in MONTHS:
        return lowered
    if lowered in MONTH_ALIASES:
        return MONTH_ALIASES[lowered]
    if len(lowered) == 2 and lowered[0] in {"q", "h"} and lowered[1].isdigit():
        return lowered
    return lowered


def _looks_like_period(token: str) -> bool:
    normalized = _normalize_period(token)
    if not normalized:
        return False
    if normalized in MONTHS:
        return True
    if len(normalized) == 2 and normalized[0] in {"q", "h"} and normalized[1].isdigit():
        return True
    return False


def _detect_frequency(raw: str) -> str:
    lowered = str(raw or "").lower()
    if "y/y" in lowered or "yoy" in lowered:
        return "y/y"
    if "m/m" in lowered or "mom" in lowered:
        return "m/m"
    if "q/q" in lowered or "qoq" in lowered:
        return "q/q"
    if "w/w" in lowered or "wow" in lowered:
        return "w/w"
    return ""


def _strip_known_suffixes(raw: str) -> str:
    trimmed = str(raw or "").strip()
    while True:
        end = trimmed.rstrip()
        if not end.endswith(")"):
            break
        open_idx = end.rfind("(")
        if open_idx < 0:
            break
        token = end[open_idx + 1 : len(end) - 1].strip()
        normalized = token.lower().replace(".", "")
        is_freq = any(
            k in normalized
            for k in (
                "y/y",
                "yoy",
                "m/m",
                "mom",
                "q/q",
                "qoq",
                "w/w",
                "wow",
            )
        )
        if _looks_like_period(token) or is_freq:
            trimmed = end[:open_idx].rstrip()
            continue
        break
    return trimmed


def build_app_event_id(currency: str, event_name: str) -> tuple[str, str, str]:
    """Match the Rust get_event_history() build_event_id() output."""
    cur = (currency or "").strip().upper()
    if not cur or cur in {"--", "-"}:
        cur = "NA"
    raw = (event_name or "").strip()
    frequency = _detect_frequency(raw)
    metric = " ".join(_strip_known_suffixes(raw).split()).replace("::", " ").strip()
    freq_token = frequency if frequency else "none"
    return f"{cur}::{metric}::{freq_token}", metric, frequency


def _safe_float(value: Any) -> Optional[float]:
    try:
        if value is None or pd.isna(value):
            return None
        out = float(value)
        if out != out:  # nan
            return None
        return out
    except Exception:
        return None


def _p_gt(a: pd.Series, b: pd.Series) -> tuple[Optional[float], int]:
    mask = (~a.isna()) & (~b.isna())
    if mask.sum() <= 0:
        return None, 0
    aa = a[mask].astype(float)
    bb = b[mask].astype(float)
    usable = aa != bb
    if usable.sum() <= 0:
        return 0.0, int(mask.sum())
    return float((aa[usable] > bb[usable]).mean()), int(mask.sum())


def _build_predict_release(alignment: pd.DataFrame) -> dict[str, Any]:
    out: dict[str, Any] = {}
    a = alignment.get("actual_value")
    f = alignment.get("forecast_value")
    p = alignment.get("previous_value")
    if a is None:
        return out
    if f is not None:
        prob, n = _p_gt(a, f)
        out["actualGtForecast"] = {"p": prob, "n": n}
    if p is not None:
        prob, n = _p_gt(a, p)
        out["actualGtPrevious"] = {"p": prob, "n": n}
    return out


def _signals_used(payload: dict[str, Any]) -> list[dict[str, Any]]:
    used: list[dict[str, Any]] = []
    signals = payload.get("signals") if isinstance(payload.get("signals"), dict) else {}
    if "preheat" in signals:
        used.append({"id": "preheat", "title": "Preheat (early move) monitor"})
    if "trend" in signals:
        used.append({"id": "trend", "title": "Indicator trend & seasonality"})
    if "components" in signals:
        used.append({"id": "components", "title": "Component decomposition"})
    if "pathDependency" in signals:
        used.append({"id": "path_dependency", "title": "Path dependency"})
    if "priorityRouting" in signals:
        used.append({"id": "priority_routing", "title": "Priority routing"})
    if "uncertainty" in signals:
        used.append({"id": "uncertainty", "title": "Uncertainty & calibration"})
    return used


def build_deep_analysis_json(currency: str, alignment: pd.DataFrame, paths: Paths) -> dict[str, Any]:
    preheat_summary = _read_table_if_exists(paths.preheat_summary)
    trend_summary = _read_table_if_exists(paths.trend_summary)
    component_breakdown = _read_table_if_exists(paths.component_breakdown)
    path_summary = _read_table_if_exists(paths.path_summary)
    priority_scores = _read_table_if_exists(paths.priority_scores, parse_dates=("event_time",))
    priority_rules = None
    if Path(paths.priority_rules).exists():
        try:
            priority_rules = json.loads(Path(paths.priority_rules).read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            priority_rules = None
    uncertainty_intervals = _read_table_if_exists(paths.uncertainty_intervals)
    uncertainty_event_predictions = _read_table_if_exists(paths.uncertainty_event_predictions)

    df = alignment.copy()
    if "currency" in df.columns:
        df = df[df["currency"].astype(str).str.upper() == currency.upper()]
    if df.empty:
        raise SystemExit(f"No rows for currency={currency} in {paths.alignment}")

    required_cols = {"event_id", "event_name", "currency"}
    missing = required_cols - set(df.columns)
    if missing:
        raise SystemExit(f"Alignment parquet missing required columns: {sorted(missing)}")

    # Stage event_id -> app_event_id, and raw event_name -> app_event_id.
    stage_to_app: dict[str, str] = {}
    name_to_app: dict[str, str] = {}
    for row in df[["event_id", "event_name", "currency"]].itertuples(index=False):
        app_id, _, _ = build_app_event_id(str(row.currency), str(row.event_name))
        stage_to_app[str(row.event_id)] = app_id
        name_to_app[str(row.event_name)] = app_id

    # Preheat summary is keyed by raw event_name. Attach app_event_id so we can aggregate.
    preheat_by_app: Optional[pd.DataFrame] = None
    if preheat_summary is not None and "event_name" in preheat_summary.columns:
        tmp = preheat_summary.copy()
        tmp["app_event_id"] = tmp["event_name"].astype(str).map(name_to_app)
        preheat_by_app = tmp.dropna(subset=["app_event_id"])

    # Priority and uncertainty predictions are per Stage event_id; attach app_event_id.
    if priority_scores is not None and "event_id" in priority_scores.columns:
        priority_scores = priority_scores.copy()
        priority_scores["app_event_id"] = priority_scores["event_id"].astype(str).map(stage_to_app)
        priority_scores = priority_scores.dropna(subset=["app_event_id"])

    if uncertainty_event_predictions is not None and "event_id" in uncertainty_event_predictions.columns:
        uncertainty_event_predictions = uncertainty_event_predictions.copy()
        uncertainty_event_predictions["app_event_id"] = uncertainty_event_predictions["event_id"].astype(str).map(stage_to_app)
        uncertainty_event_predictions = uncertainty_event_predictions.dropna(subset=["app_event_id"])

    if uncertainty_intervals is not None and "event_name" in uncertainty_intervals.columns:
        uncertainty_intervals = uncertainty_intervals.copy()
        uncertainty_intervals["app_event_id"] = uncertainty_intervals["event_name"].astype(str).map(name_to_app)
        uncertainty_intervals = uncertainty_intervals.dropna(subset=["app_event_id"])

    df["app_event_id"] = df.apply(
        lambda r: build_app_event_id(str(r.get("currency")), str(r.get("event_name")))[0],
        axis=1,
    )

    events: dict[str, Any] = {}

    for app_event_id, group in df.groupby("app_event_id", dropna=False):
        app_event_id = str(app_event_id).strip()
        if not app_event_id:
            continue

        payload: dict[str, Any] = {
            "predictRelease": _build_predict_release(group),
            "signals": {},
        }
        signals: dict[str, Any] = payload["signals"]

        # Preheat: aggregate summary rows mapping to this metric id.
        if preheat_by_app is not None:
            hit = preheat_by_app[preheat_by_app["app_event_id"].astype(str) == app_event_id]
            if not hit.empty:
                total = int(hit["total_events"].sum()) if "total_events" in hit.columns else int(hit.shape[0])
                flagged = int(hit["flagged_events"].sum()) if "flagged_events" in hit.columns else 0
                share = float(flagged / total) if total > 0 else None
                signals["preheat"] = {"flaggedShare": share, "totalEvents": total, "flaggedEvents": flagged}

        # Trend: use indicator normaliser to find the per-indicator summary.
        if trend_summary is not None and "indicator_name" in trend_summary.columns:
            try:
                from scripts.calendar.workflow.event_trend_analysis import _normalise_indicator  # type: ignore
            except Exception:
                _normalise_indicator = None  # type: ignore
            if _normalise_indicator is not None and "event_name" in group.columns:
                name = str(group["event_name"].mode().iloc[0] if not group["event_name"].mode().empty else group["event_name"].iloc[-1])
                key = str(_normalise_indicator(name))
                ts = trend_summary[trend_summary["indicator_name"].astype(str) == key]
                if not ts.empty:
                    # Keep only a small, UI-friendly subset.
                    row = ts.iloc[0].to_dict()
                    keep = {
                        k: row.get(k)
                        for k in (
                            "total_events",
                            "years_covered",
                            "trend_slope_per_year",
                            "surprise_autocorr_lag1",
                            "seasonality_strength",
                            "surprise_price_corr_post60",
                            "surprise_price_corr_post240",
                        )
                        if k in row
                    }
                    signals["trend"] = keep

        # Components + Path dependency: use the same base/freq/core categorisers as the Stage script.
        if "event_name" in group.columns:
            try:
                from scripts.calendar.workflow.event_component_decomposition import (  # type: ignore
                    _categorise_core,
                    _extract_frequency,
                    _normalise_base_indicator,
                )
            except Exception:
                _categorise_core = None  # type: ignore
                _extract_frequency = None  # type: ignore
                _normalise_base_indicator = None  # type: ignore

            if _normalise_base_indicator is not None and _extract_frequency is not None and _categorise_core is not None:
                name = str(group["event_name"].mode().iloc[0] if not group["event_name"].mode().empty else group["event_name"].iloc[-1])
                base = str(_normalise_base_indicator(name))
                freq = str(_extract_frequency(name))
                core = str(_categorise_core(name))

                if component_breakdown is not None and "base_indicator" in component_breakdown.columns:
                    cb = component_breakdown
                    mask = (
                        (cb.get("base_indicator").astype(str) == base)
                        & (cb.get("frequency_tag").astype(str) == freq)
                        & (cb.get("core_category").astype(str) == core)
                    )
                    hit = cb[mask]
                    if not hit.empty:
                        hit = hit.sort_values(by=["event_count"], ascending=False).head(6)
                        signals["components"] = hit.to_dict(orient="records")

                if path_summary is not None and "base_indicator" in path_summary.columns:
                    ps = path_summary
                    mask = (
                        (ps.get("base_indicator").astype(str) == base)
                        & (ps.get("frequency_tag").astype(str) == freq)
                        & (ps.get("core_category").astype(str) == core)
                    )
                    hit = ps[mask]
                    if not hit.empty:
                        hit = hit.sort_values(by=["sample_size"], ascending=False).head(8)
                        signals["pathDependency"] = hit.to_dict(orient="records")

        # Priority routing: direction share + avg strength.
        if priority_scores is not None and "app_event_id" in priority_scores.columns:
            hit = priority_scores[priority_scores["app_event_id"].astype(str) == app_event_id]
            if not hit.empty:
                total = int(hit.shape[0])
                direction_share = (
                    hit["direction"].astype(str).str.lower().value_counts().to_dict()
                    if "direction" in hit.columns
                    else {}
                )
                direction_share = {k: (v / total) for k, v in direction_share.items()} if total else {}
                avg_score = _safe_float(hit["priority_score"].astype(float).mean()) if "priority_score" in hit.columns else None
                avg_strength = _safe_float(hit["signal_strength"].astype(float).mean()) if "signal_strength" in hit.columns else None
                signals["priorityRouting"] = {
                    "avgScore": avg_score,
                    "avgSignalStrength": avg_strength,
                    "directionShare": direction_share,
                    "rules": priority_rules,
                }

        # Uncertainty: horizons + short interval excerpt.
        predict_market: dict[str, Any] = {}
        if uncertainty_event_predictions is not None and "app_event_id" in uncertainty_event_predictions.columns:
            hit = uncertainty_event_predictions[uncertainty_event_predictions["app_event_id"].astype(str) == app_event_id]
            if not hit.empty and "window" in hit.columns and "predicted_positive_share_pct" in hit.columns:
                horizons: dict[str, Any] = {}
                for window, sub in hit.groupby("window"):
                    p_up = _safe_float(sub["predicted_positive_share_pct"].astype(float).mean())
                    if p_up is None:
                        continue
                    horizons[f"{int(window)}m"] = {"pUp": float(p_up) / 100.0, "n": int(sub.shape[0])}
                if horizons:
                    predict_market["horizons"] = horizons

        if uncertainty_intervals is not None and "app_event_id" in uncertainty_intervals.columns:
            hit = uncertainty_intervals[uncertainty_intervals["app_event_id"].astype(str) == app_event_id]
            if not hit.empty:
                cols = [c for c in ("window", "sample_size", "positive_share_pct", "mean_return_pct", "std_return_pct") if c in hit.columns]
                excerpt = hit[cols].copy() if cols else None
                if excerpt is not None and not excerpt.empty:
                    excerpt = excerpt.sort_values(by=["window"]).head(24)
                    signals["uncertainty"] = {"intervalSummary": excerpt.to_dict(orient="records")}

        if predict_market:
            payload["predictMarket"] = predict_market

        payload["signalsUsed"] = _signals_used(payload)
        payload["method"] = {
            "name": "calendar-stage-bc-export",
            "version": "2",
            "summary": "Deep JSON exported from Stage B/C outputs (preheat, trend, components, path dependency, priority routing, uncertainty).",
        }

        events[app_event_id] = payload

    return {
        "schema": 1,
        "generated_at_utc": _utc_now_rfc3339(),
        "meta": {
            "currency": currency.upper(),
            "sources": {
                "alignment": str(Path(paths.alignment).as_posix()),
                "preheat_summary": str(Path(paths.preheat_summary).as_posix()),
                "trend_summary": str(Path(paths.trend_summary).as_posix()),
                "component_breakdown": str(Path(paths.component_breakdown).as_posix()),
                "path_summary": str(Path(paths.path_summary).as_posix()),
                "priority_scores": str(Path(paths.priority_scores).as_posix()),
                "priority_rules": str(Path(paths.priority_rules).as_posix()),
                "uncertainty_intervals": str(Path(paths.uncertainty_intervals).as_posix()),
                "uncertainty_event_predictions": str(Path(paths.uncertainty_event_predictions).as_posix()),
            },
        },
        "events": events,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--currency", default="USD")
    parser.add_argument("--alignment-path", type=Path, default=DEFAULT_ALIGNMENT_PATH)
    parser.add_argument(
        "--calendar-outputs-dir",
        type=Path,
        default=Path("data/calendar_outputs"),
    )
    parser.add_argument(
        "--output-json",
        type=Path,
        default=Path("data/analysis/xauusd_event_deep_analysis_usd.json"),
    )
    args = parser.parse_args()

    base = Path(args.calendar_outputs_dir)
    paths = Paths(
        alignment=args.alignment_path,
        preheat_summary=base / "event_preheat_monitor" / "preheat_summary.parquet",
        trend_summary=base / "event_trend_analysis" / "trend_event_summary.parquet",
        component_breakdown=base / "component_decomposition" / "component_breakdown.parquet",
        path_summary=base / "path_dependency" / "path_dependency_summary.parquet",
        priority_scores=base / "event_priority_routing" / "priority_event_scores.parquet",
        priority_rules=base / "event_priority_routing" / "priority_rules.json",
        uncertainty_intervals=base / "event_uncertainty" / "uncertainty_interval_summary.parquet",
        uncertainty_event_predictions=base / "event_uncertainty" / "uncertainty_event_predictions.parquet",
    )

    alignment_path = Path(paths.alignment).expanduser().resolve()
    if not alignment_path.exists():
        raise SystemExit(f"Alignment dataset not found: {alignment_path}")

    alignment = read_table(alignment_path, parse_dates=("event_time",))
    payload = build_deep_analysis_json(args.currency, alignment, paths)

    out_path = Path(args.output_json).expanduser().resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {out_path} (events={len(payload.get('events', {}))}).")


if __name__ == "__main__":
    main()

