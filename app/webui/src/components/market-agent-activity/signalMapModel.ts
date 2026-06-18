import type {
  MarketAgentEvidenceForRunResponse,
  MarketAgentLLMConfigResponse,
  MarketAgentLiveQuoteResponse,
  MarketAgentMonitorStatusResponse,
  MarketAgentProviderConfigResponse,
  MarketAgentProviderHealthEntry,
  MarketAgentProviderHealthResponse,
  MarketAgentReplayPayload,
  MarketAgentReplayResponse,
  MarketAgentTelegramConfigResponse
} from "../../types";
import {
  findProviderHealth,
  humanizeMarketAgentValue,
  normalizeMarketAgentValue,
  providerGuidance
} from "../../utils/marketAgentUi";
import { formatUtcOffset, getSystemUtcOffsetMinutes } from "../../utils/calendarTime";

export type SignalTone = "good" | "working" | "bad" | "muted" | "ai" | "store";

export type SignalNode = {
  id: string;
  label: string;
  lane: string;
  group?: string;
  status: string;
  action: string;
  source: string;
  processing: string;
  output: string;
  storage: string[];
  ai: string;
  trace: string[];
  detail: string;
  tone: SignalTone;
  badges?: SignalBadge[];
  drilldown?: SignalDrilldownSection[];
  history?: SignalDrilldownSection[];
  requests?: SignalDataRequest[];
  performance?: SignalPerformanceSummary;
};

export type SignalBadge = {
  label: string;
  tone: SignalTone;
};

export type SignalDrilldownRow = {
  label: string;
  status: string;
  detail: string;
  meta: string[];
  tone?: SignalTone;
};

export type SignalDrilldownSection = {
  title: string;
  detail: string;
  rows: SignalDrilldownRow[];
};

export type SignalPerformanceSummary = {
  title: string;
  status: string;
  detail: string;
  metrics: SignalDrilldownRow[];
};

export type SignalDataRequest = {
  target: string;
  status: string;
  requestedBy: string;
  reason: string;
  mode: string;
};

export type SignalLane = {
  id: string;
  title: string;
  detail: string;
  nodes: SignalNode[];
};

export type StorageGroup = {
  title: string;
  detail: string;
  tables: string[];
};

export type SignalDecisionTraceItem = {
  label: string;
  status: string;
  detail: string;
  meta: string[];
  tone: SignalTone;
};

export type SignalDecisionTrace = {
  runLabel: string;
  summary: string;
  status: string;
  items: SignalDecisionTraceItem[];
  records: SignalDecisionTraceItem[];
  performance?: SignalPerformanceSummary;
};

export type SignalMapModel = {
  phaseLabel: string;
  phaseMessage: string;
  decisionTrace: SignalDecisionTrace;
  lanes: SignalLane[];
  coreSensors: SignalNode[];
  candidateSensors: SignalNode[];
  discoveredSensors: SignalNode[];
  aiNodes: SignalNode[];
  storageGroups: StorageGroup[];
  storagePath: string;
  outputs: SignalNode[];
};

export type BuildSignalMapArgs = {
  monitorStatus: MarketAgentMonitorStatusResponse | null;
  liveQuote: MarketAgentLiveQuoteResponse | null;
  providerHealth: MarketAgentProviderHealthResponse | null;
  replay: MarketAgentReplayResponse | null;
  selectedEvidence: MarketAgentEvidenceForRunResponse | null;
  providerConfig: MarketAgentProviderConfigResponse | null;
  telegramConfig: MarketAgentTelegramConfigResponse | null;
  llmConfig: MarketAgentLLMConfigResponse | null;
};

const textValue = (entry: Record<string, unknown> | undefined, key: string) => {
  const value = entry?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : "";
};

const userFacingActivityText = (value: string, fallback: string) => {
  const text = value.trim() || fallback;
  const normalized = normalizeMarketAgentValue(text);
  if (
    normalized.includes("current_conclusion_is_paused") ||
    normalized.includes("current conclusion is paused") ||
    normalized.includes("current_driver_conclusions_are_paused")
  ) {
    return "News and calendar context is stored and filtered; the current XAUUSD market conclusion waits for live price history.";
  }
  return text
    .replace(/\bEvidence packet JSON\b/g, "Evidence review packet")
    .replace(/\bEvidence packet\b/g, "Evidence review");
};

const numberValue = (entry: Record<string, unknown> | undefined, key: string) => {
  const value = entry?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const recordValue = (entry: Record<string, unknown> | undefined, key: string) => {
  const value = entry?.[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
};

const recordListValue = (entry: Record<string, unknown> | undefined, key: string) => {
  const value = entry?.[key];
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
};

const listValue = (entry: Record<string, unknown> | undefined, key: string) => {
  const value = entry?.[key];
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean);
};

const statusTone = (status: string): SignalTone => {
  const normalized = normalizeMarketAgentValue(status);
  if (["live", "active", "ready", "available", "validated", "synced", "stored", "sent", "approved", "summarized"].includes(normalized)) return "good";
  if (["checking", "collecting", "syncing", "preparing", "queued", "market_closed", "partial", "stale", "snapshot", "waiting"].includes(normalized)) return "working";
  if (["unavailable", "failed", "error", "blocked"].includes(normalized)) return "bad";
  return "muted";
};

const replayStats = (payload: MarketAgentReplayPayload | undefined) => {
  const priceRows = payload?.price_series ?? [];
  const related = Object.entries(payload?.related_assets ?? {});
  const relatedRows = related.reduce((total, [, rows]) => total + rows.length, 0);
  return {
    priceRows: priceRows.length,
    relatedRows,
    newsRows: payload?.news_items?.length ?? 0,
    calendarRows: payload?.calendar_events?.length ?? 0,
    timelineEvents: payload?.timeline_events?.length ?? 0,
    monthSummaryEvents: payload?.month_summary_events?.length ?? 0,
    alerts: (payload?.alerts?.length ?? 0) + (payload?.suppressed_alerts?.length ?? 0)
  };
};

const latestRelatedAsset = (payload: MarketAgentReplayPayload | undefined, key: string) => {
  const rows = payload?.related_assets?.[key] ?? [];
  return rows.length ? rows[rows.length - 1] : undefined;
};

const assetValue = (row: Record<string, unknown> | undefined) => {
  const value = row?.change_15m ?? row?.change ?? row?.value;
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "waiting";
};

const providerLabel = (health: MarketAgentProviderHealthEntry | undefined, fallback: string) => {
  const source = String(health?.source ?? health?.provider ?? fallback);
  return source || fallback;
};

const defaultNewsFeeds = [
  "Federal Reserve press feed",
  "CNBC Top News RSS",
  "MarketWatch Top Stories RSS"
];

const defaultNewsFeedUrls = [
  "https://www.federalreserve.gov/feeds/press_all.xml",
  "https://www.cnbc.com/id/100003114/device/rss/rss.html",
  "https://www.marketwatch.com/rss/topstories"
];

const splitSourceList = (value: unknown) =>
  String(value ?? "")
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);

const newsFeedLabel = (feed: string) => {
  const lowered = feed.toLowerCase();
  if (lowered.includes("federalreserve.gov")) return "Federal Reserve press feed";
  if (lowered.includes("cnbc.com")) return "CNBC Top News RSS";
  if (lowered.includes("marketwatch.com")) return "MarketWatch Top Stories RSS";
  if (feed.length > 80) return `${feed.slice(0, 77)}...`;
  return feed;
};

const newsFeedSources = (contextEntry: Record<string, unknown> | undefined, newsHealth: MarketAgentProviderHealthEntry | undefined) => {
  const configured = splitSourceList(newsHealth?.raw_source_id);
  const normalized = Array.from(new Set(configured.map(newsFeedLabel).filter(Boolean)));
  return normalized.length ? normalized : defaultNewsFeeds;
};

const newsFeedSourceSummary = (feeds: string[]) => `RSS feeds / ${feeds.length} configured`;

const formatMs = (value: number | null) => (value === null ? "not recorded" : value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms`);

const llmTelemetrySummary = (llmEntry: Record<string, unknown> | undefined): SignalPerformanceSummary => {
  const telemetry = recordListValue(llmEntry, "telemetry");
  const status = textValue(llmEntry, "status") || "waiting";
  if (!telemetry.length) {
    return {
      title: "AI Performance",
      status,
      detail: "No Local AI call ran in this selected run, so token/s and processing speed do not exist for this run.",
      metrics: [
        {
          label: "Local AI calls",
          status,
          detail: "0 calls recorded. This usually means Local AI was disabled, unavailable, skipped by policy, or the run ended before an LLM step was needed.",
          meta: ["token/s: not available", "elapsed: not available", "source: LocalLLMClient telemetry"]
        }
      ]
    };
  }

  const elapsedMs = telemetry.reduce((total, item) => total + (numberValue(item, "elapsed_ms") ?? 0), 0);
  const modelMs = telemetry.reduce((total, item) => total + (numberValue(item, "total_duration_ms") ?? 0), 0);
  const inputTokens = telemetry.reduce((total, item) => total + (numberValue(item, "input_tokens") ?? 0), 0);
  const outputTokens = telemetry.reduce((total, item) => total + (numberValue(item, "output_tokens") ?? 0), 0);
  const tokenRates = telemetry.map((item) => numberValue(item, "tokens_per_second")).filter((value): value is number => value !== null);
  const bestTokenRate = tokenRates.length ? Math.max(...tokenRates) : null;
  const avgTokenRate = tokenRates.length ? Math.round((tokenRates.reduce((total, value) => total + value, 0) / tokenRates.length) * 100) / 100 : null;
  const model = textValue(telemetry[0], "model") || textValue(llmEntry, "model") || "unknown";

  return {
    title: "AI Performance",
    status: "recorded",
    detail: `${telemetry.length} Local AI call(s) recorded for ${model}. Average speed ${avgTokenRate === null ? "not recorded" : `${avgTokenRate} token/s`}.`,
    metrics: [
      {
        label: "Speed",
        status: bestTokenRate === null ? "not recorded" : "recorded",
        detail: bestTokenRate === null ? "Ollama did not return token timing for this run." : `Best call reached ${bestTokenRate} token/s; average ${avgTokenRate} token/s.`,
        meta: [`token/s: ${bestTokenRate === null ? "not recorded" : bestTokenRate}`, `average token/s: ${avgTokenRate === null ? "not recorded" : avgTokenRate}`, `model: ${model}`]
      },
      {
        label: "Processing time",
        status: "recorded",
        detail: `Wall time ${formatMs(elapsedMs)}; model duration ${formatMs(modelMs)}.`,
        meta: [`elapsed: ${formatMs(elapsedMs)}`, `model duration: ${formatMs(modelMs)}`, `calls: ${telemetry.length}`]
      },
      {
        label: "Token usage",
        status: "recorded",
        detail: `${inputTokens} input token(s), ${outputTokens} output token(s).`,
        meta: [`input tokens: ${inputTokens}`, `output tokens: ${outputTokens}`, `source: LocalLLMClient telemetry`]
      }
    ]
  };
};

const llmTelemetryRows = (llmEntry: Record<string, unknown> | undefined): SignalDrilldownRow[] => {
  const telemetry = recordListValue(llmEntry, "telemetry");
  if (!telemetry.length) {
    return [
      {
        label: "No telemetry recorded",
        status: textValue(llmEntry, "status") || "waiting",
        detail: "No Local AI call metrics were recorded for this selected run.",
        meta: ["metrics: elapsed / tokens / token/s", "source: LocalLLMClient"]
      }
    ];
  }
  return telemetry.map((item) => {
    const rawTask = textValue(item, "task") || "llm_call";
    const task = normalizeMarketAgentValue(rawTask);
    const rawStatus = normalizeMarketAgentValue(textValue(item, "status") || "recorded");
    const status = ["ok", "success", "completed", "validated"].includes(rawStatus)
      ? "completed"
      : ["error", "failed", "invalid", "invalid_or_unavailable"].includes(rawStatus)
        ? "failed"
        : rawStatus.replace(/_/g, " ");
    const elapsed = numberValue(item, "elapsed_ms");
    const total = numberValue(item, "total_duration_ms");
    const inputTokens = numberValue(item, "input_tokens");
    const outputTokens = numberValue(item, "output_tokens");
    const tps = numberValue(item, "tokens_per_second");
    const model = textValue(item, "model") || "unknown";
    const error = textValue(item, "error");
    const taskInfo = (() => {
      if (task === "cause_review") {
        return {
          label: "Cause review",
          type: "Cause analysis",
          result: status === "failed" ? "cause analysis failed" : "cause analysis completed",
          success: `Model ${model} reviewed the bounded evidence packet and returned a valid cause analysis. This completed the AI cause-review step, not the whole Market Agent run.`,
          failure: `Model ${model} failed while reviewing the bounded evidence packet, so Market Agent must keep rule-based cause analysis or the last valid stored result.`
        };
      }
      if (task === "display_summary") {
        return {
          label: "Display summary",
          type: "Display text",
          result: status === "failed" ? "display summary failed" : "display summary completed",
          success: `Model ${model} created shorter user-facing summary text for dashboard rows. This completed the display-summary step only.`,
          failure: `Model ${model} failed while creating user-facing summary text. Dashboard rows should fall back to stored source text, and this does not invalidate a separate cause review.`
        };
      }
      return {
        label: humanizeMarketAgentValue(rawTask),
        type: "AI call",
        result: status === "failed" ? "AI call failed" : "AI call completed",
        success: `Model ${model} completed this Local AI task.`,
        failure: `Model ${model} failed during this Local AI task.`
      };
    })();
    return {
      label: taskInfo.label,
      status,
      detail: error ? `${taskInfo.failure} Error: ${error}.` : status === "failed" ? taskInfo.failure : taskInfo.success,
      meta: [
        `task: ${rawTask}`,
        `type: ${taskInfo.type}`,
        `result: ${taskInfo.result}`,
        `model: ${model}`,
        elapsed === null ? "elapsed: not recorded" : `elapsed: ${elapsed}ms`,
        total === null ? "model duration: not recorded" : `model duration: ${total}ms`,
        inputTokens === null ? "input tokens: not recorded" : `input tokens: ${inputTokens}`,
        outputTokens === null ? "output tokens: not recorded" : `output tokens: ${outputTokens}`,
        tps === null ? "token/s: not recorded" : `token/s: ${tps}`
      ]
    };
  });
};

const booleanText = (value: unknown) => (value === true ? "yes" : value === false ? "no" : "unknown");

const firstText = (...values: unknown[]) => {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
};

const shortHistoryText = (value: unknown, fallback = "not recorded") => {
  const text = String(value ?? "").trim();
  if (!text) return fallback;
  return text.length > 150 ? `${text.slice(0, 147)}...` : text;
};

const historyDisplayText = (value: unknown, fallback = "not recorded") => {
  const text = firstText(value);
  return text ? humanizeMarketAgentValue(text) : fallback;
};

const isUnknownDriver = (value: unknown) => {
  const normalized = normalizeMarketAgentValue(value);
  return !normalized || normalized === "unknown" || normalized === "none" || normalized === "not_recorded";
};

const isUnconfirmedCause = (value: unknown) => {
  const normalized = normalizeMarketAgentValue(value);
  return !normalized || normalized === "unconfirmed" || normalized === "unknown" || normalized === "not_confirmed";
};

const noTradeCallReason = (row: Record<string, unknown>, summary: string) => {
  const text = normalizeMarketAgentValue(`${summary} ${row.rejection_reason ?? ""} ${row.evidence_status ?? ""}`);
  if (text.includes("market_closed") || text.includes("market_is_closed") || text.includes("market_reopens")) {
    return "Market closed, evidence kept";
  }
  if (text.includes("live_xauusd") || text.includes("price_history") || text.includes("recent_price_history") || text.includes("current_conclusion_is_paused")) {
    return "Waiting for live price history";
  }
  if (text.includes("no_news")) return "No market news driver found";
  return "Evidence not enough";
};

const compactListText = (values: string[], fallback = "not recorded") => values.length ? values.join(" | ") : fallback;

const readableCoverageCount = (value: unknown, noun: string) => {
  const text = firstText(value);
  if (!text) return "";
  const count = text.match(/\d+(?:\s+of\s+\d+)?/i)?.[0] ?? text;
  return `${count} ${noun}`;
};

const marketReadSignature = (row: Record<string, unknown>) => {
  const marketRead = recordValue(row, "market_read");
  const evidence = recordValue(marketRead, "evidence");
  return JSON.stringify({
    engine: firstText(row.analysis_engine),
    status: firstText(row.llm_status),
    driver: firstText(row.main_driver),
    cause: firstText(row.cause_status),
    confidence: firstText(row.confidence),
    summary: firstText(row.summary, row.causal_chain),
    readStatus: firstText(marketRead.status),
    headline: firstText(marketRead.headline),
    thesis: firstText(marketRead.thesis),
    missing: listValue(evidence, "missing"),
    latestNews: listValue(evidence, "latest_news"),
    calendar: listValue(evidence, "calendar"),
    watchNext: listValue(marketRead, "watch_next")
  });
};

const compactStoredAiHistoryRows = (rows: Record<string, unknown>[]) => {
  const groups: Record<string, unknown>[] = [];
  for (const row of rows) {
    const signature = marketReadSignature(row);
    const previous = groups[groups.length - 1];
    if (previous && previous.__signature === signature) {
      previous.__repeatCount = Number(previous.__repeatCount ?? 1) + 1;
      previous.__oldestRunStartedAt = firstText(row.run_started_at, row.created_at, previous.__oldestRunStartedAt);
      previous.__oldestMonitorRunId = firstText(row.monitor_run_id, previous.__oldestMonitorRunId);
      continue;
    }
    groups.push({
      ...row,
      __signature: signature,
      __repeatCount: 1,
      __latestRunStartedAt: firstText(row.run_started_at, row.created_at, ""),
      __oldestRunStartedAt: firstText(row.run_started_at, row.created_at, ""),
      __latestMonitorRunId: firstText(row.monitor_run_id, ""),
      __oldestMonitorRunId: firstText(row.monitor_run_id, "")
    });
  }
  return groups;
};

const normalizeNewsKeyPart = (value: unknown) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

const newsRowKey = (item: Record<string, unknown>, index: number) => {
  const title = normalizeNewsKeyPart(item.title ?? item.summary_title);
  const link = normalizeNewsKeyPart(item.link);
  if (!title && !link) return `row:${index}`;
  return [
    title,
    normalizeNewsKeyPart(item.source),
    String(item.published_at ?? "").trim(),
    link
  ].join("|");
};

const newsSeenCount = (item: Record<string, unknown>) => {
  const seenCount = numberValue(item, "seen_count");
  if (seenCount !== null) return Math.max(1, Math.round(seenCount));
  const duplicateCount = numberValue(item, "duplicate_count");
  if (duplicateCount !== null) return Math.max(1, Math.round(duplicateCount) + 1);
  return 1;
};

const parseNewsTime = (value: unknown) => {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
};

const earlierNewsTime = (left: unknown, right: unknown) => {
  const leftText = firstText(left);
  const rightText = firstText(right);
  if (!leftText) return rightText;
  if (!rightText) return leftText;
  const leftMs = parseNewsTime(leftText);
  const rightMs = parseNewsTime(rightText);
  if (leftMs === null) return rightText;
  if (rightMs === null) return leftText;
  return leftMs <= rightMs ? leftText : rightText;
};

const laterNewsTime = (left: unknown, right: unknown) => {
  const leftText = firstText(left);
  const rightText = firstText(right);
  if (!leftText) return rightText;
  if (!rightText) return leftText;
  const leftMs = parseNewsTime(leftText);
  const rightMs = parseNewsTime(rightText);
  if (leftMs === null) return rightText;
  if (rightMs === null) return leftText;
  return leftMs >= rightMs ? leftText : rightText;
};

const newsPreferenceScore = (item: Record<string, unknown>) => {
  const hasSummary = Boolean(firstText(item.summary, item.short_summary, item.summary_source, item.ai_summary_source));
  const included = item.included === true || normalizeMarketAgentValue(item.review_status).includes("included");
  const seenAt = firstText(item.fetched_at, item.last_seen_at, item.first_seen_at, item.published_at);
  return (hasSummary ? 10_000_000_000_000 : 0) + (included ? 1_000_000_000_000 : 0) + (parseNewsTime(seenAt) ?? 0);
};

const newsFilterExplanation = (value: unknown) => {
  switch (normalizeMarketAgentValue(value)) {
    case "no_market_agent_keyword":
      return "No Market Agent keyword matched, so this stayed out of evidence.";
    case "missing_timestamp":
      return "No reliable published time was available, so this stayed out of evidence.";
    case "stale_news_item":
      return "The headline is outside the fresh news window, so this stayed out of evidence.";
    case "low_signal_opinion_or_forecast":
      return "This looks like low-signal opinion or forecast content, so this stayed out of evidence.";
    case "score_below_threshold":
      return "The relevance score was below the Market Agent threshold.";
    default:
      return firstText(value);
  }
};

const newsFilterSummaryLabel = (value: unknown) => {
  switch (normalizeMarketAgentValue(value)) {
    case "no_market_agent_keyword":
      return "No Market Agent keyword matched";
    case "missing_timestamp":
      return "Missing timestamp";
    case "stale_news_item":
      return "Outside fresh news window";
    case "low_signal_opinion_or_forecast":
      return "Low-signal opinion or forecast";
    case "score_below_threshold":
      return "Relevance score below threshold";
    default:
      return humanizeMarketAgentValue(value, "Not recorded");
  }
};

const compactNewsItems = (items: Record<string, unknown>[]) => {
  const rows = new Map<string, Record<string, unknown>>();
  items.forEach((item, index) => {
    const key = newsRowKey(item, index);
    const existing = rows.get(key);
    if (!existing) {
      rows.set(key, { ...item, seen_count: newsSeenCount(item), duplicate_count: Math.max(0, newsSeenCount(item) - 1) });
      return;
    }
    const preferred = newsPreferenceScore(item) > newsPreferenceScore(existing) ? item : existing;
    const firstSeenAt = earlierNewsTime(existing.first_seen_at ?? existing.fetched_at, item.first_seen_at ?? item.fetched_at);
    const lastSeenAt = laterNewsTime(existing.last_seen_at ?? existing.fetched_at ?? existing.first_seen_at, item.last_seen_at ?? item.fetched_at ?? item.first_seen_at);
    const seenCount = newsSeenCount(existing) + newsSeenCount(item);
    rows.set(key, {
      ...preferred,
      first_seen_at: firstSeenAt || preferred.first_seen_at,
      last_seen_at: lastSeenAt || preferred.last_seen_at,
      fetched_at: lastSeenAt || preferred.fetched_at || preferred.first_seen_at,
      seen_count: seenCount,
      duplicate_count: Math.max(0, seenCount - 1)
    });
  });
  return Array.from(rows.values());
};

const formatNewsCoverageDay = (date: Date) => {
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()}`;
};

const startOfLocalDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());

const parseCoverageDate = (value: unknown) => {
  const text = firstText(value);
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const adjustedCoverageEnd = (start: Date, end: Date) => {
  const adjusted = new Date(end);
  if (
    adjusted.getTime() > start.getTime() &&
    adjusted.getHours() === 0 &&
    adjusted.getMinutes() === 0 &&
    adjusted.getSeconds() === 0 &&
    adjusted.getMilliseconds() === 0
  ) {
    adjusted.setMilliseconds(adjusted.getMilliseconds() - 1);
  }
  return adjusted;
};

const newsCoverageTimestamp = (item: Record<string, unknown>) =>
  parseCoverageDate(firstText(item.published_at, item.fetched_at, item.first_seen_at, item.last_seen_at));

const isIncludedNewsItem = (item: Record<string, unknown>) =>
  item.included === true || normalizeMarketAgentValue(item.review_status).includes("included");

const isFilteredNewsItem = (item: Record<string, unknown>) =>
  item.included === false || normalizeMarketAgentValue(item.review_status).includes("filtered");

const newsSummarySource = (item: Record<string, unknown>) => firstText(item.summary_source, item.ai_summary_source);

const hasNewsAiSummary = (item: Record<string, unknown>) => Boolean(newsSummarySource(item));

const summarizeNewsFilters = (items: Record<string, unknown>[]) => {
  const counts = new Map<string, number>();
  items.filter(isFilteredNewsItem).forEach((item) => {
    const label = newsFilterSummaryLabel(item.filter_reason || item.reason || "Not recorded");
    counts.set(label, (counts.get(label) ?? 0) + 1);
  });
  return Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([label, count]) => `${label}: ${count}`)
    .join("; ");
};

const summarizeNewsSummarySources = (items: Record<string, unknown>[]) => {
  const counts = new Map<string, number>();
  items.map(newsSummarySource).filter(Boolean).forEach((source) => {
    counts.set(source, (counts.get(source) ?? 0) + 1);
  });
  return Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([source, count]) => `${source}: ${count}`)
    .join("; ");
};

const minDate = (dates: Date[]) =>
  dates.reduce<Date | null>((earliest, date) => (!earliest || date.getTime() < earliest.getTime() ? date : earliest), null);

const maxDate = (dates: Date[]) =>
  dates.reduce<Date | null>((latest, date) => (!latest || date.getTime() > latest.getTime() ? date : latest), null);

const newsCoverageRows = (items: Record<string, unknown>[], replay: MarketAgentReplayResponse | null): SignalDrilldownRow[] => {
  const compacted = compactNewsItems(items);
  const datedItems = compacted
    .map((item) => ({ item, date: newsCoverageTimestamp(item) }))
    .filter((entry): entry is { item: Record<string, unknown>; date: Date } => entry.date !== null);
  const itemDates = datedItems.map((entry) => entry.date);
  const replayStart = parseCoverageDate(replay?.start);
  const replayEnd = parseCoverageDate(replay?.end);
  const start = replayStart ?? minDate(itemDates);
  const end = replayEnd && start ? adjustedCoverageEnd(start, replayEnd) : maxDate(itemDates);

  if (!start || !end || start.getTime() > end.getTime()) {
    return [
      {
        label: "Selected window",
        status: "empty",
        detail: "No replay range or stored news timestamp is available, so day-level coverage cannot be shown yet.",
        meta: [
          `selected_window: ${firstText(replay?.start, "not recorded")} -> ${firstText(replay?.end, "not recorded")}`,
          "storage: news_items"
        ]
      }
    ];
  }

  const byDay = new Map<string, Record<string, unknown>[]>();
  datedItems.forEach(({ item, date }) => {
    const key = formatNewsCoverageDay(date);
    const rows = byDay.get(key) ?? [];
    rows.push(item);
    byDay.set(key, rows);
  });

  const rows: SignalDrilldownRow[] = [];
  const maxDays = 45;
  const cursor = startOfLocalDay(start);
  const endDay = startOfLocalDay(end);
  while (cursor.getTime() <= endDay.getTime() && rows.length < maxDays) {
    const label = formatNewsCoverageDay(cursor);
    const dayItems = byDay.get(label) ?? [];
    const included = dayItems.filter(isIncludedNewsItem).length;
    const filtered = dayItems.filter(isFilteredNewsItem).length;
    const filterReasons = summarizeNewsFilters(dayItems);
    const aiSummaries = dayItems.filter(hasNewsAiSummary).length;
    const summarySources = summarizeNewsSummarySources(dayItems);
    const publishedDates = dayItems.map((item) => parseCoverageDate(item.published_at)).filter((date): date is Date => date !== null);
    const firstPublished = minDate(publishedDates);
    const lastPublished = maxDate(publishedDates);

    rows.push({
      label,
      status: dayItems.length ? "available" : "missing",
      detail: dayItems.length
        ? `${dayItems.length} headline row(s), ${included} included, ${filtered} filtered. Filter reasons: ${filterReasons || "none"}. AI summaries: ${aiSummaries}. Published ${readableDateTime(firstPublished?.toISOString())} -> ${readableDateTime(lastPublished?.toISOString())}.`
        : "No stored news rows in the selected replay window for this day.",
      meta: [
        `selected_window: ${firstText(replay?.start, "not recorded")} -> ${firstText(replay?.end, "not recorded")}`,
        `included: ${included}`,
        `filtered: ${filtered}`,
        `filter_reasons: ${filterReasons || "none"}`,
        `ai_summaries: ${aiSummaries}`,
        `summary_sources: ${summarySources || "none"}`,
        "storage: news_items"
      ]
    });
    cursor.setDate(cursor.getDate() + 1);
  }

  if (cursor.getTime() <= endDay.getTime()) {
    rows.push({
      label: "Range truncated",
      status: "partial",
      detail: `Showing the first ${maxDays} day(s). Narrow the replay range to inspect the rest of the news coverage.`,
      meta: [
        `selected_window: ${firstText(replay?.start, "not recorded")} -> ${firstText(replay?.end, "not recorded")}`,
        "storage: news_items"
      ]
    });
  }

  return rows;
};

const sensorLabel = (value: string) => value.replace(/[^a-z0-9]/gi, "").toUpperCase();

const aiHistoryItems = (llmEntry: Record<string, unknown> | undefined): SignalDecisionTraceItem[] => {
  const telemetry = recordListValue(llmEntry, "telemetry");
  const rows = llmTelemetryRows(llmEntry);
  if (!telemetry.length) return [];
  return rows.map((row): SignalDecisionTraceItem => ({
    label: row.label,
    status: row.status,
    detail: row.detail,
    meta: [...row.meta, "history: LocalLLMClient telemetry"],
    tone: row.status === "error" || row.status === "invalid" ? "bad" : "ai"
  }));
};

const storedAiHistoryItems = (selectedEvidence: MarketAgentEvidenceForRunResponse | null): SignalDecisionTraceItem[] => {
  const rows = recordListValue(selectedEvidence?.payload, "analysis_history");
  return compactStoredAiHistoryRows(rows
    .filter((row) => firstText(row.analysis_engine) === "llm_validated" || firstText(row.llm_status) === "validated")
    .slice(0, 100))
    .map((row): SignalDecisionTraceItem => {
      const runStartedAt = firstText(row.run_started_at, row.created_at, "");
      const engine = firstText(row.analysis_engine, "analysis");
      const llmStatus = firstText(row.llm_status, "stored");
      const causeStatus = firstText(row.cause_status, "unknown");
      const mainDriver = firstText(row.main_driver, "unknown");
      const confidence = firstText(row.confidence, "not recorded");
      const marketRead = recordValue(row, "market_read");
      const marketReadCoverage = recordValue(marketRead, "coverage");
      const marketReadEvidence = recordValue(marketRead, "evidence");
      const marketReadHeadline = firstText(marketRead?.headline, "");
      const marketReadThesis = firstText(marketRead?.thesis, "");
      const marketReadStatus = firstText(marketRead?.status, "");
      const latestNews = listValue(marketReadEvidence, "latest_news");
      const missingInputs = listValue(marketReadEvidence, "missing");
      const watchNext = listValue(marketRead, "watch_next");
      const coverageLabel = [
        readableCoverageCount(marketReadCoverage.news, "news"),
        readableCoverageCount(marketReadCoverage.calendar, "calendar"),
        readableCoverageCount(marketReadCoverage.sensors, "sensors")
      ].filter(Boolean).join(", ");
      const summary = firstText(row.summary, row.causal_chain, "Stored AI analysis result.");
      const driverLabel = historyDisplayText(mainDriver, "Driver unknown");
      const causeLabel = historyDisplayText(causeStatus, "Cause unknown");
      const confidenceLabel = historyDisplayText(confidence, "Confidence not recorded");
      const noTradeCall = isUnknownDriver(mainDriver) && isUnconfirmedCause(causeStatus);
      const marketObservation = normalizeMarketAgentValue(marketReadStatus) === "market_observation";
      const resultLabel = noTradeCall ? noTradeCallReason(row, summary) : `${driverLabel} / ${causeLabel}`;
      const displayResult = marketObservation ? marketReadHeadline || resultLabel : noTradeCall ? resultLabel : marketReadHeadline || resultLabel;
      const aiStepLabel = marketObservation ? "Market observation" : noTradeCall ? "Trade-call review" : "Driver cause review";
      const statusLabel = llmStatus === "validated" ? "ai_validated" : llmStatus;
      const repeatCount = Number(row.__repeatCount ?? 1);
      const oldestRunStartedAt = firstText(row.__oldestRunStartedAt, runStartedAt);
      const repeatedLabel = repeatCount > 1 ? ` This same read repeated ${repeatCount} times from ${oldestRunStartedAt} to ${runStartedAt}.` : "";
      const reviewScope = coverageLabel ? ` Reviewed ${coverageLabel}.` : "";
      const missingLabel = missingInputs.length ? ` Missing: ${missingInputs.join(", ")}.` : "";
      const watchLabel = watchNext.length ? ` Watch next: ${watchNext.join("; ")}.` : "";
      return {
        label: aiStepLabel,
        status: statusLabel,
        detail: marketObservation
          ? `${marketReadThesis || summary} This is market context, not a directional trade call yet.${reviewScope}${missingLabel}${watchLabel}${repeatedLabel}`
          : noTradeCall
          ? `${marketReadThesis || summary} The review covered price, news, calendar, sensors, and history, but did not publish a current market conclusion. Confidence: ${confidenceLabel}.${reviewScope}${missingLabel}${watchLabel}${repeatedLabel}`
          : `${marketReadThesis || summary} Main driver: ${driverLabel}. Cause status: ${causeLabel}. Confidence: ${confidenceLabel}.${reviewScope}${watchLabel}${repeatedLabel}`,
        meta: [
          `run_started_at: ${runStartedAt}`,
          `type: ${engine}`,
          `status: ${llmStatus}`,
          `result: ${displayResult}`,
          `market_read_status: ${marketReadStatus || "not recorded"}`,
          `confidence: ${confidence}`,
          `repeat_count: ${repeatCount}`,
          `oldest_run_started_at: ${oldestRunStartedAt}`,
          `latest_news: ${compactListText(latestNews)}`,
          `missing: ${compactListText(missingInputs)}`,
          `watch_next: ${compactListText(watchNext)}`,
          `monitor_run_id: ${firstText(row.monitor_run_id, "not recorded")}`,
          "history: analysis_results"
        ],
        tone: llmStatus === "validated" ? "ai" : "muted"
      };
    });
};

const suppressionReason = (alert: Record<string, unknown>, monitorRun: Record<string, unknown>, analysisResult: Record<string, unknown>) =>
  firstText(
    alert.reason,
    alert.suppression_reason,
    alert.notification_reason,
    monitorRun.alert_suppressed_reason,
    monitorRun.detail,
    analysisResult.notification_reason,
    analysisResult.suppression_reason,
    "No notification was sent because policy/evidence gates did not approve a user alert."
  );

const outputHistoryItems = (
  alerts: Record<string, unknown>[],
  monitorRun: Record<string, unknown>,
  analysisResult: Record<string, unknown>,
  replayPayload: MarketAgentReplayPayload | undefined
): SignalDecisionTraceItem[] => {
  const sentAlerts = alerts.filter((alert) => alert.should_notify === true || alert.shouldNotify === true);
  const suppressedAlerts = ((replayPayload?.suppressed_alerts ?? []) as Record<string, unknown>[]).filter(Boolean);
  const remainingAlerts = alerts.filter((alert) => alert.should_notify !== true && alert.shouldNotify !== true);
  const auditAlerts = [...sentAlerts, ...remainingAlerts, ...suppressedAlerts].filter(
    (alert, index, allAlerts) => {
      const key = [
        firstText(alert.monitor_run_id, "no-run"),
        firstText(alert.run_started_at, "no-time"),
        firstText(alert.message, alert.title, alert.summary, "no-message")
      ].join("|");
      return allAlerts.findIndex((candidate) => {
        const candidateKey = [
          firstText(candidate.monitor_run_id, "no-run"),
          firstText(candidate.run_started_at, "no-time"),
          firstText(candidate.message, candidate.title, candidate.summary, "no-message")
        ].join("|");
        return candidateKey === key;
      }) === index;
    }
  );

  if (!auditAlerts.length) {
    return [
      {
        label: "Notification audit",
        status: "no candidate",
        detail: "No alert candidate was recorded for this selected run/range.",
        meta: ["history: alerts", "surface: Activity audit only"],
        tone: "muted"
      }
    ];
  }

  return auditAlerts.map((alert, index): SignalDecisionTraceItem => {
    const sent = alert.should_notify === true || alert.shouldNotify === true;
    const message = firstText(alert.message, alert.title, alert.summary, analysisResult.summary, "No alert message text recorded.");
    return {
      label: sent ? "Notification sent" : "Notification suppressed",
      status: sent ? "sent" : "suppressed",
      detail: sent
        ? `Sent candidate: ${shortHistoryText(message)}`
        : `Suppressed candidate: ${shortHistoryText(message)} Reason: ${shortHistoryText(suppressionReason(alert, monitorRun, analysisResult))}`,
      meta: [
        `run: ${firstText(alert.monitor_run_id, monitorRun.id, monitorRun.monitor_run_id, "not recorded")}`,
        `level: ${firstText(alert.notification_level, alert.level, "not recorded")}`,
        `created_at: ${firstText(alert.run_started_at, monitorRun.run_started_at, "not recorded")}`,
        "history: alerts",
        "surface: Activity audit only"
      ],
      tone: sent ? "good" : "working"
    };
  });
};

const suppressionAuditRows = (
  alerts: Record<string, unknown>[],
  monitorRun: Record<string, unknown>,
  analysisResult: Record<string, unknown>,
  replayPayload: MarketAgentReplayPayload | undefined
): SignalDrilldownRow[] =>
  outputHistoryItems(alerts, monitorRun, analysisResult, replayPayload).map((item) => ({
    label: item.label,
    status: item.status,
    detail: item.detail,
    meta: item.meta
  }));

const buildDecisionTrace = ({
  selectedEvidence,
  replayPayload,
  analysisResult,
  evidencePacket,
  llmEntry,
  llmPerformance
}: {
  selectedEvidence: MarketAgentEvidenceForRunResponse | null;
  replayPayload: MarketAgentReplayPayload | undefined;
  analysisResult: Record<string, unknown>;
  evidencePacket: Record<string, unknown> | undefined;
  llmEntry: Record<string, unknown> | undefined;
  llmPerformance: SignalPerformanceSummary;
}): SignalDecisionTrace => {
  const monitorRun = (selectedEvidence?.payload?.monitor_run ?? {}) as Record<string, unknown>;
  const selectedAlerts = recordListValue(selectedEvidence?.payload, "alerts");
  const replayAlerts = ((replayPayload?.alerts ?? []) as Record<string, unknown>[]).filter(Boolean);
  const alerts = selectedAlerts.length ? selectedAlerts : replayAlerts;
  const stateTransition = (selectedEvidence?.payload?.state_transition ?? {}) as Record<string, unknown>;
  const hasStateTransition = Object.keys(stateTransition).length > 0;
  const newsItems = ((replayPayload?.news_items ?? []) as Record<string, unknown>[]).filter(Boolean);
  const calendarEvents = ((replayPayload?.calendar_events ?? []) as Record<string, unknown>[]).filter(Boolean);
  const relatedAssets = replayPayload?.related_assets ?? {};
  const relatedAssetCount = Object.values(relatedAssets).reduce((total, rows) => total + (Array.isArray(rows) ? rows.length : 0), 0);
  const causeStatus = firstText(analysisResult.cause_status, "unknown");
  const runStartedAt = firstText(monitorRun.run_started_at, selectedEvidence?.monitor_run_id ? `run #${selectedEvidence.monitor_run_id}` : "");
  const runLabel = runStartedAt || "Selected run";
  const storedAiItems = storedAiHistoryItems(selectedEvidence);
  const telemetryAiItems = aiHistoryItems(llmEntry);
  const summary = storedAiItems.length
    ? `Showing ${storedAiItems.length} stored Local AI validated analysis result(s) from analysis_results. Current-run telemetry is shown only when stored history is unavailable.`
    : "This is a Local AI call audit for the selected run. Cause review, display summary, alert review, and other AI tasks can complete or fail independently.";
  const aiItems = storedAiItems.length ? storedAiItems : telemetryAiItems;

  return {
    runLabel,
    summary,
    status: causeStatus,
    performance: llmPerformance,
    items: aiItems,
    records: [
      {
        label: "Input history",
        status: newsItems.length || calendarEvents.length || relatedAssetCount ? "recorded" : "empty",
        detail: `${newsItems.length} news item(s), ${calendarEvents.length} calendar event(s), ${relatedAssetCount} asset sensor row(s).`,
        meta: ["news_items", "calendar context", "market_price_bars / related_asset_bars"],
        tone: newsItems.length || calendarEvents.length || relatedAssetCount ? "store" : "muted"
      },
      {
        label: "AI decisions",
        status: evidencePacket || Object.keys(analysisResult).length ? "stored" : "missing",
        detail: "Evidence gates and final analysis are stored so the AI/rule decision can be inspected later.",
        meta: ["evidence_packets", "analysis_results", hasStateTransition ? "state transition recorded" : "state transition not recorded"],
        tone: evidencePacket || Object.keys(analysisResult).length ? "store" : "bad"
      },
      {
        label: "User-facing history",
        status: alerts.length ? "recorded" : "not sent",
        detail: "Replay rows, dashboard evidence, and Telegram decisions are built only after validation.",
        meta: ["timeline_events", "month_summary_events", "alerts"],
        tone: "store"
      }
    ]
  };
};

const newsFeedRows = (
  configuredFeeds: string[],
  newsHealth: MarketAgentProviderHealthEntry | undefined,
  stats: ReturnType<typeof replayStats>
): SignalDrilldownRow[] => {
  const feedDiagnostics = recordListValue(newsHealth?.metadata, "feeds");
  if (feedDiagnostics.length) {
    return feedDiagnostics.map((feed) => {
      const label = newsFeedLabel(textValue(feed, "feed_url") || textValue(feed, "source") || "RSS feed");
      const status = textValue(feed, "status") || "checked";
      const headlineCount = numberValue(feed, "headline_count") ?? 0;
      const includedCount = numberValue(feed, "included_count") ?? 0;
      const latency = numberValue(feed, "latency_ms");
      return {
        label,
        status,
        detail: textValue(feed, "reason") || `${headlineCount} headline(s), ${includedCount} included after scoring.`,
        meta: [
          "provider: RSSNewsProvider",
          `source: ${textValue(feed, "feed_url") || label}`,
          `headlines: ${headlineCount}`,
          `included: ${includedCount}`,
          latency === null ? "latency: not recorded" : `latency: ${latency}ms`,
          `stored: ${stats.newsRows} row(s) in selected replay payload`
        ]
      };
    });
  }
  const rawSources = splitSourceList(newsHealth?.raw_source_id);
  const rawLabels = new Set(rawSources.map(newsFeedLabel));
  const feedLabels = Array.from(new Set(configuredFeeds.length ? configuredFeeds : defaultNewsFeeds));
  return feedLabels.map((label) => {
    const knownUrl = defaultNewsFeedUrls.find((url) => newsFeedLabel(url) === label);
    const rawSource = rawSources.find((source) => newsFeedLabel(source) === label) || knownUrl || label;
    const isReported = rawLabels.has(label);
    const status = newsHealth?.is_available && isReported ? "available" : "configured";
    const detail =
      status === "available"
        ? "This feed was reported by the RSS provider for the selected run."
        : "Configured feed. The selected run did not report a usable headline from this individual feed.";
    return {
      label,
      status,
      detail,
      meta: [
        "provider: RSSNewsProvider",
        `source: ${rawSource}`,
        "storage: news_items",
        `used_by: raw capture, dedupe, source scoring, theme extraction`,
        `why: ${stats.newsRows ? `${stats.newsRows} headline row(s) in selected replay payload.` : "No raw headline rows in selected replay payload."}`
      ]
    };
  });
};

const rawNewsRows = (items: Record<string, unknown>[]): SignalDrilldownRow[] => {
  if (!items.length) {
    return [
      {
        label: "No headlines captured",
        status: "empty",
        detail: "No raw news rows are available in the selected replay payload.",
        meta: ["storage: news_items"]
      }
    ];
  }
  return compactNewsItems(items).slice(0, 20).map((item, index) => {
    const title = firstText(item.title, item.summary_title, `Headline ${index + 1}`);
    const summarySource = firstText(item.summary_source, item.ai_summary_source);
    const included = item.included === true || normalizeMarketAgentValue(item.review_status).includes("included");
    const filtered = item.included === false || normalizeMarketAgentValue(item.review_status).includes("filtered");
    const seenCount = newsSeenCount(item);
    const fetchedAt = firstText(item.fetched_at, item.last_seen_at, item.first_seen_at, "not recorded");
    const status = summarySource
      ? "summarized"
      : included
        ? "included"
        : filtered
          ? "filtered"
          : "raw captured";
    const preview = firstText(
      item.summary,
      item.short_summary,
      item.preview,
      item.description,
      item.content,
      item.raw_text,
      ""
    );
    const filterExplanation = filtered ? newsFilterExplanation(item.filter_reason || item.reason) : "";
    const detail = [preview, filterExplanation].filter(Boolean).join(" ");
    return {
      label: shortHistoryText(title, `Headline ${index + 1}`),
      status,
      detail: seenCount > 1
        ? `${detail || "No body or summary was recorded for this item."} Captured ${seenCount} times; History shows one merged row using the latest fetch timestamp.`
        : detail,
      meta: [
        `source: ${firstText(item.source, "not recorded")}`,
        `published_at: ${firstText(item.published_at, "not recorded")}`,
        `fetched_at: ${fetchedAt}`,
        ...(seenCount > 1 ? [`fetches: ${seenCount}`] : []),
        ...(seenCount > 1 ? [`first_seen_at: ${firstText(item.first_seen_at, "not recorded")}`] : []),
        ...(seenCount > 1 ? [`last_seen_at: ${firstText(item.last_seen_at, fetchedAt, "not recorded")}`] : []),
        ...(firstText(item.link) ? [`link: ${firstText(item.link)}`] : []),
        ...(filterExplanation ? [`filter: ${filterExplanation}`] : []),
        `summary_source: ${summarySource || "not recorded"}`,
        `evidence: ${firstText(item.evidence_status, item.review_status, item.data_mode, "not recorded")}`,
        "storage: news_items"
      ]
    };
  });
};

const calendarContextRows = (items: Record<string, unknown>[]): SignalDrilldownRow[] => {
  if (!items.length) {
    return [
      {
        label: "No calendar context",
        status: "empty",
        detail: "No existing Economic Calendar rows are available in the selected replay payload.",
        meta: ["source: existing Economic Calendar"]
      }
    ];
  }
  return items.slice(0, 20).map((item, index) => {
    const title = firstText(item.title, item.event_name, item.name, `Calendar event ${index + 1}`);
    const reviewStatus = firstText(item.review_status, item.evidence_status, item.data_mode, "context");
    return {
      label: shortHistoryText(title, `Calendar event ${index + 1}`),
      status: reviewStatus,
      detail: firstText(item.summary, item.result, item.reason, item.description, "Calendar context row from the existing Economic Calendar."),
      meta: [
        `source: ${firstText(item.source, "existing Economic Calendar")}`,
        `scheduled_at: ${firstText(item.scheduled_at, item.event_time, "not recorded")}`,
        `country: ${firstText(item.country, "not recorded")}`,
        `currency: ${firstText(item.currency, "not recorded")}`,
        `impact: ${firstText(item.impact, "not recorded")}`,
        `window: ${firstText(item.window, item.context_type, "not recorded")}`
      ]
    };
  });
};

const normalizeStorageLabel = (value: string) => value.replace(/_/g, " ");

const sensorDefinitions = [
  { id: "xauusd", label: "XAUUSD", group: "Primary price", source: "cTrader spot / GC=F proxy", storage: "market_price_bars" },
  { id: "dxy", label: "DXY", group: "USD pressure", source: "DX-Y.NYB", storage: "related_asset_bars" },
  { id: "us10y", label: "US10Y", group: "Rates / yields", source: "^TNX", storage: "related_asset_bars" },
  { id: "us2y", label: "US2Y", group: "Rates / yields", source: "Dedicated yield source when available", storage: "related_asset_bars" },
  { id: "wti", label: "WTI", group: "Oil / inflation", source: "CL=F", storage: "related_asset_bars" },
  { id: "brent", label: "Brent", group: "Oil / inflation", source: "BZ=F", storage: "related_asset_bars" },
  { id: "vix", label: "VIX", group: "Risk sentiment", source: "^VIX", storage: "related_asset_bars" },
  { id: "spx", label: "S&P 500", group: "Risk sentiment", source: "^GSPC", storage: "related_asset_bars" },
  { id: "nasdaq", label: "Nasdaq", group: "Risk sentiment", source: "^IXIC", storage: "related_asset_bars" }
];

const node = (input: Omit<SignalNode, "tone"> & { tone?: SignalTone }): SignalNode => ({
  tone: input.tone ?? statusTone(input.status),
  ...input
});

const asRecordList = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : []);

const monthLabels = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad2 = (value: number) => String(value).padStart(2, "0");

const readableDateTime = (value: unknown) => {
  if (typeof value !== "string" || !value.trim()) return "not recorded";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return `${pad2(parsed.getDate())} ${monthLabels[parsed.getMonth()]} ${parsed.getFullYear()} ${pad2(parsed.getHours())}:${pad2(parsed.getMinutes())} ${formatUtcOffset(getSystemUtcOffsetMinutes(parsed.getTime()))}`;
};

const timestampMs = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1_000_000_000_000 ? value * 1000 : value;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
};

const isExpiredLiveSpot = (health: MarketAgentProviderHealthEntry | undefined, nowMs = Date.now()) => {
  if (
    !health?.is_available ||
    health.is_stale ||
    normalizeMarketAgentValue(health.source_type) !== "spot" ||
    normalizeMarketAgentValue(health.data_mode) !== "live_seen"
  ) {
    return false;
  }
  const fetchedAt = timestampMs(health.fetched_at);
  const dataTimestamp = timestampMs(health.data_timestamp ?? health.fetched_at);
  if (fetchedAt === null || dataTimestamp === null) return true;
  return nowMs - fetchedAt > 300_000 || fetchedAt - dataTimestamp > 3_600_000;
};

const isMarketClosedSnapshot = (health: MarketAgentProviderHealthEntry | undefined) =>
  Boolean(
    health?.is_available &&
      (health.is_stale || normalizeMarketAgentValue(health.data_mode) === "stale" || isExpiredLiveSpot(health)) &&
      ["spot", "spot_snapshot"].includes(normalizeMarketAgentValue(health.source_type)) &&
      !isSavedCTraderSnapshot(health) &&
      hasMarketClosedReason(health) &&
      typeof health.current_value === "number" &&
      Number.isFinite(health.current_value)
  );

const isStaleLiveSpotSnapshot = (health: MarketAgentProviderHealthEntry | undefined, nowMs = Date.now()) =>
  Boolean(
    health?.is_available &&
      (health.is_stale || normalizeMarketAgentValue(health.data_mode) === "stale" || isExpiredLiveSpot(health, nowMs)) &&
      ["spot", "spot_snapshot"].includes(normalizeMarketAgentValue(health.source_type)) &&
      !isMarketClosedSnapshot(health) &&
      !isSavedCTraderSnapshot(health) &&
      typeof health.current_value === "number" &&
      Number.isFinite(health.current_value)
  );

const isSavedCTraderSnapshot = (health: MarketAgentProviderHealthEntry | undefined) =>
  Boolean(
    health?.is_available &&
      ["spot", "spot_snapshot"].includes(normalizeMarketAgentValue(health.source_type)) &&
      (
        normalizeMarketAgentValue(health.data_mode) === "snapshot" ||
        normalizeMarketAgentValue(health.source_type) === "spot_snapshot" ||
        normalizeMarketAgentValue(health.stale_reason).includes("saved ctrader quote snapshot")
      )
  );

const hasMarketClosedReason = (health: MarketAgentProviderHealthEntry | undefined) => {
  const reason = String(health?.stale_reason || health?.error || "").toLowerCase();
  return /market\s+(is\s+)?closed|market\s+reopens/.test(reason);
};

const healthFreshness = (health: MarketAgentProviderHealthEntry | undefined) => {
  if (!health) return "not recorded";
  if (!health.is_available || normalizeMarketAgentValue(health.source_type) === "unavailable") return "unavailable";
  if (isMarketClosedSnapshot(health)) return "market closed";
  if (isStaleLiveSpotSnapshot(health) || isExpiredLiveSpot(health)) return "stale";
  if (health.is_stale) return "stale";
  return "fresh";
};

const requestFromHealth = (sensorLabel: string, health: MarketAgentProviderHealthEntry | undefined): SignalDataRequest | null => {
  if (!health) {
    return {
      target: sensorLabel,
      status: "watching",
      requestedBy: "Provider health",
      reason: "No provider status has been recorded for this sensor in the current payload.",
      mode: "provider mapping"
    };
  }
  if (!health.is_available || normalizeMarketAgentValue(health.source_type) === "unavailable") {
    return {
      target: sensorLabel,
      status: "unavailable",
      requestedBy: "Evidence gate",
      reason: providerGuidance(health),
      mode: health.data_mode || "unavailable"
    };
  }
  if (health.is_stale) {
    return {
      target: sensorLabel,
      status: "stale",
      requestedBy: "Freshness check",
      reason: health.stale_reason || "The latest value is stale and cannot confirm a fresh move.",
      mode: health.data_mode || "refresh"
    };
  }
  if (isExpiredLiveSpot(health)) {
    return {
      target: sensorLabel,
      status: "stale",
      requestedBy: "Freshness check",
      reason: "The last cTrader quote snapshot is available, but it is not a fresh live quote.",
      mode: "quote snapshot"
    };
  }
  return null;
};

export const buildSignalMapModel = ({
  monitorStatus,
  liveQuote,
  providerHealth,
  replay,
  selectedEvidence,
  providerConfig,
  telegramConfig,
  llmConfig
}: BuildSignalMapArgs): SignalMapModel => {
  const activityIsStale = monitorStatus?.activityStale === true;
  const activity = activityIsStale ? {} : (monitorStatus?.activity ?? {});
  const cTraderEntry = activity.ctrader;
  const historyEntry = activity.history;
  const contextEntry = activity.context;
  const evidenceEntry = activity.evidence;
  const llmEntry = activity.llm;
  const replayEntry = activity.replay;
  const alertEntry = activity.alerts;
  const summaryEntry = activity.summary;
  const selfAudit = monitorStatus?.selfAudit ?? null;
  const selfAuditChecks = asRecordList(selfAudit?.checks);
  const selfAuditStatus = String(selfAudit?.status || "").trim();
  const selfAuditSummary = String(selfAudit?.summary || "").trim();
  const payload = replay?.replay;
  const stats = replayStats(payload);
  const selectedEvidencePacket = selectedEvidence?.payload?.evidence_packet as Record<string, unknown> | undefined;
  const evidenceChain = selectedEvidencePacket?.evidence_chain_status as Record<string, unknown> | undefined;
  const selectedProviderHealth = asRecordList(selectedEvidence?.payload?.provider_health) as MarketAgentProviderHealthEntry[];
  const healthItems = providerHealth?.items?.length ? providerHealth.items : selectedProviderHealth;
  const driverStates = asRecordList(selectedEvidence?.payload?.driver_attention_states);
  const analysisResult = (selectedEvidence?.payload?.analysis_result ?? {}) as Record<string, unknown>;
  const storageSummary = recordValue(replayEntry, "storageSummary");
  const storageCounts = recordValue(storageSummary, "counts");
  const fallbackXauusdHealth = findProviderHealth(healthItems, ["xauusd", "gc=f", "xauusd price"]);
  const xauusdHealth = liveQuote?.provider_health
    ? ({ ...fallbackXauusdHealth, ...liveQuote.provider_health } as MarketAgentProviderHealthEntry)
    : fallbackXauusdHealth;
  const newsHealth = findProviderHealth(healthItems, ["news", "rss", "rss_provider"]);
  const configuredNewsFeeds = newsFeedSources(contextEntry, newsHealth);
  const newsSourceLabel = newsFeedSourceSummary(configuredNewsFeeds);
  const cTraderLive = Boolean(xauusdHealth?.is_available && !xauusdHealth.is_stale && !isExpiredLiveSpot(xauusdHealth));
  const xauusdStatusSummary = isMarketClosedSnapshot(xauusdHealth)
    ? { status: "market closed", action: "Market closed snapshot", detail: "Last market-closed cTrader spot snapshot is stored." }
    : cTraderLive
      ? { status: "live", action: "Fresh live quote", detail: "Fresh cTrader spot quote is flowing into Market Agent." }
      : isSavedCTraderSnapshot(xauusdHealth)
        ? { status: "connecting", action: "Connecting live quote", detail: "Saved cTrader snapshot is visible while the live stream reconnects." }
        : isStaleLiveSpotSnapshot(xauusdHealth) || isExpiredLiveSpot(xauusdHealth, Date.now())
          ? { status: "reconnecting", action: "Reconnecting live quote", detail: "Last live cTrader quote is stored while the stream reconnects." }
          : providerConfig?.ctrader?.enabled
            ? { status: "checking", action: "Checking live quote", detail: "Waiting for the first fresh cTrader spot quote." }
            : { status: "waiting", action: "Connect cTrader", detail: "Live cTrader spot is not configured yet." };
  const cTraderStatus =
    textValue(cTraderEntry, "status") ||
    (isMarketClosedSnapshot(xauusdHealth) ? "market closed" : cTraderLive ? "live" : providerConfig?.ctrader?.enabled ? "checking" : "waiting");
  const historyStatus = textValue(historyEntry, "status") || (monitorStatus?.running ? "syncing" : "idle");
  const contextStatus = textValue(contextEntry, "status") || (stats.newsRows || stats.calendarRows ? "active" : "collecting");
  const evidenceStatus = textValue(evidenceEntry, "status") || String(evidenceChain?.status || "pending");
  const llmStatus = textValue(llmEntry, "status") || (llmConfig?.llm?.enabled ? "queued" : "skipped");
  const llmPerformance = llmTelemetrySummary(llmEntry);
  const decisionTrace = buildDecisionTrace({
    selectedEvidence,
    replayPayload: payload,
    analysisResult,
    evidencePacket: selectedEvidencePacket,
    llmEntry,
    llmPerformance
  });
  const replayStatus = textValue(replayEntry, "status") || (stats.timelineEvents ? "stored" : "pending");
  const alertStatus = textValue(alertEntry, "status") || (telegramConfig?.telegram?.enabled ? "ready" : "idle");
  const phaseLabel = humanizeMarketAgentValue(monitorStatus?.phase || (monitorStatus?.running ? "running" : "stopped"));
  const latestStoredRunLabel = monitorStatus?.latestStoredRunAt
    ? readableDateTime(monitorStatus.latestStoredRunAt)
    : monitorStatus?.latestMonitorRunId
      ? `run #${monitorStatus.latestMonitorRunId}`
      : "available";
  const phaseMessage = activityIsStale
    ? `${monitorStatus?.message || "Monitor loop is stopped."} Latest stored run is ${latestStoredRunLabel}; current signal rows use latest provider health, replay, and evidence instead of the stale activity snapshot.`
    : selfAuditSummary || monitorStatus?.message || (monitorStatus?.running ? "Market radar is active between analysis passes." : "Agent is idle.");
  const historyProgress = numberValue(historyEntry, "progress");
  const packetAllowedDrivers = listValue(selectedEvidencePacket, "allowed_candidate_drivers");
  const activityAllowedDrivers = listValue(evidenceEntry, "allowedCandidateDrivers");
  const allowedDrivers = packetAllowedDrivers.length ? packetAllowedDrivers : activityAllowedDrivers;
  const packetBlockedDrivers = recordValue(selectedEvidencePacket, "blocked_drivers");
  const activityBlockedDrivers = recordValue(evidenceEntry, "blockedDrivers");
  const blockedDrivers = Object.keys(packetBlockedDrivers).length ? packetBlockedDrivers : activityBlockedDrivers;
  const selectedAlerts = recordListValue(selectedEvidence?.payload, "alerts");
  const replayAlerts = ((payload?.alerts ?? []) as Record<string, unknown>[]).filter(Boolean);
  const auditAlerts = selectedAlerts.length ? selectedAlerts : replayAlerts;
  const jobRows = (entry: Record<string, unknown> | undefined, fallbackTitle: string): SignalDrilldownRow[] => {
    const jobs = asRecordList(entry?.jobs);
    if (!jobs.length) {
      return [
        {
          label: fallbackTitle,
          status: textValue(entry, "status") || "not recorded",
          detail: userFacingActivityText(textValue(entry, "detail"), "No detailed activity jobs were recorded for this step."),
          meta: [
            `input: ${userFacingActivityText(textValue(entry, "input"), "not recorded")}`,
            `output: ${userFacingActivityText(textValue(entry, "output"), "not recorded")}`
          ]
        }
      ];
    }
    return jobs.map((job) => ({
      label: textValue(job, "title") || fallbackTitle,
      status: textValue(job, "status") || "recorded",
      detail: userFacingActivityText(textValue(job, "detail"), "Step was recorded in the monitor activity snapshot."),
      meta: [
        `input: ${userFacingActivityText(textValue(job, "input"), "not recorded")}`,
        `output: ${userFacingActivityText(textValue(job, "output"), "not recorded")}`,
        `time: ${readableDateTime(job.timestamp)}`
      ]
    }));
  };
  const cTraderRows = (): SignalDrilldownRow[] => {
    const rows = jobRows(cTraderEntry, "Live quote request");
    const hasRecordedJobs = asRecordList(cTraderEntry?.jobs).length > 0;
    const latestReplayPriceRow = payload?.price_series?.[payload.price_series.length - 1] as Record<string, unknown> | undefined;
    const livePriceValue =
      typeof xauusdHealth?.current_value === "number" && Number.isFinite(xauusdHealth.current_value)
        ? xauusdHealth.current_value
        : numberValue(latestReplayPriceRow, "close_price") ?? numberValue(latestReplayPriceRow, "bid_price") ?? numberValue(latestReplayPriceRow, "ask_price");
    const runtimeHealthWins =
      Boolean(
        xauusdHealth?.is_available &&
        !xauusdHealth.is_stale &&
        !isExpiredLiveSpot(xauusdHealth) &&
        livePriceValue !== null
      );
    const runtimeReconnecting =
      Boolean(
        xauusdHealth?.is_available &&
        (isStaleLiveSpotSnapshot(xauusdHealth) || isExpiredLiveSpot(xauusdHealth)) &&
        livePriceValue !== null
      );
    if (!runtimeHealthWins && !runtimeReconnecting && (hasRecordedJobs || !xauusdHealth?.is_available || livePriceValue === null)) {
      return rows;
    }
    const status = isMarketClosedSnapshot(xauusdHealth)
      ? "market closed"
      : runtimeHealthWins
        ? "live"
        : runtimeReconnecting
          ? "reconnecting"
          : isSavedCTraderSnapshot(xauusdHealth)
            ? "connecting"
            : "snapshot";
    return [
      {
        label: isMarketClosedSnapshot(xauusdHealth)
          ? "Last quote snapshot"
          : runtimeReconnecting
            ? "Last live quote"
            : "Latest live quote",
        status,
        detail: isMarketClosedSnapshot(xauusdHealth)
          ? `Last quote ${livePriceValue}. cTrader returned a price snapshot while the market is closed. This is a display snapshot, not a fresh live tick.`
          : runtimeHealthWins
            ? `Latest quote ${livePriceValue}. cTrader provider health confirms a fresh live quote, so this step follows the current runtime status instead of an older monitor activity snapshot.`
            : runtimeReconnecting
              ? `Stored quote ${livePriceValue}. cTrader provider health shows the last quote is stale, so the stream is reconnecting while the previous live value stays visible.`
              : isSavedCTraderSnapshot(xauusdHealth)
                ? `Saved quote ${livePriceValue}. cTrader is connecting to the live stream and only a saved snapshot is available right now.`
            : `Latest quote ${livePriceValue}. cTrader provider health has a quote snapshot, but the monitor activity job did not record a live ingest step.`,
        meta: [
          `price: ${livePriceValue}`,
          `source: ${providerLabel(xauusdHealth, "cTrader")}`,
          `mode: ${xauusdHealth.data_mode || "not recorded"}`,
          `data_timestamp: ${readableDateTime(xauusdHealth.data_timestamp)}`,
          `fetched_at: ${readableDateTime(xauusdHealth.fetched_at)}`,
          `storage: provider_health`
        ]
      }
    ];
  };
  const storagePath =
    textValue(replayEntry, "timelineStorePath") ||
    String(storageSummary.path || "") ||
    replay?.timeline_store_path ||
    selectedEvidence?.timeline_store_path ||
    "TimelineStore not loaded";

  const evidenceStatusMap = recordValue(selectedEvidencePacket, "evidence_status");
  const crossAssetConfirmation = recordValue(selectedEvidencePacket, "cross_asset_confirmation");
  const sensorRequests: SignalDataRequest[] = [];
  const coreSensors = sensorDefinitions.map((sensor) => {
    const row = sensor.id === "xauusd" ? payload?.price_series?.[payload.price_series.length - 1] : latestRelatedAsset(payload, sensor.id);
    const health = findProviderHealth(healthItems, [sensor.id, sensor.label]);
    const healthRequest = requestFromHealth(sensor.label, health);
    if (healthRequest) sensorRequests.push(healthRequest);
    const evidenceState = String(evidenceStatusMap[sensor.id] || crossAssetConfirmation[sensor.id] || "");
    const healthStatus = isMarketClosedSnapshot(health)
      ? "market closed"
      : health?.is_stale || isExpiredLiveSpot(health)
        ? "stale"
        : health?.is_available
          ? "available"
          : health
            ? "unavailable"
            : "waiting";
    const status =
      evidenceState ||
      (sensor.id === "xauusd" && ["market closed", "stale"].includes(healthStatus)
        ? healthStatus
        : row
          ? String(row.data_mode || "live")
          : healthStatus);
    const requestedBy = sensor.id === "xauusd" ? "Move detection" : sensor.group.includes("Rates") ? "Yields driver / evidence gate" : sensor.group.includes("Oil") ? "Theme discovery / inflation channel" : "Driver attention";
    const usedBy = sensor.id === "xauusd" ? "Move detection, evidence gate, replay, alerts" : "Driver attention, evidence gate, Latest Evidence";
    return node({
      id: `sensor-${sensor.id}`,
      label: sensor.label,
      lane: "Market Sensors",
      group: sensor.group,
      status,
      action: `${sensor.group}: ${assetValue(row)}`,
      source: row ? String(row.source || sensor.source) : providerLabel(health, sensor.source),
      processing: "Compare sensor move with XAUUSD direction, then mark confirming, contradicting, not confirming, stale, or unavailable.",
      output: "Evidence gate + Driver Attention + Latest Evidence + Replay",
      storage: [sensor.storage],
      ai: "Display summarizer can compress this row for Latest Evidence; cause review consumes the bounded evidence packet.",
      trace: [`sensor-${sensor.id}`, "sensor-confirmation", "evidence-gate", "driver-attention", "evidence-packet", "latest-evidence", "replay-output", "storage-raw"],
      detail: `${sensor.label} is a ${sensor.group} sensor. It is not a cause by itself; it confirms or challenges an XAUUSD explanation.`,
      badges: [
        { label: healthFreshness(health), tone: statusTone(healthFreshness(health)) },
        { label: String(health?.data_mode || row?.data_mode || "mode unknown"), tone: statusTone(String(health?.data_mode || row?.data_mode || "")) },
        { label: row ? "stored" : "not stored in range", tone: row ? "store" : "muted" }
      ],
      drilldown: [
        {
          title: "Sensor trace",
          detail: "Asset sensors stay inside the Assets source group. They are collected, checked for freshness, stored, then used only if evidence gates allow it.",
          rows: [
            {
              label: sensor.label,
              status,
              detail: providerGuidance(health),
              meta: [
                `provider: ${providerLabel(health, sensor.source)}`,
                `source_type: ${health?.source_type || "unknown"}`,
                `mode: ${health?.data_mode || String(row?.data_mode || "not recorded")}`,
                `data_timestamp: ${readableDateTime(health?.data_timestamp || row?.timestamp || row?.time)}`,
                `fetched_at: ${readableDateTime(health?.fetched_at)}`,
                `storage: ${row ? sensor.storage : "not stored in selected range"}`,
                `requested_by: ${requestedBy}`,
                `used_by: ${usedBy}`
              ]
            }
          ]
        }
      ],
      requests: healthRequest ? [healthRequest] : []
    });
  });

  const candidateNames = Array.from(new Set([...allowedDrivers, ...Object.keys(blockedDrivers)]))
    .filter((name) => !isUnknownDriver(name));
  const candidateSensors = (candidateNames.length ? candidateNames : ["geopolitics", "liquidity"]).slice(0, 6).map((name) =>
    node({
      id: `candidate-${normalizeMarketAgentValue(name)}`,
      label: humanizeMarketAgentValue(name),
      lane: "Candidate Sensors",
      status: blockedDrivers[name] ? "guarded" : "watching",
      action: blockedDrivers[name] ? "Guarded by evidence gate" : "Watching evidence",
      source: "Driver Attention, news grouping, evidence gate, or AI review",
      processing: "Track whether a possible driver has enough observed evidence or needs a provider mapping.",
      output: "Candidate driver gate",
      storage: ["driver_attention_states", "evidence_packets"],
      ai: "AI can flag unsupported plausible drivers, but guarded drivers cannot become causes.",
      trace: [`candidate-${normalizeMarketAgentValue(name)}`, "driver-attention", "candidate-gate", "evidence-packet"],
      detail: blockedDrivers[name] ? String(blockedDrivers[name]) : "Candidate sensor is watched because current context may require confirmation.",
      badges: [
        { label: blockedDrivers[name] ? "guarded" : "watching", tone: "working" },
        { label: "not active by default", tone: "muted" }
      ],
      drilldown: [
        {
          title: "Theme lifecycle",
          detail: "A candidate or emerging theme can request data, but it needs repeated evidence, fresh timestamps, source diversity, and market reaction before activation.",
          rows: [
            {
              label: humanizeMarketAgentValue(name),
              status: blockedDrivers[name] ? "guarded" : "watching",
              detail: blockedDrivers[name] ? String(blockedDrivers[name]) : "Watching for repeated evidence and cross-asset confirmation.",
              meta: ["state: observed/watching/emerging before active", "storage: driver_attention_states", "guard: evidence gate"]
            }
          ]
        }
      ],
      requests: blockedDrivers[name]
        ? [
            {
              target: humanizeMarketAgentValue(name),
              status: "guarded",
              requestedBy: "Driver attention",
              reason: String(blockedDrivers[name]),
              mode: "theme confirmation"
            }
          ]
        : [
            {
              target: humanizeMarketAgentValue(name),
              status: "watching",
              requestedBy: "Theme discovery",
              reason: "Watch this theme without promoting it to active until evidence persists.",
              mode: "priority watch"
            }
          ]
    })
  );

  const discoveredSensors = ["Geopolitical risk proxy", "Credit stress proxy", "Shipping / supply proxy"].map((label) =>
    node({
      id: `discovered-${normalizeMarketAgentValue(label)}`,
      label,
      lane: "Discovered Sensors",
      status: "unmapped",
      action: "Not monitored yet",
      source: "Repeated evidence can request this sensor",
      processing: "Visible gap state; does not pretend data exists.",
      output: "Provider mapping backlog",
      storage: ["evidence_packets"],
      ai: "AI may identify the gap, but the UI marks it as unmapped until a provider exists.",
      trace: [`discovered-${normalizeMarketAgentValue(label)}`, "candidate-gate"],
      detail: "Discovered sensors represent unknown or newly relevant drivers that need provider coverage.",
      badges: [
        { label: "unmapped", tone: "bad" },
        { label: "request only", tone: "working" }
      ],
      drilldown: [
        {
          title: "Discovered sensor request",
          detail: "Unknown themes stay visible as gaps. They do not become evidence until a reliable provider exists.",
          rows: [
            {
              label,
              status: "unmapped",
              detail: "Needs provider mapping, freshness policy, and evidence rules before it can influence conclusions.",
              meta: ["requested_by: theme discovery", "used_by: none yet", "storage: evidence_packets"]
            }
          ]
        }
      ],
      requests: [
        {
          target: label,
          status: "unmapped",
          requestedBy: "Theme discovery",
          reason: "Repeated evidence may require a new sensor, but the provider is not configured.",
          mode: "provider mapping"
        }
      ]
    })
  );

  const sourceLane: SignalLane = {
    id: "sources",
    title: "Signal Sources",
    detail: "Independent market feeds enter the system here.",
    nodes: [
      node({
        id: "price-source",
        label: "XAUUSD price",
        lane: "Signal Sources",
        status: xauusdStatusSummary.status || cTraderStatus,
        action: xauusdStatusSummary.detail,
        source: textValue(cTraderEntry, "source") || "cTrader",
        processing: "Live quote feeds move detection, evidence, replay, and alert preflight.",
        output: "Move detection + Evidence gate",
        storage: ["market_price_bars"],
        ai: "No AI at collection.",
        trace: ["price-source", "move-detection", "evidence-gate", "storage-raw"],
        detail: "Primary XAUUSD price signal from cTrader.",
        drilldown: [
          {
            title: "Live quote stream",
            detail: "This is the live quote path. It shows the current XAUUSD quote feed, not stored M1 bars.",
            rows: cTraderRows()
          }
        ]
      }),
      node({
        id: "history-source",
        label: "History",
        lane: "Signal Sources",
        status: historyStatus,
        action: historyProgress === null ? "Checking gaps" : `${Math.round(historyProgress)}% sync`,
        source: "cTrader history",
        processing: "Backfill fills replay and evidence gaps without blocking the live quote.",
        output: "Replay rows + TimelineStore",
        storage: ["market_price_bars", "related_asset_bars"],
        ai: "No AI at history fetch.",
        trace: ["history-source", "history-replay", "storage-raw", "replay-output"],
        detail: textValue(historyEntry, "detail") || "Historical rows support replay and gap recovery.",
        drilldown: [
          {
            title: "M1 history persistence",
            detail: "This is the stored M1/bar path used for replay and evidence windows. Recovered history does not become a live Telegram alert.",
            rows: jobRows(historyEntry, "History/backfill request")
          }
        ]
      }),
      node({
        id: "news-source",
        label: "News",
        lane: "Signal Sources",
        status: contextStatus,
        action: `${numberValue(contextEntry, "newsCount") ?? stats.newsRows} headline(s)`,
        source: newsSourceLabel,
        processing: "Relevance filtering and grouping before evidence can use a headline.",
        output: "News grouping + Evidence review",
        storage: ["news_items"],
        ai: "Display summarizer can shorten selected news rows.",
        trace: ["news-source", "news-grouping", "evidence-gate", "display-summarizer", "latest-evidence", "storage-raw"],
        detail: textValue(contextEntry, "detail") || "News rows provide event context and possible driver themes.",
        history: [
          {
            title: "Captured headlines",
            detail: "Headlines captured in this run/range. AI summaries appear only when a Local AI call actually processed the row.",
            rows: rawNewsRows(((payload?.news_items ?? []) as Record<string, unknown>[]).filter(Boolean))
          }
        ],
        drilldown: [
          {
            title: "Configured news feeds",
            detail: "News is collected from configured RSS feeds first. Headlines only become evidence after timestamp, dedupe, source scoring, relevance, and market-confirmation checks.",
            rows: newsFeedRows(configuredNewsFeeds, newsHealth, stats)
          },
          {
            title: "News coverage by day",
            detail: "Shows which days in the selected replay window have stored news rows and which days have no captured news.",
            rows: newsCoverageRows(((payload?.news_items ?? []) as Record<string, unknown>[]).filter(Boolean), replay)
          },
          {
            title: "News processing path",
            detail: "News starts raw, then becomes deduped, filtered/included, summarized, and finally an evidence candidate only when timestamps and relevance pass.",
            rows: [
              {
                label: "Raw capture",
                status: contextStatus,
                detail: stats.newsRows
                  ? `${stats.newsRows} raw headline row(s) are available in the selected replay payload.`
                  : "No raw headline rows are available in the selected replay payload.",
                meta: [`source: ${newsSourceLabel}`, `provider: ${providerLabel(newsHealth, "RSSNewsProvider")}`, "storage: news_items"]
              },
              {
                label: "Dedupe / source scoring",
                status: "checking",
                detail: "Repeated headlines and weak sources are handled before they can crowd Latest Evidence.",
                meta: ["state: filtered or included per row", "storage: news_items"]
              },
              {
                label: "Theme extraction",
                status: allowedDrivers.length || Object.keys(blockedDrivers).length ? "watching" : "waiting",
                detail: "Headlines can suggest themes, but a theme does not become active from one headline.",
                meta: [`allowed: ${allowedDrivers.join(", ") || "none"}`, `blocked: ${Object.keys(blockedDrivers).join(", ") || "none"}`]
              },
              {
                label: "Evidence candidate",
                status: evidenceStatus,
                detail: "Only relevant, timestamped, non-contradicted rows enter the evidence packet.",
                meta: ["handoff: evidence_packets", "display: Latest Evidence short summary"]
              }
            ]
          },
        ]
      }),
      node({
        id: "calendar-source",
        label: "Calendar",
        lane: "Signal Sources",
        status: contextStatus,
        action: `${numberValue(contextEntry, "calendarCount") ?? stats.calendarRows} event(s)`,
        source: "Existing Economic Calendar",
        processing: "Market Agent reads the app's existing Economic Calendar and aligns scheduled events to the current XAUUSD move window.",
        output: "Calendar context + Evidence review",
        storage: ["calendar context snapshot"],
        ai: "Display summarizer can shorten selected calendar rows.",
        trace: ["calendar-source", "calendar-context", "evidence-gate", "display-summarizer", "latest-evidence", "storage-raw"],
        detail: "Calendar rows come from the app's existing Economic Calendar and explain scheduled macro risk near the move.",
        drilldown: [
          {
            title: "Calendar event windows",
            detail: "Calendar data already exists in the app, so Market Agent does not fetch it again. The key work is timing: pre-risk, first reaction, and confirmation windows.",
            rows: [
              {
                label: "Read existing calendar",
                status: contextStatus,
                detail: `${stats.calendarRows} calendar event row(s) from the existing Economic Calendar are available in the selected replay payload.`,
                meta: ["source: existing Economic Calendar", "mode: read existing calendar context"]
              },
              {
                label: "Window alignment",
                status: "checking",
                detail: "Events are aligned to XAUUSD movement windows before they can explain a move.",
                meta: ["windows: pre-risk / first reaction / confirmation", "handoff: context gate"]
              },
              {
                label: "Evidence alignment",
                status: evidenceStatus,
                detail: "Actual/forecast/previous values support context when available; distant events stay background.",
                meta: ["handoff: evidence_packets", "display: Latest Evidence"]
              }
            ]
          },
          {
            title: "Calendar context rows",
            detail: "Existing Economic Calendar rows attached to this selected replay payload.",
            rows: calendarContextRows(((payload?.calendar_events ?? []) as Record<string, unknown>[]).filter(Boolean))
          }
        ]
      })
    ]
  };

  const processingLane: SignalLane = {
    id: "processing",
    title: "Processing Fabric",
    detail: "Signals are normalized, checked, gated, and converted into a bounded evidence packet.",
    nodes: [
      node({
        id: "move-detection",
        label: "Move detection",
        lane: "Processing Fabric",
        status: cTraderStatus,
        action: "Detecting XAUUSD move",
        source: "XAUUSD price + recent history",
        processing: "Measure the latest move window before asking what caused it.",
        output: "Evidence gate",
        storage: ["market_price_bars"],
        ai: "No AI.",
        trace: ["price-source", "move-detection", "evidence-gate"],
        detail: "Move detection decides whether the run has a meaningful XAUUSD move to explain."
      }),
      node({
        id: "sensor-confirmation",
        label: "Sensor confirmation",
        lane: "Processing Fabric",
        status: evidenceStatus,
        action: "Confirming cross-market signals",
        source: "Market Sensors + provider health",
        processing: "Classify DXY, yields, oil, and risk sentiment as confirming, contradicting, stale, unavailable, or background.",
        output: "Evidence gate + Driver Attention",
        storage: ["related_asset_bars", "evidence_packets"],
        ai: "No AI required; AI can later summarize the row.",
        trace: ["sensor-confirmation", "evidence-gate", "driver-attention"],
        detail: "This is where market sensors become usable evidence instead of loose context."
      }),
      node({
        id: "evidence-gate",
        label: "Evidence gate",
        lane: "Processing Fabric",
        status: evidenceStatus,
        action: userFacingActivityText(textValue(evidenceEntry, "detail"), "Checking usable inputs"),
        source: "Price, history, news, calendar, sensors",
        processing: "Decides what is usable, stale, blocked, or background.",
        output: "Driver Attention + Evidence review",
        storage: ["evidence_packets"],
        ai: "AI cannot bypass this gate.",
        trace: ["evidence-gate", "driver-attention", "evidence-packet", "storage-derived"],
        detail: userFacingActivityText(textValue(evidenceEntry, "label"), "Evidence readiness and blocking state."),
        drilldown: [
          {
            title: "Driver gate",
            detail: "Drivers listed here show what can be used now and what is blocked until its required evidence is fresh and confirming.",
            rows: [
              ...(
                allowedDrivers.length
                  ? allowedDrivers.map((label) => ({
                      label: humanizeMarketAgentValue(label),
                      status: "usable",
                      detail: "This driver passed the evidence gate for the current run.",
                      meta: [
                        "source: evidence gate",
                        "storage: evidence_packets",
                        "why: Required evidence is usable for this run.",
                        "used_by: Driver Attention + AI input guard"
                      ],
                      tone: "good"
                    }))
                  : [{
                      label: "Usable drivers",
                      status: "none",
                      detail: "No driver passed the evidence gate for this run.",
                      meta: [
                        "source: evidence gate",
                        "storage: evidence_packets",
                        "why: No allowed_candidate_drivers were recorded."
                      ],
                      tone: "working"
                    }]
              ),
              ...Object.entries(blockedDrivers).map(([label, reason]) => ({
                label: humanizeMarketAgentValue(label),
                status: "guarded",
                detail: `Held out by the evidence gate: ${String(reason)}`,
                meta: [
                  "source: evidence gate",
                  "storage: evidence_packets",
                  `why: ${String(reason)}`,
                  "used_by: Driver Attention + AI input guard"
                ],
                tone: "good"
              }))
            ]
          },
          {
            title: "Input evidence status",
            detail: "These are the latest inputs recorded in the evidence packet. Not confirming means present but not usable as confirmation.",
            rows: Object.entries(evidenceStatusMap).map(([label, status]) => {
              const statusText = String(status);
              return {
                label: humanizeMarketAgentValue(label),
                status: statusText,
                detail: statusText === "unavailable"
                  ? `${humanizeMarketAgentValue(label)} is unavailable, so it is not neutral evidence.`
                  : "Input status recorded for this run.",
                meta: [
                  "source: evidence packet",
                  "storage: evidence_packets",
                  `why: ${statusText === "unavailable" ? "Input is unavailable for this run." : "Input is present but has not confirmed the current read."}`,
                  "used_by: Evidence review + Latest Evidence"
                ],
                tone: statusText === "unavailable" ? "bad" : statusText === "supporting" || statusText === "confirming" ? "good" : "working"
              };
            })
          }
        ]
      }),
      node({
        id: "driver-attention",
        label: "Driver Attention",
        lane: "Processing Fabric",
        status: evidenceStatus,
        action: `${allowedDrivers.length} allowed driver(s)`,
        source: "Evidence gate + previous driver states",
        processing: "Move drivers between watching, emerging, active, cooling, retired, and blocked.",
        output: "Candidate gate + Evidence review",
        storage: ["driver_attention_states"],
        ai: "AI sees only allowed/blocked driver context.",
        trace: ["driver-attention", "candidate-gate", "evidence-packet", "storage-derived"],
        detail: "Driver Attention prevents a raw sensor from being treated as causation too early.",
        drilldown: [
          {
            title: "Driver lifecycle",
            detail: "Themes move through observed, watching, emerging, active, cooling, retired, or rejected states across monitor runs.",
            rows: driverStates.length
              ? driverStates.map((state) => ({
                  label: textValue(state, "label") || humanizeMarketAgentValue(textValue(state, "driver_id") || "driver"),
                  status: textValue(state, "current_state") || "watching",
                  detail: textValue(state, "current_evidence_summary") || textValue(state, "activation_reason") || "Driver state is stored for this run.",
                  meta: [
                    `priority: ${textValue(state, "priority") || "unknown"}`,
                    `confidence: ${textValue(state, "confidence") || "unknown"}`,
                    `last_evidence_at: ${readableDateTime(state.last_evidence_at)}`,
                    `storage: driver_attention_states`
                  ]
                }))
              : [
                  {
                    label: "Driver attention",
                    status: "waiting",
                    detail: "No driver attention state rows were returned for the selected run.",
                    meta: ["storage: driver_attention_states"]
                  }
                ]
          }
        ]
      }),
      node({
        id: "evidence-packet",
        label: "Evidence review",
        lane: "Processing Fabric",
        status: evidenceStatus,
        action: "Building bounded packet",
        source: "ScenarioFixture + EvidenceChainStatus",
        processing: "Compress raw rows and gate state into the packet checked by rules and eligible Local AI calls.",
        output: "AI checkpoints + Evidence UI",
        storage: ["evidence_packets"],
        ai: "Cause review and display summaries consume this bounded packet.",
        trace: ["evidence-packet", "display-summarizer", "cause-review", "latest-evidence", "storage-derived"],
        detail: "The evidence review is the bounded handoff from collected records to explanation.",
        drilldown: [
          {
            title: "Packet contents",
            detail: "The AI sees bounded facts from this packet, not the full raw universe.",
            rows: [
              {
                label: "Allowed drivers",
                status: allowedDrivers.length ? "ready" : "none",
                detail: allowedDrivers.join(", ") || "No candidate driver passed the gate.",
                meta: ["source: evidence gate", "storage: evidence_packets"]
              },
              {
                label: "Blocked drivers",
                status: Object.keys(blockedDrivers).length ? "blocked" : "none",
                detail: Object.entries(blockedDrivers).map(([label, reason]) => `${humanizeMarketAgentValue(label)}: ${reason}`).join(" | ") || "No blocked drivers recorded.",
                meta: ["AI cannot promote blocked drivers"]
              },
              {
                label: "Analysis result",
                status: String(analysisResult.cause_status || "pending"),
                detail: `main_driver: ${String(analysisResult.main_driver || "unknown")}`,
                meta: [`confidence: ${String(analysisResult.confidence || "unknown")}`, "storage: analysis_results"]
              }
            ]
          }
        ]
      })
    ]
  };

  const aiNodes = [
    node({
      id: "agent-self-audit",
      label: "Agent health",
      lane: "AI Checkpoints",
      status: selfAuditStatus || (monitorStatus?.running ? "running" : "not recorded"),
      action: selfAuditStatus === "healthy" ? "All required paths healthy" : selfAuditStatus === "action_required" ? "Needs attention" : "Monitoring partial inputs",
      source: "TimelineStore + provider health + latest evidence packet",
      processing: "Checks whether price, news, calendar, analysis, replay, and storage are present enough for the current market read.",
      output: "Activity health summary",
      storage: ["monitor_runs", "evidence_packets", "analysis_results", "timeline_events"],
      ai: "Shows whether Local AI or rule fallback produced the latest stored analysis.",
      trace: ["monitor-run", "agent-self-audit", "activity-output"],
      detail: selfAuditSummary || "Self-audit is recorded after each monitor pass when the desktop monitor provides a status file.",
      tone: statusTone(selfAuditStatus || "checking"),
      drilldown: [
        {
          title: "Runtime self-check",
          detail: selfAuditSummary || "Self-check explains what the agent has, what is partial, and what blocks a current market conclusion.",
          rows: selfAuditChecks.length
            ? selfAuditChecks.map((check) => ({
                label: humanizeMarketAgentValue(String(check.name || "check")),
                status: String(check.status || "not recorded"),
                detail: userFacingActivityText(String(check.detail || ""), "No detail recorded for this check."),
                meta: [
                  `checked_at: ${readableDateTime(selfAudit?.checked_at)}`,
                  `latest_evidence_run: ${String(selfAudit?.latest_evidence_run_id ?? "not recorded")}`,
                  `latest_timeline_event: ${readableDateTime(selfAudit?.latest_timeline_event_at)}`
                ]
              }))
            : [
                {
                  label: "Self-check",
                  status: "not recorded",
                  detail: "Run the monitor from the desktop app so status can include runtime self-audit.",
                  meta: ["storage: monitor status file"]
                }
              ]
        }
      ]
    }),
    node({
      id: "display-summarizer",
      label: "Display summarizer",
      lane: "AI Checkpoints",
      status: textValue(summaryEntry, "displaySummaryStatus") || llmStatus,
      action: "Shortening evidence rows",
      source: "News, calendar, related sensor rows",
      processing: "Generate short UI summaries without inventing facts.",
      output: "Latest Evidence",
      storage: ["news_items", "related_asset_bars", "evidence_packets"],
      ai: "Local AI when enabled; rule fallback keeps raw text usable.",
      trace: ["evidence-packet", "display-summarizer", "latest-evidence"],
      detail: "This checkpoint prevents long raw evidence from crowding the dashboard.",
      tone: "ai",
      drilldown: [
        {
          title: "LLM display role",
          detail: "The display summarizer shortens rows for UI readability while raw text remains in storage.",
          rows: jobRows(summaryEntry, "Display evidence summary")
        }
      ]
    }),
    node({
      id: "cause-review",
      label: "Cause review",
      lane: "AI Checkpoints",
      status: llmStatus,
      action: textValue(llmEntry, "detail") || "Reviewing cause packet",
              source: "Evidence review packet",
              processing: "Review the likely driver using only allowed evidence.",
      output: "AnalysisResult",
      storage: ["analysis_results"],
      ai: llmConfig?.llm?.enabled ? "Local AI enabled" : "Rule fallback active",
      trace: ["evidence-packet", "cause-review", "validator-repair", "dashboard-output", "storage-derived"],
      detail: textValue(llmEntry, "result") || "Cause review waits for a bounded evidence packet.",
      tone: "ai",
      performance: llmPerformance,
      drilldown: [
        {
          title: "LLM analysis",
          detail: "LLM groups evidence into human-readable explanations, but only from the bounded evidence packet.",
          rows: [
            {
              label: "Prompt input",
              status: llmStatus,
              detail: "Checked source bundle, accepted drivers, unused drivers, provider health, and previous state.",
              meta: ["guard: no outside news", "storage: evidence_packets"]
            },
            {
              label: "LLM output",
              status: textValue(llmEntry, "result") ? "returned" : llmStatus,
              detail: textValue(llmEntry, "result") || "No LLM result text recorded in activity snapshot.",
              meta: ["handoff: validator", "storage: analysis_results"]
            },
            ...llmTelemetryRows(llmEntry)
          ]
        }
      ]
    }),
    node({
      id: "validator-repair",
      label: "Validator / repair",
      lane: "AI Checkpoints",
      status: llmStatus,
      action: "Validating LLM JSON",
      source: "LLM output + allowed/blocked drivers",
      processing: "Repair once or reject invalid output.",
      output: "Dashboard + analysis_results",
      storage: ["analysis_results"],
      ai: "Deterministic validation controls AI output.",
      trace: ["cause-review", "validator-repair", "dashboard-output", "storage-derived"],
      detail: "AI output cannot reach the dashboard until it passes validation.",
      tone: "ai",
      drilldown: [
        {
          title: "Validator guard",
          detail: "Deterministic validation keeps the LLM from inventing drivers or bypassing unavailable evidence.",
          rows: [
            {
              label: "Schema validation",
              status: llmStatus,
              detail: "Invalid JSON is repaired once or rejected.",
              meta: ["guard: JSON contract", "storage: analysis_results"]
            },
            {
              label: "Evidence validation",
              status: evidenceStatus,
              detail: "The main driver must be supported by allowed evidence; unknown remains unknown when evidence is insufficient.",
              meta: [`main_driver: ${String(analysisResult.main_driver || "unknown")}`, `cause_status: ${String(analysisResult.cause_status || "unknown")}`]
            }
          ]
        }
      ]
    }),
    node({
      id: "replay-condenser",
      label: "Replay condenser",
      lane: "AI Checkpoints",
      status: replayStatus,
      action: `${stats.monthSummaryEvents} month turn(s)`,
      source: "timeline_events + analysis summaries",
      processing: "Day keeps detailed rows; month keeps important turns and summaries.",
      output: "Replay",
      storage: ["timeline_events", "month_summary_events"],
      ai: "Local AI summaries can be used; rule fallback filters important events.",
      trace: ["storage-derived", "replay-condenser", "replay-output"],
      detail: "This is why month replay should not expand every day marker.",
      tone: "ai",
      drilldown: [
        {
          title: "Replay condensation",
          detail: "Day replay keeps detailed rows; month replay keeps important turns and summaries.",
          rows: [
            {
              label: "Day trace",
              status: stats.timelineEvents ? "stored" : "waiting",
              detail: `${stats.timelineEvents} detailed timeline event(s) available.`,
              meta: ["storage: timeline_events"]
            },
            {
              label: "Month summary",
              status: stats.monthSummaryEvents ? "summarized" : "waiting",
              detail: `${stats.monthSummaryEvents} month summary event(s) available.`,
              meta: ["storage: month_summary_events", "AI/rule: important turns only"]
            }
          ]
        }
      ]
    }),
    node({
      id: "alert-review",
      label: "Alert review",
      lane: "AI Checkpoints",
      status: textValue(alertEntry, "preflightStatus") || alertStatus,
      action: "Reviewing delivery candidate",
      source: "Formatted alert + evidence packet",
      processing: "Approve, rewrite, or block alert text without adding unsupported facts.",
      output: "Telegram or dashboard only",
      storage: ["alerts"],
      ai: "Optional Local AI review before Telegram.",
      trace: ["evidence-packet", "alert-review", "telegram-output", "storage-derived"],
      detail: textValue(alertEntry, "detail") || "Alert review is only used when an alert candidate exists.",
      tone: "ai",
      drilldown: [
        {
          title: "Notification policy",
          detail: "Alerts are only sent when usefulness and evidence gates pass; otherwise the dashboard updates without paging the user.",
          rows: jobRows(alertEntry, "Alert preflight")
        }
      ]
    })
  ];

  const outputs = [
    node({
      id: "dashboard-output",
      label: "Dashboard",
      lane: "Outputs",
      status: textValue(llmEntry, "result") ? "ready" : evidenceStatus,
      action: "Showing current situation",
      source: "Validated AnalysisResult + display summaries",
      processing: "Show the most recent evidence-gated state.",
      output: "Dashboard view",
      storage: ["analysis_results", "evidence_packets"],
      ai: "Uses AI summary/review only after validation.",
      trace: ["validator-repair", "dashboard-output"],
      detail: "Dashboard is an output surface, not a source of truth.",
      tone: "good",
      drilldown: [
        {
          title: "Dashboard output",
          detail: "Dashboard shows the latest validated state and evidence-limited explanation.",
          rows: [
            {
              label: "Current situation",
              status: String(analysisResult.cause_status || "pending"),
              detail: `main_driver: ${String(analysisResult.main_driver || "unknown")}`,
              meta: [`confidence: ${String(analysisResult.confidence || "unknown")}`, "source: validated AnalysisResult"]
            }
          ]
        }
      ]
    }),
    node({
      id: "latest-evidence",
      label: "Latest Evidence",
      lane: "Outputs",
      status: evidenceStatus,
      action: "Showing short summaries",
      source: "Display summarizer + raw row fallback",
      processing: "Prefer short summary fields while keeping source rows and calendar context auditable.",
      output: "Evidence panel",
      storage: ["news_items", "related_asset_bars", "evidence_packets"],
      ai: "Display summarizer participates here.",
      trace: ["display-summarizer", "latest-evidence"],
      detail: "Latest Evidence is where long rows become readable.",
      tone: "good",
      drilldown: [
        {
          title: "Evidence panel output",
          detail: "Short display summaries are shown here while raw rows remain auditable in storage.",
          rows: [
            {
              label: "News evidence",
              status: stats.newsRows ? "available" : "waiting",
              detail: `${stats.newsRows} news row(s) available for replay/evidence.`,
              meta: ["display: short summary", "storage: news_items"]
            },
            {
              label: "Calendar evidence",
              status: stats.calendarRows ? "available" : "waiting",
              detail: `${stats.calendarRows} existing Economic Calendar row(s) available for replay/evidence context.`,
              meta: ["display: short summary", "source: existing Economic Calendar"]
            }
          ]
        }
      ]
    }),
    node({
      id: "replay-output",
      label: "Replay",
      lane: "Outputs",
      status: replayStatus,
      action: "Reading day/month rows",
      source: "TimelineStore indexed range reads",
      processing: "Day reads detailed timeline; month reads condensed major turns.",
      output: "Replay tab",
      storage: ["timeline_events", "month_summary_events"],
      ai: "Replay condenser can summarize important month turns.",
      trace: ["replay-condenser", "replay-output", "storage-derived"],
      detail: textValue(replayEntry, "detail") || "Replay reconstructs what happened from persisted rows.",
      tone: "store",
      drilldown: [
        {
          title: "Per-run trace",
          detail: "Replay follows the persisted path from raw source rows through processing, storage, evidence, and output.",
          rows: [
            {
              label: "Source rows",
              status: "stored",
              detail: `${stats.priceRows} price, ${stats.relatedRows} related asset, ${stats.newsRows} news, ${stats.calendarRows} calendar context row(s).`,
              meta: ["storage: market_price_bars / related_asset_bars / news_items", "calendar: existing Economic Calendar context"]
            },
            {
              label: "Timeline rows",
              status: stats.timelineEvents ? "stored" : "waiting",
              detail: `${stats.timelineEvents} timeline event(s), ${stats.monthSummaryEvents} month summary event(s).`,
              meta: ["storage: timeline_events / month_summary_events"]
            }
          ]
        }
      ]
    }),
    node({
      id: "telegram-output",
      label: "Telegram",
      lane: "Outputs",
      status: textValue(alertEntry, "telegramStatus") || alertStatus,
      action: telegramConfig?.telegram?.enabled ? "Ready for delivery" : "Dashboard only",
      source: "Approved alert payload",
      processing: "Deliver only after alert gates pass.",
      output: "Telegram chat",
      storage: ["alerts"],
      ai: "Alert review can rewrite/block before delivery.",
      trace: ["alert-review", "telegram-output"],
      detail: textValue(alertEntry, "detail") || "Telegram is optional and gated.",
      tone: statusTone(alertStatus),
      drilldown: [
        {
          title: "Telegram delivery",
          detail: "Telegram shows sent alerts only. Suppressed candidates stay here as Activity audit records, not Replay events.",
          rows: [
            {
              label: "Sent alerts",
              status: (payload?.alerts ?? []).some((alert) => alert.should_notify === true || alert.shouldNotify === true) ? "sent" : "none",
              detail: `${(payload?.alerts ?? []).filter((alert) => alert.should_notify === true || alert.shouldNotify === true).length} sent alert(s) in the selected replay range.`,
              meta: ["storage: alerts"]
            },
            ...suppressionAuditRows(auditAlerts, alertEntry ?? {}, analysisResult, payload)
          ]
        }
      ]
    })
  ];

  return {
    phaseLabel,
    phaseMessage,
    decisionTrace,
    lanes: [sourceLane, { id: "sensors", title: "Market Sensors", detail: "Core sensors are always visible; candidate and discovered sensors expose gaps.", nodes: coreSensors }, processingLane],
    coreSensors,
    candidateSensors,
    discoveredSensors,
    aiNodes,
    storageGroups: [
      {
        title: "Raw collected",
        detail: `${stats.priceRows + stats.relatedRows + stats.newsRows} stored market/news row(s), plus ${stats.calendarRows} existing calendar context row(s) in the current replay payload`,
        tables: ["market_price_bars", "related_asset_bars", "news_items", "provider_health"]
      },
      {
        title: "Processed / derived",
        detail: `${Object.keys(storageCounts).length ? Object.keys(storageCounts).map(normalizeStorageLabel).slice(0, 4).join(", ") : "analysis and replay rows"}`,
        tables: ["evidence_packets", "analysis_results", "driver_attention_states", "timeline_events", "month_summary_events", "state_transitions", "alerts"]
      }
    ],
    storagePath,
    outputs
  };
};
