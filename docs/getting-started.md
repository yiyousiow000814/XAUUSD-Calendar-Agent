# Getting Started

## Data Source Setup
1. Prepare your economic calendar data in the required JSON format (see below).
2. Configure the repository path in the application settings.
3. Ensure your data follows the expected directory structure: `data/Economic_Calendar/<year>/<year>_calendar.json`

### If you don't have your own data source
You can use the built-in dataset shipped with this repository (`data/Economic_Calendar`):

- The repository updates the `data/Economic_Calendar` events data once per day via GitHub Actions at 15:30 UTC (23:30 UTC+8).
- The app checks for updates every 6 hours and updates automatically.
- If the app detects the data is older than 1 day, it triggers an automatic update.
- The app also performs this check on startup and updates automatically when needed.

### What "Temporary Path (Working Copy)" is for
`Temporary Path` is an optional separate working copy used for automated pull/sync so your Main Path stays read-only:

- When enabled, the app clones/pulls the Git repo into `Temporary Path` and reads calendar data from there.
- This avoids overwriting your Main Path (for example, your local dev checkout).
- It is off by default. Turn it on only if you need the app to manage a separate working copy.

## Data Format
The application expects economic calendar data in JSON format with the following structure:

```json
[
  {
    "Date": "2026-01-15",
    "Time": "14:30",
    "Event": "Retail Sales m/m",
    "Cur.": "USD",
    "Imp.": "High",
    "Actual": "0.3%",
    "Forecast": "0.2%",
    "Previous": "0.4%"
  },
  {
    "Date": "2026-01-15",
    "Time": "All Day",
    "Event": "New Year Holiday",
    "Cur.": "USD",
    "Imp.": "Holiday"
  }
]
```

### Required Fields
- `Date`: Date string in `YYYY-MM-DD` format
- `Event`: Name of the economic event

### Optional Fields
- `Time`: Time string in `HH:MM` format (24-hour) or `All Day`
- `Cur.`: Currency code (e.g., `USD`, `EUR`)
- `Imp.`: Importance level (`High`, `Medium`, `Low`, `Holiday`)
- `Actual`: Actual released value
- `Forecast`: Predicted value
- `Previous`: Previous period value

### Directory Structure
```text
<repository_path>/
└── data/
    └── Economic_Calendar/
        ├── 2025/
        │   └── 2025_calendar.json
        ├── 2026/
        │   └── 2026_calendar.json
        └── ...
```

## Development Setup

### Prerequisites
- Python 3.9+
- pip package manager
