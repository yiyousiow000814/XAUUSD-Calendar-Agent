import base64
import hashlib
import ipaddress
import logging
import os
import random
import re
import subprocess
import sys
import unicodedata
from pathlib import Path
from urllib.parse import parse_qs, unquote, urljoin, urlparse

import cloudscraper
import feedparser
import requests
from bs4 import BeautifulSoup
from newspaper import Article, Config

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/122.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}

# Rotate these headers when access is denied
UA_POOL = [
    HEADERS["User-Agent"],
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0",
]

REPO_ROOT = Path(__file__).resolve().parents[2]


def _configure_output_encoding() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8", errors="replace")
            except Exception:
                pass


_configure_output_encoding()


_URL_TOKEN_RE = re.compile(r"(?:https?://|www\\.)\\S+", re.IGNORECASE)
_DOMAIN_TOKEN_RE = re.compile(
    r"\\b(?:[A-Za-z0-9-]{2,63}\\.)+[A-Za-z]{2,24}\\b", re.IGNORECASE
)


def _strip_web_tokens(text: str) -> str:
    cleaned = _URL_TOKEN_RE.sub("", text)
    cleaned = _DOMAIN_TOKEN_RE.sub("", cleaned)
    cleaned = re.sub(r"\\s{2,}", " ", cleaned).strip()
    return cleaned


def _stable_id(value: str, short: bool = True) -> str:
    digest = hashlib.sha256(value.encode("utf-8")).hexdigest()
    return digest[:12] if short else digest


def _load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if (value.startswith('"') and value.endswith('"')) or (
            value.startswith("'") and value.endswith("'")
        ):
            value = value[1:-1]
        if not key:
            continue
        if os.environ.get(key, "").strip():
            continue
        os.environ[key] = value


def _load_local_env() -> None:
    _load_dotenv(REPO_ROOT / ".env")
    _load_dotenv(REPO_ROOT / "user-data" / ".env")


def _parse_env_list(name: str) -> list[str]:
    raw = os.getenv(name, "")
    if not raw.strip():
        return []
    items: list[str] = []
    for token in re.split(r"[\r\n,]+", raw):
        value = token.strip()
        if value.startswith("-"):
            value = value[1:].strip()
        if value:
            items.append(value)
    return items


def _load_feed_list_from_file(path: Path) -> list[str]:
    if not path.exists():
        return []
    items: list[str] = []
    for raw_line in path.read_text(encoding="utf-8-sig").splitlines():
        value = raw_line.lstrip("\ufeff").strip()
        if not value or value.startswith("#"):
            continue
        if value.startswith("-"):
            value = value[1:].strip()
        if value:
            items.append(value)
    return items


_load_local_env()
RSS_FEEDS = _parse_env_list("NEWS_RSS_FEEDS")
if not RSS_FEEDS:
    feed_file = os.getenv("NEWS_RSS_FEEDS_FILE")
    feed_path = (
        Path(feed_file).expanduser()
        if feed_file
        else (REPO_ROOT / "user-data" / "NEWS_RSS_FEEDS.txt")
    )
    RSS_FEEDS = _load_feed_list_from_file(feed_path)
    if RSS_FEEDS:
        os.environ["NEWS_RSS_FEEDS"] = "\n".join(RSS_FEEDS)
if not RSS_FEEDS:
    print(
        "[ERROR] No RSS feeds configured. Set NEWS_RSS_FEEDS (comma/newline separated) "
        "or provide user-data/NEWS_RSS_FEEDS.txt."
    )
    raise SystemExit(2)


# Domain whitelist for redirect targets (derived from RSS feed hosts + optional overrides).
ALLOWED_DOMAINS: set[str] = set()

for rss_url in RSS_FEEDS:
    try:
        host = urlparse(rss_url).netloc.lower()
    except Exception:
        continue
    if host.startswith("www."):
        host = host[4:]
    if host:
        ALLOWED_DOMAINS.add(host)
        if host.startswith("feeds."):
            ALLOWED_DOMAINS.add(host[len("feeds.") :])

for domain in _parse_env_list("NEWS_ALLOWED_DOMAINS"):
    ALLOWED_DOMAINS.add(domain.lower().removeprefix("www."))

MAX_ARTICLES_PER_FEED = int(os.environ.get("MAX_ARTICLES_PER_FEED", "3") or 3)

# Safety and redirect handling constants
ALLOWED_SCHEMES = {"http", "https"}
MAX_REDIRECTS = 5
MAX_SEGMENT_LENGTH = 200  # avoid excessive base64 decoding
HTTP_REDIRECT_STATUS = {301, 302, 303, 307, 308}

try:
    import lxml  # noqa: F401

    BS_PARSER = "lxml"
except Exception:
    BS_PARSER = "html.parser"
    logging.warning("lxml not available, falling back to html.parser")


def _normalize_host(host: str) -> str:
    host = (host or "").strip().lower()
    prefixes = ("www.", "amp.", "m.", "mobile.")
    while True:
        matched = False
        for prefix in prefixes:
            if host.startswith(prefix):
                host = host[len(prefix) :]
                matched = True
                break
        if not matched:
            break
    return host


def _host_from_url(url: str) -> str:
    return _normalize_host(urlparse(url).hostname or "")


def _domain_ok(url: str, allowed_hosts: set[str] | None = None) -> bool:
    """Return True if the redirect target host is safe enough to follow."""
    host = _host_from_url(url)
    if not host:
        return False
    if host in {"localhost"} or host.endswith(".local"):
        return False
    host_value = host[1:-1] if host.startswith("[") and host.endswith("]") else host
    try:
        ip = ipaddress.ip_address(host_value)
    except ValueError:
        ip = None
    if ip is not None and (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    ):
        return False
    allow_any_public = os.environ.get("NEWS_LOOSE_REDIRECTS", "").strip() == "1"
    if allow_any_public:
        return True

    effective_allowed = set(ALLOWED_DOMAINS)
    if allowed_hosts:
        effective_allowed |= {h for h in allowed_hosts if h}

    if host in effective_allowed:
        return True

    # Allow redirects within the same allowed host tree (parent/subdomain).
    # Example: allow `news.example.com` when `example.com` is allowed.
    for allowed in effective_allowed:
        if not allowed or allowed == host:
            continue
        if host.endswith("." + allowed) or allowed.endswith("." + host):
            return True

    return False


logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")

# ANSI color sequences and detection
COLORS = {
    "RESET": "\033[0m",
    "RED": "\033[31m",
    "GREEN": "\033[38;5;34m",
    "YELLOW": "\033[38;5;178m",
}


def _supports_color() -> bool:
    """Return True if the running environment supports ANSI colors."""
    if any(mod in sys.modules for mod in ("jupyter", "IPython")):
        return True
    if os.environ.get("FORCE_COLOR") or os.environ.get("COLORTERM"):
        return True
    return (
        hasattr(sys.stderr, "isatty")
        and sys.stderr.isatty()
        and os.environ.get("TERM") != "dumb"
    )


USE_COLOR = _supports_color()


def _display_width(text: str) -> int:
    """Return the printable width of a string accounting for wide characters."""
    width = 0
    for ch in text:
        if unicodedata.east_asian_width(ch) in ("F", "W"):
            width += 2
        else:
            width += 1
    return width


def _center_in_box(text: str, width: int) -> str:
    """Center text in a fixed width box accounting for wide characters."""
    inner_width = _display_width(text)
    padding = max(width - inner_width, 0)
    left = padding // 2
    right = padding - left
    return "│" + " " * left + text + " " * right + "│"


def print_section(title: str, items: list, color_key: str) -> None:
    width = 41
    prefix = COLORS[color_key] if USE_COLOR else ""
    reset = COLORS["RESET"] if USE_COLOR else ""
    print(prefix + "┌" + "─" * width + "┐" + reset)
    print(prefix + _center_in_box(title, width) + reset)
    print(prefix + "└" + "─" * width + "┘" + reset)
    for item in items:
        link = None
        if len(item) == 7:
            t, article_id, published, text, sent, gscore, link = item
        elif len(item) == 6:
            t, article_id, published, text, sent, gscore = item
        elif len(item) == 5:
            t, article_id, published, text, sent = item
            gscore = None
        else:
            t, article_id, published, text = item
            sent = None
            gscore = None
        print(prefix + f"📌 {t}" + reset)
        print(prefix + f"🆔 {article_id}" + reset)
        print(prefix + f"📅 {published}" + reset)
        if link:
            print(prefix + f"🔗 {link}" + reset)
        if sent is not None:
            print(prefix + f"📈 Sentiment: {sent:+.2f}" + reset)
        if gscore is not None:
            print(prefix + f"🥇 Gold Score: {gscore:.2f}" + reset)
        print(prefix + f"📄 {text[:150]}..." + reset)
        print(prefix + "─" * 50 + reset)


PAYWALL_KEYWORDS = ["subscription", "trial", "cancel anytime"]
# Use official Gemini model IDs. Environment variables can override these.
GEMINI_FACT_MODEL = os.environ.get("GEMINI_FACT_MODEL", "gemini-2.5-pro")
GEMINI_SENTIMENT_MODEL = os.environ.get("GEMINI_SENT_MODEL", "gemini-2.5-pro")

GOLD_MODEL = os.environ.get("GOLD_MODEL", "facebook/bart-large-mnli")
_gold_classifier = None
GOLD_THRESHOLD = 0.6


def _get_gold_classifier():
    global _gold_classifier
    if os.environ.get("DISABLE_GOLD_MODEL", "").strip() == "1":
        return None
    if _gold_classifier is not None:
        return _gold_classifier
    try:
        from transformers import pipeline  # type: ignore
    except Exception as exc:
        logging.warning("Gold classifier disabled (transformers unavailable): %s", exc)
        return None
    try:
        _gold_classifier = pipeline("zero-shot-classification", model=GOLD_MODEL)
    except Exception as exc:
        logging.warning("Gold classifier disabled (init failed): %s", exc)
        _gold_classifier = None
    return _gold_classifier


def is_fake_news(title: str, body: str) -> bool:
    """Return True if Gemini CLI deems the article inconsistent."""
    if not body:
        return False
    if os.environ.get("DISABLE_GEMINI", "").strip() == "1":
        return False

    prompt = (
        "你是事实核查助手。回答 true 表示新闻不可信，false 表示可信。\n"
        f"标题: {title}\n内容: {body}"
    )
    try:
        result = subprocess.run(
            ["gemini", "--model", GEMINI_FACT_MODEL],
            input=prompt,
            text=True,
            capture_output=True,
            check=True,
        )
        return result.stdout.strip().lower().startswith("true")
    except Exception as exc:
        logging.error("Gemini fact check error: %s", exc)
        return False


def gemini_sentiment(text: str) -> float:
    """Return sentiment score using Gemini CLI (-1 to 1)."""
    if os.environ.get("DISABLE_GEMINI", "").strip() == "1":
        return 0.0
    prompt = "请给出以下文本的情绪分值，范围 -1 到 1，仅返回数值。\n" + text
    try:
        result = subprocess.run(
            ["gemini", "--model", GEMINI_SENTIMENT_MODEL],
            input=prompt,
            text=True,
            capture_output=True,
            check=True,
        )
        return float(result.stdout.strip())
    except Exception as exc:
        logging.error("Gemini sentiment error: %s", exc)
        return 0.0


def gold_relevance(text: str) -> float:
    """Return probability that the text is gold-related."""
    classifier = _get_gold_classifier()
    if classifier is None:
        return 1.0
    try:
        result = classifier(text, candidate_labels=["gold", "non-gold"])
        labels = result.get("labels", [])
        scores = result.get("scores", [])
        if labels and scores:
            for label, score in zip(labels, scores):
                if label == "gold":
                    return float(score)
        return 0.0
    except Exception as exc:
        logging.error("Gold classifier error: %s", exc)
        return 0.0


def create_session() -> requests.Session:
    """Return a CloudScraper session with browser-like headers."""
    ua = random.choice(UA_POOL)
    session = cloudscraper.create_scraper(browser={"User-Agent": ua})
    session.headers.update(
        {"User-Agent": ua, "Accept-Language": HEADERS["Accept-Language"]}
    )
    return session


def _extract_meta_refresh(html: str) -> str | None:
    """Return redirect URL from a meta refresh tag if present."""
    soup = BeautifulSoup(html, BS_PARSER)
    meta = soup.find(
        "meta", attrs={"http-equiv": lambda v: v and v.lower() == "refresh"}
    )
    if meta:
        content = meta.get("content", "")
        match = re.search(r"url\s*=\s*['\"]?\s*([^'\"\s>]+)", content, re.I)
        if match:
            return unquote(match.group(1).strip())
    return None


def _extract_js_redirect(html: str) -> str | None:
    """Return redirect URL from JavaScript location redirects."""
    match = re.search(
        r"(?:window\.)?location(?:\.href|\.replace|\.assign)?\s*=\s*['\"]([^'\"]+)['\"]",
        html,
        re.I,
    )
    if not match:
        match = re.search(
            r"setTimeout\([^)]*location\.(?:href|replace)\s*=\s*['\"]([^'\"]+)['\"]",
            html,
            re.I,
        )
    if match:
        return unquote(match.group(1))
    return None


def _extract_canonical(html: str) -> str | None:
    """Return canonical or og:url if present."""
    soup = BeautifulSoup(html, BS_PARSER)
    link = soup.find("link", rel=lambda v: v and v.lower() == "canonical")
    if link and link.get("href"):
        return link["href"]
    meta = soup.find("meta", attrs={"property": "og:url"})
    if meta and meta.get("content"):
        return meta["content"]
    return None


def _extract_url_from_path(path: str) -> str | None:
    """Return URL encoded in a path segment if present."""
    match = re.search(r"https?%3A%2F%2F[^&]+", path, re.I)
    if match:
        return unquote(match.group(0))
    match = re.search(r"https?://[^?]+", path)
    if match:
        return match.group(0)
    for seg in path.split("/"):
        seg = seg.strip()
        if not seg or len(seg) > MAX_SEGMENT_LENGTH:
            continue
        try:
            padded = seg + "=" * (-len(seg) % 4)
            decoded = base64.urlsafe_b64decode(padded).decode()
            if decoded.startswith("http"):
                return decoded
        except Exception:
            continue
    return None


def _extract_candidate_urls_from_url(link: str) -> list[str]:
    parsed = urlparse(link)
    qs = parse_qs(parsed.query)
    candidates: list[str] = []
    for values in qs.values():
        for val in values:
            candidate = unquote(val)
            if candidate.startswith("http"):
                candidates.append(candidate)
            if len(candidate) <= MAX_SEGMENT_LENGTH:
                try:
                    padded = candidate + "=" * (-len(candidate) % 4)
                    decoded = base64.urlsafe_b64decode(padded).decode()
                    if decoded.startswith("http"):
                        candidates.append(decoded)
                except Exception:
                    pass
    path_url = _extract_url_from_path(parsed.path)
    if path_url:
        candidates.append(path_url)
    return candidates


def _allowed_hosts_for_entry(feed_url: str, entry_link: str) -> set[str]:
    hosts = {_host_from_url(feed_url), _host_from_url(entry_link)}
    for candidate in _extract_candidate_urls_from_url(entry_link):
        hosts.add(_host_from_url(candidate))
    return {h for h in hosts if h}


def resolve_redirect(
    link: str, html: str, allowed_hosts: set[str] | None = None
) -> str:
    """Return the final article URL following common redirect patterns."""
    parsed = urlparse(link)
    qs = parse_qs(parsed.query)
    for key in ("url", "u"):
        if key in qs:
            candidate = unquote(qs[key][0])
            if urlparse(candidate).scheme in ALLOWED_SCHEMES and _domain_ok(
                candidate, allowed_hosts
            ):
                return candidate

    for values in qs.values():
        for val in values:
            candidate = unquote(val)
            if (
                candidate.startswith("http")
                and urlparse(candidate).scheme in ALLOWED_SCHEMES
                and _domain_ok(candidate, allowed_hosts)
            ):
                return candidate
            if len(candidate) <= MAX_SEGMENT_LENGTH:
                try:
                    padded = candidate + "=" * (-len(candidate) % 4)
                    decoded = base64.urlsafe_b64decode(padded).decode()
                    if (
                        decoded.startswith("http")
                        and urlparse(decoded).scheme in ALLOWED_SCHEMES
                        and _domain_ok(decoded, allowed_hosts)
                    ):
                        return decoded
                except Exception:
                    pass

    path_url = _extract_url_from_path(parsed.path)
    if path_url:
        if urlparse(path_url).scheme in ALLOWED_SCHEMES and _domain_ok(
            path_url, allowed_hosts
        ):
            return path_url

    meta_url = _extract_meta_refresh(html)
    if meta_url:
        if urlparse(meta_url).scheme in ALLOWED_SCHEMES and _domain_ok(
            meta_url, allowed_hosts
        ):
            return meta_url

    js_url = _extract_js_redirect(html)
    if (
        js_url
        and urlparse(js_url).scheme in ALLOWED_SCHEMES
        and _domain_ok(js_url, allowed_hosts)
    ):
        return js_url

    canonical = _extract_canonical(html)
    if (
        canonical
        and urlparse(canonical).scheme in ALLOWED_SCHEMES
        and _domain_ok(canonical, allowed_hosts)
    ):
        return canonical

    return link


def download_article(
    link: str,
    session: requests.Session,
    allowed_hosts: set[str] | None = None,
    depth: int = 0,
    visited: set | None = None,
) -> tuple[str, Article]:
    """Download article and follow redirects if content is empty."""
    if visited is None:
        visited = set()
    base = urlparse(link)._replace(query="", fragment="").geturl()
    if base in visited or depth >= MAX_REDIRECTS:
        return link, Article(link)
    visited.add(base)
    config = Config()
    ua = session.headers.get("User-Agent", HEADERS["User-Agent"])
    config.browser_user_agent = ua
    config.headers = {"User-Agent": ua, "Accept-Language": HEADERS["Accept-Language"]}

    response = fetch_with_fallback(link, session)
    if response.status_code in HTTP_REDIRECT_STATUS:
        location = response.headers.get("Location", "").strip()
        if location:
            target = urljoin(link, location)
            if urlparse(target).scheme in ALLOWED_SCHEMES and _domain_ok(
                target, allowed_hosts
            ):
                return download_article(
                    target,
                    session,
                    allowed_hosts=allowed_hosts,
                    depth=depth + 1,
                    visited=visited,
                )
        return link, Article(link)
    response.raise_for_status()
    html = response.text
    article = Article(link, config=config)
    try:
        article.download(input_html=html)
        article.parse()
    except Exception:
        article.set_html(html)
        try:
            article.parse()
        except Exception:
            pass

    if article.text:
        return link, article

    resolved = resolve_redirect(link, html, allowed_hosts=allowed_hosts)
    if resolved != link:
        return download_article(
            resolved,
            session,
            allowed_hosts=allowed_hosts,
            depth=depth + 1,
            visited=visited,
        )

    return link, article


def fetch_with_fallback(url: str, session: requests.Session) -> requests.Response:
    """Fetch URL using the provided session."""
    response = session.get(url, allow_redirects=False)
    if response.status_code in {403, 503}:
        logging.warning(
            "Access denied (id=%s): %s", _stable_id(url), response.status_code
        )
        new_ua = random.choice(UA_POOL)
        session.headers["User-Agent"] = new_ua
        response = session.get(url, allow_redirects=False)
    return response


def fetch_rss(url: str, session: requests.Session):
    """拉取并解析 RSS，返回解析结果"""
    logging.info("Parsing RSS feed (id=%s)", _stable_id(url))
    allowed_hosts = {_host_from_url(url)}
    response = fetch_with_fallback(url, session)
    redirects = 0
    while response.status_code in HTTP_REDIRECT_STATUS and redirects < MAX_REDIRECTS:
        location = response.headers.get("Location", "").strip()
        if not location:
            break
        target = urljoin(url, location)
        if urlparse(target).scheme not in ALLOWED_SCHEMES or not _domain_ok(
            target, allowed_hosts
        ):
            break
        url = target
        response = fetch_with_fallback(url, session)
        redirects += 1
    response.raise_for_status()
    return feedparser.parse(response.content)


def _append_link_map_row(
    article_id: str, canonical_link: str, *, output_path: Path
) -> None:
    try:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        if not output_path.exists():
            output_path.write_text("article_id,canonical_link\n", encoding="utf-8")
        with output_path.open("a", encoding="utf-8") as f:
            safe_id = article_id.replace('"', '""')
            safe_link = canonical_link.replace('"', '""')
            f.write(f'"{safe_id}","{safe_link}"\n')
    except Exception as exc:
        logging.warning(
            "Failed to write local link map: %s", _strip_web_tokens(str(exc))
        )


def main():
    session = create_session()
    seen_article_ids = set()
    seen_hashes = set()
    real_news = []
    fake_news = []
    paywall_news = []
    non_gold_news = []
    failed_news = []

    max_feeds = int(os.environ.get("NEWS_MAX_FEEDS", "0") or 0)
    feeds = RSS_FEEDS[:max_feeds] if max_feeds > 0 else RSS_FEEDS
    print_links = os.environ.get("NEWS_PRINT_LINKS", "").strip() == "1"
    write_link_map = os.environ.get("NEWS_WRITE_LINK_MAP", "").strip() == "1"
    link_map_path = (
        Path(os.environ.get("NEWS_LINK_MAP_PATH", "")) if write_link_map else None
    )
    if write_link_map and not os.environ.get("NEWS_LINK_MAP_PATH", "").strip():
        link_map_path = REPO_ROOT / "user-data" / "news_link_map.csv"

    for rss_url in feeds:
        feed_id = _stable_id(rss_url)
        feed = fetch_rss(rss_url, session)
        if not feed.entries:
            logging.warning("No entries found in RSS feed (id=%s)", feed_id)
            continue

        for entry in feed.entries[:MAX_ARTICLES_PER_FEED]:
            title = getattr(entry, "title", "N/A") or "N/A"
            link = getattr(entry, "link", "")
            published = getattr(entry, "published", "N/A")

            if not link:
                logging.info("Skipping entry with empty URL")
                continue

            try:
                allowed_hosts = _allowed_hosts_for_entry(rss_url, link)
                link, article = download_article(
                    link, session, allowed_hosts=allowed_hosts
                )
                canonical_url = article.canonical_link or article.url or link
                article_id = _stable_id(canonical_url)
                if article_id in seen_article_ids:
                    logging.info("Skipping duplicate article (id=%s)", article_id)
                    continue
                seen_article_ids.add(article_id)
                if write_link_map and link_map_path is not None:
                    _append_link_map_row(
                        article_id, canonical_url, output_path=link_map_path
                    )

                summary = getattr(entry, "summary", "")
                if summary:
                    summary = BeautifulSoup(summary, BS_PARSER).get_text()
                text = article.text or summary
                gold_score = gold_relevance(summary or title)
                sentiment = gemini_sentiment(summary or text)
                if len(text) >= 200:
                    content_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
                    if content_hash in seen_hashes:
                        logging.info(
                            "Skipping duplicate content for article (id=%s)", article_id
                        )
                        continue
                    seen_hashes.add(content_hash)
                parse_failed = len(text.strip()) < 50

                safe_title = _strip_web_tokens(title) or "N/A"
                safe_content = _strip_web_tokens(text)[:200]

                skip_check = False
                if any(k in text.lower() for k in PAYWALL_KEYWORDS):
                    logging.info(
                        "Skip fact check: possible paywall (id=%s)", article_id
                    )
                    skip_check = True
                if parse_failed:
                    logging.info(
                        "Parse failed or very short content (id=%s)", article_id
                    )
                    failed_news.append(
                        (
                            safe_title,
                            article_id,
                            published,
                            safe_content,
                            sentiment,
                            gold_score,
                            canonical_url if print_links else None,
                        )
                    )
                    continue

                if skip_check:
                    paywall_news.append(
                        (
                            safe_title,
                            article_id,
                            published,
                            safe_content,
                            sentiment,
                            gold_score,
                            canonical_url if print_links else None,
                        )
                    )
                elif is_fake_news(title, text):
                    logging.info("Fact check failed (id=%s)", article_id)
                    fake_news.append(
                        (
                            safe_title,
                            article_id,
                            published,
                            safe_content,
                            sentiment,
                            gold_score,
                            canonical_url if print_links else None,
                        )
                    )
                elif gold_score < GOLD_THRESHOLD:
                    non_gold_news.append(
                        (
                            safe_title,
                            article_id,
                            published,
                            safe_content,
                            sentiment,
                            gold_score,
                            canonical_url if print_links else None,
                        )
                    )
                else:
                    real_news.append(
                        (
                            safe_title,
                            article_id,
                            published,
                            safe_content,
                            sentiment,
                            gold_score,
                            canonical_url if print_links else None,
                        )
                    )
            except Exception as exc:
                logging.error(
                    "Failed to parse article (feed_id=%s, error=%s)",
                    feed_id,
                    _strip_web_tokens(str(exc)) or type(exc).__name__,
                )
                continue

    # Nicely formatted output for real, fake, and paywall news
    print_section(f"📰 REAL NEWS ({len(real_news)})", real_news, "GREEN")
    print_section(
        f"📂 NON-GOLD ARTICLES ({len(non_gold_news)})", non_gold_news, "YELLOW"
    )
    print_section(f"❌ POTENTIAL FAKE NEWS ({len(fake_news)})", fake_news, "RED")
    print_section(
        f"💰 PAYWALLED ARTICLES ({len(paywall_news)})", paywall_news, "YELLOW"
    )
    if failed_news:
        print_section(f"⚠️ PARSE FAILED ({len(failed_news)})", failed_news, "RED")


if __name__ == "__main__":
    main()
