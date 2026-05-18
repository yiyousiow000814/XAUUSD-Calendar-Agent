from src.xauusd_market_agent.cli import run_dry_scenario


def test_dry_run_returns_unconfirmed_report_for_unconfirmed_scenario() -> None:
    result = run_dry_scenario("unconfirmed_move")

    assert "No confirmed macro/news driver found." in result.user_message
    assert result.notification_level == "none"
