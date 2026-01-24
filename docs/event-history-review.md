# Event History Review & Manual Patching

This repository maintains a derived "event history index" under `data/event_history_index/` to power the Event history UI and to support manual QA.

## Outputs (generated)

Run:

```bash
python scripts/calendar/build_event_history_index.py
```

This generates:

1. Per-year index (backend fallback):
   - `YYYY_event_history_index.csv`
2. Per-year clean history (for manual review):
   - `YYYY_event_history_clean.csv`
3. Issue reports (for manual review):
   - All: `YYYY_event_history_issues.csv` / `YYYY_event_history_issues.json`
   - Open: `YYYY_event_history_issues_open.csv` / `YYYY_event_history_issues_open.json`
   - Solved: `YYYY_event_history_issues_solved.csv` / `YYYY_event_history_issues_solved.json`
4. Auto patch suggestions (previous fill opportunities):
   - `YYYY_event_history_previous_patch.csv` / `YYYY_event_history_previous_patch.json`
5. Backend lookup files:
   - `event_history_by_event.ndjson`
   - `event_history_by_event.index.json`

Notes:

- "Clean" data may exclude some rows (for example: releases that remain missing `Actual` for more than 2 days).
- The UI reads from the `event_history_by_event.*` files, so rebuilding the index is required after you change the pipeline or apply manual patches.

## Automatic checks (problem detection channels)

1. Index build-time detection (local / CI usage)
   - `scripts/calendar/build_event_history_index.py` flags issues while rebuilding the index and writes them into `*_event_history_issues*`.

## Manual review workflow

1. Start with open issues:

   - `data/event_history_index/*_event_history_issues_open.csv`

2. Investigate the underlying raw calendar row(s) under:

   - `data/Economic_Calendar/YYYY/YYYY_calendar.json`

3. Decide whether to patch the clean index.

## Manual patching

Manual patch input:

- `data/event_history_index/event_history_manual_patch.csv`

Expected columns:

- `EventId`, `Date`, `Time`, `Period`, `Actual`, `Forecast`, `Previous`, `Reason`

Rules:

- Use `Date` in `DD-MM-YYYY` (recommended). `YYYY-MM-DD` is accepted for convenience.
- `Time` uses `HH:MM` (24-hour). Leave it blank only if the target row also has an empty time.
- `Period` is optional. It is only used when the event name includes a quarter/half token (e.g., `Q4`).
- Only fill the fields you want to override (`Actual` / `Forecast` / `Previous`). Leave the others blank.

Apply patches:

```bash
python scripts/calendar/build_event_history_index.py
```

Applied patch reports:

- `YYYY_event_history_manual_patch_applied.csv` / `YYYY_event_history_manual_patch_applied.json`

These reports are the canonical "what was overridden and why" record for review.
