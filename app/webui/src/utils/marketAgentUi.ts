import type {
  MarketAgentProviderHealthEntry,
  MarketAgentSnapshotResponse
} from "../types";

const LABELS: Record<string, string> = {
  active_macro: "Active macro",
  available: "Available",
  backfilled: "Backfilled",
  bearish_gold: "Bearish gold",
  bullish_gold: "Bullish gold",
  conditional_macro: "Conditional macro",
  confirming: "Confirming",
  core_structural: "Core sensor",
  disabled: "Disabled",
  dormant: "Dormant",
  emerging: "Emerging",
  false: "No",
  faded: "Faded",
  futures_proxy: "Futures proxy",
  high: "High",
  level_1: "Level 1",
  level_2: "Level 2",
  level_3: "Level 3",
  live: "Live",
  live_seen: "Live data",
  live_xauusd_spot: "Live XAUUSD spot",
  local_csv_fallback: "Local CSV fallback",
  low: "Low",
  market_closed_last_xauusd_spot: "Market closed XAUUSD spot",
  medium: "Medium",
  medium_high: "Medium high",
  micro_theme: "Micro theme",
  neutral: "Neutral",
  no_meaningful_change: "No meaningful change",
  not_confirming: "Not confirming",
  possible: "Possible",
  proxy: "Proxy",
  retired: "Retired",
  spot: "Spot",
  stale: "Stale data",
  suppressed: "Suppressed",
  temporary_event: "Temporary event",
  true: "Yes",
  unavailable: "Not available",
  unconfirmed: "Unconfirmed",
  unknown: "Unknown",
  watching: "Watching",
  xauusd: "XAUUSD",
  xauusd_recent_history: "XAUUSD recent history"
};

const DRIVER_LABELS: Record<string, string> = {
  ai_power_demand: "AI power demand",
  banking_stress: "Banking stress",
  central_bank_gold: "Central bank gold",
  china_demand: "China demand",
  dxy: "DXY / USD",
  economic_calendar: "Economic calendar",
  fed_rates: "Fed / rates",
  fiscal_debt: "Fiscal debt",
  geopolitics: "Geopolitics",
  inflation: "Inflation",
  liquidity: "Liquidity",
  oil_inflation: "Oil / inflation",
  positioning: "Positioning",
  real_yields: "Real yields",
  risk_sentiment: "Risk sentiment",
  supply_chain: "Supply chain",
  technical_liquidation: "Technical liquidation",
  trade_tariffs: "Trade / tariffs",
  treasury_supply: "Treasury supply",
  usd: "DXY / USD",
  us10y: "US10Y",
  us2y: "US2Y",
  yields: "US yields"
};

export const normalizeMarketAgentValue = (value: unknown) =>
  String(value ?? "")
    .trim()
    .replace(/[\s-]+/g, "_")
    .toLowerCase();

export const humanizeMarketAgentValue = (value: unknown, fallback = "--") => {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : fallback;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  const normalized = normalizeMarketAgentValue(value);
  if (LABELS[normalized]) return LABELS[normalized];
  return String(value)
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
};

export const formatDriverLabel = (driverId: unknown, fallback = "Unknown driver") => {
  const normalized = normalizeMarketAgentValue(driverId);
  return DRIVER_LABELS[normalized] ?? humanizeMarketAgentValue(driverId, fallback);
};

const parseMarketAgentTime = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value < 1_000_000_000_000 ? value * 1000 : value);
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  if (/^\d{10,13}$/.test(trimmed)) {
    const numeric = Number.parseInt(trimmed, 10);
    return new Date(trimmed.length <= 10 ? numeric * 1000 : numeric);
  }
  return new Date(trimmed);
};

export const formatShortTime = (value: unknown, fallback = "--") => {
  const parsed = parseMarketAgentTime(value);
  if (!parsed) return fallback;
  if (Number.isNaN(parsed.getTime())) return String(value);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${pad(parsed.getDate())}-${pad(parsed.getMonth() + 1)} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
};

export const formatRelevance = (score: unknown) => {
  if (typeof score !== "number" || !Number.isFinite(score)) return "Relevance not scored";
  if (score >= 0.75) return "High relevance";
  if (score >= 0.45) return "Medium relevance";
  if (score > 0) return "Low relevance";
  return "Background only";
};

export const humanizeMarketAgentReason = (value: unknown, fallback = "No state change reason recorded.") => {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const text = value.trim();
  const mainDriverChange = text.match(/^main_driver\s+(.+?)\s*->\s*(.+)$/i);
  if (mainDriverChange) {
    return `Main driver changed from ${formatDriverLabel(mainDriverChange[1])} to ${formatDriverLabel(mainDriverChange[2])}.`;
  }
  const biasChange = text.match(/^current_bias\s+(.+?)\s*->\s*(.+)$/i);
  if (biasChange) {
    return `Market bias changed from ${humanizeMarketAgentValue(biasChange[1])} to ${humanizeMarketAgentValue(biasChange[2])}.`;
  }
  return humanizeMarketAgentValue(text, fallback);
};

export const badgeToneForValue = (value: unknown): "neutral" | "good" | "warn" | "bad" | "info" => {
  const normalized = normalizeMarketAgentValue(value);
  if (["live", "live_seen", "confirmed", "active", "available", "spot"].includes(normalized)) return "good";
  if (["backfilled", "proxy", "futures_proxy", "watching", "emerging", "possible", "likely", "cooling", "suppressed", "local_csv_fallback"].includes(normalized)) return "warn";
  if (["stale", "unavailable", "retired", "unknown", "unconfirmed", "blocked", "disabled"].includes(normalized)) return "bad";
  if (["confirming", "core_structural"].includes(normalized)) return "info";
  return "neutral";
};

export const findProviderHealth = (
  items: MarketAgentProviderHealthEntry[] | undefined,
  keys: string[]
) => {
  const normalizedKeys = new Set(keys.map(normalizeMarketAgentValue));
  return items?.find((item) => normalizedKeys.has(normalizeMarketAgentValue(item.provider_key ?? item.source)));
};

export const buildSituationSummary = (
  snapshot: MarketAgentSnapshotResponse | null,
  xauusdHealth: MarketAgentProviderHealthEntry | undefined
) => {
  const state = snapshot?.state;
  if (!snapshot?.available || !state) return "Market Agent has not run yet.";

  const bias = normalizeMarketAgentValue(state.current_bias);
  const mainDriver = normalizeMarketAgentValue(state.main_driver);
  const causeStatus = normalizeMarketAgentValue(state.cause_status);
  const sourceType = normalizeMarketAgentValue(xauusdHealth?.source_type);
  const dataMode = normalizeMarketAgentValue(xauusdHealth?.data_mode);
  const priceIsMarketClosed = Boolean(
    xauusdHealth?.is_available &&
    (xauusdHealth.is_stale || dataMode === "stale") &&
    typeof xauusdHealth.current_value === "number" &&
    Number.isFinite(xauusdHealth.current_value)
  );

  if (priceIsMarketClosed) {
    return "XAUUSD market is closed. The last cTrader price is fixed while news and calendar context keep updating.";
  }

  if (causeStatus === "no_meaningful_change" || (bias === "neutral" && mainDriver === "unknown")) {
    return "No meaningful XAUUSD move detected. Market Agent is watching for fresh driver changes.";
  }

  if (causeStatus === "unconfirmed" || mainDriver === "unknown") {
    return "Move is unconfirmed. No strong macro or news driver passed evidence gates.";
  }

  if (mainDriver.includes("yield") || mainDriver === "usd" || mainDriver === "dxy") {
    return "Gold is currently under yield/USD pressure.";
  }

  if (sourceType === "futures_proxy" || dataMode === "proxy") {
    return `Market Agent sees ${formatDriverLabel(state.main_driver)} as the main driver, using a futures proxy for price.`;
  }

  return `Market Agent sees ${formatDriverLabel(state.main_driver)} as the main driver with ${humanizeMarketAgentValue(state.confidence).toLowerCase()} confidence.`;
};

export const providerGuidance = (item: MarketAgentProviderHealthEntry | undefined) => {
  if (!item) return "No provider status has been recorded for this source.";
  const sourceType = normalizeMarketAgentValue(item.source_type);
  const dataMode = normalizeMarketAgentValue(item.data_mode);
  const source = normalizeMarketAgentValue(item.source);

  if (!item.is_available || sourceType === "unavailable" || dataMode === "unavailable") {
    if (normalizeMarketAgentValue(item.provider_key) === "us2y") {
      return "US2Y is unavailable, so it is not treated as neutral or confirming evidence.";
    }
    return item.error || item.stale_reason || "This source is not available for evidence in the latest run.";
  }
  if (item.is_stale || dataMode === "stale") {
    if (typeof item.current_value === "number" && Number.isFinite(item.current_value)) {
      return "Market is closed or the feed is paused. The last XAUUSD price can be shown, but current driver scoring waits for a fresh quote.";
    }
    return item.stale_reason || "The latest value is stale and cannot confirm a fresh move.";
  }
  if (sourceType === "futures_proxy") return "Using Yahoo GC=F futures proxy, not true spot XAUUSD.";
  if (sourceType === "local_csv_fallback" || dataMode === "local_csv_fallback" || source.includes("csv")) {
    return "Using local CSV fallback. Configure cTrader or Yahoo provider for live monitoring.";
  }
  if (sourceType === "spot") return "True spot quote source for XAUUSD when cTrader is configured and fresh.";
  return "Fresh enough for monitoring, but evidence gates still decide whether it confirms a driver.";
};
