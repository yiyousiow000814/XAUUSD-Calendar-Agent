from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any


class BridgeError(RuntimeError):
    pass


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat()


def _parse_timestamp(value: str) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed.astimezone() if parsed.tzinfo else parsed.replace(tzinfo=datetime.now().astimezone().tzinfo)


def _as_int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _read_stdin() -> dict[str, Any]:
    raw = sys.stdin.read().strip()
    if not raw:
        return {}
    payload = json.loads(raw)
    return payload if isinstance(payload, dict) else {}


def _env_bool(name: str) -> bool:
    return os.getenv(name, "").strip().lower() == "true"


def _allow_cli_adapter_shell() -> bool:
    return _env_bool("CTRADER_ALLOW_CLI_ADAPTER_SHELL")


def _spawn_debug_log_path(snapshot_path: Path) -> Path:
    return snapshot_path.parent / "market_agent_spawn_debug.ndjson"


def _append_spawn_debug(snapshot_path: Path, payload: dict[str, Any]) -> None:
    try:
        log_path = _spawn_debug_log_path(snapshot_path)
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with log_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, ensure_ascii=False) + "\n")
    except Exception:
        return


def _without_secrets(payload: dict[str, Any]) -> dict[str, Any]:
    clean = dict(payload)
    if clean.get("password"):
        clean["password"] = "***"
    return clean


def _redact_text(value: str, secrets: list[str]) -> str:
    redacted = value
    for secret in secrets:
        if secret:
            redacted = redacted.replace(secret, "***")
    return redacted


@dataclass
class BridgeRequest:
    account_id: str
    ctid: str
    password: str
    environment: str
    symbol: str
    symbol_id: int | None
    snapshot_path: Path
    quote_timeout_seconds: int
    quote_stale_after_seconds: int
    cli_executable: str

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "BridgeRequest":
        return cls(
            account_id=str(payload.get("accountId", "")).strip(),
            ctid=str(payload.get("ctid", "")).strip(),
            password=str(payload.get("password", "")).strip(),
            environment="live" if str(payload.get("environment", "")).lower() == "live" else "demo",
            symbol=str(payload.get("symbol", "XAUUSD") or "XAUUSD").strip() or "XAUUSD",
            symbol_id=_as_int(payload.get("symbolId")),
            snapshot_path=Path(str(payload.get("snapshotPath", "ctrader-live-quote.json"))),
            quote_timeout_seconds=int(payload.get("quoteTimeoutSeconds", 8) or 8),
            quote_stale_after_seconds=int(payload.get("quoteStaleAfterSeconds", 15) or 15),
            cli_executable=str(payload.get("cliExecutable", "ctrader-cli") or "ctrader-cli").strip()
            or "ctrader-cli",
        )

    def require_credentials(self) -> None:
        if not self.account_id or not self.ctid or not self.password:
            raise BridgeError("cTrader CLI credentials are incomplete.")

    def cli_payload(self, extra: dict[str, Any] | None = None) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "accountId": self.account_id,
            "ctid": self.ctid,
            "password": self.password,
            "environment": self.environment,
            "symbol": self.symbol,
            "symbolId": self.symbol_id,
        }
        if extra:
            payload.update(extra)
        return payload


class CTraderCliBridge:
    def __init__(self, request: BridgeRequest) -> None:
        self.request = request

    def _local_adapter_ps1_path(self) -> Path | None:
        executable_path = Path(self.request.cli_executable)
        if executable_path.suffix.lower() not in {".cmd", ".bat"}:
            return None
        adapter_ps1 = executable_path.with_suffix(".ps1")
        return adapter_ps1 if adapter_ps1.exists() else None

    def _local_quote_bridge_command(self) -> list[str] | None:
        adapter_ps1 = self._local_adapter_ps1_path()
        if adapter_ps1 is None:
            return None
        adapter_root = adapter_ps1.parent
        project_path = adapter_root / "ctrader-quote-bridge" / "ctrader-quote-bridge.csproj"
        release_dir = adapter_root / "ctrader-quote-bridge" / "bin" / "Release" / "net6.0"
        algo_candidates = [
            release_dir / "XAUUSDQuoteBridge.algo",
            release_dir / "XauusdQuoteBridge.algo",
        ]
        algo_path = next((candidate for candidate in algo_candidates if candidate.exists()), None)
        if not project_path.exists() or algo_path is None:
            return None
        dll_path = None
        try:
            for line in adapter_ps1.read_text(encoding="utf-8").splitlines():
                stripped = line.strip()
                if stripped.startswith('$dll = "') and stripped.endswith('"'):
                    dll_path = Path(stripped[len('$dll = "') : -1])
                    break
        except OSError:
            return None
        if dll_path is None or not dll_path.exists():
            return None
        return ["dotnet", str(dll_path), "run", str(algo_path)]

    def _run_local_quote_bridge(self) -> dict[str, Any]:
        base_command = self._local_quote_bridge_command()
        if base_command is None:
            raise BridgeError("Local cTrader quote bridge is unavailable.")
        password_fd, password_path = tempfile.mkstemp(prefix="ctrader-adapter-pwd-", suffix=".txt")
        os.close(password_fd)
        quote_fd, quote_path = tempfile.mkstemp(prefix="ctrader-quote-", suffix=".json")
        os.close(quote_fd)
        password_file = Path(password_path)
        quote_file = Path(quote_path)
        try:
            password_file.write_text(self.request.password, encoding="utf-8")
            cli_command = [
                *base_command,
                f"--ctid={self.request.ctid}",
                f"--pwd-file={password_file}",
                f"--account={self.request.account_id}",
                f"--symbol={self.request.symbol}",
                "--period=m1",
                "--full-access",
                "--exit-on-stop",
                f"--CustomParameter1={quote_file}",
            ]
            startupinfo = None
            creationflags = 0
            if os.name == "nt":
                startupinfo = subprocess.STARTUPINFO()
                startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                startupinfo.wShowWindow = 0
                creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            _append_spawn_debug(
                self.request.snapshot_path,
                {
                    "ts": _now_iso(),
                    "event": "spawn_request",
                    "layer": "ctrader_bridge_py",
                    "command": "quote",
                    "argv": cli_command,
                    "cwd": str(Path.cwd()),
                    "creationflags": creationflags,
                    "startupinfo_hidden": bool(startupinfo is not None),
                    "snapshot_path": str(self.request.snapshot_path),
                    "transport": "direct_dotnet_quote_bridge",
                },
            )
            process = subprocess.run(
                cli_command,
                text=True,
                capture_output=True,
                check=False,
                timeout=max(5, self.request.quote_timeout_seconds + 2),
                startupinfo=startupinfo,
                creationflags=creationflags,
            )
            _append_spawn_debug(
                self.request.snapshot_path,
                {
                    "ts": _now_iso(),
                    "event": "spawn_result",
                    "layer": "ctrader_bridge_py",
                    "command": "quote",
                    "argv": cli_command,
                    "returncode": process.returncode,
                    "stdout_preview": process.stdout.strip()[:400],
                    "stderr_preview": process.stderr.strip()[:400],
                    "transport": "direct_dotnet_quote_bridge",
                },
            )
            if process.returncode != 0:
                safe_error = _redact_text(process.stderr.strip() or process.stdout.strip(), [self.request.password, self.request.ctid])
                raise BridgeError(safe_error or f"cTrader quote bridge exited with code {process.returncode}.")
            if not quote_file.exists():
                raise BridgeError("cTrader quote bridge ran but did not write a quote payload.")
            quote_payload = json.loads(quote_file.read_text(encoding="utf-8"))
            if not isinstance(quote_payload, dict):
                raise BridgeError("cTrader quote bridge payload must be an object.")
            if quote_payload.get("ok") is False:
                raise BridgeError(str(quote_payload.get("error") or "cTrader quote bridge returned an error."))
            bid = float(quote_payload["bid"])
            ask = float(quote_payload["ask"])
            mid = float(quote_payload.get("mid") or ((bid + ask) / 2.0))
            timestamp = str(quote_payload["timestamp"])
            server_time = str(quote_payload.get("server_time") or _now_iso())
            symbol = str(quote_payload.get("symbol") or self.request.symbol)
            m1_bar = quote_payload.get("m1_bar") if isinstance(quote_payload.get("m1_bar"), dict) else {}
            return {
                "ok": True,
                "quote": {
                    "symbol": symbol,
                    "bid": bid,
                    "ask": ask,
                    "mid": mid,
                    "timestamp": timestamp,
                    "server_time": server_time,
                    "source": "cTrader CLI cBot bridge",
                    "source_type": "spot",
                },
                "bars": [
                    {
                        "symbol": symbol,
                        "data_timestamp": str(m1_bar.get("data_timestamp") or timestamp),
                        "open": m1_bar.get("open"),
                        "high": m1_bar.get("high"),
                        "low": m1_bar.get("low"),
                        "close": m1_bar.get("close"),
                        "bid": bid,
                        "ask": ask,
                        "source": "cTrader CLI cBot bridge",
                        "source_type": "spot_m1",
                        "data_mode": "live_seen",
                        "is_stale": False,
                        "stale_reason": "",
                    }
                ],
                "provider_health": {
                    "source": "cTrader",
                    "source_type": "spot",
                    "data_mode": "live_seen",
                    "is_available": True,
                    "is_stale": False,
                    "stale_reason": "",
                    "error": "",
                    "current_value": mid,
                    "data_timestamp": timestamp,
                    "fetched_at": server_time,
                    "raw_source_id": symbol,
                },
            }
        except FileNotFoundError as exc:
            raise BridgeError(
                "The local cTrader connector is not available. Install or repair the cTrader connector and try again."
            ) from exc
        except subprocess.TimeoutExpired as exc:
            _append_spawn_debug(
                self.request.snapshot_path,
                {
                    "ts": _now_iso(),
                    "event": "spawn_timeout",
                    "layer": "ctrader_bridge_py",
                    "command": "quote",
                    "argv": base_command,
                    "transport": "direct_dotnet_quote_bridge",
                },
            )
            raise BridgeError("cTrader CLI command timed out.") from exc
        finally:
            try:
                password_file.unlink(missing_ok=True)
            except TypeError:
                if password_file.exists():
                    password_file.unlink()
            try:
                quote_file.unlink(missing_ok=True)
            except TypeError:
                if quote_file.exists():
                    quote_file.unlink()

    def _build_cli_command(self, command: str) -> list[str]:
        executable = self.request.cli_executable
        executable_path = Path(executable)
        suffix = executable_path.suffix.lower()
        if suffix in {".cmd", ".bat"}:
            if not _allow_cli_adapter_shell():
                raise BridgeError(
                    "cTrader CLI adapter shell is disabled because it starts cmd/powershell/dotnet "
                    "processes. Use the long-running connector snapshot for live data."
                )
            adapter_ps1 = executable_path.with_suffix(".ps1")
            if adapter_ps1.exists():
                return [
                    "powershell.exe",
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-WindowStyle",
                    "Hidden",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    str(adapter_ps1),
                    command,
                ]
        return [executable, command]

    def _run_cli(self, command: str, extra: dict[str, Any] | None = None) -> dict[str, Any]:
        self.request.require_credentials()
        if command in {"test-connection", "resolve-symbol", "backfill"} and Path(self.request.cli_executable).suffix.lower() in {".cmd", ".bat"}:
            if not _allow_cli_adapter_shell():
                raise BridgeError(
                    "cTrader CLI adapter shell is disabled because it starts cmd/powershell/dotnet "
                    "processes. Save the connector settings and let the long-running connector write snapshots."
                )
        if command == "quote":
            direct_quote = self._local_quote_bridge_command()
            if direct_quote is not None:
                if not _env_bool("CTRADER_ALLOW_CBOT_BRIDGE"):
                    raise BridgeError(
                        "cTrader cBot quote bridge is disabled by default because it starts external "
                        "cTrader CLI/algo host processes. Use a long-running connector snapshot instead."
                    )
                return self._run_local_quote_bridge()
        payload = self.request.cli_payload(extra)
        cli_command = self._build_cli_command(command)
        startupinfo = None
        creationflags = 0
        if os.name == "nt":
            startupinfo = subprocess.STARTUPINFO()
            startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            startupinfo.wShowWindow = 0
            creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        _append_spawn_debug(
            self.request.snapshot_path,
            {
                "ts": _now_iso(),
                "event": "spawn_request",
                "layer": "ctrader_bridge_py",
                "command": command,
                "argv": cli_command,
                "cwd": str(Path.cwd()),
                "creationflags": creationflags,
                "startupinfo_hidden": bool(startupinfo is not None),
                "snapshot_path": str(self.request.snapshot_path),
            },
        )
        try:
            process = subprocess.run(
                cli_command,
                input=json.dumps(payload),
                text=True,
                capture_output=True,
                check=False,
                timeout=max(5, self.request.quote_timeout_seconds + 2),
                startupinfo=startupinfo,
                creationflags=creationflags,
            )
        except FileNotFoundError as exc:
            _append_spawn_debug(
                self.request.snapshot_path,
                {
                    "ts": _now_iso(),
                    "event": "spawn_error",
                    "layer": "ctrader_bridge_py",
                    "command": command,
                    "argv": cli_command,
                    "error": f"{exc}",
                },
            )
            raise BridgeError(
                "The local cTrader connector is not available. Install or repair the cTrader connector and try again."
            ) from exc
        except subprocess.TimeoutExpired as exc:
            _append_spawn_debug(
                self.request.snapshot_path,
                {
                    "ts": _now_iso(),
                    "event": "spawn_timeout",
                    "layer": "ctrader_bridge_py",
                    "command": command,
                    "argv": cli_command,
                },
            )
            raise BridgeError("cTrader CLI command timed out.") from exc

        _append_spawn_debug(
            self.request.snapshot_path,
            {
                "ts": _now_iso(),
                "event": "spawn_result",
                "layer": "ctrader_bridge_py",
                "command": command,
                "argv": cli_command,
                "returncode": process.returncode,
                "stdout_preview": process.stdout.strip()[:400],
                "stderr_preview": process.stderr.strip()[:400],
            },
        )

        stdout = process.stdout.strip()
        stderr = process.stderr.strip()
        if process.returncode != 0:
            safe_error = _redact_text(stderr or stdout, [self.request.password, self.request.ctid])
            raise BridgeError(safe_error or f"cTrader CLI exited with code {process.returncode}.")
        if not stdout:
            raise BridgeError("cTrader CLI returned no JSON payload.")
        try:
            parsed = json.loads(stdout)
        except json.JSONDecodeError as exc:
            raise BridgeError("cTrader CLI returned invalid JSON.") from exc
        if not isinstance(parsed, dict):
            raise BridgeError("cTrader CLI JSON payload must be an object.")
        return parsed

    def test_connection(self) -> dict[str, Any]:
        response = self._run_cli("test-connection")
        if response.get("ok") is False:
            return response
        return {
            "ok": True,
            "message": str(response.get("message", "cTrader CLI credentials accepted.")),
            "account": response.get("account")
            or {
                "ctidTraderAccountId": self.request.account_id,
                "environment": self.request.environment,
            },
            "symbol": response.get("symbol"),
            "provider_health": response.get("provider_health"),
        }

    def resolve_symbol(self) -> dict[str, Any]:
        if self.request.symbol_id is not None:
            return {
                "ok": True,
                "symbol": {"symbolId": self.request.symbol_id, "symbolName": self.request.symbol},
            }
        response = self._run_cli("resolve-symbol")
        symbol = response.get("symbol")
        if isinstance(symbol, dict):
            return {"ok": True, "symbol": symbol}
        symbol_id = response.get("symbolId") or response.get("symbol_id")
        symbol_name = response.get("symbolName") or response.get("symbol") or self.request.symbol
        if symbol_id is None:
            raise BridgeError("cTrader CLI did not return a symbol id.")
        return {
            "ok": True,
            "symbol": {
                "symbolId": symbol_id,
                "symbolName": symbol_name,
                "digits": response.get("digits"),
                "pipPosition": response.get("pipPosition") or response.get("pip_position"),
            },
        }

    def quote(self) -> dict[str, Any]:
        response = self._run_cli("quote")
        if response.get("ok") is False:
            return response
        quote = response.get("quote") if isinstance(response.get("quote"), dict) else response
        raw_bars = response.get("bars") if isinstance(response.get("bars"), list) else []
        timestamp = str(quote.get("timestamp") or quote.get("data_timestamp") or _now_iso())
        bid = quote.get("bid")
        ask = quote.get("ask")
        mid = quote.get("mid")
        if mid is None and bid is not None and ask is not None:
            mid = (float(bid) + float(ask)) / 2
        if mid is None:
            mid = quote.get("close") or quote.get("price")
        quote_time = _parse_timestamp(timestamp)
        now = datetime.now().astimezone()
        age_seconds = (now - quote_time).total_seconds() if quote_time is not None else None
        stale_after = max(1, self.request.quote_stale_after_seconds)
        is_stale = age_seconds is None or age_seconds > stale_after
        stale_reason = (
            "cTrader quote timestamp could not be parsed."
            if age_seconds is None
            else f"cTrader quote is {int(age_seconds)}s old; market may be closed or feed is paused."
        ) if is_stale else ""
        normalized_quote = {
            "symbol": str(quote.get("symbol", self.request.symbol)),
            "symbol_id": quote.get("symbol_id", quote.get("symbolId", self.request.symbol_id)),
            "bid": bid,
            "ask": ask,
            "mid": mid,
            "timestamp": timestamp,
            "source": "cTrader CLI",
            "source_type": "spot",
            "environment": self.request.environment,
            "account_id": self.request.account_id,
        }
        health = response.get("provider_health") if isinstance(response.get("provider_health"), dict) else {}
        provider_health = {
            **health,
            "source": "cTrader",
            "source_type": "spot",
            "data_mode": "stale" if is_stale else "live_seen",
            "is_available": True,
            "is_stale": is_stale,
            "stale_reason": stale_reason,
            "error": "",
            "current_value": mid,
            "data_timestamp": timestamp,
            "fetched_at": _now_iso(),
            "raw_source_id": str(normalized_quote.get("symbol_id") or self.request.symbol),
        }
        bars: list[dict[str, Any]] = []
        for bar in raw_bars:
            if not isinstance(bar, dict):
                continue
            bars.append(
                {
                    "symbol": str(bar.get("symbol", self.request.symbol)),
                    "data_timestamp": str(bar.get("data_timestamp") or bar.get("timestamp") or timestamp),
                    "open": bar.get("open"),
                    "high": bar.get("high"),
                    "low": bar.get("low"),
                    "close": bar.get("close"),
                    "bid": bar.get("bid", bid),
                    "ask": bar.get("ask", ask),
                    "source": str(bar.get("source", "cTrader CLI")),
                    "source_type": str(bar.get("source_type", "spot_m1")),
                    "data_mode": str(bar.get("data_mode", "live_seen")),
                    "is_stale": bool(bar.get("is_stale", is_stale)),
                    "stale_reason": str(bar.get("stale_reason", stale_reason if is_stale else "")),
                }
            )
        return {"ok": True, "quote": normalized_quote, "bars": bars, "provider_health": provider_health}

    def backfill(self, start: str, end: str) -> dict[str, Any]:
        response = self._run_cli("backfill", {"start": start, "end": end})
        if response.get("ok") is False:
            return response
        bars = response.get("bars")
        if not isinstance(bars, list):
            raise BridgeError("cTrader CLI backfill did not return bars.")
        health = response.get("provider_health") if isinstance(response.get("provider_health"), dict) else {}
        provider_health = {
            **health,
            "source": "cTrader",
            "source_type": "spot",
            "data_mode": "backfilled",
            "is_available": bool(bars),
            "is_stale": False,
            "stale_reason": "",
            "error": "",
            "data_timestamp": str(bars[-1].get("data_timestamp", end)) if bars else end,
            "fetched_at": _now_iso(),
            "raw_source_id": str(self.request.symbol_id or self.request.symbol),
        }
        return {"ok": True, "bars": bars, "provider_health": provider_health}


def handle(command: str, payload: dict[str, Any]) -> dict[str, Any]:
    request = BridgeRequest.from_payload(payload)
    bridge = CTraderCliBridge(request)
    if command == "test-connection":
        return bridge.test_connection()
    if command == "resolve-symbol":
        return bridge.resolve_symbol()
    if command == "quote":
        return bridge.quote()
    if command == "backfill":
        return bridge.backfill(str(payload.get("start", "")), str(payload.get("end", "")))
    raise BridgeError(f"Unsupported cTrader CLI bridge command: {command}")


def main() -> int:
    command = sys.argv[1] if len(sys.argv) > 1 else "quote"
    try:
        payload = _read_stdin()
        response = handle(command, payload)
        print(json.dumps(response, ensure_ascii=False))
        return 0 if response.get("ok", True) is not False else 1
    except Exception as exc:
        safe_payload = _without_secrets(_read_stdin()) if False else {}
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": str(exc),
                    "payload": safe_payload,
                },
                ensure_ascii=False,
            )
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
