import json

from src.xauusd_market_agent.fixtures import load_builtin_fixture
from src.xauusd_market_agent.llm_client import LocalLLMClient, LocalLLMConfig
from src.xauusd_market_agent.pipeline import analyze_fixture_with_optional_llm, build_llm_evidence_packet


class FakeAllowedLLM:
    def analyze(self, evidence_packet):
        return {
            "bias": "bearish_gold",
            "main_driver": "yields",
            "secondary_driver": "usd",
            "cause_status": "likely",
            "confidence": "high",
            "is_new_state": True,
            "is_continuation": False,
            "previous_state_invalidated": False,
            "should_notify": True,
            "notification_level": "level_2",
            "no_news_found": False,
            "allowed_candidate_drivers_used": ["yields", "usd"],
            "rejected_or_blocked_drivers_acknowledged": True,
            "timeline": [],
            "cross_asset_confirmation": {
                "dxy": "confirms",
                "us10y": "confirms",
                "us2y": "confirms",
                "oil": "neutral",
                "vix_equities": "neutral",
            },
            "evidence_status": {
                "dxy": "confirming",
                "us10y": "confirming",
                "us2y": "confirming",
                "oil": "not_confirming",
                "vix_equities": "not_confirming",
                "news": "relevant_news_found",
            },
            "causal_chain": "Rates pressure remains the main driver.",
            "invalidation_conditions": ["US10Y drops more than 7 bps"],
            "user_message": "Gold remains under pressure from rising yields and a firmer dollar.",
        }


class FakeBlockedLLM:
    def analyze(self, evidence_packet):
        return {
            "bias": "bearish_gold",
            "main_driver": "fed_rates",
            "secondary_driver": None,
            "cause_status": "possible",
            "confidence": "medium",
            "is_new_state": True,
            "is_continuation": False,
            "previous_state_invalidated": False,
            "should_notify": True,
            "notification_level": "level_2",
            "no_news_found": True,
            "allowed_candidate_drivers_used": ["fed_rates"],
            "rejected_or_blocked_drivers_acknowledged": False,
            "timeline": [],
            "cross_asset_confirmation": {
                "dxy": "neutral",
                "us10y": "neutral",
                "us2y": "neutral",
                "oil": "neutral",
                "vix_equities": "neutral",
            },
            "evidence_status": {
                "dxy": "not_confirming",
                "us10y": "not_confirming",
                "us2y": "not_confirming",
                "oil": "not_confirming",
                "vix_equities": "not_confirming",
                "news": "no_relevant_news_found",
            },
            "causal_chain": "Fed pressure likely drove gold lower.",
            "invalidation_conditions": [],
            "user_message": "Fed pressure hit gold.",
        }


class FakeTypeLooseLLM:
    def analyze(self, evidence_packet):
        return {
            "bias": "neutral",
            "main_driver": "unknown",
            "secondary_driver": "",
            "cause_status": "unconfirmed",
            "confidence": "low",
            "is_new_state": False,
            "is_continuation": True,
            "previous_state_invalidated": False,
            "should_notify": False,
            "notification_level": "none",
            "no_news_found": False,
            "allowed_candidate_drivers_used": "unknown",
            "rejected_or_blocked_drivers_acknowledged": ["fed_rates", "yields"],
            "timeline": None,
            "cross_asset_confirmation": {
                "dxy": "stale",
                "us10y": "stale",
                "us2y": "unavailable",
                "oil": "stale",
                "vix_equities": "stale",
            },
            "evidence_status": {
                "dxy": "stale",
                "us10y": "stale",
                "us2y": "unavailable",
                "oil": "stale",
                "vix_equities": "stale",
                "news": "relevant_news_found",
            },
            "causal_chain": [],
            "invalidation_conditions": None,
            "user_message": "",
            "summary": "Current conclusion is paused until live XAUUSD resumes.",
        }


def test_analyze_fixture_with_optional_llm_accepts_allowed_driver() -> None:
    fixture = load_builtin_fixture("yield_pressure_confirmed")

    result = analyze_fixture_with_optional_llm(fixture, llm_client=FakeAllowedLLM())

    assert result.main_driver == "yields"
    assert result.secondary_driver == "usd"
    assert result.analysis_engine == "llm_validated"
    assert result.llm_status == "validated"


def test_analyze_fixture_with_optional_llm_rejects_blocked_driver() -> None:
    fixture = load_builtin_fixture("llm_hallucination_guard")

    result = analyze_fixture_with_optional_llm(fixture, llm_client=FakeBlockedLLM())

    assert result.main_driver == "unknown"
    assert result.rejected_driver == "fed_rates"
    assert result.analysis_engine == "llm_validated"
    assert result.llm_status == "validated"


def test_analyze_fixture_with_optional_llm_accepts_type_loose_unknown_payload() -> None:
    fixture = load_builtin_fixture("llm_hallucination_guard")

    result = analyze_fixture_with_optional_llm(fixture, llm_client=FakeTypeLooseLLM())

    assert result.main_driver == "unknown"
    assert result.secondary_driver is None
    assert result.timeline == []
    assert result.user_message == "Current conclusion is paused until live XAUUSD resumes."
    assert result.analysis_engine == "llm_validated"
    assert result.llm_status == "validated"


def test_local_llm_prompt_contains_compact_evidence_packet(monkeypatch) -> None:
    fixture = load_builtin_fixture("yield_pressure_confirmed")
    evidence_packet = build_llm_evidence_packet(
        fixture,
        previous_state={
            "current_bias": "bearish_gold",
            "main_driver": "usd",
            "confidence": "medium",
        },
    )
    captured: dict[str, object] = {}

    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, str]:
            return {"response": "{}"}

    def fake_post(url, json, timeout):  # type: ignore[no-redef]
        captured["url"] = url
        captured["request_json"] = json
        captured["timeout"] = timeout
        return FakeResponse()

    monkeypatch.setattr("requests.post", fake_post)
    client = LocalLLMClient(
        LocalLLMConfig(
            enabled=True,
            endpoint="http://localhost:11434",
            model="qwen3.5:4b",
            timeout_seconds=20,
        )
    )

    client.analyze(evidence_packet)

    prompt = captured["request_json"]["prompt"]  # type: ignore[index]
    assert "allowed_candidate_drivers" in prompt
    assert "blocked_drivers" in prompt
    assert "cross_asset_confirmation" in prompt
    assert "evidence_status" in prompt
    assert "timeline" in prompt
    assert "market_move" in prompt
    assert "provider_health" in prompt
    assert "active_driver_states" in prompt
    assert "dormant_driver_states" in prompt
    assert "driver_attention_summary" in prompt
    assert "data_mode" in prompt
    assert "previous_state" in prompt
    assert "Required JSON object keys" in prompt


def test_local_llm_parses_qwen_thinking_json_when_response_is_empty(monkeypatch) -> None:
    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, str]:
            return {
                "response": "",
                "thinking": json.dumps(
                    {
                        "bias": "neutral",
                        "main_driver": "unknown",
                        "secondary_driver": None,
                        "cause_status": "unconfirmed",
                        "confidence": "low",
                        "is_new_state": False,
                        "is_continuation": False,
                        "previous_state_invalidated": False,
                        "should_notify": False,
                        "notification_level": "none",
                        "no_news_found": False,
                        "allowed_candidate_drivers_used": ["unknown"],
                        "rejected_or_blocked_drivers_acknowledged": True,
                        "timeline": [],
                        "cross_asset_confirmation": {
                            "dxy": "stale",
                            "us10y": "stale",
                            "us2y": "unavailable",
                            "oil": "stale",
                            "vix_equities": "stale",
                        },
                        "evidence_status": {
                            "dxy": "stale",
                            "us10y": "stale",
                            "us2y": "unavailable",
                            "oil": "stale",
                            "vix_equities": "stale",
                            "news": "relevant_news_found",
                        },
                        "causal_chain": "Current conclusion is paused until live XAUUSD resumes.",
                        "invalidation_conditions": [],
                        "user_message": "Current conclusion is paused until live XAUUSD resumes.",
                    }
                ),
            }

    monkeypatch.setattr("requests.post", lambda *args, **kwargs: FakeResponse())
    client = LocalLLMClient(LocalLLMConfig(enabled=True))

    result = client.analyze({"allowed_candidate_drivers": ["unknown"]})

    assert result is not None
    assert result["main_driver"] == "unknown"
    assert client.get_telemetry()[0]["status"] == "ok"


def test_local_llm_summarize_display_returns_structured_short_rows(monkeypatch) -> None:
    captured: dict[str, object] = {}

    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, str]:
            return {
                "response": json.dumps(
                    {
                        "news": [
                            {
                                "source_index": 0,
                                "summary_title": "Fed Rates Signal",
                                "summary": "Fed headline lifted yields; gold pressure stayed active.",
                            }
                        ],
                        "related_assets": {
                            "dxy": [
                                {
                                    "source_index": 0,
                                    "summary": "DXY strength confirmed USD pressure on gold.",
                                }
                            ]
                        },
                    }
                )
            }

    def fake_post(url, json, timeout):  # type: ignore[no-redef]
        captured["request_json"] = json
        return FakeResponse()

    monkeypatch.setattr("requests.post", fake_post)
    client = LocalLLMClient(LocalLLMConfig(enabled=True, model="qwen3.5:4b"))

    result = client.summarize_display(
        {
            "evidence_packet": {"allowed_candidate_drivers": ["yields"], "blocked_drivers": {}},
            "analysis": {"main_driver": "yields"},
            "news": [{"title": "Long Fed headline", "source": "Reuters"}],
            "calendar": [],
            "related_assets": [{"symbol": "dxy", "change_15m": 0.22}],
        }
    )

    prompt = captured["request_json"]["prompt"]  # type: ignore[index]
    assert "short UI summaries" in prompt
    assert "source_index" in prompt
    assert result["news"][0]["summary_title"] == "Fed Rates Signal"
    assert result["related_assets"]["dxy"][0]["summary"].startswith("DXY strength")


def test_enabled_local_llm_blocked_driver_claim_falls_back_to_unknown(monkeypatch) -> None:
    fixture = load_builtin_fixture("llm_hallucination_guard")

    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, str]:
            return {
                "response": json.dumps(
                    {
                        "bias": "bearish_gold",
                        "main_driver": "fed_rates",
                        "secondary_driver": None,
                        "cause_status": "possible",
                        "confidence": "medium",
                        "is_new_state": True,
                        "is_continuation": False,
                        "previous_state_invalidated": False,
                        "should_notify": True,
                        "notification_level": "level_2",
                        "no_news_found": True,
                        "allowed_candidate_drivers_used": ["fed_rates"],
                        "rejected_or_blocked_drivers_acknowledged": False,
                        "timeline": [],
                        "cross_asset_confirmation": {
                            "dxy": "neutral",
                            "us10y": "neutral",
                            "us2y": "neutral",
                            "oil": "neutral",
                            "vix_equities": "neutral",
                        },
                        "evidence_status": {
                            "dxy": "not_confirming",
                            "us10y": "not_confirming",
                            "us2y": "not_confirming",
                            "oil": "not_confirming",
                            "vix_equities": "not_confirming",
                            "news": "no_relevant_news_found",
                        },
                        "causal_chain": "Fed pressure likely drove gold lower.",
                        "invalidation_conditions": [],
                        "user_message": "Fed pressure hit gold.",
                    }
                )
            }

    monkeypatch.setattr("requests.post", lambda *args, **kwargs: FakeResponse())
    client = LocalLLMClient(LocalLLMConfig(enabled=True))

    result = analyze_fixture_with_optional_llm(fixture, llm_client=client)

    assert result.main_driver == "unknown"
    assert result.rejected_driver == "fed_rates"
    assert result.rejection_reason == "Fed/rates evidence is missing or stale."
