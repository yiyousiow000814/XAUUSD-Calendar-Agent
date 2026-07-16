from __future__ import annotations

from datetime import datetime

from src.xauusd_market_agent.providers.trading_economics import TradingEconomicsQuoteProvider, TradingEconomicsUS2YProvider


class FakeResponse:
    text = """
    <script>TELastUpdate = '202606120540';</script>
    <script type="text/javascript" language="Javascript">TEChartsMeta = [{"value":4.081000000000,"last":4.081000000000,"type":"Bond","name":"US 2Y","full_name":"US 2 Year Note Bond Yield","ticker":"USGG2YR:IND","supported_resolutions":["5","15"],"has_intraday":true}]; console.log('TEChartsMeta:', TEChartsMeta);</script>
    """

    def raise_for_status(self) -> None:
        return None


class FakeSession:
    def get(self, url, timeout):
        assert "2-year-note-yield" in url
        assert timeout == 20
        return FakeResponse()


def test_trading_economics_us2y_provider_reads_quote_and_uses_cache(tmp_path) -> None:
    cache_path = tmp_path / "us2y-cache.json"
    cache_path.write_text(
        '{"rows":[{"timestamp":"2026-06-12T05:25:00+00:00","value":4.031}]}',
        encoding="utf-8",
    )
    provider = TradingEconomicsUS2YProvider(cache_path=cache_path, session=FakeSession())

    rows, health = provider.fetch_latest(datetime.fromisoformat("2026-06-12T05:45:00+00:00"))

    assert len(rows) == 1
    assert rows[0]["symbol"] == "us2y"
    assert rows[0]["source"] == "Trading Economics"
    assert rows[0]["change_unit"] == "bps"
    assert round(rows[0]["change_15m"], 6) == 5.0
    assert health.is_available is True
    assert health.raw_source_id == "USGG2YR:IND"
    assert health.change_unit == "bps"


def test_trading_economics_index_provider_reports_percent_change(tmp_path) -> None:
    class FakeIndexResponse:
        text = """
        <script>TELastUpdate = '202606120745';</script>
        <script>TEChartsMeta = [{"value":19.240000000000,"last":19.240000000000,"ticker":"VIX:IND"}];</script>
        """

        def raise_for_status(self) -> None:
            return None

    class FakeIndexSession:
        def get(self, url, timeout):
            assert "vix:ind" in url
            return FakeIndexResponse()

    cache_path = tmp_path / "vix-cache.json"
    cache_path.write_text(
        '{"rows":[{"timestamp":"2026-06-12T07:30:00+00:00","value":19.00}]}',
        encoding="utf-8",
    )
    provider = TradingEconomicsQuoteProvider(symbol="vix", cache_path=cache_path, session=FakeIndexSession())

    rows, health = provider.fetch_latest(datetime.fromisoformat("2026-06-12T07:50:00+00:00"))

    assert rows[0]["symbol"] == "vix"
    assert rows[0]["change_unit"] == "percent"
    assert round(rows[0]["change_15m"], 6) == round(((19.24 - 19.0) / 19.0) * 100, 6)
    assert health.source_type == "index_quote"
    assert health.raw_source_id == "VIX:IND"
