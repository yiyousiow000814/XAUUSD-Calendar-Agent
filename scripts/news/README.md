[English](README.md) | [中文](README.zh-CN.md)

# News Collection & Analysis

This folder contains scripts for collecting and analyzing news that may influence `XAUUSD`.

## Quick Run
```bash
python scripts/news/news_fetcher.py
```

## Configuration
This repository does not ship with any default data sources.

- `user-data/NEWS_RSS_FEEDS.txt`: one RSS URL per line (a leading `- ` is allowed).
  - The current `XAUUSD Calendar Agent` app does not read this file.
  - This file is used by the news scripts in this folder.

Example:
```text
https://example.com/rss
- https://another.example.com/feed.xml
```

## Implemented Features
- Scheduled crawling of RSS feeds and selected news sites (for long-running operation).
- Filtering contradictory / unreliable items using the local `Jan-v1-4B` model.
- Basic sentiment scoring for downstream features.

## Roadmap
### Done
- Crawling: periodic collection from multiple sites and RSS feeds.
- Unreliable info filtering: local `Jan-v1-4B` checks for contradictions and filters suspicious items.
- Sentiment scoring: produces sentiment values for downstream features.

### In Progress (Full List)
- `Jan` model optimization: reduce local inference cost and refactor the loading pipeline.
- Keyword extraction and feature aggregation: produce daily/weekly summaries.
- Keyword frequency statistics: support later RAG retrieval.
- Sentiment ↔ price alignment: link sentiment to `XAUUSD` moves and track drivers.
- Prediction module: output up/flat/down probabilities with confidence intervals and key drivers.
- News organization: categorize news, generate topic summaries, and trigger WhatsApp/Email notifications.
- Persistence: write crawl results and indicators into a database for tracking.
- Visualization: chart price and sentiment trends.
- Logging and alerting: record runtime status and alert on failures.
- Automated news summaries: periodic summaries for specific topics.
- Timezone normalization and source de-duplication: store all timestamps in UTC+8 and remove duplicates.
- Topic and sentiment label taxonomy: multi-level tags with uncertainty signals.
- Compliance/copyright: store only embeddable or full-text RSS content and display an “information only” notice.
- Internationalization and accessibility: bilingual fields and accessible UI.

## Notes
- The repository does not include any RSS/news sources by default; provide your own legally accessible sources.
