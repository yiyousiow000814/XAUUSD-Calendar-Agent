from __future__ import annotations

"""
Lightweight helper to speed up per-event research without templating.

This script intentionally does NOT write any event notes. It only:
- runs a DuckDuckGo HTML search via r.jina.ai
- fetches a few candidate pages via r.jina.ai
- extracts short, definition-like lines (evidence candidates)

Designed to reduce manual browsing time while keeping the repo policy:
each event needs its own supporting excerpt and its own final note.
"""

import argparse
import hashlib
import re
import sys
import textwrap
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path


JINA_PREFIX = "https://r.jina.ai/"
DDG_HTML = "http://duckduckgo.com/html/?q="


@dataclass(frozen=True)
class Candidate:
    source_url: str
    excerpt: str


def _http_get_text(url: str, timeout_s: int) -> str:
    req = urllib.request.Request(
        url,
        headers={
            # Keep it simple and consistent; DDG and some sites may block empty UA.
            "User-Agent": "Mozilla/5.0 (compatible; event-notes-research/1.0)",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:
        return resp.read().decode("utf-8", errors="replace")


def _slug(s: str) -> str:
    s = s.lower().strip()
    s = re.sub(r"[^a-z0-9]+", "_", s)
    return s.strip("_")[:80] or "page"


def _cache_path(cache_dir: Path, label: str, url: str, ext: str = "md") -> Path:
    h = hashlib.sha256(url.encode("utf-8")).hexdigest()[:12]
    return cache_dir / f"{_slug(label)}_{h}.{ext}"


def _event_query(event_id: str) -> str:
    # Example: USD::opec monthly report::none -> "USD opec monthly report definition"
    parts = event_id.split("::")
    currency = parts[0] if parts else event_id
    name = parts[1] if len(parts) > 1 else ""
    unit = parts[2] if len(parts) > 2 else ""
    bits = [currency, name, unit, "definition", "what is"]
    return " ".join(b for b in bits if b and b.lower() != "none")


def _extract_ddg_urls(ddg_text: str, max_results: int) -> list[str]:
    # DuckDuckGo HTML results (via r.jina.ai) include "uddg=<encoded_url>" in links.
    urls: list[str] = []
    for m in re.finditer(r"uddg=([^&]+)", ddg_text):
        url = urllib.parse.unquote(m.group(1))
        if not url.startswith("http"):
            continue
        if url not in urls:
            urls.append(url)
        if len(urls) >= max_results:
            break
    return urls


def _extract_evidence_lines(markdown: str, max_lines: int) -> list[str]:
    lines = []
    # Prefer lines that read like definitions.
    want = re.compile(
        r"\b("
        r"measures|reports|announces|sets|publishes|provides|consists of|is a|are a"
        r")\b",
        re.IGNORECASE,
    )
    for raw in markdown.splitlines():
        line = raw.strip()
        if not line or len(line) < 40:
            continue
        if len(line) > 260:
            continue
        if want.search(line):
            # Drop markdown link noise.
            line = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", line)
            lines.append(line)
        if len(lines) >= max_lines:
            break
    # De-dupe while preserving order.
    out: list[str] = []
    seen = set()
    for line in lines:
        key = re.sub(r"\s+", " ", line)
        if key in seen:
            continue
        seen.add(key)
        out.append(key)
    return out


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Fetch candidate sources + evidence lines for one event id."
    )
    parser.add_argument("--event-id", required=True, help='e.g. "USD::m2 money supply::m/m"')
    parser.add_argument("--query", help="override search query")
    parser.add_argument("--max-results", type=int, default=5)
    parser.add_argument("--max-lines", type=int, default=8)
    parser.add_argument("--timeout", type=int, default=30, help="HTTP timeout seconds")
    parser.add_argument("--cache-dir", default="tmp/sources", help="gitignored cache dir")
    args = parser.parse_args()

    cache_dir = Path(args.cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)

    query = args.query or _event_query(args.event_id)
    ddg_url = f"{JINA_PREFIX}{DDG_HTML}{urllib.parse.quote_plus(query)}"
    ddg_text = _http_get_text(ddg_url, timeout_s=args.timeout)
    ddg_cache = _cache_path(cache_dir, f"ddg_{args.event_id}", ddg_url, ext="md")
    ddg_cache.write_text(ddg_text, encoding="utf-8")

    urls = _extract_ddg_urls(ddg_text, max_results=args.max_results)
    if not urls:
        print("No results. Try a different --query.", file=sys.stderr)
        return 2

    candidates: list[Candidate] = []
    for url in urls:
        jina_url = f"{JINA_PREFIX}{url}"
        try:
            md = _http_get_text(jina_url, timeout_s=args.timeout)
        except Exception:
            continue
        page_cache = _cache_path(cache_dir, args.event_id, url, ext="md")
        page_cache.write_text(md, encoding="utf-8")
        for line in _extract_evidence_lines(md, max_lines=args.max_lines):
            candidates.append(Candidate(source_url=url, excerpt=line))

    # Print a compact, copy-paste friendly output.
    print(f"event_id: {args.event_id}")
    print(f"query: {query}")
    print(f"cached: {ddg_cache.as_posix()}")
    if not candidates:
        print("No evidence lines extracted. Open cached pages under tmp/sources/ and grep manually.")
        return 0

    print("candidates:")
    for c in candidates[:20]:
        wrapped = textwrap.fill(c.excerpt, width=100)
        print(f"- source: {c.source_url}")
        print(textwrap.indent(wrapped, prefix="  "))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

