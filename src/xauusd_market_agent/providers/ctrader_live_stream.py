from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from ..market_session import classify_xauusd_stale_quote


class LiveStreamError(RuntimeError):
    pass


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat()


def _read_stdin() -> dict[str, Any]:
    raw = sys.stdin.read().strip()
    if not raw:
        return {}
    payload = json.loads(raw)
    return payload if isinstance(payload, dict) else {}


def _write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(f"{path.suffix}.tmp-{os.getpid()}-{time.monotonic_ns()}")
    temp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    last_error: OSError | None = None
    for attempt in range(3):
        try:
            temp_path.replace(path)
            return
        except OSError as exc:
            last_error = exc
            if attempt < 2:
                time.sleep(0.05)
    try:
        temp_path.unlink(missing_ok=True)
    except TypeError:
        if temp_path.exists():
            temp_path.unlink()
    if last_error:
        raise last_error


def _mirror_snapshot_atomic(source_path: Path, destination_path: Path) -> bool:
    try:
        payload = source_path.read_text(encoding="utf-8")
    except OSError:
        return False
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = destination_path.with_suffix(f"{destination_path.suffix}.tmp-{os.getpid()}-{time.monotonic_ns()}")
    try:
        temp_path.write_text(payload, encoding="utf-8")
        for attempt in range(3):
            try:
                temp_path.replace(destination_path)
                return True
            except OSError:
                if attempt < 2:
                    time.sleep(0.05)
        return False
    except OSError:
        return False
    finally:
        try:
            temp_path.unlink(missing_ok=True)
        except TypeError:
            if temp_path.exists():
                temp_path.unlink()


def _append_spawn_debug(status_path: Path, payload: dict[str, Any]) -> None:
    try:
        log_path = status_path.parent / "market_agent_spawn_debug.ndjson"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with log_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, ensure_ascii=False) + "\n")
    except Exception:
        return


def _redact_text(value: str, secrets: list[str]) -> str:
    redacted = value
    for secret in secrets:
        if secret:
            redacted = redacted.replace(secret, "***")
    return redacted


def _parse_timestamp(value: str) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed.astimezone() if parsed.tzinfo else parsed.replace(tzinfo=datetime.now().astimezone().tzinfo)


def _status_payload(
    request: "LiveStreamRequest",
    *,
    ok: bool,
    running: bool,
    phase: str,
    message: str,
    bridge_pid: int | None = None,
    last_error: str = "",
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "ok": ok,
        "running": running,
        "phase": phase,
        "pid": os.getpid(),
        "bridgePid": bridge_pid,
        "startedAt": _now_iso(),
        "snapshotPath": str(request.snapshot_path),
        "message": message,
        "lastError": last_error,
    }
    if extra:
        payload.update(extra)
    return payload


def _snapshot_is_fresh(snapshot_path: Path, stale_after_seconds: int) -> bool:
    return bool(_snapshot_freshness_status(snapshot_path, stale_after_seconds=stale_after_seconds).get("fresh"))


def _snapshot_freshness_status(
    snapshot_path: Path,
    *,
    stale_after_seconds: int,
    now: datetime | None = None,
) -> dict[str, Any]:
    try:
        payload = json.loads(snapshot_path.read_text(encoding="utf-8"))
    except Exception:
        return {
            "fresh": False,
            "classification": "missing_snapshot",
            "message": "cTrader live stream has not written a quote snapshot yet.",
        }
    if not isinstance(payload, dict) or payload.get("ok") is False:
        return {
            "fresh": False,
            "classification": "invalid_snapshot",
            "message": "cTrader live stream snapshot is not usable.",
        }
    timestamp = str(payload.get("timestamp", "") or payload.get("server_time", "")).strip()
    if not timestamp:
        return {
            "fresh": False,
            "classification": "invalid_timestamp",
            "message": "cTrader live stream snapshot has no quote timestamp.",
        }
    parsed = _parse_timestamp(timestamp)
    if parsed is None:
        return {
            "fresh": False,
            "classification": "invalid_timestamp",
            "message": "cTrader live stream snapshot timestamp is invalid.",
        }
    anchor = now or datetime.now().astimezone()
    classification = classify_xauusd_stale_quote(
        quote_time=parsed,
        anchor_time=anchor,
        stale_after_seconds=stale_after_seconds,
    )
    return {
        "fresh": classification.classification == "fresh",
        "classification": classification.classification,
        "age_seconds": classification.age_seconds,
        "market_closed": classification.market_closed,
        "message": classification.reason,
    }


@dataclass
class LiveStreamRequest:
    account_id: str
    ctid: str
    password: str
    symbol: str
    snapshot_path: Path
    status_path: Path
    cli_executable: str
    stale_after_seconds: int

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "LiveStreamRequest":
        return cls(
            account_id=str(payload.get("accountId", "")).strip(),
            ctid=str(payload.get("ctid", "")).strip(),
            password=str(payload.get("password", "")).strip(),
            symbol=str(payload.get("symbol", "XAUUSD") or "XAUUSD").strip() or "XAUUSD",
            snapshot_path=Path(str(payload.get("snapshotPath", "")).strip()),
            status_path=Path(str(payload.get("statusPath", "")).strip()),
            cli_executable=str(payload.get("cliExecutable", "ctrader-cli") or "ctrader-cli").strip() or "ctrader-cli",
            stale_after_seconds=int(payload.get("quoteStaleAfterSeconds", 20) or 20),
        )

    def require_ready(self) -> None:
        if not self.account_id or not self.ctid or not self.password:
            raise LiveStreamError("cTrader live stream credentials are incomplete.")
        if not str(self.snapshot_path):
            raise LiveStreamError("Live stream snapshot path is missing.")
        if not str(self.status_path):
            raise LiveStreamError("Live stream status path is missing.")


class LiveBridgeLauncher:
    def __init__(self, request: LiveStreamRequest) -> None:
        self.request = request

    def _adapter_ps1_path(self) -> Path:
        executable_path = Path(self.request.cli_executable)
        if executable_path.suffix.lower() not in {".cmd", ".bat"}:
            raise LiveStreamError(
                "Live cTrader stream requires the local ctrader-cli-adapter.cmd bridge."
            )
        adapter_ps1 = executable_path.with_suffix(".ps1")
        if not adapter_ps1.exists():
            raise LiveStreamError("Local cTrader adapter PowerShell bridge is missing.")
        return adapter_ps1

    def _adapter_root(self) -> Path:
        return self._adapter_ps1_path().parent

    def _dll_path(self) -> Path:
        adapter_ps1 = self._adapter_ps1_path()
        try:
            for line in adapter_ps1.read_text(encoding="utf-8").splitlines():
                stripped = line.strip()
                if stripped.startswith('$dll = "') and stripped.endswith('"'):
                    dll_path = Path(stripped[len('$dll = "') : -1])
                    if dll_path.exists():
                        return dll_path
        except OSError as exc:
            raise LiveStreamError(f"Unable to read local cTrader adapter bridge: {exc}") from exc
        raise LiveStreamError("Local cTrader CLI DLL path is missing from the adapter bridge.")

    def _bridge_project_path(self) -> Path:
        return self._adapter_root() / "ctrader-quote-bridge" / "ctrader-live-stream-bridge.csproj"

    def _bridge_source_path(self) -> Path:
        return self._adapter_root() / "ctrader-quote-bridge" / "XAUUSDLiveStreamBridge.cs"

    def _algo_path(self) -> Path:
        return self._adapter_root() / "ctrader-quote-bridge" / "bin" / "Release" / "net6.0" / "XAUUSDLiveStreamBridge.algo"

    def _ensure_live_bridge_built(self) -> None:
        project_path = self._bridge_project_path()
        source_path = self._bridge_source_path()
        algo_path = self._algo_path()
        if not project_path.exists():
            raise LiveStreamError("The local cTrader live stream bridge project is missing.")
        needs_build = not algo_path.exists()
        if source_path.exists() and algo_path.exists():
            needs_build = source_path.stat().st_mtime > algo_path.stat().st_mtime
        if not needs_build:
            return
        startupinfo = None
        creationflags = 0
        if os.name == "nt":
            startupinfo = subprocess.STARTUPINFO()
            startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            startupinfo.wShowWindow = 0
            creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        process = subprocess.run(
            ["dotnet", "build", str(project_path), "-c", "Release"],
            text=True,
            capture_output=True,
            check=False,
            startupinfo=startupinfo,
            creationflags=creationflags,
        )
        if process.returncode != 0 or not algo_path.exists():
            error = (process.stderr or process.stdout).strip() or "The local cTrader live stream bridge build failed."
            raise LiveStreamError(error)

    def build_command(self, password_file: Path, bridge_snapshot_path: Path) -> list[str]:
        self._ensure_live_bridge_built()
        return [
            "dotnet",
            str(self._dll_path()),
            "run",
            str(self._algo_path()),
            f"--ctid={self.request.ctid}",
            f"--pwd-file={password_file}",
            f"--account={self.request.account_id}",
            f"--symbol={self.request.symbol}",
            "--period=m1",
            "--full-access",
            f"--CustomParameter1={bridge_snapshot_path}",
        ]

    def spawn(self) -> tuple[subprocess.Popen[str], Path, Path]:
        password_fd, password_path = tempfile.mkstemp(prefix="ctrader-live-pwd-", suffix=".txt")
        os.close(password_fd)
        bridge_fd, bridge_snapshot_path = tempfile.mkstemp(
            prefix="ctrader-live-bridge-quote-", suffix=".json"
        )
        os.close(bridge_fd)
        password_file = Path(password_path)
        bridge_snapshot_file = Path(bridge_snapshot_path)
        password_file.write_text(self.request.password, encoding="utf-8")
        command = self.build_command(password_file, bridge_snapshot_file)
        startupinfo = None
        creationflags = 0
        if os.name == "nt":
            startupinfo = subprocess.STARTUPINFO()
            startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            startupinfo.wShowWindow = 0
            creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        _append_spawn_debug(
            self.request.status_path,
            {
                "ts": _now_iso(),
                "event": "live_stream_spawn_request",
                "layer": "ctrader_live_stream_py",
                "argv": command,
                "bridge_snapshot_path": str(bridge_snapshot_file),
                "snapshot_path": str(self.request.snapshot_path),
                "status_path": str(self.request.status_path),
            },
        )
        try:
            process = subprocess.Popen(
                command,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                text=True,
                startupinfo=startupinfo,
                creationflags=creationflags,
            )
        except FileNotFoundError as exc:
            password_file.unlink(missing_ok=True)
            bridge_snapshot_file.unlink(missing_ok=True)
            raise LiveStreamError(
                "The local cTrader live stream bridge is not available. Install or repair the adapter and try again."
            ) from exc
        return process, password_file, bridge_snapshot_file


def run_live_stream(payload: dict[str, Any]) -> int:
    request = LiveStreamRequest.from_payload(payload)
    request.require_ready()
    launcher = LiveBridgeLauncher(request)
    _write_json_atomic(
        request.status_path,
        _status_payload(
            request,
            ok=True,
            running=False,
            phase="starting",
            message="Starting cTrader live stream bridge.",
            bridge_pid=None,
        ),
    )
    process, password_file, bridge_snapshot_file = launcher.spawn()
    try:
        _write_json_atomic(
            request.status_path,
            _status_payload(
                request,
                ok=True,
                running=True,
                phase="waiting_for_first_snapshot",
                message="cTrader live stream bridge is running. Waiting for the first fresh XAUUSD snapshot.",
                bridge_pid=process.pid,
            ),
        )
        last_phase = "waiting_for_first_snapshot"
        while True:
            if bridge_snapshot_file.exists():
                _mirror_snapshot_atomic(bridge_snapshot_file, request.snapshot_path)
            return_code = process.poll()
            if return_code is not None:
                _append_spawn_debug(
                    request.status_path,
                    {
                        "ts": _now_iso(),
                        "event": "live_stream_bridge_exit",
                        "layer": "ctrader_live_stream_py",
                        "returncode": return_code,
                        "bridge_pid": process.pid,
                    },
                )
                _write_json_atomic(
                    request.status_path,
                    _status_payload(
                        request,
                        ok=False,
                        running=False,
                        phase="error",
                        message="Live quote stream stopped unexpectedly.",
                        bridge_pid=process.pid,
                        last_error=f"cTrader live stream bridge exited with code {return_code}.",
                        extra={"stoppedAt": _now_iso()},
                    ),
                )
                return 1

            freshness = _snapshot_freshness_status(
                bridge_snapshot_file,
                stale_after_seconds=request.stale_after_seconds,
            )
            fresh = bool(freshness.get("fresh"))
            classification = str(freshness.get("classification", "waiting"))
            if fresh and last_phase != "running":
                last_phase = "running"
                _write_json_atomic(
                    request.status_path,
                    _status_payload(
                        request,
                        ok=True,
                        running=True,
                        phase="running",
                        message="cTrader live quote stream is producing fresh snapshots.",
                        bridge_pid=process.pid,
                    ),
                )
            elif classification == "market_closed" and last_phase != "market_closed":
                last_phase = "market_closed"
                _write_json_atomic(
                    request.status_path,
                    _status_payload(
                        request,
                        ok=True,
                        running=True,
                        phase="market_closed",
                        message=str(freshness.get("message") or "XAUUSD market is closed; waiting for the next live quote."),
                        bridge_pid=process.pid,
                        extra={
                            "quoteAgeSeconds": freshness.get("age_seconds"),
                            "staleClassification": classification,
                        },
                    ),
                )
            elif not fresh and classification != "market_closed" and last_phase != "waiting_for_first_snapshot":
                last_phase = "waiting_for_first_snapshot"
                _write_json_atomic(
                    request.status_path,
                    _status_payload(
                        request,
                        ok=True,
                        running=True,
                        phase="waiting_for_first_snapshot",
                        message="cTrader live stream bridge is running. Waiting for the next fresh XAUUSD snapshot.",
                        bridge_pid=process.pid,
                    ),
                )
            time.sleep(0.5)
    finally:
        try:
            password_file.unlink(missing_ok=True)
        except TypeError:
            if password_file.exists():
                password_file.unlink()
        try:
            bridge_snapshot_file.unlink(missing_ok=True)
        except TypeError:
            if bridge_snapshot_file.exists():
                bridge_snapshot_file.unlink()


def main() -> int:
    command = sys.argv[1] if len(sys.argv) > 1 else "start"
    payload = _read_stdin()
    status_path = Path(str(payload.get("statusPath", "")).strip()) if payload else None
    try:
        if command != "start":
            raise LiveStreamError(f"Unsupported live stream command: {command}")
        return run_live_stream(payload)
    except Exception as exc:
        if status_path and str(status_path):
            request = LiveStreamRequest.from_payload(payload)
            try:
                _write_json_atomic(
                    status_path,
                    _status_payload(
                        request,
                        ok=False,
                        running=False,
                        phase="error",
                        message="Unable to start cTrader live quote stream.",
                        bridge_pid=None,
                        last_error=_redact_text(str(exc), [request.password, request.ctid]),
                        extra={"stoppedAt": _now_iso()},
                    ),
                )
            except Exception:
                pass
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
