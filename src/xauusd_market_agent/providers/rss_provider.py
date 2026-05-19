from __future__ import annotations

from datetime import datetime
from email.utils import parsedate_to_datetime
import html
from pathlib import Path
from typing import Any
from urllib.request import urlopen
from xml.etree import ElementTree as ET

from ..models import ProviderHealth


_SOURCE_SCORES = {
    "federal reserve": 1.0,
    "bls": 1.0,
    "bea": 0.95,
    "eia": 0.95,
    "reuters": 0.92,
    "bloomberg": 0.9,
    "cnbc": 0.78,
    "kitco": 0.72,
    "fxstreet": 0.7,
    "marketwatch": 0.66,
}

_EVENT_KEYWORDS = ("fed", "powell", "cpi", "ppi", "pce", "nfp", "yield", "dxy", "dollar", "gold", "xauusd", "opec", "oil", "war", "tariff")
_LOW_SIGNAL_KEYWORDS = ("opinion", "forecast", "analysis", "explainer", "preview")


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
        if Path(feed_url).exists():
            return Path(feed_url).read_text(encoding="utf-8")
        with urlopen(feed_url, timeout=15) as response:
            return response.read().decode("utf-8", errors="replace")
    except Exception:
        return None


def _score_item(source: str, title: str, has_timestamp: bool) -> tuple[float, list[str]]:
    lowered_source = source.lower()
    lowered_title = title.lower()
    matched = [word for word in _EVENT_KEYWORDS if word in lowered_title]
    source_score = max((score for key, score in _SOURCE_SCORES.items() if key in lowered_source), default=0.45)
    keyword_bonus = min(len(matched) * 0.05, 0.2)
    low_signal_penalty = 0.2 if any(word in lowered_title for word in _LOW_SIGNAL_KEYWORDS) else 0.0
    timestamp_penalty = 0.15 if not has_timestamp else 0.0
    score = max(0.0, min(1.0, source_score + keyword_bonus - low_signal_penalty - timestamp_penalty))
    return score, matched


class RSSNewsProvider:
    def __init__(self, feeds: list[str]) -> None:
        self.feeds = feeds

    def _fetch(self, *, seen_at: datetime, data_mode: str) -> tuple[list[dict[str, Any]], ProviderHealth]:
        items: list[dict[str, Any]] = []
        dedupe: set[tuple[str, str]] = set()
        for feed_url in self.feeds:
            xml_text = _read_feed(feed_url)
            if not xml_text:
                continue
            root = ET.fromstring(xml_text)
            channel_title = root.findtext("./channel/title", default=feed_url)
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
                score, matched_keywords = _score_item(channel_title, title, published is not None)
                items.append(
                    {
                        "published_at": (published or seen_at).isoformat(),
                        "first_seen_at": seen_at.isoformat(),
                        "backfilled_at": seen_at.isoformat() if data_mode == "backfilled" else None,
                        "is_backfilled": data_mode == "backfilled",
                        "source": channel_title,
                        "title": title,
                        "link": link,
                        "relevance_reason": "Matched configured RSS provider and news relevance scoring.",
                        "impact_direction_on_gold": "unknown",
                        "data_mode": data_mode,
                        "score": score,
                        "matched_keywords": matched_keywords,
                        "categories": ["rss"],
                    }
                )
        items.sort(key=lambda item: item["published_at"])
        health = ProviderHealth(
            source="RSS",
            source_type="rss_provider",
            fetched_at=seen_at.isoformat(),
            data_timestamp=items[-1]["published_at"] if items else seen_at.isoformat(),
            data_mode=data_mode if items else "unavailable",
            is_available=bool(items),
            is_stale=False,
            current_value=float(len(items)),
        )
        return items, health

    def fetch_latest(self, anchor_time: datetime) -> tuple[list[dict[str, Any]], ProviderHealth]:
        return self._fetch(seen_at=anchor_time, data_mode="live_seen")

    def backfill(self, start: datetime, end: datetime) -> tuple[list[dict[str, Any]], ProviderHealth]:
        return self._fetch(seen_at=end, data_mode="backfilled")
