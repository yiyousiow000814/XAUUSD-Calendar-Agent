import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState } from "react";

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
  MarketAgentLLMSetupResponse,
  MarketAgentOllamaPullProgress,
  MarketAgentCTraderAuthResponse,
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
import { normalizeMarketAgentReplayPayload } from "../utils/marketAgentReplay";
import "./MarketAgentPage.css";

type MarketAgentSection =
  | "live"
  | "drivers"
  | "replay"
  | "evidence"
  | "providers"
  | "sources"
  | "alerts";

type MarketAgentPageProps = {
  snapshot: MarketAgentSnapshotResponse | null;
  providerConfig: MarketAgentProviderConfigResponse | null;
  telegramConfig: MarketAgentTelegramConfigResponse | null;
  llmConfig: MarketAgentLLMConfigResponse | null;
  localAiSetup?: MarketAgentLLMSetupResponse | null;
  localAiPullProgress?: MarketAgentOllamaPullProgress | null;
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
  onStartCTraderConnect?: (ctrader: MarketAgentProviderConfigInput) => Promise<MarketAgentCTraderAuthResponse>;
  onTestCTraderBackfill?: (ctrader: MarketAgentProviderConfigInput) => Promise<MarketAgentProviderActionResponse>;
  onSaveTelegramConfig: (telegram: MarketAgentTelegramConfigInput) => Promise<MarketAgentTelegramConfigResponse>;
  onTestTelegramMessage: (telegram: MarketAgentTelegramConfigInput) => Promise<MarketAgentTelegramActionResponse>;
  onSaveLLMConfig: (llm: MarketAgentLLMConfigInput) => Promise<MarketAgentLLMConfigResponse>;
  onTestLLMConnection: (llm: MarketAgentLLMConfigInput) => Promise<MarketAgentLLMActionResponse>;
  onTestLLMJsonResponse: (llm: MarketAgentLLMConfigInput) => Promise<MarketAgentLLMActionResponse>;
  onDetectLocalAI?: () => Promise<MarketAgentLLMSetupResponse>;
  onInstallRecommendedModel?: (model: string) => Promise<MarketAgentLLMActionResponse>;
  onCancelModelDownload?: (model?: string) => Promise<MarketAgentLLMActionResponse>;
  onBenchmarkLLM?: (llm: MarketAgentLLMConfigInput) => Promise<MarketAgentLLMActionResponse>;
  onApplyLLMFallbackPolicy?: (payload: Record<string, unknown>) => Promise<MarketAgentLLMActionResponse>;
  onRunMonitorOnce: () => Promise<MarketAgentMonitorStatusResponse>;
  onRunBackfillRecovery: () => Promise<MarketAgentMonitorStatusResponse>;
  onStartMonitorLoop: () => Promise<MarketAgentMonitorStatusResponse>;
  onStopMonitorLoop: () => Promise<MarketAgentMonitorStatusResponse>;
};

type MarketAgentNavIconName =
  | "dashboard"
  | "drivers"
  | "replay"
  | "evidence"
  | "providers"
  | "sources"
  | "alerts"
  | "settings";

const sectionGroups: Array<{
  label: string;
  items: Array<{ id: MarketAgentSection; label: string; icon: MarketAgentNavIconName }>;
}> = [
  {
    label: "Overview",
    items: [
      { id: "live", label: "Dashboard", icon: "dashboard" },
      { id: "drivers", label: "Driver Attention", icon: "drivers" },
      { id: "replay", label: "Replay / Timeline", icon: "replay" },
      { id: "evidence", label: "Evidence", icon: "evidence" }
    ]
  },
  {
    label: "Data & Health",
    items: [
      { id: "providers", label: "Provider Health", icon: "providers" },
      { id: "sources", label: "Data Sources", icon: "sources" }
    ]
  },
  {
    label: "System",
    items: [
      { id: "alerts", label: "Alerts", icon: "alerts" }
    ]
  }
];

function MarketAgentNavIcon({ name }: { name: MarketAgentNavIconName }) {
  const common = {
    width: 15,
    height: 15,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.9,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "data-nav-icon": name,
    "aria-hidden": true
  };

  if (name === "dashboard") {
    return (
      <svg {...common}>
        <path d="M4.2 10.9 12 4.4l7.8 6.5" />
        <path d="M6.5 10.6v8.2h11v-8.2" />
        <path d="M10 18.8v-5h4v5" />
      </svg>
    );
  }
  if (name === "drivers") {
    return (
      <svg {...common}>
        <path d="M4.8 15.7a7.2 7.2 0 0 1 14.4 0" />
        <path d="M12 15.4 16.4 9" />
        <path d="M8.2 18h7.6" />
        <circle cx="12" cy="15.4" r="1.2" />
      </svg>
    );
  }
  if (name === "replay") {
    return (
      <svg {...common}>
        <path d="M5.2 6.2h13.6" />
        <path d="M5.2 12h9.2" />
        <path d="M5.2 17.8h13.6" />
        <circle cx="7.4" cy="6.2" r="1.5" />
        <circle cx="14.4" cy="12" r="1.5" />
        <circle cx="10.4" cy="17.8" r="1.5" />
      </svg>
    );
  }
  if (name === "evidence") {
    return (
      <svg {...common}>
        <path d="M8.2 5.2h7.6l2.2 2.4v11.2H6.8V6.6a1.4 1.4 0 0 1 1.4-1.4Z" />
        <path d="M15.6 5.4v2.4h2.2" />
        <path d="m9.7 13.1 1.7 1.8 3.5-4" />
        <path d="M9.8 8.8h3.1" />
      </svg>
    );
  }
  if (name === "providers") {
    return (
      <svg {...common}>
        <rect x="5.2" y="4.7" width="13.6" height="5.2" rx="1.5" />
        <rect x="5.2" y="14.1" width="13.6" height="5.2" rx="1.5" />
        <path d="M8.2 7.3h.1" />
        <path d="M8.2 16.7h.1" />
        <path d="M11 7.3h4.8" />
        <path d="M11 16.7h4.8" />
        <path d="M12 9.9v4.2" />
      </svg>
    );
  }
  if (name === "sources") {
    return (
      <svg {...common}>
        <ellipse cx="12" cy="5.8" rx="6.8" ry="2.7" />
        <path d="M5.2 5.8v6.2c0 1.5 3 2.7 6.8 2.7s6.8-1.2 6.8-2.7V5.8" />
        <path d="M5.2 12v4.2c0 1.5 3 2.7 6.8 2.7s6.8-1.2 6.8-2.7V12" />
      </svg>
    );
  }
  if (name === "alerts") {
    return (
      <svg {...common}>
        <path d="M18 9.8a6 6 0 0 0-12 0c0 5-2 5.7-2 5.7h16s-2-.7-2-5.7" />
        <path d="M9.7 18.3a2.5 2.5 0 0 0 4.6 0" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M12.2 3.2h-.4a1.6 1.6 0 0 0-1.6 1.6v.3a1.5 1.5 0 0 1-.8 1.3l-.4.2a1.5 1.5 0 0 1-1.5 0l-.3-.2a1.6 1.6 0 0 0-2.2.6l-.2.4a1.6 1.6 0 0 0 .6 2.2l.3.2a1.5 1.5 0 0 1 .8 1.3v.6a1.5 1.5 0 0 1-.8 1.3l-.3.2a1.6 1.6 0 0 0-.6 2.2l.2.4a1.6 1.6 0 0 0 2.2.6l.3-.2a1.5 1.5 0 0 1 1.5 0l.4.2a1.5 1.5 0 0 1 .8 1.3v.3a1.6 1.6 0 0 0 1.6 1.6h.4a1.6 1.6 0 0 0 1.6-1.6v-.3a1.5 1.5 0 0 1 .8-1.3l.4-.2a1.5 1.5 0 0 1 1.5 0l.3.2a1.6 1.6 0 0 0 2.2-.6l.2-.4a1.6 1.6 0 0 0-.6-2.2l-.3-.2a1.5 1.5 0 0 1-.8-1.3v-.6a1.5 1.5 0 0 1 .8-1.3l.3-.2a1.6 1.6 0 0 0 .6-2.2l-.2-.4a1.6 1.6 0 0 0-2.2-.6l-.3.2a1.5 1.5 0 0 1-1.5 0l-.4-.2a1.5 1.5 0 0 1-.8-1.3v-.3a1.6 1.6 0 0 0-1.6-1.6Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

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

function MarketAgentValuePulse({
  value,
  children,
  className = ""
}: {
  value: unknown;
  children: ReactNode;
  className?: string;
}) {
  const valueKey = typeof value === "object" ? JSON.stringify(value ?? "") : String(value ?? "");
  return (
    <span key={valueKey} className={`market-agent-value-pulse ${className}`.trim()}>
      {children}
    </span>
  );
}

function MarketAgentCountdownDigit({
  digit,
  direction
}: {
  digit: string;
  direction: "down" | "up" | "none";
}) {
  const previousRef = useRef(digit);
  const [roll, setRoll] = useState<{
    previous: string;
    digit: string;
    direction: "down" | "up" | "none";
  } | null>(null);

  useEffect(() => {
    const previous = previousRef.current;
    if (previous === digit) {
      setRoll(null);
      return undefined;
    }
    previousRef.current = digit;
    setRoll({ previous, digit, direction });
    const timeout = window.setTimeout(() => {
      setRoll((current) => (current?.digit === digit ? null : current));
    }, 220);
    return () => window.clearTimeout(timeout);
  }, [digit, direction]);

  const activeRoll = roll?.digit === digit ? roll : null;

  return (
    <span
      className={`market-agent-countdown-digit${activeRoll ? ` is-changing roll-${activeRoll.direction}` : ""}`}
      data-old={activeRoll?.previous}
      data-new={activeRoll?.digit}
      aria-hidden="true"
    >
      <span className="market-agent-countdown-digit-current">{digit}</span>
    </span>
  );
}

function MarketAgentRollingCountdown({ seconds }: { seconds: number }) {
  const previousSecondsRef = useRef(seconds);
  const previousSeconds = previousSecondsRef.current;
  const direction = seconds < previousSeconds ? "down" : seconds > previousSeconds ? "up" : "none";
  const digits = String(seconds).split("");

  useEffect(() => {
    previousSecondsRef.current = seconds;
  }, [seconds]);

  return (
    <span
      className="market-agent-countdown"
      data-qa="qa:market-agent:next-countdown"
      aria-label={formatCountdownSeconds(seconds)}
    >
      <span className="market-agent-countdown-number" aria-hidden="true">
        {digits.map((digit, index) => {
          const place = digits.length - index - 1;
          return <MarketAgentCountdownDigit key={`place-${place}`} digit={digit} direction={direction} />;
        })}
      </span>{" "}
      <span className="market-agent-countdown-unit" aria-hidden="true">sec</span>
    </span>
  );
}

const parseTimestampMs = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1000;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
};

const padDatePart = (value: number) => String(value).padStart(2, "0");

const formatClockTime = (value: unknown, fallback = "--") => {
  const parsed = parseTimestampMs(value);
  if (parsed === null) return fallback;
  const date = new Date(parsed);
  return `${padDatePart(date.getHours())}:${padDatePart(date.getMinutes())}`;
};

const formatStateSinceTime = (value: unknown, fallback = "--") => {
  const parsed = parseTimestampMs(value);
  if (parsed === null) return fallback;
  const date = new Date(parsed);
  return `${padDatePart(date.getDate())}-${padDatePart(date.getMonth() + 1)}-${date.getFullYear()} ${formatClockTime(value, fallback)}`;
};

const formatStateSinceCompactTime = (value: unknown, fallback = "--") => {
  const parsed = parseTimestampMs(value);
  if (parsed === null) return fallback;
  const date = new Date(parsed);
  return `${padDatePart(date.getDate())}-${padDatePart(date.getMonth() + 1)} ${formatClockTime(value, fallback)}`;
};

const formatReplayTime = (value: unknown, fallback = "--") => {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });
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

const formatSignedPriceChange = (value: unknown) => {
  const numeric = numberValue(value);
  if (numeric === null) return "--";
  const sign = numeric > 0 ? "+" : "";
  return `${sign}${numeric.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
};

const formatPercentChange = (value: unknown) => {
  const numeric = numberValue(value);
  if (numeric === null) return "--";
  const sign = numeric > 0 ? "+" : "";
  return `${sign}${numeric.toFixed(2)}%`;
};

const formatMarketStateLabel = (value: unknown) => {
  const normalized = normalizeMarketAgentValue(value);
  if (normalized.includes("bearish")) return "TRENDING DOWN";
  if (normalized.includes("bullish")) return "TRENDING UP";
  if (normalized === "neutral" || normalized.includes("range")) return "RANGEBOUND";
  if (normalized === "unknown" || !normalized) return "UNKNOWN";
  return formatValue(value, "UNKNOWN").toUpperCase();
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

const formatDurationSeconds = (value: number | null, fallback = "--") => {
  if (value === null) return fallback;
  const seconds = Math.max(0, Math.round(value));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${remaining.toString().padStart(2, "0")}s`;
  return `${remaining}s`;
};

const formatMoveDuration = (
  price: Record<string, unknown> | undefined,
  detectedAt: unknown,
  nowMs: number,
  fallback = "--"
) => {
  const raw =
    numberValue(price?.duration_seconds) ??
    numberValue(price?.move_duration_seconds) ??
    numberValue(price?.window_seconds);
  if (raw !== null) return formatDurationSeconds(raw, fallback);
  const detectedMs = parseTimestampMs(detectedAt);
  if (detectedMs === null) return fallback;
  return formatDurationSeconds((nowMs - detectedMs) / 1000, fallback);
};

const formatEvidenceStrength = (value: unknown) => {
  const normalized = normalizeMarketAgentValue(value);
  if (normalized === "high" || normalized === "medium_high") return "Strong";
  if (normalized === "medium" || normalized === "balanced") return "Mixed";
  if (normalized === "low" || normalized === "weak") return "Weak";
  if (normalized === "none" || normalized === "unknown" || !normalized) return "Quiet";
  return formatValue(value, "Quiet");
};

const formatEvidenceScoreStrength = (score: number, total: number, contrary: number) => {
  if (total <= 0) return "Quiet";
  if (score >= 75) return "Strong";
  if (score >= 40) return "Mixed";
  if (contrary > 0 && score === 0) return "Contrary";
  return "Weak";
};

const formatDataFreshness = (value: unknown, nowMs: number) => {
  const timestamp = parseTimestampMs(value);
  if (timestamp === null) return "";
  const seconds = Math.max(0, Math.round((nowMs - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
};

const formatDataModeLabel = (sourceType: string, providerStatus: string) => {
  if (sourceType === "spot") return "Live";
  if (sourceType === "futures_proxy") return "Proxy";
  if (sourceType === "local_csv_fallback") return "Local CSV fallback";
  if (providerStatus === "Stale data") return "Stale";
  if (providerStatus === "Unavailable") return "Unavailable";
  return providerStatus;
};

const formatCountdownSeconds = (seconds: number) =>
  `${seconds} sec`;

const nextRunCountdown = (
  monitorStatus: MarketAgentMonitorStatusResponse | null,
  nowMs: number,
  fallbackBaseMs: number
) => {
  const intervalSeconds = Math.max(1, Math.round(numberValue(monitorStatus?.intervalSeconds) ?? 60));
  const nextRunMs = parseTimestampMs(monitorStatus?.nextRunAt);
  if (nextRunMs !== null) {
    let seconds = Math.ceil((nextRunMs - nowMs) / 1000);
    while (seconds <= 0) seconds += intervalSeconds;
    if (seconds > intervalSeconds) {
      seconds = ((seconds - 1) % intervalSeconds) + 1;
    }
    return { seconds, intervalSeconds };
  }
  const elapsed = Math.max(0, Math.floor((nowMs - fallbackBaseMs) / 1000));
  const remainder = elapsed % intervalSeconds;
  return { seconds: remainder === 0 ? intervalSeconds : intervalSeconds - remainder, intervalSeconds };
};

const formatScore = (value: unknown) => {
  const numeric = numberValue(value);
  if (numeric === null) return "--";
  return String(Math.round(numeric > 1 ? numeric : numeric * 100));
};

const formatDriverImpact = (driver: MarketAgentDriverAttentionResponse["states"][number]) => {
  const record = driver as MarketAgentDriverAttentionResponse["states"][number] & Record<string, unknown>;
  const impact = numberValue(
    record.impact_percent ??
    record.latest_impact_percent ??
    record.move_percent ??
    record.impact
  );
  return impact === null ? "--" : formatSignedValue(impact, "%");
};

const driverImpactTone = (driver: MarketAgentDriverAttentionResponse["states"][number]) => {
  const record = driver as MarketAgentDriverAttentionResponse["states"][number] & Record<string, unknown>;
  const impact = numberValue(
    record.impact_percent ??
    record.latest_impact_percent ??
    record.move_percent ??
    record.impact
  );
  if (impact === null || impact === 0) return "neutral";
  return impact < 0 ? "negative" : "positive";
};

const attentionLabel = (driver: MarketAgentDriverAttentionResponse["states"][number]) => {
  const score = numberValue(driver.relevance_score) ?? 0;
  if (score >= 0.75) return "High";
  if (score >= 0.4) return "Medium";
  return "Low";
};

const formatDriverStateLabel = (value: unknown) =>
  formatValue(value, "Unknown").toUpperCase();

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

type ReplayRange = "day" | "month";

type EvidenceFilter = "all" | "news" | "calendar" | "technical" | "drivers";

type DashboardEvidenceRow = {
  key: string;
  title: string;
  detail: string;
  status: string;
  kind: string;
  filter: EvidenceFilter;
  time: string;
};

const replayRangeOptions: Array<{ value: ReplayRange; label: string; hint: string }> = [
  { value: "day", label: "Day", hint: "Detailed event flow" },
  { value: "month", label: "Month", hint: "Major XAUUSD turns" }
];

const evidenceFilterOptions: Array<{ value: EvidenceFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "news", label: "News" },
  { value: "calendar", label: "Calendar" },
  { value: "technical", label: "Technical" },
  { value: "drivers", label: "Drivers" }
];

const timelineKindMeta: Record<TimelineKind, { tag: string; icon: string; tone: string; title: string }> = {
  breakout: { tag: "BREAKOUT", icon: "B", tone: "red", title: "Breakout" },
  news: { tag: "NEWS", icon: "N", tone: "blue", title: "News" },
  reversal: { tag: "REVERSAL", icon: "R", tone: "purple", title: "Reversal" },
  range: { tag: "RANGE", icon: "R", tone: "green", title: "Range" },
  session: { tag: "SESSION", icon: "S", tone: "amber", title: "Session" },
  recovery: { tag: "RECOVERY", icon: "R", tone: "green", title: "Recovery" },
  suppressed: { tag: "SUPPRESSED", icon: "S", tone: "muted", title: "Suppressed" },
  alert: { tag: "ALERT", icon: "A", tone: "red", title: "Alert" },
  calendar: { tag: "CALENDAR", icon: "C", tone: "amber", title: "Calendar" },
  evidence: { tag: "EVIDENCE", icon: "E", tone: "blue", title: "Evidence" }
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

const timelineImpactValue = (item: TimelineRow) => {
  const payloadImpact = numberValue(item.payload?.impact_percent);
  const segment = item.payload?.segment as Record<string, unknown> | undefined;
  const segmentImpact = numberValue(segment?.move_percent);
  return payloadImpact ?? segmentImpact;
};

const isMajorTimelineEvent = (item: TimelineRow) => {
  const kind = inferTimelineKind(item);
  const impact = timelineImpactValue(item);
  const status = normalizeMarketAgentValue(item.status);
  const title = normalizeMarketAgentValue(item.title);
  if (item.source === "alert") return true;
  if (["breakout", "reversal", "recovery"].includes(kind)) return true;
  if (typeof impact === "number" && Math.abs(impact) >= 0.2) return true;
  if (status.includes("level_2") || status.includes("level_3") || status.includes("confirmed")) return true;
  return ["pressure", "breakout", "selloff", "drop", "spike", "reversal", "driver"].some((word) => title.includes(word));
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
  const rows = normalizeMarketAgentReplayPayload(replay?.replay).price_series;
  return rows[rows.length - 1] as Record<string, unknown> | undefined;
};

const previousPrice = (replay: MarketAgentReplayResponse | null) => {
  const rows = normalizeMarketAgentReplayPayload(replay?.replay).price_series;
  return rows.length > 1 ? rows[rows.length - 2] as Record<string, unknown> : undefined;
};

const ALERT_NOTICE_STORAGE_KEY = "xauusd:market-agent:seen-alert-ids";

const alertNoticeId = (kind: "sent" | "suppressed", item: Record<string, unknown>, index: number) =>
  [
    kind,
    String(item.monitor_run_id ?? ""),
    String(item.run_started_at ?? ""),
    String(item.message ?? ""),
    String(item.notification_level ?? ""),
    String(index)
  ].join("::");

const alertNoticeIds = (replay: MarketAgentReplayResponse | null) => {
  const payload = normalizeMarketAgentReplayPayload(replay?.replay);
  return payload.alerts.map((item, index) => alertNoticeId("sent", item, index));
};

const alertDriverFromMessage = (message: unknown) => {
  if (typeof message !== "string") return "";
  const match = message.match(/active\s+driver\s*:\s*([^.\n]+)/i);
  return match?.[1]?.trim() || "";
};

const alertTitle = (message: unknown) => {
  if (typeof message !== "string") return "Market alert";
  const stripped = message.replace(/\s*active\s+driver\s*:\s*[^.\n]+\.?/i, "").trim();
  return formatValue(stripped || message, "Market alert");
};

const alertDriverDetail = (driver: unknown, message?: unknown) => {
  const normalized = normalizeMarketAgentValue(driver);
  if (!normalized || normalized === "unknown") {
    const messageDriver = alertDriverFromMessage(message);
    return messageDriver ? `Active driver ${humanizeMarketAgentValue(messageDriver, messageDriver)}` : "Review market move";
  }
  return `Driver ${formatDriverLabel(driver)}`;
};

const readSeenAlertIds = () => {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(ALERT_NOTICE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
};

const writeSeenAlertIds = (ids: string[]) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ALERT_NOTICE_STORAGE_KEY, JSON.stringify(ids.slice(-250)));
  } catch {
    // Ignore storage failures; notification badges still work for the current render.
  }
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
    .sort((left, right) => String(right.time).localeCompare(String(left.time)));
};

const filterTimelineByReplayRange = (rows: TimelineRow[], range: ReplayRange) => {
  if (range === "month") return rows.filter(isMajorTimelineEvent);
  return rows;
};

const evidenceStatusLabel = (value: unknown, fallback = "Supporting") => {
  const normalized = normalizeMarketAgentValue(value);
  if (!normalized) return fallback;
  if (normalized.includes("unavailable") || normalized.includes("missing") || normalized.includes("no_data")) {
    return "Not Available";
  }
  if (normalized.includes("blocked") || normalized.includes("rejected") || normalized.includes("contrary")) {
    return "Blocked";
  }
  if (normalized.includes("neutral") || normalized.includes("background") || normalized.includes("not_confirming") || normalized.includes("unconfirmed")) {
    return "Neutral";
  }
  return "Supporting";
};

const evidenceStatusTone = (status: string): "neutral" | "good" | "warn" | "bad" | "info" => {
  const normalized = normalizeMarketAgentValue(status);
  if (normalized === "supporting") return "good";
  if (normalized === "neutral") return "warn";
  if (normalized.includes("available")) return "neutral";
  if (normalized === "blocked") return "bad";
  return "info";
};

const userFacingEvidenceDetail = (value: unknown, fallback: string) =>
  String(value || fallback)
    .replace(/\bconfirming\b/gi, "supporting the move")
    .replace(/\bconfirmed\b/gi, "supported");

const evidenceStatusValue = (packet: Record<string, unknown> | undefined, key: string) => {
  const evidenceStatus = (packet?.evidence_status as Record<string, unknown> | undefined) ?? {};
  const crossAsset = (packet?.cross_asset_confirmation as Record<string, unknown> | undefined) ?? {};
  return evidenceStatus[key] ?? crossAsset[key];
};

const latestRelatedAsset = (payload: MarketAgentReplayPayload | undefined, key: string) => {
  const rows = payload?.related_assets?.[key];
  if (!Array.isArray(rows) || rows.length === 0) return undefined;
  return [...rows].sort((left, right) =>
    String(right.data_timestamp ?? right.timestamp ?? "").localeCompare(String(left.data_timestamp ?? left.timestamp ?? ""))
  )[0];
};

const driverStateDetail = (
  driverAttention: MarketAgentDriverAttentionResponse | null,
  driverIds: string[],
  fallback: string
) => {
  const ids = new Set(driverIds.map(normalizeMarketAgentValue));
  const state = driverAttention?.states.find((item) => ids.has(normalizeMarketAgentValue(item.driver_id)));
  return userFacingEvidenceDetail(
    state?.current_evidence_summary ||
      state?.activation_reason ||
      state?.deactivation_reason ||
      fallback,
    fallback
  );
};

const relatedAssetDetail = (label: string, asset: Record<string, unknown> | undefined, fallback: string, unit = "") => {
  const change = numberValue(asset?.change_15m ?? asset?.change ?? asset?.move);
  if (change === null) return fallback;
  return `${label} moved ${formatSignedValue(change, unit)} in the latest window.`;
};

const latestTechnicalEvent = (payload: MarketAgentReplayPayload | undefined) =>
  [...(payload?.timeline_events ?? [])]
    .filter((item) => {
      const type = normalizeMarketAgentValue(item.payload?.semantic_type ?? item.event_type);
      return ["breakout", "reversal", "range"].includes(type);
    })
    .sort((left, right) => String(right.event_time).localeCompare(String(left.event_time)))
    .sort((left, right) => {
      const leftType = normalizeMarketAgentValue(left.payload?.semantic_type ?? left.event_type);
      const rightType = normalizeMarketAgentValue(right.payload?.semantic_type ?? right.event_type);
      return Number(rightType === "breakout") - Number(leftType === "breakout");
    })[0];

const evidenceItems = (
  selectedEvidence: MarketAgentEvidenceForRunResponse | null,
  replay: MarketAgentReplayResponse | null,
  driverAttention: MarketAgentDriverAttentionResponse | null
): DashboardEvidenceRow[] => {
  const packet = selectedEvidence?.payload?.evidence_packet as Record<string, unknown> | undefined;
  const analysis = selectedEvidence?.payload?.analysis_result as Record<string, unknown> | undefined;
  const payload = normalizeMarketAgentReplayPayload(replay?.replay);
  const runTime = String(selectedEvidence?.payload?.monitor_run?.run_started_at ?? "");
  const rows: DashboardEvidenceRow[] = [];
  const news = payload?.news_items.find((item) => item.title || item.summary || item.description);
  if (news) {
    rows.push({
      key: `news-${String(news.published_at ?? news.title ?? "latest")}`,
      title: String(news.summary_title ?? "High Impact News"),
      detail: String(news.summary ?? news.description ?? news.title ?? news.source ?? "News item"),
      status: evidenceStatusLabel(news.included ?? news.data_mode ?? evidenceStatusValue(packet, "news")),
      kind: "news",
      filter: "news",
      time: String(news.published_at ?? news.first_seen_at ?? runTime)
    });
  }

  const dxyAsset = latestRelatedAsset(payload, "dxy");
  const dxyStatus = evidenceStatusLabel(evidenceStatusValue(packet, "dxy"));
  if (dxyAsset || evidenceStatusValue(packet, "dxy")) {
    rows.push({
      key: "driver-dxy",
      title: "DXY / USD",
      detail: driverStateDetail(
        driverAttention,
        ["usd", "dxy"],
        relatedAssetDetail("DXY", dxyAsset, "USD pressure is part of the evidence packet.")
      ),
      status: dxyStatus,
      kind: "usd",
      filter: "drivers",
      time: String(dxyAsset?.data_timestamp ?? dxyAsset?.timestamp ?? runTime)
    });
  }

  const us10yAsset = latestRelatedAsset(payload, "us10y");
  if (us10yAsset || evidenceStatusValue(packet, "us10y")) {
    rows.push({
      key: "driver-us10y",
      title: "US10Y Yield Move",
      detail: driverStateDetail(
        driverAttention,
        ["yields", "us10y", "real_yields"],
        relatedAssetDetail("US10Y", us10yAsset, "US yield confirmation is part of the evidence packet.", "bp")
      ),
      status: evidenceStatusLabel(evidenceStatusValue(packet, "us10y")),
      kind: "yield",
      filter: "drivers",
      time: String(us10yAsset?.data_timestamp ?? us10yAsset?.timestamp ?? runTime)
    });
  }

  const technical = latestTechnicalEvent(payload);
  if (technical) {
    const kind = inferTimelineKind({
      key: `technical-${technical.monitor_run_id}`,
      time: technical.event_time,
      title: technical.label,
      meta: "",
      status: technical.event_type,
      payload: technical.payload,
      source: "event"
    });
    const meta = timelineKindMeta[kind];
    rows.push({
      key: `technical-${technical.monitor_run_id}-${technical.event_time}`,
      title: `Technical ${meta.title}`,
      detail: technical.label,
      status: evidenceStatusLabel(technical.payload?.cause_status ?? analysis?.cause_status ?? "supporting"),
      kind: "technical",
      filter: "technical",
      time: technical.event_time
    });
  }

  const us2yAsset = latestRelatedAsset(payload, "us2y");
  if (us2yAsset || evidenceStatusValue(packet, "us2y")) {
    rows.push({
      key: "driver-us2y",
      title: "US2Y",
      detail: us2yAsset ? relatedAssetDetail("US2Y", us2yAsset, "US2Y source is present.", "bp") : "No available US2Y source for this run.",
      status: evidenceStatusLabel(evidenceStatusValue(packet, "us2y"), "Not Available"),
      kind: "yield",
      filter: "drivers",
      time: String(us2yAsset?.data_timestamp ?? us2yAsset?.timestamp ?? runTime)
    });
  }

  const oilAsset = latestRelatedAsset(payload, "wti") ?? latestRelatedAsset(payload, "brent");
  if (rows.length < 5 && (oilAsset || evidenceStatusValue(packet, "oil"))) {
    rows.push({
      key: "driver-oil",
      title: "Oil Price Move",
      detail: driverStateDetail(
        driverAttention,
        ["oil_inflation", "oil"],
        relatedAssetDetail("Oil", oilAsset, "Oil is background evidence only.", "%")
      ),
      status: evidenceStatusLabel(evidenceStatusValue(packet, "oil"), "Neutral"),
      kind: "oil",
      filter: "drivers",
      time: String(oilAsset?.data_timestamp ?? oilAsset?.timestamp ?? runTime)
    });
  }

  const calendar = payload?.calendar_events.find((item) => item.title || item.summary);
  if (rows.length < 5 && calendar) {
    rows.push({
      key: `calendar-${String(calendar.scheduled_at ?? calendar.title ?? "latest")}`,
      title: "Calendar Context",
      detail: String(calendar.summary ?? calendar.title ?? "Calendar event"),
      status: evidenceStatusLabel(calendar.data_mode ?? "neutral", "Neutral"),
      kind: "calendar",
      filter: "calendar",
      time: String(calendar.scheduled_at ?? runTime)
    });
  }

  return rows.slice(0, 5);
};

const evidenceKindMeta = (kind: string) => {
  const normalized = normalizeMarketAgentValue(kind);
  if (normalized.includes("news")) return { icon: "N", tone: "blue", label: "News" };
  if (normalized.includes("calendar")) return { icon: "C", tone: "amber", label: "Calendar" };
  if (normalized.includes("yield")) return { icon: "Y", tone: "amber", label: "Yield" };
  if (normalized.includes("usd")) return { icon: "$", tone: "green", label: "USD" };
  if (normalized.includes("oil")) return { icon: "O", tone: "amber", label: "Oil" };
  if (normalized.includes("blocked")) return { icon: "X", tone: "red", label: "Blocked" };
  if (normalized.includes("technical")) return { icon: "T", tone: "purple", label: "Technical" };
  return { icon: "D", tone: "blue", label: "Driver" };
};

const SCORE_RING_RADIUS = 34;
const SCORE_RING_CIRCUMFERENCE = 2 * Math.PI * SCORE_RING_RADIUS;

function MarketAgentDashboard({
  snapshot,
  providerHealth,
  driverAttention,
  replay,
  selectedEvidence,
  monitorStatus,
  onSelectRun,
  onNavigate
}: {
  snapshot: MarketAgentSnapshotResponse | null;
  providerHealth: MarketAgentProviderHealthResponse | null;
  driverAttention: MarketAgentDriverAttentionResponse | null;
  replay: MarketAgentReplayResponse | null;
  selectedEvidence: MarketAgentEvidenceForRunResponse | null;
  monitorStatus: MarketAgentMonitorStatusResponse | null;
  onSelectRun: (monitorRunId: number) => void;
  onNavigate: (section: MarketAgentSection) => void;
}) {
  const [replayRange, setReplayRange] = useState<ReplayRange>("day");
  const [evidenceFilter, setEvidenceFilter] = useState<EvidenceFilter>("all");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [countdownBaseMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const state = snapshot?.state;
  const xauusdHealth = findProviderHealth(providerHealth?.items, ["xauusd", "gc=f", "xauusd price"]);
  const price = latestPrice(replay);
  const priorPrice = previousPrice(replay);
  const priceValue = numberValue(price?.close_price ?? xauusdHealth?.current_value);
  const previousPriceValue = numberValue(priorPrice?.close_price ?? xauusdHealth?.previous_value);
  const priceChangeValue = numberValue(price?.change_value ?? price?.change ?? price?.change_15m);
  const computedPriceChange = priceChangeValue ?? (
    priceValue !== null && previousPriceValue !== null ? priceValue - previousPriceValue : null
  );
  const priceChangePercent =
    numberValue(price?.change_pct ?? price?.change_15m_pct ?? price?.move_percent) ??
    (priceValue !== null && previousPriceValue !== null && previousPriceValue !== 0
      ? ((priceValue - previousPriceValue) / previousPriceValue) * 100
      : null);
  const timeline = filterTimelineByReplayRange(latestTimelineRows(replay?.replay), replayRange);
  const allEvidence = evidenceItems(selectedEvidence, replay, driverAttention);
  const evidence = evidenceFilter === "all" ? allEvidence : allEvidence.filter((item) => item.filter === evidenceFilter);
  const supportingCount = evidence.filter((item) =>
    normalizeMarketAgentValue(item.status) === "supporting"
  ).length;
  const contraryCount = evidence.filter((item) =>
    ["blocked", "rejected", "contrary"].includes(normalizeMarketAgentValue(item.status))
  ).length;
  const neutralCount = Math.max(0, evidence.length - supportingCount - contraryCount);
  const evidenceScore = evidence.length ? Math.round((supportingCount / evidence.length) * 100) : 0;
  const clampedEvidenceScore = Math.max(0, Math.min(100, evidenceScore));
  const evidenceScoreLabel = formatEvidenceScoreStrength(clampedEvidenceScore, evidence.length, contraryCount);
  const isEvidenceScoreEmpty = clampedEvidenceScore <= 0;
  const isEvidenceScoreFull = clampedEvidenceScore >= 100;
  const evidenceScoreDashOffset = SCORE_RING_CIRCUMFERENCE * (1 - clampedEvidenceScore / 100);
  const moveChange = numberValue(price?.change_pct ?? price?.change_15m_pct ?? xauusdHealth?.change_value);
  const sourceType = normalizeMarketAgentValue(xauusdHealth?.source_type ?? price?.source_type);
  const priceSourceLabel = sourceType === "spot" ? "cTrader (Spot)" : sourceType === "futures_proxy" ? "Backup price" : "No price source";
  const providerStatus = statusForProvider(xauusdHealth);
  const displayProviderStatus = formatDataModeLabel(sourceType, providerStatus);
  const dataFreshness = formatDataFreshness(xauusdHealth?.data_timestamp ?? price?.data_timestamp ?? price?.timestamp, nowMs);
  const latestAlertMessage = replay?.replay.alerts?.[0]?.message;
  const evidenceRunTime = formatReplayTime(selectedEvidence?.payload?.monitor_run?.run_started_at);
  const latestMoveLabel = moveChange === null
    ? (extractMovePercent(latestAlertMessage) ?? "--")
    : formatSignedValue(moveChange, xauusdHealth?.change_unit === "%" ? "%" : "");
  const latestMoveIsNegative = latestMoveLabel.startsWith("-");
  const latestMoveSizeTone = latestMoveLabel === "--" ? "neutral" : latestMoveIsNegative ? "negative" : "positive";
  const latestMove = formatMoveType(latestMoveLabel, latestAlertMessage);
  const marketTone = marketStateTone(state?.current_bias);
  const priceChangeTone = computedPriceChange === null ? "neutral" : computedPriceChange < 0 ? "negative" : "positive";
  const marketStrength = formatEvidenceStrength(state?.confidence);
  const stateSinceCompact = formatStateSinceCompactTime(state?.last_analysis_time);
  const stateSinceFull = formatStateSinceTime(state?.last_analysis_time);
  const nextUpdate = nextRunCountdown(monitorStatus, nowMs, countdownBaseMs);
  const activeDrivers = (driverAttention?.states ?? [])
    .filter((item) => ["active", "active_macro"].includes(normalizeMarketAgentValue(item.current_state)))
    .sort((left, right) => (right.relevance_score ?? 0) - (left.relevance_score ?? 0));
  const watchingDrivers = (driverAttention?.states ?? [])
    .filter((item) => ["watching", "emerging", "cooling"].includes(normalizeMarketAgentValue(item.current_state)))
    .sort((left, right) => (right.relevance_score ?? 0) - (left.relevance_score ?? 0));
  const backgroundDrivers = (driverAttention?.states ?? [])
    .filter((item) => ["dormant", "retired", "unknown", ""].includes(normalizeMarketAgentValue(item.current_state)))
    .sort((left, right) => (right.relevance_score ?? 0) - (left.relevance_score ?? 0));
  const visibleDrivers = [...activeDrivers, ...watchingDrivers, ...backgroundDrivers].slice(0, 8);

  return (
    <section className="market-agent-cockpit" data-qa="qa:market-agent:cockpit">
      <div className="market-agent-kpi-grid">
        <article className="market-agent-kpi-card market-agent-price-card">
          <div className="market-agent-kpi-head">
            <h3>XAUUSD (Spot)</h3>
            <span className="market-agent-source-dot">
              <span className={sourceType === "spot" ? "spot" : "proxy"} />
              {priceSourceLabel}
            </span>
          </div>
          <div className="market-agent-price-value-row">
            <strong>
              <MarketAgentValuePulse value={priceValue ?? xauusdHealth?.current_value}>
                {formatPrice(priceValue ?? xauusdHealth?.current_value, "No price")}
              </MarketAgentValuePulse>
            </strong>
            <span className={`market-agent-price-change ${priceChangeTone}`}>
              <MarketAgentValuePulse value={`${computedPriceChange ?? "--"}-${priceChangePercent ?? "--"}`}>
                {computedPriceChange === null ? "--" : `${formatSignedPriceChange(computedPriceChange)} (${formatPercentChange(priceChangePercent)})`}
              </MarketAgentValuePulse>
            </span>
          </div>
          <div className="market-agent-price-data">
            <em>Data:</em>
            <b><MarketAgentValuePulse value={displayProviderStatus}>{displayProviderStatus}</MarketAgentValuePulse></b>
            {dataFreshness ? (
              <span>
                (<MarketAgentValuePulse value={dataFreshness}>{dataFreshness}</MarketAgentValuePulse>)
              </span>
            ) : null}
          </div>
        </article>
        <article className="market-agent-kpi-card market-agent-state-card">
          <div className="market-agent-kpi-head">
            <h3>Market State</h3>
          </div>
          <strong className={`market-agent-state-value ${marketTone}`}>
            <MarketAgentValuePulse value={state?.current_bias}>
              {formatMarketStateLabel(state?.current_bias)}
            </MarketAgentValuePulse>
            <span>{marketStateArrow(state?.current_bias)}</span>
          </strong>
          <div className="market-agent-state-details market-agent-kpi-detail-stack">
            <span className="market-agent-kpi-subline">
              <span>Since</span>
              <b data-kpi-detail="state-since" title={stateSinceFull}>{stateSinceCompact}</b>
            </span>
            <div className="market-agent-kpi-mini-metrics" aria-label="Market state detail metrics">
              <span>
                <em>Strength</em>
                <b data-kpi-detail="state-strength"><MarketAgentValuePulse value={marketStrength}>{marketStrength}</MarketAgentValuePulse></b>
              </span>
              <span>
                <em>Confidence</em>
                <b data-kpi-detail="state-confidence"><MarketAgentValuePulse value={state?.confidence}>{formatValue(state?.confidence, "--")}</MarketAgentValuePulse></b>
              </span>
            </div>
          </div>
        </article>
        <article className="market-agent-kpi-card market-agent-move-card">
          <div className="market-agent-kpi-head">
            <h3>Latest Move</h3>
          </div>
          <strong className={`market-agent-move-type ${latestMove.tone}`}>
            <MarketAgentValuePulse value={latestMove.label}>
              {latestMove.label}
            </MarketAgentValuePulse>
            <span>{latestMove.arrow}</span>
          </strong>
          <div className="market-agent-move-details market-agent-kpi-detail-stack">
            <span className="market-agent-kpi-subline">
              <span>Detected</span>
              <b data-kpi-detail="move-detected">{formatClockTime(state?.last_alert_time)}</b>
            </span>
            <div className="market-agent-kpi-mini-metrics" aria-label="Latest move detail metrics">
              <span>
                <em>Move Size</em>
                <b className={latestMoveSizeTone} data-kpi-detail="move-size"><MarketAgentValuePulse value={latestMoveLabel}>{latestMoveLabel}</MarketAgentValuePulse></b>
              </span>
              <span>
                <em>Duration</em>
                <b data-kpi-detail="move-duration">{formatMoveDuration(price, state?.last_alert_time, nowMs)}</b>
              </span>
            </div>
          </div>
        </article>
        <article className="market-agent-kpi-card market-agent-evidence-score-card">
          <div className="market-agent-kpi-head">
            <h3>Evidence Status</h3>
          </div>
          <div className="market-agent-evidence-score">
            <div
              className="market-agent-score-ring"
              data-score-target={String(clampedEvidenceScore)}
            >
              <svg className="market-agent-score-svg" viewBox="0 0 80 80" aria-hidden="true">
                <circle className="market-agent-score-track" cx="40" cy="40" r={SCORE_RING_RADIUS} />
                <circle
                  className={`market-agent-score-progress${isEvidenceScoreEmpty ? " is-empty" : ""}${isEvidenceScoreFull ? " is-full" : ""}`}
                  cx="40"
                  cy="40"
                  r={SCORE_RING_RADIUS}
                  strokeDasharray={isEvidenceScoreFull ? undefined : SCORE_RING_CIRCUMFERENCE}
                  strokeDashoffset={isEvidenceScoreFull ? undefined : evidenceScoreDashOffset}
                />
              </svg>
              <div className="market-agent-score-content">
                <strong className="market-agent-score-value">
                  <span className="market-agent-score-number">{evidenceScore}</span>
                  <span className="market-agent-score-suffix">%</span>
                </strong>
                <span className="market-agent-score-strength">{evidenceScoreLabel}</span>
              </div>
            </div>
            <div className="market-agent-evidence-counts">
              <span><i className="supporting" /><span>Supporting</span><b><MarketAgentValuePulse value={supportingCount}>{supportingCount}</MarketAgentValuePulse></b></span>
              <span><i className="neutral" /><span>Neutral</span><b><MarketAgentValuePulse value={neutralCount}>{neutralCount}</MarketAgentValuePulse></b></span>
              <span><i className="contrary" /><span>Contrary</span><b><MarketAgentValuePulse value={contraryCount}>{contraryCount}</MarketAgentValuePulse></b></span>
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
            <div className="market-agent-next-main">
              <span className="market-agent-clock-icon market-agent-clock-icon-animated" aria-hidden="true" />
              <strong><MarketAgentRollingCountdown seconds={nextUpdate.seconds} /></strong>
            </div>
            <div className="market-agent-next-meta">
              <span>{snapshot?.available ? "Auto monitoring" : "Not running"}</span>
              <small>Every {nextUpdate.intervalSeconds} seconds</small>
            </div>
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
            {visibleDrivers.map((driver, index) => {
              const attention = attentionLabel(driver);
              const impact = formatDriverImpact(driver);
              return (
                <div
                  className="market-agent-attention-table-row market-agent-animated-row"
                  role="row"
                  key={driver.driver_id}
                  style={{ "--ma-row-index": index } as CSSProperties}
                >
                  <strong>{driver.label || formatDriverLabel(driver.driver_id)}</strong>
                  <span className={`market-agent-driver-state state-${normalizeMarketAgentValue(driver.current_state)}`}>
                    {formatDriverStateLabel(driver.current_state)}
                  </span>
                  <span
                    className={driverImpactTone(driver)}
                    data-market-agent-attention-cell="impact"
                  >
                    {impact}
                  </span>
                  <span
                    className={`market-agent-attention-text attention-${normalizeMarketAgentValue(attention)}`}
                    title={attention}
                  >
                    {attention}
                  </span>
                  <span data-market-agent-attention-cell="score">{formatScore(driver.relevance_score)}</span>
                </div>
              );
            })}
            {visibleDrivers.length === 0 ? (
              <div className="market-agent-empty-state">No active or watching drivers.</div>
            ) : null}
          </div>
        </section>

        <section className="market-agent-cockpit-panel market-agent-replay-panel">
          <div className="market-agent-panel-title-row">
            <h3>Market Replay <span>({replayRange === "month" ? "Month" : "Day"})</span></h3>
            <div className="market-agent-range-tabs" role="group" aria-label="Replay range">
              {replayRangeOptions.map((item) => (
                <button
                  type="button"
                  key={item.value}
                  className={replayRange === item.value ? "active" : ""}
                  aria-pressed={replayRange === item.value}
                  title={item.hint}
                  onClick={() => setReplayRange(item.value)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
          <div className="market-agent-timeline-track">
            {timeline.map((item, index) => {
              const kind = inferTimelineKind(item);
              const meta = timelineKindMeta[kind];
              return (
                <button
                  type="button"
                  key={item.key}
                  className={`market-agent-timeline-track-row market-agent-animated-row kind-${meta.tone}`}
                  style={{ "--ma-row-index": index } as CSSProperties}
                  onClick={() => item.monitorRunId && onSelectRun(item.monitorRunId)}
                >
                  <time>{formatReplayTime(item.time)}</time>
                  <span className="market-agent-timeline-node" aria-hidden="true" />
                  <div className="market-agent-timeline-body">
                    <div className="market-agent-timeline-title-row">
                      <strong>{compactTimelineTitle(item)}</strong>
                      <span className={`market-agent-event-tag tone-${meta.tone}`}>{meta.tag}</span>
                    </div>
                    <div className="market-agent-timeline-meta-row">
                      <span>{item.meta}</span>
                      <small>{formatTimelineImpact(item)}</small>
                    </div>
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

        <section className="market-agent-cockpit-panel market-agent-evidence-panel">
          <div className="market-agent-panel-title-row">
            <h3>Latest Evidence <span>({evidenceRunTime})</span></h3>
            <button type="button" className="market-agent-panel-link" onClick={() => onNavigate("evidence")}>
              View All
            </button>
          </div>
          <div className="market-agent-evidence-tabs" role="tablist" aria-label="Evidence filters">
            {evidenceFilterOptions.map((item) => (
              <button
                type="button"
                role="tab"
                key={item.value}
                className={evidenceFilter === item.value ? "active" : ""}
                aria-selected={evidenceFilter === item.value}
                onClick={() => setEvidenceFilter(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="market-agent-evidence-feed">
            {evidence.map((item, index) => {
              const meta = evidenceKindMeta(item.kind);
              return (
                <div
                  className={`market-agent-evidence-feed-row market-agent-animated-row tone-${meta.tone}`}
                  key={`${item.title}-${index}`}
                  style={{ "--ma-row-index": index } as CSSProperties}
                >
                  <span className="market-agent-evidence-icon">{meta.icon}</span>
                  <div>
                    <span className="market-agent-evidence-type">{meta.label}</span>
                    <strong>{item.title}</strong>
                    <span>{item.detail}</span>
                  </div>
                  <time>{formatReplayTime(item.time, evidenceRunTime)}</time>
                  <span
                    className={`market-agent-evidence-status-text tone-${evidenceStatusTone(item.status)}`}
                    title={item.status}
                  >
                    {humanizeMarketAgentValue(item.status)}
                  </span>
                </div>
              );
            })}
            {evidence.length === 0 ? <div className="market-agent-empty-state">No evidence in this category.</div> : null}
          </div>
          <div className="market-agent-evidence-footer">
            <span><i /> Evidence Quality: <b>{evidenceScoreLabel} ({evidenceScore}%)</b></span>
            <span>{supportingCount} Supporting, {neutralCount} Neutral, {contraryCount} Contrary</span>
          </div>
        </section>
      </div>

    </section>
  );
}

export function MarketAgentPage(props: MarketAgentPageProps) {
  const [section, setSection] = useState<MarketAgentSection>("live");
  const replayPayload = useMemo(() => normalizeMarketAgentReplayPayload(props.replay?.replay), [props.replay]);
  const normalizedReplay = useMemo<MarketAgentReplayResponse | null>(() => {
    if (!props.replay) return null;
    return { ...props.replay, replay: replayPayload };
  }, [props.replay, replayPayload]);
  const currentAlertNoticeIds = useMemo(() => alertNoticeIds(normalizedReplay), [normalizedReplay]);
  const currentAlertNoticeKey = currentAlertNoticeIds.join("\n");
  const [seenAlertIds, setSeenAlertIds] = useState<string[]>(() => readSeenAlertIds());
  const seenAlertIdSet = useMemo(() => new Set(seenAlertIds), [seenAlertIds]);

  useEffect(() => {
    if (section !== "alerts" || currentAlertNoticeIds.length === 0) return;
    setSeenAlertIds((previous) => {
      const merged = new Set(previous);
      let changed = false;
      currentAlertNoticeIds.forEach((id) => {
        if (!merged.has(id)) {
          merged.add(id);
          changed = true;
        }
      });
      if (!changed) return previous;
      const next = Array.from(merged).slice(-250);
      writeSeenAlertIds(next);
      return next;
    });
  }, [currentAlertNoticeIds, currentAlertNoticeKey, section]);

  const content = useMemo(() => {
    if (section === "live") {
      return (
        <MarketAgentDashboard
          snapshot={props.snapshot}
          providerHealth={props.providerHealth}
          driverAttention={props.driverAttention}
          replay={normalizedReplay}
          selectedEvidence={props.selectedEvidence}
          monitorStatus={props.monitorStatus}
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
          replay={normalizedReplay}
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
          providerHealth={props.providerHealth}
          localAiSetup={props.localAiSetup ?? null}
          localAiPullProgress={props.localAiPullProgress ?? null}
          onSave={props.onSaveProviderConfig}
          onClear={props.onClearProviderConfig}
          onTestConnection={props.onTestCTraderConnection}
          onResolveSymbol={props.onResolveCTraderSymbol}
          onQuoteTest={props.onGetCTraderQuoteTest}
          onStartCTraderConnect={props.onStartCTraderConnect}
          onTestCTraderBackfill={props.onTestCTraderBackfill}
          onSaveTelegram={props.onSaveTelegramConfig}
          onTestTelegram={props.onTestTelegramMessage}
          onSaveLLM={props.onSaveLLMConfig}
          onTestLLMConnection={props.onTestLLMConnection}
          onTestLLMJsonResponse={props.onTestLLMJsonResponse}
          onDetectLocalAI={props.onDetectLocalAI}
          onInstallRecommendedModel={props.onInstallRecommendedModel}
          onCancelModelDownload={props.onCancelModelDownload}
          onBenchmarkLLM={props.onBenchmarkLLM}
          onApplyLLMFallbackPolicy={props.onApplyLLMFallbackPolicy}
          monitorStatus={props.monitorStatus}
          onRunMonitorOnce={props.onRunMonitorOnce}
          onRunBackfillRecovery={props.onRunBackfillRecovery}
          onStartMonitorLoop={props.onStartMonitorLoop}
          onStopMonitorLoop={props.onStopMonitorLoop}
        />
      );
    }
    if (section === "alerts") {
      const attentionAlerts = replayPayload.alerts;
      const suppressedAlerts = replayPayload.suppressed_alerts;
      const alertRows = attentionAlerts.map((alert, index) => ({
          key: `alert-${index}`,
          kind: "attention" as const,
          index: index + 1,
          title: alertTitle(alert.message),
          detail: alertDriverDetail(alert.main_driver, alert.message),
          time: String(alert.run_started_at ?? ""),
          badge: "Needs attention",
          tone: "warn" as const
        }));
      const attentionLabel = `${attentionAlerts.length} attention item${attentionAlerts.length === 1 ? "" : "s"}`;
      const hiddenLabel = `${suppressedAlerts.length} quiet repeat${suppressedAlerts.length === 1 ? "" : "s"} hidden`;
      const telegramEnabled = Boolean(props.telegramConfig?.telegram?.enabled);
      const renderAlertCard = (alert: (typeof alertRows)[number]) => (
        <article className={`market-agent-alert-card ${alert.kind}`} data-alert-kind={alert.kind} key={alert.key}>
          <span className="market-agent-alert-index">Attention</span>
          <div className="market-agent-alert-main">
            <div className="market-agent-alert-title-row">
              <strong>{alert.title}</strong>
              <MarketAgentStatusBadge label={alert.badge} tone={alert.tone} />
            </div>
            <span>{alert.detail}</span>
          </div>
          <time className="market-agent-alert-time" dateTime={alert.time}>
            {formatShortTime(alert.time)}
          </time>
        </article>
      );
      return (
        <section className="market-agent-surface market-agent-alerts-surface">
          <div className="market-agent-surface-header">
            <div>
              <h2>Alerts</h2>
              <span className="hint">
                {telegramEnabled
                  ? "Important market alerts delivered by your alert settings"
                  : "Important market alerts. Telegram is off, so nothing is sent there."}
              </span>
            </div>
          </div>
          <div className="market-agent-alerts-summary-line" aria-label="Alert summary">
            <strong>{attentionLabel}</strong>
            <span>/ {hiddenLabel}</span>
          </div>
          {alertRows.length ? (
            <div className="market-agent-alerts-list" data-qa="qa:market-agent:alerts-list">
              {alertRows.map(renderAlertCard)}
            </div>
          ) : (
            <div className="market-agent-empty-state">No alerts in this replay window.</div>
          )}
        </section>
      );
    }
    return null;
  }, [normalizedReplay, props, replayPayload, section]);

  const alertNoticeCount = currentAlertNoticeIds.filter((id) => !seenAlertIdSet.has(id)).length;

  return (
    <div className="market-agent-page market-agent-cockpit-shell" data-qa="qa:page:market-agent">
      <aside className="market-agent-side-nav">
        <nav aria-label="Market Agent sections">
          {sectionGroups.map((group) => (
            <div className="market-agent-side-group" key={group.label}>
              <span>{group.label}</span>
              {group.items.map((item) => {
                const badgeCount = item.id === "alerts" ? alertNoticeCount : 0;
                const displayLabel = item.id === "replay" ? "Replay" : item.label;
                return (
                  <button
                    type="button"
                    key={item.id}
                    aria-label={badgeCount ? `${item.label}, ${badgeCount} notifications` : item.label}
                    aria-pressed={section === item.id}
                    className={section === item.id ? "active" : ""}
                    data-market-agent-section={item.id}
                    onClick={() => setSection(item.id)}
                  >
                    <MarketAgentNavIcon name={item.icon} />
                    <span className="market-agent-nav-label">{displayLabel}</span>
                    {badgeCount > 0 ? <span className="market-agent-nav-badge" key={badgeCount}>{badgeCount}</span> : null}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
      </aside>
      <main className="market-agent-cockpit-main">{content}</main>
    </div>
  );
}
