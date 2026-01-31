# Event Impact Analysis (XAUUSD) - Design Notes

## Goal

Show historical XAUUSD price behavior around a selected USD economic event inside the Event History modal:

- A single chart that covers **pre** and **post** windows around the event time.
- A **range band** showing the historical spread of outcomes per window.
- A **best-path line** showing the direction with the highest probability per window, with the probability label at each point.
- A lightweight **Deep analysis** placeholder section describing future multi-event attribution.

This feature is designed to avoid running heavy analysis on every app launch. Analysis output is cached locally and reused.

## Data Sources

### Price data

File: `data/XAUUSD_data/XAUUSD_data.csv` (ignored by git)

- `bar_open_time_utc`: timestamp in UTC+0, format `DD-MM-YYYY HH:MM:SS.mmm`
- OHLC columns: `open, high, low, close`
- 1-minute bars (assumed)

Price definition:

```
mid = (open + high + low + close) / 4
```

### Event history

File: `<calendar_repo>/data/event_history_index/event_history_by_event.ndjson`

- Each line stores one `eventId` and a list of historical `points`.
- `points[i]` contains (at minimum): date, time, actual, forecast, previous.
- Source timezone for `date/time` is treated as UTC+8.

### Timezone unification for analysis

All analysis is computed on a unified UTC timeline:

- Price series uses `bar_open_time_utc` (UTC+0).
- Event time is parsed as UTC+8 and converted to UTC.

UI timezone selection does not change analysis results; it only affects display formatting.

## Scope

### Included

- USD events only (`eventId` starts with `USD::`).
- Events with explicit time (`HH:MM`). "All Day" points are excluded.

### Excluded

- Non-USD events.
- All Day events (no explicit time).

## Buckets (Actual vs Previous)

Single-event analysis must not mix different result directions.

For each history point:

- Parse `actual` and `previous` into comparable numbers.
- Assign the point into one of these buckets:
  - `ap_gt_prev`: actual > previous
  - `ap_lt_prev`: actual < previous
  - `ap_eq_prev`: actual == previous (optional; may be very small)

If parsing fails (e.g., `--`, `TBA`, non-numeric), skip the point.

## Event-to-price alignment

Let `event_dt_utc` be the event timestamp in UTC.

Define the baseline minute bar:

- `t0` is the first bar where `bar_open_time_utc >= event_dt_utc`.

If `t0` cannot be found in the price series, skip the point.

## Windows

Windows are symmetric around the event:

- Pre: `-12h, -4h, -1h, -30m, -15m, -5m, -1m`
- Post: `+1m, +5m, +15m, +30m, +1h, +4h, +12h`

For each window `T`, compute:

```
pct(T) = (mid(t0 + T) - mid(t0)) / mid(t0) * 100
```

If `t0 + T` does not exist (market closed / gaps), the sample is excluded for that window.

## Aggregation output per (eventId, bucket)

For each window `T`:

- `n`: number of valid samples
- `p_up`: count(pct(T) > 0) / n
- `p_down`: count(pct(T) < 0) / n
- `p10, p50, p90`: percentiles for `pct(T)` (suggested band: P10..P90)

Best-path metadata per `T`:

- `best_direction`: `"up"` or `"down"` based on max(p_up, p_down)
- `best_p`: that probability
- `best_median_pct`: median of pct(T) for samples matching `best_direction`

## UI Integration

### Single-event analysis

In Event History modal:

- Add a top toggle button: `Impact` (or `Analysis`).
- When active, show:
  - Bucket selector: `Actual > Previous`, `Actual < Previous`, optional `Actual = Previous`.
  - Single chart:
    - X axis: window offsets (pre -> event -> post)
    - Range band: P10..P90 for `pct(T)`
    - Line: best-path median pct(T)
    - Label: `Up 63%` / `Down 58%` at each point

### Deep analysis placeholder

Render a section titled `Deep analysis` with a short note:

- Future work will account for nearby/overlapping events and multi-event attribution.

## Storage & Caching

Analysis output is generated locally and stored under app data (not committed):

- Suggested path: `<appdata>/analysis/xauusd_event_impact_usd.json`

The desktop backend exposes a read API for the cached file. If missing, UI shows a message and a build action.

## Build / Verification

Rust:

- `cargo fmt --manifest-path app/tauri/src-tauri/Cargo.toml`
- `cargo clippy --manifest-path app/tauri/src-tauri/Cargo.toml -- -D warnings`

Installer:

- `app/installer/build_installer.ps1`

