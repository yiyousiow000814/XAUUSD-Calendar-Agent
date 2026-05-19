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
  timeline_store_path?: string;
  timeline_available?: boolean;
  state: MarketAgentState | null;
  alerts: MarketAgentAlert[];
};

export type MarketAgentProviderHealthEntry = {
  provider_key?: string;
  source: string;
  source_type: string;
  fetched_at?: string;
  data_timestamp?: string;
  data_mode: string;
  is_available: boolean;
  is_stale: boolean;
  stale_reason?: string;
  error?: string;
  raw_source_id?: string;
  latency_ms?: number | null;
  current_value?: number | null;
  previous_value?: number | null;
  change_value?: number | null;
  change_unit?: string;
  monitor_run_id?: number;
  run_started_at?: string;
};

export type MarketAgentDriverAttentionState = {
  driver_id: string;
  label?: string;
  category?: string;
  current_state: string;
  priority: string;
  relevance_score?: number;
  activation_reason?: string;
  deactivation_reason?: string;
  first_activated_at?: string;
  last_confirmed_at?: string;
  last_evidence_at?: string;
  decay_deadline?: string;
  current_evidence_summary?: string;
  current_counter_evidence?: string;
  confidence: string;
  source_count?: number;
  related_news_count?: number;
  related_calendar_events?: number;
  notes?: string;
  data_mode: string;
  monitor_run_id?: number;
  run_started_at?: string;
};

export type MarketAgentTimelineEvent = {
  monitor_run_id: number;
  event_time: string;
  event_type: string;
  label: string;
  payload: Record<string, unknown>;
};

export type MarketAgentStateTransition = Record<string, unknown> & {
  monitor_run_id?: number;
  run_started_at?: string;
};

export type MarketAgentAlertTimelineItem = Record<string, unknown> & {
  monitor_run_id?: number;
  run_started_at?: string;
  should_notify?: boolean;
};

export type MarketAgentReplayPayload = {
  price_series: Record<string, unknown>[];
  related_assets: Record<string, Record<string, unknown>[]>;
  news_items: Record<string, unknown>[];
  calendar_events: Record<string, unknown>[];
  driver_attention_timeline: Record<string, unknown>[];
  timeline_events: MarketAgentTimelineEvent[];
  state_transitions: MarketAgentStateTransition[];
  alerts: MarketAgentAlertTimelineItem[];
  suppressed_alerts: MarketAgentAlertTimelineItem[];
};

export type MarketAgentReplayResponse = {
  ok: boolean;
  available: boolean;
  message?: string;
  timeline_store_path?: string;
  start?: string;
  end?: string;
  replay: MarketAgentReplayPayload;
};

export type MarketAgentProviderHealthResponse = {
  ok: boolean;
  available: boolean;
  message?: string;
  timeline_store_path?: string;
  monitor_run_id?: number | null;
  run_started_at?: string | null;
  items: MarketAgentProviderHealthEntry[];
};

export type MarketAgentProviderConfig = {
  enabled: boolean;
  environment: string;
  symbol: string;
  symbolId?: number | null;
  accountId: string;
  clientIdMasked: string;
  clientSecretMasked: string;
  accessTokenMasked: string;
  refreshTokenMasked: string;
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
  appRedirectUri?: string;
  tokenStorePath: string;
  snapshotPath: string;
  quoteTimeoutSeconds: number;
  quoteStaleAfterSeconds: number;
  allowSavedSnapshotFallback: boolean;
  bridgePythonExecutable: string;
  configPath: string;
};

export type MarketAgentProviderConfigResponse = {
  ok: boolean;
  available: boolean;
  message?: string;
  ctrader?: MarketAgentProviderConfig | null;
};

export type MarketAgentProviderConfigInput = {
  enabled: boolean;
  environment: string;
  clientId: string;
  clientSecret: string;
  accessToken: string;
  refreshToken: string;
  accountId: string;
  symbol: string;
  symbolId?: number | null;
  appRedirectUri?: string;
  tokenStorePath?: string;
  snapshotPath?: string;
  quoteTimeoutSeconds: number;
  quoteStaleAfterSeconds: number;
  allowSavedSnapshotFallback: boolean;
  bridgePythonExecutable?: string;
};

export type MarketAgentProviderActionResponse = {
  ok: boolean;
  message?: string;
  error?: string;
  provider_health?: Record<string, unknown> | null;
  quote?: Record<string, unknown> | null;
  symbol?: Record<string, unknown> | null;
  account?: Record<string, unknown> | null;
  ctrader?: MarketAgentProviderConfig | null;
  tokenStorePath?: string;
};

export type MarketAgentTelegramConfig = {
  enabled: boolean;
  botTokenMasked: string;
  hasBotToken: boolean;
  chatId: string;
  timeoutSeconds: number;
  levels: string[];
  configPath: string;
  lastSendStatus?: string;
  lastError?: string;
};

export type MarketAgentTelegramConfigResponse = {
  ok: boolean;
  available: boolean;
  message?: string;
  telegram?: MarketAgentTelegramConfig | null;
};

export type MarketAgentTelegramConfigInput = {
  enabled: boolean;
  botToken: string;
  chatId: string;
  timeoutSeconds: number;
  levels: string[];
};

export type MarketAgentTelegramActionResponse = {
  ok: boolean;
  status?: string;
  message?: string;
  error?: string;
  telegram?: MarketAgentTelegramConfig | null;
};

export type MarketAgentLLMConfig = {
  enabled: boolean;
  provider: string;
  endpoint: string;
  model: string;
  temperature: number;
  timeoutSeconds: number;
  keepAlive: string;
  maxContext: number;
  configPath: string;
  lastStatus?: string;
  lastError?: string;
};

export type MarketAgentLLMConfigResponse = {
  ok: boolean;
  available: boolean;
  message?: string;
  llm?: MarketAgentLLMConfig | null;
};

export type MarketAgentLLMConfigInput = {
  enabled: boolean;
  provider: string;
  endpoint: string;
  model: string;
  temperature: number;
  timeoutSeconds: number;
  keepAlive: string;
  maxContext: number;
};

export type MarketAgentLLMActionResponse = {
  ok: boolean;
  status?: string;
  message?: string;
  error?: string;
  llm?: MarketAgentLLMConfig | null;
};

export type MarketAgentDriverAttentionResponse = {
  ok: boolean;
  available: boolean;
  message?: string;
  timeline_store_path?: string;
  monitor_run_id?: number | null;
  run_started_at?: string | null;
  states: MarketAgentDriverAttentionState[];
};

export type MarketAgentTimelineResponse = {
  ok: boolean;
  available: boolean;
  message?: string;
  timeline_store_path?: string;
  start?: string;
  end?: string;
  items: MarketAgentTimelineEvent[];
};

export type MarketAgentEvidenceForRunPayload = {
  monitor_run?: Record<string, unknown> | null;
  evidence_packet?: Record<string, unknown> | null;
  analysis_result?: Record<string, unknown> | null;
  provider_health?: Record<string, unknown>[];
  driver_attention_states?: Record<string, unknown>[];
  alerts?: Record<string, unknown>[];
  state_transition?: Record<string, unknown> | null;
};

export type MarketAgentEvidenceForRunResponse = {
  ok: boolean;
  available: boolean;
  message?: string;
  timeline_store_path?: string;
  monitor_run_id?: number;
  payload: MarketAgentEvidenceForRunPayload;
};

export type MarketAgentStateTransitionsResponse = {
  ok: boolean;
  available: boolean;
  message?: string;
  timeline_store_path?: string;
  start?: string;
  end?: string;
  items: MarketAgentStateTransition[];
};

export type MarketAgentSuppressedAlertsResponse = {
  ok: boolean;
  available: boolean;
  message?: string;
  timeline_store_path?: string;
  start?: string;
  end?: string;
  items: MarketAgentAlertTimelineItem[];
};

export type MarketAgentMonitorStatusResponse = {
  ok: boolean;
  available: boolean;
  running: boolean;
  phase: string;
  pid?: number | null;
  intervalSeconds?: number;
  lastRunAt?: number | string | null;
  nextRunAt?: number | string | null;
  lastRecoveryAt?: number | string | null;
  lastError?: string;
  message?: string;
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
