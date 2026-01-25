from __future__ import annotations

import json
import re
from pathlib import Path

INDEX_PATH = Path("data/event_history_index/event_history_by_event.index.json")
OUTPUT_PATH = Path("app/webui/src/data/event_notes.json")

CURRENCY_INFO = {
    "USD": {"region": "the United States", "bank": "the Fed"},
    "EUR": {"region": "the Eurozone", "bank": "the ECB"},
    "GBP": {"region": "the United Kingdom", "bank": "the BoE"},
    "JPY": {"region": "Japan", "bank": "the BoJ"},
    "CNY": {"region": "China", "bank": "the PBoC"},
    "AUD": {"region": "Australia", "bank": "the RBA"},
    "NZD": {"region": "New Zealand", "bank": "the RBNZ"},
    "CAD": {"region": "Canada", "bank": "the BoC"},
    "CHF": {"region": "Switzerland", "bank": "the SNB"},
}

FREQ_LABELS = {
    "m/m": "month-over-month",
    "y/y": "year-over-year",
    "q/q": "quarter-over-quarter",
    "w/w": "week-over-week",
    "none": "",
}

FREQ_DISPLAY = {
    "m/m": "MoM",
    "y/y": "YoY",
    "q/q": "QoQ",
    "w/w": "WoW",
    "none": "",
}

ACRONYMS = {
    "cpi": "CPI",
    "ppi": "PPI",
    "pce": "PCE",
    "gdp": "GDP",
    "pmi": "PMI",
    "ism": "ISM",
    "fed": "Fed",
    "ecb": "ECB",
    "boj": "BoJ",
    "boe": "BoE",
    "boc": "BoC",
    "rba": "RBA",
    "rbnz": "RBNZ",
    "snb": "SNB",
    "opec": "OPEC",
    "ioer": "IOER",
    "tankan": "Tankan",
    "ppi": "PPI",
    "pmi": "PMI",
    "iip": "IIP",
    "bnz": "BNZ",
}

METRIC_DEFINITION_RULES = [
    (
        re.compile(r"\bCPI\b|\bConsumer Price Index\b", re.IGNORECASE),
        "CPI is the Consumer Price Index, a basket of consumer prices.",
    ),
    (
        re.compile(r"\bPCE\b|\bPersonal Consumption Expenditures\b", re.IGNORECASE),
        "PCE is the Personal Consumption Expenditures price index, the Fed's preferred inflation gauge.",
    ),
    (
        re.compile(r"\bPPI\b|\bProducer Price Index\b", re.IGNORECASE),
        "PPI is the Producer Price Index, prices received by producers.",
    ),
    (
        re.compile(r"\bGDP\b|\bGross Domestic Product\b", re.IGNORECASE),
        "GDP is Gross Domestic Product, total economic output.",
    ),
    (
        re.compile(r"\bPMI\b|\bPurchasing Managers' Index\b", re.IGNORECASE),
        "PMI is a Purchasing Managers' Index, a survey of business activity.",
    ),
    (
        re.compile(r"\bISM\b|\bInstitute for Supply Management\b", re.IGNORECASE),
        "ISM is the Institute for Supply Management survey.",
    ),
    (
        re.compile(r"\bNFP\b|\bNonfarm Payrolls\b", re.IGNORECASE),
        "NFP is Nonfarm Payrolls, the monthly change in employment.",
    ),
]


def split_event_id(event_id: str) -> tuple[str, str, str]:
    parts = event_id.split("::")
    if len(parts) >= 3:
        return parts[0], parts[1], parts[2]
    if len(parts) == 2:
        return parts[0], parts[1], "none"
    return "NA", event_id, "none"


def humanize_metric(metric: str) -> str:
    text = metric.replace("_", " ").replace("-", " ")
    text = " ".join(text.split())
    words = text.split(" ")
    output: list[str] = []
    for word in words:
        lowered = word.lower()
        if lowered in {"and", "or", "of", "the", "to", "for", "in", "on", "vs"}:
            output.append(lowered)
            continue
        output.append(word.capitalize())
    result = " ".join(output)
    for token, label in ACRONYMS.items():
        result = re.sub(rf"\b{re.escape(token)}\b", label, result, flags=re.IGNORECASE)
    return result


def build_metric_definition(metric_label: str) -> str:
    for pattern, definition in METRIC_DEFINITION_RULES:
        if pattern.search(metric_label):
            return definition
    return ""


def category_for_metric(metric: str) -> str:
    text = metric.lower()
    if re.search(r"\b(holiday|bank holiday)\b", text):
        return "holiday"
    if re.search(r"\b(minutes|press conference|testimony|speech|statement)\b", text):
        return "policy-communication"
    if re.search(
        r"\b(interest rate|rate decision|policy rate|cash rate|bank rate|refinancing|fomc)\b",
        text,
    ):
        return "rates"
    if re.search(r"\b(cpi|inflation|pce|ppi|deflator|core)\b", text):
        return "inflation"
    if re.search(
        r"\b(nonfarm|employment|unemployment|jobless|claims|wage|earnings|labor)\b",
        text,
    ):
        return "labor"
    if re.search(
        r"\b(gdp|retail sales|pmi|ism|manufacturing|services|industrial production|"
        r"factory orders|durable goods)\b",
        text,
    ):
        return "growth"
    if re.search(r"\b(confidence|sentiment|survey)\b", text):
        return "sentiment"
    if re.search(r"\b(trade balance|current account|exports|imports)\b", text):
        return "trade"
    if re.search(
        r"\b(housing|home sales|housing starts|building permits|house price)\b",
        text,
    ):
        return "housing"
    if re.search(r"\b(m1|m2|m3|money supply|credit)\b", text):
        return "liquidity"
    if re.search(r"\b(budget|debt|fiscal|deficit|surplus)\b", text):
        return "fiscal"
    if re.search(r"\b(auction|bond|note|bill|yield)\b", text):
        return "rates-market"
    return "other"


def build_what(
    category: str, metric_label: str, region: str, bank: str, frequency: str
) -> str:
    freq = FREQ_LABELS.get(frequency, "")
    freq_suffix = f" It is reported on a {freq} basis." if freq else ""
    if category == "holiday":
        return "A market holiday with lighter trading and lower liquidity."
    if category == "policy-communication":
        return f"{bank} communication about policy outlook and guidance for {region}.{freq_suffix}"
    if category == "rates":
        return f"{bank} policy rate decision for {region}.{freq_suffix}"
    if category == "inflation":
        return f"An inflation reading for {region}.{freq_suffix}"
    if category == "labor":
        return f"A labor market report for {region} that tracks {metric_label}.{freq_suffix}"
    if category == "growth":
        return (
            f"A growth indicator for {region} that tracks {metric_label}.{freq_suffix}"
        )
    if category == "sentiment":
        return (
            f"A sentiment survey for {region} that tracks {metric_label}.{freq_suffix}"
        )
    if category == "trade":
        return f"A trade balance reading for {region} that tracks {metric_label}.{freq_suffix}"
    if category == "housing":
        return f"A housing activity reading for {region} that tracks {metric_label}.{freq_suffix}"
    if category == "liquidity":
        return f"A money and liquidity indicator for {region} that tracks {metric_label}.{freq_suffix}"
    if category == "fiscal":
        return f"A public finance update for {region} that tracks {metric_label}.{freq_suffix}"
    if category == "rates-market":
        return f"A market rate signal for {region} that tracks {metric_label}.{freq_suffix}"
    return f"A macro indicator for {region} that tracks {metric_label}.{freq_suffix}"


def build_direction(category: str) -> str:
    if category == "holiday":
        return "Lower liquidity can make XAUUSD moves sharper."
    if category == "policy-communication":
        return "A more hawkish message can pressure XAUUSD; a more dovish message can support it."
    if category == "rates":
        return "Higher rate expectations can pressure XAUUSD; lower expectations can support it."
    if category == "inflation":
        return "Higher-than-expected inflation can pressure XAUUSD; lower-than-expected inflation can support it."
    if category == "labor":
        return "Stronger-than-expected labor data can pressure XAUUSD; weaker data can support it."
    if category == "growth":
        return "Stronger growth can pressure XAUUSD; weaker growth can support it."
    if category == "sentiment":
        return "Risk-off readings can support XAUUSD, while risk-on sentiment can weigh on it."
    if category == "trade":
        return "Stronger external balance can support the currency and weigh on XAUUSD; a weaker balance can do the opposite."
    if category == "housing":
        return "Stronger housing data can pressure XAUUSD; weaker housing data can support it."
    if category == "liquidity":
        return "Faster money growth can pressure XAUUSD; slower growth can support it."
    if category == "fiscal":
        return "Worse fiscal balance can support XAUUSD; improving balance can weigh on it."
    if category == "rates-market":
        return "Higher yields can pressure XAUUSD; lower yields can support it."
    return "Direction depends on how the release shifts USD tone and real-rate expectations."


def build_frequency_explainer(frequency: str) -> str:
    if frequency == "y/y":
        return "YoY means the change versus the same period a year earlier."
    if frequency == "m/m":
        return "MoM means the change versus the previous month."
    if frequency == "q/q":
        return "QoQ means the change versus the previous quarter."
    if frequency == "w/w":
        return "WoW means the change versus the previous week."
    return ""


def lower_leading_article(text: str) -> str:
    if text.startswith("A "):
        return f"a {text[2:]}"
    if text.startswith("An "):
        return f"an {text[3:]}"
    return text


def main() -> None:
    if not INDEX_PATH.exists():
        raise SystemExit(f"Missing index file: {INDEX_PATH}")
    with INDEX_PATH.open(encoding="utf-8") as handle:
        payload = json.load(handle)
    event_ids = sorted(payload.get("index", {}).keys())

    notes: dict[str, dict[str, str]] = {}
    for event_id in event_ids:
        currency, metric, frequency = split_event_id(event_id)
        info = CURRENCY_INFO.get(
            currency, {"region": "the local economy", "bank": "the central bank"}
        )
        metric_label = humanize_metric(metric)
        category = category_for_metric(metric)
        frequency_explainer = build_frequency_explainer(frequency)
        freq_display = FREQ_DISPLAY.get(frequency, "")
        event_label = (
            f"{currency} {metric_label} ({freq_display})"
            if freq_display
            else f"{currency} {metric_label}".strip()
        )
        what = build_what(
            category, metric_label, info["region"], info["bank"], frequency
        )
        definition = build_metric_definition(metric_label)
        reaction = build_direction(category)
        explainer = f" {frequency_explainer}" if frequency_explainer else ""
        definition_text = f" {definition}" if definition else ""
        note = (
            f"{event_label} is {lower_leading_article(what)}{explainer}"
            f"{definition_text} {reaction}"
        )
        notes[event_id] = {"note": note.strip()}

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT_PATH.open("w", encoding="utf-8") as handle:
        json.dump(notes, handle, indent=2, ensure_ascii=True, sort_keys=True)
        handle.write("\n")


if __name__ == "__main__":
    main()
