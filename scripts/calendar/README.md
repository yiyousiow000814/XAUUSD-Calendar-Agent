[English](README.md) | [中文](README.zh-CN.md)

# Calendar Utilities

This folder contains scripts and workflows for:
- Fetching and refreshing economic calendar data into `data/Economic_Calendar/<year>/`.
- Building minute-level price × event datasets for downstream analysis.
- Running Stage A/B/C workflows that generate analysis outputs under `data/calendar_outputs/`.

## Scripts Overview
- `economic_calendar_fetcher.py`: Fetches economic calendar data for a date range and writes yearly files under `data/Economic_Calendar/<year>/`.
- `preprocess_price_minutes.py`: Converts trade/tick CSV input into continuous 1-minute bars (UTC+8) for Stage A.
- `run_stage_workflow.py`: A convenience runner that chains common Stage A/B steps with a consistent CLI.
- `workflow/calendar_price_pipeline.py` (Stage A): Aligns minute bars with economic events and produces a unified feature dataset.
- `workflow/event_price_alignment.py` (Stage A): Aggregates pre/post-event price behavior for later stages.
- `workflow/event_price_deepdive.py` (Stage B): Produces event deep-dive outputs (response tables, thresholds, follow-up flags).
- `workflow/event_component_decomposition.py` (Stage B): Decomposes event components (core vs non-core, sub-items) when applicable.
- `workflow/event_path_dependency.py` (Stage B): Measures directional persistence / reversal patterns across consecutive surprises.
- `workflow/event_preheat_monitor.py` (Stage B): Detects possible “preheat/leak” behavior before releases.
- `workflow/event_trend_analysis.py` (Stage B): Builds long-horizon indicator trend and correlation summaries.
- `workflow/event_adaptive_window.py` (Stage C): Suggests adaptive post-event observation windows by surprise strength.
- `workflow/event_priority_routing.py` (Stage C): Generates priority and conflict-resolution rules for simultaneous events.
- `workflow/event_uncertainty_analysis.py` (Stage C): Produces interval / calibration summaries for predictive uncertainty.

## Fetch Economic Calendar Data
```bash
python scripts/calendar/economic_calendar_fetcher.py --start-date 2025-01-01 --end-date 2025-01-07
```

Notes:
- By default, the fetcher merges new rows into existing exports without deleting existing rows inside the date window.
- JSON exports normalize missing values to `null` to keep diffs stable across runs.
- To reduce 429 rate limits, set `CALENDAR_HTTP_MIN_INTERVAL_SECONDS` (for example `2`) and increase the pagination delay (for example `CALENDAR_PAGE_DELAY_MIN_SECONDS=5` and `CALENDAR_PAGE_DELAY_MAX_SECONDS=7`).
- To troubleshoot rate limiting and paging, set `CALENDAR_HTTP_STATS=1` to print request rate stats and paging stop reasons.
- If you enable pruning inside the date window, the prune guard (`CALENDAR_PRUNE_GUARD_RATIO`, `CALENDAR_PRUNE_GUARD_MIN_NEW_NONHOLIDAY`) prevents accidental data loss when upstream results are incomplete.

Outputs are written to:
- `data/Economic_Calendar/<year>/<year>_calendar.json`
- `data/Economic_Calendar/<year>/<year>_calendar.csv`
- `data/Economic_Calendar/<year>/<year>_calendar.xlsx`

## Run Stage A Quickly
```bash
python scripts/calendar/run_stage_workflow.py \
  --price-path data/XAUUSD_1m_data/preprocessed_minutes.parquet \
  --calendar-dir data/Economic_Calendar \
  --output-dir data/calendar_outputs/minute_event_datasets \
  --start-year 2020 --end-year 2020 \
  --currencies USD \
  --pre-window 1440 --post-window 1440
```

Notes:
- The runner can chain: Stage A pipeline → alignment → Stage B modules (deep-dive / preheat / trends / etc.).
- Use `--skip-pipeline`, `--skip-alignment`, `--skip-deepdive`, `--skip-preheat`, `--skip-trend`, `--skip-components`, `--skip-path`, `--skip-prototypes`, `--skip-adaptive` to skip steps.
- When running alignment/deep-dive/preheat/trend without Stage A, provide `--minutes-dir` pointing to Stage A outputs.
- If you want Stage A to stay in memory, use `--memory-only-stage-a`. CSV output is optional and can be very large.

## Outputs
Most workflows write to subfolders under `data/calendar_outputs/` (for example `minute_event_datasets/`, `event_price_alignment/`, `event_price_deepdive/`).

## Stage A: Price × Event Pipeline
```bash
python scripts/calendar/workflow/calendar_price_pipeline.py \
  --price-path data/XAUUSD_1m_data/preprocessed_minutes.parquet \
  --calendar-dir data/Economic_Calendar \
  --output-dir data/calendar_outputs/minute_event_datasets \
  --start-year 2020 --end-year 2020 \
  --currencies USD \
  --pre-window 1440 --post-window 1440
```

Outputs (per year) typically include:
- `data/calendar_outputs/minute_event_datasets/<year>/xauusd_minutes_with_events.parquet`
- Optional CSV (can be very large): `.../xauusd_minutes_with_events.csv` (enable with `--csv`)
- Optional sample workbook: `.../xauusd_minutes_with_events_sample.xlsx`

The dataset includes fields such as `event_stage`, `minutes_from_event`, and `surprise`, which serve as the shared input for Stage B/C workflows.

## Stage A: Event ↔ Price Alignment
```bash
python scripts/calendar/workflow/event_price_alignment.py \
  --minutes-dir data/calendar_outputs/minute_event_datasets \
  --output-parquet data/calendar_outputs/event_price_alignment/event_price_alignment.parquet \
  --start-year 2020 --end-year 2020 \
  --pre-window 1440 --post-window 1440
```

This step summarizes price behavior around Medium/High events and produces `event_price_alignment.*` with:
- Event metadata and timestamps
- Pre/post returns across multiple windows
- Volatility and volume context
- Normalized surprise/revision percentages and scenario tags
- Joint-event grouping fields for multiple releases in the same minute

## Stage B: Deep-Dive (Event Response)
```bash
python scripts/calendar/workflow/event_price_deepdive.py \
  --alignment-path data/calendar_outputs/event_price_alignment/event_price_alignment.parquet \
  --heatmap-output-parquet data/calendar_outputs/event_price_deepdive/event_response_heatmap.parquet \
  --thresholds-output-csv data/calendar_outputs/event_price_deepdive/return_thresholds.csv \
  --flags-output-parquet data/calendar_outputs/event_price_deepdive/event_followup_flags.parquet
```

Tuning:
- `--deepdive-flag-quantile` adjusts follow-up sensitivity.
- Use `--deepdive-no-heatmap-csv` / `--deepdive-no-flags-csv` to control extra outputs.

## Stage B: Component Decomposition
```bash
python scripts/calendar/workflow/event_component_decomposition.py \
  --alignment-path data/calendar_outputs/event_price_alignment/event_price_alignment.parquet
```

This module compares the direction/impact share across event variants (for example core vs non-core, and selected sub-components).

## Stage B: Path Dependency
```bash
python scripts/calendar/workflow/event_path_dependency.py \
  --alignment-path data/calendar_outputs/event_price_alignment/event_price_alignment.parquet
```

This module measures whether consecutive surprises show momentum vs fatigue, and writes aggregated summaries for later review.

## Stage B: Event Clusters / Prototypes
`run_stage_workflow.py` can generate prototype/clustering artifacts from the alignment/deep-dive outputs.

## Stage B: Preheat/Leak Monitor
```bash
python scripts/calendar/workflow/event_preheat_monitor.py \
  --alignment-path data/calendar_outputs/event_price_alignment/event_price_alignment.parquet
```

Tuning:
- `--preheat-pre-windows`, `--preheat-volume-baselines`, `--preheat-flag-quantile` control windows and alert sensitivity.
- `--preheat-no-*-csv` flags control optional CSV outputs.

## Stage B: Indicator Trend Analysis
```bash
python scripts/calendar/workflow/event_trend_analysis.py \
  --alignment-path data/calendar_outputs/event_price_alignment/event_price_alignment.parquet \
  --summary-output-parquet data/calendar_outputs/event_trend_analysis/trend_event_summary.parquet \
  --correlation-output-parquet data/calendar_outputs/event_trend_analysis/trend_correlation_pairs.parquet
```

This module aggregates indicators monthly and writes:
- Alias suggestions (to help normalize naming)
- Rolling averages and YoY-style changes
- Trend/correlation summaries for later inspection

Tuning:
- `--trend-monthly-windows`, `--trend-min-events`, `--trend-top-corr-pairs` control output size and thresholds.
- `--trend-no-*-csv` flags control optional CSV outputs.

## Stage C: Adaptive Window
```bash
python scripts/calendar/workflow/event_adaptive_window.py \
  --alignment-path data/calendar_outputs/event_price_alignment/event_price_alignment.parquet
```

Outputs include:
- `adaptive_window_events.*` (per-event metrics and peak window)
- `adaptive_window_summary.*` (aggregated distributions by currency/importance/surprise)
- `adaptive_window_recommendations.json` (recommended windows)

## Stage C: Priority Routing
```bash
python scripts/calendar/workflow/event_priority_routing.py \
  --alignment-path data/calendar_outputs/event_price_alignment/event_price_alignment.parquet \
  --adaptive-events-path data/calendar_outputs/event_adaptive_window/adaptive_window_events.parquet
```

Outputs include:
- `priority_event_scores.*` (per-event scores and priority)
- `priority_group_resolutions.*` (conflict resolution for simultaneous releases)
- `priority_rules.json` (weights/config for later loading)

## Stage C: Predictive Uncertainty
```bash
python scripts/calendar/workflow/event_uncertainty_analysis.py \
  --alignment-path data/calendar_outputs/event_price_alignment/event_price_alignment.parquet
```

Outputs include:
- `uncertainty_interval_summary.*` (interval summaries per event/window)
- `uncertainty_calibration_summary.*` (calibration summaries)
- `uncertainty_event_predictions.*` (per-event predictions vs outcomes)

## Further Work
- Explain volatility without events: label moves not explained by Forecast/Actual and categorize patterns.
- News-driven moves: expand news collection and classification to capture non-calendar catalysts.
- News clues for event interpretation: link major releases to related news/expectation narratives.
- “News vacuum” radar: detect elevated volatility when both events and news are quiet.

## Notes
- Prefer Parquet outputs for large runs; enabling full CSV outputs can create multi-GB files.
