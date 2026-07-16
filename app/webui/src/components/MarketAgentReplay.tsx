import type { MarketAgentEvidenceForRunResponse, MarketAgentReplayResponse } from "../types";
import { type CSSProperties, useDeferredValue, useEffect, useMemo, useState } from "react";
import { MarketAgentStatusBadge } from "./MarketAgentStatusBadge";
import {
  bestMarketNewsTitle,
  formatDriverLabel,
  parseMarketAgentTimestampMs,
  formatShortTime
} from "../utils/marketAgentUi";
import { normalizeMarketAgentReplayPayload } from "../utils/marketAgentReplay";
import { backend } from "../api";
import "./MarketAgentReplay.css";

type MarketAgentReplayProps = {
  replay: MarketAgentReplayResponse | null;
  selectedEvidence: MarketAgentEvidenceForRunResponse | null;
  selectedMonitorRunId: number | null;
  rangePreset: string;
  rangeStartInput: string;
  rangeEndInput: string;
  onPresetChange: (preset: string) => void;
  onRangeStartChange: (value: string) => void;
  onRangeEndChange: (value: string) => void;
  onApplyRange: () => void;
  onSelectRun: (monitorRunId: number) => void;
};

type TimelineRow = {
  key: string;
  time: string;
  type: string;
  title: string;
  meta: string;
  status: string;
  source: "event" | "news" | "calendar" | "alert" | "suppressed";
  payload?: Record<string, unknown>;
  monitorRunId?: number;
};

type ReplayDetailItem = {
  title: string;
  detail: string;
  source: string;
  time: string;
  tag: string;
  url?: string;
  monitorRunId?: number;
};

type TimelineKind = "breakout" | "news" | "reversal" | "range" | "session" | "recovery" | "suppressed" | "alert" | "calendar" | "evidence";

const REPLAY_NEWS_MARKER_LIMIT = 14;
const REPLAY_CALENDAR_MARKER_LIMIT = 12;
const DEFER_REPLAY_ROWS = import.meta.env.MODE !== "test";

const timelineKindMeta: Record<TimelineKind, { tag: string; tone: string }> = {
  breakout: { tag: "BREAKOUT", tone: "red" },
  news: { tag: "NEWS", tone: "blue" },
  reversal: { tag: "REVERSAL", tone: "purple" },
  range: { tag: "RANGE", tone: "green" },
  session: { tag: "SESSION", tone: "amber" },
  recovery: { tag: "RECOVERY", tone: "green" },
  suppressed: { tag: "SUPPRESSED", tone: "muted" },
  alert: { tag: "ALERT", tone: "red" },
  calendar: { tag: "CALENDAR", tone: "amber" },
  evidence: { tag: "EVIDENCE", tone: "blue" }
};

const normalizeValue = (value: unknown) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

const numberValue = (value: unknown) => {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
};

const formatSignedValue = (value: number, suffix = "") => `${value > 0 ? "+" : ""}${value.toFixed(2)}${suffix}`;

const rawText = (value: unknown) => String(value ?? "").trim();

const firstUrlValue = (item: Record<string, unknown> | undefined) => {
  for (const value of [item?.url, item?.link, item?.source_url, item?.article_url, item?.canonical_url]) {
    const text = rawText(value);
    if (/^https?:\/\//i.test(text)) return text;
  }
  return undefined;
};

const openOriginalUrl = async (url: string) => {
  try {
    const result = await backend.openUrl(url);
    if (result?.ok) return;
  } catch {
    // Fall through to browser fallback.
  }
  window.open(url, "_blank", "noreferrer");
};

const itemSourceLabel = (item: Record<string, unknown> | undefined, fallback: string) =>
  rawText(item?.source ?? item?.provider ?? item?.feed_name ?? item?.calendar ?? item?.currency) || fallback;

const timestampValue = (item: Record<string, unknown>) =>
  item.published_at ??
  item.first_seen_at ??
  item.last_seen_at ??
  item.scheduled_at ??
  item.timestamp_myt ??
  item.event_time ??
  item.timestamp ??
  "";

const timestampMs = (value: unknown) => {
  return parseMarketAgentTimestampMs(value) ?? 0;
};

const compareTimelineTimeAsc = (left: unknown, right: unknown) => {
  const leftMs = parseMarketAgentTimestampMs(left);
  const rightMs = parseMarketAgentTimestampMs(right);
  if (leftMs !== null && rightMs !== null) return leftMs - rightMs;
  if (leftMs !== null) return -1;
  if (rightMs !== null) return 1;
  return String(left ?? "").localeCompare(String(right ?? ""));
};

const compareTimelineTimeDesc = (left: unknown, right: unknown) =>
  compareTimelineTimeAsc(right, left);

const summaryText = (item: Record<string, unknown> | undefined, fallback = "") => {
  for (const value of [
    item?.summary,
    item?.short_summary,
    item?.ai_summary,
    item?.display_summary,
    item?.description,
    fallback
  ]) {
    const text = rawText(value);
    if (text) return text;
  }
  return fallback;
};

const summaryTitle = (item: Record<string, unknown> | undefined, fallback: string) => {
  return bestMarketNewsTitle(
    [
      item?.display_title,
      item?.ai_title,
      item?.short_title,
      item?.summary_title,
      item?.title,
      fallback,
      item?.summary,
      item?.description
    ],
    fallback
  );
};

const driverValue = (row: TimelineRow) => normalizeValue(row.payload?.main_driver ?? row.payload?.driver ?? row.meta);

const inferTimelineKind = (row: TimelineRow): TimelineKind => {
  const semanticType = normalizeValue(row.payload?.semantic_type);
  if (semanticType in timelineKindMeta) return semanticType as TimelineKind;
  const status = normalizeValue(row.status);
  const title = normalizeValue(row.title);
  if (row.source === "news" || title.includes("headline")) return "news";
  if (row.source === "calendar") return "calendar";
  if (row.source === "suppressed" || status.includes("suppressed")) return "suppressed";
  if (status.includes("recovery") || status.includes("backfilled")) return "recovery";
  if (title.includes("rebound") || title.includes("reverse") || title.includes("invalidated")) return "reversal";
  if (title.includes("session")) return "session";
  if (title.includes("range") || title.includes("quiet")) return "range";
  if (status.includes("level") || row.source === "alert") return "alert";
  if (title.includes("breakout") || title.includes("selloff") || title.includes("pressure") || title.includes("drop")) return "breakout";
  return "evidence";
};

const compactTimelineTitle = (row: TimelineRow) => {
  const impact = numberValue(row.payload?.impact_percent);
  const title = normalizeValue(row.title);
  const driver = driverValue(row);
  const titleIsRawDriver = Boolean(driver && title && (title === driver || driver.endsWith(`_${title}`)));
  if (impact !== null && (row.source === "alert" || titleIsRawDriver)) {
    const action = impact < 0 ? "XAUUSD drop" : impact > 0 ? "XAUUSD spike" : "XAUUSD flat";
    return `${action} ${formatSignedValue(impact, "%")}`;
  }
  return row.title;
};

const compactTimelineDetail = (row: TimelineRow) => summaryText(row.payload, replayMetaText(row));

const replayRowDetail = (row: TimelineRow): ReplayDetailItem => {
  const kind = inferTimelineKind(row);
  return {
    title: compactTimelineTitle(row),
    detail: compactTimelineDetail(row),
    source: itemSourceLabel(row.payload, row.meta || sourceLabel(row)),
    time: row.time,
    tag: timelineKindMeta[kind].tag,
    url: firstUrlValue(row.payload),
    monitorRunId: row.monitorRunId
  };
};

const formatTimelineImpact = (row: TimelineRow) => {
  if (row.source === "calendar") {
    const impact = String(row.payload?.impact ?? "").toLowerCase();
    const contextType = String(row.payload?.context_type ?? "");
    if (impact === "holiday" || contextType === "liquidity_context") return "Liquidity context";
    return "Calendar context";
  }
  const payloadImpact = numberValue(row.payload?.impact_percent);
  const segment = row.payload?.segment as Record<string, unknown> | undefined;
  const segmentImpact = numberValue(segment?.move_percent);
  const impact = payloadImpact ?? segmentImpact;
  if (impact === null) return "Context only";
  return `Impact: ${formatSignedValue(impact, "%")}`;
};

const timelineImpactValue = (row: TimelineRow) => {
  const payloadImpact = numberValue(row.payload?.impact_percent);
  const segment = row.payload?.segment as Record<string, unknown> | undefined;
  const segmentImpact = numberValue(segment?.move_percent);
  return payloadImpact ?? segmentImpact;
};

const observedPriceMoveRow = (payload: MarketAgentReplayResponse["replay"]): TimelineRow | null => {
  const rows = payload.price_series ?? [];
  if (rows.length < 2) return null;
  const sorted = [...rows].sort((left, right) =>
    compareTimelineTimeAsc(left.data_timestamp ?? left.timestamp ?? "", right.data_timestamp ?? right.timestamp ?? "")
  );
  const latest = sorted[sorted.length - 1];
  const previous = sorted[sorted.length - 2];
  const latestPrice = numberValue(latest.close_price ?? latest.close ?? latest.mid);
  const previousPrice = numberValue(previous.close_price ?? previous.close ?? previous.mid);
  if (latestPrice === null || previousPrice === null || previousPrice === 0) return null;
  const movePercent =
    numberValue(latest.move_percent ?? latest.change_pct ?? latest.change_15m_pct) ??
    ((latestPrice - previousPrice) / previousPrice) * 100;
  if (!Number.isFinite(movePercent) || Math.abs(movePercent) < 0.01) return null;
  const direction = movePercent < 0 ? "down" : "up";
  return {
    key: `price-${String(latest.data_timestamp ?? latest.timestamp ?? "")}`,
    time: String(latest.data_timestamp ?? latest.timestamp ?? ""),
    type: "Price",
    title: `Observed XAUUSD ${direction === "down" ? "drop" : "rise"} ${formatSignedValue(movePercent, "%")}`,
    meta: "Price action",
    status: "observed",
    source: "event",
    payload: {
      semantic_type: Math.abs(movePercent) >= 0.18 ? "breakout" : "range",
      impact_percent: movePercent,
      direction,
      main_driver: "price_action",
      summary: `XAUUSD moved ${formatSignedValue(movePercent, "%")} between the latest stored price bars.`
    }
  };
};

const replayMode = (rangePreset: string): "day" | "month" =>
  rangePreset === "month" ? "month" : "day";

const replayModeLabel = (rangePreset: string) => {
  const mode = replayMode(rangePreset);
  if (mode === "month") return "Month: latest first";
  return "Day: latest first";
};

const hasConfirmedDriver = (row: TimelineRow) => {
  const driver = driverValue(row);
  return Boolean(driver && !["unknown", "no_state_change"].includes(driver));
};

const hasMarketReadObservation = (row: TimelineRow) => {
  const marketRead =
    (row.payload?.market_read && typeof row.payload.market_read === "object" ? row.payload.market_read as Record<string, unknown> : null) ??
    (row.payload?.analysis && typeof row.payload.analysis === "object"
      ? (row.payload.analysis as Record<string, unknown>).market_read as Record<string, unknown> | undefined
      : null);
  if (!marketRead) return false;
  const headline = rawText(marketRead.headline ?? marketRead.summary_title);
  const status = normalizeValue(marketRead?.status ?? row.payload?.cause_status ?? row.status);
  return Boolean(headline && normalizeValue(headline) !== "unknown" && status !== "context_only");
};

const isInternalReviewStatusRow = (row: TimelineRow) => {
  const semanticType = normalizeValue(row.payload?.semantic_type ?? row.type);
  const eventType = normalizeValue(row.type);
  const summary = normalizeValue(row.payload?.summary ?? row.payload?.causal_chain ?? row.title);
  const tradeConclusion = row.payload?.trade_conclusion;
  return Boolean(
    semanticType === "context_review" ||
      eventType === "context_review" ||
      tradeConclusion === false ||
      summary.includes("needs_fresh_live_price") ||
      summary.includes("needs fresh live price") ||
      summary.includes("recent price history")
  );
};

const isContextOnlyAnalysisRow = (row: TimelineRow) => {
  if (row.source !== "event") return false;
  if (hasMarketReadObservation(row)) return false;
  const driver = driverValue(row);
  const impact = timelineImpactValue(row);
  const causeStatus = normalizeValue(row.payload?.cause_status ?? row.status);
  const summary = normalizeValue(row.payload?.summary ?? row.payload?.causal_chain);
  return (
    isInternalReviewStatusRow(row) ||
    !driver ||
    driver === "unknown" ||
    causeStatus === "unconfirmed" ||
    summary.includes("current_conclusion_is_paused") ||
    impact === 0
  );
};

const isAnalyzedNewsRow = (item: Record<string, unknown>) => {
  const summarySource = normalizeValue(item.summary_source);
  const reviewStatus = normalizeValue(item.review_status ?? item.evidence_status);
  const driver = normalizeValue(item.main_driver ?? item.driver);
  return Boolean(
    summarySource === "local_ai" ||
    reviewStatus.includes("accepted") ||
    reviewStatus.includes("used") ||
    (driver && driver !== "unknown") ||
    numberValue(item.impact_percent) !== null
  );
};

const isReplayNewsRow = (item: Record<string, unknown>) => {
  if (!rawText(item.title ?? item.summary_title)) return false;
  const filterReason = normalizeValue(item.filter_reason ?? item.reason);
  const reviewStatus = normalizeValue(item.review_status ?? item.evidence_status ?? item.included);
  if (filterReason.includes("no_market_agent_keyword")) return false;
  if (item.included === false || ["false", "filtered", "excluded", "rejected", "dropped", "unreviewed_context"].includes(reviewStatus)) {
    return false;
  }
  return item.included === true || isAnalyzedNewsRow(item);
};

const isReplayCalendarRow = (item: Record<string, unknown>) => {
  const text = normalizeValue(`${item.title ?? ""} ${item.summary ?? ""} ${item.description ?? ""}`);
  if (!text) return false;
  const reviewStatus = normalizeValue(item.review_status ?? item.evidence_status ?? item.included);
  if (item.included === false || ["false", "filtered", "excluded", "rejected", "dropped"].includes(reviewStatus)) return false;
  const impact = normalizeValue(item.impact ?? item.importance ?? item.context_type ?? item.relevance_reason);
  const currency = normalizeValue(item.currency ?? item.country ?? item.region);
  if (text.includes("session_open") || text.includes("session_opens") || text.includes("market_session")) return false;
  if (impact.includes("holiday") || text.includes("holiday") || text.includes("birthday") || text.includes("bank_holiday")) return false;
  if (["accepted", "used", "included", "supporting", "confirming", "true"].includes(reviewStatus)) return true;
  if (currency && currency !== "usd" && !text.includes("fed") && !text.includes("fomc")) return false;
  if (
    !currency &&
    ["german", "french", "spanish", "italian", "eurozone", "ecb", "buba", "boe", "boj", "rba", "boc"].some((needle) =>
      text.includes(needle)
    )
  ) {
    return false;
  }
  return [
    "fed",
    "fomc",
    "powell",
    "us_",
    "u_s",
    "michigan",
    "rate",
    "treasury",
    "yield",
    "cpi",
    "ppi",
    "pce",
    "inflation",
    "nfp",
    "payroll",
    "jobless",
    "unemployment",
    "retail_sales",
    "ism",
    "pmi",
    "gdp",
    "auction",
    "consumer_confidence",
    "sentiment"
  ].some((needle) => text.includes(needle));
};

const marketReplayStoryFingerprint = (value: unknown) => {
  const stems: Record<string, string> = {
    loses: "lose",
    losing: "lose",
    lost: "lose",
    falls: "fall",
    fell: "fall",
    falling: "fall",
    jumps: "jump",
    jumped: "jump",
    jumping: "jump",
    rises: "rise",
    rose: "rise",
    rising: "rise",
    extends: "extend",
    extended: "extend",
    extending: "extend",
    changes: "change",
    changed: "change",
    changing: "change",
    announces: "announce",
    announced: "announce",
    announcing: "announce"
  };
  const stopwords = new Set([
    "a", "an", "and", "are", "as", "at", "be", "for", "from", "in", "into", "is", "it",
    "its", "just", "more", "of", "on", "over", "report", "s", "says", "than", "that",
    "the", "their", "to", "with"
  ]);
  const tokens = normalizeValue(String(value ?? "").replace(/short-seller/gi, "short seller"))
    .split(/[^a-z0-9]+/)
    .map((token) => stems[token] ?? token)
    .filter((token) => token && !stopwords.has(token));
  return tokens.length >= 5 ? tokens.slice(0, 14).join(" ") : "";
};

const uniqueMarketContextRows = (rows: Record<string, unknown>[], limit: number) => {
  const seen = new Set<string>();
  return [...rows]
    .sort((left, right) => timestampMs(timestampValue(right)) - timestampMs(timestampValue(left)))
    .filter((row) => {
      const title = rawText(row.title ?? row.summary_title ?? row.display_title ?? row.ai_title ?? row.short_title);
      const link = rawText(row.link ?? row.url ?? row.guid);
      const source = rawText(row.source);
      const scheduled = rawText(row.scheduled_at);
      const storyKey = marketReplayStoryFingerprint(title);
      const key = storyKey
        ? `story:${storyKey}:${normalizeValue(source)}`
        : normalizeValue(`${title}|${link || source}|${scheduled && !link ? scheduled : ""}`);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
};

const isMaintenanceRow = (row: TimelineRow) => {
  const kind = inferTimelineKind(row);
  const status = normalizeValue(row.status);
  const title = normalizeValue(row.title);
  return (
    kind === "recovery" ||
    row.source === "suppressed" ||
    title.includes("backfill") ||
    status.includes("recovery")
  );
};

const isMajorTimelineRow = (row: TimelineRow) => {
  const kind = inferTimelineKind(row);
  const impact = timelineImpactValue(row);
  const status = normalizeValue(row.status);
  const title = normalizeValue(row.title);
  if (isMaintenanceRow(row) || isContextOnlyAnalysisRow(row) || !hasConfirmedDriver(row)) return false;
  if (row.source === "alert") return typeof impact === "number" ? Math.abs(impact) >= 0.2 : true;
  if (["breakout", "reversal"].includes(kind)) return true;
  if (typeof impact === "number" && Math.abs(impact) >= 0.35) return true;
  if (status.includes("level_2") || status.includes("level_3") || status.includes("confirmed")) return true;
  return ["pressure", "breakout", "selloff", "drop", "spike", "reversal", "driver"].some((word) => title.includes(word));
};

const sourceLabel = (row: TimelineRow) => {
  if (row.source === "event") return "Monitor timeline";
  if (row.source === "news") return "News feed";
  if (row.source === "calendar") return "Calendar";
  if (row.source === "alert") return "Alert decision";
  return "Replay";
};

const replayMetaText = (row: TimelineRow) => {
  const meta = row.meta && row.meta !== "Unknown driver" ? row.meta : "Driver not confirmed";
  return `${meta} · ${sourceLabel(row)}`;
};

const majorRowKey = (row: TimelineRow) => {
  const impact = timelineImpactValue(row);
  const parsedTime = new Date(row.time);
  const timeKey = Number.isNaN(parsedTime.getTime())
    ? String(row.time)
    : parsedTime.toISOString().slice(0, 16);
  return [
    timeKey,
    inferTimelineKind(row),
    driverValue(row),
    impact === null ? "watching" : impact.toFixed(2),
    compactTimelineTitle(row).toLowerCase()
  ].join("|");
};

const dedupeMajorRows = (rows: TimelineRow[]) => {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = majorRowKey(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const buildTimelineRows = (payload: MarketAgentReplayResponse["replay"]): TimelineRow[] => {
  const eventRunIds = new Set(payload.timeline_events.map((item) => item.monitor_run_id).filter(Boolean));
  const replayNewsItems = uniqueMarketContextRows(payload.news_items.filter(isReplayNewsRow), REPLAY_NEWS_MARKER_LIMIT);
  const replayCalendarEvents = uniqueMarketContextRows(payload.calendar_events.filter(isReplayCalendarRow), REPLAY_CALENDAR_MARKER_LIMIT);
  const observedMove = observedPriceMoveRow(payload);
  const rows: TimelineRow[] = [
    ...payload.timeline_events.map((item) => ({
      key: `timeline-${item.monitor_run_id}-${item.event_time}-${item.label}`,
      time: item.event_time,
      type: item.event_type,
      title: summaryTitle(item.payload, item.label),
      meta: formatDriverLabel((item.payload?.main_driver as string | undefined) ?? "unknown"),
      status: (item.payload?.cause_status as string | undefined) ?? item.event_type,
      source: "event" as const,
      payload: item.payload,
      monitorRunId: item.monitor_run_id
    })),
    ...replayNewsItems.map((item, index) => ({
      key: `news-${index}-${String(item.published_at ?? item.title ?? "")}`,
      time: String(timestampValue(item)),
      type: "News",
      title: summaryTitle(item, String(item.title ?? "News item")),
      meta: String(item.source ?? formatDriverLabel(item.driver ?? item.category ?? "news")),
      status: String(item.data_mode ?? "possible"),
      source: "news" as const,
      payload: item
    })),
    ...replayCalendarEvents.map((item, index) => ({
      key: `calendar-${index}-${String(item.scheduled_at ?? item.title ?? "")}`,
      time: String(item.scheduled_at ?? ""),
      type: "Calendar",
      title: summaryTitle(item, String(item.title ?? "Calendar event")),
      meta: formatDriverLabel(item.driver ?? item.currency ?? "calendar"),
      status: String(item.data_mode ?? "possible"),
      source: "calendar" as const,
      payload: item
    })),
    ...payload.alerts
      .filter((item) => item.should_notify === true || item.shouldNotify === true)
      .filter((item) => !item.monitor_run_id || !eventRunIds.has(item.monitor_run_id))
      .map((item, index) => ({
        key: `alert-${index}-${item.monitor_run_id ?? index}`,
        time: String(item.run_started_at ?? ""),
        type: "Alert",
        title: summaryTitle(item, String(item.message ?? "Alert")),
        meta: formatDriverLabel(item.main_driver ?? "unknown"),
        status: String(item.notification_level ?? "confirmed"),
        source: "alert" as const,
        payload: item,
        monitorRunId: item.monitor_run_id
      }))
  ];

  const visibleRows = rows
    .filter((row) => !isContextOnlyAnalysisRow(row))
    .filter((row) => row.source !== "suppressed")
    .filter((row) => row.time || row.title)
    .sort((left, right) => compareTimelineTimeDesc(left.time, right.time));
  return visibleRows.length ? visibleRows : observedMove ? [observedMove] : [];
};

const buildMonthSummaryRows = (payload: MarketAgentReplayResponse["replay"]): TimelineRow[] => {
  if (!payload.month_summary_events?.length) return [];
  return payload.month_summary_events
    .map((item) => ({
      key: `month-summary-${item.monitor_run_id}-${item.event_time}-${item.label}`,
      time: item.event_time,
      type: item.event_type,
      title: summaryTitle(item.payload, item.label),
      meta: formatDriverLabel((item.payload?.main_driver as string | undefined) ?? "unknown"),
      status: (item.payload?.cause_status as string | undefined) ?? item.event_type,
      source: "event" as const,
      payload: item.payload,
      monitorRunId: item.monitor_run_id
    }))
    .filter((row) => row.time || row.title)
    .sort((left, right) => compareTimelineTimeDesc(left.time, right.time));
};

const objectValue = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const textListValue = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((item) => rawText(item)).filter(Boolean) : [];

const selectedEvidenceFallbackRows = (
  selectedEvidence: MarketAgentEvidenceForRunResponse | null | undefined
): TimelineRow[] => {
  const packet = objectValue(selectedEvidence?.payload?.evidence_packet);
  const analysis = objectValue(selectedEvidence?.payload?.analysis_result);
  const marketRead = objectValue(packet?.market_read) ?? objectValue(analysis?.market_read);
  if (!marketRead) return [];
  const runTime = rawText(selectedEvidence?.payload?.monitor_run?.run_started_at);
  const evidence = objectValue(marketRead.evidence);
  const rows: TimelineRow[] = [];
  const headline = rawText(marketRead.headline);
  if (headline && normalizeValue(headline) !== "unknown") {
    rows.push({
      key: `selected-market-read-${runTime || headline}`,
      time: runTime,
      type: "Market read",
      title: headline,
      meta: formatDriverLabel(marketRead.driver ?? analysis?.main_driver ?? "market_read"),
      status: rawText(marketRead.status) || rawText(analysis?.cause_status) || "reviewed",
      source: "event",
      payload: {
        ...marketRead,
        main_driver: marketRead.driver ?? analysis?.main_driver ?? "market_read",
        semantic_type: "evidence",
        summary: rawText(marketRead.thesis) || "Stored market read · Evidence packet"
      }
    });
  }
  textListValue(evidence?.latest_news).slice(0, 3).forEach((title, index) => {
    rows.push({
      key: `selected-news-${index}-${title}`,
      time: runTime,
      type: "News",
      title,
      meta: "News",
      status: "reviewed",
      source: "news",
      payload: {
        title,
        summary: "Reviewed news · Evidence packet",
        included: true,
        summary_source: "local_ai"
      }
    });
  });
  textListValue(evidence?.calendar).slice(0, 2).forEach((title, index) => {
    rows.push({
      key: `selected-calendar-${index}-${title}`,
      time: runTime,
      type: "Calendar",
      title,
      meta: "Calendar",
      status: "reviewed",
      source: "calendar",
      payload: {
        title,
        summary: "Reviewed calendar · Evidence packet",
        included: true,
        impact: "medium"
      }
    });
  });
  return rows.filter((row) => row.time || row.title);
};

export function MarketAgentReplay({
  replay,
  selectedEvidence,
  selectedMonitorRunId: _selectedMonitorRunId,
  rangePreset,
  rangeStartInput,
  rangeEndInput,
  onPresetChange,
  onRangeStartChange,
  onRangeEndChange,
  onApplyRange,
  onSelectRun: _onSelectRun
}: MarketAgentReplayProps) {
  const [selectedDetail, setSelectedDetail] = useState<ReplayDetailItem | null>(null);
  const mode = replayMode(rangePreset);
  const [rowsReady, setRowsReady] = useState(!DEFER_REPLAY_ROWS);
  const deferredReplay = useDeferredValue(replay);
  useEffect(() => {
    if (!DEFER_REPLAY_ROWS) {
      setRowsReady(true);
      return undefined;
    }
    setRowsReady(false);
    let raf1 = 0;
    let raf2 = 0;
    let cancelled = false;
    raf1 = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(() => {
        if (!cancelled) setRowsReady(true);
      });
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(raf1);
      window.cancelAnimationFrame(raf2);
    };
  }, [deferredReplay, mode]);
  const rows = useMemo(() => {
    if (!rowsReady) return [];
    const payload = normalizeMarketAgentReplayPayload(deferredReplay?.replay);
    const allRows = buildTimelineRows(payload);
    const monthSummaryRows = buildMonthSummaryRows(payload);
    if (mode === "month" && monthSummaryRows.length) return monthSummaryRows;
    if (mode === "month") {
      const majorRows = dedupeMajorRows(allRows.filter(isMajorTimelineRow));
      const fallbackRows = selectedEvidenceFallbackRows(selectedEvidence);
      return majorRows.length ? majorRows : dedupeMajorRows(allRows).length ? dedupeMajorRows(allRows) : fallbackRows;
    }
    return allRows.length ? allRows : selectedEvidenceFallbackRows(selectedEvidence);
  }, [deferredReplay, mode, rowsReady, selectedEvidence]);
  const modeLabel = replayModeLabel(rangePreset);
  const markerLabel = mode === "month" ? "major turns" : "market markers";

  return (
    <section className="market-agent-surface market-agent-replay-surface" data-qa="qa:market-agent:replay">
      <div className="market-agent-surface-header">
        <div>
          <h2>Market Replay</h2>
          <span className="hint">Price action, drivers, and confirmation sequence</span>
        </div>
      </div>

      <div className="market-agent-replay-controls">
        {[
          { value: "day", label: "Day" },
          { value: "month", label: "Month" }
        ].map((preset) => (
          <button
            key={preset.value}
            type="button"
            className={`btn ghost btn-compact${replayMode(rangePreset) === preset.value ? " primary" : ""}`}
            onClick={() => onPresetChange(preset.value)}
            data-qa={`qa:market-agent:range:${preset.value}`}
          >
            {preset.label}
          </button>
        ))}
        <input
          type="datetime-local"
          value={rangeStartInput}
          onChange={(event) => onRangeStartChange(event.target.value)}
          data-qa="qa:market-agent:range-start"
        />
        <input
          type="datetime-local"
          value={rangeEndInput}
          onChange={(event) => onRangeEndChange(event.target.value)}
          data-qa="qa:market-agent:range-end"
        />
        <button type="button" className="btn ghost btn-compact" onClick={onApplyRange} data-qa="qa:market-agent:apply-range">
          Apply
        </button>
      </div>

      {!deferredReplay?.available ? (
        <div className="market-agent-empty-state">{deferredReplay?.message || "Replay data is unavailable."}</div>
      ) : (
        <div className="market-agent-replay-story" data-qa="qa:market-agent:timeline-list">
          <div className="market-agent-replay-story-head">
            <div>
              <span>Market Replay</span>
              <strong>{rowsReady ? rows.length ? `${rows.length} ${markerLabel}` : "No replay markers" : "Loading replay"}</strong>
            </div>
            <MarketAgentStatusBadge label={modeLabel} tone="info" />
          </div>
          <div className="market-agent-replay-track">
            <div className={`market-agent-replay-track-inner${rows.length === 0 ? " is-empty" : ""}`}>
              {!rowsReady ? (
                <div className="market-agent-replay-loading" data-qa="qa:market-agent:replay-loading">
                  <span />
                  <strong>Preparing timeline</strong>
                </div>
              ) : null}
              {rows.map((row, index) => {
                const kind = inferTimelineKind(row);
                const meta = timelineKindMeta[kind];
                return (
                  <button
                    type="button"
                    key={row.key}
                    className={`market-agent-replay-track-row kind-${meta.tone}`}
                    style={{ "--ma-replay-row-index": index } as CSSProperties}
                    onClick={() => setSelectedDetail(replayRowDetail(row))}
                  >
                    <time>{formatShortTime(row.time)}</time>
                    <span className="market-agent-replay-node" aria-hidden="true" />
                    <div className="market-agent-replay-row-body">
                      <div className="market-agent-replay-title-row">
                        <strong>{compactTimelineTitle(row)}</strong>
                        <span className={`market-agent-event-tag tone-${meta.tone}`}>{meta.tag}</span>
                      </div>
                      <div className="market-agent-replay-meta-row">
                        <span>{compactTimelineDetail(row)}</span>
                        <small>{formatTimelineImpact(row)}</small>
                      </div>
                    </div>
                  </button>
                );
              })}
              {rowsReady && rows.length === 0 ? (
                <div className="market-agent-empty-state market-agent-replay-empty">
                  {mode === "month" ? (
                    "No major turns in this window."
                  ) : (
                    <>
                      <strong>No accepted market events in this window.</strong>
                      {" "}
                      <span>No confirmed market-moving news, calendar event, or price move for this period.</span>
                    </>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}
      <ReplayItemDetailModal
        item={selectedDetail}
        onClose={() => setSelectedDetail(null)}
        onOpenRun={(monitorRunId) => {
          setSelectedDetail(null);
          _onSelectRun(monitorRunId);
        }}
      />
    </section>
  );
}

function ReplayItemDetailModal({
  item,
  onClose,
  onOpenRun
}: {
  item: ReplayDetailItem | null;
  onClose: () => void;
  onOpenRun: (monitorRunId: number) => void;
}) {
  useEffect(() => {
    if (!item) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [item, onClose]);

  if (!item) return null;

  return (
    <div className="market-agent-replay-detail-backdrop" role="presentation" onClick={onClose}>
      <section
        className="market-agent-replay-detail"
        role="dialog"
        aria-modal="true"
        aria-label="Replay item detail"
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span>{item.tag}</span>
            <h3>{item.title}</h3>
          </div>
          <button type="button" className="btn ghost btn-compact" onClick={onClose}>Close</button>
        </header>
        <dl>
          <div>
            <dt>Source</dt>
            <dd>{item.source || "--"}</dd>
          </div>
          <div>
            <dt>Time</dt>
            <dd>{formatShortTime(item.time)}</dd>
          </div>
        </dl>
        <p>{item.detail || "No detail recorded for this item."}</p>
        <footer>
          {item.monitorRunId ? (
            <button type="button" className="btn ghost btn-compact" onClick={() => onOpenRun(item.monitorRunId as number)}>
              Open evidence run
            </button>
          ) : null}
          {item.url ? (
            <button type="button" className="btn ghost btn-compact" onClick={() => void openOriginalUrl(item.url as string)}>
              Open original
            </button>
          ) : null}
        </footer>
      </section>
    </div>
  );
}
