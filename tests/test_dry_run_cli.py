from src.xauusd_market_agent import cli
from src.xauusd_market_agent.cli import run_dry_scenario


def test_cli_reconfigures_stdout_to_utf8(monkeypatch) -> None:
    calls = []

    class FakeStdout:
        def reconfigure(self, **kwargs):
            calls.append(kwargs)

    class FakeParser:
        def __init__(self, *_args, **_kwargs):
            pass

        def add_argument(self, *_args, **_kwargs):
            return None

        def parse_args(self):
            return type(
                "Args",
                (),
                {
                    "list_scenarios": True,
                    "alert_history": False,
                    "refresh_related_assets": False,
                    "self_check": False,
                    "status": False,
                    "provider_health": False,
                    "timeline": False,
                    "replay": False,
                    "export_timeline": False,
                    "live_once": False,
                    "monitor_once": False,
                    "backfill_recovery": False,
                    "monitor_loop": False,
                },
            )()

    monkeypatch.setattr(cli.sys, "stdout", FakeStdout())
    monkeypatch.setattr(cli.argparse, "ArgumentParser", FakeParser)
    monkeypatch.setattr(cli, "list_builtin_scenarios", lambda: [])

    cli.main()

    assert calls == [{"encoding": "utf-8"}]


def test_dry_run_returns_unconfirmed_report_for_unconfirmed_scenario() -> None:
    result = run_dry_scenario("unconfirmed_move")

    assert "No confirmed macro/news driver found." in result.user_message
    assert result.notification_level == "none"
