"""Defaults for the stage workflow CLI."""

from __future__ import annotations

from pathlib import Path
from typing import Sequence

from .workflow import event_adaptive_window as adaptive_window
from .workflow import event_component_decomposition as component_decomposition
from .workflow import event_path_dependency as path_dependency
from .workflow import event_preheat_monitor as preheat_monitor
from .workflow import event_priority_routing as priority_routing
from .workflow import event_prototype_analysis as prototype_analysis
from .workflow import event_trend_analysis as trend_analysis
from .workflow import event_uncertainty_analysis as uncertainty_analysis

DEFAULT_PRICE_PATH = Path("data/XAUUSD_1m_data/preprocessed_minutes.parquet")
DEFAULT_CALENDAR_DIR = Path("data/Economic_Calendar")
BASE_OUTPUT_DIR = Path("data/calendar_outputs")
DEFAULT_OUTPUT_DIR = BASE_OUTPUT_DIR / "minute_event_datasets"
DEFAULT_ALIGNMENT_PARQUET = (
    BASE_OUTPUT_DIR / "event_price_alignment/event_price_alignment.parquet"
)
DEFAULT_ALIGNMENT_CSV = (
    BASE_OUTPUT_DIR / "event_price_alignment/event_price_alignment.csv"
)
DEFAULT_DEEPDIVE_DIR = BASE_OUTPUT_DIR / "event_price_deepdive"
DEFAULT_DEEPDIVE_HEATMAP_PARQUET = (
    DEFAULT_DEEPDIVE_DIR / "event_response_heatmap.parquet"
)
DEFAULT_DEEPDIVE_HEATMAP_CSV = DEFAULT_DEEPDIVE_DIR / "event_response_heatmap.csv"
DEFAULT_DEEPDIVE_THRESHOLDS = DEFAULT_DEEPDIVE_DIR / "return_thresholds.csv"
DEFAULT_DEEPDIVE_FLAGS_PARQUET = DEFAULT_DEEPDIVE_DIR / "event_followup_flags.parquet"
DEFAULT_DEEPDIVE_FLAGS_CSV = DEFAULT_DEEPDIVE_DIR / "event_followup_flags.csv"
DEFAULT_PREHEAT_DIR = BASE_OUTPUT_DIR / "event_preheat_monitor"
DEFAULT_PREHEAT_METRICS_PARQUET = DEFAULT_PREHEAT_DIR / "preheat_metrics.parquet"
DEFAULT_PREHEAT_METRICS_CSV = DEFAULT_PREHEAT_DIR / "preheat_metrics.csv"
DEFAULT_PREHEAT_FLAGS_PARQUET = DEFAULT_PREHEAT_DIR / "preheat_flags.parquet"
DEFAULT_PREHEAT_FLAGS_CSV = DEFAULT_PREHEAT_DIR / "preheat_flags.csv"
DEFAULT_PREHEAT_THRESHOLDS = DEFAULT_PREHEAT_DIR / "preheat_thresholds.csv"
DEFAULT_PREHEAT_SUMMARY_PARQUET = DEFAULT_PREHEAT_DIR / "preheat_summary.parquet"
DEFAULT_PREHEAT_SUMMARY_CSV = DEFAULT_PREHEAT_DIR / "preheat_summary.csv"
DEFAULT_COMPONENT_DIR = BASE_OUTPUT_DIR / "component_decomposition"
DEFAULT_COMPONENT_DETAIL_PARQUET = DEFAULT_COMPONENT_DIR / "component_breakdown.parquet"
DEFAULT_COMPONENT_DETAIL_CSV = DEFAULT_COMPONENT_DIR / "component_breakdown.csv"
DEFAULT_COMPONENT_SUMMARY_PARQUET = DEFAULT_COMPONENT_DIR / "component_summary.parquet"
DEFAULT_COMPONENT_SUMMARY_CSV = DEFAULT_COMPONENT_DIR / "component_summary.csv"
COMPONENT_DEFAULT_MIN_EVENTS = component_decomposition.DEFAULT_MIN_EVENTS
DEFAULT_PATH_DIR = BASE_OUTPUT_DIR / "path_dependency"
DEFAULT_PATH_DETAIL_PARQUET = DEFAULT_PATH_DIR / "path_dependency_events.parquet"
DEFAULT_PATH_DETAIL_CSV = DEFAULT_PATH_DIR / "path_dependency_events.csv"
DEFAULT_PATH_SUMMARY_PARQUET = DEFAULT_PATH_DIR / "path_dependency_summary.parquet"
DEFAULT_PATH_SUMMARY_CSV = DEFAULT_PATH_DIR / "path_dependency_summary.csv"
PATH_DEFAULT_MIN_EVENTS = path_dependency.DEFAULT_MIN_EVENTS
DEFAULT_PROTOTYPE_DIR = BASE_OUTPUT_DIR / "event_prototypes"
DEFAULT_PROTOTYPE_DETAIL_PARQUET = (
    DEFAULT_PROTOTYPE_DIR / "event_prototype_events.parquet"
)
DEFAULT_PROTOTYPE_DETAIL_CSV = DEFAULT_PROTOTYPE_DIR / "event_prototype_events.csv"
DEFAULT_PROTOTYPE_SUMMARY_PARQUET = (
    DEFAULT_PROTOTYPE_DIR / "event_prototype_summary.parquet"
)
DEFAULT_PROTOTYPE_SUMMARY_CSV = DEFAULT_PROTOTYPE_DIR / "event_prototype_summary.csv"
DEFAULT_PROTOTYPE_CENTROID_PARQUET = (
    DEFAULT_PROTOTYPE_DIR / "event_prototype_centroids.parquet"
)
DEFAULT_PROTOTYPE_CENTROID_CSV = DEFAULT_PROTOTYPE_DIR / "event_prototype_centroids.csv"
PROTOTYPE_DEFAULT_MIN_EVENTS = prototype_analysis.DEFAULT_MIN_EVENTS
PROTOTYPE_DEFAULT_MAX_CLUSTERS = prototype_analysis.DEFAULT_MAX_CLUSTERS
PROTOTYPE_DEFAULT_RANDOM_STATE = prototype_analysis.DEFAULT_RANDOM_STATE
DEFAULT_CURRENCIES = ("USD",)
PREHEAT_DEFAULT_FLAG_QUANTILE = preheat_monitor.DEFAULT_FLAG_QUANTILE
PREHEAT_DEFAULT_PRE_WINDOWS = preheat_monitor.DEFAULT_PRE_WINDOWS
PREHEAT_DEFAULT_VOLUME_BASELINES = preheat_monitor.DEFAULT_VOLUME_BASELINES
PREHEAT_DEFAULT_QUANTILES = preheat_monitor.DEFAULT_QUANTILES
PreheatMonitorConfig = preheat_monitor.PreheatConfig
run_preheat_monitor = preheat_monitor.run_preheat_monitor
DEFAULT_TREND_DIR = BASE_OUTPUT_DIR / "event_trend_analysis"
DEFAULT_TREND_MONTHLY_PARQUET = DEFAULT_TREND_DIR / "trend_monthly_metrics.parquet"
DEFAULT_TREND_MONTHLY_CSV = DEFAULT_TREND_DIR / "trend_monthly_metrics.csv"
DEFAULT_TREND_SUMMARY_PARQUET = DEFAULT_TREND_DIR / "trend_event_summary.parquet"
DEFAULT_TREND_SUMMARY_CSV = DEFAULT_TREND_DIR / "trend_event_summary.csv"
DEFAULT_TREND_CORR_PARQUET = DEFAULT_TREND_DIR / "trend_correlation_pairs.parquet"
DEFAULT_TREND_CORR_CSV = DEFAULT_TREND_DIR / "trend_correlation_pairs.csv"
DEFAULT_TREND_ALIAS_FILE = DEFAULT_TREND_DIR / "indicator_aliases.csv"
DEFAULT_TREND_AUTO_ALIAS_FILE = DEFAULT_TREND_DIR / "auto_aliases.csv"
DEFAULT_TREND_ALIAS_SUGGESTIONS = DEFAULT_TREND_DIR / "alias_suggestions.csv"
TREND_DEFAULT_MONTHLY_WINDOWS = trend_analysis.DEFAULT_MONTHLY_WINDOWS
TREND_DEFAULT_MIN_EVENTS = trend_analysis.DEFAULT_MIN_EVENTS
TREND_DEFAULT_MIN_CORR_EVENTS = trend_analysis.DEFAULT_MIN_CORR_EVENTS
TREND_DEFAULT_TOP_CORR = trend_analysis.DEFAULT_TOP_CORR
TrendAnalysisConfig = trend_analysis.TrendConfig
run_trend_analysis = trend_analysis.run_trend_analysis

DEFAULT_IMPORTANCE = ("Medium", "High")

AdaptiveWindowConfig = adaptive_window.AdaptiveWindowConfig
run_adaptive_window = adaptive_window.run_adaptive_window
DEFAULT_ADAPTIVE_EVENTS_PARQUET = (
    BASE_OUTPUT_DIR / "event_adaptive_window/adaptive_window_events.parquet"
)
DEFAULT_ADAPTIVE_EVENTS_CSV = (
    BASE_OUTPUT_DIR / "event_adaptive_window/adaptive_window_events.csv"
)
DEFAULT_ADAPTIVE_SUMMARY_PARQUET = (
    BASE_OUTPUT_DIR / "event_adaptive_window/adaptive_window_summary.parquet"
)
DEFAULT_ADAPTIVE_SUMMARY_CSV = (
    BASE_OUTPUT_DIR / "event_adaptive_window/adaptive_window_summary.csv"
)
DEFAULT_ADAPTIVE_RECOMMENDATIONS = (
    BASE_OUTPUT_DIR / "event_adaptive_window/adaptive_window_recommendations.json"
)
ADAPTIVE_DEFAULT_POST_WINDOWS = adaptive_window.DEFAULT_POST_WINDOWS
ADAPTIVE_DEFAULT_DOMINANCE_RATIO = adaptive_window.DEFAULT_DOMINANCE_RATIO
ADAPTIVE_DEFAULT_SURPRISE_QUANTILES = adaptive_window.DEFAULT_SURPRISE_QUANTILES
ADAPTIVE_DEFAULT_MIN_EVENTS = adaptive_window.DEFAULT_MIN_EVENTS
ADAPTIVE_DEFAULT_TOP_WINDOWS = adaptive_window.DEFAULT_TOP_WINDOWS
ADAPTIVE_DEFAULT_MIN_SHARE = adaptive_window.DEFAULT_MIN_SHARE
ADAPTIVE_DEFAULT_FALLBACK_WINDOWS = adaptive_window.DEFAULT_FALLBACK_WINDOWS

PriorityConfig = priority_routing.PriorityConfig
run_priority_routing = priority_routing.run_priority_routing
DEFAULT_PRIORITY_EVENT_PARQUET = (
    BASE_OUTPUT_DIR / "event_priority_routing/priority_event_scores.parquet"
)
DEFAULT_PRIORITY_EVENT_CSV = (
    BASE_OUTPUT_DIR / "event_priority_routing/priority_event_scores.csv"
)
DEFAULT_PRIORITY_GROUP_PARQUET = (
    BASE_OUTPUT_DIR / "event_priority_routing/priority_group_resolutions.parquet"
)
DEFAULT_PRIORITY_GROUP_CSV = (
    BASE_OUTPUT_DIR / "event_priority_routing/priority_group_resolutions.csv"
)
DEFAULT_PRIORITY_RULES_JSON = (
    BASE_OUTPUT_DIR / "event_priority_routing/priority_rules.json"
)
PRIORITY_DEFAULT_MIN_GROUP_SIZE = priority_routing.DEFAULT_MIN_GROUP_SIZE
PRIORITY_DEFAULT_MIN_SIGNAL = priority_routing.DEFAULT_MIN_SIGNAL
PRIORITY_DEFAULT_IMPORTANCE_HIGH = priority_routing.DEFAULT_IMPORTANCE_WEIGHTS["High"]
PRIORITY_DEFAULT_IMPORTANCE_MEDIUM = priority_routing.DEFAULT_IMPORTANCE_WEIGHTS[
    "Medium"
]
PRIORITY_DEFAULT_IMPORTANCE_LOW = priority_routing.DEFAULT_IMPORTANCE_WEIGHTS["Low"]
PRIORITY_DEFAULT_WEIGHT_IMPORTANCE = priority_routing.DEFAULT_WEIGHT_IMPORTANCE
PRIORITY_DEFAULT_WEIGHT_SURPRISE = priority_routing.DEFAULT_WEIGHT_SURPRISE
PRIORITY_DEFAULT_WEIGHT_RETURN = priority_routing.DEFAULT_WEIGHT_RETURN
PRIORITY_DEFAULT_WEIGHT_DOMINANCE = priority_routing.DEFAULT_WEIGHT_DOMINANCE
PRIORITY_DEFAULT_SURPRISE_CAP = priority_routing.DEFAULT_SURPRISE_CAP
PRIORITY_DEFAULT_RETURN_CAP = priority_routing.DEFAULT_RETURN_CAP

UncertaintyConfig = uncertainty_analysis.UncertaintyConfig
run_uncertainty_analysis = uncertainty_analysis.run_uncertainty_analysis
DEFAULT_UNCERTAINTY_SUMMARY_PARQUET = (
    BASE_OUTPUT_DIR / "event_uncertainty/uncertainty_interval_summary.parquet"
)
DEFAULT_UNCERTAINTY_SUMMARY_CSV = (
    BASE_OUTPUT_DIR / "event_uncertainty/uncertainty_interval_summary.csv"
)
DEFAULT_UNCERTAINTY_CALIBRATION_PARQUET = (
    BASE_OUTPUT_DIR / "event_uncertainty/uncertainty_calibration_summary.parquet"
)
DEFAULT_UNCERTAINTY_CALIBRATION_CSV = (
    BASE_OUTPUT_DIR / "event_uncertainty/uncertainty_calibration_summary.csv"
)
DEFAULT_UNCERTAINTY_EVENT_PARQUET = (
    BASE_OUTPUT_DIR / "event_uncertainty/uncertainty_event_predictions.parquet"
)
DEFAULT_UNCERTAINTY_EVENT_CSV = (
    BASE_OUTPUT_DIR / "event_uncertainty/uncertainty_event_predictions.csv"
)
UNCERTAINTY_DEFAULT_WINDOWS = uncertainty_analysis.DEFAULT_WINDOWS
UNCERTAINTY_DEFAULT_QUANTILES = uncertainty_analysis.DEFAULT_QUANTILES
UNCERTAINTY_DEFAULT_CALIBRATION_BINS = uncertainty_analysis.DEFAULT_CALIBRATION_BINS
UNCERTAINTY_DEFAULT_MIN_SAMPLES = uncertainty_analysis.DEFAULT_MIN_SAMPLES
UNCERTAINTY_DEFAULT_MIN_CALIBRATION = uncertainty_analysis.DEFAULT_MIN_CALIBRATION


def _title_set(values: Sequence[str]) -> set[str]:
    return {value.title() for value in values}
