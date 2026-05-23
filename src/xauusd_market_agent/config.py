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


def _env_bool(name: str) -> bool | None:
    raw = os.getenv(name, "").strip().lower()
    if not raw:
        return None
    return raw == "true"


def _env_json_path(name: str) -> Path | None:
    raw = os.getenv(name, "").strip()
    if not raw:
        return None
    return _env_path(name, REPO_ROOT / raw)


def _read_json(path: Path | None) -> dict[str, object]:
    if path is None or not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _telegram_config_payload() -> dict[str, object]:
    return _read_json(
        _env_json_path("MARKET_AGENT_TELEGRAM_CONFIG_PATH")
        or (REPO_ROOT / "user-data" / "market-agent-telegram.json")
    )


def _telegram_enabled_default() -> bool:
    env_value = _env_bool("MARKET_AGENT_TELEGRAM_ENABLED")
    if env_value is not None:
        return env_value
    return _json_bool(_telegram_config_payload(), "enabled", fallback=False)


def _telegram_str_default(env_name: str, key: str) -> str:
    return os.getenv(env_name, "").strip() or _json_str(_telegram_config_payload(), key)


def _telegram_int_default(env_name: str, key: str, fallback: int) -> int:
    raw = os.getenv(env_name, "").strip()
    if raw:
        try:
            return int(raw)
        except ValueError:
            return fallback
    return _json_int(_telegram_config_payload(), key, fallback=fallback) or fallback


def _telegram_levels_default() -> list[str]:
    raw = os.getenv("MARKET_AGENT_TELEGRAM_LEVELS", "").strip()
    if raw.lower() == "all":
        return ["level_1", "level_2", "level_3"]
    if raw:
        return _env_list("MARKET_AGENT_TELEGRAM_LEVELS")
    payload = _telegram_config_payload()
    levels = payload.get("levels")
    if isinstance(levels, list):
        parsed = [str(item).strip() for item in levels if str(item).strip()]
        if parsed:
            return parsed
    if isinstance(levels, str) and levels.strip():
        return [item.strip() for item in levels.split(",") if item.strip()]
    return ["level_2", "level_3"]


def _json_bool(payload: dict[str, object], *keys: str, fallback: bool = False) -> bool:
    for key in keys:
        value = payload.get(key)
        if isinstance(value, bool):
            return value
    return fallback


def _json_str(payload: dict[str, object], *keys: str, fallback: str = "") -> str:
    for key in keys:
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return fallback


def _json_int(payload: dict[str, object], *keys: str, fallback: int | None = None) -> int | None:
    for key in keys:
        value = payload.get(key)
        if isinstance(value, bool):
            continue
        if isinstance(value, int):
            return value
        if isinstance(value, float) and value.is_integer():
            return int(value)
        if isinstance(value, str) and value.strip():
            try:
                return int(value.strip())
            except ValueError:
                continue
    return fallback


@dataclass(frozen=True)
class CTraderCliConfig:
    enabled: bool
    account_id: str
    ctid: str
    password: str
    environment: str
    symbol: str
    symbol_id: int | None
    config_path: Path
    snapshot_path: Path
    allow_saved_snapshot_fallback: bool
    quote_timeout_seconds: int
    quote_stale_after_seconds: int
    cli_executable: str

    @classmethod
    def default(cls, repo_root: Path) -> "CTraderCliConfig":
        user_data_dir = repo_root / "user-data"
        return cls(
            enabled=False,
            account_id="",
            ctid="",
            password="",
            environment="demo",
            symbol="XAUUSD",
            symbol_id=None,
            config_path=user_data_dir / "ctrader-cli.json",
            snapshot_path=user_data_dir / "ctrader-last-quote.json",
            allow_saved_snapshot_fallback=True,
            quote_timeout_seconds=8,
            quote_stale_after_seconds=15,
            cli_executable="ctrader-cli",
        )

    @classmethod
    def from_sources(cls, market_config: "MarketAgentConfig") -> "CTraderCliConfig":
        base = cls.default(market_config.repo_root)
        config_path = market_config.ctrader_config_path or base.config_path
        config_payload = _read_json(config_path)
        snapshot_path_raw = _json_str(config_payload, "snapshotPath", fallback="")
        snapshot_path = (
            Path(snapshot_path_raw).expanduser()
            if snapshot_path_raw
            else (market_config.ctrader_saved_snapshot_path or base.snapshot_path)
        )
        if not snapshot_path.is_absolute():
            snapshot_path = market_config.repo_root / snapshot_path

        enabled = os.getenv("CTRADER_ENABLED", "").strip().lower()
        env_enabled = enabled == "true" if enabled else None
        account_id = os.getenv("CTRADER_ACCOUNT_ID", "").strip() or _json_str(
            config_payload, "accountId"
        )
        ctid = os.getenv("CTRADER_CTID", "").strip() or _json_str(config_payload, "ctid")
        password = os.getenv("CTRADER_PASSWORD", "").strip() or _json_str(config_payload, "password")
        environment = (
            os.getenv("CTRADER_ENVIRONMENT", "").strip()
            or _json_str(config_payload, "environment", fallback="demo")
        ).lower()
        symbol = os.getenv("CTRADER_SYMBOL", "").strip() or _json_str(
            config_payload, "symbol", fallback="XAUUSD"
        )
        symbol_id = _json_int(
            {"env": os.getenv("CTRADER_SYMBOL_ID", "").strip(), **config_payload},
            "env",
            "symbolId",
            fallback=None,
        )
        cli_executable = os.getenv("CTRADER_CLI_EXECUTABLE", "").strip() or _json_str(
            config_payload, "cliExecutable", fallback=base.cli_executable
        )
        timeout_seconds = _json_int(
            {"env": os.getenv("CTRADER_QUOTE_TIMEOUT_SECONDS", "").strip(), **config_payload},
            "env",
            "quoteTimeoutSeconds",
            fallback=base.quote_timeout_seconds,
        )
        stale_after_seconds = _json_int(
            {"env": os.getenv("CTRADER_QUOTE_STALE_AFTER_SECONDS", "").strip(), **config_payload},
            "env",
            "quoteStaleAfterSeconds",
            fallback=base.quote_stale_after_seconds,
        )
        allow_saved_snapshot_fallback = _json_bool(
            config_payload,
            "allowSavedSnapshotFallback",
            fallback=base.allow_saved_snapshot_fallback,
        )
        configured = all((account_id, ctid, password))
        return cls(
            enabled=env_enabled if env_enabled is not None else _json_bool(config_payload, "enabled", fallback=configured),
            account_id=account_id,
            ctid=ctid,
            password=password,
            environment="live" if environment == "live" else "demo",
            symbol=symbol or "XAUUSD",
            symbol_id=symbol_id,
            config_path=config_path,
            snapshot_path=snapshot_path,
            allow_saved_snapshot_fallback=allow_saved_snapshot_fallback,
            quote_timeout_seconds=int(timeout_seconds or base.quote_timeout_seconds),
            quote_stale_after_seconds=int(stale_after_seconds or base.quote_stale_after_seconds),
            cli_executable=cli_executable or base.cli_executable,
        )

    def is_ready(self) -> bool:
        return self.enabled and all((self.account_id, self.ctid, self.password))


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
    yahoo_enabled: bool = os.getenv("MARKET_AGENT_YAHOO_ENABLED", "true").lower() == "true"
    yahoo_fixture_dir: Path | None = field(
        default_factory=lambda: _env_json_path("MARKET_AGENT_YAHOO_FIXTURE_DIR")
    )
    ctrader_saved_snapshot_path: Path | None = field(
        default_factory=lambda: _env_json_path("MARKET_AGENT_CTRADER_SAVED_SNAPSHOT_PATH")
    )
    ctrader_config_path: Path | None = field(
        default_factory=lambda: (
            _env_json_path("CTRADER_CONFIG_PATH")
            or (REPO_ROOT / "user-data" / "ctrader-cli.json")
        )
    )
    forex_factory_fixture_path: Path | None = field(
        default_factory=lambda: _env_json_path("MARKET_AGENT_FOREX_FACTORY_FIXTURE_PATH")
    )
    forex_factory_source_url: str = os.getenv("MARKET_AGENT_FOREX_FACTORY_SOURCE_URL", "").strip()
    csv_fallback_enabled: bool = os.getenv("MARKET_AGENT_CSV_FALLBACK_ENABLED", "true").lower() == "true"
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
    monitor_lock_path: Path = field(
        default_factory=lambda: _env_path(
            "MARKET_AGENT_MONITOR_LOCK_PATH",
            REPO_ROOT / "user-data" / "market_agent_monitor.lock",
        )
    )
    backfill_gap_minutes: int = int(os.getenv("MARKET_AGENT_BACKFILL_GAP_MINUTES", "120"))
    notification_cooldown_minutes: int = int(
        os.getenv("MARKET_AGENT_NOTIFICATION_COOLDOWN_MINUTES", "30")
    )
    telegram_enabled: bool = field(default_factory=_telegram_enabled_default)
    telegram_bot_token: str = field(
        default_factory=lambda: _telegram_str_default(
            "MARKET_AGENT_TELEGRAM_BOT_TOKEN", "botToken"
        )
    )
    telegram_chat_id: str = field(
        default_factory=lambda: _telegram_str_default(
            "MARKET_AGENT_TELEGRAM_CHAT_ID", "chatId"
        )
    )
    telegram_timeout_seconds: int = field(
        default_factory=lambda: _telegram_int_default(
            "MARKET_AGENT_TELEGRAM_TIMEOUT_SECONDS", "timeoutSeconds", 10
        )
    )
    telegram_levels: list[str] = field(default_factory=_telegram_levels_default)
