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


def _read_json(path: Path | None) -> dict[str, object]:
    if path is None or not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


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
class CTraderOpenApiConfig:
    enabled: bool
    client_id: str
    client_secret: str
    access_token: str
    refresh_token: str
    account_id: str
    environment: str
    symbol: str
    symbol_id: int | None
    app_redirect_uri: str
    config_path: Path
    token_store_path: Path
    snapshot_path: Path
    allow_saved_snapshot_fallback: bool
    quote_timeout_seconds: int
    quote_stale_after_seconds: int
    bridge_python_executable: str

    @classmethod
    def default(cls, repo_root: Path) -> "CTraderOpenApiConfig":
        user_data_dir = repo_root / "user-data"
        return cls(
            enabled=False,
            client_id="",
            client_secret="",
            access_token="",
            refresh_token="",
            account_id="",
            environment="demo",
            symbol="XAUUSD",
            symbol_id=None,
            app_redirect_uri="",
            config_path=user_data_dir / "ctrader-openapi.json",
            token_store_path=user_data_dir / "ctrader-token.json",
            snapshot_path=user_data_dir / "ctrader-last-quote.json",
            allow_saved_snapshot_fallback=True,
            quote_timeout_seconds=8,
            quote_stale_after_seconds=15,
            bridge_python_executable="python",
        )

    @classmethod
    def from_sources(cls, market_config: "MarketAgentConfig") -> "CTraderOpenApiConfig":
        base = cls.default(market_config.repo_root)
        config_path = market_config.ctrader_config_path or base.config_path
        config_payload = _read_json(config_path)
        token_store_path_raw = _json_str(config_payload, "tokenStorePath", fallback="")
        token_store_path = (
            Path(token_store_path_raw).expanduser()
            if token_store_path_raw
            else (market_config.ctrader_token_store_path or base.token_store_path)
        )
        if not token_store_path.is_absolute():
            token_store_path = market_config.repo_root / token_store_path
        token_payload = _read_json(token_store_path)
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
        client_id = os.getenv("CTRADER_CLIENT_ID", "").strip() or _json_str(config_payload, "clientId")
        client_secret = os.getenv("CTRADER_CLIENT_SECRET", "").strip() or _json_str(
            token_payload, "clientSecret", fallback=_json_str(config_payload, "clientSecret")
        )
        access_token = os.getenv("CTRADER_ACCESS_TOKEN", "").strip() or _json_str(
            token_payload, "accessToken", fallback=_json_str(config_payload, "accessToken")
        )
        refresh_token = os.getenv("CTRADER_REFRESH_TOKEN", "").strip() or _json_str(
            token_payload, "refreshToken", fallback=_json_str(config_payload, "refreshToken")
        )
        account_id = os.getenv("CTRADER_ACCOUNT_ID", "").strip() or _json_str(
            config_payload, "accountId"
        )
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
        app_redirect_uri = os.getenv("CTRADER_APP_REDIRECT_URI", "").strip() or _json_str(
            config_payload, "appRedirectUri"
        )
        bridge_python = os.getenv("CTRADER_BRIDGE_PYTHON", "").strip() or _json_str(
            config_payload, "bridgePythonExecutable", fallback=base.bridge_python_executable
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
        configured = all((client_id, client_secret, access_token, account_id))
        return cls(
            enabled=env_enabled if env_enabled is not None else _json_bool(config_payload, "enabled", fallback=configured),
            client_id=client_id,
            client_secret=client_secret,
            access_token=access_token,
            refresh_token=refresh_token,
            account_id=account_id,
            environment="live" if environment == "live" else "demo",
            symbol=symbol or "XAUUSD",
            symbol_id=symbol_id,
            app_redirect_uri=app_redirect_uri,
            config_path=config_path,
            token_store_path=token_store_path,
            snapshot_path=snapshot_path,
            allow_saved_snapshot_fallback=allow_saved_snapshot_fallback,
            quote_timeout_seconds=int(timeout_seconds or base.quote_timeout_seconds),
            quote_stale_after_seconds=int(stale_after_seconds or base.quote_stale_after_seconds),
            bridge_python_executable=bridge_python or base.bridge_python_executable,
        )

    def is_ready(self) -> bool:
        return self.enabled and all(
            (self.client_id, self.client_secret, self.access_token, self.account_id)
        )


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
            or (REPO_ROOT / "user-data" / "ctrader-openapi.json")
        )
    )
    ctrader_token_store_path: Path | None = field(
        default_factory=lambda: (
            _env_json_path("CTRADER_TOKEN_STORE_PATH")
            or (REPO_ROOT / "user-data" / "ctrader-token.json")
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
