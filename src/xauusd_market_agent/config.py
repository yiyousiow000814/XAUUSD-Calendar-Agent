from __future__ import annotations

import os
from dataclasses import dataclass, field
import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def _env_path(name: str, default: Path) -> Path:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    path = Path(raw).expanduser()
    if not path.is_absolute():
        path = REPO_ROOT / path
    return path


def _env_list(name: str) -> list[str]:
    raw = os.getenv(name, "").strip()
    if not raw:
        return []
    return [item.strip() for item in raw.split(",") if item.strip()]


def _env_json_path(name: str) -> Path | None:
    raw = os.getenv(name, "").strip()
    if not raw:
        return None
    return _env_path(name, REPO_ROOT / raw)


@dataclass(frozen=True)
class MarketAgentConfig:
    repo_root: Path = REPO_ROOT
    price_data_path: Path = field(
        default_factory=lambda: _env_path(
            "MARKET_AGENT_PRICE_DATA_PATH",
            REPO_ROOT / "data" / "XAUUSD_data" / "XAUUSD_data.csv",
        )
    )
    calendar_dir: Path = field(
        default_factory=lambda: _env_path(
            "MARKET_AGENT_CALENDAR_DIR",
            REPO_ROOT / "data" / "Economic_Calendar",
        )
    )
    related_assets_path: Path | None = field(
        default_factory=lambda: (
            _env_path(
                "MARKET_AGENT_RELATED_ASSETS_PATH",
                REPO_ROOT / "user-data" / "market_agent_related_assets.json",
            )
            if os.getenv("MARKET_AGENT_RELATED_ASSETS_PATH", "").strip()
            else None
        )
    )
    related_assets_dir: Path | None = field(
        default_factory=lambda: (
            _env_path(
                "MARKET_AGENT_RELATED_ASSETS_DIR",
                REPO_ROOT / "user-data" / "market_agent_related_assets",
            )
            if os.getenv("MARKET_AGENT_RELATED_ASSETS_DIR", "").strip()
            else None
        )
    )
    related_assets_sources_path: Path | None = field(
        default_factory=lambda: _env_json_path("MARKET_AGENT_RELATED_ASSETS_SOURCES_PATH")
    )
    rss_feeds: list[str] = field(default_factory=lambda: _env_list("NEWS_RSS_FEEDS"))
    news_lookback_minutes: int = int(os.getenv("MARKET_AGENT_NEWS_LOOKBACK_MINUTES", "30"))
    post_move_news_minutes: int = int(os.getenv("MARKET_AGENT_POST_MOVE_NEWS_MINUTES", "120"))
    calendar_lookback_minutes: int = int(os.getenv("MARKET_AGENT_CALENDAR_LOOKBACK_MINUTES", "60"))
    move_window_minutes: int = int(os.getenv("MARKET_AGENT_MOVE_WINDOW_MINUTES", "15"))
    state_store_path: Path = field(
        default_factory=lambda: _env_path(
            "MARKET_AGENT_STATE_STORE_PATH",
            REPO_ROOT / "user-data" / "market_agent_state.json",
        )
    )
    timeline_store_path: Path = field(
        default_factory=lambda: _env_path(
            "MARKET_AGENT_TIMELINE_STORE_PATH",
            REPO_ROOT / "user-data" / "market_agent_timeline.sqlite",
        )
    )
    alerts_output_path: Path = field(
        default_factory=lambda: _env_path(
            "MARKET_AGENT_ALERTS_OUTPUT_PATH",
            REPO_ROOT / "user-data" / "market_agent_alerts.ndjson",
        )
    )
    backfill_gap_minutes: int = int(os.getenv("MARKET_AGENT_BACKFILL_GAP_MINUTES", "120"))
    notification_cooldown_minutes: int = int(
        os.getenv("MARKET_AGENT_NOTIFICATION_COOLDOWN_MINUTES", "30")
    )
    telegram_enabled: bool = os.getenv("MARKET_AGENT_TELEGRAM_ENABLED", "false").lower() == "true"
    telegram_bot_token: str = os.getenv("MARKET_AGENT_TELEGRAM_BOT_TOKEN", "")
    telegram_chat_id: str = os.getenv("MARKET_AGENT_TELEGRAM_CHAT_ID", "")
    telegram_timeout_seconds: int = int(
        os.getenv("MARKET_AGENT_TELEGRAM_TIMEOUT_SECONDS", "10")
    )
