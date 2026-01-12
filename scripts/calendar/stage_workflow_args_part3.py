from __future__ import annotations

from pathlib import Path

from .stage_workflow_defaults import *  # noqa: F403


def add_stage_args_part3(parser):

    parser.add_argument(
        "--components-min-events",
        type=int,
        default=COMPONENT_DEFAULT_MIN_EVENTS,
        help="Minimum sample size required to keep a component bucket.",
    )
    parser.add_argument(
        "--prototype-detail-output-parquet",
        type=Path,
        default=DEFAULT_PROTOTYPE_DETAIL_PARQUET,
        help="Parquet output for prototype event assignments.",
    )
    parser.add_argument(
        "--prototype-detail-output-csv",
        type=Path,
        default=DEFAULT_PROTOTYPE_DETAIL_CSV,
        help="Optional CSV output for prototype event assignments.",
    )
    parser.add_argument(
        "--prototype-no-detail-csv",
        action="store_true",
        help="Skip writing the prototype detail CSV output.",
    )
    parser.add_argument(
        "--prototype-summary-output-parquet",
        type=Path,
        default=DEFAULT_PROTOTYPE_SUMMARY_PARQUET,
        help="Parquet output for prototype summary statistics.",
    )
    parser.add_argument(
        "--prototype-summary-output-csv",
        type=Path,
        default=DEFAULT_PROTOTYPE_SUMMARY_CSV,
        help="Optional CSV output for prototype summaries.",
    )
    parser.add_argument(
        "--prototype-no-summary-csv",
        action="store_true",
        help="Skip writing the prototype summary CSV output.",
    )
    parser.add_argument(
        "--prototype-centroid-output-parquet",
        type=Path,
        default=DEFAULT_PROTOTYPE_CENTROID_PARQUET,
        help="Parquet output for prototype centroids.",
    )
    parser.add_argument(
        "--prototype-centroid-output-csv",
        type=Path,
        default=DEFAULT_PROTOTYPE_CENTROID_CSV,
        help="Optional CSV output for prototype centroids.",
    )
    parser.add_argument(
        "--prototype-no-centroid-csv",
        action="store_true",
        help="Skip writing the prototype centroid CSV output.",
    )
    parser.add_argument(
        "--prototype-min-events",
        type=int,
        default=PROTOTYPE_DEFAULT_MIN_EVENTS,
        help="Minimum sample size required per indicator before clustering.",
    )
    parser.add_argument(
        "--prototype-max-clusters",
        type=int,
        default=PROTOTYPE_DEFAULT_MAX_CLUSTERS,
        help="Maximum cluster count per indicator.",
    )
    parser.add_argument(
        "--prototype-random-state",
        type=int,
        default=PROTOTYPE_DEFAULT_RANDOM_STATE,
        help="Random seed for prototype clustering.",
    )
    parser.add_argument(
        "--path-detail-output-parquet",
        type=Path,
        default=DEFAULT_PATH_DETAIL_PARQUET,
        help="Parquet output for path dependency event records.",
    )
    parser.add_argument(
        "--path-detail-output-csv",
        type=Path,
        default=DEFAULT_PATH_DETAIL_CSV,
        help="Optional CSV output for path dependency event records.",
    )
    parser.add_argument(
        "--path-no-detail-csv",
        action="store_true",
        help="Skip writing the path dependency detail CSV output.",
    )
    parser.add_argument(
        "--path-summary-output-parquet",
        type=Path,
        default=DEFAULT_PATH_SUMMARY_PARQUET,
        help="Parquet output for aggregated path dependency summaries.",
    )
    parser.add_argument(
        "--path-summary-output-csv",
        type=Path,
        default=DEFAULT_PATH_SUMMARY_CSV,
        help="Optional CSV output for aggregated path dependency summaries.",
    )
    parser.add_argument(
        "--path-no-summary-csv",
        action="store_true",
        help="Skip writing the path dependency summary CSV output.",
    )
    parser.add_argument(
        "--path-min-events",
        type=int,
        default=PATH_DEFAULT_MIN_EVENTS,
        help="Minimum sample size required for aggregated path dependency metrics.",
    )
    parser.add_argument(
        "--preheat-metrics-output-parquet",
        type=Path,
        default=DEFAULT_PREHEAT_METRICS_PARQUET,
        help="Output parquet for Stage B preheat metrics.",
    )
    parser.add_argument(
        "--preheat-metrics-output-csv",
        type=Path,
        default=DEFAULT_PREHEAT_METRICS_CSV,
        help="Optional CSV for Stage B preheat metrics (omit via --preheat-no-metrics-csv).",
    )
    parser.add_argument(
        "--preheat-no-metrics-csv",
        action="store_true",
        help="Skip writing the preheat metrics CSV.",
    )
    parser.add_argument(
        "--preheat-flags-output-parquet",
        type=Path,
        default=DEFAULT_PREHEAT_FLAGS_PARQUET,
        help="Output parquet filtered to flagged preheat events.",
    )
    parser.add_argument(
        "--preheat-flags-output-csv",
        type=Path,
        default=DEFAULT_PREHEAT_FLAGS_CSV,
        help="Optional CSV filtered to flagged preheat events (omit via --preheat-no-flags-csv).",
    )
    parser.add_argument(
        "--preheat-no-flags-csv",
        action="store_true",
        help="Skip writing the preheat flags CSV.",
    )
    parser.add_argument(
        "--preheat-thresholds-output",
        type=Path,
        default=DEFAULT_PREHEAT_THRESHOLDS,
        help="Output CSV storing preheat quantile thresholds.",
    )
    parser.add_argument(
        "--preheat-summary-output-parquet",
        type=Path,
        default=DEFAULT_PREHEAT_SUMMARY_PARQUET,
        help="Output parquet summarising preheat flags by event name.",
    )
    parser.add_argument(
        "--preheat-summary-output-csv",
        type=Path,
        default=DEFAULT_PREHEAT_SUMMARY_CSV,
        help="Optional CSV summary for preheat flags (omit via --preheat-no-summary-csv).",
    )
    parser.add_argument(
        "--preheat-no-summary-csv",
        action="store_true",
        help="Skip writing the preheat summary CSV.",
    )
    parser.add_argument(
        "--preheat-flag-quantile",
        type=float,
        default=None,
        help="Override the quantile used for preheat flags (default 0.9).",
    )
    parser.add_argument(
        "--preheat-pre-windows",
        type=int,
        nargs="+",
        default=list(PREHEAT_DEFAULT_PRE_WINDOWS),
        help="Pre-event windows (minutes) used for preheat monitoring (default: 15 60).",
    )
    parser.add_argument(
        "--preheat-volume-baselines",
        type=int,
        nargs="+",
        default=list(PREHEAT_DEFAULT_VOLUME_BASELINES),
        help="Baseline windows (minutes) for volume ratios (default: 60 240 1440).",
    )
    parser.add_argument(
        "--preheat-quantiles",
        type=float,
        nargs="+",
        default=list(PREHEAT_DEFAULT_QUANTILES),
        help="Quantiles for preheat threshold calculation (default: 0.75 0.9 0.95).",
    )
    parser.add_argument(
        "--trend-monthly-output-parquet",
        type=Path,
        default=DEFAULT_TREND_MONTHLY_PARQUET,
        help="Parquet path for monthly trend metrics.",
    )
    parser.add_argument(
        "--trend-monthly-output-csv",
        type=Path,
        default=DEFAULT_TREND_MONTHLY_CSV,
        help="Optional CSV for monthly trend metrics.",
    )
    parser.add_argument(
        "--trend-no-monthly-csv",
        action="store_true",
        help="Skip writing the trend monthly CSV.",
    )
    parser.add_argument(
        "--trend-summary-output-parquet",
        type=Path,
        default=DEFAULT_TREND_SUMMARY_PARQUET,
        help="Parquet path for trend summary statistics.",
    )
    parser.add_argument(
        "--trend-summary-output-csv",
        type=Path,
        default=DEFAULT_TREND_SUMMARY_CSV,
        help="Optional CSV for trend summary statistics.",
    )
    parser.add_argument(
        "--trend-no-summary-csv",
        action="store_true",
        help="Skip writing the trend summary CSV.",
    )
    parser.add_argument(
        "--trend-correlation-output-parquet",
        type=Path,
        default=DEFAULT_TREND_CORR_PARQUET,
        help="Parquet path for correlated indicator pairs.",
    )
    parser.add_argument(
        "--trend-correlation-output-csv",
        type=Path,
        default=DEFAULT_TREND_CORR_CSV,
        help="Optional CSV for correlated indicator pairs.",
    )
    parser.add_argument(
        "--trend-no-correlation-csv",
        action="store_true",
        help="Skip writing the trend correlation CSV.",
    )
    parser.add_argument(
        "--trend-alias-file",
        type=Path,
        default=DEFAULT_TREND_ALIAS_FILE,
        help="Manual alias CSV (alias,canonical_name).",
    )
    parser.add_argument(
        "--trend-auto-alias-file",
        type=Path,
        default=DEFAULT_TREND_AUTO_ALIAS_FILE,
        help="Output CSV listing automatically merged aliases.",
    )
    parser.add_argument(
        "--trend-alias-suggestions",
        type=Path,
        default=DEFAULT_TREND_ALIAS_SUGGESTIONS,
        help="Output CSV listing alias suggestions for review.",
    )
    parser.add_argument(
        "--trend-monthly-windows",
        type=int,
        nargs="+",
        default=list(TREND_DEFAULT_MONTHLY_WINDOWS),
        help="Rolling windows (months) for trend metrics (default: 3 6 12).",
    )
    parser.add_argument(
        "--trend-min-events",
        type=int,
        default=TREND_DEFAULT_MIN_EVENTS,
        help="Minimum monthly observations per indicator for trend outputs.",
    )
    parser.add_argument(
        "--trend-min-corr-events",
        type=int,
        default=TREND_DEFAULT_MIN_CORR_EVENTS,
        help="Minimum monthly observations when computing indicator correlations.",
    )
    parser.add_argument(
        "--trend-top-corr-pairs",
        type=int,
        default=TREND_DEFAULT_TOP_CORR,
        help="Number of top indicator correlation pairs to keep.",
    )
