import json
import threading
import time
from pathlib import Path

from src.xauusd_market_agent.providers import ctrader_live_stream


class _FakeProcess:
    def __init__(self) -> None:
        self.pid = 43210
        self._returncode = None

    def poll(self):
        return self._returncode

    def stop(self, code: int = 0) -> None:
        self._returncode = code


def _payload(status_path: Path, snapshot_path: Path) -> dict[str, object]:
    return {
        "statusPath": str(status_path),
        "snapshotPath": str(snapshot_path),
        "accountId": "123456",
        "ctid": "trader@example.com",
        "password": "super-secret-password",
        "symbol": "XAUUSD",
        "quoteStaleAfterSeconds": 30,
        "cliExecutable": str(status_path.parent / "ctrader-cli-adapter.cmd"),
    }


def test_ctrader_live_stream_marks_running_after_first_fresh_snapshot(tmp_path, monkeypatch) -> None:
    status_path = tmp_path / "ctrader_live_stream_status.json"
    snapshot_path = tmp_path / "ctrader-live-quote.json"
    fake_process = _FakeProcess()

    def fake_spawn(self):
        return fake_process, tmp_path / "pwd.txt", snapshot_path

    monkeypatch.setattr(ctrader_live_stream.LiveBridgeLauncher, "spawn", fake_spawn)
    monkeypatch.setattr(ctrader_live_stream, "_append_spawn_debug", lambda *_args, **_kwargs: None)

    worker = threading.Thread(
        target=ctrader_live_stream.run_live_stream,
        args=(_payload(status_path, snapshot_path),),
        daemon=True,
    )
    worker.start()

    for _ in range(20):
        if status_path.exists():
            break
        time.sleep(0.05)
    initial = json.loads(status_path.read_text(encoding="utf-8"))
    assert initial["phase"] in {"starting", "waiting_for_first_snapshot"}

    snapshot_path.write_text(
        json.dumps(
            {
                "ok": True,
                "symbol": "XAUUSD",
                "bid": 4512.3,
                "ask": 4512.7,
                "mid": 4512.5,
                "timestamp": ctrader_live_stream._now_iso(),
            }
        ),
        encoding="utf-8",
    )

    for _ in range(30):
        current = json.loads(status_path.read_text(encoding="utf-8"))
        if current["phase"] == "running":
            break
        time.sleep(0.05)
    else:
        raise AssertionError("live stream status never became running")

    assert current["running"] is True
    assert current["bridgePid"] == fake_process.pid
    assert "fresh snapshots" in current["message"]

    fake_process.stop(0)
    worker.join(timeout=2)


def test_ctrader_live_stream_reports_bridge_exit(tmp_path, monkeypatch) -> None:
    status_path = tmp_path / "ctrader_live_stream_status.json"
    snapshot_path = tmp_path / "ctrader-live-quote.json"
    fake_process = _FakeProcess()

    def fake_spawn(self):
        return fake_process, tmp_path / "pwd.txt", snapshot_path

    monkeypatch.setattr(ctrader_live_stream.LiveBridgeLauncher, "spawn", fake_spawn)
    monkeypatch.setattr(ctrader_live_stream, "_append_spawn_debug", lambda *_args, **_kwargs: None)

    worker = threading.Thread(
        target=ctrader_live_stream.run_live_stream,
        args=(_payload(status_path, snapshot_path),),
        daemon=True,
    )
    worker.start()
    time.sleep(0.1)
    fake_process.stop(17)
    worker.join(timeout=2)

    status = json.loads(status_path.read_text(encoding="utf-8"))
    assert status["running"] is False
    assert status["phase"] == "error"
    assert "exited with code 17" in status["lastError"]


def test_ctrader_live_stream_classifies_weekend_stale_snapshot_as_market_closed(tmp_path) -> None:
    snapshot_path = tmp_path / "ctrader-live-quote.json"
    snapshot_path.write_text(
        json.dumps(
            {
                "ok": True,
                "symbol": "XAUUSD",
                "bid": 4541.13,
                "ask": 4541.53,
                "mid": 4541.33,
                "timestamp": "2026-05-29T20:56:59.947000+00:00",
            }
        ),
        encoding="utf-8",
    )

    status = ctrader_live_stream._snapshot_freshness_status(
        snapshot_path,
        stale_after_seconds=45,
        now=ctrader_live_stream._parse_timestamp("2026-05-31T16:28:00+08:00"),
    )

    assert status["fresh"] is False
    assert status["classification"] == "market_closed"
    assert "closed" in status["message"].lower()
