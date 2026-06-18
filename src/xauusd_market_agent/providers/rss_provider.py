from __future__ import annotations

from datetime import datetime, timedelta
from email.utils import parsedate_to_datetime
import html
import re
from pathlib import Path
from time import perf_counter
from typing import Any
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from xml.etree import ElementTree as ET

from ..models import ProviderHealth


_SOURCE_SCORES = {
    "frb": 1.0,
    "federal reserve": 1.0,
    "bls": 1.0,
    "bea": 0.95,
    "eia": 0.95,
    "reuters": 0.92,
    "bloomberg": 0.9,
    "cnbc": 0.78,
    "top news and analysis": 0.78,
    "us top news and analysis": 0.78,
    "kitco": 0.72,
    "fxstreet": 0.7,
    "marketwatch": 0.66,
}

_EVENT_KEYWORDS = (
    "brent",
    "crude",
    "cpi",
    "dxy",
    "dollar",
    "fed",
    "fomc",
    "gdp",
    "gold",
    "inflation",
    "inventory",
    "inventories",
    "jobs",
    "nfp",
    "oil",
    "opec",
    "payroll",
    "pce",
    "ppi",
    "powell",
    "rate",
    "rates",
    "tariff",
    "treasury",
    "unemployment",
    "wti",
    "xauusd",
    "yield",
    "yields",
)
_GEOPOLITICAL_KEYWORDS = (
    "conflict",
    "geopolitical",
    "airspace",
    "attack",
    "attacks",
    "ceasefire",
    "hormuz",
    "iran",
    "israel",
    "lebanon",
    "middle east",
    "military",
    "missile",
    "red sea",
    "russia",
    "sanction",
    "strike",
    "strikes",
    "strait of hormuz",
    "ukraine",
)
_OFFICIAL_MACRO_SOURCES = ("frb", "federal reserve", "bls", "bea", "eia")
_LOW_SIGNAL_KEYWORDS = ("opinion", "forecast", "analysis", "explainer", "preview", "portfolio")
_PERSONAL_FINANCE_KEYWORDS = (
    "social security",
    "cola",
    "retirement",
    "retiree",
    "retirees",
    "medicare",
    "401(k)",
    "parent plus",
)
_MARKET_CONFIRMATION_KEYWORDS = (
    "gold",
    "xauusd",
    "dollar",
    "dxy",
    "fomc",
    "federal reserve",
    "fed chair",
    "cpi",
    "pce",
    "ppi",
    "payroll",
    "nfp",
    "jobs report",
    "rate",
    "rates",
    "yield",
    "yields",
    "treasury",
    "oil",
    "crude",
    "brent",
    "wti",
)
_FED_RESERVE_CONTEXT_KEYWORDS = (
    "federal reserve",
    "fomc",
    "powell",
    "warsh",
    "rate",
    "rates",
    "cut",
    "cuts",
    "hike",
    "inflation",
    "treasury",
    "yield",
    "yields",
    "chair",
    "chairman",
    "governor",
    "governors",
    "minutes",
    "policy",
    "speaker",
)
_HTTP_USER_AGENT = "Mozilla/5.0 (compatible; XAUUSD-Calendar-Agent/1.0)"
_MAX_NEWS_ITEM_AGE = timedelta(hours=72)
_PREVIEW_MAX_CHARS = 500


def _decode_feed_bytes(raw: bytes, declared_charset: str | None = None) -> str:
    candidates = [declared_charset, "utf-8", "cp1252", "latin-1"]
    seen: set[str] = set()
    for candidate in candidates:
        if not candidate:
            continue
        encoding = candidate.strip().lower()
        if not encoding or encoding in seen:
            continue
        seen.add(encoding)
        try:
            return raw.decode(encoding, errors="strict")
        except (LookupError, UnicodeDecodeError):
            continue
    return raw.decode("utf-8", errors="replace")


def _coerce_dt(raw: str) -> datetime | None:
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw)
    except ValueError:
        try:
            parsed = parsedate_to_datetime(raw)
            if parsed.tzinfo is None:
                return parsed.replace(tzinfo=datetime.now().astimezone().tzinfo)
            return parsed
        except Exception:
            return None


def _read_feed(feed_url: str) -> str | None:
    try:
        parsed = urlparse(feed_url)
        if parsed.scheme not in {"http", "https"} and Path(feed_url).exists():
            return _decode_feed_bytes(Path(feed_url).read_bytes())
        request = Request(feed_url, headers={"User-Agent": _HTTP_USER_AGENT})
        with urlopen(request, timeout=15) as response:
            charset = response.headers.get_content_charset() if response.headers else None
            return _decode_feed_bytes(response.read(), charset)
    except Exception:
        return None


def _clean_preview(raw: str) -> str:
    text = html.unescape(raw or "")
    text = re.sub(r"(?is)<script\b.*?</script>", " ", text)
    text = re.sub(r"(?is)<style\b.*?</style>", " ", text)
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    text = " ".join(text.split())
    if len(text) <= _PREVIEW_MAX_CHARS:
        return text
    return text[:_PREVIEW_MAX_CHARS].rsplit(" ", 1)[0].rstrip()


def _item_preview(item: ET.Element) -> str:
    candidates = [
        item.findtext("description", default=""),
        item.findtext("summary", default=""),
    ]
    for child in item:
        local_name = child.tag.rsplit("}", 1)[-1].lower()
        if local_name in {"encoded", "content"} and child.text:
            candidates.append(child.text)
    for candidate in candidates:
        preview = _clean_preview(candidate or "")
        if preview:
            return preview
    return ""


def _keyword_matches(title: str) -> list[str]:
    lowered_title = title.lower()
    matched: list[str] = []
    has_federal_reserve_context = any(word in lowered_title for word in _FED_RESERVE_CONTEXT_KEYWORDS)
    for word in _EVENT_KEYWORDS:
        if word == "fed" and not has_federal_reserve_context:
            continue
        if " " in word:
            if word in lowered_title:
                matched.append(word)
        elif re.search(rf"\b{re.escape(word)}\b", lowered_title):
            matched.append(word)
    geo_matches = [word for word in _GEOPOLITICAL_KEYWORDS if word in lowered_title]
    if geo_matches:
        matched.extend(geo_matches)
        if re.search(r"\bwar\b", lowered_title):
            matched.append("war")
    return sorted(set(matched))


def _is_stale_news_item(published: datetime | None, seen_at: datetime) -> bool:
    if published is None:
        return False
    anchor = seen_at
    item_time = published
    if anchor.tzinfo is None and item_time.tzinfo is not None:
        anchor = anchor.replace(tzinfo=item_time.tzinfo)
    elif anchor.tzinfo is not None and item_time.tzinfo is None:
        item_time = item_time.replace(tzinfo=anchor.tzinfo)
    return item_time < anchor - _MAX_NEWS_ITEM_AGE


def _score_item(
    source: str,
    title: str,
    published: datetime | None,
    seen_at: datetime,
) -> tuple[float, float, list[str], bool, str]:
    lowered_source = source.lower()
    lowered_title = title.lower()
    matched = _keyword_matches(title)
    has_timestamp = published is not None
    stale_news_item = _is_stale_news_item(published, seen_at)
    source_score = max((score for key, score in _SOURCE_SCORES.items() if key in lowered_source), default=0.45)
    keyword_bonus = min(len(matched) * 0.05, 0.2)
    low_signal_penalty = 0.2 if any(word in lowered_title for word in _LOW_SIGNAL_KEYWORDS) else 0.0
    personal_finance_noise = (
        any(word in lowered_title for word in _PERSONAL_FINANCE_KEYWORDS)
        and not any(word in lowered_title for word in _MARKET_CONFIRMATION_KEYWORDS)
    )
    timestamp_penalty = 0.15 if not has_timestamp else 0.0
    score = max(0.0, min(1.0, source_score + keyword_bonus - low_signal_penalty - timestamp_penalty))
    has_market_agent_signal = bool(matched)
    included = (
        score >= 0.55
        and has_timestamp
        and low_signal_penalty == 0.0
        and not personal_finance_noise
        and has_market_agent_signal
        and not stale_news_item
    )
    if not has_timestamp:
        filter_reason = "missing_timestamp"
    elif stale_news_item:
        filter_reason = "stale_news_item"
    elif low_signal_penalty > 0.0:
        filter_reason = "low_signal_opinion_or_forecast"
    elif personal_finance_noise:
        filter_reason = "personal_finance_noise"
    elif not has_market_agent_signal:
        filter_reason = "no_market_agent_keyword"
    elif score < 0.55:
        filter_reason = "score_below_threshold"
    else:
        filter_reason = ""
    return score, source_score, matched, included, filter_reason


class RSSNewsProvider:
    def __init__(self, feeds: list[str]) -> None:
        self.feeds = feeds

    def _fetch(self, *, seen_at: datetime, data_mode: str) -> tuple[list[dict[str, Any]], ProviderHealth]:
        items: list[dict[str, Any]] = []
        dedupe: set[tuple[str, str]] = set()
        attempted_feeds: list[str] = []
        successful_feeds: list[str] = []
        feed_statuses: list[dict[str, Any]] = []
        started_at = perf_counter()
        for feed_url in self.feeds:
            feed_started_at = perf_counter()
            attempted_feeds.append(feed_url)
            xml_text = _read_feed(feed_url)
            if not xml_text:
                feed_statuses.append(
                    {
                        "feed_url": feed_url,
                        "status": "failed",
                        "reason": "Feed could not be read.",
                        "headline_count": 0,
                        "included_count": 0,
                        "latency_ms": round((perf_counter() - feed_started_at) * 1000, 2),
                    }
                )
                continue
            try:
                root = ET.fromstring(xml_text)
            except ET.ParseError:
                feed_statuses.append(
                    {
                        "feed_url": feed_url,
                        "status": "failed",
                        "reason": "Feed XML could not be parsed.",
                        "headline_count": 0,
                        "included_count": 0,
                        "latency_ms": round((perf_counter() - feed_started_at) * 1000, 2),
                    }
                )
                continue
            successful_feeds.append(feed_url)
            channel_title = root.findtext("./channel/title", default=feed_url)
            feed_count = 0
            included_count = 0
            for item in root.findall("./channel/item"):
                title = html.unescape(item.findtext("title", default="").strip())
                if not title:
                    continue
                published_raw = item.findtext("pubDate", default="") or item.findtext("published", default="")
                published = _coerce_dt(published_raw)
                link = item.findtext("link", default="").strip()
                key = (title.lower(), link)
                if key in dedupe:
                    continue
                dedupe.add(key)
                preview = _item_preview(item)
                score, source_quality_score, matched_keywords, included, filter_reason = _score_item(
                    channel_title,
                    title,
                    published,
                    seen_at,
                )
                feed_count += 1
                if included:
                    included_count += 1
                items.append(
                    {
                        "published_at": (published or seen_at).isoformat(),
                        "first_seen_at": seen_at.isoformat(),
                        "backfilled_at": seen_at.isoformat() if data_mode == "backfilled" else None,
                        "is_backfilled": data_mode == "backfilled",
                        "source": channel_title,
                        "title": title,
                        "link": link,
                        "preview": preview,
                        "description": preview,
                        "relevance_reason": "Matched configured RSS provider and news relevance scoring.",
                        "impact_direction_on_gold": "unknown",
                        "data_mode": data_mode,
                        "included": included,
                        "filter_reason": filter_reason,
                        "source_quality_score": source_quality_score,
                        "score": score,
                        "matched_keywords": matched_keywords,
                        "categories": ["rss"] + ([] if included else ["filtered"]),
                    }
                )
            feed_statuses.append(
                {
                    "feed_url": feed_url,
                    "source": channel_title,
                    "status": "available" if feed_count else "empty",
                    "reason": "" if feed_count else "Feed returned no item headlines.",
                    "headline_count": feed_count,
                    "included_count": included_count,
                    "latency_ms": round((perf_counter() - feed_started_at) * 1000, 2),
                }
            )
        items.sort(key=lambda item: item["published_at"])
        included_items = [item for item in items if item.get("included")]
        health = ProviderHealth(
            source="RSS",
            source_type="rss_provider",
            fetched_at=seen_at.isoformat(),
            data_timestamp=included_items[-1]["published_at"] if included_items else seen_at.isoformat(),
            data_mode=data_mode if included_items else "unavailable",
            is_available=bool(included_items),
            is_stale=False,
            stale_reason="" if included_items else "Configured RSS feeds returned no usable headlines for Market Agent in this run.",
            raw_source_id="\n".join(successful_feeds or attempted_feeds),
            latency_ms=round((perf_counter() - started_at) * 1000, 2),
            current_value=float(len(included_items)),
            metadata={
                "feeds": feed_statuses,
                "attempted_feed_count": len(attempted_feeds),
                "successful_feed_count": len(successful_feeds),
                "headline_count": len(items),
                "included_count": len(included_items),
            },
        )
        return items, health

    def fetch_latest(self, anchor_time: datetime) -> tuple[list[dict[str, Any]], ProviderHealth]:
        return self._fetch(seen_at=anchor_time, data_mode="live_seen")

    def backfill(self, start: datetime, end: datetime) -> tuple[list[dict[str, Any]], ProviderHealth]:
        return self._fetch(seen_at=end, data_mode="backfilled")
