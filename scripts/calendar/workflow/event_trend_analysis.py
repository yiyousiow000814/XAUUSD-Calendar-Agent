"""Stage B trend analysis: evaluate indicator trends, seasonality, and predictive signals."""

from __future__ import annotations

import argparse
import math
import re
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path
from typing import Optional, Sequence

import numpy as np
import pandas as pd

BASE_OUTPUT_DIR = Path("data/calendar_outputs/event_trend_analysis")
DEFAULT_ALIGNMENT_PATH = Path(
    "data/calendar_outputs/event_price_alignment/event_price_alignment.parquet"
)
DEFAULT_MONTHLY_OUTPUT = BASE_OUTPUT_DIR / "trend_monthly_metrics.parquet"
DEFAULT_MONTHLY_CSV = BASE_OUTPUT_DIR / "trend_monthly_metrics.csv"
DEFAULT_SUMMARY_OUTPUT = BASE_OUTPUT_DIR / "trend_event_summary.parquet"
DEFAULT_SUMMARY_CSV = BASE_OUTPUT_DIR / "trend_event_summary.csv"
DEFAULT_CORR_OUTPUT = BASE_OUTPUT_DIR / "trend_correlation_pairs.parquet"
DEFAULT_CORR_CSV = BASE_OUTPUT_DIR / "trend_correlation_pairs.csv"
DEFAULT_ALIAS_FILE = BASE_OUTPUT_DIR / "indicator_aliases.csv"
DEFAULT_AUTO_ALIAS_FILE = BASE_OUTPUT_DIR / "auto_aliases.csv"
DEFAULT_ALIAS_SUGGESTIONS = BASE_OUTPUT_DIR / "alias_suggestions.csv"

DEFAULT_MONTHLY_WINDOWS = (3, 6, 12)
DEFAULT_MIN_EVENTS = 12
DEFAULT_MIN_CORR_EVENTS = 24
DEFAULT_TOP_CORR = 50
AUTO_MERGE_THRESHOLD = 0.97
SUGGESTION_THRESHOLD = 0.9
MONTH_SUFFIX = re.compile(
    r"\s*\((jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec"
    r"|january|february|march|april|june|july|august|september|october|november|december)"
    r"\b[^)]*\)",
    flags=re.IGNORECASE,
)
TOKENIZER = re.compile(r"[^a-z0-9]+")


@dataclass
class TrendConfig:
    alignment_path: Path
    monthly_output_parquet: Path
    monthly_output_csv: Optional[Path]
    summary_output_parquet: Path
    summary_output_csv: Optional[Path]
    correlation_output_parquet: Path
    correlation_output_csv: Optional[Path]
    alias_file: Path
    auto_alias_file: Path
    suggestions_file: Path
    monthly_windows: Sequence[int]
    min_events: int
    min_corr_events: int
    top_corr_pairs: int

    def __post_init__(self) -> None:
        self.alignment_path = self.alignment_path.expanduser().resolve()
        self.monthly_output_parquet = self.monthly_output_parquet.expanduser().resolve()
        if self.monthly_output_csv is not None:
            self.monthly_output_csv = self.monthly_output_csv.expanduser().resolve()
        self.summary_output_parquet = self.summary_output_parquet.expanduser().resolve()
        if self.summary_output_csv is not None:
            self.summary_output_csv = self.summary_output_csv.expanduser().resolve()
        self.correlation_output_parquet = (
            self.correlation_output_parquet.expanduser().resolve()
        )
        if self.correlation_output_csv is not None:
            self.correlation_output_csv = (
                self.correlation_output_csv.expanduser().resolve()
            )
        self.alias_file = self.alias_file.expanduser().resolve()
        self.auto_alias_file = self.auto_alias_file.expanduser().resolve()
        self.suggestions_file = self.suggestions_file.expanduser().resolve()
        self.monthly_windows = tuple(
            sorted({int(w) for w in self.monthly_windows if w > 0})
        )
        if not self.monthly_windows:
            raise ValueError("monthly_windows must contain positive integers")
        if self.min_events <= 0:
            raise ValueError("min_events must be positive")
        if self.min_corr_events <= 0:
            raise ValueError("min_corr_events must be positive")
        if self.top_corr_pairs <= 0:
            raise ValueError("top_corr_pairs must be positive")


@dataclass
class TrendResult:
    monthly_metrics: pd.DataFrame
    event_summary: pd.DataFrame
    correlation_pairs: pd.DataFrame


def _normalise_indicator(name: str) -> str:
    if not isinstance(name, str):
        return name
    return MONTH_SUFFIX.sub("", name).strip()


def _slugify(name: str) -> str:
    lowered = name.lower()
    return TOKENIZER.sub("", lowered)


def _tokenize(name: str) -> list[str]:
    return [token for token in TOKENIZER.split(name.lower()) if token]


def _read_manual_aliases(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    try:
        df = pd.read_csv(path)
    except Exception:
        return {}
    required = {"alias", "canonical_name"}
    if not required.issubset(df.columns):
        return {}
    mapping: dict[str, str] = {}
    for alias, canonical in zip(df["alias"], df["canonical_name"]):
        if not isinstance(alias, str) or not isinstance(canonical, str):
            continue
        alias = alias.strip()
        canonical = canonical.strip()
        if alias:
            mapping[alias] = canonical or alias
    return mapping


def _build_alias_map(
    names: Sequence[str],
    counts: dict[str, int],
    manual_aliases: dict[str, str],
) -> tuple[dict[str, str], pd.DataFrame, pd.DataFrame]:
    unique_names = sorted({n for n in names if isinstance(n, str) and n.strip()})
    if not unique_names:
        return {}, pd.DataFrame(), pd.DataFrame()

    all_labels = sorted(
        set(unique_names) | set(manual_aliases.keys()) | set(manual_aliases.values())
    )
    parent = {label: label for label in all_labels}
    rank = {label: 0 for label in all_labels}

    def find(x: str) -> str:
        parent.setdefault(x, x)
        if parent[x] != x:
            parent[x] = find(parent[x])
        return parent[x]

    def union(a: str, b: str, reason: str) -> None:
        ra, rb = find(a), find(b)
        if ra == rb:
            return
        if rank[ra] < rank[rb]:
            ra, rb = rb, ra
        parent[rb] = ra
        if rank[ra] == rank[rb]:
            rank[ra] += 1

    for alias, canonical in manual_aliases.items():
        union(alias, canonical, "manual")

    slug_map: dict[str, str] = {}
    auto_records: list[dict[str, str]] = []

    for name in unique_names:
        slug = _slugify(name)
        if not slug:
            continue
        other = slug_map.get(slug)
        if other:
            union(name, other, "slug")
            auto_records.append({"alias": name, "canonical": other, "reason": "slug"})
        else:
            slug_map[slug] = name

    token_groups: dict[str, list[str]] = {}
    for name in unique_names:
        tokens = _tokenize(name)
        key = " ".join(tokens[:2]) if tokens else name.lower()
        token_groups.setdefault(key, []).append(name)

    suggestions: dict[tuple[str, str], dict[str, object]] = {}

    for group in token_groups.values():
        if len(group) < 2:
            continue
        group = sorted(set(group))
        for idx in range(len(group)):
            for jdx in range(idx):
                a = group[jdx]
                b = group[idx]
                ratio = SequenceMatcher(None, a.lower(), b.lower()).ratio()
                if ratio >= AUTO_MERGE_THRESHOLD:
                    union(a, b, "auto_similarity")
                    auto_records.append(
                        {
                            "alias": a,
                            "canonical": b,
                            "reason": f"auto_similarity:{ratio:.3f}",
                        }
                    )
                elif ratio >= SUGGESTION_THRESHOLD:
                    key = tuple(sorted((a, b)))
                    existing = suggestions.get(key)
                    entry = {
                        "name_a": key[0],
                        "name_b": key[1],
                        "similarity": round(ratio, 3),
                        "count_a": counts.get(key[0], 0),
                        "count_b": counts.get(key[1], 0),
                    }
                    if existing is None or entry["similarity"] > existing["similarity"]:
                        suggestions[key] = entry

    clusters: dict[str, set[str]] = {}
    for label in all_labels:
        clusters.setdefault(find(label), set()).add(label)

    canonical_map: dict[str, str] = {}
    for rep, members in clusters.items():
        manual_candidates = [m for m in members if m in manual_aliases.values()]
        data_members = [m for m in members if m in counts]
        if manual_candidates:
            canonical = sorted(manual_candidates, key=lambda x: (len(x), x.lower()))[0]
        elif data_members:
            canonical = sorted(
                data_members,
                key=lambda x: (-counts.get(x, 0), len(x), x.lower()),
            )[0]
        else:
            canonical = sorted(members, key=lambda x: (len(x), x.lower()))[0]
        for member in members:
            canonical_map[member] = canonical

    suggestions_df = pd.DataFrame(suggestions.values())
    if not suggestions_df.empty:
        suggestions_df = suggestions_df.sort_values(
            "similarity", ascending=False
        ).reset_index(drop=True)

    auto_df = pd.DataFrame(auto_records).drop_duplicates()
    if not auto_df.empty:
        auto_df = auto_df.reset_index(drop=True)

    return canonical_map, suggestions_df, auto_df


def _linear_trend(values: pd.Series, dates: pd.Series) -> Optional[float]:
    if len(values) < 2 or values.isna().all():
        return None
    x = dates.astype("int64") // 10**9
    y = values.astype(float)
    mask = ~(y.isna())
    if mask.sum() < 2:
        return None
    slope, _ = np.polyfit(x[mask], y[mask], 1)
    slope_per_year = slope * 60 * 60 * 24 * 365
    return float(slope_per_year)


def _autocorr(series: pd.Series) -> Optional[float]:
    series = series.astype(float)
    if series.isna().sum() > len(series) - 2:
        return None
    s1 = series[:-1]
    s2 = series[1:]
    mask = ~s1.isna() & ~s2.isna()
    if mask.sum() < 2:
        return None
    return float(np.corrcoef(s1[mask], s2[mask])[0, 1])


def _prepare_monthly(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    if "indicator_name" not in df.columns:
        df["indicator_name"] = df["event_name"].astype(str).map(_normalise_indicator)
    if df["event_time"].dt.tz is not None:
        df["event_time"] = df["event_time"].dt.tz_convert(None)
    df["month_period"] = df["event_time"].dt.to_period("M")
    monthly = (
        df.groupby(["indicator_name", "month_period"], dropna=False)
        .agg(
            actual_mean=("actual_value", "mean"),
            forecast_mean=("forecast_value", "mean"),
            previous_mean=("previous_value", "mean"),
            surprise_mean=("surprise", "mean"),
            surprise_pct_mean=("surprise_pct", "mean"),
            revision_mean=("revision", "mean"),
            revision_pct_mean=("revision_pct", "mean"),
            count=("event_id", "count"),
        )
        .reset_index()
    )
    monthly["year"] = monthly["month_period"].dt.year
    monthly["month"] = monthly["month_period"].dt.month
    monthly = monthly.sort_values(["indicator_name", "month_period"]).reset_index(
        drop=True
    )
    return monthly


def _apply_rolling(monthly: pd.DataFrame, windows: Sequence[int]) -> pd.DataFrame:
    def apply_windows(group: pd.DataFrame) -> pd.DataFrame:
        grp = group.copy()
        grp["indicator_name"] = group.name
        for window in windows:
            grp[f"actual_mean_roll_{window}"] = (
                grp["actual_mean"].rolling(window, min_periods=1).mean()
            )
            grp[f"surprise_pct_roll_{window}"] = (
                grp["surprise_pct_mean"].rolling(window, min_periods=1).mean()
            )
            grp[f"surprise_pct_std_{window}"] = (
                grp["surprise_pct_mean"].rolling(window, min_periods=2).std()
            )
        grp["actual_mean_yoy"] = grp["actual_mean"].diff(12)
        grp["surprise_pct_mean_yoy"] = grp["surprise_pct_mean"].diff(12)
        return grp

    return monthly.groupby("indicator_name", group_keys=False).apply(
        apply_windows, include_groups=False
    )


def _seasonality_strength(monthly: pd.DataFrame) -> pd.Series:
    def compute_strength(group: pd.DataFrame) -> float:
        overall_std = group["actual_mean"].std(ddof=0)
        if overall_std is None or math.isnan(overall_std) or overall_std == 0:
            return float("nan")
        month_means = group.groupby("month")["actual_mean"].mean()
        return float(month_means.std(ddof=0) / overall_std)

    return monthly.groupby("indicator_name").apply(
        compute_strength, include_groups=False
    )


def _build_event_summary(df: pd.DataFrame, monthly: pd.DataFrame) -> pd.DataFrame:
    summary_rows = []
    seasonality = _seasonality_strength(monthly)
    valid_indicators = set(monthly["indicator_name"].unique())

    for indicator_name, group in df.groupby("indicator_name"):
        if indicator_name not in valid_indicators:
            continue
        if len(group) < 2:
            continue
        actual_values = group["actual_value"]
        surprise_pct = group["surprise_pct"]
        returns_post60 = group.get("return_post_60_pct")
        returns_post240 = group.get("return_post_240_pct")
        trend_slope = _linear_trend(actual_values, group["event_time"])
        surprise_autocorr = _autocorr(surprise_pct)
        price_corr = None
        price_corr_long = None
        if returns_post60 is not None:
            mask = ~surprise_pct.isna() & ~returns_post60.isna()
            if mask.sum() >= 3:
                price_corr = float(
                    np.corrcoef(surprise_pct[mask], returns_post60[mask])[0, 1]
                )
        if returns_post240 is not None:
            mask = ~surprise_pct.isna() & ~returns_post240.isna()
            if mask.sum() >= 3:
                price_corr_long = float(
                    np.corrcoef(surprise_pct[mask], returns_post240[mask])[0, 1]
                )
        summary_rows.append(
            {
                "indicator_name": indicator_name,
                "total_events": int(len(group)),
                "first_event": group["event_time"].min(),
                "last_event": group["event_time"].max(),
                "years_covered": group["event_time"].dt.year.nunique(),
                "actual_mean": actual_values.mean(),
                "actual_std": actual_values.std(ddof=0),
                "surprise_pct_mean": surprise_pct.mean(),
                "surprise_pct_std": surprise_pct.std(ddof=0),
                "positive_surprise_share": (surprise_pct > 0).mean() * 100.0,
                "trend_slope_per_year": trend_slope,
                "surprise_autocorr_lag1": surprise_autocorr,
                "surprise_price_corr_post60": price_corr,
                "surprise_price_corr_post240": price_corr_long,
                "seasonality_strength": seasonality.get(indicator_name, float("nan")),
            }
        )

    summary = pd.DataFrame(summary_rows)
    if summary.empty:
        return summary
    numeric_cols = summary.select_dtypes(include="number").columns
    summary[numeric_cols] = summary[numeric_cols].round(6)
    return summary.sort_values("indicator_name").reset_index(drop=True)


def _build_correlation_pairs(
    monthly: pd.DataFrame, min_events: int, top_n: int
) -> pd.DataFrame:
    valid = monthly.groupby("indicator_name")["count"].sum()
    valid_events = valid[valid >= min_events].index.tolist()
    if len(valid_events) < 2:
        return pd.DataFrame(
            columns=["indicator_a", "indicator_b", "correlation", "shared_periods"]
        )

    pivot = monthly[monthly["indicator_name"].isin(valid_events)].pivot_table(
        index="month_period", columns="indicator_name", values="surprise_pct_mean"
    )
    pivot = pivot.loc[:, pivot.std(skipna=True) > 0]
    if pivot.shape[1] < 2:
        return pd.DataFrame(
            columns=["indicator_a", "indicator_b", "correlation", "shared_periods"]
        )

    corr_matrix = pivot.corr(min_periods=6).rename_axis(
        index="indicator_a", columns="indicator_b"
    )
    mask = ~np.tril(np.ones_like(corr_matrix, dtype=bool), k=0)
    corr_long = (
        corr_matrix.where(mask).stack(dropna=True).rename("correlation").reset_index()
    )

    counts_matrix = (
        (~pivot.isna()).astype(int).T @ (~pivot.isna()).astype(int)
    ).rename_axis(index="indicator_a", columns="indicator_b")
    counts_long = (
        counts_matrix.where(mask)
        .stack(dropna=True)
        .rename("shared_periods")
        .reset_index()
    )

    corr_long = corr_long.merge(
        counts_long, on=["indicator_a", "indicator_b"], how="left"
    )
    corr_long = corr_long.dropna(subset=["correlation"])
    corr_long = corr_long.sort_values(
        "correlation", key=lambda x: x.abs(), ascending=False
    )
    return corr_long.head(top_n).reset_index(drop=True)


def run_trend_analysis(
    config: TrendConfig, alignment_df: Optional[pd.DataFrame] = None
) -> TrendResult:
    df = (
        alignment_df.copy()
        if alignment_df is not None
        else pd.read_parquet(config.alignment_path)
    )
    if df.empty:
        raise SystemExit("Alignment dataset is empty; nothing to analyse.")
    df = df.copy()
    df["event_time"] = pd.to_datetime(df["event_time"])
    df = df[df["event_time"].notna()]
    df["indicator_name"] = df["event_name"].astype(str).map(_normalise_indicator)

    manual_aliases = _read_manual_aliases(config.alias_file)
    name_counts = df["indicator_name"].value_counts().to_dict()
    canonical_map, suggestions_df, auto_df = _build_alias_map(
        df["indicator_name"].unique(), name_counts, manual_aliases
    )

    if canonical_map:
        df["indicator_name"] = (
            df["indicator_name"].map(canonical_map).fillna(df["indicator_name"])
        )

    config.alias_file.parent.mkdir(parents=True, exist_ok=True)
    if not suggestions_df.empty:
        suggestions_df.to_csv(config.suggestions_file, index=False)
    elif config.suggestions_file.exists():
        config.suggestions_file.unlink()
    if not auto_df.empty:
        auto_df.to_csv(config.auto_alias_file, index=False)
    elif config.auto_alias_file.exists():
        config.auto_alias_file.unlink()

    monthly = _prepare_monthly(df)
    monthly = _apply_rolling(monthly, config.monthly_windows)

    monthly_filtered = monthly.groupby("indicator_name").filter(
        lambda x: len(x) >= config.min_events
    )
    event_summary = _build_event_summary(df, monthly_filtered)
    correlation_pairs = _build_correlation_pairs(
        monthly_filtered, config.min_corr_events, config.top_corr_pairs
    )

    config.monthly_output_parquet.parent.mkdir(parents=True, exist_ok=True)
    monthly_to_store = monthly_filtered.copy()
    if "month_period" in monthly_to_store.columns:
        monthly_to_store["month_period"] = monthly_to_store["month_period"].astype(str)
    monthly_to_store.to_parquet(config.monthly_output_parquet, index=False)
    if config.monthly_output_csv is not None:
        monthly_to_store.to_csv(config.monthly_output_csv, index=False)

    config.summary_output_parquet.parent.mkdir(parents=True, exist_ok=True)
    event_summary.to_parquet(config.summary_output_parquet, index=False)
    if config.summary_output_csv is not None:
        event_summary.to_csv(config.summary_output_csv, index=False)

    config.correlation_output_parquet.parent.mkdir(parents=True, exist_ok=True)
    correlation_pairs.to_parquet(config.correlation_output_parquet, index=False)
    if config.correlation_output_csv is not None:
        correlation_pairs.to_csv(config.correlation_output_csv, index=False)

    print(
        "Saved trend analysis outputs -> "
        f"{config.summary_output_parquet}, {config.monthly_output_parquet}, {config.correlation_output_parquet}"
    )

    return TrendResult(
        monthly_metrics=monthly_filtered,
        event_summary=event_summary,
        correlation_pairs=correlation_pairs,
    )


def parse_args() -> TrendConfig:
    parser = argparse.ArgumentParser(
        description="Stage B trend analysis: analyse indicator trends, seasonality, and predictive relationships."
    )
    parser.add_argument("--alignment-path", type=Path, default=DEFAULT_ALIGNMENT_PATH)
    parser.add_argument(
        "--monthly-output-parquet",
        type=Path,
        default=DEFAULT_MONTHLY_OUTPUT,
        help="Parquet path for monthly-level trend metrics.",
    )
    parser.add_argument(
        "--monthly-output-csv",
        type=Path,
        default=DEFAULT_MONTHLY_CSV,
        help="Optional CSV export for monthly trend metrics.",
    )
    parser.add_argument(
        "--no-monthly-csv",
        action="store_true",
        help="Skip writing the monthly trend metrics CSV.",
    )
    parser.add_argument(
        "--summary-output-parquet",
        type=Path,
        default=DEFAULT_SUMMARY_OUTPUT,
        help="Parquet path for per-indicator summary statistics.",
    )
    parser.add_argument(
        "--summary-output-csv",
        type=Path,
        default=DEFAULT_SUMMARY_CSV,
        help="Optional CSV for per-indicator summary.",
    )
    parser.add_argument(
        "--no-summary-csv",
        action="store_true",
        help="Skip writing the summary CSV.",
    )
    parser.add_argument(
        "--correlation-output-parquet",
        type=Path,
        default=DEFAULT_CORR_OUTPUT,
        help="Parquet path for top correlated indicator pairs.",
    )
    parser.add_argument(
        "--correlation-output-csv",
        type=Path,
        default=DEFAULT_CORR_CSV,
        help="Optional CSV for correlated indicator pairs.",
    )
    parser.add_argument(
        "--no-correlation-csv",
        action="store_true",
        help="Skip writing the correlation CSV.",
    )
    parser.add_argument(
        "--alias-file",
        type=Path,
        default=DEFAULT_ALIAS_FILE,
        help="CSV file providing manual alias mappings (alias,canonical_name).",
    )
    parser.add_argument(
        "--auto-alias-file",
        type=Path,
        default=DEFAULT_AUTO_ALIAS_FILE,
        help="CSV output listing automatically merged alias pairs.",
    )
    parser.add_argument(
        "--alias-suggestions",
        type=Path,
        default=DEFAULT_ALIAS_SUGGESTIONS,
        help="CSV output listing potential aliases requiring confirmation.",
    )
    parser.add_argument(
        "--monthly-windows",
        type=int,
        nargs="+",
        default=list(DEFAULT_MONTHLY_WINDOWS),
        help="Rolling windows (number of months) for trend metrics (default: 3 6 12).",
    )
    parser.add_argument(
        "--min-events",
        type=int,
        default=DEFAULT_MIN_EVENTS,
        help="Minimum monthly observations per indicator to include in outputs.",
    )
    parser.add_argument(
        "--min-corr-events",
        type=int,
        default=DEFAULT_MIN_CORR_EVENTS,
        help="Minimum monthly observations when computing pairwise correlations.",
    )
    parser.add_argument(
        "--top-corr-pairs",
        type=int,
        default=DEFAULT_TOP_CORR,
        help="Number of top correlation pairs to keep (sorted by |corr|).",
    )

    args = parser.parse_args()
    return TrendConfig(
        alignment_path=args.alignment_path,
        monthly_output_parquet=args.monthly_output_parquet,
        monthly_output_csv=None if args.no_monthly_csv else args.monthly_output_csv,
        summary_output_parquet=args.summary_output_parquet,
        summary_output_csv=None if args.no_summary_csv else args.summary_output_csv,
        correlation_output_parquet=args.correlation_output_parquet,
        correlation_output_csv=(
            None if args.no_correlation_csv else args.correlation_output_csv
        ),
        alias_file=args.alias_file,
        auto_alias_file=args.auto_alias_file,
        suggestions_file=args.alias_suggestions,
        monthly_windows=args.monthly_windows,
        min_events=args.min_events,
        min_corr_events=args.min_corr_events,
        top_corr_pairs=args.top_corr_pairs,
    )


if __name__ == "__main__":
    cfg = parse_args()
    run_trend_analysis(cfg)
