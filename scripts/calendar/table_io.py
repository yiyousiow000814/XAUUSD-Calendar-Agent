"""Small I/O helpers for calendar pipeline tables.

Why this exists:
- Stage scripts primarily use Parquet for speed/size.
- Some Python environments (notably very new Python versions) may not have a
  Parquet engine (pyarrow/fastparquet) available.

So we:
1) Try Parquet first when asked.
2) Fall back to CSV seamlessly when Parquet isn't available.

Note: When Parquet isn't available and the caller asks to write to a `.parquet`
path, we write CSV *to the same path* (keeping the filename). This keeps
downstream paths stable during development runs.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
from typing import Iterable, Optional

import pandas as pd


def _has_parquet_engine() -> bool:
    return bool(importlib.util.find_spec("pyarrow")) or bool(
        importlib.util.find_spec("fastparquet")
    )


def read_table(
    path: Path,
    *,
    parse_dates: Optional[Iterable[str]] = None,
) -> pd.DataFrame:
    path = Path(path)
    parse_dates = tuple(parse_dates or ())

    if path.suffix.lower() == ".parquet":
        try:
            return pd.read_parquet(path)
        except Exception:
            # Parquet engine missing, file isn't parquet, or unreadable: fall back to CSV.
            df = pd.read_csv(path)
    else:
        df = pd.read_csv(path) if path.suffix.lower() == ".csv" else pd.read_parquet(path)

    for col in parse_dates:
        if col in df.columns:
            df[col] = pd.to_datetime(df[col], errors="coerce")
    return df


def write_table(df: pd.DataFrame, path: Path, *, index: bool = False) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)

    if path.suffix.lower() == ".parquet":
        if _has_parquet_engine():
            df.to_parquet(path, index=index)
            return
        # Keep the requested path stable; write as CSV content.
        df.to_csv(path, index=index)
        return

    if path.suffix.lower() == ".csv":
        df.to_csv(path, index=index)
        return

    # Default: try parquet then fallback to CSV.
    try:
        df.to_parquet(path, index=index)
    except Exception:
        df.to_csv(path, index=index)

