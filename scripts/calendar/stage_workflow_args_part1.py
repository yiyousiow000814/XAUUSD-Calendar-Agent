from __future__ import annotations

import argparse
from pathlib import Path

from .stage_workflow_defaults import *  # noqa: F403


def add_stage_args_part1(parser):

    parser.add_argument(
        "--skip-pipeline", action="store_true", help="Skip the merge step."
    )
    parser.add_argument(
        "--skip-alignment", action="store_true", help="Skip the alignment step."
    )
    parser.add_argument(
        "--skip-deepdive", action="store_true", help="Skip the Stage B deep-dive."
    )
    parser.add_argument(
        "--skip-path",
        action="store_true",
        help="Skip the Stage B path dependency analysis.",
    )

    parser.add_argument(
        "--skip-preheat", action="store_true", help="Skip the Stage B preheat monitor."
    )
    parser.add_argument(
        "--skip-components",
        action="store_true",
        help="Skip the Stage B component decomposition.",
    )
    parser.add_argument(
        "--skip-prototypes",
        action="store_true",
        help="Skip the Stage B prototype clustering.",
    )

    parser.add_argument(
        "--skip-trend", action="store_true", help="Skip the Stage B trend analysis."
    )
    parser.add_argument(
        "--skip-adaptive",
        action="store_true",
        help="Skip the Stage C adaptive window analysis.",
    )
    parser.add_argument(
        "--skip-priority",
        action="store_true",
        help="Skip the Stage C priority routing analysis.",
    )
    parser.add_argument(
        "--skip-uncertainty",
        action="store_true",
        help="Skip the Stage C predictive uncertainty analysis.",
    )

    parser.add_argument("--price-path", type=Path, default=DEFAULT_PRICE_PATH)
    parser.add_argument("--calendar-dir", type=Path, default=DEFAULT_CALENDAR_DIR)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    parser.add_argument(
        "--minutes-dir",
        type=Path,
        default=None,
        help="Stage A minutes directory (used if pipeline skipped).",
    )

    parser.add_argument("--start-year", type=int, default=2020)
    parser.add_argument("--end-year", type=int, default=2020)
    parser.add_argument("--pre-window", type=int, default=60)
    parser.add_argument("--post-window", type=int, default=60)
    parser.add_argument(
        "--currencies",
        nargs="*",
        default=list(DEFAULT_CURRENCIES),
        help="Currency codes to retain when building Stage A features.",
    )
    parser.add_argument(
        "--importance",
        nargs="*",
        default=list(DEFAULT_IMPORTANCE),
        help="Importance levels for Stage A features.",
    )
    parser.add_argument(
        "--memory-only-stage-a",
        action="store_true",
        help="Skip writing Stage A outputs to disk; keep results in memory only.",
    )
    parser.add_argument(
        "--pipeline-csv",
        action="store_true",
        help="Write per-year CSV outputs for Stage A (disabled by default).",
    )
    parser.add_argument(
        "--no-pipeline-csv",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--no-pipeline-xlsx",
        action="store_true",
        help="Do not write per-year XLSX sample outputs.",
    )

    parser.add_argument(
        "--alignment-output-parquet",
        type=Path,
        default=DEFAULT_ALIGNMENT_PARQUET,
        help="Output parquet path for the alignment summary.",
    )
    parser.add_argument(
        "--alignment-output-csv",
        type=Path,
        default=DEFAULT_ALIGNMENT_CSV,
        help="Output CSV path for the alignment summary.",
    )
    parser.add_argument(
        "--alignment-no-csv",
        action="store_true",
        help="Do not write the alignment CSV.",
    )
    parser.add_argument(
        "--alignment-pre-window",
        type=int,
        help="Override pre-window for alignment metrics.",
    )
    parser.add_argument(
        "--alignment-post-window",
        type=int,
        help="Override post-window for alignment metrics.",
    )
    parser.add_argument(
        "--alignment-importance",
        nargs="*",
        help="Override importance levels when computing alignment metrics.",
    )

    parser.add_argument(
        "--adaptive-events-output-parquet",
        type=Path,
        default=DEFAULT_ADAPTIVE_EVENTS_PARQUET,
        help="Parquet output for Stage C adaptive per-event metrics.",
    )
    parser.add_argument(
        "--adaptive-events-output-csv",
        type=Path,
        default=DEFAULT_ADAPTIVE_EVENTS_CSV,
        help="Optional CSV output for Stage C adaptive per-event metrics.",
    )
    parser.add_argument(
        "--adaptive-no-events-csv",
        action="store_true",
        help="Skip writing the Stage C per-event adaptive CSV.",
    )
    parser.add_argument(
        "--adaptive-summary-output-parquet",
        type=Path,
        default=DEFAULT_ADAPTIVE_SUMMARY_PARQUET,
        help="Parquet output for Stage C adaptive summaries.",
    )
    parser.add_argument(
        "--adaptive-summary-output-csv",
        type=Path,
        default=DEFAULT_ADAPTIVE_SUMMARY_CSV,
        help="Optional CSV output for Stage C adaptive summaries.",
    )
    parser.add_argument(
        "--adaptive-no-summary-csv",
        action="store_true",
        help="Skip writing the Stage C adaptive summary CSV.",
    )
    parser.add_argument(
        "--adaptive-recommendations-json",
        type=Path,
        default=DEFAULT_ADAPTIVE_RECOMMENDATIONS,
        help="JSON output capturing adaptive window recommendations.",
    )
    parser.add_argument(
        "--adaptive-post-windows",
        type=int,
        nargs="*",
        default=list(ADAPTIVE_DEFAULT_POST_WINDOWS),
        help="Candidate post-event windows (minutes) for adaptive analysis.",
    )
    parser.add_argument(
        "--adaptive-dominance-ratio",
        type=float,
        default=ADAPTIVE_DEFAULT_DOMINANCE_RATIO,
        help="Share of peak move required to treat a window as dominant.",
    )
    parser.add_argument(
        "--adaptive-surprise-quantiles",
        type=float,
        nargs="*",
        default=list(ADAPTIVE_DEFAULT_SURPRISE_QUANTILES),
        help="Quantiles (0-1) that split surprise magnitude buckets.",
    )
    parser.add_argument(
        "--adaptive-min-events",
        type=int,
        default=ADAPTIVE_DEFAULT_MIN_EVENTS,
        help="Minimum events per bucket before writing adaptive summaries.",
    )
    parser.add_argument(
        "--adaptive-top-windows",
        type=int,
        default=ADAPTIVE_DEFAULT_TOP_WINDOWS,
        help="Fallback number of windows when coverage is limited.",
    )
    parser.add_argument(
        "--adaptive-min-share",
        type=float,
        default=ADAPTIVE_DEFAULT_MIN_SHARE,
        help="Minimum share (0-1) for recommending a window directly.",
    )
    parser.add_argument(
        "--adaptive-fallback-windows",
        type=int,
        nargs="*",
        default=list(ADAPTIVE_DEFAULT_FALLBACK_WINDOWS),
        help="Fallback window list when adaptive rules have insufficient data.",
    )
    parser.add_argument(
        "--adaptive-disable-deepdive",
        action="store_true",
        help="Do not override Stage B Stage C windows with adaptive results.",
    )

    parser.add_argument(
        "--priority-event-output-parquet",
        type=Path,
        default=DEFAULT_PRIORITY_EVENT_PARQUET,
        help="Parquet output for Stage C priority event scores.",
    )
    parser.add_argument(
        "--priority-event-output-csv",
        type=Path,
        default=DEFAULT_PRIORITY_EVENT_CSV,
        help="Optional CSV output for Stage C priority event scores.",
    )
    parser.add_argument(
        "--priority-no-event-csv",
        action="store_true",
        help="Skip writing the Stage C priority event CSV.",
    )
