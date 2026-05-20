import { type CSSProperties, useMemo, useState } from "react";

import type {
  MarketAgentDriverAttentionResponse,
  MarketAgentEvidenceForRunResponse,
  MarketAgentMonitorStatusResponse,
  MarketAgentProviderActionResponse,
  MarketAgentProviderConfigInput,
  MarketAgentProviderConfigResponse,
  MarketAgentProviderHealthEntry,
  MarketAgentProviderHealthResponse,
  MarketAgentLLMActionResponse,
  MarketAgentLLMConfigInput,
  MarketAgentLLMConfigResponse,
  MarketAgentReplayPayload,
  MarketAgentReplayResponse,
  MarketAgentSnapshotResponse,
  MarketAgentTelegramActionResponse,
  MarketAgentTelegramConfigInput,
  MarketAgentTelegramConfigResponse
} from "../types";
import { MarketAgentProviderConfig } from "./MarketAgentProviderConfig";
import { MarketAgentDriverAttention } from "./MarketAgentDriverAttention";
import { MarketAgentEvidencePanel } from "./MarketAgentEvidencePanel";
import { MarketAgentProviderHealth } from "./MarketAgentProviderHealth";
import { MarketAgentReplay } from "./MarketAgentReplay";
import { MarketAgentStatusBadge } from "./MarketAgentStatusBadge";
import {
  findProviderHealth,
  formatDriverLabel,
  formatRelevance,
  formatShortTime,
  humanizeMarketAgentValue,
  normalizeMarketAgentValue,
} from "../utils/marketAgentUi";
import "./MarketAgentPage.css";

type MarketAgentSection =
  | "live"
  | "drivers"
  | "replay"
  | "evidence"
  | "providers"
  | "sources"
  | "alerts"
  | "logs";

type MarketAgentPageProps = {
  snapshot: MarketAgentSnapshotResponse | null;
  providerConfig: MarketAgentProviderConfigResponse | null;
  telegramConfig: MarketAgentTelegramConfigResponse | null;
  llmConfig: MarketAgentLLMConfigResponse | null;
  providerHealth: MarketAgentProviderHealthResponse | null;
  driverAttention: MarketAgentDriverAttentionResponse | null;
  replay: MarketAgentReplayResponse | null;
  selectedEvidence: MarketAgentEvidenceForRunResponse | null;
  monitorStatus: MarketAgentMonitorStatusResponse | null;
  selectedMonitorRunId: number | null;
  rangePreset: string;
  rangeStartInput: string;
  rangeEndInput: string;
  onPresetChange: (preset: string) => void;
  onRangeStartChange: (value: string) => void;
  onRangeEndChange: (value: string) => void;
  onApplyRange: () => void;
  onSelectRun: (monitorRunId: number) => void;
  onSaveProviderConfig: (ctrader: MarketAgentProviderConfigInput) => void;
  onClearProviderConfig: () => void;
  onTestCTraderConnection: (ctrader: MarketAgentProviderConfigInput) => Promise<MarketAgentProviderActionResponse>;
  onResolveCTraderSymbol: (ctrader: MarketAgentProviderConfigInput) => Promise<MarketAgentProviderActionResponse>;
  onGetCTraderQuoteTest: (ctrader: MarketAgentProviderConfigInput) => Promise<MarketAgentProviderActionResponse>;
  onRefreshCTraderToken: (ctrader: MarketAgentProviderConfigInput) => Promise<MarketAgentProviderActionResponse>;
  onSaveTelegramConfig: (telegram: MarketAgentTelegramConfigInput) => Promise<MarketAgentTelegramConfigResponse>;
  onTestTelegramMessage: (telegram: MarketAgentTelegramConfigInput) => Promise<MarketAgentTelegramActionResponse>;
  onSaveLLMConfig: (llm: MarketAgentLLMConfigInput) => Promise<MarketAgentLLMConfigResponse>;
  onTestLLMConnection: (llm: MarketAgentLLMConfigInput) => Promise<MarketAgentLLMActionResponse>;
  onTestLLMJsonResponse: (llm: MarketAgentLLMConfigInput) => Promise<MarketAgentLLMActionResponse>;
  onRunMonitorOnce: () => Promise<MarketAgentMonitorStatusResponse>;
  onRunBackfillRecovery: () => Promise<MarketAgentMonitorStatusResponse>;
  onStartMonitorLoop: () => Promise<MarketAgentMonitorStatusResponse>;
  onStopMonitorLoop: () => Promise<MarketAgentMonitorStatusResponse>;
};

const sectionGroups: Array<{
  label: string;
  items: Array<{ id: MarketAgentSection; label: string }>;
}> = [
  {
    label: "Overview",
    items: [
      { id: "live", label: "Dashboard" },
      { id: "drivers", label: "Driver Attention" },
      { id: "replay", label: "Replay / Timeline" },
      { id: "evidence", label: "Evidence" }
    ]
  },
  {
    label: "Data & Health",
    items: [
      { id: "providers", label: "Provider Health" },
      { id: "sources", label: "Data Sources" }
    ]
  },
  {
    label: "System",
    items: [
      { id: "alerts", label: "Alerts" },
      { id: "logs", label: "Logs / Settings" }
    ]
  }
];

const formatValue = (value: unknown, fallback = "--") =>
  typeof value === "string" && value.trim()
    ? humanizeMarketAgentValue(value, fallback)
    : typeof value === "number"
      ? Number.isInteger(value)
        ? String(value)
        : value.toFixed(2)
      : typeof value === "boolean"
        ? value
          ? "Yes"
          : "No"
        : fallback;

const formatMonitorTime = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return formatShortTime(new Date(value > 10_000_000_000 ? value : value * 1000).toISOString());
  }
  return formatShortTime(value);
};

const numberValue = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const formatPrice = (value: unknown, fallback = "--") => {
  const numeric = numberValue(value);
  return numeric === null ? fallback : numeric.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
};

const formatSignedValue = (value: unknown, unit = "") => {
  const numeric = numberValue(value);
  if (numeric === null) return "--";
  const sign = numeric > 0 ? "+" : "";
  return `${sign}${numeric.toFixed(2)}${unit}`;
};

const formatMarketStateLabel = (value: unknown) => {
  const normalized = normalizeMarketAgentValue(value);
  if (normalized.includes("bearish")) return "Bearish";
  if (normalized.includes("bullish")) return "Bullish";
  if (normalized === "neutral") return "Neutral";
  if (normalized === "unknown" || !normalized) return "Unknown";
  return formatValue(value, "Unknown");
};

const marketStateTone = (value: unknown) => {
  const normalized = normalizeMarketAgentValue(value);
  if (normalized.includes("bearish")) return "negative";
  if (normalized.includes("bullish")) return "positive";
  return "neutral";
};

const marketStateArrow = (value: unknown) => {
  const tone = marketStateTone(value);
  if (tone === "positive") return "↗";
  if (tone === "negative") return "↘";
  return "→";
};

const extractMovePercent = (message: unknown) => {
  if (typeof message !== "string") return null;
  const match = message.match(/([+-]?\d+(?:\.\d+)?)\s*%/);
  if (!match) return null;
  const raw = Number(match[1]);
  if (!Number.isFinite(raw)) return null;
  const normalized = message.toLowerCase();
  const signed = raw < 0 || /drop|dropped|fall|fell|lower|down/.test(normalized) ? -Math.abs(raw) : raw;
  return `${signed > 0 ? "+" : ""}${signed.toFixed(2)}%`;
};

const formatMoveType = (changeLabel: string, message: unknown) => {
  const text = typeof message === "string" ? message.toLowerCase() : "";
  if (changeLabel === "--") return { label: "No move", tone: "neutral", arrow: "→" };
  if (changeLabel.startsWith("-")) {
    if (/reversal|retracement|pullback/.test(text)) return { label: "Retracement", tone: "negative", arrow: "↘" };
    return { label: "Drop", tone: "negative", arrow: "↓" };
  }
  if (/rebound|bounce|recovered|recovery/.test(text)) return { label: "Rebound", tone: "positive", arrow: "↑" };
  if (/spike|surge/.test(text)) return { label: "Spike", tone: "positive", arrow: "↑" };
  return { label: "Breakout", tone: "positive", arrow: "↑" };
};

const formatMoveDuration = (price: Record<string, unknown> | undefined, fallback = "15m") => {
  const raw =
    numberValue(price?.duration_seconds) ??
    numberValue(price?.move_duration_seconds) ??
    numberValue(price?.window_seconds);
  if (raw === null) return fallback;
  const seconds = Math.max(0, Math.round(raw));
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  if (minutes <= 0) return `${remaining}s`;
  return `${minutes}m ${remaining.toString().padStart(2, "0")}s`;
};

const formatEvidenceStrength = (value: unknown) => {
  const normalized = normalizeMarketAgentValue(value);
  if (normalized === "high" || normalized === "medium_high") return "Strong";
  if (normalized === "medium" || normalized === "balanced") return "Mixed";
  if (normalized === "low" || normalized === "weak") return "Weak";
  if (normalized === "none" || normalized === "unknown" || !normalized) return "Quiet";
  return formatValue(value, "Quiet");
};

const formatScore = (value: unknown) => {
  const numeric = numberValue(value);
  if (numeric === null) return "--";
  return String(Math.round(numeric > 1 ? numeric : numeric * 100));
};

const formatDriverImpact = (driver: MarketAgentDriverAttentionResponse["states"][number]) => {
  const score = numberValue(driver.relevance_score);
  if (score === null) return "--";
  const signed = score >= 0.5 ? score : -score;
  return `${signed >= 0 ? "+" : "-"}${Math.abs(signed * 100).toFixed(2)}%`;
};

const attentionLabel = (driver: MarketAgentDriverAttentionResponse["states"][number]) => {
  const score = numberValue(driver.relevance_score) ?? 0;
  if (score >= 0.75) return "High";
  if (score >= 0.4) return "Medium";
  return "Low";
};

type TimelineKind = "breakout" | "news" | "reversal" | "range" | "session" | "recovery" | "suppressed" | "alert" | "calendar" | "evidence";

type TimelineRow = {
  key: string;
  time: string;
  title: string;
  meta: string;
  status: unknown;
  monitorRunId?: number;
  payload?: Record<string, unknown>;
  source: "event" | "news" | "calendar" | "alert" | "suppressed";
};

const timelineKindMeta: Record<TimelineKind, { tag: string; icon: string; tone: string; title: string }> = {
  breakout: { tag: "BREAKOUT", icon: "↯", tone: "red", title: "Breakout" },
  news: { tag: "NEWS", icon: "✦", tone: "blue", title: "News" },
  reversal: { tag: "REVERSAL", icon: "↺", tone: "purple", title: "Reversal" },
  range: { tag: "RANGE", icon: "◇", tone: "green", title: "Range" },
  session: { tag: "SESSION", icon: "◷", tone: "amber", title: "Session" },
  recovery: { tag: "RECOVERY", icon: "⟳", tone: "green", title: "Recovery" },
  suppressed: { tag: "SUPPRESSED", icon: "×", tone: "muted", title: "Suppressed" },
  alert: { tag: "ALERT", icon: "!", tone: "red", title: "Alert" },
  calendar: { tag: "CALENDAR", icon: "◷", tone: "amber", title: "Calendar" },
  evidence: { tag: "EVIDENCE", icon: "◆", tone: "blue", title: "Evidence" }
};

const inferTimelineKind = (item: TimelineRow): TimelineKind => {
  const payloadKind = normalizeMarketAgentValue(item.payload?.semantic_type);
  if (payloadKind in timelineKindMeta) return payloadKind as TimelineKind;
  const status = normalizeMarketAgentValue(item.status);
  const title = normalizeMarketAgentValue(item.title);
  if (item.source === "news" || title.includes("headline")) return "news";
  if (item.source === "calendar") return "calendar";
  if (item.source === "suppressed" || status.includes("suppressed")) return "suppressed";
  if (status.includes("recovery") || status.includes("backfilled")) return "recovery";
  if (title.includes("rebound") || title.includes("reverse") || title.includes("invalidated")) return "reversal";
  if (title.includes("session")) return "session";
  if (title.includes("range") || title.includes("quiet")) return "range";
  if (status.includes("level") || item.source === "alert") return "alert";
  if (title.includes("breakout") || title.includes("selloff") || title.includes("pressure") || title.includes("drop")) return "breakout";
  return "evidence";
};

const formatTimelineImpact = (item: TimelineRow) => {
  const payloadImpact = numberValue(item.payload?.impact_percent);
  const segment = item.payload?.segment as Record<string, unknown> | undefined;
  const segmentImpact = numberValue(segment?.move_percent);
  const impact = payloadImpact ?? segmentImpact;
  if (impact === null) return "Impact: watching";
  return `Impact: ${formatSignedValue(impact, "%")}`;
};

const compactTimelineTitle = (item: TimelineRow) => {
  const impact = numberValue(item.payload?.impact_percent);
  if (impact !== null && item.source === "alert") {
    const action = impact < 0 ? "XAUUSD drop" : impact > 0 ? "XAUUSD spike" : "XAUUSD flat";
    return `${action} ${formatSignedValue(impact, "%")}`;
  }
  return item.title;
};

const statusForProvider = (item: MarketAgentProviderHealthEntry | undefined) => {
  if (!item) return "Disabled";
  const sourceType = normalizeMarketAgentValue(item.source_type);
  const dataMode = normalizeMarketAgentValue(item.data_mode);
  if (!item.is_available || dataMode === "unavailable") return "Unavailable";
  if (item.is_stale || dataMode === "stale") return "Stale data";
  if (sourceType === "futures_proxy" || dataMode === "proxy") return "Futures proxy";
  if (sourceType === "local_csv_fallback" || dataMode === "local_csv_fallback") return "Local CSV fallback";
  if (sourceType === "spot") return "Live data";
  if (dataMode === "backfilled") return "Backfilled";
  return "Live data";
};

const latestPrice = (replay: MarketAgentReplayResponse | null) => {
  const rows = replay?.replay.price_series ?? [];
  return rows[rows.length - 1] as Record<string, unknown> | undefined;
};

const latestTimelineRows = (payload: MarketAgentReplayPayload | undefined): TimelineRow[] => {
  if (!payload) return [];
  const eventRunIds = new Set(payload.timeline_events.map((item) => item.monitor_run_id).filter(Boolean));
  return [
    ...payload.timeline_events.map((item) => ({
      key: `event-${item.monitor_run_id}-${item.event_time}`,
      time: item.event_time,
      title: item.label,
      meta: formatDriverLabel(item.payload?.main_driver ?? "unknown"),
      status: item.event_type,
      monitorRunId: item.monitor_run_id,
      payload: item.payload,
      source: "event" as const
    })),
    ...payload.news_items.map((item, index) => ({
      key: `news-${index}-${String(item.published_at ?? item.title ?? "")}`,
      time: String(item.published_at ?? item.first_seen_at ?? ""),
      title: String(item.title ?? "News item"),
      meta: String(item.source ?? "News"),
      status: item.data_mode ?? "possible",
      monitorRunId: undefined,
      payload: item,
      source: "news" as const
    })),
    ...payload.calendar_events.map((item, index) => ({
      key: `calendar-${index}-${String(item.scheduled_at ?? item.title ?? "")}`,
      time: String(item.scheduled_at ?? ""),
      title: String(item.title ?? "Calendar event"),
      meta: String(item.source ?? "Calendar"),
      status: item.data_mode ?? "possible",
      monitorRunId: undefined,
      payload: item,
      source: "calendar" as const
    })),
    ...payload.alerts
      .filter((item) => !item.monitor_run_id || !eventRunIds.has(item.monitor_run_id))
      .map((item, index) => ({
        key: `alert-${index}-${item.monitor_run_id ?? index}`,
        time: String(item.run_started_at ?? ""),
        title: String(item.message ?? "Alert"),
        meta: formatDriverLabel(item.main_driver ?? "unknown"),
        status: item.notification_level ?? "alert",
        monitorRunId: item.monitor_run_id,
        payload: item,
        source: "alert" as const
      })),
    ...payload.suppressed_alerts.map((item, index) => ({
      key: `suppressed-${index}-${item.monitor_run_id ?? index}`,
      time: String(item.run_started_at ?? ""),
      title: String(item.message ?? "Suppressed alert"),
      meta: "No state change",
      status: "suppressed",
      monitorRunId: item.monitor_run_id,
      payload: item,
      source: "suppressed" as const
    }))
  ]
    .filter((item) => item.time || item.title)
    .sort((left, right) => String(right.time).localeCompare(String(left.time)))
    .slice(0, 6);
};

const evidenceItems = (selectedEvidence: MarketAgentEvidenceForRunResponse | null) => {
  const packet = selectedEvidence?.payload?.evidence_packet as Record<string, unknown> | undefined;
  const analysis = selectedEvidence?.payload?.analysis_result as Record<string, unknown> | undefined;
  const evidenceStatus = (packet?.evidence_status as Record<string, unknown> | undefined) ?? {};
  const allowed = Array.isArray(packet?.allowed_candidate_drivers) ? packet.allowed_candidate_drivers : [];
  const blocked = (packet?.blocked_drivers as Record<string, unknown> | undefined) ?? {};
  const rows = [
    ...allowed.map((driver) => ({
      title: formatDriverLabel(driver),
      status: "Supporting",
      detail: "Confirmed enough to explain the move",
      kind: normalizeMarketAgentValue(driver).includes("yield") ? "yield" : normalizeMarketAgentValue(driver).includes("usd") ? "usd" : "driver"
    })),
    ...Object.entries(evidenceStatus).map(([key, value]) => ({
      title: formatDriverLabel(key),
      status: value,
      detail: formatValue(value, "Evidence status"),
      kind: normalizeMarketAgentValue(key).includes("news") ? "news" : normalizeMarketAgentValue(key).includes("us") ? "yield" : "technical"
    })),
    ...Object.entries(blocked).map(([key, value]) => ({
      title: formatDriverLabel(key),
      status: "Blocked",
      detail: String(value),
      kind: "blocked"
    }))
  ];
  if (analysis?.rejected_driver) {
    rows.push({
      title: formatDriverLabel(analysis.rejected_driver),
      status: "Rejected",
      detail: String(analysis.rejection_reason ?? "Rejected by validator"),
      kind: "blocked"
    });
  }
  return rows.slice(0, 5);
};

const evidenceKindMeta = (kind: string) => {
  const normalized = normalizeMarketAgentValue(kind);
  if (normalized.includes("news")) return { icon: "N", tone: "blue", label: "News" };
  if (normalized.includes("yield")) return { icon: "Y", tone: "amber", label: "Yield" };
  if (normalized.includes("usd")) return { icon: "$", tone: "green", label: "USD" };
  if (normalized.includes("blocked")) return { icon: "X", tone: "red", label: "Blocked" };
  if (normalized.includes("technical")) return { icon: "T", tone: "purple", label: "Technical" };
  return { icon: "D", tone: "blue", label: "Driver" };
};

function MarketAgentDashboard({
  snapshot,
  providerHealth,
  driverAttention,
  replay,
  selectedEvidence,
  onSelectRun,
  onNavigate
}: {
  snapshot: MarketAgentSnapshotResponse | null;
  providerHealth: MarketAgentProviderHealthResponse | null;
  driverAttention: MarketAgentDriverAttentionResponse | null;
  replay: MarketAgentReplayResponse | null;
  selectedEvidence: MarketAgentEvidenceForRunResponse | null;
  onSelectRun: (monitorRunId: number) => void;
  onNavigate: (section: MarketAgentSection) => void;
}) {
  const state = snapshot?.state;
  const xauusdHealth = findProviderHealth(providerHealth?.items, ["xauusd", "gc=f", "xauusd price"]);
  const price = latestPrice(replay);
  const priceValue = numberValue(price?.close_price ?? xauusdHealth?.current_value);
  const bid = numberValue(price?.bid ?? price?.bid_price);
  const ask = numberValue(price?.ask ?? price?.ask_price);
  const spread = numberValue(price?.spread) ?? (bid !== null && ask !== null ? ask - bid : null);
  const timeline = latestTimelineRows(replay?.replay);
  const evidence = evidenceItems(selectedEvidence);
  const supportingCount = evidence.filter((item) =>
    ["supporting", "confirming", "allowed", "live data"].includes(normalizeMarketAgentValue(item.status))
  ).length || (evidence.length ? Math.max(1, evidence.length - 1) : 0);
  const contraryCount = evidence.filter((item) =>
    ["blocked", "rejected", "contrary"].includes(normalizeMarketAgentValue(item.status))
  ).length;
  const neutralCount = Math.max(0, evidence.length - supportingCount - contraryCount);
  const evidenceScore = evidence.length ? Math.round((supportingCount / evidence.length) * 100) : 0;
  const moveChange = numberValue(price?.change_pct ?? price?.change_15m_pct ?? xauusdHealth?.change_value);
  const sourceType = normalizeMarketAgentValue(xauusdHealth?.source_type ?? price?.source_type);
  const priceSourceLabel = sourceType === "spot" ? "Spot price" : sourceType === "futures_proxy" ? "Backup price" : "No price source";
  const providerStatus = statusForProvider(xauusdHealth);
  const displayProviderStatus = providerStatus === "Futures proxy" ? "Backup" : providerStatus;
  const lastPriceTime = formatShortTime(xauusdHealth?.data_timestamp ?? price?.timestamp);
  const latestAlertMessage = replay?.replay.alerts?.[0]?.message;
  const evidenceRunTime = formatShortTime(selectedEvidence?.payload?.monitor_run?.run_started_at);
  const latestMoveLabel = moveChange === null
    ? (extractMovePercent(latestAlertMessage) ?? "--")
    : formatSignedValue(moveChange, xauusdHealth?.change_unit === "%" ? "%" : "");
  const latestMoveIsNegative = latestMoveLabel.startsWith("-");
  const latestMoveSizeTone = latestMoveLabel === "--" ? "neutral" : latestMoveIsNegative ? "negative" : "positive";
  const latestMove = formatMoveType(latestMoveLabel, latestAlertMessage);
  const marketTone = marketStateTone(state?.current_bias);
  const hasBidAsk = bid !== null || ask !== null || spread !== null;
  const activeDrivers = (driverAttention?.states ?? [])
    .filter((item) => ["active", "active_macro"].includes(normalizeMarketAgentValue(item.current_state)))
    .sort((left, right) => (right.relevance_score ?? 0) - (left.relevance_score ?? 0));
  const watchingDrivers = (driverAttention?.states ?? [])
    .filter((item) => ["watching", "emerging", "cooling"].includes(normalizeMarketAgentValue(item.current_state)))
    .sort((left, right) => (right.relevance_score ?? 0) - (left.relevance_score ?? 0));
  const backgroundDrivers = (driverAttention?.states ?? [])
    .filter((item) => ["dormant", "retired", "unknown", ""].includes(normalizeMarketAgentValue(item.current_state)))
    .sort((left, right) => (right.relevance_score ?? 0) - (left.relevance_score ?? 0));
  const visibleDrivers = [...activeDrivers, ...watchingDrivers, ...backgroundDrivers].slice(0, 7);
  const backgroundCount = (driverAttention?.states ?? []).filter((item) =>
    ["dormant", "retired", "unknown", ""].includes(normalizeMarketAgentValue(item.current_state))
  ).length;

  return (
    <section className="market-agent-cockpit" data-qa="qa:market-agent:cockpit">
      <div className="market-agent-kpi-grid">
        <article className="market-agent-kpi-card market-agent-price-card">
          <div className="market-agent-kpi-head">
            <h3>XAUUSD Price</h3>
            <span className="market-agent-source-dot">
              <span className={sourceType === "spot" ? "spot" : "proxy"} />
              {priceSourceLabel}
            </span>
          </div>
          <strong>{formatPrice(priceValue ?? xauusdHealth?.current_value, "No price")}</strong>
          {hasBidAsk ? (
            <div className="market-agent-price-meta market-agent-kpi-metrics">
              <span>Bid <b>{formatPrice(bid)}</b></span>
              <span>Ask <b>{formatPrice(ask)}</b></span>
              <span>Spread <b>{formatPrice(spread)}</b></span>
            </div>
          ) : <div className="market-agent-kpi-spacer" />}
          <div className="market-agent-kpi-footer">
            <span>{displayProviderStatus}</span>
            <span>{lastPriceTime}</span>
          </div>
        </article>
        <article className="market-agent-kpi-card market-agent-state-card">
          <div className="market-agent-kpi-head">
            <h3>Market State</h3>
          </div>
          <strong className={`market-agent-state-value ${marketTone}`}>
            {formatMarketStateLabel(state?.current_bias)}
            <span>{marketStateArrow(state?.current_bias)}</span>
          </strong>
          <div className="market-agent-state-details">
            <span>Since {formatShortTime(state?.last_analysis_time)}</span>
            <span>Confidence: <b>{formatValue(state?.confidence, "--")}</b></span>
          </div>
        </article>
        <article className="market-agent-kpi-card market-agent-move-card">
          <div className="market-agent-kpi-head">
            <h3>Latest Move</h3>
          </div>
          <strong className={`market-agent-move-type ${latestMove.tone}`}>
            {latestMove.label}
            <span>{latestMove.arrow}</span>
          </strong>
          <div className="market-agent-move-details">
            <span>Detected: <b>{formatShortTime(state?.last_alert_time)}</b></span>
            <span>
              Move Size: <b className={latestMoveSizeTone}>{latestMoveLabel}</b>
            </span>
            <span>Duration: <b>{formatMoveDuration(price)}</b></span>
          </div>
        </article>
        <article className="market-agent-kpi-card market-agent-evidence-score-card">
          <div className="market-agent-kpi-head">
            <h3>Evidence Status</h3>
          </div>
          <div className="market-agent-evidence-score">
            <div className="market-agent-score-ring" style={{ "--score": `${evidenceScore}%` } as CSSProperties}>
              <strong>{evidenceScore}%</strong>
              <span>{formatEvidenceStrength(state?.confidence)}</span>
            </div>
            <div className="market-agent-evidence-counts">
              <span><i className="supporting" /><span>Supporting</span><b>{supportingCount}</b></span>
              <span><i className="neutral" /><span>Neutral</span><b>{neutralCount}</b></span>
              <span><i className="contrary" /><span>Contrary</span><b>{contraryCount}</b></span>
            </div>
          </div>
          <div className="market-agent-evidence-quality">
            <span>Quality:</span>
            <b>{formatValue(state?.confidence, "--")}</b>
          </div>
        </article>
        <article className="market-agent-kpi-card market-agent-next-card">
          <div className="market-agent-kpi-head">
            <h3>Next Update</h3>
          </div>
          <div className="market-agent-next-content">
            <span className="market-agent-clock-icon" aria-hidden="true" />
            <div>
              <strong>60 sec</strong>
              <span>{snapshot?.available ? "Auto monitoring" : "Not running"}</span>
            </div>
          </div>
          <div className="market-agent-kpi-footer">
            <span>Last check</span>
            <span>{formatShortTime(state?.last_analysis_time)}</span>
          </div>
        </article>
      </div>

      <div className="market-agent-cockpit-panels">
        <section className="market-agent-cockpit-panel">
          <div className="market-agent-panel-title-row">
            <h3>Driver Attention <span>(Current)</span></h3>
            <button type="button" className="market-agent-panel-link" onClick={() => onNavigate("drivers")}>
              View All
            </button>
          </div>
          <div className="market-agent-attention-table" role="table" aria-label="Driver Attention Current">
            <div className="market-agent-attention-table-head" role="row">
              <span>Driver</span>
              <span>State</span>
              <span>Impact</span>
              <span>Attention</span>
              <span>Score</span>
            </div>
            {visibleDrivers.map((driver) => (
              <div className="market-agent-attention-table-row" role="row" key={driver.driver_id}>
                <strong>{driver.label || formatDriverLabel(driver.driver_id)}</strong>
                <span className={`market-agent-driver-state state-${normalizeMarketAgentValue(driver.current_state)}`}>
                  {formatValue(driver.current_state, "Unknown")}
                </span>
                <span className={formatDriverImpact(driver).startsWith("-") ? "negative" : "positive"}>
                  {formatDriverImpact(driver)}
                </span>
                <MarketAgentStatusBadge label={attentionLabel(driver)} />
                <span>{formatScore(driver.relevance_score)}</span>
              </div>
            ))}
            {visibleDrivers.length === 0 ? (
              <div className="market-agent-empty-state">No active or watching drivers.</div>
            ) : null}
          </div>
          <div className="market-agent-attention-footer">
            <div>
              <span>Attention Score:</span>
              <b>{formatScore(activeDrivers[0]?.relevance_score ?? watchingDrivers[0]?.relevance_score)} / 100</b>
            </div>
            <div className="market-agent-attention-meter" aria-hidden="true">
              <span style={{ width: `${Math.max(0, Math.min(100, Number(formatScore(activeDrivers[0]?.relevance_score ?? watchingDrivers[0]?.relevance_score)) || 0))}%` }} />
            </div>
            <div className="market-agent-attention-legend">
              <span><i className="active" />Active</span>
              <span><i className="watching" />Watching</span>
              <span><i className="dormant" />Background {backgroundCount}</span>
            </div>
          </div>
        </section>

        <section className="market-agent-cockpit-panel">
          <div className="market-agent-panel-title-row">
            <h3>Market Replay <span>(Today)</span></h3>
            <div className="market-agent-range-tabs" aria-label="Replay range">
              <span>1H</span>
              <span>4H</span>
              <span className="active">1D</span>
            </div>
          </div>
          <div className="market-agent-timeline-track">
            {timeline.map((item) => {
              const kind = inferTimelineKind(item);
              const meta = timelineKindMeta[kind];
              return (
                <button
                  type="button"
                  key={item.key}
                  className={`market-agent-timeline-track-row kind-${meta.tone}`}
                  onClick={() => item.monitorRunId && onSelectRun(item.monitorRunId)}
                >
                  <time>{formatShortTime(item.time)}</time>
                  <span className="market-agent-timeline-node">{meta.icon}</span>
                  <div>
                    <span className={`market-agent-event-tag tone-${meta.tone}`}>{meta.tag}</span>
                    <strong>{compactTimelineTitle(item)}</strong>
                    <span>{item.meta}</span>
                    <small>{formatTimelineImpact(item)}</small>
                  </div>
                </button>
              );
            })}
            {timeline.length === 0 ? <div className="market-agent-empty-state">No replay events in this window.</div> : null}
          </div>
          <button type="button" className="market-agent-panel-link market-agent-panel-link-footer" onClick={() => onNavigate("replay")}>
            View Full Timeline <span aria-hidden="true">→</span>
          </button>
        </section>

        <section className="market-agent-cockpit-panel">
          <div className="market-agent-panel-title-row">
            <h3>Latest Evidence <span>({evidenceRunTime})</span></h3>
            <button type="button" className="market-agent-panel-link" onClick={() => onNavigate("evidence")}>
              View All
            </button>
          </div>
          <div className="market-agent-evidence-tabs" aria-label="Evidence filters">
            <span className="active">All</span>
            <span>News</span>
            <span>Calendar</span>
            <span>Technical</span>
            <span>Drivers</span>
          </div>
          <div className="market-agent-evidence-feed">
            {evidence.map((item, index) => {
              const meta = evidenceKindMeta(item.kind);
              return (
                <div className={`market-agent-evidence-feed-row tone-${meta.tone}`} key={`${item.title}-${index}`}>
                  <span className="market-agent-evidence-icon">{meta.icon}</span>
                  <div>
                    <span className="market-agent-evidence-type">{meta.label}</span>
                    <strong>{item.title}</strong>
                    <span>{item.detail}</span>
                  </div>
                  <time>{evidenceRunTime}</time>
                  <MarketAgentStatusBadge label={formatValue(item.status, "unknown")} />
                </div>
              );
            })}
            {evidence.length === 0 ? <div className="market-agent-empty-state">No evidence packet selected.</div> : null}
          </div>
          <div className="market-agent-evidence-footer">
            <span><i /> Evidence Quality: <b>{formatEvidenceStrength(state?.confidence)} ({evidenceScore}%)</b></span>
            <span>{supportingCount} Supporting, {neutralCount} Neutral, {contraryCount} Contrary</span>
          </div>
        </section>
      </div>

    </section>
  );
}

export function MarketAgentPage(props: MarketAgentPageProps) {
  const [section, setSection] = useState<MarketAgentSection>("live");
  const content = useMemo(() => {
    if (section === "live") {
      return (
        <MarketAgentDashboard
          snapshot={props.snapshot}
          providerHealth={props.providerHealth}
          driverAttention={props.driverAttention}
          replay={props.replay}
          selectedEvidence={props.selectedEvidence}
          onSelectRun={props.onSelectRun}
          onNavigate={setSection}
        />
      );
    }
    if (section === "drivers") {
      return <MarketAgentDriverAttention data={props.driverAttention} />;
    }
    if (section === "replay") {
      return (
        <MarketAgentReplay
          replay={props.replay}
          selectedEvidence={props.selectedEvidence}
          selectedMonitorRunId={props.selectedMonitorRunId}
          rangePreset={props.rangePreset}
          rangeStartInput={props.rangeStartInput}
          rangeEndInput={props.rangeEndInput}
          onPresetChange={props.onPresetChange}
          onRangeStartChange={props.onRangeStartChange}
          onRangeEndChange={props.onRangeEndChange}
          onApplyRange={props.onApplyRange}
          onSelectRun={props.onSelectRun}
        />
      );
    }
    if (section === "evidence") {
      return <MarketAgentEvidencePanel data={props.selectedEvidence} />;
    }
    if (section === "providers") {
      return <MarketAgentProviderHealth data={props.providerHealth} />;
    }
    if (section === "sources") {
      return (
        <MarketAgentProviderConfig
          data={props.providerConfig}
          telegramData={props.telegramConfig}
          llmData={props.llmConfig}
          onSave={props.onSaveProviderConfig}
          onClear={props.onClearProviderConfig}
          onTestConnection={props.onTestCTraderConnection}
          onResolveSymbol={props.onResolveCTraderSymbol}
          onQuoteTest={props.onGetCTraderQuoteTest}
          onRefreshToken={props.onRefreshCTraderToken}
          onSaveTelegram={props.onSaveTelegramConfig}
          onTestTelegram={props.onTestTelegramMessage}
          onSaveLLM={props.onSaveLLMConfig}
          onTestLLMConnection={props.onTestLLMConnection}
          onTestLLMJsonResponse={props.onTestLLMJsonResponse}
          monitorStatus={props.monitorStatus}
          onRunMonitorOnce={props.onRunMonitorOnce}
          onRunBackfillRecovery={props.onRunBackfillRecovery}
          onStartMonitorLoop={props.onStartMonitorLoop}
          onStopMonitorLoop={props.onStopMonitorLoop}
        />
      );
    }
    if (section === "alerts") {
      return (
        <section className="market-agent-surface">
          <div className="market-agent-surface-header">
            <div>
              <h2>Alerts</h2>
              <span className="hint">Recent sent and suppressed market-agent alerts</span>
            </div>
          </div>
          <div className="market-agent-alerts-list">
            {(props.replay?.replay.alerts ?? []).map((alert, index) => (
              <div key={`alert-${index}`} className="market-agent-evidence-mini-row">
                <strong>{formatValue(alert.message, "Alert")}</strong>
                <span>{formatShortTime(alert.run_started_at)}</span>
                <MarketAgentStatusBadge label={formatValue(alert.notification_level, "alert")} />
              </div>
            ))}
            {(props.replay?.replay.suppressed_alerts ?? []).map((alert, index) => (
              <div key={`suppressed-${index}`} className="market-agent-evidence-mini-row">
                <strong>{formatValue(alert.message, "Suppressed alert")}</strong>
                <span>{formatShortTime(alert.run_started_at)}</span>
                <MarketAgentStatusBadge label="Suppressed" />
              </div>
            ))}
          </div>
        </section>
      );
    }
    return (
      <section className="market-agent-surface">
        <div className="market-agent-surface-header">
          <div>
            <h2>Logs / Settings</h2>
            <span className="hint">Control the Windows-friendly monitor loop and inspect last process status.</span>
          </div>
        </div>
        <div className="market-agent-monitor-control">
          <article>
            <div>
              <h3>Monitor Process</h3>
              <MarketAgentStatusBadge label={props.monitorStatus?.running ? "Running" : formatValue(props.monitorStatus?.phase, "Stopped")} />
            </div>
            <p>{props.monitorStatus?.message || "Monitor loop is stopped."}</p>
            <div className="market-agent-monitor-control-grid">
              <span>PID</span>
              <strong>{formatValue(props.monitorStatus?.pid, "--")}</strong>
              <span>Last run</span>
              <strong>{formatMonitorTime(props.monitorStatus?.lastRunAt)}</strong>
              <span>Next run</span>
              <strong>{formatMonitorTime(props.monitorStatus?.nextRunAt)}</strong>
              <span>Last error</span>
              <strong>{props.monitorStatus?.lastError || "None"}</strong>
            </div>
            <div className="market-agent-monitor-actions">
              <button type="button" className="btn ghost btn-compact" onClick={() => void props.onRunMonitorOnce()}>
                Run once
              </button>
              <button type="button" className="btn ghost btn-compact" onClick={() => void props.onStartMonitorLoop()}>
                Start monitor loop
              </button>
              <button type="button" className="btn ghost btn-compact" onClick={() => void props.onStopMonitorLoop()}>
                Stop monitor loop
              </button>
            </div>
          </article>
          <article>
            <div>
              <h3>Telegram Reporting</h3>
              <MarketAgentStatusBadge label="Optional" />
            </div>
            <p>
              Telegram is disabled unless configured by environment or saved settings. Failed sends are recorded with
              alert history and do not stop monitoring.
            </p>
          </article>
        </div>
      </section>
    );
  }, [props, section]);

  return (
    <div className="market-agent-page market-agent-cockpit-shell" data-qa="qa:page:market-agent">
      <aside className="market-agent-side-nav">
        <div className="market-agent-side-brand">
          <span>ALPHA</span>
          <strong>Market Agent</strong>
        </div>
        <nav aria-label="Market Agent sections">
          {sectionGroups.map((group) => (
            <div className="market-agent-side-group" key={group.label}>
              <span>{group.label}</span>
              {group.items.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  aria-pressed={section === item.id}
                  className={section === item.id ? "active" : ""}
                  onClick={() => setSection(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
      </aside>
      <main className="market-agent-cockpit-main">{content}</main>
    </div>
  );
}
