from __future__ import annotations

import re
from dataclasses import dataclass

_FREQUENCY_ALIASES = {
    "m/m": "m/m",
    "mom": "m/m",
    "y/y": "y/y",
    "yoy": "y/y",
    "q/q": "q/q",
    "qoq": "q/q",
    "w/w": "w/w",
    "wow": "w/w",
}

_MONTH_TOKENS = {
    "jan",
    "january",
    "feb",
    "february",
    "mar",
    "march",
    "apr",
    "april",
    "may",
    "jun",
    "june",
    "jul",
    "july",
    "aug",
    "august",
    "sep",
    "sept",
    "september",
    "oct",
    "october",
    "nov",
    "november",
    "dec",
    "december",
}

_PERIOD_RE = re.compile(r"^(?:q[1-4]|h[1-2])$", re.IGNORECASE)
_TRAILING_PAREN_RE = re.compile(r"\(([^()]*)\)\s*$")
_FREQUENCY_RE = re.compile(r"\b(m/m|mom|y/y|yoy|q/q|qoq|w/w|wow)\b", re.IGNORECASE)


@dataclass(frozen=True)
class EventIdentity:
    metric: str
    frequency: str
    period: str


def _strip_trailing_parenthetical(text: str) -> tuple[str, str]:
    match = _TRAILING_PAREN_RE.search(text)
    if not match:
        return text, ""
    return text[: match.start()].rstrip(), match.group(1).strip()


def _normalize_frequency(token: str) -> str:
    normalized = token.strip().lower()
    normalized = normalized.replace(".", "").replace(" ", "")
    return _FREQUENCY_ALIASES.get(normalized, "")


def _is_period_token(token: str) -> bool:
    if not token:
        return False
    lowered = token.strip().lower()
    if lowered in _MONTH_TOKENS:
        return True
    return bool(_PERIOD_RE.match(lowered))


def normalize_event_metric(value: str) -> str:
    if not value:
        return "unknown"
    normalized = value.replace("\u2013", "-").replace("\u2014", "-")
    normalized = re.sub(r"\s*-\s*", " - ", normalized)
    normalized = " ".join(normalized.split())
    normalized = normalized.strip().lower()
    return normalized or "unknown"


def parse_event_components(event_name: str) -> EventIdentity:
    base = (event_name or "").strip()
    period = ""
    frequency = ""

    if base:
        base, trailing = _strip_trailing_parenthetical(base)
        if _is_period_token(trailing):
            period = trailing
        else:
            base = f"{base} ({trailing})".strip() if trailing else base

    if base:
        base, trailing = _strip_trailing_parenthetical(base)
        normalized = _normalize_frequency(trailing)
        if normalized:
            frequency = normalized
        else:
            base = f"{base} ({trailing})".strip() if trailing else base

    if base and not frequency:
        match = _FREQUENCY_RE.search(base)
        if match and match.end() == len(base):
            normalized = _normalize_frequency(match.group(1))
            if normalized:
                frequency = normalized
                base = base[: match.start()].rstrip()

    metric = " ".join(base.split()).strip()
    if not metric:
        metric = event_name.strip() if event_name else ""
    return EventIdentity(metric=metric, frequency=frequency or "none", period=period)


def build_event_canonical_id(cur: str, event_name: str) -> tuple[str, EventIdentity]:
    identity = parse_event_components(event_name)
    currency = (cur or "").strip().upper()
    if currency in {"", "--", "-", "\u2014"}:
        currency = "NA"
    metric = normalize_event_metric(identity.metric)
    safe_metric = metric.replace("::", " ")
    event_id = f"{currency}::{safe_metric}::{identity.frequency}"
    return event_id, identity
