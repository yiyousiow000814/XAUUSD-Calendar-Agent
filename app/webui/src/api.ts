import type {
  EventDeepAnalysisResponse,
  EventHistoryResponse,
  EventImpactResponse,
  MarketAgentDriverAttentionResponse,
  MarketAgentEvidenceForRunResponse,
  MarketAgentLLMActionResponse,
  MarketAgentLLMConfigInput,
  MarketAgentLLMConfigResponse,
  MarketAgentLLMSetupResponse,
  MarketAgentMonitorStatusResponse,
  MarketAgentOllamaPullProgress,
  MarketAgentCTraderAuthResponse,
  MarketAgentProviderActionResponse,
  MarketAgentProviderConfigInput,
  MarketAgentProviderConfigResponse,
  MarketAgentProviderHealthResponse,
  MarketAgentReplayResponse,
  MarketAgentSnapshotResponse,
  MarketAgentStateTransitionsResponse,
  MarketAgentSuppressedAlertsResponse,
  MarketAgentTelegramActionResponse,
  MarketAgentTelegramConfigInput,
  MarketAgentTelegramConfigResponse,
  MarketAgentTimelineResponse,
  PredictReleaseModelResponse,
  Settings,
  Snapshot
} from "./types";
import { CURRENCY_OPTIONS } from "./constants/currencyOptions";
import { formatLocalDateTime } from "./utils/calendarTime";

type ApiResult<T> = Promise<T>;

type UpdateState = {
  ok: boolean;
  phase: string;
  message: string;
  availableVersion?: string;
  progress?: number;
  downloadedBytes?: number;
  totalBytes?: number | null;
  lastCheckedAt?: string;
};

type BackendApi = { 
  get_snapshot: () => ApiResult<Snapshot>; 
  get_event_history?: (payload: { event: string; cur: string }) => ApiResult<EventHistoryResponse>; 
  get_event_impact_usd?: (payload: { eventId: string; bucket: string }) => ApiResult<EventImpactResponse>; 
  get_event_deep_analysis_usd?: (payload: { eventId: string; anchorDtUtc?: string }) => ApiResult<EventDeepAnalysisResponse>;
  get_predict_release_model_usd?: () => ApiResult<PredictReleaseModelResponse>;
  get_market_agent_snapshot?: (payload: { limit?: number }) => ApiResult<MarketAgentSnapshotResponse>;
  get_market_agent_replay?: (payload: { start: string; end: string }) => ApiResult<MarketAgentReplayResponse>;
  get_market_agent_timeline?: (payload: { start: string; end: string }) => ApiResult<MarketAgentTimelineResponse>;
  get_market_agent_provider_health?: (_payload: Record<string, never>) => ApiResult<MarketAgentProviderHealthResponse>;
  get_market_agent_provider_config?: (_payload: Record<string, never>) => ApiResult<MarketAgentProviderConfigResponse>;
  get_market_agent_driver_attention?: (_payload: Record<string, never>) => ApiResult<MarketAgentDriverAttentionResponse>;
  get_market_agent_evidence_for_run?: (payload: { monitorRunId: number }) => ApiResult<MarketAgentEvidenceForRunResponse>;
  get_market_agent_state_transitions?: (payload: { start: string; end: string }) => ApiResult<MarketAgentStateTransitionsResponse>;
  get_market_agent_suppressed_alerts?: (payload: { start: string; end: string }) => ApiResult<MarketAgentSuppressedAlertsResponse>;
  get_market_agent_monitor_status?: (_payload: Record<string, never>) => ApiResult<MarketAgentMonitorStatusResponse>;
  run_market_agent_monitor_once?: (_payload: Record<string, never>) => ApiResult<MarketAgentMonitorStatusResponse>;
  run_market_agent_backfill_recovery?: (_payload: Record<string, never>) => ApiResult<MarketAgentMonitorStatusResponse>;
  start_market_agent_monitor_loop?: (payload: { intervalSeconds: number }) => ApiResult<MarketAgentMonitorStatusResponse>;
  stop_market_agent_monitor_loop?: (_payload: Record<string, never>) => ApiResult<MarketAgentMonitorStatusResponse>;
  save_market_agent_provider_config?: (payload: { ctrader: MarketAgentProviderConfigInput }) => ApiResult<MarketAgentProviderConfigResponse>;
  get_market_agent_llm_config?: (_payload: Record<string, never>) => ApiResult<MarketAgentLLMConfigResponse>;
  save_market_agent_llm_config?: (payload: { llm: MarketAgentLLMConfigInput }) => ApiResult<MarketAgentLLMConfigResponse>;
  test_market_agent_llm_connection?: (payload: { llm: MarketAgentLLMConfigInput }) => ApiResult<MarketAgentLLMActionResponse>;
  test_market_agent_llm_json_response?: (payload: { llm: MarketAgentLLMConfigInput }) => ApiResult<MarketAgentLLMActionResponse>;
  detect_local_ai_setup?: (payload: Record<string, unknown>) => ApiResult<MarketAgentLLMSetupResponse>;
  pull_ollama_model?: (payload: { model: string; endpoint?: string }) => ApiResult<MarketAgentLLMActionResponse>;
  cancel_model_download?: (payload: { model?: string }) => ApiResult<MarketAgentLLMActionResponse>;
  benchmark_llm?: (payload: { llm: MarketAgentLLMConfigInput }) => ApiResult<MarketAgentLLMActionResponse>;
  apply_llm_fallback_policy?: (payload: Record<string, unknown>) => ApiResult<MarketAgentLLMActionResponse>;
  get_market_agent_telegram_config?: (_payload: Record<string, never>) => ApiResult<MarketAgentTelegramConfigResponse>;
  save_market_agent_telegram_config?: (payload: { telegram: MarketAgentTelegramConfigInput }) => ApiResult<MarketAgentTelegramConfigResponse>;
  test_market_agent_telegram?: (payload: { telegram: MarketAgentTelegramConfigInput }) => ApiResult<MarketAgentTelegramActionResponse>;
  test_ctrader_connection?: (payload: { ctrader: MarketAgentProviderConfigInput }) => ApiResult<MarketAgentProviderActionResponse>;
  resolve_ctrader_symbol?: (payload: { ctrader: MarketAgentProviderConfigInput }) => ApiResult<MarketAgentProviderActionResponse>;
  get_ctrader_quote_test?: (payload: { ctrader: MarketAgentProviderConfigInput }) => ApiResult<MarketAgentProviderActionResponse>;
  start_ctrader_connect?: (payload: { ctrader: MarketAgentProviderConfigInput }) => ApiResult<MarketAgentCTraderAuthResponse>;
  test_ctrader_backfill?: (payload: { ctrader: MarketAgentProviderConfigInput }) => ApiResult<MarketAgentProviderActionResponse>;
  clear_ctrader_config?: (_payload: Record<string, never>) => ApiResult<MarketAgentProviderConfigResponse>;
  get_settings: () => ApiResult<Settings>; 
  save_settings: (payload: Settings) => ApiResult<{ ok: boolean }>; 
  frontend_boot_complete?: () => ApiResult<{ ok: boolean }>; 
  set_ui_state?: (payload: { visible: boolean; focused: boolean; lastInputAt: number }) => ApiResult<{ ok: boolean }>; 
  get_temporary_path_task: () => ApiResult<{
    ok: boolean;
    active: boolean;
    phase: string;
    progress: number;
    message: string;
    path: string;
  }>;
  probe_temporary_path: (payload: {
    enableTemporaryPath: boolean;
    temporaryPath: string;
    autoStart?: boolean;
  }) => ApiResult<{
    ok: boolean;
    status: string;
    ready: boolean;
    needsConfirmation: boolean;
    canUseAsIs: boolean;
    canReset: boolean;
    path: string;
    message: string;
    details?: Record<string, unknown>;
    action?: string;
    taskActive?: boolean;
    taskPath?: string;
  }>;
  temporary_path_use_as_is: (payload: { temporaryPath: string }) => ApiResult<{ ok: boolean; message?: string }>;
  temporary_path_reset: (payload: { temporaryPath: string }) => ApiResult<{ ok: boolean; message?: string }>;
  get_update_state: () => ApiResult<UpdateState>;
  check_updates: () => ApiResult<{ ok: boolean; message?: string }>;
  update_now: () => ApiResult<{ ok: boolean; message?: string }>;
  install_update: () => ApiResult<{ ok: boolean; message?: string }>;
  open_log: () => ApiResult<{ ok: boolean; message?: string }>;
  open_path: (path: string) => ApiResult<{ ok: boolean; message?: string }>;
  open_url?: (url: string) => ApiResult<{ ok: boolean; message?: string }>;
  open_release_notes?: () => ApiResult<{ ok: boolean; message?: string }>;
  add_log: (payload: { message: string; level?: string }) => ApiResult<{ ok: boolean }>;
  browse_temporary_path: () => ApiResult<{ ok: boolean; path?: string }>;
  set_temporary_path: (path: string) => ApiResult<{ ok: boolean }>;
  pull_now: () => ApiResult<{ ok: boolean }>;
  sync_now: () => ApiResult<{ ok: boolean }>;
  browse_output_dir: () => ApiResult<{ ok: boolean; path?: string }>;
  set_output_dir: (path: string) => ApiResult<{ ok: boolean }>;
  set_currency: (value: string) => ApiResult<{ ok: boolean }>;
  clear_logs: () => ApiResult<{ ok: boolean }>;
  dismiss_modal?: (payload: { id: string }) => ApiResult<{ ok: boolean }>;
};

type TauriEventListen = (event: string, handler: (event: unknown) => void) => unknown;
type TauriEventUnlisten = (id: unknown) => unknown;

const isUiCheckRuntime = () => {
  if (typeof window === "undefined") return false;
  return (window as { __UI_CHECK_RUNTIME__?: boolean }).__UI_CHECK_RUNTIME__ === true;
};

const getTauriInvoke = () => {
  if (typeof window === "undefined") return null;
  const win = window as unknown as {
    __TAURI__?: { core?: { invoke?: unknown }; invoke?: unknown };
    __TAURI_INTERNALS__?: { invoke?: unknown };
  };
  const invoker =
    (win.__TAURI__?.core?.invoke as unknown) ??
    (win.__TAURI__?.invoke as unknown) ??
    (win.__TAURI_INTERNALS__?.invoke as unknown);
  return typeof invoker === "function"
    ? (invoker as <U>(cmd: string, args?: Record<string, unknown>) => Promise<U>)
    : null;
};

const isTauri = () => {
  return getTauriInvoke() !== null;
};

export const isWebview = () => {
  if (isUiCheckRuntime()) return false;
  return isTauri();
};

const getTauriListen = () => {
  if (typeof window === "undefined") return null;
  const win = window as unknown as {
    __TAURI__?: { event?: { listen?: unknown; unlisten?: unknown } };
    __TAURI_INTERNALS__?: { event?: { listen?: unknown; unlisten?: unknown } };
  };
  const listen =
    (win.__TAURI__?.event?.listen as unknown) ??
    (win.__TAURI_INTERNALS__?.event?.listen as unknown);
  return typeof listen === "function" ? (listen as TauriEventListen) : null;
};

const getTauriUnlisten = () => {
  if (typeof window === "undefined") return null;
  const win = window as unknown as {
    __TAURI__?: { event?: { unlisten?: unknown } };
    __TAURI_INTERNALS__?: { event?: { unlisten?: unknown } };
  };
  const unlisten =
    (win.__TAURI__?.event?.unlisten as unknown) ??
    (win.__TAURI_INTERNALS__?.event?.unlisten as unknown);
  return typeof unlisten === "function" ? (unlisten as TauriEventUnlisten) : null;
};

export const tauriListen = async <T,>(event: string, onPayload: (payload: T) => void) => {
  if (isUiCheckRuntime()) return null;
  const listen = getTauriListen();
  if (!listen) return null;

  const handler = (evt: unknown) => {
    const payload = (evt as { payload?: unknown } | null)?.payload ?? evt;
    onPayload(payload as T);
  };

  const res = listen(event, handler);

  if (typeof res === "function") {
    return res as () => void;
  }
  if (res && typeof (res as Promise<unknown>).then === "function") {
    const awaited = await (res as Promise<unknown>);
    if (typeof awaited === "function") return awaited as () => void;
    const unlisten = getTauriUnlisten();
    if (unlisten) {
      return () => {
        try {
          void unlisten(awaited);
        } catch {
          // Ignore.
        }
      };
    }
    return null;
  }

  const unlisten = getTauriUnlisten();
  if (!unlisten) return null;
  return () => {
    try {
      void unlisten(res);
    } catch {
      // Ignore.
    }
  };
};

const tauriInvoke = async <T,>(command: string, payload?: Record<string, unknown>) => {
  const invokeFn = getTauriInvoke();
  if (!invokeFn) {
    throw new Error("Tauri invoke unavailable");
  }
  const timeoutMs = 8000;
  return Promise.race([
    payload && Object.keys(payload).length > 0
      ? invokeFn<T>(command, payload)
      : invokeFn<T>(command),
    new Promise<T>((_, reject) => {
      window.setTimeout(() => {
        reject(new Error(`Tauri invoke timeout (${timeoutMs}ms): ${command}`));
      }, timeoutMs);
    })
  ]);
};

const tauriApiRef = (): BackendApi | null => {
  if (!isTauri()) return null;
  return new Proxy({} as BackendApi, {
    get: (_target, prop) => {
      if (typeof prop !== "string") return undefined;
      // Prevent the Proxy from being treated as a "thenable" (Promise-like) value.
      // Some async flows (e.g. `await withApi()`) will probe `.then` and accidentally invoke it.
      if (prop === "then") return undefined;
      return (...args: unknown[]) => {
        if (args.length === 0) return tauriInvoke(prop);
        const first = args[0];
        if (prop === "open_path" || prop === "set_output_dir" || prop === "set_temporary_path") {
          return tauriInvoke(prop, { path: String(first ?? "") });
        }
        if (prop === "set_currency") {
          return tauriInvoke(prop, { value: String(first ?? "") });
        }
        if (prop === "open_url") {
          return tauriInvoke(prop, { url: String(first ?? "") });
        }
        return tauriInvoke(prop, { payload: first as Record<string, unknown> });
      };
    }
  });
};

const desktopApiRef = () => tauriApiRef();

const baseMockSnapshot: Snapshot = {
  lastPull: "04-01-2026 06:51",
  lastSync: "Not yet",
  lastPullAt: "2026-01-04T06:51:00",
  lastSyncAt: "",
  outputDir: "",
  repoPath: "",
  currency: "USD",
  currencyOptions: Array.from(CURRENCY_OPTIONS),
  pullActive: false,
  syncActive: false,
  restartInSeconds: 0,
  events: [
    {
      id: "mock-evt-1",
      state: "upcoming",
      time: "05-01-2026 01:30",
      cur: "USD",
      impact: "Medium",
      event: "FOMC Member Kaplan Speaks",
      countdown: "18h 27m"
    },
    {
      id: "mock-evt-2",
      state: "upcoming",
      time: "05-01-2026 03:10",
      cur: "USD",
      impact: "Low",
      event: "ISM Services PMI",
      countdown: "20h 05m"
    },
    {
      id: "mock-evt-3",
      state: "upcoming",
      time: "05-01-2026 04:00",
      cur: "EUR",
      impact: "High",
      event: "ECB President Speech",
      countdown: "21h 00m"
    },
    {
      id: "mock-evt-4",
      state: "upcoming",
      time: "05-01-2026 06:30",
      cur: "GBP",
      impact: "Low",
      event: "UK Manufacturing PMI",
      countdown: "23h 30m"
    }
  ],
  pastEvents: [
    {
      time: "06-01-2026 15:00",
      cur: "JPY",
      impact: "Low",
      event: "Household Spending",
      actual: "-0.2",
      forecast: "--",
      previous: "--"
    },
    {
      time: "06-01-2026 18:00",
      cur: "USD",
      impact: "Medium",
      event: "Fed Balance Sheet",
      actual: "--",
      forecast: "--",
      previous: "--"
    },
    {
      time: "06-01-2026 21:30",
      cur: "USD",
      impact: "High",
      event: "CPI (MoM)",
      actual: "+0.1",
      forecast: "+0.2",
      previous: "+0.3"
    },
    {
      time: "05-01-2026 03:00",
      cur: "USD",
      impact: "High",
      event: "ISM Services PMI",
      actual: "52.1",
      forecast: "52.0",
      previous: "51.8"
    },
    {
      time: "05-01-2026 12:30",
      cur: "USD",
      impact: "Medium",
      event: "Jobless Claims",
      actual: "217k",
      forecast: "220k",
      previous: "219k"
    }
  ],
  logs: [
    { time: "04-01-2026 07:02", message: "Repo already up to date", level: "INFO" },
    { time: "04-01-2026 07:02", message: "Calendar snapshot loaded", level: "INFO" }
  ],
  // Browser-only mock: the real app version is provided by the desktop backend (APP_VERSION).
  version: "0.0.0",
  modal: null
};

const getMockSnapshot = () =>
  ((window as unknown as { __MOCK_SNAPSHOT__?: Snapshot }).__MOCK_SNAPSHOT__ ??
    baseMockSnapshot) as Snapshot;

const setMockSnapshot = (next: Snapshot) => {
  (window as unknown as { __MOCK_SNAPSHOT__?: Snapshot }).__MOCK_SNAPSHOT__ = next;
  return next;
};

const normalizeMockPathKey = (value: string) =>
  String(value || "")
    .trim()
    .replace(/[\\/]+$/, "")
    .toLowerCase();

const getMockOutputLastSync = (outputDir: string) => {
  const key = normalizeMockPathKey(outputDir);
  const map =
    (window as unknown as { __MOCK_OUTPUT_LAST_SYNC__?: Record<string, { lastSyncAt: string; lastSync: string }> })
      .__MOCK_OUTPUT_LAST_SYNC__ ?? {};
  return map[key] || { lastSyncAt: "", lastSync: "Not yet" };
};

const setMockOutputLastSync = (outputDir: string, payload: { lastSyncAt: string; lastSync: string }) => {
  const key = normalizeMockPathKey(outputDir);
  if (!key) return;
  const win = window as unknown as {
    __MOCK_OUTPUT_LAST_SYNC__?: Record<string, { lastSyncAt: string; lastSync: string }>;
  };
  win.__MOCK_OUTPUT_LAST_SYNC__ = { ...(win.__MOCK_OUTPUT_LAST_SYNC__ ?? {}), [key]: payload };
};

const baseMockUpdateState: UpdateState = {
  ok: true,
  phase: "idle",
  message: "",
  availableVersion: "",
  progress: 0,
  lastCheckedAt: ""
};

const getMockUpdateState = () =>
  ((window as unknown as { __MOCK_UPDATE_STATE__?: UpdateState }).__MOCK_UPDATE_STATE__ ??
    baseMockUpdateState) as UpdateState;

const setMockUpdateState = (next: Partial<UpdateState>) => {
  const win = window as unknown as { __MOCK_UPDATE_STATE__?: UpdateState };
  win.__MOCK_UPDATE_STATE__ = { ...getMockUpdateState(), ...next, ok: true };
  return win.__MOCK_UPDATE_STATE__;
};

const mockUpdateTimers: { download?: number } = {};

let mockSettings: Settings = {
  autoSyncAfterPull: true,
  autoUpdateEnabled: true,
  runOnStartup: true,
  autostartLaunchMode: "tray",
  closeBehavior: "exit",
  traySupported: true,
  debug: false,
  autoSave: true,
  splitRatio: 0.66,
  enableSystemTheme: false,
  theme: "dark",
  calendarTimezoneMode: "system",
  calendarUtcOffsetMinutes: 0,
  enableTemporaryPath: false,
  temporaryPath: "",
  repoPath: "",
  logPath: "C:\\\\Users\\\\User\\\\AppData\\\\Roaming\\\\XAUUSDCalendar\\\\logs\\\\app.log"
};

const buildMockMarketAgentSnapshot = (): MarketAgentSnapshotResponse => ({
  ok: true,
  available: true,
  state_path: "user-data/market_agent_state.json",
  alerts_path: "user-data/market_agent_alerts.ndjson",
  timeline_store_path: "user-data/market_agent_timeline.sqlite",
  timeline_available: true,
  state: {
    current_bias: "bearish_gold",
    main_driver: "yields",
    secondary_driver: "usd",
    risk_driver: null,
    confidence: "high",
    cause_status: "confirmed",
    last_alert_time: "2026-05-19T08:00:00+08:00",
    last_alert_summary: "Gold remains under pressure.",
    last_analysis_time: "2026-05-19T08:05:00+08:00",
    last_notification_level: "level_3",
    state_change_reason: "main_driver usd -> yields",
    invalidation_triggered: false,
    invalidation_triggered_by: [],
    invalidation_conditions: ["US10Y drops more than 7 bps"]
  },
  alerts: [
    {
      time: "2026-05-19T08:00:00+08:00",
      notification_level: "level_3",
      message: "Gold remains under pressure.",
      main_driver: "yields",
      bias: "bearish_gold"
    },
    {
      time: "2026-05-19T07:10:00+08:00",
      notification_level: "level_1",
      message: "XAUUSD rebounded, but cross-asset confirmation stayed mixed.",
      main_driver: "unknown",
      bias: "unknown"
    }
  ]
});

const buildMockMarketAgentReplay = (): MarketAgentReplayResponse => ({
  ok: true,
  available: true,
  timeline_store_path: "user-data/market_agent_timeline.sqlite",
  start: "2026-05-19T04:00:00+08:00",
  end: "2026-05-19T08:30:00+08:00",
  replay: {
    price_series: [
      {
        symbol: "XAUUSD",
        data_timestamp: "2026-05-19T07:30:00+08:00",
        close_price: 4521.4,
        bid_price: 4521.15,
        ask_price: 4521.65,
        source: "cTrader",
        source_type: "spot",
        data_mode: "live_seen",
        is_stale: false
      },
      {
        symbol: "XAUUSD",
        data_timestamp: "2026-05-19T08:00:00+08:00",
        close_price: 4504.8,
        bid_price: 4504.52,
        ask_price: 4505.08,
        source: "cTrader",
        source_type: "spot",
        data_mode: "live_seen",
        is_stale: false
      }
    ],
    related_assets: {
      dxy: [{ symbol: "dxy", data_timestamp: "2026-05-19T08:00:00+08:00", change_15m: 0.22, source_type: "proxy", data_mode: "live_seen" }],
      us10y: [{ symbol: "us10y", data_timestamp: "2026-05-19T08:00:00+08:00", change_15m: 5.1, source_type: "proxy", data_mode: "live_seen" }],
      us2y: [],
      wti: [{ symbol: "wti", data_timestamp: "2026-05-19T08:00:00+08:00", change_15m: 1.7, source_type: "proxy", data_mode: "live_seen" }],
      brent: [],
      vix: [{ symbol: "vix", data_timestamp: "2026-05-19T08:00:00+08:00", change_15m: 2.4, source_type: "proxy", data_mode: "live_seen" }],
      spx: [{ symbol: "spx", data_timestamp: "2026-05-19T08:00:00+08:00", change_15m: -0.6, source_type: "proxy", data_mode: "live_seen" }],
      nasdaq: [{ symbol: "nasdaq", data_timestamp: "2026-05-19T08:00:00+08:00", change_15m: -0.8, source_type: "proxy", data_mode: "live_seen" }]
    },
    news_items: [
      {
        title: "Fed headline pressures yields",
        source: "Reuters",
        published_at: "2026-05-19T08:03:00+08:00",
        included: true,
        data_mode: "backfilled",
        semantic_type: "news",
        impact_percent: -0.21
      }
    ],
    calendar_events: [
      {
        title: "US session opens",
        scheduled_at: "2026-05-19T08:14:00+08:00",
        source: "ForexFactory",
        data_mode: "live_seen",
        semantic_type: "session",
        impact_percent: -0.08
      }
    ],
    driver_attention_timeline: [
      {
        monitor_run_id: 22,
        driver_id: "yields",
        current_state: "active",
        priority: "core_structural",
        relevance_score: 0.91,
        confidence: "medium_high",
        data_mode: "backfilled"
      },
      {
        monitor_run_id: 22,
        driver_id: "oil_inflation",
        current_state: "cooling",
        priority: "conditional_macro",
        relevance_score: 0.42,
        confidence: "medium",
        data_mode: "live_seen"
      }
    ],
    timeline_events: [
      {
        monitor_run_id: 21,
        event_time: "2026-05-19T07:56:00+08:00",
        event_type: "analysis",
        label: "Range held near session low",
        payload: { semantic_type: "range", impact_percent: 0.05, direction: "flat", main_driver: "unknown", data_mode: "live_seen" }
      },
      {
        monitor_run_id: 21,
        event_time: "2026-05-19T07:58:00+08:00",
        event_type: "analysis",
        label: "Reversal attempt rejected",
        payload: { semantic_type: "reversal", impact_percent: 0.24, direction: "up", main_driver: "technical_liquidation", data_mode: "live_seen" }
      },
      {
        monitor_run_id: 22,
        event_time: "2026-05-19T07:55:00+08:00",
        event_type: "recovery_summary",
        label: "Recovered selloff",
        payload: { semantic_type: "breakout", impact_percent: -0.68, direction: "down", data_mode: "backfilled", cause_status: "likely", main_driver: "yields" }
      },
      {
        monitor_run_id: 23,
        event_time: "2026-05-19T08:05:00+08:00",
        event_type: "market_alert",
        label: "Yields pressure",
        payload: { semantic_type: "breakout", impact_percent: -0.48, direction: "down", data_mode: "proxy", cause_status: "confirmed", main_driver: "yields" }
      }
    ],
    state_transitions: [
      {
        monitor_run_id: 23,
        run_started_at: "2026-05-19T08:05:00+08:00",
        state_change_reason: "main_driver usd -> yields",
        previous_state_invalidated: false
      }
    ],
    alerts: [
      {
        monitor_run_id: 23,
        run_started_at: "2026-05-19T08:05:00+08:00",
        should_notify: true,
        notification_level: "level_3",
        message: "XAUUSD dropped 0.48%. Active driver: yields/USD.",
        semantic_type: "breakout",
        impact_percent: -0.48
      }
    ],
    suppressed_alerts: [
      {
        monitor_run_id: 24,
        run_started_at: "2026-05-19T07:20:00+08:00",
        should_notify: false,
        notification_level: "level_1",
        message: "Suppressed duplicate continuation.",
        semantic_type: "range",
        impact_percent: 0.04
      }
    ]
  }
});

const buildMockMarketAgentProviderHealth = (): MarketAgentProviderHealthResponse => ({
  ok: true,
  available: true,
  timeline_store_path: "user-data/market_agent_timeline.sqlite",
  monitor_run_id: 23,
  run_started_at: "2026-05-19T08:05:00+08:00",
  items: [
    {
      provider_key: "xauusd",
      source: "cTrader",
      source_type: "spot",
      data_mode: "live_seen",
      is_available: true,
      is_stale: false,
      data_timestamp: "2026-05-19T08:00:00+08:00",
      fetched_at: "2026-05-19T08:05:02+08:00"
    },
    {
      provider_key: "us2y",
      source: "US2Y",
      source_type: "unavailable",
      data_mode: "unavailable",
      is_available: false,
      is_stale: false,
      stale_reason: "No reliable free 2Y source configured.",
      error: "Provider unavailable."
    },
    {
      provider_key: "calendar",
      source: "ForexFactory",
      source_type: "calendar",
      data_mode: "live_seen",
      is_available: true,
      is_stale: false,
      data_timestamp: "2026-05-19T08:15:00+08:00",
      fetched_at: "2026-05-19T08:05:01+08:00"
    }
  ]
});

const buildMockMarketAgentProviderConfig = (): MarketAgentProviderConfigResponse => ({
  ok: true,
  available: true,
  ctrader: {
    enabled: false,
    environment: "demo",
    symbol: "XAUUSD",
    symbolId: null,
    accountId: "",
    ctidMasked: "",
    passwordMasked: "",
    hasPassword: false,
    snapshotPath: "user-data/ctrader-last-quote.json",
    quoteTimeoutSeconds: 8,
    quoteStaleAfterSeconds: 15,
    allowSavedSnapshotFallback: true,
    configPath: "user-data/ctrader-cli.json"
  }
});

const buildMockMarketAgentProviderAction = (
  overrides: Partial<MarketAgentProviderActionResponse> = {}
): MarketAgentProviderActionResponse => ({
  ok: true,
  message: "Mocked cTrader action completed.",
  ...overrides
});

const buildMockMarketAgentTelegramConfig = (): MarketAgentTelegramConfigResponse => ({
  ok: true,
  available: true,
  telegram: {
    enabled: false,
    botTokenMasked: "12********90",
    hasBotToken: true,
    chatId: "123456789",
    timeoutSeconds: 10,
    levels: ["level_2", "level_3"],
    configPath: "user-data/market-agent-telegram.json",
    lastSendStatus: "not tested",
    lastError: ""
  }
});

const buildMockMarketAgentTelegramAction = (
  overrides: Partial<MarketAgentTelegramActionResponse> = {}
): MarketAgentTelegramActionResponse => ({
  ok: true,
  status: "sent",
  message: "Telegram test message sent.",
  telegram: buildMockMarketAgentTelegramConfig().telegram ?? null,
  ...overrides
});

const buildMockMarketAgentLLMConfig = (): MarketAgentLLMConfigResponse => ({
  ok: true,
  available: true,
  llm: {
    enabled: false,
    provider: "ollama",
    endpoint: "http://127.0.0.1:21434",
    model: "qwen3.5:4b",
    temperature: 0.1,
    timeoutSeconds: 20,
    keepAlive: "0",
    maxContext: 8192,
    configPath: "user-data/market-agent-llm.json",
    lastStatus: "disabled",
    lastError: ""
  }
});

const buildMockMarketAgentLLMSetup = (
  overrides: Partial<MarketAgentLLMSetupResponse> = {}
): MarketAgentLLMSetupResponse => ({
  ok: true,
  available: true,
  status: "model_missing",
  message: "Recommended model is missing.",
  system: {
    os: "windows",
    arch: "x86_64",
    cpu: "AMD Ryzen 7",
    logicalCpuCount: 16,
    ramBytes: 34_359_738_368,
    gpuVendor: "NVIDIA",
    gpuName: "NVIDIA GeForce RTX 3060 Ti",
    vramBytes: 8_589_934_592,
    nvidiaAvailable: true
  },
  ollama: {
    installed: true,
    running: true,
    endpointReachable: true,
    endpoint: "http://127.0.0.1:21434",
    version: "0.9.0"
  },
  installedModels: [],
  recommendedModel: {
    name: "qwen3.5:4b",
    tier: "balanced",
    label: "Balanced",
    approximateSizeBytes: 2_900_000_000,
    diskLabel: "~2.9 GB",
    reason: "NVIDIA GPU with 8GB VRAM or better can use the balanced model for fast JSON."
  },
  profiles: [],
  fallbackChain: ["qwen3.5:4b", "qwen3.5:2b", "qwen3.5:0.8b", "rule-based-only"],
  ruleBasedActive: true,
  llm: buildMockMarketAgentLLMConfig().llm ?? null,
  ...overrides
});

const buildMockMarketAgentLLMAction = (
  overrides: Partial<MarketAgentLLMActionResponse> = {}
): MarketAgentLLMActionResponse => ({
  ok: true,
  status: "available",
  message: "Local AI is available and returned valid JSON.",
  llm: buildMockMarketAgentLLMConfig().llm ?? null,
  ...overrides
});

const buildMockMarketAgentDriverAttention = (): MarketAgentDriverAttentionResponse => ({
  ok: true,
  available: true,
  timeline_store_path: "user-data/market_agent_timeline.sqlite",
  monitor_run_id: 23,
  run_started_at: "2026-05-19T08:05:00+08:00",
  states: [
    {
      driver_id: "usd",
      label: "DXY (USD Index)",
      category: "macro",
      current_state: "active",
      priority: "core_structural",
      relevance_score: 0.92,
      impact_percent: -0.65,
      confidence: "high",
      activation_reason: "DXY confirms pressure.",
      deactivation_reason: "",
      last_confirmed_at: "2026-05-19T08:05:00+08:00",
      decay_deadline: "2026-05-19T10:05:00+08:00",
      data_mode: "live_seen"
    },
    {
      driver_id: "yields",
      label: "US10Y (Yield)",
      category: "macro",
      current_state: "active",
      priority: "core_structural",
      relevance_score: 0.85,
      impact_percent: -0.12,
      confidence: "medium_high",
      activation_reason: "US10Y fresh and confirming.",
      deactivation_reason: "",
      last_confirmed_at: "2026-05-19T08:05:00+08:00",
      decay_deadline: "2026-05-19T10:05:00+08:00",
      data_mode: "backfilled"
    },
    {
      driver_id: "us2y",
      label: "US2Y (Yield)",
      category: "macro",
      current_state: "watching",
      priority: "core_structural",
      relevance_score: 0.62,
      impact_percent: -0.08,
      confidence: "medium",
      activation_reason: "Front-end yield is monitored for confirmation.",
      deactivation_reason: "",
      last_confirmed_at: "",
      decay_deadline: "2026-05-19T09:05:00+08:00",
      data_mode: "backfilled"
    },
    {
      driver_id: "oil_inflation",
      label: "WTI Oil",
      category: "macro",
      current_state: "watching",
      priority: "conditional_macro",
      relevance_score: 0.58,
      impact_percent: 0.45,
      confidence: "medium",
      activation_reason: "Oil is moving, but the inflation channel is incomplete.",
      deactivation_reason: "",
      last_confirmed_at: "",
      decay_deadline: "2026-05-19T09:05:00+08:00",
      data_mode: "live_seen"
    },
    {
      driver_id: "vix_equities",
      label: "VIX (Volatility)",
      category: "risk",
      current_state: "dormant",
      priority: "conditional_macro",
      relevance_score: 0.28,
      impact_percent: -2.15,
      confidence: "low",
      activation_reason: "",
      deactivation_reason: "Risk tone is monitored, not yet causal.",
      last_confirmed_at: "",
      decay_deadline: "",
      data_mode: "live_seen"
    },
    {
      driver_id: "risk_sentiment",
      label: "S&P 500",
      category: "risk",
      current_state: "dormant",
      priority: "conditional_macro",
      relevance_score: 0.25,
      impact_percent: 0.28,
      confidence: "low",
      activation_reason: "",
      deactivation_reason: "Equity risk tone has not confirmed the move.",
      last_confirmed_at: "",
      decay_deadline: "",
      data_mode: "live_seen"
    },
    {
      driver_id: "geopolitics",
      label: "Geopolitics / News",
      category: "event",
      current_state: "watching",
      priority: "temporary_event",
      relevance_score: 0.5,
      impact_percent: null,
      confidence: "medium",
      activation_reason: "Headline detected, waiting for market confirmation.",
      deactivation_reason: "",
      last_confirmed_at: "",
      decay_deadline: "2026-05-19T09:05:00+08:00",
      data_mode: "live_seen"
    },
    {
      driver_id: "unknown",
      label: "Unknown Drivers",
      category: "fallback",
      current_state: "emerging",
      priority: "background_noise",
      relevance_score: 0.45,
      impact_percent: null,
      confidence: "low",
      activation_reason: "XAUUSD moved before a confirmed macro driver appeared.",
      deactivation_reason: "",
      last_confirmed_at: "",
      decay_deadline: "2026-05-19T08:35:00+08:00",
      data_mode: "live_seen"
    }
  ]
});

const buildMockMarketAgentTimeline = (): MarketAgentTimelineResponse => ({
  ok: true,
  available: true,
  timeline_store_path: "user-data/market_agent_timeline.sqlite",
  start: "2026-05-19T04:00:00+08:00",
  end: "2026-05-19T08:30:00+08:00",
  items: buildMockMarketAgentReplay().replay.timeline_events
});

const buildMockMarketAgentEvidenceForRun = (monitorRunId: number): MarketAgentEvidenceForRunResponse => ({
  ok: true,
  available: true,
  timeline_store_path: "user-data/market_agent_timeline.sqlite",
  monitor_run_id: monitorRunId,
  payload: {
    monitor_run: {
      monitor_run_id: monitorRunId,
      run_started_at: "2026-05-19T08:05:00+08:00",
      run_type: "recovery",
      data_mode: "backfilled",
      backfill_required: true
    },
    evidence_packet: {
      allowed_candidate_drivers: ["yields", "usd"],
      blocked_drivers: {
        fed_rates: "No direct Fed headline in monitored window.",
        geopolitics: "No timestamped headline with confirmation."
      },
      evidence_status: {
        dxy: "confirming",
        us10y: "confirming",
        us2y: "unavailable",
        oil: "neutral",
        news: "backfilled_news_found"
      },
      cross_asset_confirmation: {
        dxy: "confirming",
        us10y: "confirming",
        oil: "background_only",
        vix_equities: "neutral"
      },
      provider_health: {
        xauusd: { source_type: "spot", data_mode: "live_seen" }
      },
      active_driver_states: [{ driver_id: "yields", current_state: "active" }],
      dormant_driver_states: [{ driver_id: "oil_inflation", current_state: "dormant" }]
    },
    analysis_result: {
      main_driver: "yields",
      cause_status: "likely",
      confidence: "medium_high",
      rejected_driver: "fed_rates",
      rejection_reason: "blocked driver"
    },
    provider_health: buildMockMarketAgentProviderHealth().items,
    driver_attention_states: buildMockMarketAgentDriverAttention().states,
    alerts: buildMockMarketAgentReplay().replay.alerts,
    state_transition: buildMockMarketAgentReplay().replay.state_transitions[0]
  }
});

const buildMockMarketAgentStateTransitions = (): MarketAgentStateTransitionsResponse => ({
  ok: true,
  available: true,
  timeline_store_path: "user-data/market_agent_timeline.sqlite",
  start: "2026-05-19T04:00:00+08:00",
  end: "2026-05-19T08:30:00+08:00",
  items: buildMockMarketAgentReplay().replay.state_transitions
});

const buildMockMarketAgentSuppressedAlerts = (): MarketAgentSuppressedAlertsResponse => ({
  ok: true,
  available: true,
  timeline_store_path: "user-data/market_agent_timeline.sqlite",
  start: "2026-05-19T04:00:00+08:00",
  end: "2026-05-19T08:30:00+08:00",
  items: buildMockMarketAgentReplay().replay.suppressed_alerts
});

let mockMarketAgentMonitorStatus: MarketAgentMonitorStatusResponse = {
  ok: true,
  available: true,
  running: false,
  phase: "stopped",
  pid: null,
  intervalSeconds: 60,
  lastRunAt: null,
  nextRunAt: null,
  lastError: "",
  message: "Monitor loop is stopped.",
  activity: {
    ctrader: {
      status: "live",
      label: "XAUUSD live",
      detail: "Mock cTrader price feed is active."
    },
    history: {
      status: "idle",
      label: "History current",
      detail: "No backfill gap detected."
    },
    context: {
      status: "active",
      label: "News and calendar",
      detail: "Mock headlines and calendar events are available.",
      newsCount: 2,
      calendarCount: 1
    },
    llm: {
      status: "skipped",
      label: "Rule-based",
      detail: "Evidence gate and deterministic rules are running."
    },
    alerts: {
      status: "idle",
      label: "No alert",
      detail: "No current live alert passed the gate."
    }
  }
};

const withApi = async () => desktopApiRef();

const hasMethod = (api: BackendApi | null, key: keyof BackendApi) =>
  Boolean(api && typeof api[key] === "function");

const buildMockEventHistory = (payload: { event: string; cur: string }): EventHistoryResponse => {
  const points = (() => {
    const count = 120;
    const start = new Date(Date.UTC(2026, 0, 22));
    const pad = (value: number) => String(value).padStart(2, "0");
    const fmtDate = (dt: Date) =>
      `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;

    const result: Array<{
      date: string;
      time: string;
      actual: string;
      actualRaw: string;
      actualRevisedFrom: string;
      forecast: string;
      previous: string;
      previousRaw: string;
      previousRevisedFrom: string;
      period: string;
    }> = [];

    let lastPoint: (typeof result)[number] | null = null;
    // Build oldest -> newest to match backend sorting expectations.
    for (let i = count - 1; i >= 0; i -= 1) {
      const dt = new Date(start);
      dt.setUTCDate(start.getUTCDate() - i * 7);
      const actualK = 220 + Math.round(Math.sin(i / 5) * 12 + (i % 4) * 2);
      const forecastK = 221 + Math.round(Math.cos(i / 6) * 10 - (i % 3));
      const monthTokens = [
        "jan",
        "feb",
        "mar",
        "apr",
        "may",
        "jun",
        "jul",
        "aug",
        "sep",
        "oct",
        "nov",
        "dec"
      ] as const;
      const period = monthTokens[dt.getUTCMonth()] ?? "";

      const actualRaw = `${actualK}k`;
      const forecast = `${forecastK}k`;
      const previousBase = lastPoint && i % 17 !== 0 ? lastPoint.actual : "--";
      let previous = previousBase;
      let previousRaw = previousBase;
      let previousRevisedFrom = "";

      // Simulate occasional revisions: the newer row's Previous value revises the older
      // row's Actual. Keep the old value in `actualRevisedFrom` and surface the revision
      // under the newer row's Previous.
      if (lastPoint && previousBase !== "--" && i % 23 === 0) {
        const base = Number(lastPoint.actualRaw.replace(/k/i, ""));
        const revised = Number.isFinite(base) ? Math.max(0, base - 3) : base;
        const revisedValue = `${revised}k`;
        previous = revisedValue;
        previousRaw = revisedValue;
        previousRevisedFrom = lastPoint.actualRaw;
        lastPoint.actualRevisedFrom = lastPoint.actualRaw;
        lastPoint.actual = revisedValue;
      }

      const point = {
        date: fmtDate(dt),
        time: "08:30",
        actual: actualRaw,
        actualRaw,
        actualRevisedFrom: "",
        forecast,
        previous,
        previousRaw,
        previousRevisedFrom,
        period
      };
      result.push(point);
      lastPoint = point;
    }
    return result;
  })();

  return {
    ok: true,
    // Keep the mock payload aligned with production semantics (e.g. Impact analysis gating checks `USD::` prefix).
    eventId: `${payload.cur}::${payload.event}`,
    metric: payload.event,
    frequency: "m/m",
    period: "",
    cur: payload.cur,
    points
  };
};

const buildMockEventImpactUsd = (payload: {
  eventId: string;
  bucket: string;
}): EventImpactResponse => {
  if (!payload.eventId.startsWith("USD::")) {
    return { ok: false, message: "Impact analysis unavailable." };
  }
  const windowsMinutes = [-12 * 60, -4 * 60, -60, -15, -5, -1, 0, 1, 5, 15, 60, 4 * 60, 12 * 60];

  const data: Record<string, any> = {};
  for (const offset of windowsMinutes) {
    const key = String(offset);
    if (offset === 0) {
      data[key] = {
        n: 80,
        p_up: 0.5,
        p_down: 0.5,
        p10: 0,
        p50: 0,
        p90: 0,
        p05_all: 0,
        p10_all: 0,
        p25_all: 0,
        p50_all: 0,
        p75_all: 0,
        p90_all: 0,
        p95_all: 0,
        up_n: 40,
        down_n: 40,
        up_p10: 0,
        up_p50: 0,
        up_p90: 0,
        down_p10: 0,
        down_p50: 0,
        down_p90: 0,
        best_direction: "up",
        best_p: 0.5,
        best_median_pct: 0
      };
      continue;
    }
    const abs = Math.abs(offset);
    const norm = Math.min(1, abs / (4 * 60));
    const tilt = offset < 0 ? -1 : 1;
    const median = tilt * (0.06 + 0.08 * norm) * (0.6 + 0.4 * Math.sin(abs / 90));
    const spread = 0.12 + 0.1 * norm;
    const upMedian = Math.abs(median) * 0.92;
    const downMedian = -Math.abs(median) * 1.04;
    const bestDirection = median >= 0 ? "up" : "down";
    const pUp = bestDirection === "up" ? 0.63 : 0.37;
    const pDown = 1 - pUp;
    // Mock all-sample distribution (used by the UI's density bands).
    const allMedian = (pUp * upMedian + pDown * downMedian) / Math.max(1e-9, pUp + pDown);
    const allSpread = spread * 0.9;
    const p05All = allMedian - allSpread * 1.35;
    const p10All = allMedian - allSpread * 1.0;
    const p25All = allMedian - allSpread * 0.55;
    const p75All = allMedian + allSpread * 0.55;
    const p90All = allMedian + allSpread * 1.0;
    const p95All = allMedian + allSpread * 1.35;

    // Keep conditional stats in the mock (still used by tooltip), but UI may choose not to render them.
    const upSpread = Math.min(spread * 0.55, Math.abs(upMedian) * 0.85);
    const downSpread = Math.min(spread * 0.55, Math.abs(downMedian) * 0.85);
    const upP10 = upMedian - upSpread;
    const upP90 = upMedian + spread * 0.6;
    const downP10 = downMedian - spread * 0.6;
    const downP90 = downMedian + downSpread;
    data[key] = {
      n: 80,
      p_up: pUp,
      p_down: pDown,
      p10: bestDirection === "up" ? upP10 : downP10,
      p50: bestDirection === "up" ? upMedian : downMedian,
      p90: bestDirection === "up" ? upP90 : downP90,
      p05_all: p05All,
      p10_all: p10All,
      p25_all: p25All,
      p50_all: allMedian,
      p75_all: p75All,
      p90_all: p90All,
      p95_all: p95All,
      up_n: Math.round(80 * pUp),
      down_n: Math.round(80 * pDown),
      up_p10: upP10,
      up_p50: upMedian,
      up_p90: upP90,
      down_p10: downP10,
      down_p50: downMedian,
      down_p90: downP90,
      best_direction: bestDirection,
      best_p: Math.max(pUp, pDown),
      best_median_pct: bestDirection === "up" ? upMedian : downMedian
    };
  }

  return {
    ok: true,
    eventId: payload.eventId,
    bucket: payload.bucket as any,
    generatedAtUtc: "2026-01-31T00:00:00Z",
    meta: {
      event_source_tz: "UTC+8",
      event_min_utc: "2016-10-18T00:00:00Z",
      event_max_utc: "2026-01-30T00:00:00Z",
      sample_points: 80,
      price_min_utc: "2016-10-18T00:00:00Z",
      price_max_utc: "2026-01-30T00:00:00Z"
    },
    windowsMinutes,
    data
  };
};

const buildMockEventDeepAnalysisUsd = (payload: {
  eventId: string;
  anchorDtUtc?: string;
}): EventDeepAnalysisResponse => {
  if (!payload.eventId.startsWith("USD::")) {
    return { ok: false, message: "Deep analysis unavailable." };
  }

  const stepMinutes = 15;
  const displayHalfMinutes = 24 * 60;
  const offsetsMinutes: number[] = [];
  for (let t = -displayHalfMinutes; t <= displayHalfMinutes; t += stepMinutes) {
    offsetsMinutes.push(t);
  }

  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  const pUp = offsetsMinutes.map((t) => {
    const x = t / displayHalfMinutes; // -1..+1
    const s = Math.tanh(x * 1.4); // smooth regime drift
    const w = Math.sin(t / 180) * 0.04 + Math.sin(t / 520) * 0.02; // small waves
    return clamp01(0.5 + 0.16 * s + w);
  });
  const pUpPrior = pUp.map((p, idx) => {
    const t = offsetsMinutes[idx] ?? 0;
    const wobble = Math.sin(t / 260) * 0.02;
    return clamp01(0.5 + (p - 0.5) * 0.72 + wobble);
  });

  // Keep labels stable in ui-check: use the anchor when present.
  const asOfUtc = String(payload.anchorDtUtc || "2026-01-30T08:30:00Z");

  return {
    ok: true,
    eventId: payload.eventId,
    generatedAtUtc: asOfUtc,
    meta: {
      source: "ui-check-mock"
    },
    data: {
      predictMarket: {
        unifiedPath: {
          offsetsMinutes,
          pUp
        },
        unifiedPathPrior: {
          offsetsMinutes,
          pUp: pUpPrior
        },
        contributions: [
          {
            eventId: `${payload.eventId}@mock-1`,
            label: "Mock nearby event · 30-01-2026 08:30",
            weight: 1,
            deltaPUp: offsetsMinutes.map((t) => Math.sin(t / 260) * 0.02)
          },
          {
            eventId: `${payload.eventId}@mock-2`,
            label: "Mock nearby event · 30-01-2026 09:30",
            weight: 0.8,
            deltaPUp: offsetsMinutes.map((t) => Math.cos(t / 320) * 0.015)
          }
        ],
        unifiedMeta: {
          source: "ui-check-mock",
          anchorEventId: payload.eventId,
          anchorDtUtc: asOfUtc,
          asOfUtc,
          displayWindowMinutes: displayHalfMinutes,
          includeWindowMinutes: displayHalfMinutes * 2,
          stepMinutes,
          nearbyEvents: 8,
          displayEvents: 2,
          usedActualEvents: 2,
          usedForecastEvents: 2,
          usedUnconditionalEvents: 0,
          adjustedByActual: true
        }
      },
      method: {
        name: "ui-check-mock",
        version: "1",
        summary: "Mock deep analysis payload used by ui-check to validate layout and interactions."
      }
    }
  };
};

export const backend = { 
  getSnapshot: async (): ApiResult<Snapshot> => {
    if (isTauri()) {
      return tauriInvoke("get_snapshot");
    }
    if (isWebview() && !isUiCheckRuntime()) {
      throw new Error("Desktop backend unavailable");
    }
    return Promise.resolve(getMockSnapshot());
  },
  getEventHistory: async (payload: { event: string; cur: string }) => {
    if (isUiCheckRuntime()) {
      return Promise.resolve(buildMockEventHistory(payload));
    }
    const api = await withApi();
    if (!api || !hasMethod(api, "get_event_history")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return Promise.resolve(buildMockEventHistory(payload));
    }
    // Tauri invoke proxy wraps method args as `{ payload: ... }`, so align with that shape.
    return api.get_event_history({ event: payload.event, cur: payload.cur } as any);
  },
  getEventImpactUsd: async (payload: { eventId: string; bucket: string }) => { 
    if (isUiCheckRuntime()) {
      return Promise.resolve(buildMockEventImpactUsd(payload));
    }
    const api = await withApi();
    if (!api || !hasMethod(api, "get_event_impact_usd")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return Promise.resolve({ ok: false, message: "Impact analysis unavailable" });
    }
    return api.get_event_impact_usd({ eventId: payload.eventId, bucket: payload.bucket } as any); 
  }, 
  getEventDeepAnalysisUsd: async (payload: { eventId: string; anchorDtUtc?: string }) => {
    if (isUiCheckRuntime()) {
      return Promise.resolve(buildMockEventDeepAnalysisUsd(payload));
    }
    const api = await withApi();
    if (!api || !hasMethod(api, "get_event_deep_analysis_usd")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return Promise.resolve({ ok: false, message: "Deep analysis unavailable" });
    }
    return api.get_event_deep_analysis_usd({ eventId: payload.eventId, anchorDtUtc: payload.anchorDtUtc });
  },
  getPredictReleaseModelUsd: async (): ApiResult<PredictReleaseModelResponse> => {
    if (isUiCheckRuntime()) {
      return Promise.resolve({ ok: false, message: "Predict release model unavailable in ui-check runtime" });
    }
    const api = await withApi();
    if (!api || !hasMethod(api, "get_predict_release_model_usd")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return Promise.resolve({ ok: false, message: "Predict release model unavailable" });
    }
    return api.get_predict_release_model_usd();
  },
  getMarketAgentSnapshot: async (limit = 5): ApiResult<MarketAgentSnapshotResponse> => {
    if (isUiCheckRuntime()) {
      return Promise.resolve(buildMockMarketAgentSnapshot());
    }
    const api = await withApi();
    if (!api || !hasMethod(api, "get_market_agent_snapshot")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return Promise.resolve(buildMockMarketAgentSnapshot());
    }
    return api.get_market_agent_snapshot({ limit });
  },
  getMarketAgentReplay: async (start: string, end: string): ApiResult<MarketAgentReplayResponse> => {
    if (isUiCheckRuntime()) {
      return Promise.resolve(buildMockMarketAgentReplay());
    }
    const api = await withApi();
    if (!api || !hasMethod(api, "get_market_agent_replay")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return Promise.resolve(buildMockMarketAgentReplay());
    }
    return api.get_market_agent_replay({ start, end });
  },
  getMarketAgentTimeline: async (start: string, end: string): ApiResult<MarketAgentTimelineResponse> => {
    if (isUiCheckRuntime()) {
      return Promise.resolve(buildMockMarketAgentTimeline());
    }
    const api = await withApi();
    if (!api || !hasMethod(api, "get_market_agent_timeline")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return Promise.resolve(buildMockMarketAgentTimeline());
    }
    return api.get_market_agent_timeline({ start, end });
  },
  getMarketAgentProviderHealth: async (): ApiResult<MarketAgentProviderHealthResponse> => {
    if (isUiCheckRuntime()) {
      return Promise.resolve(buildMockMarketAgentProviderHealth());
    }
    const api = await withApi();
    if (!api || !hasMethod(api, "get_market_agent_provider_health")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return Promise.resolve(buildMockMarketAgentProviderHealth());
    }
    return api.get_market_agent_provider_health({});
  },
  getMarketAgentProviderConfig: async (): ApiResult<MarketAgentProviderConfigResponse> => {
    if (isUiCheckRuntime()) {
      return Promise.resolve(buildMockMarketAgentProviderConfig());
    }
    const api = await withApi();
    if (!api || !hasMethod(api, "get_market_agent_provider_config")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return Promise.resolve(buildMockMarketAgentProviderConfig());
    }
    return api.get_market_agent_provider_config({});
  },
  getMarketAgentTelegramConfig: async (): ApiResult<MarketAgentTelegramConfigResponse> => {
    if (isUiCheckRuntime()) {
      return Promise.resolve(buildMockMarketAgentTelegramConfig());
    }
    const api = await withApi();
    if (!api || !hasMethod(api, "get_market_agent_telegram_config")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return Promise.resolve(buildMockMarketAgentTelegramConfig());
    }
    return api.get_market_agent_telegram_config({});
  },
  getMarketAgentLLMConfig: async (): ApiResult<MarketAgentLLMConfigResponse> => {
    if (isUiCheckRuntime()) {
      return Promise.resolve(buildMockMarketAgentLLMConfig());
    }
    const api = await withApi();
    if (!api || !hasMethod(api, "get_market_agent_llm_config")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return Promise.resolve(buildMockMarketAgentLLMConfig());
    }
    return api.get_market_agent_llm_config({});
  },
  getMarketAgentDriverAttention: async (): ApiResult<MarketAgentDriverAttentionResponse> => {
    if (isUiCheckRuntime()) {
      return Promise.resolve(buildMockMarketAgentDriverAttention());
    }
    const api = await withApi();
    if (!api || !hasMethod(api, "get_market_agent_driver_attention")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return Promise.resolve(buildMockMarketAgentDriverAttention());
    }
    return api.get_market_agent_driver_attention({});
  },
  getMarketAgentEvidenceForRun: async (monitorRunId: number): ApiResult<MarketAgentEvidenceForRunResponse> => {
    if (isUiCheckRuntime()) {
      return Promise.resolve(buildMockMarketAgentEvidenceForRun(monitorRunId));
    }
    const api = await withApi();
    if (!api || !hasMethod(api, "get_market_agent_evidence_for_run")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return Promise.resolve(buildMockMarketAgentEvidenceForRun(monitorRunId));
    }
    return api.get_market_agent_evidence_for_run({ monitorRunId });
  },
  getMarketAgentStateTransitions: async (start: string, end: string): ApiResult<MarketAgentStateTransitionsResponse> => {
    if (isUiCheckRuntime()) {
      return Promise.resolve(buildMockMarketAgentStateTransitions());
    }
    const api = await withApi();
    if (!api || !hasMethod(api, "get_market_agent_state_transitions")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return Promise.resolve(buildMockMarketAgentStateTransitions());
    }
    return api.get_market_agent_state_transitions({ start, end });
  },
  getMarketAgentSuppressedAlerts: async (start: string, end: string): ApiResult<MarketAgentSuppressedAlertsResponse> => {
    if (isUiCheckRuntime()) {
      return Promise.resolve(buildMockMarketAgentSuppressedAlerts());
    }
    const api = await withApi();
    if (!api || !hasMethod(api, "get_market_agent_suppressed_alerts")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return Promise.resolve(buildMockMarketAgentSuppressedAlerts());
    }
    return api.get_market_agent_suppressed_alerts({ start, end });
  },
  getMarketAgentMonitorStatus: async (): ApiResult<MarketAgentMonitorStatusResponse> => {
    if (isUiCheckRuntime()) {
      return Promise.resolve(mockMarketAgentMonitorStatus);
    }
    const api = await withApi();
    if (!api || !hasMethod(api, "get_market_agent_monitor_status")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return Promise.resolve(mockMarketAgentMonitorStatus);
    }
    return api.get_market_agent_monitor_status({});
  },
  runMarketAgentMonitorOnce: async (): ApiResult<MarketAgentMonitorStatusResponse> => {
    if (isUiCheckRuntime()) {
      mockMarketAgentMonitorStatus = {
        ...mockMarketAgentMonitorStatus,
        ok: true,
        running: false,
        phase: "stopped",
        lastRunAt: Date.now(),
        message: "Monitor run completed."
      };
      return Promise.resolve(mockMarketAgentMonitorStatus);
    }
    const api = await withApi();
    if (!api || !hasMethod(api, "run_market_agent_monitor_once")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return Promise.resolve(mockMarketAgentMonitorStatus);
    }
    return api.run_market_agent_monitor_once({});
  },
  runMarketAgentBackfillRecovery: async (): ApiResult<MarketAgentMonitorStatusResponse> => {
    if (isUiCheckRuntime()) {
      mockMarketAgentMonitorStatus = {
        ...mockMarketAgentMonitorStatus,
        ok: true,
        running: false,
        phase: "recovery_completed",
        lastRunAt: Date.now(),
        lastRecoveryAt: Date.now(),
        message: "Backfill recovery completed."
      } as MarketAgentMonitorStatusResponse;
      return Promise.resolve(mockMarketAgentMonitorStatus);
    }
    const api = await withApi();
    if (!api || !hasMethod(api, "run_market_agent_backfill_recovery")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return Promise.resolve(mockMarketAgentMonitorStatus);
    }
    return api.run_market_agent_backfill_recovery({});
  },
  startMarketAgentMonitorLoop: async (intervalSeconds = 60): ApiResult<MarketAgentMonitorStatusResponse> => {
    if (isUiCheckRuntime()) {
      mockMarketAgentMonitorStatus = {
        ...mockMarketAgentMonitorStatus,
        ok: true,
        running: true,
        phase: "running",
        pid: 4242,
        intervalSeconds,
        nextRunAt: Date.now() + intervalSeconds * 1000,
        lastError: "",
        message: "Monitor loop is running."
      };
      return Promise.resolve(mockMarketAgentMonitorStatus);
    }
    const api = await withApi();
    if (!api || !hasMethod(api, "start_market_agent_monitor_loop")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return Promise.resolve(mockMarketAgentMonitorStatus);
    }
    return api.start_market_agent_monitor_loop({ intervalSeconds });
  },
  stopMarketAgentMonitorLoop: async (): ApiResult<MarketAgentMonitorStatusResponse> => {
    if (isUiCheckRuntime()) {
      mockMarketAgentMonitorStatus = {
        ...mockMarketAgentMonitorStatus,
        ok: true,
        running: false,
        phase: "stopped",
        pid: null,
        nextRunAt: null,
        message: "Monitor loop is stopped."
      };
      return Promise.resolve(mockMarketAgentMonitorStatus);
    }
    const api = await withApi();
    if (!api || !hasMethod(api, "stop_market_agent_monitor_loop")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return Promise.resolve(mockMarketAgentMonitorStatus);
    }
    return api.stop_market_agent_monitor_loop({});
  },
  saveMarketAgentProviderConfig: async (ctrader: MarketAgentProviderConfigInput): ApiResult<MarketAgentProviderConfigResponse> => {
    if (isUiCheckRuntime()) {
      return Promise.resolve(buildMockMarketAgentProviderConfig());
    }
    const api = await withApi();
    if (!api || !hasMethod(api, "save_market_agent_provider_config")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return Promise.resolve(buildMockMarketAgentProviderConfig());
    }
    return api.save_market_agent_provider_config({ ctrader });
  },
  saveMarketAgentLLMConfig: async (llm: MarketAgentLLMConfigInput): ApiResult<MarketAgentLLMConfigResponse> => {
    if (isUiCheckRuntime()) {
      return Promise.resolve(buildMockMarketAgentLLMConfig());
    }
    const api = await withApi();
    if (!api || !hasMethod(api, "save_market_agent_llm_config")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return Promise.resolve(buildMockMarketAgentLLMConfig());
    }
    return api.save_market_agent_llm_config({ llm });
  },
  testMarketAgentLLMConnection: async (llm: MarketAgentLLMConfigInput): ApiResult<MarketAgentLLMActionResponse> => {
    if (isUiCheckRuntime()) {
      return Promise.resolve(buildMockMarketAgentLLMAction({ message: "Local AI is available." }));
    }
    const api = await withApi();
    if (!api || !hasMethod(api, "test_market_agent_llm_connection")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return Promise.resolve(buildMockMarketAgentLLMAction({ message: "Local AI is available." }));
    }
    return api.test_market_agent_llm_connection({ llm });
  },
  testMarketAgentLLMJsonResponse: async (llm: MarketAgentLLMConfigInput): ApiResult<MarketAgentLLMActionResponse> => {
    if (isUiCheckRuntime()) {
      return Promise.resolve(buildMockMarketAgentLLMAction({ message: "Model returned valid JSON." }));
    }
    const api = await withApi();
    if (!api || !hasMethod(api, "test_market_agent_llm_json_response")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return Promise.resolve(buildMockMarketAgentLLMAction({ message: "Model returned valid JSON." }));
    }
    return api.test_market_agent_llm_json_response({ llm });
  },
  detectMarketAgentLocalAI: async (): ApiResult<MarketAgentLLMSetupResponse> => {
    if (isUiCheckRuntime()) {
      return Promise.resolve(buildMockMarketAgentLLMSetup());
    }
    const api = await withApi();
    if (!api || !hasMethod(api, "detect_local_ai_setup")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return Promise.resolve(buildMockMarketAgentLLMSetup());
    }
    return api.detect_local_ai_setup({});
  },
  pullOllamaModel: async (model: string, endpoint?: string): ApiResult<MarketAgentLLMActionResponse> => {
    if (isUiCheckRuntime()) {
      return Promise.resolve(
        buildMockMarketAgentLLMAction({
          status: "download_started",
          model,
          message: "Local AI model download is running in the background.",
          done: false
        })
      );
    }
    const api = await withApi();
    if (!api || !hasMethod(api, "pull_ollama_model")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return Promise.resolve(
        buildMockMarketAgentLLMAction({
          status: "download_started",
          model,
          message: "Local AI model download is running in the background.",
          done: false
        })
      );
    }
    return api.pull_ollama_model({ model, endpoint });
  },
  cancelModelDownload: async (model?: string): ApiResult<MarketAgentLLMActionResponse> => {
    const api = await withApi();
    if (!api || !hasMethod(api, "cancel_model_download")) {
      return Promise.resolve({ ok: true, status: "cancelled", model, message: "Model download cancelled.", done: true });
    }
    return api.cancel_model_download({ model });
  },
  benchmarkMarketAgentLLM: async (llm: MarketAgentLLMConfigInput): ApiResult<MarketAgentLLMActionResponse> => {
    if (isUiCheckRuntime()) {
      return Promise.resolve({ ok: true, status: "model_ready", model: llm.model, elapsedMs: 900, message: "Benchmark passed." });
    }
    const api = await withApi();
    if (!api || !hasMethod(api, "benchmark_llm")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return Promise.resolve({ ok: true, status: "model_ready", model: llm.model, elapsedMs: 900, message: "Benchmark passed." });
    }
    return api.benchmark_llm({ llm });
  },
  applyLLMFallbackPolicy: async (payload: Record<string, unknown>): ApiResult<MarketAgentLLMActionResponse> => {
    const api = await withApi();
    if (!api || !hasMethod(api, "apply_llm_fallback_policy")) {
      return Promise.resolve({ ok: true, status: "fallback_active", ...(payload as Record<string, unknown>) } as MarketAgentLLMActionResponse);
    }
    return api.apply_llm_fallback_policy(payload);
  },
  saveMarketAgentTelegramConfig: async (telegram: MarketAgentTelegramConfigInput): ApiResult<MarketAgentTelegramConfigResponse> => {
    if (isUiCheckRuntime()) {
      return Promise.resolve(buildMockMarketAgentTelegramConfig());
    }
    const api = await withApi();
    if (!api || !hasMethod(api, "save_market_agent_telegram_config")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return Promise.resolve(buildMockMarketAgentTelegramConfig());
    }
    return api.save_market_agent_telegram_config({ telegram });
  },
  testMarketAgentTelegram: async (telegram: MarketAgentTelegramConfigInput): ApiResult<MarketAgentTelegramActionResponse> => {
    if (isUiCheckRuntime()) {
      return Promise.resolve(buildMockMarketAgentTelegramAction());
    }
    const api = await withApi();
    if (!api || !hasMethod(api, "test_market_agent_telegram")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return Promise.resolve(buildMockMarketAgentTelegramAction());
    }
    return api.test_market_agent_telegram({ telegram });
  },
  testCTraderConnection: async (ctrader: MarketAgentProviderConfigInput): ApiResult<MarketAgentProviderActionResponse> => {
    if (isUiCheckRuntime()) {
      return Promise.resolve(
        buildMockMarketAgentProviderAction({
          account: { ctidTraderAccountId: 123456, isLive: false },
          symbol: { symbolId: 777, symbolName: "XAUUSD", digits: 2, pipPosition: 1 }
        })
      );
    }
    const api = await withApi();
    if (!api || !hasMethod(api, "test_ctrader_connection")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return Promise.resolve(buildMockMarketAgentProviderAction());
    }
    return api.test_ctrader_connection({ ctrader });
  },
  resolveCTraderSymbol: async (ctrader: MarketAgentProviderConfigInput): ApiResult<MarketAgentProviderActionResponse> => {
    if (isUiCheckRuntime()) {
      return Promise.resolve(
        buildMockMarketAgentProviderAction({
          symbol: { symbolId: 777, symbolName: "XAUUSD", digits: 2, pipPosition: 1 }
        })
      );
    }
    const api = await withApi();
    if (!api || !hasMethod(api, "resolve_ctrader_symbol")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return Promise.resolve(buildMockMarketAgentProviderAction());
    }
    return api.resolve_ctrader_symbol({ ctrader });
  },
  getCTraderQuoteTest: async (ctrader: MarketAgentProviderConfigInput): ApiResult<MarketAgentProviderActionResponse> => {
    if (isUiCheckRuntime()) {
      return Promise.resolve(
        buildMockMarketAgentProviderAction({
          quote: {
            symbol: "XAUUSD",
            symbol_id: 777,
            bid: 4512.34,
            ask: 4512.72,
            mid: 4512.53,
            timestamp: "2026-05-19T10:15:23+08:00",
            source: "cTrader CLI",
            source_type: "spot",
            environment: "demo"
          },
          provider_health: {
            source: "cTrader",
            source_type: "spot",
            data_mode: "live_seen",
            is_available: true,
            is_stale: false
          }
        })
      );
    }
    const api = await withApi();
    if (!api || !hasMethod(api, "get_ctrader_quote_test")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return Promise.resolve(buildMockMarketAgentProviderAction());
    }
    return api.get_ctrader_quote_test({ ctrader });
  },
  startCTraderConnect: async (ctrader: MarketAgentProviderConfigInput): ApiResult<MarketAgentCTraderAuthResponse> => {
    if (isUiCheckRuntime()) {
      return Promise.resolve({
        ok: true,
        status: "preparing_live_feed",
        message: "cTrader is connected. Preparing live XAUUSD and syncing history in the background.",
        ctrader: buildMockMarketAgentProviderConfig().ctrader ?? null
      });
    }
    const api = await withApi();
    if (!api || !hasMethod(api, "start_ctrader_connect")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return Promise.resolve({ ok: false, status: "credentials_required", message: "Desktop backend unavailable." });
    }
    return api.start_ctrader_connect({ ctrader });
  },
  testCTraderBackfill: async (ctrader: MarketAgentProviderConfigInput): ApiResult<MarketAgentProviderActionResponse> => {
    if (isUiCheckRuntime()) {
      return Promise.resolve(buildMockMarketAgentProviderAction({ message: "M1 trendbar backfill is available." }));
    }
    const api = await withApi();
    if (!api || !hasMethod(api, "test_ctrader_backfill")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return Promise.resolve(buildMockMarketAgentProviderAction({ message: "M1 trendbar backfill is available." }));
    }
    return api.test_ctrader_backfill({ ctrader });
  },
  clearCTraderConfig: async (): ApiResult<MarketAgentProviderConfigResponse> => {
    if (isUiCheckRuntime()) {
      return Promise.resolve(buildMockMarketAgentProviderConfig());
    }
    const api = await withApi();
    if (!api || !hasMethod(api, "clear_ctrader_config")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return Promise.resolve(buildMockMarketAgentProviderConfig());
    }
    return api.clear_ctrader_config({});
  },
  getUpdateState: async () => { 
    const api = await withApi(); 
    if (!api || !hasMethod(api, "get_update_state")) { 
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return Promise.resolve(getMockUpdateState());
    }
    return api.get_update_state();
  },
  checkUpdates: async () => {
    const api = await withApi();
    if (!api || !hasMethod(api, "check_updates")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      const now = new Date();
      const pad = (value: number) => String(value).padStart(2, "0");
      const lastCheckedAt = `${pad(now.getDate())}-${pad(now.getMonth() + 1)}-${now.getFullYear()} ${pad(
        now.getHours()
      )}:${pad(now.getMinutes())}`;
      setMockUpdateState({
        phase: "available",
        message: "Update available: 9.9.9",
        availableVersion: "9.9.9",
        progress: 0,
        lastCheckedAt
      });
      return Promise.resolve({ ok: true });
    }
    return api.check_updates();
  },
  updateNow: async () => {
    const api = await withApi();
    if (!api || !hasMethod(api, "update_now")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      const state = getMockUpdateState();
      if (!state.availableVersion) {
        setMockUpdateState({
          phase: "available",
          message: "Update available: 9.9.9",
          availableVersion: "9.9.9",
          progress: 0
        });
      }
      if (mockUpdateTimers.download) {
        window.clearInterval(mockUpdateTimers.download);
        mockUpdateTimers.download = undefined;
      }
      const startedAt = Date.now();
      setMockUpdateState({
        phase: "downloading",
        message: "Downloading...",
        progress: 0
      });
      mockUpdateTimers.download = window.setInterval(() => {
        const elapsed = Date.now() - startedAt;
        const progress = Math.min(1, elapsed / 1600);
      if (progress >= 1) {
        const timer = mockUpdateTimers.download;
        if (typeof timer === "number") {
          window.clearInterval(timer);
        }
        mockUpdateTimers.download = undefined;
        setMockUpdateState({ phase: "downloaded", message: "Ready to install", progress: 1 });
        return;
      }
      setMockUpdateState({ progress });
    }, 120);
      return Promise.resolve({ ok: true });
    }
    return api.update_now();
  },
  installUpdate: async () => {
    const api = await withApi();
    if (!api || !hasMethod(api, "install_update")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      setMockUpdateState({
        phase: "installing",
        message: "Installing...",
        progress: 1
      });
      window.setTimeout(() => {
        setMockUpdateState({
          phase: "restarting",
          message: "Restarting...",
          progress: 1
        });
      }, 600);
      return Promise.resolve({ ok: true });
    }
    return api.install_update();
  },
  getSettings: async (): ApiResult<Settings> => {
    const api = await withApi();
    if (!api || !hasMethod(api, "get_settings")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return Promise.resolve(mockSettings);
    }
    return api.get_settings();
  },
  saveSettings: async (payload: Settings) => {
    const api = await withApi();
    if (!api || !hasMethod(api, "save_settings")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      mockSettings = { ...mockSettings, ...payload };
      return { ok: true };
    }
    return api.save_settings(payload);
  },
  frontendBootComplete: async () => {
    const api = await withApi();
    if (!api || !hasMethod(api, "frontend_boot_complete")) {
      return Promise.resolve({ ok: true });
    }
    return api.frontend_boot_complete();
  },
  setUiState: async (payload: { visible: boolean; focused: boolean; lastInputAt: number }) => {
    const api = await withApi();
    if (!api || !hasMethod(api, "set_ui_state")) {
      return Promise.resolve({ ok: true });
    }
    return api.set_ui_state(payload);
  },
  openLog: async () => {
    const api = await withApi();
    if (!api || !hasMethod(api, "open_log")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return { ok: true };
    }
    return api.open_log();
  },
  openPath: async (path: string) => {
    const api = await withApi();
    if (!api || !hasMethod(api, "open_path")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return { ok: true };
    }
    return api.open_path(path);
  },
  openUrl: async (url: string) => {
    const api = await withApi();
    if (!api || !hasMethod(api, "open_url")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      try {
        window.open(url, "_blank", "noreferrer");
      } catch {
        // ignore
      }
      return { ok: true };
    }
    return api.open_url(url);
  },
  openReleaseNotes: async () => {
    const api = await withApi();
    if (!api || !hasMethod(api, "open_release_notes")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return { ok: false, message: "Release notes not available" };
    }
    return api.open_release_notes();
  },
  addLog: async (payload: { message: string; level?: string }) => {
    const api = await withApi();
    if (!api || !hasMethod(api, "add_log")) {
      if (isWebview() && !isUiCheckRuntime()) {
        return { ok: false };
      }
      return { ok: true };
    }
    return api.add_log(payload);
  },
  browseTemporaryPath: async () => {
    const api = await withApi();
    if (!api || !hasMethod(api, "browse_temporary_path")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return { ok: true, path: "" };
    }
    return api.browse_temporary_path();
  },
  setTemporaryPathPath: async (path: string) => {
    const api = await withApi();
    if (!api || !hasMethod(api, "set_temporary_path")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return { ok: true };
    }
    return api.set_temporary_path(path);
  },
  getTemporaryPathTask: async () => {
    const api = await withApi();
    if (!api || !hasMethod(api, "get_temporary_path_task")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return { ok: true, active: false, phase: "idle", progress: 0, message: "", path: "" };
    }
    return api.get_temporary_path_task();
  },
  probeTemporaryPath: async (payload: { enableTemporaryPath: boolean; temporaryPath: string; autoStart?: boolean }) => {
    const api = await withApi();
    if (!api || !hasMethod(api, "probe_temporary_path")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      const uiCheck = (
        window as unknown as {
          __ui_check__?: {
            mockProbeTemporaryPath?:
              | Record<string, unknown>
              | ((payload: { enableTemporaryPath: boolean; temporaryPath: string; autoStart?: boolean }) => unknown);
          };
        }
      ).__ui_check__;
      if (uiCheck?.mockProbeTemporaryPath) {
        const mocked =
          typeof uiCheck.mockProbeTemporaryPath === "function"
            ? uiCheck.mockProbeTemporaryPath(payload)
            : uiCheck.mockProbeTemporaryPath;
        return {
          ok: true,
          status: "mock",
          ready: true,
          needsConfirmation: false,
          canUseAsIs: false,
          canReset: false,
          path: payload.temporaryPath || "",
          message: "",
          ...(mocked as Record<string, unknown>)
        };
      }
      return {
        ok: true,
        status: "mock",
        ready: true,
        needsConfirmation: false,
        canUseAsIs: false,
        canReset: false,
        path: payload.temporaryPath || "",
        message: ""
      };
    }
    return api.probe_temporary_path(payload);
  },
  temporaryPathUseAsIs: async (temporaryPath: string) => {
    const api = await withApi();
    if (!api || !hasMethod(api, "temporary_path_use_as_is")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return { ok: true };
    }
    return api.temporary_path_use_as_is({ temporaryPath });
  },
  temporaryPathReset: async (temporaryPath: string) => {
    const api = await withApi();
    if (!api || !hasMethod(api, "temporary_path_reset")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return { ok: true };
    }
    return api.temporary_path_reset({ temporaryPath });
  },
  pullNow: async () => {
    const api = await withApi();
    if (!api || !hasMethod(api, "pull_now")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      const baseline = getMockSnapshot();
      const startedAt = formatLocalDateTime(new Date());
      setMockSnapshot({
        ...baseline,
        pullActive: true,
        logs: [{ time: startedAt, message: "Manual pull started", level: "INFO" }, ...baseline.logs]
      });
      window.setTimeout(() => {
        const current = getMockSnapshot();
        const finishedAt = formatLocalDateTime(new Date());
        setMockSnapshot({
          ...current,
          pullActive: false,
          lastPullAt: new Date().toISOString(),
          lastPull: finishedAt,
          logs: [
            { time: finishedAt, message: "Data update completed", level: "INFO" },
            ...current.logs
          ]
        });
      }, 700);
      return { ok: true };
    }
    return api.pull_now();
  },
  syncNow: async () => {
    const api = await withApi();
    if (!api || !hasMethod(api, "sync_now")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      const baseline = getMockSnapshot();
      const startedAt = formatLocalDateTime(new Date());
      setMockSnapshot({
        ...baseline,
        syncActive: true,
        logs: [{ time: startedAt, message: "Manual sync started", level: "INFO" }, ...baseline.logs]
      });
      window.setTimeout(() => {
        const current = getMockSnapshot();
        const finishedAt = formatLocalDateTime(new Date());
        const outputDir = String(current.outputDir || "").trim();
        if (!outputDir) {
          setMockSnapshot({
            ...current,
            syncActive: false,
            logs: [{ time: finishedAt, message: "Sync skipped (no output dir)", level: "WARN" }, ...current.logs]
          });
          return;
        }
        const lastSyncAt = new Date().toISOString();
        setMockOutputLastSync(outputDir, { lastSyncAt, lastSync: finishedAt });
        setMockSnapshot({
          ...current,
          syncActive: false,
          lastSyncAt,
          lastSync: finishedAt,
          logs: [{ time: finishedAt, message: "Sync completed", level: "INFO" }, ...current.logs]
        });
      }, 700);
      return { ok: true };
    }
    return api.sync_now();
  },
  browseOutputDir: async () => {
    const api = await withApi();
    if (!api || !hasMethod(api, "browse_output_dir")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return { ok: true, path: getMockSnapshot().outputDir };
    }
    return api.browse_output_dir();
  },
  setOutputDir: async (path: string) => {
    const api = await withApi();
    if (!api || !hasMethod(api, "set_output_dir")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      const value = String(path || "");
      const baseline = getMockSnapshot();
      const sync = value ? getMockOutputLastSync(value) : { lastSyncAt: "", lastSync: "Not yet" };
      setMockSnapshot({ ...baseline, outputDir: value, lastSyncAt: sync.lastSyncAt, lastSync: sync.lastSync });
      return { ok: true };
    }
    return api.set_output_dir(path);
  },
  setCurrency: async (value: string) => {
    const api = await withApi();
    if (!api || !hasMethod(api, "set_currency")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return { ok: true };
    }
    return api.set_currency(value);
  },
  clearLogs: async () => {
    const api = await withApi();
    if (!api || !hasMethod(api, "clear_logs")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return { ok: true };
    }
    return api.clear_logs();
  },
  dismissModal: async (id: string) => {
    const api = await withApi();
    if (!api || !hasMethod(api, "dismiss_modal")) {
      return { ok: true };
    }
    return api.dismiss_modal({ id });
  }
};
