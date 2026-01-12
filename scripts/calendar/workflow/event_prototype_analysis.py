"""Stage B event prototypes: cluster similar events into response playbooks."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd

from .event_component_decomposition import (
    _categorise_core,
    _extract_frequency,
    _normalise_base_indicator,
)

BASE_OUTPUT_DIR = Path("data/calendar_outputs/event_prototypes")
DEFAULT_ALIGNMENT_PATH = Path(
    "data/calendar_outputs/event_price_alignment/event_price_alignment.parquet"
)
DEFAULT_DETAIL_OUTPUT_PARQUET = BASE_OUTPUT_DIR / "event_prototype_events.parquet"
DEFAULT_DETAIL_OUTPUT_CSV = BASE_OUTPUT_DIR / "event_prototype_events.csv"
DEFAULT_SUMMARY_OUTPUT_PARQUET = BASE_OUTPUT_DIR / "event_prototype_summary.parquet"
DEFAULT_SUMMARY_OUTPUT_CSV = BASE_OUTPUT_DIR / "event_prototype_summary.csv"
DEFAULT_CENTROID_OUTPUT_PARQUET = BASE_OUTPUT_DIR / "event_prototype_centroids.parquet"
DEFAULT_CENTROID_OUTPUT_CSV = BASE_OUTPUT_DIR / "event_prototype_centroids.csv"

DEFAULT_MIN_EVENTS = 12
DEFAULT_MAX_CLUSTERS = 4
DEFAULT_RANDOM_STATE = 42
MAX_KMEANS_ITER = 100
TOLERANCE = 1e-6

FEATURE_PRE_WINDOWS = [15, 60, 120]
FEATURE_POST_WINDOWS = [15, 60, 120, 240]
FEATURE_COLUMNS = (
    [f"return_pre_{w}_pct" for w in FEATURE_PRE_WINDOWS]
    + ["return_at_pct"]
    + [f"return_post_{w}_pct" for w in FEATURE_POST_WINDOWS]
)
CENTROID_COLUMNS = [
    "currency",
    "base_indicator",
    "frequency_tag",
    "core_category",
    "cluster_id",
    "cluster_size",
    "within_cluster_mad",
] + FEATURE_COLUMNS
DETAIL_COLUMNS = [
    "event_id",
    "event_time",
    "event_name",
    "currency",
    "importance",
    "base_indicator",
    "frequency_tag",
    "core_category",
    "cluster_id",
    "cluster_distance",
] + FEATURE_COLUMNS
SUMMARY_COLUMNS = [
    "currency",
    "base_indicator",
    "frequency_tag",
    "core_category",
    "cluster_id",
    "cluster_size",
    "positive_share_post_60_pct",
    "positive_share_post_240_pct",
    "avg_return_post_60_pct",
    "avg_return_post_240_pct",
    "avg_return_post_15_pct",
    "avg_return_post_120_pct",
    "avg_return_at_pct",
]


@dataclass
class PrototypeConfig:
    alignment_path: Path
    detail_output_parquet: Path
    detail_output_csv: Optional[Path]
    summary_output_parquet: Path
    summary_output_csv: Optional[Path]
    centroid_output_parquet: Path
    centroid_output_csv: Optional[Path]
    min_events: int = DEFAULT_MIN_EVENTS
    max_clusters: int = DEFAULT_MAX_CLUSTERS
    random_state: int = DEFAULT_RANDOM_STATE

    def __post_init__(self) -> None:
        self.alignment_path = self.alignment_path.expanduser().resolve()
        self.detail_output_parquet = self.detail_output_parquet.expanduser().resolve()
        if self.detail_output_csv is not None:
            self.detail_output_csv = self.detail_output_csv.expanduser().resolve()
        self.summary_output_parquet = self.summary_output_parquet.expanduser().resolve()
        if self.summary_output_csv is not None:
            self.summary_output_csv = self.summary_output_csv.expanduser().resolve()
        self.centroid_output_parquet = (
            self.centroid_output_parquet.expanduser().resolve()
        )
        if self.centroid_output_csv is not None:
            self.centroid_output_csv = self.centroid_output_csv.expanduser().resolve()
        if self.min_events <= 0:
            raise ValueError("min_events must be positive")
        if self.max_clusters <= 0:
            raise ValueError("max_clusters must be positive")


@dataclass
class PrototypeResult:
    detail: pd.DataFrame
    summary: pd.DataFrame
    centroids: pd.DataFrame


def _load_alignment(
    config: PrototypeConfig, alignment_df: Optional[pd.DataFrame]
) -> pd.DataFrame:
    if alignment_df is None:
        if not config.alignment_path.exists():
            raise FileNotFoundError(config.alignment_path)
        alignment_df = pd.read_parquet(config.alignment_path)

    if alignment_df.empty:
        raise SystemExit("Alignment dataset is empty; nothing to analyse.")

    required = set(FEATURE_COLUMNS) | {"event_name", "event_time", "currency"}
    missing = required - set(alignment_df.columns)
    if missing:
        raise ValueError(f"Alignment dataset missing required columns: {missing}")

    df = alignment_df.copy()
    df["event_time"] = pd.to_datetime(df["event_time"])
    df["event_name"] = df["event_name"].astype(str)
    df["currency"] = df["currency"].astype(str)
    return df


def _prepare_features(df: pd.DataFrame) -> pd.DataFrame:
    enriched = df.copy()
    enriched["base_indicator"] = enriched["event_name"].apply(_normalise_base_indicator)
    enriched["frequency_tag"] = enriched["event_name"].apply(_extract_frequency)
    enriched["core_category"] = enriched["event_name"].apply(_categorise_core)
    feature_frame = enriched[FEATURE_COLUMNS].astype(float).fillna(0.0)
    enriched.loc[:, FEATURE_COLUMNS] = feature_frame
    return enriched


def _initialise_centroids(
    data: np.ndarray, k: int, rng: np.random.Generator
) -> np.ndarray:
    indices = rng.choice(data.shape[0], size=k, replace=False)
    return data[indices].copy()


def _assign_clusters(data: np.ndarray, centroids: np.ndarray) -> np.ndarray:
    distances = np.linalg.norm(data[:, None, :] - centroids[None, :, :], axis=2)
    return distances.argmin(axis=1), distances.min(axis=1)


def _recompute_centroids(data: np.ndarray, labels: np.ndarray, k: int) -> np.ndarray:
    centroids = np.zeros((k, data.shape[1]))
    for i in range(k):
        members = data[labels == i]
        if members.size == 0:
            centroids[i] = data.mean(axis=0)
        else:
            centroids[i] = members.mean(axis=0)
    return centroids


def _kmeans(
    data: np.ndarray,
    k: int,
    rng: np.random.Generator,
    max_iter: int = MAX_KMEANS_ITER,
    tol: float = TOLERANCE,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    centroids = _initialise_centroids(data, k, rng)
    for _ in range(max_iter):
        labels, distances = _assign_clusters(data, centroids)
        new_centroids = _recompute_centroids(data, labels, k)
        shift = np.linalg.norm(new_centroids - centroids)
        centroids = new_centroids
        if shift < tol:
            break
    labels, distances = _assign_clusters(data, centroids)
    return labels, distances, centroids


def _positive_share(series: pd.Series) -> Optional[float]:
    clean = series.dropna().astype(float)
    if clean.empty:
        return None
    return float(round((clean > 0).mean() * 100.0, 4))


def _mean(series: pd.Series) -> Optional[float]:
    clean = series.dropna().astype(float)
    if clean.empty:
        return None
    return float(round(clean.mean(), 6))


def _build_prototypes(
    enriched: pd.DataFrame, config: PrototypeConfig
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    rng = np.random.default_rng(config.random_state)
    detail_records: list[dict[str, object]] = []
    summary_records: list[dict[str, object]] = []
    centroid_records: list[dict[str, object]] = []

    grouping_cols = ["currency", "base_indicator", "frequency_tag", "core_category"]
    grouped = enriched.groupby(grouping_cols, dropna=False, sort=False)

    for key, group in grouped:
        sample_size = int(group.shape[0])
        if sample_size < config.min_events:
            continue

        max_clusters = min(config.max_clusters, sample_size)
        if max_clusters <= 1:
            cluster_labels = np.zeros(sample_size, dtype=int)
            distances = np.zeros(sample_size, dtype=float)
            centroids = group[FEATURE_COLUMNS].to_numpy(dtype=float)[:1]
        else:
            data_matrix = group[FEATURE_COLUMNS].to_numpy(dtype=float)
            cluster_labels, distances, centroids = _kmeans(
                data_matrix, max_clusters, rng
            )

        group = group.reset_index(drop=True)
        for idx, row in group.iterrows():
            record = {
                "event_id": row.get("event_id"),
                "event_time": row.get("event_time"),
                "event_name": row.get("event_name"),
                "currency": row.get("currency"),
                "importance": row.get("importance"),
                "base_indicator": row.get("base_indicator"),
                "frequency_tag": row.get("frequency_tag"),
                "core_category": row.get("core_category"),
                "cluster_id": int(cluster_labels[idx]),
                "cluster_distance": float(round(distances[idx], 6)),
            }
            for column in FEATURE_COLUMNS:
                record[column] = float(row[column])
            detail_records.append(record)

        for cluster_id in range(len(centroids)):
            members = group.iloc[cluster_labels == cluster_id]
            if members.empty:
                continue
            centroid_record = {
                "currency": key[0],
                "base_indicator": key[1],
                "frequency_tag": key[2],
                "core_category": key[3],
                "cluster_id": int(cluster_id),
                "cluster_size": int(members.shape[0]),
                "within_cluster_mad": float(
                    round(
                        np.mean(
                            np.abs(
                                members[FEATURE_COLUMNS].to_numpy(dtype=float)
                                - centroids[cluster_id]
                            )
                        ),
                        6,
                    )
                ),
            }
            for column, value in zip(FEATURE_COLUMNS, centroids[cluster_id]):
                centroid_record[column] = float(round(value, 6))
            centroid_records.append(centroid_record)

            summary_record = {
                "currency": key[0],
                "base_indicator": key[1],
                "frequency_tag": key[2],
                "core_category": key[3],
                "cluster_id": int(cluster_id),
                "cluster_size": int(members.shape[0]),
                "positive_share_post_60_pct": _positive_share(
                    members["return_post_60_pct"]
                ),
                "positive_share_post_240_pct": _positive_share(
                    members["return_post_240_pct"]
                ),
                "avg_return_post_60_pct": _mean(members["return_post_60_pct"]),
                "avg_return_post_240_pct": _mean(members["return_post_240_pct"]),
                "avg_return_post_15_pct": _mean(members["return_post_15_pct"]),
                "avg_return_post_120_pct": _mean(members["return_post_120_pct"]),
                "avg_return_at_pct": _mean(members["return_at_pct"]),
            }
            summary_records.append(summary_record)

    detail_df = pd.DataFrame.from_records(detail_records)
    if detail_df.empty:
        detail_df = pd.DataFrame(columns=DETAIL_COLUMNS)
    else:
        detail_df = detail_df.reindex(columns=DETAIL_COLUMNS)

    summary_df = pd.DataFrame.from_records(summary_records)
    if summary_df.empty:
        summary_df = pd.DataFrame(columns=SUMMARY_COLUMNS)
    else:
        summary_df = summary_df.reindex(columns=SUMMARY_COLUMNS)

    centroid_df = pd.DataFrame.from_records(centroid_records)
    if centroid_df.empty:
        centroid_df = pd.DataFrame(columns=CENTROID_COLUMNS)
    else:
        centroid_df = centroid_df.reindex(columns=CENTROID_COLUMNS)

    return detail_df, summary_df, centroid_df


def run_prototype_analysis(
    config: PrototypeConfig, alignment_df: Optional[pd.DataFrame] = None
) -> PrototypeResult:
    df = _load_alignment(config, alignment_df)
    enriched = _prepare_features(df)
    detail, summary, centroids = _build_prototypes(enriched, config)

    if not detail.empty:
        config.detail_output_parquet.parent.mkdir(parents=True, exist_ok=True)
        detail.to_parquet(config.detail_output_parquet, index=False)
        if config.detail_output_csv is not None:
            config.detail_output_csv.parent.mkdir(parents=True, exist_ok=True)
            detail.to_csv(config.detail_output_csv, index=False)
    else:
        print("[INFO] No prototype detail records produced; skipping detail outputs.")

    if not summary.empty:
        config.summary_output_parquet.parent.mkdir(parents=True, exist_ok=True)
        summary.to_parquet(config.summary_output_parquet, index=False)
        if config.summary_output_csv is not None:
            config.summary_output_csv.parent.mkdir(parents=True, exist_ok=True)
            summary.to_csv(config.summary_output_csv, index=False)
    else:
        print("[INFO] No prototype summary produced; skipping summary outputs.")

    if not centroids.empty:
        config.centroid_output_parquet.parent.mkdir(parents=True, exist_ok=True)
        centroids.to_parquet(config.centroid_output_parquet, index=False)
        if config.centroid_output_csv is not None:
            config.centroid_output_csv.parent.mkdir(parents=True, exist_ok=True)
            centroids.to_csv(config.centroid_output_csv, index=False)
    else:
        print("[INFO] No prototype centroids produced; skipping centroid outputs.")

    if not detail.empty or not summary.empty or not centroids.empty:
        print(
            "Saved event prototype outputs -> "
            f"{config.detail_output_parquet}, {config.summary_output_parquet}, "
            f"{config.centroid_output_parquet}"
        )

    return PrototypeResult(detail=detail, summary=summary, centroids=centroids)


def parse_args() -> PrototypeConfig:
    parser = argparse.ArgumentParser(
        description=(
            "Stage B prototype analysis: cluster similar events and derive response "
            "playbooks across time windows."
        )
    )
    parser.add_argument(
        "--alignment-path",
        type=Path,
        default=DEFAULT_ALIGNMENT_PATH,
        help="Parquet file produced by event_price_alignment.py.",
    )
    parser.add_argument(
        "--detail-output-parquet",
        type=Path,
        default=DEFAULT_DETAIL_OUTPUT_PARQUET,
        help="Parquet output for event-level cluster assignments.",
    )
    parser.add_argument(
        "--detail-output-csv",
        type=Path,
        default=DEFAULT_DETAIL_OUTPUT_CSV,
        help="Optional CSV output for event-level cluster assignments.",
    )
    parser.add_argument(
        "--no-detail-csv",
        action="store_true",
        help="Skip writing the event-level CSV output.",
    )
    parser.add_argument(
        "--summary-output-parquet",
        type=Path,
        default=DEFAULT_SUMMARY_OUTPUT_PARQUET,
        help="Parquet output for aggregated cluster statistics.",
    )
    parser.add_argument(
        "--summary-output-csv",
        type=Path,
        default=DEFAULT_SUMMARY_OUTPUT_CSV,
        help="Optional CSV output for aggregated cluster statistics.",
    )
    parser.add_argument(
        "--no-summary-csv",
        action="store_true",
        help="Skip writing the summary CSV output.",
    )
    parser.add_argument(
        "--centroid-output-parquet",
        type=Path,
        default=DEFAULT_CENTROID_OUTPUT_PARQUET,
        help="Parquet output for cluster centroids.",
    )
    parser.add_argument(
        "--centroid-output-csv",
        type=Path,
        default=DEFAULT_CENTROID_OUTPUT_CSV,
        help="Optional CSV output for cluster centroids.",
    )
    parser.add_argument(
        "--no-centroid-csv",
        action="store_true",
        help="Skip writing the centroid CSV output.",
    )
    parser.add_argument(
        "--min-events",
        type=int,
        default=DEFAULT_MIN_EVENTS,
        help="Minimum events required per indicator before clustering.",
    )
    parser.add_argument(
        "--max-clusters",
        type=int,
        default=DEFAULT_MAX_CLUSTERS,
        help="Maximum number of clusters per indicator (auto-limited by sample size).",
    )
    parser.add_argument(
        "--random-state",
        type=int,
        default=DEFAULT_RANDOM_STATE,
        help="Random seed for k-means initialisation.",
    )

    args = parser.parse_args()
    return PrototypeConfig(
        alignment_path=args.alignment_path,
        detail_output_parquet=args.detail_output_parquet,
        detail_output_csv=None if args.no_detail_csv else args.detail_output_csv,
        summary_output_parquet=args.summary_output_parquet,
        summary_output_csv=None if args.no_summary_csv else args.summary_output_csv,
        centroid_output_parquet=args.centroid_output_parquet,
        centroid_output_csv=None if args.no_centroid_csv else args.centroid_output_csv,
        min_events=args.min_events,
        max_clusters=args.max_clusters,
        random_state=args.random_state,
    )


if __name__ == "__main__":
    config = parse_args()
    run_prototype_analysis(config)
