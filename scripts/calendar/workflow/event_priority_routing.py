"""Stage C priority routing: resolve conflicting event signals via governance rules."""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import pandas as pd

try:
    from .event_adaptive_window import AdaptiveWindowResult
except ImportError:  # pragma: no cover - fallback when running as module
    AdaptiveWindowResult = None  # type: ignore[attr-defined]

try:
    from .event_price_deepdive import _normalise_surprise_direction
except ImportError:  # pragma: no cover
    import sys

    sys.path.append(str(Path(__file__).resolve().parents[3]))
    # fmt: off
    from scripts.calendar.workflow.event_price_deepdive import (
        _normalise_surprise_direction,  # type: ignore[import-not-found]
    )

    # fmt: on

BASE_OUTPUT_DIR = Path("data/calendar_outputs/event_priority_routing")
DEFAULT_ALIGNMENT_PATH = Path(
    "data/calendar_outputs/event_price_alignment/event_price_alignment.parquet"
)
DEFAULT_ADAPTIVE_EVENTS_PATH = Path(
    "data/calendar_outputs/event_adaptive_window/adaptive_window_events.parquet"
)
DEFAULT_EVENT_OUTPUT_PARQUET = BASE_OUTPUT_DIR / "priority_event_scores.parquet"
DEFAULT_EVENT_OUTPUT_CSV = BASE_OUTPUT_DIR / "priority_event_scores.csv"
DEFAULT_GROUP_OUTPUT_PARQUET = BASE_OUTPUT_DIR / "priority_group_resolutions.parquet"
DEFAULT_GROUP_OUTPUT_CSV = BASE_OUTPUT_DIR / "priority_group_resolutions.csv"
DEFAULT_RULES_JSON = BASE_OUTPUT_DIR / "priority_rules.json"

DEFAULT_IMPORTANCE_WEIGHTS = {"High": 3.0, "Medium": 2.0, "Low": 1.0}
DEFAULT_WEIGHT_IMPORTANCE = 5.0
DEFAULT_WEIGHT_SURPRISE = 3.0
DEFAULT_WEIGHT_RETURN = 4.0
DEFAULT_WEIGHT_DOMINANCE = 2.0
DEFAULT_SURPRISE_CAP = 5.0
DEFAULT_RETURN_CAP = 1.5
DEFAULT_MIN_SIGNAL = 0.05
DEFAULT_MIN_GROUP_SIZE = 2


@dataclass
class PriorityConfig:
    alignment_path: Path = DEFAULT_ALIGNMENT_PATH
    adaptive_events_path: Path = DEFAULT_ADAPTIVE_EVENTS_PATH
    event_output_parquet: Path = DEFAULT_EVENT_OUTPUT_PARQUET
    event_output_csv: Optional[Path] = DEFAULT_EVENT_OUTPUT_CSV
    group_output_parquet: Path = DEFAULT_GROUP_OUTPUT_PARQUET
    group_output_csv: Optional[Path] = DEFAULT_GROUP_OUTPUT_CSV
    rules_output_json: Path = DEFAULT_RULES_JSON
    importance_weight_high: float = DEFAULT_IMPORTANCE_WEIGHTS["High"]
    importance_weight_medium: float = DEFAULT_IMPORTANCE_WEIGHTS["Medium"]
    importance_weight_low: float = DEFAULT_IMPORTANCE_WEIGHTS["Low"]
    weight_importance: float = DEFAULT_WEIGHT_IMPORTANCE
    weight_surprise: float = DEFAULT_WEIGHT_SURPRISE
    weight_return: float = DEFAULT_WEIGHT_RETURN
    weight_dominance: float = DEFAULT_WEIGHT_DOMINANCE
    surprise_cap: float = DEFAULT_SURPRISE_CAP
    return_cap: float = DEFAULT_RETURN_CAP
    min_signal_strength: float = DEFAULT_MIN_SIGNAL
    min_group_size: int = DEFAULT_MIN_GROUP_SIZE
    include_singletons: bool = False

    def __post_init__(self) -> None:
        self.alignment_path = self.alignment_path.expanduser().resolve()
        self.adaptive_events_path = self.adaptive_events_path.expanduser().resolve()
        self.event_output_parquet = self.event_output_parquet.expanduser().resolve()
        if self.event_output_csv is not None:
            self.event_output_csv = self.event_output_csv.expanduser().resolve()
        self.group_output_parquet = self.group_output_parquet.expanduser().resolve()
        if self.group_output_csv is not None:
            self.group_output_csv = self.group_output_csv.expanduser().resolve()
        self.rules_output_json = self.rules_output_json.expanduser().resolve()
        self.min_group_size = max(1, int(self.min_group_size))
        if self.min_group_size <= 1 and not self.include_singletons:
            self.min_group_size = 2
        if self.surprise_cap <= 0:
            raise ValueError("surprise_cap must be positive")
        if self.return_cap <= 0:
            raise ValueError("return_cap must be positive")
        if self.min_signal_strength < 0:
            raise ValueError("min_signal_strength cannot be negative")

    @property
    def importance_weights(self) -> dict[str, float]:
        return {
            "High": float(self.importance_weight_high),
            "Medium": float(self.importance_weight_medium),
            "Low": float(self.importance_weight_low),
        }


@dataclass
class PriorityResult:
    events: pd.DataFrame
    groups: pd.DataFrame


def _load_alignment(
    config: PriorityConfig, alignment_df: Optional[pd.DataFrame]
) -> pd.DataFrame:
    if alignment_df is not None:
        df = alignment_df.copy()
    else:
        if not config.alignment_path.exists():
            raise FileNotFoundError(
                f"Alignment dataset not found: {config.alignment_path}"
            )
        df = pd.read_parquet(config.alignment_path)
    if df.empty:
        raise SystemExit("Alignment dataset is empty; nothing to process.")
    df["event_time"] = pd.to_datetime(df["event_time"])
    df["importance"] = df["importance"].astype(str).str.title()
    return df


def _load_adaptive(
    config: PriorityConfig,
    adaptive_result: Optional[AdaptiveWindowResult],
) -> pd.DataFrame:
    if adaptive_result is not None:
        events = adaptive_result.events.copy()
    else:
        if not config.adaptive_events_path.exists():
            raise FileNotFoundError(
                "Adaptive window dataset not found; run Stage C adaptive window first "
                "or provide the path via --adaptive-events-path."
            )
        events = pd.read_parquet(config.adaptive_events_path)
    if events.empty:
        raise SystemExit("Adaptive window dataset is empty; nothing to process.")
    drop_cols = [
        col
        for col in (
            "event_time",
            "event_name",
            "currency",
            "importance",
            "surprise_pct",
            "surprise_pct_abs",
            "surprise_direction",
        )
        if col in events.columns
    ]
    if drop_cols:
        events = events.drop(columns=drop_cols)
    return events


def _determine_group_key(row: pd.Series) -> str:
    group_id = row.get("joint_event_group_id")
    if pd.notna(group_id):
        return f"joint::{str(group_id)}"
    timestamp = row.get("event_time")
    if isinstance(timestamp, pd.Timestamp):
        return f"time::{timestamp.isoformat()}"
    return f"event::{row.get('event_id')}"


def _scale_value(value: Optional[float], cap: float) -> float:
    if value is None or pd.isna(value):
        return 0.0
    return min(abs(float(value)), cap) / cap


def _compute_direction(signal: Optional[float], threshold: float) -> str:
    if signal is None or pd.isna(signal):
        return "unknown"
    value = float(signal)
    if abs(value) < threshold:
        return "flat"
    return "up" if value > 0 else "down"


def _format_reason(row: pd.Series) -> str:
    parts: list[str] = []
    importance = row.get("importance")
    if importance:
        parts.append(f"importance={importance}")
    surprise_abs = row.get("surprise_pct_abs")
    if pd.notna(surprise_abs):
        parts.append(f"abs_surprise={float(surprise_abs):.2f}%")
    dominant_return = row.get("adaptive_dominant_return_pct")
    if pd.notna(dominant_return):
        parts.append(f"dominant_return={float(dominant_return):.3f}%")
    dominant_window = row.get("adaptive_dominant_window")
    if pd.notna(dominant_window):
        parts.append(f"window={int(dominant_window)}m")
    return "; ".join(parts)


def _prepare_event_scores(
    merged: pd.DataFrame,
    config: PriorityConfig,
) -> pd.DataFrame:
    records = []
    for _, row in merged.iterrows():
        group_key = _determine_group_key(row)
        signal = row.get("adaptive_dominant_return_pct")
        fallback_signal = row.get("return_post_60_pct")
        dominant_used = True
        if signal is None or pd.isna(signal):
            signal = fallback_signal
            dominant_used = False
        direction = _compute_direction(signal, config.min_signal_strength)
        signal_strength = (
            abs(signal) if signal is not None and not pd.isna(signal) else None
        )

        importance = row.get("importance", "Medium") or "Medium"
        importance_score = config.importance_weights.get(str(importance), 1.0)
        surprise_abs = row.get("surprise_pct_abs")
        surprise_score = _scale_value(surprise_abs, config.surprise_cap)
        return_score = _scale_value(signal, config.return_cap)
        dominance_share = row.get("adaptive_dominant_share")
        if dominance_share is None or pd.isna(dominance_share):
            dominance_share = 0.0
        dominance_score = float(dominance_share)

        priority_score = (
            importance_score * config.weight_importance
            + surprise_score * config.weight_surprise
            + return_score * config.weight_return
            + dominance_score * config.weight_dominance
        )

        records.append(
            {
                "event_id": row.get("event_id"),
                "event_name": row.get("event_name"),
                "currency": row.get("currency"),
                "importance": importance,
                "event_time": row.get("event_time"),
                "priority_group_key": group_key,
                "joint_event_group_id": row.get("joint_event_group_id"),
                "group_size": row.get("joint_event_group_size"),
                "importance_score": importance_score,
                "surprise_pct": row.get("surprise_pct"),
                "surprise_pct_abs": surprise_abs,
                "surprise_direction": _normalise_surprise_direction(
                    row.get("surprise_category")
                ),
                "adaptive_dominant_window": row.get("adaptive_dominant_window"),
                "adaptive_dominant_return_pct": row.get("adaptive_dominant_return_pct"),
                "adaptive_dominant_share": dominance_share,
                "return_post_60_pct": row.get("return_post_60_pct"),
                "signal_used": "dominant" if dominant_used else "post_60",
                "signal_value_pct": signal,
                "signal_strength_pct": signal_strength,
                "signal_direction": direction,
                "priority_score": priority_score,
                "reason": _format_reason(row),
            }
        )

    event_scores = pd.DataFrame.from_records(records)
    if event_scores.empty:
        raise SystemExit("No events available for priority analysis.")
    event_scores.sort_values(
        by=["priority_group_key", "priority_score", "importance_score"],
        ascending=[True, False, False],
        inplace=True,
    )
    event_scores["priority_rank"] = (
        event_scores.groupby("priority_group_key").cumcount().astype(int) + 1
    )
    return event_scores


def _build_group_resolutions(
    event_scores: pd.DataFrame,
    config: PriorityConfig,
) -> pd.DataFrame:
    grouped = event_scores.groupby("priority_group_key", sort=False)
    group_records = []
    for group_key, group_df in grouped:
        group_size = len(group_df)
        if group_size < config.min_group_size and not config.include_singletons:
            continue
        directions = {
            direction
            for direction in group_df["signal_direction"].dropna().unique()
            if direction in {"up", "down"}
        }
        conflict = len(directions) > 1
        currencies = sorted(group_df["currency"].dropna().unique().tolist())
        top_row = group_df.iloc[0]
        sequence_labels = [f"{row.event_name}" for row in group_df.itertuples()]
        sequence_ids = group_df["event_id"].astype(str).tolist()
        rule = (
            f"Prioritise {top_row['event_name']} ({top_row['importance']}) when "
            f"{top_row['event_time']} has {group_size} overlapping signals. "
            f"Direction {top_row['signal_direction']} with score {top_row['priority_score']:.2f}."
        )

        group_records.append(
            {
                "priority_group_key": group_key,
                "event_time": top_row["event_time"],
                "group_size": group_size,
                "currencies": ",".join(currencies),
                "conflict": conflict,
                "top_event_id": top_row["event_id"],
                "top_event_name": top_row["event_name"],
                "top_signal_direction": top_row["signal_direction"],
                "top_priority_score": top_row["priority_score"],
                "priority_sequence_ids": ",".join(sequence_ids),
                "priority_sequence": "; ".join(sequence_labels),
                "rule_summary": rule,
            }
        )

    return pd.DataFrame(group_records)


def _write_outputs(
    config: PriorityConfig, events: pd.DataFrame, groups: pd.DataFrame
) -> None:
    config.event_output_parquet.parent.mkdir(parents=True, exist_ok=True)
    events.to_parquet(config.event_output_parquet, index=False)
    if config.event_output_csv is not None:
        config.event_output_csv.parent.mkdir(parents=True, exist_ok=True)
        events.to_csv(config.event_output_csv, index=False)

    if not groups.empty:
        config.group_output_parquet.parent.mkdir(parents=True, exist_ok=True)
        groups.to_parquet(config.group_output_parquet, index=False)
        if config.group_output_csv is not None:
            config.group_output_csv.parent.mkdir(parents=True, exist_ok=True)
            groups.to_csv(config.group_output_csv, index=False)
    else:
        print("[WARN] No priority groups met the criteria; skipping group outputs.")

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "event_count": int(len(events)),
        "group_count": int(len(groups)),
        "conflict_groups": (
            int(groups[groups["conflict"]].shape[0]) if not groups.empty else 0
        ),
        "weights": {
            "importance": config.weight_importance,
            "surprise": config.weight_surprise,
            "return": config.weight_return,
            "dominance": config.weight_dominance,
        },
        "importance_weights": config.importance_weights,
        "min_group_size": config.min_group_size,
    }
    config.rules_output_json.parent.mkdir(parents=True, exist_ok=True)
    config.rules_output_json.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def run_priority_routing(
    config: PriorityConfig,
    alignment_df: Optional[pd.DataFrame] = None,
    adaptive_result: Optional[AdaptiveWindowResult] = None,
) -> PriorityResult:
    alignment = _load_alignment(config, alignment_df)
    adaptive_events = _load_adaptive(config, adaptive_result)
    merged = alignment.merge(
        adaptive_events,
        on="event_id",
        how="inner",
        suffixes=("_align", "_adaptive"),
    )
    if merged.empty:
        raise SystemExit(
            "No overlapping events between alignment and adaptive datasets."
        )

    event_scores = _prepare_event_scores(merged, config)
    group_resolutions = _build_group_resolutions(event_scores, config)
    _write_outputs(config, event_scores, group_resolutions)
    return PriorityResult(events=event_scores, groups=group_resolutions)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Stage C priority routing: govern conflicting event signals."
    )
    parser.add_argument(
        "--alignment-path",
        type=Path,
        default=DEFAULT_ALIGNMENT_PATH,
        help="Stage A/B alignment dataset (parquet).",
    )
    parser.add_argument(
        "--adaptive-events-path",
        type=Path,
        default=DEFAULT_ADAPTIVE_EVENTS_PATH,
        help="Stage C adaptive events dataset (parquet).",
    )
    parser.add_argument(
        "--event-output-parquet",
        type=Path,
        default=DEFAULT_EVENT_OUTPUT_PARQUET,
        help="Parquet output for per-event priority scores.",
    )
    parser.add_argument(
        "--event-output-csv",
        type=Path,
        default=DEFAULT_EVENT_OUTPUT_CSV,
        help="Optional CSV output for per-event priority scores.",
    )
    parser.add_argument(
        "--no-event-csv",
        action="store_true",
        help="Skip writing the per-event priority CSV output.",
    )
    parser.add_argument(
        "--group-output-parquet",
        type=Path,
        default=DEFAULT_GROUP_OUTPUT_PARQUET,
        help="Parquet output for group-level priority resolutions.",
    )
    parser.add_argument(
        "--group-output-csv",
        type=Path,
        default=DEFAULT_GROUP_OUTPUT_CSV,
        help="Optional CSV output for group-level priority resolutions.",
    )
    parser.add_argument(
        "--no-group-csv",
        action="store_true",
        help="Skip writing the group-level priority CSV output.",
    )
    parser.add_argument(
        "--rules-output-json",
        type=Path,
        default=DEFAULT_RULES_JSON,
        help="JSON output summarising configuration and counts.",
    )
    parser.add_argument(
        "--importance-weight-high",
        type=float,
        default=DEFAULT_IMPORTANCE_WEIGHTS["High"],
        help="Base weight assigned to High importance events.",
    )
    parser.add_argument(
        "--importance-weight-medium",
        type=float,
        default=DEFAULT_IMPORTANCE_WEIGHTS["Medium"],
        help="Base weight assigned to Medium importance events.",
    )
    parser.add_argument(
        "--importance-weight-low",
        type=float,
        default=DEFAULT_IMPORTANCE_WEIGHTS["Low"],
        help="Base weight assigned to Low importance events.",
    )
    parser.add_argument(
        "--weight-importance",
        type=float,
        default=DEFAULT_WEIGHT_IMPORTANCE,
        help="Coefficient applied to importance score when computing priority.",
    )
    parser.add_argument(
        "--weight-surprise",
        type=float,
        default=DEFAULT_WEIGHT_SURPRISE,
        help="Coefficient applied to absolute surprise score.",
    )
    parser.add_argument(
        "--weight-return",
        type=float,
        default=DEFAULT_WEIGHT_RETURN,
        help="Coefficient applied to absolute return score.",
    )
    parser.add_argument(
        "--weight-dominance",
        type=float,
        default=DEFAULT_WEIGHT_DOMINANCE,
        help="Coefficient applied to dominant share score.",
    )
    parser.add_argument(
        "--surprise-cap",
        type=float,
        default=DEFAULT_SURPRISE_CAP,
        help="Cap for absolute surprise percentage before normalisation.",
    )
    parser.add_argument(
        "--return-cap",
        type=float,
        default=DEFAULT_RETURN_CAP,
        help="Cap for absolute return percentage before normalisation.",
    )
    parser.add_argument(
        "--min-signal-strength",
        type=float,
        default=DEFAULT_MIN_SIGNAL,
        help="Minimum absolute return (pct) to treat a signal as directional.",
    )
    parser.add_argument(
        "--min-group-size",
        type=int,
        default=DEFAULT_MIN_GROUP_SIZE,
        help="Minimum overlapping events required to output a group (defaults to 2).",
    )
    parser.add_argument(
        "--include-singletons",
        action="store_true",
        help="Also include single-event groups in the outputs.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    config = PriorityConfig(
        alignment_path=args.alignment_path,
        adaptive_events_path=args.adaptive_events_path,
        event_output_parquet=args.event_output_parquet,
        event_output_csv=None if args.no_event_csv else args.event_output_csv,
        group_output_parquet=args.group_output_parquet,
        group_output_csv=None if args.no_group_csv else args.group_output_csv,
        rules_output_json=args.rules_output_json,
        importance_weight_high=args.importance_weight_high,
        importance_weight_medium=args.importance_weight_medium,
        importance_weight_low=args.importance_weight_low,
        weight_importance=args.weight_importance,
        weight_surprise=args.weight_surprise,
        weight_return=args.weight_return,
        weight_dominance=args.weight_dominance,
        surprise_cap=args.surprise_cap,
        return_cap=args.return_cap,
        min_signal_strength=args.min_signal_strength,
        min_group_size=args.min_group_size,
        include_singletons=args.include_singletons,
    )
    run_priority_routing(config)


if __name__ == "__main__":
    main()
