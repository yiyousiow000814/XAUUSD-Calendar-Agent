from __future__ import annotations

from datetime import datetime, timedelta
from email.utils import parsedate_to_datetime
import html
from pathlib import Path
from typing import Any
from urllib.request import urlopen
from xml.etree import ElementTree as ET

from ..models import Headline


def _coerce_dt(raw: str) -> datetime | None:
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw)
    except ValueError:
        try:
            parsed = parsedate_to_datetime(raw)
            if parsed.tzinfo is None:
                return parsed.replace(tzinfo=datetime.fromisoformat("2026-01-01T00:00:00+08:00").tzinfo)
            return parsed
        except Exception:
            return None


def filter_news_in_window(
    headlines: list[dict[str, Any]],
    move_start: datetime,
    move_end: datetime,
    lookback_minutes: int,
    forward_minutes: int,
) -> list[Headline]:
    window_start = move_start - timedelta(minutes=lookback_minutes)
    window_end = move_end + timedelta(minutes=forward_minutes)
    items: list[Headline] = []
    for row in headlines:
        published = _coerce_dt(str(row.get("published_at", "")))
        if published is None or not (window_start <= published <= window_end):
            continue
        title = html.unescape(str(row.get("title", "")).strip())
        if not title:
            continue
        items.append(
            Headline(
                timestamp_myt=published.strftime("%d-%m-%Y %H:%M"),
                source=str(row.get("source", "Unknown")).strip() or "Unknown",
                title=title,
                relevance_reason=str(row.get("relevance_reason", "Headline falls inside monitored move window.")),
                impact_direction_on_gold=str(row.get("impact_direction_on_gold", "unknown")),
                tags=tuple(row.get("tags", [])),
            )
        )
    return items


def load_rss_headlines(rss_feeds: list[str]) -> list[dict[str, Any]]:
    headlines: list[dict[str, Any]] = []
    for feed_url in rss_feeds:
        try:
            if Path(feed_url).exists():
                xml_text = Path(feed_url).read_text(encoding="utf-8")
            else:
                with urlopen(feed_url, timeout=10) as response:
                    xml_text = response.read().decode("utf-8", errors="replace")
            root = ET.fromstring(xml_text)
        except Exception:
            continue
        channel_title = root.findtext("./channel/title", default=feed_url)
        for item in root.findall("./channel/item"):
            title = item.findtext("title", default="")
            published = item.findtext("pubDate", default="") or item.findtext("published", default="")
            headlines.append(
                {
                    "title": title,
                    "source": channel_title,
                    "published_at": published,
                    "relevance_reason": "RSS headline inside configured monitored window.",
                    "impact_direction_on_gold": "unknown",
                    "tags": [],
                }
            )
    return headlines
