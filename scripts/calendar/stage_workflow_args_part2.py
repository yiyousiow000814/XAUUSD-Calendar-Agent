from __future__ import annotations

from pathlib import Path

from .stage_workflow_defaults import *  # noqa: F403


def add_stage_args_part2(parser):

    parser.add_argument(
        "--priority-group-output-parquet",
        type=Path,
        default=DEFAULT_PRIORITY_GROUP_PARQUET,
        help="Parquet output for Stage C priority group resolutions.",
    )
    parser.add_argument(
        "--priority-group-output-csv",
        type=Path,
        default=DEFAULT_PRIORITY_GROUP_CSV,
        help="Optional CSV output for Stage C priority group resolutions.",
    )
    parser.add_argument(
        "--priority-no-group-csv",
        action="store_true",
        help="Skip writing the Stage C priority group CSV.",
    )
    parser.add_argument(
        "--priority-rules-output-json",
        type=Path,
        default=DEFAULT_PRIORITY_RULES_JSON,
        help="JSON output summarising Stage C priority configuration.",
    )
    parser.add_argument(
        "--priority-importance-weight-high",
        type=float,
        default=PRIORITY_DEFAULT_IMPORTANCE_HIGH,
        help="Base weight for High importance events when scoring priority.",
    )
    parser.add_argument(
        "--priority-importance-weight-medium",
        type=float,
        default=PRIORITY_DEFAULT_IMPORTANCE_MEDIUM,
        help="Base weight for Medium importance events when scoring priority.",
    )
    parser.add_argument(
        "--priority-importance-weight-low",
        type=float,
        default=PRIORITY_DEFAULT_IMPORTANCE_LOW,
        help="Base weight for Low importance events when scoring priority.",
    )
    parser.add_argument(
        "--priority-weight-importance",
        type=float,
        default=PRIORITY_DEFAULT_WEIGHT_IMPORTANCE,
        help="Coefficient applied to importance weight in the priority score.",
    )
    parser.add_argument(
        "--priority-weight-surprise",
        type=float,
        default=PRIORITY_DEFAULT_WEIGHT_SURPRISE,
        help="Coefficient applied to absolute surprise in the priority score.",
    )
    parser.add_argument(
        "--priority-weight-return",
        type=float,
        default=PRIORITY_DEFAULT_WEIGHT_RETURN,
        help="Coefficient applied to absolute return in the priority score.",
    )
    parser.add_argument(
        "--priority-weight-dominance",
        type=float,
        default=PRIORITY_DEFAULT_WEIGHT_DOMINANCE,
        help="Coefficient applied to dominant share in the priority score.",
    )
    parser.add_argument(
        "--priority-surprise-cap",
        type=float,
        default=PRIORITY_DEFAULT_SURPRISE_CAP,
        help="Cap for absolute surprise percentage when normalising priority scores.",
    )
    parser.add_argument(
        "--priority-return-cap",
        type=float,
        default=PRIORITY_DEFAULT_RETURN_CAP,
        help="Cap for absolute return percentage when normalising priority scores.",
    )
    parser.add_argument(
        "--priority-min-signal-strength",
        type=float,
        default=PRIORITY_DEFAULT_MIN_SIGNAL,
        help="Minimum absolute return (pct) to treat a signal as directional during priority routing.",
    )
    parser.add_argument(
        "--priority-min-group-size",
        type=int,
        default=PRIORITY_DEFAULT_MIN_GROUP_SIZE,
        help="Minimum overlapping events required to output a priority group.",
    )
    parser.add_argument(
        "--priority-include-singletons",
        action="store_true",
        help="Also include single-event groups in priority outputs.",
    )

    parser.add_argument(
        "--uncertainty-summary-output-parquet",
        type=Path,
        default=DEFAULT_UNCERTAINTY_SUMMARY_PARQUET,
        help="Parquet output for Stage C uncertainty interval summary.",
    )
    parser.add_argument(
        "--uncertainty-summary-output-csv",
        type=Path,
        default=DEFAULT_UNCERTAINTY_SUMMARY_CSV,
        help="Optional CSV output for Stage C uncertainty interval summary.",
    )
    parser.add_argument(
        "--uncertainty-no-summary-csv",
        action="store_true",
        help="Skip writing the Stage C uncertainty summary CSV.",
    )
    parser.add_argument(
        "--uncertainty-calibration-output-parquet",
        type=Path,
        default=DEFAULT_UNCERTAINTY_CALIBRATION_PARQUET,
        help="Parquet output for Stage C calibration summary.",
    )
    parser.add_argument(
        "--uncertainty-calibration-output-csv",
        type=Path,
        default=DEFAULT_UNCERTAINTY_CALIBRATION_CSV,
        help="Optional CSV output for Stage C calibration summary.",
    )
    parser.add_argument(
        "--uncertainty-no-calibration-csv",
        action="store_true",
        help="Skip writing the Stage C calibration summary CSV.",
    )
    parser.add_argument(
        "--uncertainty-event-output-parquet",
        type=Path,
        default=DEFAULT_UNCERTAINTY_EVENT_PARQUET,
        help="Parquet output for Stage C event-level uncertainty predictions.",
    )
    parser.add_argument(
        "--uncertainty-event-output-csv",
        type=Path,
        default=DEFAULT_UNCERTAINTY_EVENT_CSV,
        help="Optional CSV output for Stage C event-level uncertainty predictions.",
    )
    parser.add_argument(
        "--uncertainty-no-event-csv",
        action="store_true",
        help="Skip writing the Stage C event-level uncertainty CSV.",
    )
    parser.add_argument(
        "--uncertainty-windows",
        type=int,
        nargs="*",
        default=list(UNCERTAINTY_DEFAULT_WINDOWS),
        help="Windows (minutes) used for uncertainty analysis (default: 60 120 240 1440).",
    )
    parser.add_argument(
        "--uncertainty-quantiles",
        type=float,
        nargs="*",
        default=list(UNCERTAINTY_DEFAULT_QUANTILES),
        help="Quantiles for confidence intervals (default: 0.05 0.1 0.25 0.5 0.75 0.9 0.95).",
    )
    parser.add_argument(
        "--uncertainty-calibration-bins",
        type=float,
        nargs="*",
        default=list(UNCERTAINTY_DEFAULT_CALIBRATION_BINS),
        help="Bin edges for calibration summary (default: 0.0 0.1 ... 1.0).",
    )
    parser.add_argument(
        "--uncertainty-min-samples",
        type=int,
        default=UNCERTAINTY_DEFAULT_MIN_SAMPLES,
        help="Minimum samples required per group when computing uncertainty intervals (default: 15).",
    )
    parser.add_argument(
        "--uncertainty-min-calibration",
        type=int,
        default=UNCERTAINTY_DEFAULT_MIN_CALIBRATION,
        help="Minimum samples required per bin for calibration summary (default: 30).",
    )

    parser.add_argument(
        "--deepdive-heatmap-output-parquet",
        type=Path,
        default=DEFAULT_DEEPDIVE_HEATMAP_PARQUET,
        help="Output parquet path for the Stage B heatmap summary.",
    )
    parser.add_argument(
        "--deepdive-heatmap-output-csv",
        type=Path,
        default=DEFAULT_DEEPDIVE_HEATMAP_CSV,
        help="Optional CSV output path for the Stage B heatmap summary.",
    )
    parser.add_argument(
        "--deepdive-no-heatmap-csv",
        action="store_true",
        help="Skip writing the Stage B heatmap CSV.",
    )
    parser.add_argument(
        "--deepdive-thresholds-output",
        type=Path,
        default=DEFAULT_DEEPDIVE_THRESHOLDS,
        help="Output CSV path for Stage B return thresholds.",
    )
    parser.add_argument(
        "--deepdive-flags-output-parquet",
        type=Path,
        default=DEFAULT_DEEPDIVE_FLAGS_PARQUET,
        help="Output parquet path for Stage B follow-up flags.",
    )
    parser.add_argument(
        "--deepdive-flags-output-csv",
        type=Path,
        default=DEFAULT_DEEPDIVE_FLAGS_CSV,
        help="Optional CSV output path for Stage B follow-up flags.",
    )
    parser.add_argument(
        "--deepdive-no-flags-csv",
        action="store_true",
        help="Skip writing the Stage B flag CSV.",
    )
    parser.add_argument(
        "--deepdive-flag-quantile",
        type=float,
        default=None,
        help="Override the quantile used when flagging Stage C/D follow-ups (default 0.9).",
    )
    parser.add_argument(
        "--deepdive-stage-c-windows",
        type=int,
        nargs="+",
        help="Override the Stage C post-event windows (default 60 120 240).",
    )
    parser.add_argument(
        "--deepdive-stage-c-windows-positive",
        type=int,
        nargs="+",
        help="Stage C windows when surprise_category=positive (falls back to --deepdive-stage-c-windows).",
    )
    parser.add_argument(
        "--deepdive-stage-c-windows-negative",
        type=int,
        nargs="+",
        help="Stage C windows when surprise_category=negative (falls back to --deepdive-stage-c-windows).",
    )
    parser.add_argument(
        "--deepdive-stage-d-windows",
        type=int,
        nargs="+",
        help="Override the Stage D pre-event windows (default 15 60).",
    )
    parser.add_argument(
        "--deepdive-stage-d-windows-positive",
        type=int,
        nargs="+",
        help="Stage D windows when surprise_category=positive.",
    )
    parser.add_argument(
        "--deepdive-stage-d-windows-negative",
        type=int,
        nargs="+",
        help="Stage D windows when surprise_category=negative.",
    )
    parser.add_argument(
        "--components-detail-output-parquet",
        type=Path,
        default=DEFAULT_COMPONENT_DETAIL_PARQUET,
        help="Parquet output for component breakdown metrics.",
    )
    parser.add_argument(
        "--components-detail-output-csv",
        type=Path,
        default=DEFAULT_COMPONENT_DETAIL_CSV,
        help="Optional CSV output for component breakdown metrics.",
    )
    parser.add_argument(
        "--components-no-detail-csv",
        action="store_true",
        help="Skip writing the component breakdown CSV output.",
    )
    parser.add_argument(
        "--components-summary-output-parquet",
        type=Path,
        default=DEFAULT_COMPONENT_SUMMARY_PARQUET,
        help="Parquet output for aggregated component summaries.",
    )
    parser.add_argument(
        "--components-summary-output-csv",
        type=Path,
        default=DEFAULT_COMPONENT_SUMMARY_CSV,
        help="Optional CSV output for aggregated component summaries.",
    )
    parser.add_argument(
        "--components-no-summary-csv",
        action="store_true",
        help="Skip writing the component summary CSV output.",
    )
