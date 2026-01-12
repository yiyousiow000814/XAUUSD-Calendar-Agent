"""Wrapper to execute Stage A pipeline, event alignment, Stage B analyses, and Stage C adaptive windows."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Optional, Sequence

try:
    from .stage_workflow_args import parse_args
    from .stage_workflow_defaults import DEFAULT_ADAPTIVE_EVENTS_PARQUET, _title_set
    from .workflow import event_adaptive_window as adaptive_window
    from .workflow import event_component_decomposition as component_decomposition
    from .workflow import event_path_dependency as path_dependency
    from .workflow import event_preheat_monitor as preheat_monitor
    from .workflow import event_price_deepdive
    from .workflow import event_priority_routing as priority_routing
    from .workflow import event_prototype_analysis as prototype_analysis
    from .workflow import event_trend_analysis as trend_analysis
    from .workflow import event_uncertainty_analysis as uncertainty_analysis
    from .workflow.calendar_price_pipeline import CalendarPriceConfig, run_pipeline
    from .workflow.event_price_alignment import AlignmentConfig, run_alignment
except ImportError:  # pragma: no cover - allow running as a standalone script
    sys.path.append(str(Path(__file__).resolve().parents[2]))

    # fmt: off
    from scripts.calendar.stage_workflow_args import (
        parse_args,  # type: ignore[import-not-found]
    )
    from scripts.calendar.stage_workflow_defaults import (  # type: ignore[import-not-found]
        DEFAULT_ADAPTIVE_EVENTS_PARQUET,
        _title_set,
    )
    from scripts.calendar.workflow import (
        event_adaptive_window as adaptive_window,  # type: ignore[import-not-found]
    )
    from scripts.calendar.workflow import (
        event_component_decomposition as component_decomposition,  # type: ignore[import-not-found]
    )
    from scripts.calendar.workflow import (
        event_path_dependency as path_dependency,  # type: ignore[import-not-found]
    )
    from scripts.calendar.workflow import (
        event_preheat_monitor as preheat_monitor,  # type: ignore[import-not-found]
    )
    from scripts.calendar.workflow import (
        event_price_deepdive,  # type: ignore[import-not-found]
    )
    from scripts.calendar.workflow import (
        event_priority_routing as priority_routing,  # type: ignore[import-not-found]
    )
    from scripts.calendar.workflow import (
        event_prototype_analysis as prototype_analysis,  # type: ignore[import-not-found]
    )
    from scripts.calendar.workflow import (
        event_trend_analysis as trend_analysis,  # type: ignore[import-not-found]
    )
    from scripts.calendar.workflow import (
        event_uncertainty_analysis as uncertainty_analysis,  # type: ignore[import-not-found]
    )
    from scripts.calendar.workflow.calendar_price_pipeline import (  # type: ignore[import-not-found]
        CalendarPriceConfig,
        run_pipeline,
    )
    from scripts.calendar.workflow.event_price_alignment import (  # type: ignore[import-not-found]
        AlignmentConfig,
        run_alignment,
    )

    # fmt: on

DEEPDIVE_DEFAULT_FLAG_QUANTILE = event_price_deepdive.DEFAULT_FLAG_QUANTILE
DeepDiveConfig = event_price_deepdive.DeepDiveConfig
run_deepdive = event_price_deepdive.run_deepdive
AdaptiveWindowConfig = adaptive_window.AdaptiveWindowConfig
run_adaptive_window = adaptive_window.run_adaptive_window
ComponentConfig = component_decomposition.ComponentConfig
run_component_decomposition = component_decomposition.run_component_decomposition
COMPONENT_DEFAULT_MIN_EVENTS = component_decomposition.DEFAULT_MIN_EVENTS
PathDependencyConfig = path_dependency.PathDependencyConfig
run_path_dependency = path_dependency.run_path_dependency
PATH_DEFAULT_MIN_EVENTS = path_dependency.DEFAULT_MIN_EVENTS
PrototypeConfig = prototype_analysis.PrototypeConfig
run_prototype_analysis = prototype_analysis.run_prototype_analysis
PROTOTYPE_DEFAULT_MIN_EVENTS = prototype_analysis.DEFAULT_MIN_EVENTS
PROTOTYPE_DEFAULT_MAX_CLUSTERS = prototype_analysis.DEFAULT_MAX_CLUSTERS
PROTOTYPE_DEFAULT_RANDOM_STATE = prototype_analysis.DEFAULT_RANDOM_STATE
PreheatMonitorConfig = preheat_monitor.PreheatConfig
run_preheat_monitor = preheat_monitor.run_preheat_monitor
PREHEAT_DEFAULT_FLAG_QUANTILE = preheat_monitor.DEFAULT_FLAG_QUANTILE
TrendAnalysisConfig = trend_analysis.TrendConfig
run_trend_analysis = trend_analysis.run_trend_analysis
PriorityConfig = priority_routing.PriorityConfig
run_priority_routing = priority_routing.run_priority_routing
UncertaintyConfig = uncertainty_analysis.UncertaintyConfig
run_uncertainty_analysis = uncertainty_analysis.run_uncertainty_analysis


def main() -> None:
    args = parse_args()

    if (
        args.skip_pipeline
        and args.skip_alignment
        and args.skip_deepdive
        and args.skip_path
        and args.skip_prototypes
        and args.skip_components
        and args.skip_preheat
        and args.skip_trend
        and args.skip_adaptive
        and args.skip_priority
        and args.skip_uncertainty
    ):
        raise SystemExit("Nothing to do: all stages are skipped.")

    minutes_dir: Optional[Path] = args.minutes_dir
    datasets_by_year = None

    if not args.skip_pipeline:
        if args.price_path is None or args.calendar_dir is None:
            raise SystemExit(
                "price-path and calendar-dir must be provided for the pipeline step."
            )
        memory_only_stage_a = args.memory_only_stage_a
        pipeline_config = CalendarPriceConfig(
            price_path=args.price_path,
            calendar_dir=args.calendar_dir,
            output_dir=args.output_dir,
            start_year=args.start_year,
            end_year=args.end_year,
            pre_window=args.pre_window,
            post_window=args.post_window,
            currencies=tuple(args.currencies),
            importance_levels=tuple(args.importance),
            write_parquet=not memory_only_stage_a,
            write_csv=(not memory_only_stage_a)
            and args.pipeline_csv
            and not args.no_pipeline_csv,
            write_xlsx=(not memory_only_stage_a) and not args.no_pipeline_xlsx,
        )
        pipeline_result = run_pipeline(pipeline_config)
        datasets_by_year = pipeline_result.datasets_by_year
        if not memory_only_stage_a:
            minutes_dir = args.output_dir

    alignment_df = None
    if not args.skip_alignment:
        if datasets_by_year is None and minutes_dir is None:
            raise SystemExit(
                "Stage A outputs are required: provide --minutes-dir or run the pipeline."
            )

        alignment_pre = args.alignment_pre_window or args.pre_window
        alignment_post = args.alignment_post_window or args.post_window
        importance_values = (
            args.alignment_importance if args.alignment_importance else args.importance
        )

        alignment_config = AlignmentConfig(
            minutes_dir=minutes_dir,
            output_parquet=args.alignment_output_parquet,
            output_csv=None if args.alignment_no_csv else args.alignment_output_csv,
            start_year=args.start_year,
            end_year=args.end_year,
            pre_window=alignment_pre,
            post_window=alignment_post,
            importance_levels=_title_set(importance_values),
        )
        alignment_df = run_alignment(
            alignment_config, datasets_by_year=datasets_by_year
        )
    elif not args.skip_deepdive or not args.skip_adaptive or not args.skip_priority:
        # Deep-dive / Stage C will attempt to read the alignment parquet from disk.
        if not Path(args.alignment_output_parquet).exists():
            raise SystemExit(
                "Alignment step skipped and alignment parquet not found; cannot run Stage C/B deep-dive."
            )

    adaptive_result = None
    if not args.skip_adaptive:
        adaptive_config = AdaptiveWindowConfig(
            alignment_path=args.alignment_output_parquet,
            events_output_parquet=args.adaptive_events_output_parquet,
            events_output_csv=(
                None if args.adaptive_no_events_csv else args.adaptive_events_output_csv
            ),
            summary_output_parquet=args.adaptive_summary_output_parquet,
            summary_output_csv=(
                None
                if args.adaptive_no_summary_csv
                else args.adaptive_summary_output_csv
            ),
            recommendations_json=args.adaptive_recommendations_json,
            post_windows=args.adaptive_post_windows,
            dominance_ratio=args.adaptive_dominance_ratio,
            surprise_quantiles=args.adaptive_surprise_quantiles,
            min_events=args.adaptive_min_events,
            top_windows=args.adaptive_top_windows,
            min_share=args.adaptive_min_share,
            fallback_windows=args.adaptive_fallback_windows,
        )
        adaptive_result = run_adaptive_window(
            adaptive_config, alignment_df=alignment_df
        )

    if not args.skip_deepdive:
        deepdive_windows_kwargs: dict[str, Sequence[int]] = {}
        if args.deepdive_stage_c_windows:
            deepdive_windows_kwargs["stage_c_windows"] = tuple(
                args.deepdive_stage_c_windows
            )
        if args.deepdive_stage_d_windows:
            deepdive_windows_kwargs["stage_d_windows"] = tuple(
                args.deepdive_stage_d_windows
            )
        if args.deepdive_stage_c_windows_positive:
            deepdive_windows_kwargs["stage_c_positive_windows"] = tuple(
                args.deepdive_stage_c_windows_positive
            )
        if args.deepdive_stage_c_windows_negative:
            deepdive_windows_kwargs["stage_c_negative_windows"] = tuple(
                args.deepdive_stage_c_windows_negative
            )
        if args.deepdive_stage_d_windows_positive:
            deepdive_windows_kwargs["stage_d_positive_windows"] = tuple(
                args.deepdive_stage_d_windows_positive
            )
        if args.deepdive_stage_d_windows_negative:
            deepdive_windows_kwargs["stage_d_negative_windows"] = tuple(
                args.deepdive_stage_d_windows_negative
            )
        if (
            adaptive_result is not None
            and not args.adaptive_disable_deepdive
            and not args.deepdive_stage_c_windows
            and not args.deepdive_stage_c_windows_positive
            and not args.deepdive_stage_c_windows_negative
        ):
            recommendations = adaptive_result.recommendations
            stage_c_all = tuple(recommendations.get("all", ()))
            stage_c_pos = tuple(recommendations.get("positive", stage_c_all))
            stage_c_neg = tuple(recommendations.get("negative", stage_c_all))
            if stage_c_all:
                deepdive_windows_kwargs.setdefault("stage_c_windows", stage_c_all)
            if stage_c_pos:
                deepdive_windows_kwargs.setdefault(
                    "stage_c_positive_windows", stage_c_pos
                )
            if stage_c_neg:
                deepdive_windows_kwargs.setdefault(
                    "stage_c_negative_windows", stage_c_neg
                )

        deepdive_config = DeepDiveConfig(
            alignment_path=args.alignment_output_parquet,
            heatmap_output_parquet=args.deepdive_heatmap_output_parquet,
            heatmap_output_csv=(
                None
                if args.deepdive_no_heatmap_csv
                else args.deepdive_heatmap_output_csv
            ),
            thresholds_output_csv=args.deepdive_thresholds_output,
            flags_output_parquet=args.deepdive_flags_output_parquet,
            flags_output_csv=(
                None if args.deepdive_no_flags_csv else args.deepdive_flags_output_csv
            ),
            flag_quantile=(
                args.deepdive_flag_quantile
                if args.deepdive_flag_quantile is not None
                else DEEPDIVE_DEFAULT_FLAG_QUANTILE
            ),
            **deepdive_windows_kwargs,
        )
        run_deepdive(deepdive_config, alignment_df=alignment_df)
    elif (
        not args.skip_preheat
        or not args.skip_trend
        or not args.skip_components
        or not args.skip_prototypes
        or not args.skip_path
        or not args.skip_priority
        or not args.skip_uncertainty
    ):
        if alignment_df is None and not Path(args.alignment_output_parquet).exists():
            raise SystemExit(
                "Alignment step skipped and alignment parquet not found; cannot run Stage B analyses."
            )

    if not args.skip_components:
        component_config = ComponentConfig(
            alignment_path=args.alignment_output_parquet,
            detail_output_parquet=args.components_detail_output_parquet,
            detail_output_csv=(
                None
                if args.components_no_detail_csv
                else args.components_detail_output_csv
            ),
            summary_output_parquet=args.components_summary_output_parquet,
            summary_output_csv=(
                None
                if args.components_no_summary_csv
                else args.components_summary_output_csv
            ),
            min_events=args.components_min_events,
        )
        run_component_decomposition(component_config, alignment_df=alignment_df)

    if not args.skip_prototypes:
        prototype_config = PrototypeConfig(
            alignment_path=args.alignment_output_parquet,
            detail_output_parquet=args.prototype_detail_output_parquet,
            detail_output_csv=(
                None
                if args.prototype_no_detail_csv
                else args.prototype_detail_output_csv
            ),
            summary_output_parquet=args.prototype_summary_output_parquet,
            summary_output_csv=(
                None
                if args.prototype_no_summary_csv
                else args.prototype_summary_output_csv
            ),
            centroid_output_parquet=args.prototype_centroid_output_parquet,
            centroid_output_csv=(
                None
                if args.prototype_no_centroid_csv
                else args.prototype_centroid_output_csv
            ),
            min_events=args.prototype_min_events,
            max_clusters=args.prototype_max_clusters,
            random_state=args.prototype_random_state,
        )
        run_prototype_analysis(prototype_config, alignment_df=alignment_df)

    if not args.skip_path:
        path_config = PathDependencyConfig(
            alignment_path=args.alignment_output_parquet,
            detail_output_parquet=args.path_detail_output_parquet,
            detail_output_csv=(
                None if args.path_no_detail_csv else args.path_detail_output_csv
            ),
            summary_output_parquet=args.path_summary_output_parquet,
            summary_output_csv=(
                None if args.path_no_summary_csv else args.path_summary_output_csv
            ),
            min_events=args.path_min_events,
        )
        run_path_dependency(path_config, alignment_df=alignment_df)

    if not args.skip_preheat:
        preheat_config = PreheatMonitorConfig(
            alignment_path=args.alignment_output_parquet,
            metrics_output_parquet=args.preheat_metrics_output_parquet,
            metrics_output_csv=(
                None if args.preheat_no_metrics_csv else args.preheat_metrics_output_csv
            ),
            flags_output_parquet=args.preheat_flags_output_parquet,
            flags_output_csv=(
                None if args.preheat_no_flags_csv else args.preheat_flags_output_csv
            ),
            thresholds_output_csv=args.preheat_thresholds_output,
            summary_output_parquet=args.preheat_summary_output_parquet,
            summary_output_csv=(
                None if args.preheat_no_summary_csv else args.preheat_summary_output_csv
            ),
            pre_windows=args.preheat_pre_windows,
            volume_baselines=args.preheat_volume_baselines,
            quantiles=args.preheat_quantiles,
            flag_quantile=(
                args.preheat_flag_quantile
                if args.preheat_flag_quantile is not None
                else PREHEAT_DEFAULT_FLAG_QUANTILE
            ),
        )
        run_preheat_monitor(preheat_config, alignment_df=alignment_df)

    if not args.skip_trend:
        trend_config = TrendAnalysisConfig(
            alignment_path=args.alignment_output_parquet,
            monthly_output_parquet=args.trend_monthly_output_parquet,
            monthly_output_csv=(
                None if args.trend_no_monthly_csv else args.trend_monthly_output_csv
            ),
            summary_output_parquet=args.trend_summary_output_parquet,
            summary_output_csv=(
                None if args.trend_no_summary_csv else args.trend_summary_output_csv
            ),
            correlation_output_parquet=args.trend_correlation_output_parquet,
            correlation_output_csv=(
                None
                if args.trend_no_correlation_csv
                else args.trend_correlation_output_csv
            ),
            alias_file=args.trend_alias_file,
            auto_alias_file=args.trend_auto_alias_file,
            suggestions_file=args.trend_alias_suggestions,
            monthly_windows=args.trend_monthly_windows,
            min_events=args.trend_min_events,
            min_corr_events=args.trend_min_corr_events,
            top_corr_pairs=args.trend_top_corr_pairs,
        )
        run_trend_analysis(trend_config, alignment_df=alignment_df)

    if not args.skip_priority:
        priority_config = PriorityConfig(
            alignment_path=args.alignment_output_parquet,
            adaptive_events_path=(
                args.adaptive_events_output_parquet
                if args.adaptive_events_output_parquet is not None
                else DEFAULT_ADAPTIVE_EVENTS_PARQUET
            ),
            event_output_parquet=args.priority_event_output_parquet,
            event_output_csv=(
                None if args.priority_no_event_csv else args.priority_event_output_csv
            ),
            group_output_parquet=args.priority_group_output_parquet,
            group_output_csv=(
                None if args.priority_no_group_csv else args.priority_group_output_csv
            ),
            rules_output_json=args.priority_rules_output_json,
            importance_weight_high=args.priority_importance_weight_high,
            importance_weight_medium=args.priority_importance_weight_medium,
            importance_weight_low=args.priority_importance_weight_low,
            weight_importance=args.priority_weight_importance,
            weight_surprise=args.priority_weight_surprise,
            weight_return=args.priority_weight_return,
            weight_dominance=args.priority_weight_dominance,
            surprise_cap=args.priority_surprise_cap,
            return_cap=args.priority_return_cap,
            min_signal_strength=args.priority_min_signal_strength,
            min_group_size=args.priority_min_group_size,
            include_singletons=args.priority_include_singletons,
        )
        run_priority_routing(
            priority_config,
            alignment_df=alignment_df,
            adaptive_result=adaptive_result,
        )

    if args.skip_uncertainty:
        return

    uncertainty_config = UncertaintyConfig(
        alignment_path=args.alignment_output_parquet,
        summary_output_parquet=args.uncertainty_summary_output_parquet,
        summary_output_csv=(
            None
            if args.uncertainty_no_summary_csv
            else args.uncertainty_summary_output_csv
        ),
        calibration_output_parquet=args.uncertainty_calibration_output_parquet,
        calibration_output_csv=(
            None
            if args.uncertainty_no_calibration_csv
            else args.uncertainty_calibration_output_csv
        ),
        event_output_parquet=args.uncertainty_event_output_parquet,
        event_output_csv=(
            None if args.uncertainty_no_event_csv else args.uncertainty_event_output_csv
        ),
        windows=args.uncertainty_windows,
        quantiles=args.uncertainty_quantiles,
        calibration_bins=args.uncertainty_calibration_bins,
        min_samples=args.uncertainty_min_samples,
        min_calibration=args.uncertainty_min_calibration,
    )
    run_uncertainty_analysis(
        uncertainty_config,
        alignment_df=alignment_df,
    )


if __name__ == "__main__":
    main()
