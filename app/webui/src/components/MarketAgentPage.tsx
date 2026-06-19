import { type CSSProperties, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  MarketAgentDriverAttentionResponse,
  MarketAgentEvidenceForRunResponse,
  MarketAgentLiveQuoteResponse,
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
import { MarketAgentActivity } from "./MarketAgentActivity";
import { MarketAgentDriverAttention } from "./MarketAgentDriverAttention";
import { MarketAgentEvidencePanel } from "./MarketAgentEvidencePanel";
import { MarketAgentMacroMicroFocus } from "./MarketAgentMacroMicroFocus";
import { MarketAgentProviderHealth } from "./MarketAgentProviderHealth";
import { MarketAgentReplay } from "./MarketAgentReplay";
import { MarketAgentStatusBadge } from "./MarketAgentStatusBadge";
import {
  findProviderHealth,
  formatDriverLabel,
  formatShortTime,
  humanizeMarketAgentValue,
  normalizeMarketAgentValue,
  parseMarketAgentTimestampMs,
} from "../utils/marketAgentUi";
import { normalizeMarketAgentReplayPayload } from "../utils/marketAgentReplay";
import { backend } from "../api";
import "./MarketAgentPage.css";

export type MarketAgentSection =
  | "live"
  | "drivers"
  | "replay"
  | "evidence"
  | "providers"
  | "activity"
  | "sources"
  | "alerts";

type MarketAgentPageProps = {
  activeSection?: MarketAgentSection;
  snapshot: MarketAgentSnapshotResponse | null;
  providerConfig: MarketAgentProviderConfigResponse | null;
  telegramConfig: MarketAgentTelegramConfigResponse | null;
  llmConfig: MarketAgentLLMConfigResponse | null;
  localAiSetup?: MarketAgentLLMSetupResponse | null;
  localAiPullProgress?: MarketAgentOllamaPullProgress | null;
  liveQuote?: MarketAgentLiveQuoteResponse | null;
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
  onSectionChange?: (section: MarketAgentSection) => void;
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
  | "activity"
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
      { id: "activity", label: "Activity", icon: "activity" },
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
  if (name === "activity") {
    return (
      <svg {...common}>
        <path d="M4.4 12h3.4" />
        <path d="M16.2 12h3.4" />
        <path d="M10.2 6.2h3.6" />
        <path d="M10.2 17.8h3.6" />
        <circle cx="12" cy="12" r="2.7" />
        <circle cx="6.2" cy="12" r="1.6" />
        <circle cx="17.8" cy="12" r="1.6" />
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

const rawText = (value: unknown) => String(value ?? "").trim();

const objectValue = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const nestedObjectValue = (entry: Record<string, unknown> | null | undefined, key: string): Record<string, unknown> | null =>
  objectValue(entry?.[key]);

const textListValue = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((item) => rawText(item)).filter(Boolean) : [];

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
  const candidates = [
    item?.display_title,
    item?.ai_title,
    item?.short_title,
    item?.summary_title,
    fallback,
    item?.title,
    item?.summary,
    item?.description
  ];
  for (const value of candidates) {
    const text = rawText(value);
    if (text && !isReadableMarketTitle(text) && candidates.some((candidate) => rawText(candidate) && isReadableMarketTitle(rawText(candidate)))) continue;
    if (text) return text;
  }
  return fallback;
};

const MARKET_TITLE_VERBS =
  /\b(is|are|was|were|be|being|been|will|would|could|should|may|might|can|says|said|warns|warned|signals|signaled|announces|announced|expects|expected|hits|hit|jumps|jumped|falls|fell|drops|dropped|slips|slipped|rises|rose|surges|surged|eases|eased|extends|extended|keeps|kept|weighs|weighed|drives|drove|pressures|pressured|opens|opened|closes|closed|cuts|cut|raises|raised|denies|denied|confirms|confirmed|threatens|threatened|disrupts|disrupted|sanctions|sanctioned)\b/i;

const isReadableMarketTitle = (title: string) => {
  const words = title.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 7) return true;
  if (words.length < 5) return false;
  return MARKET_TITLE_VERBS.test(title);
};

function MarketAgentValuePulse({
  value,
  children,
  className = "",
  animate = true
}: {
  value: unknown;
  children: ReactNode;
  className?: string;
  animate?: boolean;
}) {
  const valueKey = typeof value === "object" ? JSON.stringify(value ?? "") : String(value ?? "");
  if (!animate) {
    return (
      <span className={`market-agent-value-stable ${className}`.trim()}>
        {children}
      </span>
    );
  }
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
  return parseMarketAgentTimestampMs(value);
};

const compareTimelineTimeAsc = (left: unknown, right: unknown) => {
  const leftMs = parseTimestampMs(left);
  const rightMs = parseTimestampMs(right);
  if (leftMs !== null && rightMs !== null) return leftMs - rightMs;
  if (leftMs !== null) return -1;
  if (rightMs !== null) return 1;
  return String(left ?? "").localeCompare(String(right ?? ""));
};

const compareTimelineTimeDesc = (left: unknown, right: unknown) =>
  compareTimelineTimeAsc(right, left);

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

const formatReplayTime = (value: unknown, fallback = "--", includeDate = false) => {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  if (includeDate) {
    return `${padDatePart(parsed.getDate())}-${padDatePart(parsed.getMonth() + 1)} ${parsed.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit"
    })}`;
  }
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

const marketReadMovePercent = (marketRead: Record<string, unknown> | null | undefined) => {
  const move = objectValue(marketRead?.move);
  return numberValue(
    move?.impact_percent ??
      move?.move_percent ??
      move?.change_percent ??
      move?.change_pct ??
      marketRead?.impact_percent
  );
};

const marketReadMoveTime = (marketRead: Record<string, unknown> | null | undefined) => {
  const move = objectValue(marketRead?.move);
  return rawText(move?.detected_at ?? move?.time ?? marketRead?.run_started_at ?? marketRead?.last_analysis_time);
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
  if (seconds < 3) return "";
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

const isFreshTimestamp = (value: unknown, nowMs: number, maxAgeSeconds: number, referenceValue?: unknown) => {
  const timestamp = parseTimestampMs(value);
  if (timestamp === null) return false;
  const reference = parseTimestampMs(referenceValue) ?? nowMs;
  return reference - timestamp <= maxAgeSeconds * 1000;
};

const hasFreshCTraderSpotQuote = (item: MarketAgentProviderHealthEntry | null | undefined, nowMs: number) =>
  Boolean(
    item?.is_available &&
    isCTraderSpotSource(item) &&
    normalizeMarketAgentValue(item.data_mode) === "live_seen" &&
    isFreshTimestamp(item.fetched_at, nowMs, 300) &&
    isFreshTimestamp(item.data_timestamp ?? item.fetched_at, nowMs, 90, item.fetched_at)
  );

const isLiveXauusdSpot = (item: MarketAgentProviderHealthEntry | null | undefined, nowMs: number) =>
  Boolean(hasFreshCTraderSpotQuote(item, nowMs) && !hasMarketClosedReason(item));

const hasFreshCTraderSpotPrice = (item: MarketAgentProviderHealthEntry | null | undefined, nowMs: number) =>
  Boolean(
    item?.is_available &&
    isCTraderSpotSource(item) &&
    numberValue(item.current_value) !== null &&
    !isSavedCTraderSnapshot(item) &&
    !hasMarketClosedReason(item) &&
    isFreshTimestamp(item.fetched_at ?? item.data_timestamp, nowMs, 300) &&
    isFreshTimestamp(item.data_timestamp ?? item.fetched_at, nowMs, 90, item.fetched_at)
  );

const hasFreshRuntimeLiveQuote = (liveQuote: MarketAgentLiveQuoteResponse | null | undefined, nowMs: number) => {
  const quote = liveQuote?.quote;
  if (!quote) return false;
  const price = numberValue(quote.mid ?? quote.bid ?? quote.ask);
  return Boolean(price !== null && isFreshTimestamp(quote.timestamp, nowMs, 90));
};

const isCTraderSpotSource = (item: MarketAgentProviderHealthEntry | null | undefined) => {
  const sourceType = normalizeMarketAgentValue(item?.source_type);
  return sourceType === "spot" || sourceType === "spot_snapshot";
};

const isSavedCTraderSnapshot = (item: MarketAgentProviderHealthEntry | null | undefined) =>
  Boolean(
    item?.is_available &&
    isCTraderSpotSource(item) &&
    (
      normalizeMarketAgentValue(item.data_mode) === "snapshot" ||
      normalizeMarketAgentValue(item.source_type) === "spot_snapshot" ||
      normalizeMarketAgentValue(item.stale_reason).includes("saved ctrader quote snapshot")
    )
  );

const hasMarketClosedReason = (item: MarketAgentProviderHealthEntry | null | undefined) => {
  const reason = String(item?.stale_reason || item?.error || "").toLowerCase();
  return /market\s+(is\s+)?closed|market\s+reopens/.test(reason);
};

const isMarketClosedSpot = (item: MarketAgentProviderHealthEntry | null | undefined) =>
  Boolean(
    item?.is_available &&
    item.is_stale &&
    isCTraderSpotSource(item) &&
    numberValue(item.current_value) !== null &&
    !isSavedCTraderSnapshot(item) &&
    hasMarketClosedReason(item)
  );

const isStaleCTraderSpotSnapshot = (item: MarketAgentProviderHealthEntry | null | undefined, nowMs: number) =>
  Boolean(
    item?.is_available &&
    isCTraderSpotSource(item) &&
    numberValue(item.current_value) !== null &&
    !isSavedCTraderSnapshot(item) &&
    !isMarketClosedSpot(item) &&
    !hasFreshCTraderSpotQuote(item, nowMs) &&
    (
      item.is_stale ||
      normalizeMarketAgentValue(item.data_mode) === "stale" ||
      hasExpiredLiveXauusdSpot(item, nowMs)
    )
  );

function hasExpiredLiveXauusdSpot(
  item: MarketAgentProviderHealthEntry | null | undefined,
  nowMs: number
) {
  return Boolean(
    item?.is_available &&
    !item.is_stale &&
    normalizeMarketAgentValue(item.source_type) === "spot" &&
    normalizeMarketAgentValue(item.data_mode) === "live_seen" &&
    (
      !isFreshTimestamp(item.fetched_at, nowMs, 300) ||
      !isFreshTimestamp(item.data_timestamp ?? item.fetched_at, nowMs, 90, item.fetched_at)
    )
  );
}

const liveXauusdStatus = (item: MarketAgentProviderHealthEntry | null | undefined, nowMs: number = Date.now()) => {
  if (isSavedCTraderSnapshot(item)) return { label: "cTrader connecting", data: "Connecting to live", valueMode: "waiting" as const };
  if (isMarketClosedSpot(item)) return { label: "Market closed", data: "Market closed", valueMode: "closed" as const };
  if (isLiveXauusdSpot(item, nowMs) || hasFreshCTraderSpotPrice(item, nowMs)) {
    return { label: "cTrader (Spot)", data: "Live", valueMode: "live" as const };
  }
  if (isStaleCTraderSpotSnapshot(item, nowMs)) {
    return { label: "cTrader reconnecting", data: "Last live quote", valueMode: "waiting" as const };
  }
  if (hasExpiredLiveXauusdSpot(item, nowMs)) return { label: "cTrader reconnecting", data: "Stale", valueMode: "waiting" as const };
  return { label: "cTrader not connected", data: "No live quote", valueMode: "waiting" as const };
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
  source?: string;
  payload?: Record<string, unknown>;
};

type MarketAgentDetailItem = {
  title: string;
  detail: string;
  source: string;
  time: string;
  tag: string;
  url?: string;
  monitorRunId?: number;
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

const timelineRowDetail = (item: TimelineRow): MarketAgentDetailItem => {
  const kind = inferTimelineKind(item);
  return {
    title: compactTimelineTitle(item),
    detail: summaryText(item.payload, item.meta || item.title),
    source: itemSourceLabel(item.payload, item.meta || timelineKindMeta[kind].title),
    time: item.time,
    tag: timelineKindMeta[kind].tag,
    url: firstUrlValue(item.payload),
    monitorRunId: item.monitorRunId
  };
};

const evidenceRowDetail = (item: DashboardEvidenceRow): MarketAgentDetailItem => ({
  title: item.title,
  detail: item.detail,
  source: item.source || itemSourceLabel(item.payload, item.kind),
  time: item.time,
  tag: item.kind.toUpperCase(),
  url: firstUrlValue(item.payload)
});

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
  if (item.source === "calendar") {
    const impact = String(item.payload?.impact ?? "").toLowerCase();
    const contextType = String(item.payload?.context_type ?? "");
    if (impact === "holiday" || contextType === "liquidity_context") return "Liquidity context";
    return "Calendar context";
  }
  const payloadImpact = numberValue(item.payload?.impact_percent);
  const segment = item.payload?.segment as Record<string, unknown> | undefined;
  const segmentImpact = numberValue(segment?.move_percent);
  const impact = payloadImpact ?? segmentImpact;
  if (impact === null) return "Context only";
  return `Impact: ${formatSignedValue(impact, "%")}`;
};

const timelineImpactValue = (item: TimelineRow) => {
  const payloadImpact = numberValue(item.payload?.impact_percent);
  const segment = item.payload?.segment as Record<string, unknown> | undefined;
  const segmentImpact = numberValue(segment?.move_percent);
  return payloadImpact ?? segmentImpact;
};

const observedPriceMoveRow = (payload: MarketAgentReplayPayload | undefined): TimelineRow | null => {
  const rows = payload?.price_series ?? [];
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
    title: `Observed XAUUSD ${direction === "down" ? "drop" : "rise"} ${formatSignedValue(movePercent, "%")}`,
    meta: "Price action",
    status: "observed",
    payload: {
      semantic_type: Math.abs(movePercent) >= 0.18 ? "breakout" : "range",
      impact_percent: movePercent,
      direction,
      main_driver: "price_action",
      summary: `XAUUSD moved ${formatSignedValue(movePercent, "%")} between the latest stored price bars.`
    },
    source: "event"
  };
};

const timelineDriverValue = (item: TimelineRow) =>
  normalizeMarketAgentValue(item.payload?.main_driver ?? item.payload?.driver ?? item.meta);

const hasMarketReadObservation = (item: TimelineRow) => {
  const marketRead =
    objectValue(item.payload?.market_read) ??
    objectValue(objectValue(item.payload?.analysis)?.market_read) ??
    objectValue(objectValue(item.payload?.analysis_result)?.market_read);
  if (!marketRead) return false;
  const headline = rawText(marketRead.headline ?? marketRead.summary_title);
  const status = normalizeMarketAgentValue(marketRead?.status ?? item.payload?.cause_status ?? item.status);
  return Boolean(headline && !["", "unknown"].includes(normalizeMarketAgentValue(headline)) && status !== "context_only");
};

const isInternalReviewStatusRow = (item: TimelineRow) => {
  const semanticType = normalizeMarketAgentValue(item.payload?.semantic_type ?? item.type);
  const eventType = normalizeMarketAgentValue(item.type);
  const summary = normalizeMarketAgentValue(item.payload?.summary ?? item.payload?.causal_chain ?? item.title);
  const tradeConclusion = item.payload?.trade_conclusion;
  return Boolean(
    semanticType === "context_review" ||
      eventType === "context_review" ||
      tradeConclusion === false ||
      summary.includes("needs_fresh_live_price") ||
      summary.includes("needs fresh live price") ||
      summary.includes("recent price history")
  );
};

const isContextOnlyAnalysisRow = (item: TimelineRow) => {
  if (item.source !== "event") return false;
  if (hasMarketReadObservation(item)) return false;
  const driver = timelineDriverValue(item);
  const impact = timelineImpactValue(item);
  const causeStatus = normalizeMarketAgentValue(item.payload?.cause_status ?? item.status);
  const summary = normalizeMarketAgentValue(item.payload?.summary ?? item.payload?.causal_chain);
  return (
    isInternalReviewStatusRow(item) ||
    !driver ||
    driver === "unknown" ||
    causeStatus === "unconfirmed" ||
    summary.includes("current_conclusion_is_paused") ||
    impact === 0
  );
};

const isAnalyzedNewsRow = (item: Record<string, unknown>) => {
  const summarySource = normalizeMarketAgentValue(item.summary_source);
  const reviewStatus = normalizeMarketAgentValue(item.review_status ?? item.evidence_status);
  const driver = normalizeMarketAgentValue(item.main_driver ?? item.driver);
  return Boolean(
    summarySource === "local_ai" ||
    reviewStatus.includes("accepted") ||
    reviewStatus.includes("used") ||
    (driver && driver !== "unknown") ||
    numberValue(item.impact_percent) !== null
  );
};

const timelineSourceTimestamp = (item: Record<string, unknown>) =>
  item.published_at ??
  item.first_seen_at ??
  item.last_seen_at ??
  item.scheduled_at ??
  item.timestamp_myt ??
  item.event_time ??
  item.timestamp ??
  "";

const isReplayNewsRow = (item: Record<string, unknown>) => {
  const title = String(item.title ?? item.summary_title ?? "").trim();
  if (!title) return false;
  const filterReason = normalizeMarketAgentValue(item.filter_reason ?? item.reason);
  const reviewStatus = normalizeMarketAgentValue(item.review_status ?? item.evidence_status ?? item.included);
  if (filterReason.includes("no_market_agent_keyword")) return false;
  if (item.included === false || ["false", "filtered", "excluded", "rejected", "dropped", "unreviewed_context"].includes(reviewStatus)) {
    return false;
  }
  return item.included === true || isAnalyzedNewsRow(item);
};

const isReplayCalendarRow = (item: Record<string, unknown>) => {
  const text = normalizeMarketAgentValue(`${item.title ?? ""} ${item.summary ?? ""} ${item.description ?? ""}`);
  if (!text) return false;
  const reviewStatus = normalizeMarketAgentValue(item.review_status ?? item.evidence_status ?? item.included);
  if (item.included === false || ["false", "filtered", "excluded", "rejected", "dropped"].includes(reviewStatus)) return false;
  const impact = normalizeMarketAgentValue(item.impact ?? item.importance ?? item.context_type ?? item.relevance_reason);
  const currency = normalizeMarketAgentValue(item.currency ?? item.country ?? item.region);
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

const marketTimelineStoryFingerprint = (value: unknown) => {
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
  const tokens = normalizeMarketAgentValue(String(value ?? "").replace(/short-seller/gi, "short seller"))
    .split(/[^a-z0-9]+/)
    .map((token) => stems[token] ?? token)
    .filter((token) => token && !stopwords.has(token));
  return tokens.length >= 5 ? tokens.slice(0, 14).join(" ") : "";
};

const uniqueTimelineSourceRows = (rows: Record<string, unknown>[], limit: number) => {
  const seen = new Set<string>();
  return [...rows]
    .sort((left, right) => (parseTimestampMs(timelineSourceTimestamp(right)) ?? 0) - (parseTimestampMs(timelineSourceTimestamp(left)) ?? 0))
    .filter((row) => {
      const title = String(row.title ?? row.summary_title ?? row.display_title ?? row.ai_title ?? row.short_title ?? "").trim();
      const link = String(row.link ?? row.url ?? row.guid ?? "").trim();
      const source = String(row.source ?? "").trim();
      const scheduled = String(row.scheduled_at ?? "").trim();
      const storyKey = marketTimelineStoryFingerprint(title);
      const key = storyKey
        ? `story:${storyKey}:${normalizeMarketAgentValue(source)}`
        : normalizeMarketAgentValue(`${title}|${link || source}|${scheduled && !link ? scheduled : ""}`);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
};

const isMajorTimelineEvent = (item: TimelineRow) => {
  const kind = inferTimelineKind(item);
  const impact = timelineImpactValue(item);
  const status = normalizeMarketAgentValue(item.status);
  const title = normalizeMarketAgentValue(item.title);
  if (isContextOnlyAnalysisRow(item)) return false;
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
  if (!item) return "Waiting";
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

const isCTraderSpotPriceRow = (row: Record<string, unknown>) => {
  const symbol = normalizeMarketAgentValue(row.symbol);
  const source = normalizeMarketAgentValue(row.source);
  const sourceType = normalizeMarketAgentValue(row.source_type);
  const dataMode = normalizeMarketAgentValue(row.data_mode);
  return (
    symbol === "xauusd" &&
    (source.includes("ctrader") || sourceType.includes("spot")) &&
    dataMode !== "local_csv_fallback" &&
    dataMode !== "stale" &&
    dataMode !== "unavailable"
  );
};

const latestCTraderSpotPriceRow = (payload: MarketAgentReplayPayload | undefined) =>
  [...(payload?.price_series ?? [])]
    .filter(isCTraderSpotPriceRow)
    .sort((left, right) =>
      (parseTimestampMs(right.data_timestamp ?? right.timestamp) ?? 0) -
      (parseTimestampMs(left.data_timestamp ?? left.timestamp) ?? 0)
    )[0];

const cTraderSpotChangeFromM1 = (
  currentPrice: number | null,
  liveQuoteRecord: Record<string, unknown> | undefined,
  liveQuoteM1Bar: Record<string, unknown> | null,
  replayPayload: MarketAgentReplayPayload | undefined,
  nowMs: number
) => {
  if (currentPrice === null) return null;
  const replayBar = latestCTraderSpotPriceRow(replayPayload);
  const bar = liveQuoteM1Bar ?? replayBar;
  if (!bar) return null;
  const quoteTimestamp = liveQuoteRecord?.timestamp ?? liveQuoteRecord?.data_timestamp;
  const barTimestamp = bar.data_timestamp ?? bar.timestamp ?? quoteTimestamp;
  const referenceMs = parseTimestampMs(quoteTimestamp) ?? nowMs;
  const barMs = parseTimestampMs(barTimestamp);
  if (barMs !== null && Math.abs(referenceMs - barMs) > 180_000) return null;
  const baseline = numberValue(bar.open ?? bar.open_price);
  if (baseline === null || baseline === 0) return null;
  const changeValue = currentPrice - baseline;
  const changePercent = (changeValue / baseline) * 100;
  if (!Number.isFinite(changeValue) || !Number.isFinite(changePercent)) return null;
  return { value: changeValue, percent: changePercent };
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

const alertReviewTitle = (alert: Record<string, unknown>) => {
  const message = typeof alert.message === "string" ? alert.message.trim() : "";
  if (message) return alertTitle(message);
  const reason = typeof alert.reason === "string" ? alert.reason.trim() : "";
  if (/does not require notification/i.test(reason)) return "Reviewed: no alert needed";
  return reason ? formatValue(reason, "Reviewed: no alert sent") : "Reviewed: no alert sent";
};

const alertReviewDetail = (alert: Record<string, unknown>) => {
  const reason = typeof alert.reason === "string" ? alert.reason.trim() : "";
  if (reason) return reason;
  return alertDriverDetail(alert.main_driver, alert.message);
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
  const replayNewsItems = uniqueTimelineSourceRows(payload.news_items.filter(isReplayNewsRow), DASHBOARD_REPLAY_PREVIEW_LIMIT);
  const replayCalendarEvents = uniqueTimelineSourceRows(payload.calendar_events.filter(isReplayCalendarRow), DASHBOARD_REPLAY_PREVIEW_LIMIT);
  const observedMove = observedPriceMoveRow(payload);
  const rows = [
    ...payload.timeline_events.map((item) => ({
      key: `event-${item.monitor_run_id}-${item.event_time}`,
      time: item.event_time,
      title: summaryTitle(item.payload, item.label),
      meta: formatDriverLabel(item.payload?.main_driver ?? "unknown"),
      status: item.event_type,
      monitorRunId: item.monitor_run_id,
      payload: item.payload,
      source: "event" as const
    })),
    ...replayNewsItems.map((item, index) => ({
      key: `news-${index}-${String(item.published_at ?? item.title ?? "")}`,
      time: String(timelineSourceTimestamp(item)),
      title: summaryTitle(item, String(item.title ?? "News item")),
      meta: String(item.source ?? "News"),
      status: item.data_mode ?? "possible",
      monitorRunId: undefined,
      payload: item,
      source: "news" as const
    })),
    ...replayCalendarEvents.map((item, index) => ({
      key: `calendar-${index}-${String(item.scheduled_at ?? item.title ?? "")}`,
      time: String(item.scheduled_at ?? ""),
      title: summaryTitle(item, String(item.title ?? "Calendar event")),
      meta: String(item.source ?? "Calendar"),
      status: item.data_mode ?? "possible",
      monitorRunId: undefined,
      payload: item,
      source: "calendar" as const
    })),
    ...payload.alerts
      .filter((item) => item.should_notify === true || item.shouldNotify === true)
      .filter((item) => !item.monitor_run_id || !eventRunIds.has(item.monitor_run_id))
      .map((item, index) => ({
        key: `alert-${index}-${item.monitor_run_id ?? index}`,
        time: String(item.run_started_at ?? ""),
        title: summaryTitle(item, String(item.message ?? "Alert")),
        meta: formatDriverLabel(item.main_driver ?? "unknown"),
        status: item.notification_level ?? "alert",
        monitorRunId: item.monitor_run_id,
        payload: item,
        source: "alert" as const
      }))
  ]
    .filter((item) => !isContextOnlyAnalysisRow(item))
    .filter((item) => item.time || item.title)
    .sort((left, right) => compareTimelineTimeDesc(left.time, right.time));
  return rows.length ? rows : observedMove ? [observedMove] : [];
};

const filterTimelineByReplayRange = (rows: TimelineRow[], range: ReplayRange) => {
  if (range === "month") return rows.filter(isMajorTimelineEvent);
  return rows;
};

const marketReadFromTimelineRows = (rows: TimelineRow[]): Record<string, unknown> | null => {
  for (const row of rows) {
    const payload = objectValue(row.payload);
    const marketRead =
      nestedObjectValue(payload, "market_read") ??
      nestedObjectValue(nestedObjectValue(payload, "analysis_result"), "market_read") ??
      nestedObjectValue(nestedObjectValue(payload, "evidence_packet"), "market_read");
    if (marketRead) return marketRead;
  }
  return null;
};

const marketReadTimelineRows = (marketRead: Record<string, unknown> | null | undefined): TimelineRow[] => {
  if (!marketRead || normalizeMarketAgentValue(marketRead.status) !== "current_read") return [];
  const impact = marketReadMovePercent(marketRead);
  const moveTime = marketReadMoveTime(marketRead);
  const headline = rawText(marketRead.headline);
  if (!headline && impact === null) return [];
  return [{
    key: `market-read-${moveTime || headline}`,
    time: moveTime,
    title: headline || "Current market read",
    meta: formatDriverLabel(marketRead.driver_label ?? marketRead.driver ?? "market_read"),
    status: marketRead.cause_status ?? marketRead.status,
    payload: {
      ...marketRead,
      semantic_type: impact !== null && Math.abs(impact) >= 0.18 ? "breakout" : "evidence",
      impact_percent: impact,
      main_driver: marketRead.driver ?? marketRead.driver_label,
      summary: marketRead.thesis
    },
    source: "event" as const
  }];
};

const monthSummaryTimelineRows = (payload: MarketAgentReplayPayload | undefined): TimelineRow[] => {
  if (!payload?.month_summary_events?.length) return [];
  return payload.month_summary_events
    .map((item) => ({
      key: `month-summary-${item.monitor_run_id}-${item.event_time}-${item.label}`,
      time: item.event_time,
      title: summaryTitle(item.payload, item.label),
      meta: formatDriverLabel(item.payload?.main_driver ?? item.payload?.driver ?? "unknown"),
      status: item.payload?.cause_status ?? item.event_type,
      monitorRunId: item.monitor_run_id,
      payload: item.payload,
      source: "event" as const
    }))
    .filter((item) => item.time || item.title)
    .sort((left, right) => compareTimelineTimeDesc(left.time, right.time));
};

const evidenceStatusLabel = (value: unknown, fallback = "Supporting") => {
  const normalized = normalizeMarketAgentValue(value);
  if (!normalized) return fallback;
  if (normalized.includes("context")) return "Context Only";
  if (normalized.includes("unavailable") || normalized.includes("missing") || normalized.includes("no_data")) {
    return "Not Available";
  }
  if (normalized.includes("blocked") || normalized.includes("rejected") || normalized.includes("contrary")) {
    return normalized.includes("contrary") ? "Contrary" : "Not used";
  }
  if (normalized.includes("neutral") || normalized.includes("background") || normalized.includes("not_confirming") || normalized.includes("unconfirmed")) {
    return "Neutral";
  }
  return "Supporting";
};

type EvidenceDirection = "bullish" | "bearish" | null;

const evidenceDirectionFromBias = (bias: unknown): EvidenceDirection => {
  const normalized = normalizeMarketAgentValue(bias);
  if (["bullish", "up", "long", "buy", "breakout"].some((token) => normalized.includes(token))) {
    return "bullish";
  }
  if (["bearish", "down", "short", "sell", "drop", "breakdown"].some((token) => normalized.includes(token))) {
    return "bearish";
  }
  return null;
};

const oppositeEvidenceDirection = (direction: EvidenceDirection): EvidenceDirection => {
  if (direction === "bullish") return "bearish";
  if (direction === "bearish") return "bullish";
  return null;
};

const evidenceDirectionText = (direction: EvidenceDirection, fallback: string) => {
  if (direction === "bullish") return "Bullish";
  if (direction === "bearish") return "Bearish";
  return fallback;
};

const displayEvidenceDirection = (status: string, direction: EvidenceDirection): "bullish" | "bearish" | "neutral" => {
  const normalized = normalizeMarketAgentValue(status);
  if (normalized === "bullish") return "bullish";
  if (normalized === "bearish") return "bearish";
  if (normalized === "supporting" && direction) return direction;
  if ((normalized === "contrary" || normalized === "blocked" || normalized === "rejected") && direction) {
    return oppositeEvidenceDirection(direction) ?? "neutral";
  }
  return "neutral";
};

const displayEvidenceStatusLabel = (status: string, direction: EvidenceDirection) => {
  return evidenceDirectionText(displayEvidenceDirection(status, direction), "Neutral");
};

const evidenceDirectionStatusFromItem = (item: Record<string, unknown> | undefined) => {
  const normalized = normalizeMarketAgentValue(
    item?.impact_direction_on_gold ??
      item?.xauusd_direction ??
      item?.direction_on_gold ??
      item?.direction
  );
  if (["bullish", "bullish_gold", "positive", "positive_gold", "xauusd_bullish"].includes(normalized)) {
    return "bullish";
  }
  if (["bearish", "bearish_gold", "negative", "negative_gold", "xauusd_bearish"].includes(normalized)) {
    return "bearish";
  }
  if (["neutral", "mixed", "balanced", "two_sided"].includes(normalized)) return "neutral";
  return "";
};

const shouldShowEvidenceDetailLine = (title: string, detail: string) => {
  const normalizedTitle = normalizeMarketAgentValue(title);
  const normalizedDetail = normalizeMarketAgentValue(detail);
  if (!normalizedDetail || normalizedTitle === normalizedDetail) return false;
  if (normalizedDetail.includes(normalizedTitle) || normalizedTitle.includes(normalizedDetail)) return false;
  return true;
};

const evidenceStatusTone = (status: string): "neutral" | "good" | "warn" | "bad" | "info" => {
  const normalized = normalizeMarketAgentValue(status);
  if (normalized === "bullish" || normalized === "supporting" || normalized === "aligned") return "good";
  if (normalized === "bearish" || normalized === "opposing") return "bad";
  if (normalized === "neutral" || normalized === "context" || normalized === "context_only") return "warn";
  if (normalized.includes("available")) return "neutral";
  if (normalized === "blocked" || normalized === "not_used") return "bad";
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

const evidenceChainStatus = (selectedEvidence: MarketAgentEvidenceForRunResponse | null) => {
  const packet = selectedEvidence?.payload?.evidence_packet as Record<string, unknown> | undefined;
  return (packet?.evidence_chain_status as Record<string, unknown> | undefined) ?? null;
};

const fallbackEvidenceChainStatus = (
  selectedEvidence: MarketAgentEvidenceForRunResponse | null,
  xauusdStatus: ReturnType<typeof liveXauusdStatus>
) => {
  if (xauusdStatus.valueMode !== "live") {
    return {
      status: "context_only",
      can_show_current_conclusion: false,
      reason:
        xauusdStatus.valueMode === "closed"
          ? "Market is closed. News and calendar context continue for the next live XAUUSD session."
          : "Connect cTrader and collect live XAUUSD history before driver conclusions can be shown.",
      missing_required: ["live_xauusd_spot", "xauusd_recent_history"],
      usable_inputs: [],
      context_only_inputs: []
    };
  }
  const chain = evidenceChainStatus(selectedEvidence);
  if (chain) return chain;
  return {
    status: "context_only",
    can_show_current_conclusion: false,
    reason: "Live price is available. Waiting for recent history review before driver conclusions can be shown.",
    missing_required: ["ai_review_inputs", "xauusd_recent_history"],
    usable_inputs: ["live_xauusd_spot"],
    context_only_inputs: []
  };
};

const canShowCurrentConclusion = (
  selectedEvidence: MarketAgentEvidenceForRunResponse | null,
  fallbackLiveReady: boolean,
  fallbackChain?: Record<string, unknown> | null
) => {
  const chain = fallbackChain ?? evidenceChainStatus(selectedEvidence);
  if (!chain || typeof chain.can_show_current_conclusion !== "boolean") return fallbackLiveReady;
  return chain.can_show_current_conclusion;
};

const evidenceChainList = (chain: Record<string, unknown> | null, key: string) =>
  (Array.isArray(chain?.[key]) ? chain?.[key] : []) as unknown[];

const latestRelatedAsset = (payload: MarketAgentReplayPayload | undefined, key: string) => {
  const rows = payload?.related_assets?.[key];
  if (!Array.isArray(rows) || rows.length === 0) return undefined;
  return [...rows].sort((left, right) =>
    compareTimelineTimeAsc(right.data_timestamp ?? right.timestamp ?? "", left.data_timestamp ?? left.timestamp ?? "")
  )[0];
};

const isUsableRelatedAsset = (asset: Record<string, unknown> | undefined) => {
  if (!asset) return false;
  const sourceType = normalizeMarketAgentValue(asset.source_type);
  const dataMode = normalizeMarketAgentValue(asset.data_mode);
  return (
    sourceType !== "local_csv_fallback" &&
    dataMode !== "local_csv_fallback" &&
    dataMode !== "stale" &&
    dataMode !== "unavailable" &&
    asset.is_stale !== true
  );
};

const isCurrentEvidenceSignal = (status: unknown) => {
  const normalized = normalizeMarketAgentValue(status);
  return ["confirming", "confirms", "supporting", "contradicting", "contradicts", "contrary", "blocked", "rejected"].includes(normalized);
};

const shouldShowRelatedEvidence = (
  asset: Record<string, unknown> | undefined,
  status: unknown,
  currentConclusionReady: boolean
) => {
  if (!asset || !isUsableRelatedAsset(asset)) return false;
  if (!currentConclusionReady) return false;
  return isCurrentEvidenceSignal(status);
};

const driverStateDetail = (
  driverAttention: MarketAgentDriverAttentionResponse | null,
  driverIds: string[],
  relatedAsset: Record<string, unknown> | undefined,
  fallback: string
) => {
  const directSummary = summaryText(relatedAsset);
  if (directSummary) return directSummary;
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
  if (!isUsableRelatedAsset(asset)) {
    return `${label} was collected, but the source is stale or imported, so it is not used as current evidence.`;
  }
  const sourceType = formatDataModeLabel(
    normalizeMarketAgentValue(asset?.source_type),
    formatValue(asset?.data_mode, "Collected")
  );
  return `${label} moved ${formatSignedValue(change, unit)} in the latest window. Source: ${sourceType}.`;
};

const latestTechnicalEvent = (payload: MarketAgentReplayPayload | undefined) =>
  [...(payload?.timeline_events ?? [])]
    .filter((item) => {
      const type = normalizeMarketAgentValue(item.payload?.semantic_type ?? item.event_type);
      return ["breakout", "reversal", "range"].includes(type);
    })
    .sort((left, right) => compareTimelineTimeAsc(right.event_time, left.event_time))
    .sort((left, right) => {
      const leftType = normalizeMarketAgentValue(left.payload?.semantic_type ?? left.event_type);
      const rightType = normalizeMarketAgentValue(right.payload?.semantic_type ?? right.event_type);
      return Number(rightType === "breakout") - Number(leftType === "breakout");
    })[0];

const latestTechnicalEventForRun = (
  payload: MarketAgentReplayPayload | undefined,
  monitorRunId: number | null
) => {
  if (!monitorRunId) return undefined;
  return latestTechnicalEvent({
    ...normalizeMarketAgentReplayPayload(payload),
    timeline_events: (payload?.timeline_events ?? []).filter((item) => item.monitor_run_id === monitorRunId)
  });
};

const latestRecordByTime = (
  rows: Record<string, unknown>[] | undefined,
  predicate: (item: Record<string, unknown>) => boolean,
  timeKeys: string[]
) =>
  [...(rows ?? [])]
    .filter(predicate)
    .sort((left, right) => {
      const leftTime = timeKeys.map((key) => left[key]).find((value) => parseTimestampMs(value) !== null);
      const rightTime = timeKeys.map((key) => right[key]).find((value) => parseTimestampMs(value) !== null);
      return (parseTimestampMs(rightTime) ?? 0) - (parseTimestampMs(leftTime) ?? 0);
    })[0];

const latestRecordsByTime = (
  rows: Record<string, unknown>[] | undefined,
  predicate: (item: Record<string, unknown>) => boolean,
  timeKeys: string[],
  limit: number
) =>
  [...(rows ?? [])]
    .filter(predicate)
    .sort((left, right) => {
      const leftTime = timeKeys.map((key) => left[key]).find((value) => parseTimestampMs(value) !== null);
      const rightTime = timeKeys.map((key) => right[key]).find((value) => parseTimestampMs(value) !== null);
      return (parseTimestampMs(rightTime) ?? 0) - (parseTimestampMs(leftTime) ?? 0);
    })
    .slice(0, limit);

const isReviewedNewsEvidence = (item: Record<string, unknown>) => {
  const summarySource = normalizeMarketAgentValue(item.summary_source);
  const reviewStatus = normalizeMarketAgentValue(item.review_status ?? item.evidence_status ?? item.included);
  const driver = normalizeMarketAgentValue(item.main_driver ?? item.driver);
  return Boolean(
    item.ai_summary ||
    item.display_summary ||
    summarySource === "local_ai" ||
    ["accepted", "used", "included", "supporting", "confirming", "true"].includes(reviewStatus) ||
    (driver && driver !== "unknown") ||
    numberValue(item.impact_percent) !== null
  );
};

const isRelevantCalendarEvidence = (item: Record<string, unknown>) => {
  const title = normalizeMarketAgentValue(`${item.title ?? ""} ${item.summary ?? ""} ${item.description ?? ""}`);
  const currency = normalizeMarketAgentValue(item.currency ?? item.country ?? item.region);
  const reviewStatus = normalizeMarketAgentValue(item.review_status ?? item.evidence_status ?? item.included);
  const impact = normalizeMarketAgentValue(item.impact ?? item.importance ?? item.context_type);
  if (reviewStatus === "unreviewed_context") return false;
  if (impact.includes("holiday") || title.includes("holiday") || title.includes("birthday")) return false;
  if (["accepted", "used", "included", "supporting", "confirming", "true"].includes(reviewStatus)) return true;
  if (currency !== "usd" && !title.includes("fed") && !title.includes("fomc")) return false;
  return [
    "fed",
    "fomc",
    "cpi",
    "ppi",
    "pce",
    "nfp",
    "payroll",
    "jobless",
    "unemployment",
    "retail_sales",
    "ism",
    "pmi",
    "gdp"
  ].some((needle) => title.includes(needle));
};

const isUsableTechnicalEvidence = (
  item: ReturnType<typeof latestTechnicalEvent>,
  currentConclusionReady: boolean
) => {
  if (!item || !currentConclusionReady) return false;
  const text = normalizeMarketAgentValue(`${item.label ?? ""} ${summaryText(item.payload, "")}`);
  const causeStatus = normalizeMarketAgentValue(item.payload?.cause_status);
  if (["context_only", "unconfirmed", "paused"].includes(causeStatus)) return false;
  return ![
    "current_conclusion_is_paused",
    "current conclusion is paused",
    "live_xauusd",
    "waiting_for_an_evidence_packet",
    "waiting_for_required_inputs"
  ].some((needle) => text.includes(needle));
};

const evidenceItems = (
  selectedEvidence: MarketAgentEvidenceForRunResponse | null,
  replay: MarketAgentReplayResponse | null,
  driverAttention: MarketAgentDriverAttentionResponse | null,
  currentConclusionReady = true
): DashboardEvidenceRow[] => {
  const packet = selectedEvidence?.payload?.evidence_packet as Record<string, unknown> | undefined;
  const analysis = selectedEvidence?.payload?.analysis_result as Record<string, unknown> | undefined;
  const payload = normalizeMarketAgentReplayPayload(replay?.replay);
  const runTime = String(selectedEvidence?.payload?.monitor_run?.run_started_at ?? "");
  const selectedMonitorRunId = numberValue(selectedEvidence?.payload?.monitor_run?.monitor_run_id);
  const rows: DashboardEvidenceRow[] = [];
  const latestNews = latestRecordsByTime(payload?.news_items, isReviewedNewsEvidence, ["published_at", "first_seen_at", "last_seen_at", "timestamp_myt"], 8);
  const seenNewsStories = new Set<string>();
  let newsIndex = 0;
  for (const news of latestNews) {
    const title = summaryTitle(news, "High Impact News");
    const source = itemSourceLabel(news, "News feed");
    const storyKey = marketTimelineStoryFingerprint(title);
    const dedupeKey = storyKey
      ? `story:${storyKey}:${normalizeMarketAgentValue(source)}`
      : normalizeMarketAgentValue(`${title}|${source}|${String(news.link ?? news.url ?? news.guid ?? "")}`);
    if (dedupeKey && seenNewsStories.has(dedupeKey)) continue;
    if (dedupeKey) seenNewsStories.add(dedupeKey);
    rows.push({
      key: `news-${String(news.published_at ?? news.title ?? "latest")}-${newsIndex}`,
      title,
      detail: summaryText(news, String(news.title ?? news.source ?? "News item")),
      status: evidenceDirectionStatusFromItem(news) ||
        (currentConclusionReady ? evidenceStatusLabel(news.included ?? news.data_mode ?? evidenceStatusValue(packet, "news")) : "Rule kept"),
      kind: "news",
      filter: "news",
      time: String(news.published_at ?? news.first_seen_at ?? runTime),
      source: itemSourceLabel(news, "News feed"),
      payload: news
    });
    newsIndex += 1;
    if (newsIndex >= 3) break;
  }

  const dxyAsset = latestRelatedAsset(payload, "dxy");
  const dxyEvidenceStatus = evidenceStatusValue(packet, "dxy");
  const dxyStatus = currentConclusionReady ? evidenceStatusLabel(dxyEvidenceStatus) : "Context";
  if (shouldShowRelatedEvidence(dxyAsset, dxyEvidenceStatus, currentConclusionReady)) {
    rows.push({
      key: "driver-dxy",
      title: "DXY / USD",
      detail: driverStateDetail(
        driverAttention,
        ["usd", "dxy"],
        dxyAsset,
        relatedAssetDetail("DXY", dxyAsset, "USD pressure is part of the current review.")
      ),
      status: dxyStatus,
      kind: "usd",
      filter: "drivers",
      time: String(dxyAsset?.data_timestamp ?? dxyAsset?.timestamp ?? runTime),
      source: "Cross-market sensor",
      payload: dxyAsset
    });
  }

  const us10yAsset = latestRelatedAsset(payload, "us10y");
  const us10yEvidenceStatus = evidenceStatusValue(packet, "us10y");
  if (shouldShowRelatedEvidence(us10yAsset, us10yEvidenceStatus, currentConclusionReady)) {
    rows.push({
      key: "driver-us10y",
      title: "US10Y Yield Move",
      detail: driverStateDetail(
        driverAttention,
        ["yields", "us10y", "real_yields"],
        us10yAsset,
        relatedAssetDetail("US10Y", us10yAsset, "US yield confirmation is part of the current review.", "bp")
      ),
      status: currentConclusionReady ? evidenceStatusLabel(us10yEvidenceStatus) : "Context",
      kind: "yield",
      filter: "drivers",
      time: String(us10yAsset?.data_timestamp ?? us10yAsset?.timestamp ?? runTime),
      source: "Cross-market sensor",
      payload: us10yAsset
    });
  }

  const technical = latestTechnicalEventForRun(payload, selectedMonitorRunId);
  if (isUsableTechnicalEvidence(technical, currentConclusionReady)) {
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
      detail: summaryText(technical.payload, technical.label),
      status: currentConclusionReady ? evidenceStatusLabel(technical.payload?.cause_status ?? analysis?.cause_status ?? "supporting") : "Context",
      kind: "technical",
      filter: "technical",
      time: technical.event_time,
      source: "Monitor timeline",
      payload: technical.payload
    });
  }

  const us2yAsset = latestRelatedAsset(payload, "us2y");
  const us2yEvidenceStatus = evidenceStatusValue(packet, "us2y");
  if (shouldShowRelatedEvidence(us2yAsset, us2yEvidenceStatus, currentConclusionReady)) {
    const us2yStatus = us2yAsset
        ? currentConclusionReady ? evidenceStatusLabel(evidenceStatusValue(packet, "us2y"), "Neutral") : "Context"
      : "Not Available";
    rows.push({
      key: "driver-us2y",
      title: "US2Y",
      detail: us2yAsset ? relatedAssetDetail("US2Y", us2yAsset, "US2Y source is present.", "bp") : "No available US2Y source for this run.",
      status: us2yStatus,
      kind: "yield",
      filter: "drivers",
      time: String(us2yAsset?.data_timestamp ?? us2yAsset?.timestamp ?? runTime),
      source: "Cross-market sensor",
      payload: us2yAsset
    });
  }

  const oilAsset = latestRelatedAsset(payload, "wti") ?? latestRelatedAsset(payload, "brent");
  const oilEvidenceStatus = evidenceStatusValue(packet, "oil");
  if (rows.length < 5 && shouldShowRelatedEvidence(oilAsset, oilEvidenceStatus, currentConclusionReady)) {
    rows.push({
      key: "driver-oil",
      title: "Oil Price Move",
      detail: driverStateDetail(
        driverAttention,
        ["oil_inflation", "oil"],
        oilAsset,
        relatedAssetDetail("Oil", oilAsset, "Oil did not confirm this XAUUSD move.", "%")
      ),
      status: currentConclusionReady ? evidenceStatusLabel(oilEvidenceStatus, "Neutral") : "Context",
      kind: "oil",
      filter: "drivers",
      time: String(oilAsset?.data_timestamp ?? oilAsset?.timestamp ?? runTime),
      source: "Cross-market sensor",
      payload: oilAsset
    });
  }

  const calendar = latestRecordByTime(payload?.calendar_events, isRelevantCalendarEvidence, ["scheduled_at", "published_at", "timestamp_myt"]);
  if (rows.length < 5 && calendar) {
    rows.push({
      key: `calendar-${String(calendar.scheduled_at ?? calendar.title ?? "latest")}`,
      title: summaryTitle(calendar, "Calendar Context"),
      detail: summaryText(calendar, String(calendar.title ?? "Calendar event")),
      status: currentConclusionReady ? evidenceStatusLabel(calendar.data_mode ?? "neutral", "Neutral") : "Context",
      kind: "calendar",
      filter: "calendar",
      time: String(calendar.scheduled_at ?? runTime),
      source: itemSourceLabel(calendar, "Economic Calendar"),
      payload: calendar
    });
  }

  return rows.slice(0, 5);
};

const marketReadEvidenceItems = (marketRead: Record<string, unknown> | null): DashboardEvidenceRow[] => {
  const evidence = nestedObjectValue(marketRead, "evidence");
  if (!evidence) return [];
  const rows: DashboardEvidenceRow[] = [];
  for (const title of textListValue(evidence.latest_news).slice(0, 2)) {
    rows.push({
      key: `market-read-news-${title}`,
      title: "Market story",
      detail: title,
      status: "Supporting",
      kind: "news",
      filter: "news",
      time: "",
      source: "AI market read"
    });
  }
  for (const driver of textListValue(evidence.confirming).slice(0, 3)) {
    rows.push({
      key: `market-read-driver-${driver}`,
      title: driver,
      detail: `${driver} is part of the current market read.`,
      status: "Supporting",
      kind: normalizeMarketAgentValue(driver).includes("dxy") ? "usd" : "yield",
      filter: "drivers",
      time: "",
      source: "AI market read"
    });
  }
  for (const event of textListValue(evidence.calendar).slice(0, 1)) {
    rows.push({
      key: `market-read-calendar-${event}`,
      title: "Calendar context",
      detail: event,
      status: "Neutral",
      kind: "calendar",
      filter: "calendar",
      time: "",
      source: "AI market read"
    });
  }
  return rows.slice(0, 5);
};

const evidenceKindMeta = (kind: string) => {
  const normalized = normalizeMarketAgentValue(kind);
  if (normalized.includes("news")) return { icon: "NEWS", tone: "blue", label: "News", className: "kind-news" };
  if (normalized.includes("calendar")) return { icon: "EVENT", tone: "amber", label: "Calendar", className: "kind-calendar" };
  if (normalized.includes("yield")) return { icon: "YIELD", tone: "amber", label: "Yield", className: "kind-driver" };
  if (normalized.includes("usd")) return { icon: "USD", tone: "green", label: "USD", className: "kind-driver" };
  if (normalized.includes("oil")) return { icon: "OIL", tone: "amber", label: "Oil", className: "kind-driver" };
  if (normalized.includes("blocked")) return { icon: "DRV", tone: "red", label: "Driver", className: "kind-driver" };
  if (normalized.includes("technical")) return { icon: "TECH", tone: "purple", label: "Technical", className: "kind-technical" };
  return { icon: "DRIVER", tone: "blue", label: "Driver", className: "kind-driver" };
};

const SCORE_RING_RADIUS = 34;
const SCORE_RING_CIRCUMFERENCE = 2 * Math.PI * SCORE_RING_RADIUS;
const DASHBOARD_REPLAY_PREVIEW_LIMIT = 12;
const DASHBOARD_SOURCE_PREVIEW_LIMIT = 160;
const DEFER_LIVE_DASHBOARD = import.meta.env.MODE !== "test";

const replayPayloadTimestamp = (item: Record<string, unknown>) =>
  item.data_timestamp ??
  item.published_at ??
  item.scheduled_at ??
  item.event_time ??
  item.run_started_at ??
  item.first_seen_at ??
  item.last_seen_at ??
  item.timestamp_myt ??
  item.timestamp ??
  "";

const compactRowsByTime = <T extends Record<string, unknown>>(rows: T[] | undefined, limit: number) =>
  [...(rows ?? [])]
    .sort((left, right) => (parseTimestampMs(replayPayloadTimestamp(left)) ?? 0) - (parseTimestampMs(replayPayloadTimestamp(right)) ?? 0))
    .slice(-limit);

const compactReplayForDashboard = (
  replay: MarketAgentReplayResponse | null
): MarketAgentReplayResponse | null => {
  if (!replay?.replay) return replay;
  const payload = replay.replay;
  const relatedAssets = Object.fromEntries(
    Object.entries(payload.related_assets ?? {}).map(([symbol, rows]) => [
      symbol,
      Array.isArray(rows) ? compactRowsByTime(rows, DASHBOARD_SOURCE_PREVIEW_LIMIT) : []
    ])
  );
  return {
    ...replay,
    replay: {
      price_series: compactRowsByTime(payload.price_series, 2),
      related_assets: relatedAssets,
      news_items: compactRowsByTime(payload.news_items, DASHBOARD_SOURCE_PREVIEW_LIMIT),
      calendar_events: compactRowsByTime(payload.calendar_events, DASHBOARD_SOURCE_PREVIEW_LIMIT),
      driver_attention_timeline: [],
      timeline_events: compactRowsByTime(payload.timeline_events, DASHBOARD_SOURCE_PREVIEW_LIMIT),
      month_summary_events: compactRowsByTime(payload.month_summary_events, DASHBOARD_REPLAY_PREVIEW_LIMIT),
      state_transitions: compactRowsByTime(payload.state_transitions, DASHBOARD_SOURCE_PREVIEW_LIMIT),
      alerts: compactRowsByTime(payload.alerts, DASHBOARD_SOURCE_PREVIEW_LIMIT),
      suppressed_alerts: []
    }
  };
};

function MarketAgentDashboard({
  snapshot,
  liveQuote,
  providerHealth,
  driverAttention,
  replay,
  selectedEvidence,
  monitorStatus,
  onSelectRun,
  onNavigate
}: {
  snapshot: MarketAgentSnapshotResponse | null;
  liveQuote?: MarketAgentLiveQuoteResponse | null;
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
  const [selectedDetail, setSelectedDetail] = useState<MarketAgentDetailItem | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [countdownBaseMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const state = snapshot?.state;
  const dashboardReplay = useMemo(() => compactReplayForDashboard(replay), [replay]);
  const replayPayload = dashboardReplay?.replay;
  const fallbackXauusdHealth = findProviderHealth(providerHealth?.items, ["xauusd", "gc=f", "xauusd price"]);
  const xauusdHealth = liveQuote?.provider_health
    ? ({ ...fallbackXauusdHealth, ...liveQuote.provider_health } as MarketAgentProviderHealthEntry)
    : fallbackXauusdHealth;
  const hasFreshLiveQuote = hasFreshRuntimeLiveQuote(liveQuote, nowMs);
  const xauusdStatus = hasFreshLiveQuote
    ? { label: "cTrader (Spot)", data: "Live", valueMode: "live" as const }
    : liveXauusdStatus(xauusdHealth, nowMs);
  const hasTrustedSpotPrice = xauusdStatus.valueMode === "live" || xauusdStatus.valueMode === "closed";
  const hasDisplaySpotPrice = hasTrustedSpotPrice || (xauusdStatus.valueMode === "waiting" && numberValue(xauusdHealth?.current_value) !== null);
  const analysisCauseStatus = normalizeMarketAgentValue(selectedEvidence?.payload?.analysis_result?.cause_status);
  const evidencePacket = objectValue(selectedEvidence?.payload?.evidence_packet);
  const analysisResult = objectValue(selectedEvidence?.payload?.analysis_result);
  const stateRecord = objectValue(state);
  const marketRead =
    nestedObjectValue(evidencePacket, "market_read") ??
    nestedObjectValue(analysisResult, "market_read") ??
    nestedObjectValue(stateRecord, "market_read") ??
    null;
  const replayRows = useMemo(() => latestTimelineRows(replayPayload), [replayPayload]);
  const marketReadFromReplay = useMemo(() => marketReadFromTimelineRows(replayRows), [replayRows]);
  const activeMarketRead = marketRead ?? marketReadFromReplay;
  const marketReadRows = useMemo(() => marketReadTimelineRows(activeMarketRead), [activeMarketRead]);
  const marketReadStatus = normalizeMarketAgentValue(activeMarketRead?.status);
  const hasCurrentMarketRead = marketReadStatus === "current_read";
  const chainStatus = fallbackEvidenceChainStatus(selectedEvidence, xauusdStatus);
  const missingInputs = evidenceChainList(chainStatus, "missing_required");
  const currentConclusionReady =
    canShowCurrentConclusion(selectedEvidence, xauusdStatus.valueMode === "live", chainStatus) ||
    (hasCurrentMarketRead && missingInputs.length === 0);
  const liveReviewPending = xauusdStatus.valueMode === "live" && !currentConclusionReady;
  const storedMarketStateReady = Boolean(
    state?.last_analysis_time && normalizeMarketAgentValue(state?.current_bias) !== "unknown"
  );
  const displayMarketStateReady = currentConclusionReady || storedMarketStateReady;
  const price = hasTrustedSpotPrice ? latestPrice(dashboardReplay) : null;
  const priorPrice = previousPrice(dashboardReplay);
  const liveQuoteRecord = liveQuote?.quote as Record<string, unknown> | undefined;
  const liveQuoteM1Bar = liveQuoteRecord?.m1_bar && typeof liveQuoteRecord.m1_bar === "object"
    ? liveQuoteRecord.m1_bar as Record<string, unknown>
    : null;
  const priceValue = numberValue((hasFreshLiveQuote ? liveQuote?.quote?.mid : null) ?? xauusdHealth?.current_value ?? price?.close_price);
  const previousPriceValue = numberValue(xauusdHealth?.previous_value ?? priorPrice?.close_price ?? liveQuoteM1Bar?.open);
  const spotHealthRecord = xauusdHealth as Record<string, unknown> | null | undefined;
  const spotChangeMetadata = objectValue(spotHealthRecord?.metadata);
  const spotChangeSource = normalizeMarketAgentValue(spotChangeMetadata?.change_source ?? spotHealthRecord?.change_source);
  const hasNativeSpotChange = ["broker_native", "ctrader_native", "provider_native"].includes(spotChangeSource);
  const nativeSpotChangeValue = hasNativeSpotChange ? numberValue(spotHealthRecord?.change_value) : null;
  const nativeSpotChangePercent = hasNativeSpotChange
    ? numberValue(
        spotHealthRecord?.change_percent ??
          spotHealthRecord?.change_pct ??
          spotChangeMetadata?.change_percent ??
          spotChangeMetadata?.change_pct ??
          (spotHealthRecord?.change_unit === "%" ? spotHealthRecord?.change_value : null)
      )
    : null;
  const computedSpotChange = !hasNativeSpotChange
    ? cTraderSpotChangeFromM1(priceValue, liveQuoteRecord, liveQuoteM1Bar, replayPayload, nowMs)
    : null;
  const spotDisplayChangeValue = nativeSpotChangeValue ?? computedSpotChange?.value ?? null;
  const spotDisplayChangePercent = nativeSpotChangePercent ?? computedSpotChange?.percent ?? null;
  const priceChangePercent =
    numberValue(price?.change_pct ?? price?.change_15m_pct ?? price?.move_percent) ??
    (priceValue !== null && previousPriceValue !== null && previousPriceValue !== 0
      ? ((priceValue - previousPriceValue) / previousPriceValue) * 100
      : null);
  const monthRows = useMemo(() => monthSummaryTimelineRows(replayPayload), [replayPayload]);
  const replayTimeline = useMemo(
    () => replayRange === "month" && monthRows.length
      ? monthRows
      : filterTimelineByReplayRange(replayRows, replayRange).slice(0, DASHBOARD_REPLAY_PREVIEW_LIMIT),
    [monthRows, replayRange, replayRows]
  );
  const timeline = useMemo(
    () => replayTimeline.length ? replayTimeline : marketReadRows.slice(0, DASHBOARD_REPLAY_PREVIEW_LIMIT),
    [marketReadRows, replayTimeline]
  );
  const baseEvidence = useMemo(
    () => evidenceItems(selectedEvidence, dashboardReplay, driverAttention, currentConclusionReady),
    [currentConclusionReady, dashboardReplay, driverAttention, selectedEvidence]
  );
  const marketReadEvidence = useMemo(() => marketReadEvidenceItems(activeMarketRead), [activeMarketRead]);
  const allEvidence = useMemo(
    () => baseEvidence.length ? baseEvidence : marketReadEvidence,
    [baseEvidence, marketReadEvidence]
  );
  const evidence = useMemo(
    () => evidenceFilter === "all" ? allEvidence : allEvidence.filter((item) => item.filter === evidenceFilter),
    [allEvidence, evidenceFilter]
  );
  const evidenceDirection = currentConclusionReady ? evidenceDirectionFromBias(state?.current_bias) : null;
  const displayEvidenceDirections = evidence.map((item) => displayEvidenceDirection(item.status, evidenceDirection));
  const bullishCount = displayEvidenceDirections.filter((direction) => direction === "bullish").length;
  const bearishCount = displayEvidenceDirections.filter((direction) => direction === "bearish").length;
  const neutralCount = displayEvidenceDirections.filter((direction) => direction === "neutral").length;
  const contraryCount = evidenceDirection === "bullish" ? bearishCount : evidenceDirection === "bearish" ? bullishCount : 0;
  const directionalCount = bullishCount + bearishCount;
  const evidenceScore = evidence.length
    ? Math.round((Math.max(bullishCount, bearishCount) / evidence.length) * 100)
    : 0;
  const clampedEvidenceScore = currentConclusionReady ? Math.max(0, Math.min(100, evidenceScore)) : 0;
  const isEvidenceScoreEmpty = clampedEvidenceScore <= 0;
  const isEvidenceScoreFull = clampedEvidenceScore >= 100;
  const evidenceScoreDashOffset = SCORE_RING_CIRCUMFERENCE * (1 - clampedEvidenceScore / 100);
  const readMovePercent = marketReadMovePercent(activeMarketRead);
  const readMoveTime = marketReadMoveTime(activeMarketRead);
  const observedMovePercent = priceChangePercent ?? (marketReadStatus === "current_read" ? readMovePercent : null);
  const moveChange = currentConclusionReady
    ? (hasCurrentMarketRead ? readMovePercent : null) ??
      numberValue(price?.change_pct ?? price?.change_15m_pct ?? (xauusdHealth?.change_unit === "%" ? xauusdHealth?.change_value : null)) ??
      observedMovePercent
    : observedMovePercent;
  const hasObservedMove = moveChange !== null;
  const sourceType = normalizeMarketAgentValue(xauusdHealth?.source_type ?? price?.source_type);
  const priceSourceLabel = xauusdStatus.label;
  const priceSourceDotClass = xauusdStatus.valueMode === "live" ? "spot" : xauusdStatus.valueMode === "closed" ? "closed" : "waiting";
  const providerStatus = statusForProvider(xauusdHealth);
  const displayProviderStatus = xauusdStatus.data || formatDataModeLabel(sourceType, providerStatus);
  const dataFreshness = formatDataFreshness((hasFreshLiveQuote ? liveQuote?.quote?.timestamp : null) ?? xauusdHealth?.data_timestamp ?? price?.data_timestamp ?? price?.timestamp, nowMs);
  const latestAlertMessage = replay?.replay?.alerts?.[0]?.message;
  const evidenceRunTime = formatReplayTime(selectedEvidence?.payload?.monitor_run?.run_started_at);
  const latestMoveLabel = moveChange === null
    ? (extractMovePercent(latestAlertMessage) ?? "--")
    : formatPercentChange(moveChange);
  const evidenceScoreLabel = currentConclusionReady
    ? bullishCount > bearishCount
      ? "Bullish"
      : bearishCount > bullishCount
        ? "Bearish"
        : neutralCount > 0
          ? "Neutral"
          : formatEvidenceScoreStrength(clampedEvidenceScore, evidence.length, contraryCount)
    : "Context";
  const latestMoveIsNegative = latestMoveLabel.startsWith("-");
  const latestMoveSizeTone = latestMoveLabel === "--" ? "neutral" : latestMoveIsNegative ? "negative" : "positive";
  const latestMove = formatMoveType(latestMoveLabel, latestAlertMessage);
  const marketTone = storedMarketStateReady
    ? marketStateTone(state?.current_bias)
    : hasCurrentMarketRead && readMovePercent !== null
      ? readMovePercent < 0 ? "negative" : readMovePercent > 0 ? "positive" : "neutral"
      : "neutral";
  const marketReadStateLabel = marketReadStatus === "current_read"
    ? "MARKET READ"
    : marketReadStatus === "no_conclusion"
      ? "NO CONCLUSION"
      : marketReadStatus === "context_only"
        ? "CONTEXT ACTIVE"
        : "";
  const marketStateLabel = storedMarketStateReady
    ? formatMarketStateLabel(state?.current_bias)
    : marketReadStateLabel
      ? marketReadStateLabel
    : liveReviewPending
      ? hasObservedMove ? "OBSERVING PRICE" : "REVIEW PENDING"
      : xauusdStatus.valueMode === "closed"
        ? "MARKET CLOSED"
        : "AWAITING LIVE PRICE";
  const latestMoveDisplay = currentConclusionReady
    ? latestMove.label
    : liveReviewPending
      ? hasObservedMove ? latestMove.label : "No conclusion yet"
      : "No live move";
  const pendingStrengthLabel = liveReviewPending ? "No conclusion" : String(chainStatus?.status ?? "Context only");
  const priceChangeTone = spotDisplayChangeValue === null ? "neutral" : spotDisplayChangeValue < 0 ? "negative" : "positive";
  const marketStrength = formatEvidenceStrength(state?.confidence);
  const stateSinceCompact = formatStateSinceCompactTime(state?.last_analysis_time);
  const stateSinceFull = formatStateSinceTime(state?.last_analysis_time);
  const monitorLoopRunning = monitorStatus?.running === true;
  const monitorLoopAvailable = monitorStatus?.available !== false;
  const nextUpdate = monitorLoopRunning ? nextRunCountdown(monitorStatus, nowMs, countdownBaseMs) : null;
  const nextUpdateLabel = monitorLoopRunning
    ? "Auto monitoring"
    : monitorLoopAvailable
      ? "Monitoring stopped"
      : "Not running";
  const nextUpdateDetail = monitorLoopRunning && nextUpdate
    ? `Every ${nextUpdate.intervalSeconds} seconds`
    : monitorStatus?.lastRunAt
      ? `Last check ${formatShortTime(monitorStatus.lastRunAt)}`
      : "Start monitoring to resume";
  const watchedDriverCount = (driverAttention?.states ?? []).filter((item) =>
    ["active", "active_macro", "watching", "emerging", "cooling", "dormant"].includes(normalizeMarketAgentValue(item.current_state))
  ).length;
  const collectedContextCount = allEvidence.length + watchedDriverCount;

  return (
    <section className="market-agent-cockpit" data-qa="qa:market-agent:cockpit">
      <div className="market-agent-kpi-grid">
        <article className="market-agent-kpi-card market-agent-price-card">
          <div className="market-agent-kpi-head">
            <h3>XAUUSD (Spot)</h3>
            <span className="market-agent-source-dot">
              <span className={priceSourceDotClass} />
              {priceSourceLabel}
            </span>
          </div>
          <div className="market-agent-price-value-row">
            <strong>
              <MarketAgentValuePulse value={priceValue ?? xauusdHealth?.current_value} animate={false}>
                {hasDisplaySpotPrice ? formatPrice(priceValue ?? xauusdHealth?.current_value, "No price") : "No live price"}
              </MarketAgentValuePulse>
            </strong>
            <span className={`market-agent-price-change ${priceChangeTone}`}>
              <MarketAgentValuePulse value={`${spotDisplayChangeValue ?? "--"}-${spotDisplayChangePercent ?? "--"}`} animate={false}>
                {spotDisplayChangeValue !== null ? `${formatSignedPriceChange(spotDisplayChangeValue)} (${formatPercentChange(spotDisplayChangePercent)})` : ""}
              </MarketAgentValuePulse>
            </span>
          </div>
          <div className="market-agent-price-data">
            <em>Data:</em>
            <b><MarketAgentValuePulse value={displayProviderStatus} animate={false}>{displayProviderStatus}</MarketAgentValuePulse></b>
            {dataFreshness ? (
              <span>
                (<MarketAgentValuePulse value={dataFreshness} animate={false}>{dataFreshness}</MarketAgentValuePulse>)
              </span>
            ) : null}
          </div>
        </article>
        <article className="market-agent-kpi-card market-agent-state-card">
          <div className="market-agent-kpi-head">
            <h3>Market State</h3>
          </div>
          <strong className={`market-agent-state-value ${marketTone}`}>
            <MarketAgentValuePulse value={marketStateLabel}>
              {marketStateLabel}
            </MarketAgentValuePulse>
            <span>{displayMarketStateReady ? marketStateArrow(state?.current_bias) : "•"}</span>
          </strong>
          <div className="market-agent-state-details market-agent-kpi-detail-stack">
            <span className="market-agent-kpi-subline">
              <span>Since</span>
              <b data-kpi-detail="state-since" title={displayMarketStateReady ? stateSinceFull : ""}>{displayMarketStateReady ? stateSinceCompact : "--"}</b>
            </span>
            <div className="market-agent-kpi-mini-metrics" aria-label="Market state detail metrics">
              <span>
                <em>Strength</em>
                <b data-kpi-detail="state-strength"><MarketAgentValuePulse value={displayMarketStateReady ? marketStrength : pendingStrengthLabel}>{displayMarketStateReady ? marketStrength : pendingStrengthLabel}</MarketAgentValuePulse></b>
              </span>
              <span>
                <em>Confidence</em>
                <b data-kpi-detail="state-confidence"><MarketAgentValuePulse value={displayMarketStateReady ? state?.confidence : "--"}>{displayMarketStateReady ? formatValue(state?.confidence, "--") : "--"}</MarketAgentValuePulse></b>
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
              {latestMoveDisplay}
            </MarketAgentValuePulse>
            <span>{currentConclusionReady || hasObservedMove ? latestMove.arrow : "•"}</span>
          </strong>
          <div className="market-agent-move-details market-agent-kpi-detail-stack">
            <span className="market-agent-kpi-subline">
              <span>Detected</span>
              <b data-kpi-detail="move-detected">
                {currentConclusionReady
                  ? formatClockTime(readMoveTime || state?.last_alert_time)
                  : hasObservedMove
                    ? formatClockTime(readMoveTime || liveQuote?.quote?.timestamp || price?.data_timestamp || price?.timestamp)
                    : "--"}
              </b>
            </span>
            <div className="market-agent-kpi-mini-metrics" aria-label="Latest move detail metrics">
              <span>
                <em>Move Size</em>
                <b className={latestMoveSizeTone} data-kpi-detail="move-size"><MarketAgentValuePulse value={latestMoveLabel} animate={false}>{currentConclusionReady || hasObservedMove ? latestMoveLabel : "--"}</MarketAgentValuePulse></b>
              </span>
              <span>
                <em>Duration</em>
                <b data-kpi-detail="move-duration">{currentConclusionReady ? formatMoveDuration(price, readMoveTime || state?.last_alert_time, nowMs) : "--"}</b>
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
              className={`market-agent-score-ring${currentConclusionReady ? "" : " is-context"}`}
              data-score-target={String(clampedEvidenceScore)}
              data-score-state={currentConclusionReady ? "ready" : "context"}
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
                  <span className="market-agent-score-number">{currentConclusionReady ? evidenceScore : "--"}</span>
                  <span className="market-agent-score-suffix">{currentConclusionReady ? "%" : ""}</span>
                </strong>
                <span className="market-agent-score-strength">{currentConclusionReady ? evidenceScoreLabel : "Context"}</span>
              </div>
            </div>
            <div className="market-agent-evidence-counts">
              {currentConclusionReady ? (
                <>
                  <span><i className="contrary" /><span>Bearish</span><b><MarketAgentValuePulse value={bearishCount}>{bearishCount}</MarketAgentValuePulse></b></span>
                  <span><i className="neutral" /><span>Neutral</span><b><MarketAgentValuePulse value={neutralCount}>{neutralCount}</MarketAgentValuePulse></b></span>
                  <span><i className="supporting" /><span>Bullish</span><b><MarketAgentValuePulse value={bullishCount}>{bullishCount}</MarketAgentValuePulse></b></span>
                </>
              ) : (
                <>
                  <span><i className="neutral" /><span>Missing</span><b>{missingInputs.length}</b></span>
                  <span><i className="supporting" /><span>Context</span><b>{collectedContextCount}</b></span>
                  <span><i className="contrary" /><span>Current</span><b>--</b></span>
                </>
              )}
            </div>
          </div>
          <div className="market-agent-evidence-quality">
            <span>{currentConclusionReady ? "Quality:" : "Mode:"}</span>
            <b>{currentConclusionReady ? formatValue(state?.confidence, "--") : "Context only"}</b>
          </div>
        </article>
        <article className="market-agent-kpi-card market-agent-next-card">
          <div className="market-agent-kpi-head">
            <h3>Next Update</h3>
          </div>
          <div className="market-agent-next-content">
            <div className="market-agent-next-main">
              <span className={`market-agent-clock-icon${monitorLoopRunning ? " market-agent-clock-icon-animated" : ""}`} aria-hidden="true" />
              <strong>{nextUpdate ? <MarketAgentRollingCountdown seconds={nextUpdate.seconds} /> : "--"}</strong>
            </div>
            <div className="market-agent-next-meta">
              <span>{nextUpdateLabel}</span>
              <small>{nextUpdateDetail}</small>
            </div>
          </div>
        </article>
      </div>

      <div className="market-agent-cockpit-panels">
        <section className="market-agent-cockpit-panel market-agent-macro-micro-panel">
          <div className="market-agent-panel-title-row">
            <h3>Macro / Micro Watch <span>(News + drivers)</span></h3>
            <button type="button" className="market-agent-panel-link" onClick={() => onNavigate("drivers")}>
              View All
            </button>
          </div>
          <MarketAgentMacroMicroFocus
            driverAttention={driverAttention}
            selectedEvidence={selectedEvidence}
            replay={dashboardReplay}
            marketRead={activeMarketRead}
            evidenceChainStatus={chainStatus}
            currentConclusionReady={currentConclusionReady}
            variant="dashboard"
          />
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
          <div className={`market-agent-timeline-track${timeline.length === 0 ? " is-empty" : ""}`}>
            <div className={`market-agent-timeline-track-inner${timeline.length === 0 ? " is-empty" : ""}`}>
              {timeline.map((item, index) => {
                const kind = inferTimelineKind(item);
                const meta = timelineKindMeta[kind];
                return (
                  <button
                    type="button"
                    key={item.key}
                    className={`market-agent-timeline-track-row market-agent-animated-row kind-${meta.tone}`}
                    style={{ "--ma-row-index": index } as CSSProperties}
                    onClick={() => setSelectedDetail(timelineRowDetail(item))}
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
              {timeline.length === 0 ? (
                <div className="market-agent-empty-state market-agent-replay-empty">
                  <strong>No accepted market events in this window.</strong>
                  {" "}
                  <span>No confirmed market-moving news, calendar event, or price move for this period.</span>
                </div>
              ) : null}
            </div>
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
              const displayStatus = displayEvidenceStatusLabel(item.status, evidenceDirection);
              const showDetail = shouldShowEvidenceDetailLine(item.title, item.detail);
              return (
                <button
                  type="button"
                  className={`market-agent-evidence-feed-row market-agent-animated-row tone-${meta.tone} ${meta.className}`}
                  key={`${item.title}-${index}`}
                  style={{ "--ma-row-index": index } as CSSProperties}
                  onClick={() => setSelectedDetail(evidenceRowDetail(item))}
                >
                  <span className="market-agent-evidence-icon">{meta.icon}</span>
                  <div>
                    <strong>{item.title}</strong>
                    {showDetail ? <span>{item.detail}</span> : null}
                  </div>
                  <time>{formatReplayTime(item.time, evidenceRunTime)}</time>
                  <span
                    className={`market-agent-evidence-status-text tone-${evidenceStatusTone(displayStatus)}`}
                    title={`${displayStatus} (${item.status})`}
                  >
                    {displayStatus}
                  </span>
                </button>
              );
            })}
            {evidence.length === 0 ? (
              <div className="market-agent-empty-state market-agent-chain-empty">
                <strong>No accepted evidence in this category.</strong>
                <span>Nothing has been accepted as XAUUSD evidence for this category.</span>
              </div>
            ) : null}
          </div>
          <div className="market-agent-evidence-footer">
            <span><i /> Evidence Status: <b>{currentConclusionReady ? `${evidenceScoreLabel} (${evidenceScore}%)` : liveReviewPending ? "Market read forming" : "No current conclusion"}</b></span>
            <span>
              {currentConclusionReady
                ? `${bearishCount} Bearish, ${neutralCount} Neutral, ${bullishCount} Bullish`
                : `${allEvidence.length} kept context item${allEvidence.length === 1 ? "" : "s"}`}
            </span>
          </div>
        </section>
      </div>
      <MarketAgentItemDetailModal
        item={selectedDetail}
        onClose={() => setSelectedDetail(null)}
        onOpenRun={(monitorRunId) => {
          setSelectedDetail(null);
          onSelectRun(monitorRunId);
        }}
      />

    </section>
  );
}

function MarketAgentItemDetailModal({
  item,
  onClose,
  onOpenRun
}: {
  item: MarketAgentDetailItem | null;
  onClose: () => void;
  onOpenRun?: (monitorRunId: number) => void;
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
    <div className="market-agent-item-detail-backdrop" role="presentation" onClick={onClose}>
      <section
        className="market-agent-item-detail"
        role="dialog"
        aria-modal="true"
        aria-label="Market item detail"
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span>{item.tag}</span>
            <h3>{item.title}</h3>
          </div>
          <button type="button" className="market-agent-panel-link" onClick={onClose}>Close</button>
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
          {item.monitorRunId && onOpenRun ? (
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

function MarketAgentDashboardShell() {
  return (
    <section className="market-agent-cockpit market-agent-cockpit-loading" data-qa="qa:market-agent:cockpit-loading">
      <div className="market-agent-kpi-grid" aria-hidden="true">
        {["XAUUSD (Spot)", "Market State", "Latest Move", "Evidence Status", "Next Update"].map((label) => (
          <article className="market-agent-kpi-card market-agent-skeleton-card" key={label}>
            <div className="market-agent-kpi-head">
              <h3>{label}</h3>
            </div>
            <span className="market-agent-skeleton-line wide" />
            <span className="market-agent-skeleton-line" />
          </article>
        ))}
      </div>
      <div className="market-agent-cockpit-panels" aria-hidden="true">
        {["Driver Attention", "Market Replay", "Latest Evidence"].map((label) => (
          <section className="market-agent-cockpit-panel market-agent-skeleton-panel" key={label}>
            <div className="market-agent-panel-title-row">
              <h3>{label}</h3>
            </div>
            <span className="market-agent-skeleton-line wide" />
            <span className="market-agent-skeleton-line wide" />
            <span className="market-agent-skeleton-line" />
          </section>
        ))}
      </div>
    </section>
  );
}

export function MarketAgentPage(props: MarketAgentPageProps) {
  const isControlledSection = props.activeSection !== undefined;
  const [internalSection, setInternalSection] = useState<MarketAgentSection>(
    props.activeSection ?? "live"
  );
  const section = isControlledSection ? (props.activeSection as MarketAgentSection) : internalSection;
  const [liveDashboardReady, setLiveDashboardReady] = useState(!DEFER_LIVE_DASHBOARD);
  const navigateSection = useCallback(
    (nextSection: MarketAgentSection) => {
      if (!isControlledSection) {
        setInternalSection(nextSection);
      }
      props.onSectionChange?.(nextSection);
    },
    [isControlledSection, props.onSectionChange]
  );

  useEffect(() => {
    if (!DEFER_LIVE_DASHBOARD) {
      setLiveDashboardReady(true);
      return undefined;
    }
    if (section !== "live") {
      setLiveDashboardReady(false);
      return undefined;
    }
    setLiveDashboardReady(false);
    let raf1 = 0;
    let raf2 = 0;
    let cancelled = false;
    raf1 = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(() => {
        if (!cancelled) {
          setLiveDashboardReady(true);
        }
      });
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(raf1);
      window.cancelAnimationFrame(raf2);
    };
  }, [section]);

  const needsFullReplay =
    section === "drivers" || section === "evidence" || section === "activity" || section === "alerts";
  const replayPayload = useMemo(
    () => (needsFullReplay ? normalizeMarketAgentReplayPayload(props.replay?.replay) : null),
    [needsFullReplay, props.replay]
  );
  const normalizedReplay = useMemo<MarketAgentReplayResponse | null>(() => {
    if (!props.replay || !replayPayload) return null;
    return { ...props.replay, replay: replayPayload };
  }, [props.replay, replayPayload]);
  const currentAlertNoticeIds = useMemo(() => {
    if (section !== "alerts") return [];
    return alertNoticeIds(normalizedReplay);
  }, [normalizedReplay, section]);
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
      if (!liveDashboardReady) {
        return <MarketAgentDashboardShell />;
      }
      return (
        <MarketAgentDashboard
          snapshot={props.snapshot}
          liveQuote={props.liveQuote}
          providerHealth={props.providerHealth}
          driverAttention={props.driverAttention}
          replay={props.replay}
          selectedEvidence={props.selectedEvidence}
          monitorStatus={props.monitorStatus}
          onSelectRun={props.onSelectRun}
          onNavigate={navigateSection}
        />
      );
    }
    if (section === "drivers") {
      const fallbackXauusdHealth = findProviderHealth(props.providerHealth?.items, ["xauusd", "gc=f", "xauusd price"]);
      const xauusdHealth = props.liveQuote?.provider_health
        ? ({ ...fallbackXauusdHealth, ...props.liveQuote.provider_health } as MarketAgentProviderHealthEntry)
        : fallbackXauusdHealth;
      const hasFreshLiveQuote = hasFreshRuntimeLiveQuote(props.liveQuote, Date.now());
      return (
        <MarketAgentDriverAttention
          data={props.driverAttention}
          selectedEvidence={props.selectedEvidence}
          replay={normalizedReplay}
          marketRead={nestedObjectValue(objectValue(props.snapshot?.state), "market_read")}
          evidenceChainStatus={fallbackEvidenceChainStatus(
            props.selectedEvidence,
            hasFreshLiveQuote
              ? { label: "cTrader (Spot)", data: "Live", valueMode: "live" as const }
              : liveXauusdStatus(xauusdHealth)
          )}
        />
      );
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
      const fallbackXauusdHealth = findProviderHealth(props.providerHealth?.items, ["xauusd", "gc=f", "xauusd price"]);
      const xauusdHealth = props.liveQuote?.provider_health
        ? ({ ...fallbackXauusdHealth, ...props.liveQuote.provider_health } as MarketAgentProviderHealthEntry)
        : fallbackXauusdHealth;
      const hasFreshLiveQuote = hasFreshRuntimeLiveQuote(props.liveQuote, Date.now());
      const xauusdStatus = hasFreshLiveQuote
        ? { label: "cTrader (Spot)", data: "Live", valueMode: "live" as const }
        : liveXauusdStatus(xauusdHealth);
      const chainStatus = fallbackEvidenceChainStatus(props.selectedEvidence, xauusdStatus);
      return (
        <div className="market-agent-evidence-stack" data-qa="qa:market-agent:evidence-stack">
          <MarketAgentEvidencePanel
            data={props.selectedEvidence}
            evidenceChainStatus={chainStatus}
          />
        </div>
      );
    }
    if (section === "providers") {
      return <MarketAgentProviderHealth data={props.providerHealth} />;
    }
    if (section === "activity") {
      return (
        <MarketAgentActivity
          monitorStatus={props.monitorStatus}
          liveQuote={props.liveQuote}
          providerHealth={props.providerHealth}
          replay={normalizedReplay}
          selectedEvidence={props.selectedEvidence}
          providerConfig={props.providerConfig}
          telegramConfig={props.telegramConfig}
          llmConfig={props.llmConfig}
        />
      );
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
      const activeReplayPayload = replayPayload ?? normalizeMarketAgentReplayPayload(null);
      const attentionAlerts = activeReplayPayload.alerts;
      const suppressedAlerts = activeReplayPayload.suppressed_alerts;
      const alertRows = attentionAlerts.map((alert, index) => ({
          key: `alert-${index}`,
          kind: "attention" as const,
          label: "Attention",
          index: index + 1,
          title: alertTitle(alert.message),
          detail: alertDriverDetail(alert.main_driver, alert.message),
          time: String(alert.run_started_at ?? ""),
          badge: "Needs attention",
          tone: "warn" as const,
          quietRepeatCount: numberValue(alert.quiet_repeat_count) ?? 0
        }));
      const recentAlertRows = alertRows.length
        ? []
        : (props.snapshot?.alerts ?? []).map((alert, index) => ({
            key: `recent-alert-${index}`,
            kind: "history" as const,
            label: "Recent",
            index: index + 1,
            title: alertTitle(alert.message),
            detail: alertDriverDetail(alert.main_driver, alert.message),
            time: String(alert.time ?? ""),
            badge: "Sent",
            tone: "neutral" as const,
            quietRepeatCount: numberValue((alert as Record<string, unknown>).quiet_repeat_count) ?? 0
          }));
      const reviewedDecisionRows = alertRows.length
        ? []
        : suppressedAlerts.slice(-8).map((alert, index) => ({
            key: `reviewed-alert-${index}`,
            kind: "reviewed" as const,
            label: "Reviewed",
            index: index + 1,
            title: alertReviewTitle(alert),
            detail: alertReviewDetail(alert),
            time: String(alert.run_started_at ?? alert.time ?? ""),
            badge: "Not sent",
            tone: "neutral" as const,
            quietRepeatCount: numberValue(alert.quiet_repeat_count) ?? 0
          }));
      const visibleAlertRows = alertRows.length ? alertRows : [...reviewedDecisionRows, ...recentAlertRows].slice(0, 8);
      const attentionLabel = alertRows.length
        ? `${alertRows.length} attention item${alertRows.length === 1 ? "" : "s"}`
        : `${recentAlertRows.length} sent / ${reviewedDecisionRows.length} reviewed`;
      const hiddenSuppressedCount = Math.max(0, suppressedAlerts.length - reviewedDecisionRows.length);
      const hiddenRepeatCount = hiddenSuppressedCount + visibleAlertRows.reduce((sum, alert) => sum + alert.quietRepeatCount, 0);
      const hiddenLabel = `${hiddenRepeatCount} quiet repeat${hiddenRepeatCount === 1 ? "" : "s"} hidden`;
      const telegramEnabled = Boolean(props.telegramConfig?.telegram?.enabled);
      const renderAlertCard = (alert: (typeof visibleAlertRows)[number]) => (
        <article className={`market-agent-alert-card ${alert.kind}`} data-alert-kind={alert.kind} key={alert.key}>
          <span className="market-agent-alert-index">{alert.label}</span>
          <div className="market-agent-alert-main">
            <div className="market-agent-alert-title-row">
              <strong>{alert.title}</strong>
            </div>
            <span>
              {alert.detail}
              {alert.quietRepeatCount > 0 ? ` / ${alert.quietRepeatCount} repeat${alert.quietRepeatCount === 1 ? "" : "s"} folded` : ""}
            </span>
          </div>
          <MarketAgentStatusBadge label={alert.badge} tone={alert.tone} />
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
          {visibleAlertRows.length ? (
            <div className="market-agent-alerts-list" data-qa="qa:market-agent:alerts-list">
              {visibleAlertRows.map(renderAlertCard)}
            </div>
          ) : (
            <div className="market-agent-empty-state" data-qa="qa:market-agent:alerts-list">
              <strong>No alertable trade call in this window.</strong>
              <span>
                Replay and Latest Evidence can still contain news, calendar, or price context. Alerts appear here only after the alert gate accepts a new non-repeat call.
              </span>
            </div>
          )}
        </section>
      );
    }
    return null;
  }, [
    normalizedReplay,
    props.driverAttention,
    props.llmConfig,
    props.liveQuote,
    props.localAiPullProgress,
    props.localAiSetup,
    props.monitorStatus,
    props.onApplyLLMFallbackPolicy,
    props.onApplyRange,
    props.onBenchmarkLLM,
    props.onCancelModelDownload,
    props.onClearProviderConfig,
    props.onDetectLocalAI,
    props.onGetCTraderQuoteTest,
    props.onInstallRecommendedModel,
    props.onPresetChange,
    props.onRangeEndChange,
    props.onRangeStartChange,
    props.onResolveCTraderSymbol,
    props.onRunBackfillRecovery,
    props.onRunMonitorOnce,
    props.onSaveLLMConfig,
    props.onSaveProviderConfig,
    props.onSaveTelegramConfig,
    props.onSelectRun,
    props.onStartCTraderConnect,
    props.onStartMonitorLoop,
    props.onStopMonitorLoop,
    props.onTestCTraderBackfill,
    props.onTestCTraderConnection,
    props.onTestLLMConnection,
    props.onTestLLMJsonResponse,
    props.onTestTelegramMessage,
    props.providerConfig,
    props.providerHealth,
    props.rangeEndInput,
    props.rangePreset,
    props.rangeStartInput,
    props.replay,
    props.selectedEvidence,
    props.selectedMonitorRunId,
    props.snapshot,
    props.telegramConfig,
    replayPayload,
    liveDashboardReady,
    section
  ]);

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
                    onClick={() => navigateSection(item.id)}
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
