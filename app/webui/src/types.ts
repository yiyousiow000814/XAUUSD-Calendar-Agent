export type LogEntry = {
  time: string;
  message: string;
  level: string;
};

export type FilterOption = "ALL" | "INFO" | "WARN" | "ERROR";

export type ToastType = "success" | "error" | "info";

export type UiModal = {
  id: string;
  title: string;
  message: string;
  tone: "info" | "error";
};

export type EventItem = {
  id: string;
  state?: "upcoming" | "current";
  time: string;
  // UTC timestamp for the specific release instance (used for Deep Analysis unified outlook window).
  dtUtc?: string;
  cur: string;
  impact: string;
  event: string;
  actual?: string;
  forecast?: string;
  previous?: string;
  countdown: string;
};

export type PastEventItem = {
  time: string;
  // UTC timestamp for the specific release instance (used for Deep Analysis unified outlook window).
  dtUtc?: string;
  cur: string;
  impact: string;
  event: string;
  actual: string;
  forecast: string;
  previous: string;
};

export type EventHistoryPoint = {
  date: string;
  time: string;
  actual: string;
  actualRaw?: string;
  actualRevisedFrom?: string;
  forecast: string;
  previous: string;
  previousRaw?: string;
  previousRevisedFrom?: string;
  period?: string;
};

export type EventHistoryResponse = {
  ok: boolean;
  eventId?: string;
  metric?: string;
  frequency?: string;
  period?: string;
  cur?: string;
  points?: EventHistoryPoint[];
  cached?: boolean;
  message?: string;
};

export type EventImpactBucket = "ap_gt_prev" | "ap_lt_prev" | "ap_eq_prev";

export type EventImpactWindowStats = {
  n: number;
  p_up?: number;
  p_down?: number;
  p10?: number;
  p50?: number;
  p90?: number;
  p05_all?: number;
  up_n?: number;
  down_n?: number;
  up_p10?: number | null;
  up_p50?: number | null;
  up_p90?: number | null;
  down_p10?: number | null;
  down_p50?: number | null;
  down_p90?: number | null;
  best_direction?: "up" | "down";
  best_p?: number;
  best_median_pct?: number;
  p10_all?: number;
  p25_all?: number;
  p50_all?: number;
  p75_all?: number;
  p90_all?: number;
  p95_all?: number;
};

export type EventImpactResponse = { 
  ok: boolean;
  message?: string;
  eventId?: string;
  bucket?: EventImpactBucket;
  generatedAtUtc?: string;
  meta?: {
    price_min_utc?: string | null;
    price_max_utc?: string | null;
    event_source_tz?: string | null;
    event_min_utc?: string | null;
    event_max_utc?: string | null;
    sample_points?: number | null;
  };
  windowsMinutes?: number[];
  data?: Record<string, EventImpactWindowStats>;
}; 

export type DeepAnalysisPrediction = {
  // Probability in [0, 1].
  p?: number;
  // Sample size / training events count (if available).
  n?: number;
  // Optional calibrated confidence label for UI.
  confidence?: "low" | "medium" | "high";
  // Human-readable explanation items (already ranked in the exporter).
  reasons?: string[];
};

export type EventDeepAnalysisData = {
  // Predict the release outcome (the economic number).
  predictRelease?: {
    // Probability that actual > forecast.
    actualGtForecast?: DeepAnalysisPrediction;
    // Probability that actual > previous.
    actualGtPrevious?: DeepAnalysisPrediction;
  };
  // Predict the market reaction (XAUUSD). Optional for now.
  predictMarket?: {
    // e.g. { "15m": { pUp: 0.58, n: 120 }, "60m": ... }
    horizons?: Record<string, { pUp?: number; n?: number; moveP50?: number | null }>;
    // Single unified outlook path P(t) for a window; events should contribute weighted deltas to it.
    unifiedPath?: {
      offsetsMinutes: number[];
      // Probability that XAUUSD is up at each offset.
      pUp: number[];
    };
    // Optional contributions (deltas) per event; UI can highlight without changing the main path.
    contributions?: Array<{
      eventId: string;
      label?: string;
      weight?: number;
      deltaPUp?: number[];
    }>;
  };
  // Optional method metadata for "How it's computed" UI.
  method?: {
    name?: string;
    version?: string;
    summary?: string;
    steps?: string[];
    limitations?: string[];
  };
  // Optional list of signal descriptors used by the exporter.
  signalsUsed?: Array<{ id?: string; title?: string; weight?: number; note?: string } | string>;
  // Raw signal flags / context (preheat/path/joint/trend/etc).
  signals?: Record<string, unknown>;
};

export type EventDeepAnalysisResponse = {
  ok: boolean;
  message?: string;
  eventId?: string;
  generatedAtUtc?: string;
  meta?: Record<string, unknown> | null;
  data?: EventDeepAnalysisData | Record<string, unknown>;
};

export type PredictReleaseModel = {
  schema: number;
  generated_at_utc?: string;
  meta?: Record<string, unknown>;
  classes?: string[];
  models?: Record<string, unknown>;
};

export type PredictReleaseModelResponse = {
  ok: boolean;
  message?: string;
  source?: string;
  data?: PredictReleaseModel | Record<string, unknown>;
};

export type MarketAgentState = {
  current_bias: string;
  main_driver: string;
  secondary_driver?: string | null;
  risk_driver?: string | null;
  confidence: string;
  cause_status: string;
  last_alert_time: string;
  last_alert_summary: string;
  last_analysis_time?: string;
  last_notification_level?: string;
  state_change_reason?: string;
  invalidation_triggered?: boolean;
  invalidation_triggered_by?: string[];
  invalidation_conditions?: string[];
};

export type MarketAgentAlert = {
  time: string;
  notification_level: string;
  message: string;
  main_driver?: string;
  bias?: string;
  state_change_reason?: string;
  confidence_delta?: string;
  previous_state_invalidated?: boolean;
  invalidation_triggered_by?: string[];
};

export type MarketAgentSnapshotResponse = {
  ok: boolean;
  available: boolean;
  message?: string;
  state_path?: string;
  alerts_path?: string;
  state: MarketAgentState | null;
  alerts: MarketAgentAlert[];
};

export type Snapshot = {
  lastPull: string;
  lastSync: string;
  lastPullAt?: string;
  lastSyncAt?: string;
  outputDir: string;
  repoPath: string;
  currency: string;
  currencyOptions: string[];
  events: EventItem[];
  pastEvents: PastEventItem[];
  logs: LogEntry[];
  version: string;
  pullActive?: boolean;
  syncActive?: boolean;
  calendarStatus?: "loading" | "downloading" | "loaded" | "empty" | "error";
  restartInSeconds?: number;
  modal?: UiModal | null;
};

export type Settings = {
  autoSyncAfterPull: boolean;
  autoUpdateEnabled: boolean;
  runOnStartup: boolean;
  autostartLaunchMode: "tray" | "show";
  closeBehavior: "exit" | "tray";
  traySupported: boolean;
  debug: boolean;
  autoSave: boolean;
  splitRatio: number;
  enableSystemTheme: boolean;
  theme: "system" | "dark" | "light";
  calendarTimezoneMode: "utc" | "system";
  calendarUtcOffsetMinutes: number;
  enableTemporaryPath: boolean;
  temporaryPath: string;
  repoPath: string;
  logPath: string;
};
