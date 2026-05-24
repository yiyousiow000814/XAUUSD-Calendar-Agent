import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MarketAgentPage } from "../components/MarketAgentPage";
import type {
  MarketAgentDriverAttentionResponse,
  MarketAgentEvidenceForRunResponse,
  MarketAgentProviderConfigResponse,
  MarketAgentProviderHealthResponse,
  MarketAgentReplayResponse,
  MarketAgentSnapshotResponse,
  MarketAgentLLMConfigResponse,
  MarketAgentLLMActionResponse,
  MarketAgentLLMSetupResponse,
  MarketAgentOllamaPullProgress,
  MarketAgentTelegramConfigResponse
} from "../types";

const freshProviderTimestamp = () => new Date(Date.now() - 30_000).toISOString();

const snapshot: MarketAgentSnapshotResponse = {
  ok: true,
  available: true,
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
    invalidation_conditions: []
  },
  alerts: []
};

const providerHealth: MarketAgentProviderHealthResponse = {
  ok: true,
  available: true,
  monitor_run_id: 23,
  items: [
    {
      provider_key: "xauusd",
      source: "cTrader",
      source_type: "spot",
      data_mode: "live_seen",
      is_available: true,
      is_stale: false,
      data_timestamp: freshProviderTimestamp(),
      fetched_at: freshProviderTimestamp()
    },
    {
      provider_key: "us2y",
      source: "US2Y",
      source_type: "unavailable",
      data_mode: "unavailable",
      is_available: false,
      is_stale: false,
      stale_reason: "No reliable free 2Y source configured."
    }
  ]
};

const localCsvProviderHealth: MarketAgentProviderHealthResponse = {
  ok: true,
  available: true,
  monitor_run_id: 24,
  items: [
    {
      provider_key: "xauusd",
      source: "Local CSV",
      source_type: "LOCAL_CSV_FALLBACK",
      data_mode: "LOCAL_CSV_FALLBACK",
      is_available: true,
      is_stale: false,
      data_timestamp: "2026-05-19T08:00:00+08:00",
      fetched_at: "2026-05-19T08:05:00+08:00"
    }
  ]
};

const providerConfig: MarketAgentProviderConfigResponse = {
  ok: true,
  available: true,
  ctrader: {
    enabled: false,
    environment: "demo",
    symbol: "XAUUSD",
    symbolId: null,
    accountId: "",
    ctidMasked: "tr******er",
    passwordMasked: "************",
    hasPassword: true,
    snapshotPath: "user-data/ctrader-last-quote.json",
    quoteTimeoutSeconds: 8,
    quoteStaleAfterSeconds: 15,
    allowSavedSnapshotFallback: true,
    configPath: "user-data/ctrader-cli.json"
  }
};

const telegramConfig: MarketAgentTelegramConfigResponse = {
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
};

const llmConfig: MarketAgentLLMConfigResponse = {
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
};

const localAiSetup: MarketAgentLLMSetupResponse = {
  ok: true,
  available: true,
  status: "model_missing",
  message: "Recommended model is missing.",
  system: {
    os: "windows",
    arch: "x86_64",
    cpu: "AMD Ryzen 7",
    logicalCpuCount: 16,
    ramBytes: 34359738368,
    gpuVendor: "NVIDIA",
    gpuName: "NVIDIA GeForce RTX 3060 Ti",
    vramBytes: 8589934592,
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
    approximateSizeBytes: 2900000000,
    diskLabel: "~2.9 GB",
    reason: "RTX 3060 Ti with 8GB VRAM can use the balanced model for fast JSON."
  },
  fallbackChain: ["qwen3.5:4b", "qwen3.5:2b", "qwen3.5:0.8b", "rule-based-only"],
  ruleBasedActive: true
};

const driverAttention: MarketAgentDriverAttentionResponse = {
  ok: true,
  available: true,
  monitor_run_id: 23,
  states: [
    {
      driver_id: "yields",
      label: "US10Y (Yield)",
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
      driver_id: "usd",
      label: "DXY (USD Index)",
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
      driver_id: "us2y",
      label: "US2Y (Yield)",
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
      current_state: "watching",
      priority: "conditional_macro",
      relevance_score: 0.58,
      impact_percent: 0.45,
      confidence: "medium",
      activation_reason: "Oil is moving, but the inflation channel is incomplete.",
      deactivation_reason: "Oil stayed background only.",
      last_confirmed_at: "",
      decay_deadline: "",
      data_mode: "live_seen"
    },
    {
      driver_id: "geopolitics",
      label: "Geopolitics / News",
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
    },
    {
      driver_id: "vix_equities",
      label: "VIX (Volatility)",
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
    }
  ]
};

const replay: MarketAgentReplayResponse = {
  ok: true,
  available: true,
  replay: {
    price_series: [
      {
        symbol: "XAUUSD",
        data_timestamp: "2026-05-19T07:45:00+08:00",
        close_price: 4520.2,
        bid_price: 4519.92,
        ask_price: 4520.48,
        source_type: "spot",
        data_mode: "live_seen"
      },
      {
        symbol: "XAUUSD",
        data_timestamp: "2026-05-19T08:00:00+08:00",
        close_price: 4504.8,
        bid_price: 4504.52,
        ask_price: 4505.08,
        source_type: "spot",
        data_mode: "live_seen"
      }
    ],
    related_assets: {
      dxy: [{ symbol: "dxy", data_timestamp: "2026-05-19T08:00:00+08:00", change_15m: 0.22, source_type: "proxy", data_mode: "live_seen" }],
      us10y: [{ symbol: "us10y", data_timestamp: "2026-05-19T08:00:00+08:00", change_15m: 5.1, source_type: "proxy", data_mode: "live_seen" }],
      us2y: [],
      wti: [],
      brent: [],
      vix: [],
      spx: [],
      nasdaq: []
    },
    news_items: [{ title: "Fed headline", published_at: "2026-05-19T08:03:00+08:00", source: "Reuters", data_mode: "backfilled", semantic_type: "news", impact_percent: -0.21 }],
    calendar_events: [{ title: "US session opens", scheduled_at: "2026-05-19T08:15:00+08:00", source: "ForexFactory", data_mode: "live_seen", semantic_type: "session", impact_percent: -0.08 }],
    driver_attention_timeline: [],
    timeline_events: [
      { monitor_run_id: 23, event_time: "2026-05-19T08:05:00+08:00", event_type: "market_alert", label: "Yields pressure", payload: { semantic_type: "breakout", impact_percent: -0.48, main_driver: "yields" } },
      { monitor_run_id: 22, event_time: "2026-05-19T07:58:00+08:00", event_type: "analysis", label: "Reversal attempt rejected", payload: { semantic_type: "reversal", impact_percent: 0.24, main_driver: "technical_liquidation" } },
      { monitor_run_id: 21, event_time: "2026-05-19T07:56:00+08:00", event_type: "analysis", label: "Range held near session low", payload: { semantic_type: "range", impact_percent: 0.05, main_driver: "unknown" } }
    ],
    state_transitions: [{ monitor_run_id: 23, run_started_at: "2026-05-19T08:05:00+08:00", state_change_reason: "main_driver usd -> yields" }],
    alerts: [{ monitor_run_id: 23, run_started_at: "2026-05-19T08:05:00+08:00", should_notify: true, notification_level: "level_3", message: "XAUUSD dropped 0.48%", main_driver: "yields", semantic_type: "breakout", impact_percent: -0.48 }],
    suppressed_alerts: [{ monitor_run_id: 24, run_started_at: "2026-05-19T07:20:00+08:00", should_notify: false, notification_level: "level_1", message: "Suppressed duplicate" }]
  }
};

const evidence: MarketAgentEvidenceForRunResponse = {
  ok: true,
  available: true,
  monitor_run_id: 23,
  payload: {
    evidence_packet: {
      allowed_candidate_drivers: ["yields", "usd"],
      blocked_drivers: { fed_rates: "No direct headline" },
      evidence_status: { dxy: "confirming", us10y: "confirming", us2y: "unavailable" },
      evidence_chain_status: {
        status: "ready",
        can_show_current_conclusion: true,
        reason: "Live XAUUSD price and recent history are available.",
        missing_required: [],
        usable_inputs: ["live_xauusd_spot", "xauusd_recent_history", "news_context"],
        context_only_inputs: ["llm_unavailable"]
      }
    },
    analysis_result: {
      main_driver: "yields",
      cause_status: "likely",
      rejected_driver: "fed_rates",
      rejection_reason: "blocked driver"
    },
    monitor_run: {
      run_started_at: "2026-05-19T08:05:00+08:00",
      data_mode: "backfilled"
    }
  }
};

const monitorStatus = {
  ok: true,
  available: true,
  running: false,
  phase: "stopped",
  pid: null,
  intervalSeconds: 60,
  lastRunAt: null,
  nextRunAt: null,
  lastError: "",
  message: "Monitor loop is stopped."
};

const marketAgentPageElement = (overrides: Partial<Parameters<typeof MarketAgentPage>[0]> = {}) => (
  <MarketAgentPage
      snapshot={snapshot}
      providerConfig={providerConfig}
      telegramConfig={telegramConfig}
      llmConfig={llmConfig}
      providerHealth={providerHealth}
      driverAttention={driverAttention}
      replay={replay}
      selectedEvidence={evidence}
      monitorStatus={monitorStatus}
      selectedMonitorRunId={23}
      rangePreset="day"
      rangeStartInput="2026-05-19T04:00"
      rangeEndInput="2026-05-19T08:30"
      onPresetChange={() => {}}
      onRangeStartChange={() => {}}
      onRangeEndChange={() => {}}
      onApplyRange={() => {}}
      onSelectRun={() => {}}
      onSaveProviderConfig={() => {}}
      onClearProviderConfig={() => {}}
      onTestCTraderConnection={async () => ({ ok: true })}
      onResolveCTraderSymbol={async () => ({ ok: true })}
      onGetCTraderQuoteTest={async () => ({ ok: true })}
      onSaveTelegramConfig={async () => telegramConfig}
      onTestTelegramMessage={async () => ({ ok: true, status: "sent", message: "Telegram test message sent." })}
      onSaveLLMConfig={async () => llmConfig}
      onTestLLMConnection={async () => ({ ok: true, status: "available", message: "Local AI is available." })}
      onTestLLMJsonResponse={async () => ({ ok: true, status: "available", message: "Model returned valid JSON." })}
      localAiSetup={localAiSetup}
      localAiPullProgress={null}
      onDetectLocalAI={async () => localAiSetup}
      onInstallRecommendedModel={async () => ({ ok: true, status: "model_ready", message: "Model ready." })}
      onCancelModelDownload={async () => ({ ok: true, status: "cancelled" })}
      onBenchmarkLLM={async () => ({ ok: true, status: "model_ready", elapsedMs: 900, message: "Benchmark passed." })}
      onApplyLLMFallbackPolicy={async () => ({ ok: true, status: "model_ready", model: "qwen3.5:4b" })}
      onStartCTraderConnect={async () => ({ ok: true, status: "preparing_live_feed", message: "cTrader is connected. Preparing live XAUUSD and syncing history in the background.", ctrader: providerConfig.ctrader })}
      onTestCTraderBackfill={async () => ({ ok: true, message: "M1 backfill is available." })}
      onRunMonitorOnce={async () => monitorStatus}
      onRunBackfillRecovery={async () => ({ ...monitorStatus, phase: "recovery_completed", message: "Backfill recovery completed." })}
      onStartMonitorLoop={async () => ({ ...monitorStatus, running: true, phase: "running" })}
      onStopMonitorLoop={async () => monitorStatus}
      {...overrides}
    />
);

const renderMarketAgentPage = (overrides: Partial<Parameters<typeof MarketAgentPage>[0]> = {}) =>
  render(marketAgentPageElement(overrides));

describe("MarketAgentPage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("renders a one-screen cockpit dashboard by default", () => {
    const { container } = render(
      <MarketAgentPage
        snapshot={snapshot}
        providerConfig={providerConfig}
        telegramConfig={telegramConfig}
        llmConfig={llmConfig}
        providerHealth={providerHealth}
        driverAttention={driverAttention}
        replay={replay}
        selectedEvidence={evidence}
        monitorStatus={monitorStatus}
        selectedMonitorRunId={23}
        rangePreset="day"
        rangeStartInput="2026-05-19T04:00"
        rangeEndInput="2026-05-19T08:30"
        onPresetChange={() => {}}
        onRangeStartChange={() => {}}
        onRangeEndChange={() => {}}
        onApplyRange={() => {}}
        onSelectRun={() => {}}
        onSaveProviderConfig={() => {}}
        onClearProviderConfig={() => {}}
        onTestCTraderConnection={async () => ({ ok: true })}
        onResolveCTraderSymbol={async () => ({ ok: true })}
        onGetCTraderQuoteTest={async () => ({ ok: true })}
        onSaveTelegramConfig={async () => telegramConfig}
        onTestTelegramMessage={async () => ({ ok: true, status: "sent", message: "Telegram test message sent." })}
        onSaveLLMConfig={async () => llmConfig}
        onTestLLMConnection={async () => ({ ok: true, status: "available", message: "Local AI is available." })}
        onTestLLMJsonResponse={async () => ({ ok: true, status: "available", message: "Model returned valid JSON." })}
        localAiSetup={localAiSetup}
        localAiPullProgress={null}
        onDetectLocalAI={async () => localAiSetup}
        onInstallRecommendedModel={async () => ({ ok: true, status: "model_ready", message: "Model ready." })}
        onCancelModelDownload={async () => ({ ok: true, status: "cancelled" })}
        onBenchmarkLLM={async () => ({ ok: true, status: "model_ready", elapsedMs: 900, message: "Benchmark passed." })}
        onApplyLLMFallbackPolicy={async () => ({ ok: true, status: "model_ready", model: "qwen3.5:4b" })}
        onStartCTraderConnect={async () => ({ ok: true, status: "preparing_live_feed", message: "cTrader is connected. Preparing live XAUUSD and syncing history in the background.", ctrader: providerConfig.ctrader })}
        onTestCTraderBackfill={async () => ({ ok: true, message: "M1 backfill is available." })}
        onRunMonitorOnce={async () => monitorStatus}
        onRunBackfillRecovery={async () => ({ ...monitorStatus, phase: "recovery_completed", message: "Backfill recovery completed." })}
        onStartMonitorLoop={async () => ({ ...monitorStatus, running: true, phase: "running" })}
        onStopMonitorLoop={async () => monitorStatus}
      />
    );

    const marketAgentNav = screen.getByRole("navigation", { name: /Market Agent sections/i });
    expect(marketAgentNav).toBeInTheDocument();
    const navIconNames = Array.from(marketAgentNav.querySelectorAll("svg")).map((icon) => icon.getAttribute("data-nav-icon"));
    expect(navIconNames).toEqual(["dashboard", "drivers", "replay", "evidence", "providers", "activity", "sources", "alerts"]);
    expect(new Set(navIconNames).size).toBe(navIconNames.length);
    expect(screen.queryByRole("button", { name: /^Control$/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Dashboard/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("heading", { name: /XAUUSD \(Spot\)/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Market State/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Latest Move/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Evidence Status/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Next Update/i })).toBeInTheDocument();
    const marketStateCard = screen.getByRole("heading", { name: /Market State/i }).closest("article");
    expect(within(marketStateCard as HTMLElement).getByText(/TRENDING DOWN/i)).toBeInTheDocument();
    expect(within(marketStateCard as HTMLElement).queryByText(/^Bearish$/i)).not.toBeInTheDocument();
    const stateSince = marketStateCard?.querySelector("[data-kpi-detail='state-since']");
    expect(stateSince?.textContent).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
    const latestMoveCard = screen.getByRole("heading", { name: /Latest Move/i }).closest("article");
    const detected = latestMoveCard?.querySelector("[data-kpi-detail='move-detected']");
    expect(detected?.textContent).toMatch(/^\d{2}:\d{2}$/);
    expect(detected?.textContent).not.toMatch(/\d{2}[-/]\d{2}|\d{4}/);
    expect(screen.queryByText("Bid")).not.toBeInTheDocument();
    expect(screen.queryByText("Ask")).not.toBeInTheDocument();
    expect(screen.queryByText("Spread")).not.toBeInTheDocument();
    expect(screen.getByText("Data:")).toBeInTheDocument();
    expect(screen.getByText("Strength")).toBeInTheDocument();
    expect(screen.getByLabelText(/^60 sec$/i)).toBeInTheDocument();
    expect(screen.getByText(/Every 60 seconds/i)).toBeInTheDocument();
    expect(screen.queryByText(/\b1m\b/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Every 1 min/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Last check/i)).not.toBeInTheDocument();
    const nextCountdown = container.querySelector("[data-qa='qa:market-agent:next-countdown']");
    expect(nextCountdown).toHaveAttribute("aria-label", "60 sec");
    expect(nextCountdown?.querySelectorAll(".market-agent-countdown-digit")).toHaveLength(2);
    expect(nextCountdown?.querySelector(".market-agent-countdown-unit")?.textContent).toBe("sec");
    expect(nextCountdown?.querySelector(".market-agent-value-pulse")).not.toBeInTheDocument();
    expect(container.querySelectorAll(".market-agent-value-pulse").length).toBeGreaterThanOrEqual(8);
    expect(container.querySelector(".market-agent-score-ring")).toBeInTheDocument();
    expect(container.querySelector(".market-agent-score-ring.market-agent-score-ring-animated")).not.toBeInTheDocument();
    expect(container.querySelector(".market-agent-score-ring svg.market-agent-score-svg")).toBeInTheDocument();
    expect(container.querySelector(".market-agent-score-progress")).toBeInTheDocument();
    expect(container.querySelector(".market-agent-clock-icon.market-agent-clock-icon-animated")).toBeInTheDocument();
    expect(container.querySelectorAll(".market-agent-animated-row").length).toBeGreaterThanOrEqual(6);
    expect(screen.getByRole("heading", { name: /Driver Attention \(Current\)/i })).toBeInTheDocument();
    const driverPanel = screen.getByRole("heading", { name: /Driver Attention \(Current\)/i }).closest("section");
    expect(driverPanel?.querySelectorAll(".market-agent-attention-table-row")).toHaveLength(8);
    expect(driverPanel?.querySelector(".market-agent-attention-footer")).not.toBeInTheDocument();
    expect(within(driverPanel as HTMLElement).getAllByText("ACTIVE")).toHaveLength(2);
    expect(within(driverPanel as HTMLElement).getByText("-0.65%")).toBeInTheDocument();
    expect(within(driverPanel as HTMLElement).queryByText("+92.00%")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Market Replay \(Day\)/i })).toBeInTheDocument();
    expect(Array.from(container.querySelectorAll(".market-agent-timeline-node")).every((node) => node.textContent === "")).toBe(true);
    expect(screen.getByRole("heading", { name: /Latest Evidence/i })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Provider Health$/i }).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /View Full Timeline/i })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^View All$/i }).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/BREAKOUT/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/NEWS/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/REVERSAL/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/RANGE/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/SESSION/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Impact:/i).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /^Data Sources$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Activity$/i })).toBeInTheDocument();
    expect(screen.queryByText(/Quick Actions/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Configure Data Sources/i })).not.toBeInTheDocument();

    expect(screen.queryByRole("heading", { name: /^Data Sources$/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Access Token/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Raw details/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Price series/i)).not.toBeInTheDocument();
    expect(screen.queryByText("futures_proxy")).not.toBeInTheDocument();
    expect(screen.queryByText("core_structural")).not.toBeInTheDocument();
    expect(screen.queryByText(/No reliable free US2Y source is configured\./i)).not.toBeInTheDocument();
  });

  it("labels empty evidence support as contrary instead of market confidence", () => {
    const zeroSupportEvidence: MarketAgentEvidenceForRunResponse = {
      ...evidence,
      payload: {
        ...evidence.payload,
        evidence_packet: {
          ...evidence.payload.evidence_packet,
          evidence_status: { dxy: "neutral", us10y: "neutral", us2y: "unavailable" }
        },
        analysis_result: {
          ...evidence.payload.analysis_result,
          cause_status: "contrary"
        }
      }
    };
    const zeroSupportReplay: MarketAgentReplayResponse = {
      ...replay,
      replay: {
        ...replay.replay,
        news_items: replay.replay.news_items.map((item) => ({ ...item, data_mode: "neutral" })),
        calendar_events: replay.replay.calendar_events.map((item) => ({ ...item, data_mode: "neutral" }))
      }
    };
    const { container } = renderMarketAgentPage({
      replay: zeroSupportReplay,
      selectedEvidence: zeroSupportEvidence
    });

    const scoreRing = container.querySelector(".market-agent-score-ring");
    expect(within(scoreRing as HTMLElement).getByText("0")).toBeInTheDocument();
    expect(within(scoreRing as HTMLElement).queryByText("Strong")).not.toBeInTheDocument();
    expect(within(scoreRing as HTMLElement).getByText("Contrary")).toBeInTheDocument();
    expect(container.querySelector(".market-agent-score-progress.is-empty")).toBeInTheDocument();
    expect(container.querySelector(".market-agent-evidence-footer")?.textContent).toContain("Contrary (0%)");
  });

  it("uses a full ring state when every evidence item supports the move", () => {
    const fullSupportEvidence: MarketAgentEvidenceForRunResponse = {
      ...evidence,
      payload: {
        ...evidence.payload,
        evidence_packet: {
          ...evidence.payload.evidence_packet,
          evidence_status: { dxy: "confirming", us10y: "confirming" }
        },
        analysis_result: {
          ...evidence.payload.analysis_result,
          cause_status: "supporting"
        }
      }
    };
    const { container } = renderMarketAgentPage({ selectedEvidence: fullSupportEvidence });

    const scoreRing = container.querySelector(".market-agent-score-ring");
    const progress = container.querySelector(".market-agent-score-progress");
    expect(within(scoreRing as HTMLElement).getByText("100")).toBeInTheDocument();
    expect(within(scoreRing as HTMLElement).getByText("Strong")).toBeInTheDocument();
    expect(progress).toHaveClass("is-full");
    expect(progress).not.toHaveAttribute("stroke-dashoffset");
    expect(progress).not.toHaveAttribute("stroke-dasharray");
  });

  it("draws partial evidence score arcs against the real circle circumference", () => {
    const { container } = renderMarketAgentPage();

    const scoreRing = container.querySelector(".market-agent-score-ring");
    const progress = container.querySelector(".market-agent-score-progress");
    expect(scoreRing).toHaveAttribute("data-score-target", "100");
    expect(progress).not.toHaveAttribute("stroke-dashoffset");
    expect(progress).not.toHaveAttribute("stroke-dasharray");
    expect(progress).not.toHaveAttribute("pathLength");
  });

  it("renders the evidence score ring and percent as static values", () => {
    const zeroSupportEvidence: MarketAgentEvidenceForRunResponse = {
      ...evidence,
      payload: {
        ...evidence.payload,
        evidence_packet: {
          ...evidence.payload.evidence_packet,
          evidence_status: { dxy: "neutral", us10y: "neutral", us2y: "unavailable" }
        },
        analysis_result: {
          ...evidence.payload.analysis_result,
          cause_status: "contrary"
        }
      }
    };
    const zeroSupportReplay: MarketAgentReplayResponse = {
      ...replay,
      replay: {
        ...replay.replay,
        news_items: replay.replay.news_items.map((item) => ({ ...item, data_mode: "neutral" })),
        calendar_events: replay.replay.calendar_events.map((item) => ({ ...item, data_mode: "neutral" }))
      }
    };
    const fullSupportEvidence: MarketAgentEvidenceForRunResponse = {
      ...evidence,
      payload: {
        ...evidence.payload,
        evidence_packet: {
          ...evidence.payload.evidence_packet,
          evidence_status: { dxy: "confirming", us10y: "confirming" }
        },
        analysis_result: {
          ...evidence.payload.analysis_result,
          cause_status: "supporting"
        }
      }
    };

    const { container, rerender } = renderMarketAgentPage({
      replay: zeroSupportReplay,
      selectedEvidence: zeroSupportEvidence
    });

    const initialRing = container.querySelector(".market-agent-score-ring");
    expect(initialRing).toHaveAttribute("data-score-target", "0");
    expect(initialRing).not.toHaveClass("market-agent-score-ring-animated");
    expect(initialRing?.querySelector(".market-agent-score-number")).not.toHaveClass("market-agent-score-number-rolling");
    expect(initialRing?.querySelector(".market-agent-score-digit")).not.toBeInTheDocument();
    expect(initialRing?.querySelector(".market-agent-score-suffix")).toHaveTextContent("%");

    rerender(marketAgentPageElement({ selectedEvidence: fullSupportEvidence }));

    const updatedRing = container.querySelector(".market-agent-score-ring");
    expect(updatedRing).toBe(initialRing);
    expect(updatedRing).toHaveAttribute("data-score-target", "100");
    expect(updatedRing?.querySelector(".market-agent-score-number")).toHaveTextContent("100");
    expect(updatedRing?.querySelector(".market-agent-score-number")).not.toHaveClass("is-changing", "roll-up", "roll-down");
    expect(updatedRing?.querySelector(".market-agent-score-progress")).not.toHaveAttribute("style");
  });

  it("shows latest move duration from the detected alert time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-19T00:45:23Z"));
    let unmount: (() => void) | undefined;

    try {
      ({ unmount } = render(
        <MarketAgentPage
          snapshot={snapshot}
          providerConfig={providerConfig}
          telegramConfig={telegramConfig}
          llmConfig={llmConfig}
          providerHealth={providerHealth}
          driverAttention={driverAttention}
          replay={replay}
          selectedEvidence={evidence}
          monitorStatus={monitorStatus}
          selectedMonitorRunId={23}
          rangePreset="day"
          rangeStartInput="2026-05-19T04:00"
          rangeEndInput="2026-05-19T08:30"
          onPresetChange={() => {}}
          onRangeStartChange={() => {}}
          onRangeEndChange={() => {}}
          onApplyRange={() => {}}
          onSelectRun={() => {}}
          onRefresh={async () => {}}
          onSaveProviderConfig={async () => providerConfig}
          onTestProviderConnection={async () => providerAction}
          onResolveProviderSymbol={async () => providerAction}
          onGetProviderQuote={async () => providerAction}
          onRefreshProviderToken={async () => providerAction}
          onSaveTelegramConfig={async () => telegramConfig}
          onTestTelegram={async () => telegramAction}
          onSaveLLMConfig={async () => llmConfig}
          onTestLLM={async () => llmAction}
          onStartMonitorLoop={async () => monitorStatus}
          onStopMonitorLoop={async () => monitorStatus}
        />
      ));

      const latestMoveCard = screen.getByRole("heading", { name: /Latest Move/i }).closest("article");
      const duration = latestMoveCard?.querySelector("[data-kpi-detail='move-duration']");
      expect(duration?.textContent).toBe("45m 23s");
    } finally {
      unmount?.();
      vi.useRealTimers();
    }
  });

  it("keeps Market Agent usable when replay payloads are missing price series fields", () => {
    const replayWithoutPriceSeries = {
      ok: true,
      available: true,
      replay: {
        related_assets: {},
        news_items: [],
        calendar_events: [],
        driver_attention_timeline: [],
        timeline_events: [],
        state_transitions: [],
        alerts: [],
        suppressed_alerts: []
      }
    } as unknown as MarketAgentReplayResponse;

    renderMarketAgentPage({ replay: replayWithoutPriceSeries });

    expect(screen.getByRole("heading", { name: /XAUUSD \(Spot\)/i })).toBeInTheDocument();
    expect(screen.getByText(/No price/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Replay \/ Timeline/i }));
    expect(screen.getByRole("heading", { name: /^Market Replay$/i })).toBeInTheDocument();
    expect(screen.queryByText(/Open full replay/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Price series/i)).not.toBeInTheDocument();
  });

  it("does not treat an expired cTrader spot payload as live current evidence", () => {
    const staleSpotHealth: MarketAgentProviderHealthResponse = {
      ...providerHealth,
      items: providerHealth.items.map((item) =>
        item.provider_key === "xauusd"
          ? {
              ...item,
              source_type: "spot",
              data_mode: "live_seen",
              is_available: true,
              is_stale: false,
              current_value: 4479,
              data_timestamp: "2026-05-19T07:15:00+08:00",
              fetched_at: "2026-05-23T17:20:47+08:00"
            }
          : item
      )
    };

    renderMarketAgentPage({ providerHealth: staleSpotHealth });

    expect(screen.getAllByText(/Market closed/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Current driver ranking paused/i)).toBeInTheDocument();
    expect(screen.queryByText(/cTrader \(Spot\)/i)).not.toBeInTheDocument();
    expect(screen.getByText(/4,479\.00/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Evidence$/i }));
    expect(screen.getByText(/Collected Context/i)).toBeInTheDocument();
    expect(screen.queryByText(/Xauusd: Live Data/i)).not.toBeInTheDocument();
  });

  it("hides fixed zero-score dormant drivers from the current driver table", () => {
    const dormantOnlyAttention: MarketAgentDriverAttentionResponse = {
      ...driverAttention,
      states: [
        {
          driver_id: "oil_inflation",
          label: "Oil / inflation",
          current_state: "dormant",
          priority: "conditional_macro",
          relevance_score: 0,
          impact_percent: null,
          confidence: "low",
          activation_reason: "",
          deactivation_reason: "Oil stayed background only.",
          current_evidence_summary: "Oil is not confirming this move.",
          last_confirmed_at: "",
          decay_deadline: "",
          data_mode: "live_seen"
        },
        {
          driver_id: "geopolitics",
          label: "Geopolitics",
          current_state: "dormant",
          priority: "temporary_event",
          relevance_score: 0,
          impact_percent: null,
          confidence: "low",
          activation_reason: "",
          deactivation_reason: "No current headline confirmation.",
          current_evidence_summary: "",
          last_confirmed_at: "",
          decay_deadline: "",
          data_mode: "live_seen"
        }
      ]
    };

    renderMarketAgentPage({ driverAttention: dormantOnlyAttention });

    const driverPanel = screen.getByRole("heading", { name: /Driver Attention \(Current\)/i }).closest("section");
    expect(driverPanel?.querySelectorAll(".market-agent-attention-table-row")).toHaveLength(0);
    expect(within(driverPanel as HTMLElement).getByText(/No active or watching drivers/i)).toBeInTheDocument();
    expect(within(driverPanel as HTMLElement).queryByText(/Oil \/ inflation/i)).not.toBeInTheDocument();
    expect(within(driverPanel as HTMLElement).queryByText(/Geopolitics/i)).not.toBeInTheDocument();
  });

  it("does not show local CSV related assets as latest supporting evidence", () => {
    const localCsvReplay: MarketAgentReplayResponse = {
      ...replay,
      replay: {
        ...replay.replay,
        related_assets: {
          ...replay.replay.related_assets,
          dxy: [
            {
              symbol: "dxy",
              data_timestamp: "2026-05-19T08:00:00+08:00",
              change_15m: 0.31,
              source_type: "local_csv_fallback",
              data_mode: "stale",
              is_stale: true
            }
          ],
          us10y: [
            {
              symbol: "us10y",
              data_timestamp: "2026-05-19T08:00:00+08:00",
              change_15m: 5.2,
              source_type: "local_csv_fallback",
              data_mode: "stale",
              is_stale: true
            }
          ],
          wti: [
            {
              symbol: "wti",
              data_timestamp: "2026-05-19T08:00:00+08:00",
              change_15m: 1.8,
              source_type: "local_csv_fallback",
              data_mode: "stale",
              is_stale: true
            }
          ]
        }
      }
    };
    const staleEvidence: MarketAgentEvidenceForRunResponse = {
      ...evidence,
      payload: {
        ...evidence.payload,
        evidence_packet: {
          ...evidence.payload.evidence_packet,
          evidence_status: { dxy: "stale", us10y: "stale", oil: "stale", us2y: "unavailable" }
        }
      }
    };

    renderMarketAgentPage({ replay: localCsvReplay, selectedEvidence: staleEvidence });

    const latestEvidencePanel = screen.getByRole("heading", { name: /Latest Evidence/i }).closest("section");
    expect(within(latestEvidencePanel as HTMLElement).queryByText(/^DXY \/ USD$/i)).not.toBeInTheDocument();
    expect(within(latestEvidencePanel as HTMLElement).queryByText(/^US10Y Yield Move$/i)).not.toBeInTheDocument();
    expect(within(latestEvidencePanel as HTMLElement).queryByText(/^Oil Price Move$/i)).not.toBeInTheDocument();
    expect(within(latestEvidencePanel as HTMLElement).queryByText(/Local CSV fallback/i)).not.toBeInTheDocument();
    fireEvent.click(within(latestEvidencePanel as HTMLElement).getByRole("tab", { name: "Drivers" }));
    expect(within(latestEvidencePanel as HTMLElement).getByText(/No evidence in this category/i)).toBeInTheDocument();
  });

  it("shows a replay unavailable state when the backend omits replay payload", () => {
    const replayWithoutPayload = {
      ok: true,
      available: false,
      message: "Unable to read market replay price series: no such table"
    } as unknown as MarketAgentReplayResponse;

    renderMarketAgentPage({ replay: replayWithoutPayload });

    expect(screen.getByRole("heading", { name: /XAUUSD \(Spot\)/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Replay \/ Timeline/i }));
    expect(screen.getByText(/Unable to read market replay price series/i)).toBeInTheDocument();
  });

  it("keeps next update countdown within the monitoring interval", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-19T00:40:00Z"));
    let unmount: (() => void) | undefined;

    try {
      ({ unmount } = render(
        <MarketAgentPage
          snapshot={snapshot}
          providerConfig={providerConfig}
          telegramConfig={telegramConfig}
          llmConfig={llmConfig}
          providerHealth={providerHealth}
          driverAttention={driverAttention}
          replay={replay}
          selectedEvidence={evidence}
          monitorStatus={{
            ...monitorStatus,
            running: true,
            phase: "running",
            intervalSeconds: 60,
            nextRunAt: "2026-05-19T02:28:29Z"
          }}
          selectedMonitorRunId={23}
          rangePreset="day"
          rangeStartInput="2026-05-19T04:00"
          rangeEndInput="2026-05-19T08:30"
          onPresetChange={() => {}}
          onRangeStartChange={() => {}}
          onRangeEndChange={() => {}}
          onApplyRange={() => {}}
          onSelectRun={() => {}}
          onRefresh={async () => {}}
          onSaveProviderConfig={async () => providerConfig}
          onTestProviderConnection={async () => providerAction}
          onResolveProviderSymbol={async () => providerAction}
          onGetProviderQuote={async () => providerAction}
          onRefreshProviderToken={async () => providerAction}
          onSaveTelegramConfig={async () => telegramConfig}
          onTestTelegram={async () => telegramAction}
          onSaveLLMConfig={async () => llmConfig}
          onTestLLM={async () => llmAction}
          onStartMonitorLoop={async () => monitorStatus}
          onStopMonitorLoop={async () => monitorStatus}
        />
      ));

      expect(screen.getByLabelText(/^29 sec$/i)).toBeInTheDocument();
      expect(screen.queryByText(/6509 sec/i)).not.toBeInTheDocument();
    } finally {
      unmount?.();
      vi.useRealTimers();
    }
  });

  it("uses interactive dashboard filters and user-facing evidence labels", () => {
    render(
      <MarketAgentPage
        snapshot={snapshot}
        providerConfig={providerConfig}
        telegramConfig={telegramConfig}
        llmConfig={llmConfig}
        providerHealth={providerHealth}
        driverAttention={driverAttention}
        replay={replay}
        selectedEvidence={evidence}
        monitorStatus={monitorStatus}
        selectedMonitorRunId={23}
        rangePreset="day"
        rangeStartInput="2026-05-19T04:00"
        rangeEndInput="2026-05-19T08:30"
        onPresetChange={() => {}}
        onRangeStartChange={() => {}}
        onRangeEndChange={() => {}}
        onApplyRange={() => {}}
        onSelectRun={() => {}}
        onSaveProviderConfig={() => {}}
        onClearProviderConfig={() => {}}
        onTestCTraderConnection={async () => ({ ok: true })}
        onResolveCTraderSymbol={async () => ({ ok: true })}
        onGetCTraderQuoteTest={async () => ({ ok: true })}
        onSaveTelegramConfig={async () => telegramConfig}
        onTestTelegramMessage={async () => ({ ok: true, status: "sent", message: "Telegram test message sent." })}
        onSaveLLMConfig={async () => llmConfig}
        onTestLLMConnection={async () => ({ ok: true, status: "available", message: "Local AI is available." })}
        onTestLLMJsonResponse={async () => ({ ok: true, status: "available", message: "Model returned valid JSON." })}
        localAiSetup={localAiSetup}
        localAiPullProgress={null}
        onDetectLocalAI={async () => localAiSetup}
        onInstallRecommendedModel={async () => ({ ok: true, status: "model_ready", message: "Model ready." })}
        onCancelModelDownload={async () => ({ ok: true, status: "cancelled" })}
        onBenchmarkLLM={async () => ({ ok: true, status: "model_ready", elapsedMs: 900, message: "Benchmark passed." })}
        onApplyLLMFallbackPolicy={async () => ({ ok: true, status: "model_ready", model: "qwen3.5:4b" })}
        onStartCTraderConnect={async () => ({ ok: true, status: "preparing_live_feed", message: "cTrader is connected. Preparing live XAUUSD and syncing history in the background.", ctrader: providerConfig.ctrader })}
        onTestCTraderBackfill={async () => ({ ok: true, message: "M1 backfill is available." })}
        onRunMonitorOnce={async () => monitorStatus}
        onRunBackfillRecovery={async () => ({ ...monitorStatus, phase: "recovery_completed", message: "Backfill recovery completed." })}
        onStartMonitorLoop={async () => ({ ...monitorStatus, running: true, phase: "running" })}
        onStopMonitorLoop={async () => monitorStatus}
      />
    );

    const replayRange = screen.getByRole("group", { name: /Replay range/i });
    const day = within(replayRange).getByRole("button", { name: "Day" });
    const month = within(replayRange).getByRole("button", { name: "Month" });
    expect(day).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(month);
    expect(month).toHaveAttribute("aria-pressed", "true");
    expect(day).toHaveAttribute("aria-pressed", "false");

    const evidenceTabs = screen.getByRole("tablist", { name: /Evidence filters/i });
    const allTab = within(evidenceTabs).getByRole("tab", { name: "All" });
    const newsTab = within(evidenceTabs).getByRole("tab", { name: "News" });
    expect(allTab).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByText(/^Confirming$/i)).not.toBeInTheDocument();
    expect(screen.getAllByText(/^Supporting$/i).length).toBeGreaterThan(0);
    fireEvent.click(newsTab);
    expect(newsTab).toHaveAttribute("aria-selected", "true");
    expect(allTab).toHaveAttribute("aria-selected", "false");
    const latestEvidencePanel = screen.getByRole("heading", { name: /Latest Evidence/i }).closest("section");
    expect(latestEvidencePanel).not.toBeNull();
    expect(within(latestEvidencePanel as HTMLElement).getByText(/Fed headline/i)).toBeInTheDocument();
    expect(within(latestEvidencePanel as HTMLElement).queryByText(/^DXY \/ USD$/i)).not.toBeInTheDocument();
  });

  it("switches cockpit sections from the left navigation", async () => {
    const { container } = render(
      <MarketAgentPage
        snapshot={snapshot}
        providerConfig={providerConfig}
        telegramConfig={telegramConfig}
        llmConfig={llmConfig}
        providerHealth={providerHealth}
        driverAttention={driverAttention}
        replay={replay}
        selectedEvidence={evidence}
        monitorStatus={monitorStatus}
        selectedMonitorRunId={23}
        rangePreset="day"
        rangeStartInput="2026-05-19T04:00"
        rangeEndInput="2026-05-19T08:30"
        onPresetChange={() => {}}
        onRangeStartChange={() => {}}
        onRangeEndChange={() => {}}
        onApplyRange={() => {}}
        onSelectRun={() => {}}
        onSaveProviderConfig={() => {}}
        onClearProviderConfig={() => {}}
        onTestCTraderConnection={async () => ({ ok: true })}
        onResolveCTraderSymbol={async () => ({ ok: true })}
        onGetCTraderQuoteTest={async () => ({ ok: true })}
        onSaveTelegramConfig={async () => telegramConfig}
        onTestTelegramMessage={async () => ({ ok: true, status: "sent", message: "Telegram test message sent." })}
        onSaveLLMConfig={async () => llmConfig}
        onTestLLMConnection={async () => ({ ok: true, status: "available", message: "Local AI is available." })}
        onTestLLMJsonResponse={async () => ({ ok: true, status: "available", message: "Model returned valid JSON." })}
        onRunMonitorOnce={async () => monitorStatus}
        onRunBackfillRecovery={async () => ({ ...monitorStatus, phase: "recovery_completed", message: "Backfill recovery completed." })}
        onStartMonitorLoop={async () => ({ ...monitorStatus, running: true, phase: "running" })}
        onStopMonitorLoop={async () => monitorStatus}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /^Data Sources$/i }));
    expect(screen.getByRole("heading", { name: /^Data Sources$/i })).toBeInTheDocument();
    expect(screen.queryByText(/Add the cTrader login used for live XAUUSD/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^cTrader$/i })).toHaveAttribute("aria-pressed", "true");
    const actions = screen.getByRole("navigation", { name: /Data source setup actions/i });
    expect(within(actions).getByRole("button", { name: /^cTrader$/i })).toBeInTheDocument();
    expect(within(actions).getByRole("button", { name: /^Local AI$/i })).toBeInTheDocument();
    expect(within(actions).getByRole("button", { name: /^Telegram$/i })).toBeInTheDocument();
    expect(within(actions).getByRole("button", { name: /^Monitoring$/i })).toBeInTheDocument();
    expect(within(actions).queryByRole("button", { name: /^Price$/i })).not.toBeInTheDocument();
    expect(within(actions).queryByRole("button", { name: /^Market data$/i })).not.toBeInTheDocument();
    expect(within(actions).queryByRole("button", { name: /^News$/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Access Token/i)).not.toBeInTheDocument();

    const alertsButton = screen.getByRole("navigation", { name: /Market Agent sections/i }).querySelector("[data-market-agent-section='alerts']")!;
    expect(alertsButton.querySelector(".market-agent-nav-badge")).toHaveTextContent("1");
    fireEvent.click(alertsButton);
    expect(screen.getByRole("heading", { name: /^Alerts$/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/Alert summary/i)).toBeInTheDocument();
    expect(screen.getByText(/1 attention item/i)).toBeInTheDocument();
    expect(screen.getByText(/1 quiet repeat hidden/i)).toBeInTheDocument();
    expect(screen.getByText(/Telegram is off, so nothing is sent there/i)).toBeInTheDocument();
    expect(screen.getByText(/Driver US yields/i)).toBeInTheDocument();
    expect(screen.queryByText(/Driver not confirmed/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Sent$/i)).not.toBeInTheDocument();
    expect(container.querySelector(".market-agent-alert-lane")).not.toBeInTheDocument();
    expect(container.querySelectorAll(".market-agent-alert-card")).toHaveLength(1);
    expect(container.querySelector(".market-agent-alerts-list .market-agent-evidence-mini-row")).not.toBeInTheDocument();
    await waitFor(() => expect(alertsButton.querySelector(".market-agent-nav-badge")).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /Replay \/ Timeline/i }));
    expect(screen.getByRole("heading", { name: /^Market Replay$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Day$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Month$/i })).toBeInTheDocument();
    expect(screen.queryByText(/Last 1h/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Last 4h/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Open full replay/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Price series/i)).not.toBeInTheDocument();
    expect(container.querySelector(".market-agent-replay-track-row.selected")).not.toBeInTheDocument();
    expect(Array.from(container.querySelectorAll(".market-agent-replay-node")).every((node) => node.textContent === "")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /^Driver Attention$/i }));
    expect(screen.getByRole("heading", { name: /^Driver Focus$/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^Driving Now$/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^Watch Next$/i })).toBeInTheDocument();
    expect(screen.queryByText(/Technical details/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Evidence$/i }));
    expect(screen.getByRole("heading", { name: /Evidence Panel/i })).toBeInTheDocument();
    expect(screen.getByText(/Accepted driver/i)).toBeInTheDocument();
    expect(screen.queryByText(/Raw details/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Audit details/i)).not.toBeInTheDocument();

    expect(screen.queryByRole("heading", { name: /System Control/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Logs \/ Settings/i })).not.toBeInTheDocument();
  });

  it("defaults Data Sources to Connect cTrader and Auto Local AI instead of raw setup forms", () => {
    renderMarketAgentPage();

    fireEvent.click(screen.getByRole("button", { name: /^Data Sources$/i }));

    expect(screen.queryByText(/^Next step$/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /^cTrader connection needed$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Open cTrader setup$/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^cTrader$/i }));
    expect(screen.getByRole("heading", { name: /^Connect cTrader$/i })).toBeInTheDocument();
    expect(screen.getByText(/fetch live XAUUSD first/i)).toBeInTheDocument();
    expect(screen.getByText(/Password is stored locally and masked after save/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^(Connect|Reconnect) cTrader$/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/Account ID/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/cTID \/ email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Password/i)).toHaveAttribute("type", "password");
    expect(screen.queryByLabelText(/Trading environment/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Symbol$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Advanced cTrader CLI setup/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Client ID/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Client Secret/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Access Token/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Refresh Token/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Authorization code/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/CLI executable/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Symbol ID/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Snapshot path/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Quote timeout/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Token store path/i)).not.toBeInTheDocument();
    const tooltipExpectations = [
      /Trading account/i,
      /cTrader ID/i,
      /local CLI login/i
    ] as const;
    tooltipExpectations.forEach((title) => {
      expect(screen.getByTitle(title)).toHaveAttribute("aria-label", "Field help");
    });
    expect(screen.queryByText(/Where do I find these/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Local AI$/i }));
    expect(screen.getByRole("heading", { name: /^Auto Local AI$/i })).toBeInTheDocument();
    expect(screen.getByText(/Rule-based active/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Auto$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Qwen3\.5 4B$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Qwen3\.5 0\.8B$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Rule-based only$/i })).toBeInTheDocument();
    expect(screen.getAllByText(/~2\.9 GB/i).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /Download recommended/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Cancel download/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/Advanced model settings/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Model$/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Endpoint$/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Test JSON/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Run benchmark/i })).not.toBeInTheDocument();
  });

  it("shows guided Local AI status and model pull progress", () => {
    const noRuntimeSetup: MarketAgentLLMSetupResponse = {
      ...localAiSetup,
      ok: false,
      available: true,
      status: "runtime_installing",
      message: "Local AI runtime will be prepared automatically when needed.",
      ollama: {
        installed: false,
        running: false,
        endpointReachable: false,
        endpoint: "http://127.0.0.1:21434"
      }
    };

    renderMarketAgentPage({ localAiSetup: noRuntimeSetup });
    fireEvent.click(screen.getByRole("button", { name: /^Data Sources$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Local AI$/i }));

    expect(screen.getAllByText(/Runtime will be prepared/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/prepared automatically/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Download recommended/i })).toBeEnabled();
  });

  it("renders Local AI pull progress bytes and percent while downloading", () => {
    const progress: MarketAgentOllamaPullProgress = {
      model: "qwen3.5:4b",
      status: "downloading model",
      completedBytes: 1450000000,
      totalBytes: 2900000000,
      percent: 50,
      done: false
    };

    renderMarketAgentPage({ localAiPullProgress: progress });
    fireEvent.click(screen.getByRole("button", { name: /^Data Sources$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Local AI$/i }));

    expect(screen.getAllByText(/Downloading model/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/1450000000 \/ 2900000000 bytes/i)).toBeInTheDocument();
    expect(screen.getByText(/50\.0%/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Downloading$/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Cancel download/i })).toBeInTheDocument();
  });

  it("does not label cTrader as live when only login is saved", () => {
    renderMarketAgentPage({
      providerConfig: {
        ...providerConfig,
        ctrader: {
          ...providerConfig.ctrader!,
          enabled: true,
          accountId: "8941207"
        }
      },
      providerHealth: {
        ...providerHealth,
        items: [
          {
            provider_key: "ctrader_spot",
            source: "cTrader",
            source_type: "spot",
            data_mode: "unavailable",
            is_available: false,
            is_stale: false,
            error: "The installed cTrader CLI supports account and symbol checks, but does not expose live quotes."
          }
        ]
      }
    });
    fireEvent.click(screen.getByRole("button", { name: /^Data Sources$/i }));

    expect(screen.getAllByText(/Getting quote/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(/cTrader live/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/does not expose live quotes/i)).not.toBeInTheDocument();
  });

  it("shows immediate Local AI download status before backend progress arrives", async () => {
    let resolveInstall: (value: MarketAgentLLMActionResponse) => void = () => {};
    const installModel = vi.fn(
      () =>
        new Promise<MarketAgentLLMActionResponse>((resolve) => {
          resolveInstall = resolve;
        })
    );

    renderMarketAgentPage({ onInstallRecommendedModel: installModel });
    fireEvent.click(screen.getByRole("button", { name: /^Data Sources$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Local AI$/i }));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Download recommended/i }));
    });

    expect(screen.getByText(/Preparing Local AI runtime/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Preparing$/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Cancel download/i })).toBeInTheDocument();

    await act(async () => {
      resolveInstall({
        ok: true,
        status: "download_started",
        model: "qwen3.5:4b",
        message: "Local AI model download is running in the background.",
        done: false
      });
    });

    expect(screen.getByRole("button", { name: /^Preparing$/i })).toBeDisabled();
    expect(screen.getByText(/Local AI model download is running in the background/i)).toBeInTheDocument();
  });

  it("shows cancelled Local AI progress immediately after cancel", async () => {
    const installModel = vi.fn(
      () =>
        Promise.resolve({
          ok: true,
          status: "download_started",
          model: "qwen3.5:4b",
          message: "Local AI model download is running in the background.",
          done: false
        })
    );
    const cancelModel = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: "cancelled",
        model: "qwen3.5:4b",
        message: "Model download cancelled.",
        done: true
      })
    );

    renderMarketAgentPage({ onInstallRecommendedModel: installModel, onCancelModelDownload: cancelModel });
    fireEvent.click(screen.getByRole("button", { name: /^Data Sources$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Local AI$/i }));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Download recommended/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Cancel download/i }));
    });

    expect(cancelModel).toHaveBeenCalledWith("qwen3.5:4b");
    expect(screen.getAllByText(/^Cancelled$/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Model download cancelled/i).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /Cancel download/i })).not.toBeInTheDocument();
  });

  it("formats monitor timestamps and does not expose raw epoch values", () => {
    renderMarketAgentPage({ monitorStatus: { ...monitorStatus, lastRunAt: 1779306621 } });
    fireEvent.click(screen.getByRole("button", { name: /^Data Sources$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Monitoring$/i }));

    const lastCheck = screen.getByText(/^Last check$/i).closest("div");
    expect(lastCheck).toHaveTextContent(/\d{2}-\d{2} \d{2}:\d{2}/);
    expect(lastCheck).not.toHaveTextContent("1779306621");
  });

  it("keeps month replay focused on meaningful market turns", () => {
    const noisyReplay: MarketAgentReplayResponse = {
      ...replay,
      replay: {
        ...replay.replay,
        timeline_events: [
          ...replay.replay.timeline_events,
          {
            monitor_run_id: 88,
            event_time: "2026-05-21T03:50:00+08:00",
            event_type: "analysis",
            label: "unknown",
            payload: { semantic_type: "evidence", impact_percent: 0.32, main_driver: "unknown" }
          },
          {
            monitor_run_id: 89,
            event_time: "2026-05-21T03:50:00+08:00",
            event_type: "recovery",
            label: "backfill",
            payload: { semantic_type: "recovery", data_mode: "backfilled", main_driver: "unknown" }
          },
          {
            monitor_run_id: 92,
            event_time: "2026-05-19T07:15:00+08:00",
            event_type: "market_alert",
            label: "yields",
            payload: { semantic_type: "breakout", impact_percent: -0.49, main_driver: "yields" }
          },
          {
            monitor_run_id: 93,
            event_time: "2026-05-19T07:15:00+08:00",
            event_type: "market_alert",
            label: "yields",
            payload: { semantic_type: "breakout", impact_percent: -0.49, main_driver: "yields" }
          }
        ],
        alerts: [
          ...replay.replay.alerts,
          {
            monitor_run_id: 90,
            run_started_at: "2026-05-21T03:50:00+08:00",
            should_notify: true,
            notification_level: "level_2",
            message: "Alert",
            main_driver: "unknown",
            semantic_type: "evidence",
            impact_percent: 0.32
          }
        ],
        suppressed_alerts: [
          ...replay.replay.suppressed_alerts,
          {
            monitor_run_id: 91,
            run_started_at: "2026-05-21T03:50:00+08:00",
            should_notify: false,
            notification_level: "level_1",
            message: "Suppressed duplicate"
          }
        ]
      }
    };

    renderMarketAgentPage({ replay: noisyReplay, rangePreset: "month" });
    fireEvent.click(screen.getByRole("button", { name: /Replay \/ Timeline/i }));

    expect(screen.getByText(/Month: Major Turns/i)).toBeInTheDocument();
    expect(screen.queryByText(/^backfill$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^unknown$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Alert$/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Yields pressure/i)).toBeInTheDocument();
    expect(screen.getByText(/3 major turns/i)).toBeInTheDocument();
    expect(screen.getByText(/XAUUSD drop -0\.49%/i)).toBeInTheDocument();
    expect(screen.getAllByText(/US yields · Monitor timeline/i)).toHaveLength(2);
    expect(screen.queryAllByText(/^yields$/i)).toHaveLength(0);
  });

  it("prefers AI-compressed evidence summaries in the dashboard feed", () => {
    const summarizedReplay: MarketAgentReplayResponse = {
      ...replay,
      replay: {
        ...replay.replay,
        news_items: [
          {
            ...replay.replay.news_items[0],
            summary_title: "Fed Rates Signal",
            summary: "Fed headline lifted yields; gold pressure stayed active.",
            title: "Very long raw headline that should not be used when summary exists"
          }
        ],
        related_assets: {
          ...replay.replay.related_assets,
          dxy: [
            {
              ...replay.replay.related_assets.dxy[0],
              summary: "DXY strength confirmed USD pressure on gold."
            }
          ],
          us10y: [
            {
              ...replay.replay.related_assets.us10y[0],
              summary: "US10Y rise confirmed the yield-pressure leg."
            }
          ]
        }
      }
    };

    renderMarketAgentPage({ replay: summarizedReplay });

    const latestEvidencePanel = screen.getByRole("heading", { name: /Latest Evidence/i }).closest("section");
    expect(within(latestEvidencePanel as HTMLElement).getByText(/Fed Rates Signal/i)).toBeInTheDocument();
    expect(within(latestEvidencePanel as HTMLElement).getByText(/Fed headline lifted yields/i)).toBeInTheDocument();
    expect(within(latestEvidencePanel as HTMLElement).getByText(/DXY strength confirmed USD pressure/i)).toBeInTheDocument();
    expect(within(latestEvidencePanel as HTMLElement).getByText(/US10Y rise confirmed the yield-pressure leg/i)).toBeInTheDocument();
    expect(within(latestEvidencePanel as HTMLElement).queryByText(/Very long raw headline/i)).not.toBeInTheDocument();
  });

  it("uses month replay summary events instead of expanding every day marker", () => {
    const monthlyReplay: MarketAgentReplayResponse = {
      ...replay,
      replay: {
        ...replay.replay,
        month_summary_events: [
          {
            monitor_run_id: 200,
            event_time: "2026-05-01T09:00:00+08:00",
            event_type: "month_summary",
            label: "Week opened with yields pressuring gold",
            payload: {
              semantic_type: "breakout",
              impact_percent: -0.62,
              main_driver: "yields",
              summary: "AI condensed 12 day markers into one yield-pressure turn.",
              source_event_ids: [21, 22, 23]
            }
          }
        ],
        timeline_events: [
          ...replay.replay.timeline_events,
          {
            monitor_run_id: 201,
            event_time: "2026-05-02T09:00:00+08:00",
            event_type: "market_alert",
            label: "Daily marker that month view should hide",
            payload: { semantic_type: "breakout", impact_percent: -0.51, main_driver: "yields" }
          }
        ]
      }
    } as MarketAgentReplayResponse;

    renderMarketAgentPage({ replay: monthlyReplay, rangePreset: "month" });
    fireEvent.click(screen.getByRole("button", { name: /Replay \/ Timeline/i }));

    expect(screen.getByText(/1 major turns/i)).toBeInTheDocument();
    expect(screen.getByText(/Week opened with yields pressuring gold/i)).toBeInTheDocument();
    expect(screen.getByText(/AI condensed 12 day markers/i)).toBeInTheDocument();
    expect(screen.queryByText(/Daily marker that month view should hide/i)).not.toBeInTheDocument();
  });

  it("orders replay markers by event time from earliest to latest", () => {
    const orderedReplay: MarketAgentReplayResponse = {
      ...replay,
      replay: {
        ...replay.replay,
        timeline_events: [
          {
            monitor_run_id: 301,
            event_time: "2026-05-19T09:00:00+08:00",
            event_type: "analysis",
            label: "Later yield pressure",
            payload: { semantic_type: "evidence", impact_percent: -0.31, main_driver: "yields" }
          },
          {
            monitor_run_id: 300,
            event_time: "2026-05-19T07:00:00+08:00",
            event_type: "analysis",
            label: "Earlier dollar pressure",
            payload: { semantic_type: "evidence", impact_percent: -0.21, main_driver: "usd" }
          }
        ]
      }
    };

    renderMarketAgentPage({ replay: orderedReplay, rangePreset: "day" });
    fireEvent.click(screen.getByRole("button", { name: /Replay \/ Timeline/i }));

    const earlier = screen.getByText(/Earlier dollar pressure/i);
    const later = screen.getByText(/Later yield pressure/i);
    expect(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("applies Local AI fallback policy returned after model installation", async () => {
    const installModel = vi.fn().mockResolvedValue({
      ok: false,
      status: "invalid_json",
      model: "qwen3.5:4b",
      message: "Model download completed, but JSON or benchmark validation failed.",
      policy: {
        ok: true,
        status: "fallback_active",
        model: "qwen3.5:2b",
        message: "Downgrade to qwen3.5:2b."
      }
    });

    renderMarketAgentPage({ onInstallRecommendedModel: installModel });
    fireEvent.click(screen.getByRole("button", { name: /^Data Sources$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Local AI$/i }));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Download recommended/i }));
    });

    expect(installModel).toHaveBeenCalledWith("qwen3.5:4b");
    expect(screen.queryByText(/Advanced model settings/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Model$/i)).not.toBeInTheDocument();
    expect(screen.getByText(/JSON or benchmark validation failed/i)).toBeInTheDocument();
  });

  it("supports the guided setup path from cTrader CLI credentials through Local AI model install", async () => {
    const startCTraderConnect = vi.fn().mockResolvedValue({
      ok: true,
      status: "preparing_live_feed",
      message: "cTrader is connected. Preparing live XAUUSD and syncing history in the background.",
      ctrader: providerConfig.ctrader
    });
    const quoteTest = vi.fn().mockResolvedValue({
      ok: true,
      message: "Live quote received.",
      quote: { symbol: "XAUUSD", mid: 4512.53, source_type: "spot" }
    });
    const backfillTest = vi.fn().mockResolvedValue({ ok: true, message: "M1 trendbar backfill is available." });
    const installModel = vi.fn().mockResolvedValue({ ok: true, status: "model_ready", message: "Model ready." });
    const jsonTest = vi.fn().mockResolvedValue({ ok: true, status: "model_ready", message: "Model returned valid JSON." });
    const benchmark = vi.fn().mockResolvedValue({ ok: true, status: "model_ready", elapsedMs: 900, message: "Benchmark passed." });
    const saveTelegram = vi.fn().mockResolvedValue({ ...telegramConfig, telegram: { ...telegramConfig.telegram!, enabled: true } });
    const startMonitor = vi.fn().mockResolvedValue({ ...monitorStatus, running: true, phase: "running" });

    renderMarketAgentPage({
      onStartCTraderConnect: startCTraderConnect,
      onGetCTraderQuoteTest: quoteTest,
      onTestCTraderBackfill: backfillTest,
      onInstallRecommendedModel: installModel,
      onTestLLMJsonResponse: jsonTest,
      onBenchmarkLLM: benchmark,
      onSaveTelegramConfig: saveTelegram,
      onStartMonitorLoop: startMonitor
    });

    fireEvent.click(screen.getByRole("button", { name: /^Data Sources$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^cTrader$/i }));
    fireEvent.change(screen.getByLabelText(/Account ID/i), { target: { value: "123456" } });
    fireEvent.change(screen.getByLabelText(/cTID \/ email/i), { target: { value: "trader@example.com" } });
    fireEvent.change(screen.getByLabelText(/Password/i), { target: { value: "very-secret-password" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^(Connect|Reconnect) cTrader$/i }));
    });
    expect(startCTraderConnect).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "123456",
        ctid: "trader@example.com",
        password: "very-secret-password",
        symbol: "XAUUSD",
        enabled: true
      })
    );

    await act(async () => {
    });
    expect(screen.queryByRole("button", { name: /Test Quote/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Test M1 Backfill/i })).not.toBeInTheDocument();
    expect(quoteTest).not.toHaveBeenCalled();
    expect(backfillTest).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /^Local AI$/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Download recommended/i }));
    });
    expect(installModel).toHaveBeenCalledWith("qwen3.5:4b");
    expect(screen.queryByRole("button", { name: /Test JSON/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Run benchmark/i })).not.toBeInTheDocument();
    expect(jsonTest).not.toHaveBeenCalled();
    expect(benchmark).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /^Telegram$/i }));
    fireEvent.click(screen.getByLabelText(/Enable Telegram alerts/i));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));
    });
    expect(saveTelegram).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /^Monitoring$/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Start Monitoring$/i }));
    });
    expect(startMonitor).toHaveBeenCalledTimes(1);
  });

  it("renders a user-facing market agent page without primary raw enum labels", async () => {
    const selected: number[] = [];

    render(
      <MarketAgentPage
        snapshot={snapshot}
        providerConfig={providerConfig}
        telegramConfig={telegramConfig}
        llmConfig={llmConfig}
        providerHealth={providerHealth}
        driverAttention={driverAttention}
        replay={replay}
        selectedEvidence={evidence}
        monitorStatus={monitorStatus}
        selectedMonitorRunId={23}
        rangePreset="day"
        rangeStartInput="2026-05-19T04:00"
        rangeEndInput="2026-05-19T08:30"
        onPresetChange={() => {}}
        onRangeStartChange={() => {}}
        onRangeEndChange={() => {}}
        onApplyRange={() => {}}
        onSelectRun={(id) => selected.push(id)}
        onSaveProviderConfig={() => {}}
        onClearProviderConfig={() => {}}
        onTestCTraderConnection={async () => ({ ok: true })}
        onResolveCTraderSymbol={async () => ({ ok: true })}
        onGetCTraderQuoteTest={async () => ({ ok: true })}
        onSaveTelegramConfig={async () => telegramConfig}
        onTestTelegramMessage={async () => ({ ok: true, status: "sent", message: "Telegram test message sent." })}
        onSaveLLMConfig={async () => llmConfig}
        onTestLLMConnection={async () => ({ ok: true, status: "available", message: "Local AI is available." })}
        onTestLLMJsonResponse={async () => ({ ok: true, status: "available", message: "Model returned valid JSON." })}
        onRunMonitorOnce={async () => monitorStatus}
        onRunBackfillRecovery={async () => ({ ...monitorStatus, phase: "recovery_completed", message: "Backfill recovery completed." })}
        onStartMonitorLoop={async () => ({ ...monitorStatus, running: true, phase: "running" })}
        onStopMonitorLoop={async () => monitorStatus}
      />
    );

    expect(screen.queryByText(/Gold is currently under yield\/USD pressure\./i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Main driver changed from DXY \/ USD to US yields\./i)).not.toBeInTheDocument();
    expect(screen.getByText(/TRENDING DOWN/i)).toBeInTheDocument();
    expect(screen.queryByText(/^Bearish$/i)).not.toBeInTheDocument();
    expect(screen.getAllByText(/Drop/i).length).toBeGreaterThan(0);
    expect(screen.getByText("Move Size")).toBeInTheDocument();
    expect(screen.getAllByText(/US yields/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/WTI Oil/i)).toBeInTheDocument();
    expect(screen.getAllByText(/cTrader \(Spot\)/i).length).toBeGreaterThan(0);
    expect(screen.queryByText("futures_proxy")).not.toBeInTheDocument();
    expect(screen.queryByText("core_structural")).not.toBeInTheDocument();
    expect(screen.queryByText("main_driver usd -> yields")).not.toBeInTheDocument();
    expect(screen.queryByText(/Using Yahoo GC=F futures proxy, not true spot XAUUSD\./i)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /XAUUSD \(Spot\)/i })).toBeInTheDocument();
    expect(screen.getByText(/cTrader \(Spot\)/i)).toBeInTheDocument();
    expect(screen.getAllByText(/100%/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/View Full Timeline/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Fed headline/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/US session opens/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Raw details/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: /Yields pressure/i })[0]);
    expect(selected).toEqual([23]);

    fireEvent.click(screen.getByRole("button", { name: /^Evidence$/i }));
    expect(screen.getAllByText(/Allowed drivers/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Fed \/ rates/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/No direct headline/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Raw details/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Audit details/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Data Sources$/i }));
    expect(screen.getByRole("heading", { name: /^Data Sources$/i })).toBeInTheDocument();
    expect(screen.queryByText(/Add the cTrader login used for live XAUUSD/i)).not.toBeInTheDocument();
    const dataSourceActions = screen.getByRole("navigation", { name: /Data source setup actions/i });
    expect(within(dataSourceActions).getByRole("button", { name: /^cTrader$/i })).toBeInTheDocument();
    expect(within(dataSourceActions).getByRole("button", { name: /^Local AI$/i })).toBeInTheDocument();
    expect(within(dataSourceActions).getByRole("button", { name: /^Telegram$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Monitoring$/i })).toBeInTheDocument();
    expect(within(dataSourceActions).queryByRole("button", { name: /^Price$/i })).not.toBeInTheDocument();
    expect(within(dataSourceActions).queryByRole("button", { name: /^Market data$/i })).not.toBeInTheDocument();
    expect(within(dataSourceActions).queryByRole("button", { name: /^News$/i })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Connect cTrader/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/Agent activity/i)).not.toBeInTheDocument();
    expect(screen.getByText(/fetch live XAUUSD first/i)).toBeInTheDocument();
    expect(screen.queryByText(/^Backup price$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Local CSV$/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Access Token/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Refresh Token/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Config path:/i)).not.toBeInTheDocument();

    fireEvent.click(within(dataSourceActions).getByRole("button", { name: /^cTrader$/i }));
    expect(screen.getByRole("heading", { name: /Connect cTrader/i })).toBeInTheDocument();
    expect(screen.getByText(/Password is stored locally and masked after save/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Account ID/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/cTID \/ email/i)).toHaveAttribute("placeholder", providerConfig.ctrader?.ctidMasked);
    expect(screen.getByLabelText(/Password/i)).toHaveAttribute("placeholder", providerConfig.ctrader?.passwordMasked);
    expect(screen.queryByLabelText(/Trading environment/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Symbol$/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Access Token/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Refresh Token/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Advanced cTrader CLI setup/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/CLI executable/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Symbol ID/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Snapshot path/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Access Token/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Refresh Token/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/CLI executable/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Config path:/i)).not.toBeInTheDocument();

    fireEvent.click(within(dataSourceActions).getByRole("button", { name: /^Telegram$/i }));
    expect(screen.getByRole("heading", { name: /Alerts/i })).toBeInTheDocument();
    expect(screen.getByText(/Telegram is optional/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Bot token/i)).toHaveAttribute("placeholder", "12********90");
    expect(screen.getByLabelText(/Chat ID/i)).toHaveValue("123456789");
    expect(screen.getByRole("button", { name: /Send test/i })).toBeInTheDocument();

    fireEvent.click(within(dataSourceActions).getByRole("button", { name: /^Local AI$/i }));
    expect(screen.getByRole("heading", { name: /Auto Local AI/i })).toBeInTheDocument();
    expect(screen.getByText(/Optional local model/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Rule-based/i).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /^Auto$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Qwen3\.5 4B$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Qwen3\.5 0\.8B$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Rule-based only$/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/Endpoint/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Download recommended/i })).toBeInTheDocument();
    expect(screen.queryByText(/Advanced model settings/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Test JSON/i })).not.toBeInTheDocument();

    fireEvent.click(within(dataSourceActions).getByRole("button", { name: /^Monitoring$/i }));
    expect(screen.getByRole("heading", { name: /Start monitoring/i })).toBeInTheDocument();
    expect(screen.getByText(/Monitoring is stopped\./i)).toBeInTheDocument();
    expect(screen.queryByText(/Backfill & Recover runs one monitor pass/i)).not.toBeInTheDocument();
    expect(screen.getByText(/automatically backfills missing cTrader history/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Check Now/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Start Monitoring/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Stop Monitoring/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Recover Missed Data/i })).not.toBeInTheDocument();

    fireEvent.click(within(dataSourceActions).getByRole("button", { name: /^cTrader$/i }));
    expect(screen.getByRole("heading", { name: /Connect cTrader/i })).toBeInTheDocument();

    expect(screen.queryByRole("button", { name: /^Refresh token$/i })).not.toBeInTheDocument();
  });

  it("shows backend agent activity as a separate pipeline view", () => {
    renderMarketAgentPage({
      monitorStatus: {
        ...monitorStatus,
        running: true,
        phase: "collecting_context",
        message: "Collecting market context.",
        updatedAt: "2026-05-19T07:15:10+08:00",
        activity: {
          ctrader: {
            status: "live",
            label: "XAUUSD live",
            detail: "Last price 3,233.15 from cTrader.",
            source: "cTrader",
            dataMode: "live_seen",
            symbols: ["XAUUSD"],
            dataTimestamp: "2026-05-19T07:15:00+08:00",
            selectedProvider: "ctrader_spot",
            providerChain: [
              {
                provider: "ctrader_spot",
                source: "cTrader",
                data_mode: "live_seen",
                is_available: true,
                is_stale: false
              }
            ],
            jobs: [
              {
                title: "Live quote request",
                status: "ready",
                detail: "cTrader returned a fresh XAUUSD spot quote.",
                input: "cTrader spot feed",
                output: "Fresh XAUUSD snapshot for evidence",
                timestamp: "2026-05-19T07:15:00+08:00"
              }
            ],
            handoff: "Live XAUUSD quote is usable by price trigger, evidence gate, replay, and alert preflight."
          },
          history: {
            status: "syncing",
            label: "History sync",
            detail: "Backfill running in the background.",
            progress: 42,
            symbols: ["XAUUSD", "DXY", "US10Y"],
            windowStart: "2026-05-19T04:15:00+08:00",
            windowEnd: "2026-05-19T07:15:00+08:00",
            storedRows: 18,
            jobs: [
              {
                title: "Gap detector",
                status: "syncing",
                detail: "Recovery backfill is running after the live check.",
                input: "last_successful_run_at + current run time",
                output: "Backfill required"
              }
            ]
          },
          context: {
            status: "active",
            label: "News and calendar",
            detail: "3 headlines and 2 calendar events collected.",
            newsCount: 3,
            calendarCount: 2,
            sources: ["Reuters", "ForexFactory"],
            latestNewsAt: "2026-05-19T07:05:00+08:00",
            jobs: [
              {
                title: "News collector",
                status: "ready",
                detail: "3 relevant headlines loaded for the current market window.",
                input: "App-managed RSS/news context",
                output: "3 headlines, 1 source"
              },
              {
                title: "Calendar collector",
                status: "ready",
                detail: "2 calendar events loaded around the analysis window.",
                input: "App-managed economic calendar",
                output: "2 calendar events"
              }
            ]
          },
          evidence: {
            status: "ready",
            label: "Evidence gate ready",
            detail: "Live price, recent history, and provider health are usable.",
            chainStatus: "ready",
            usableInputs: ["live_xauusd_spot", "xauusd_recent_history", "news_context"],
            allowedCandidateDrivers: ["yields", "usd"],
            blockedDrivers: { oil_inflation: "Oil is background only." },
            jobs: [
              {
                title: "Cross-market sensors",
                status: "ready",
                detail: "DXY and US10Y are confirming; oil is background.",
                input: "Related asset rows + provider health",
                output: "dxy: confirming, us10y: confirming, oil: not_confirming"
              },
              {
                title: "Candidate driver gate",
                status: "ready",
                detail: "Only allowed drivers can be used by rule or LLM analysis.",
                input: "Driver attention states + evidence gates",
                output: "2 allowed / 1 blocked"
              }
            ]
          },
          llm: {
            status: "validated",
            label: "Local AI reviewed",
            detail: "LLM output passed validation after the evidence gate.",
            model: "qwen3.5:4b",
            result: "yields likely",
            analysisEngine: "llm_validated",
            jobs: [
              {
                title: "Rule baseline",
                status: "ready",
                detail: "Deterministic analysis runs first and remains the fallback if Local AI is invalid.",
                input: "ScenarioFixture + evidence gate + DriverAttention",
                output: "yields / likely"
              },
              {
                title: "Cause review",
                status: "validated",
                detail: "Local AI reviewed the compact evidence packet.",
                input: "Evidence packet JSON",
                output: "Validated AnalysisResult"
              },
              {
                title: "Validator and repair",
                status: "ready",
                detail: "LLM output passed deterministic validation.",
                input: "LLM JSON + allowed_candidate_drivers + blocked_drivers",
                output: "validated"
              }
            ]
          },
          replay: {
            status: "stored",
            label: "Replay stored",
            detail: "Run 55 persisted to TimelineStore.",
            monitorRunId: 55,
            timelineStorePath: "user-data/market_agent_timeline.sqlite",
            stored: {
              marketPriceBars: 6,
              relatedAssetBars: 12,
              newsItems: 3,
              calendarEvents: 2,
              timelineEvents: 4,
              alerts: 1
            },
            jobs: [
              {
                title: "Replay query model",
                status: "ready",
                detail: "Day replay reads detailed rows; Month replay filters stored timeline events down to major XAUUSD turns.",
                input: "TimelineStore indexed range reads",
                output: "Dashboard replay, Evidence detail, Alerts history"
              }
            ],
            storageSummary: {
              path: "user-data/market_agent_timeline.sqlite",
              databaseBytes: 98304,
              counts: {
                monitorRuns: 55,
                marketPriceBars: 420,
                relatedAssetBars: 840,
                newsItems: 122,
                calendarEvents: 38
              },
              compaction: {
                status: "not_needed",
                mode: "indexed_range_reads"
              }
            }
          },
          alerts: {
            status: "suppressed",
            label: "No alert",
            detail: "No current live alert passed the gate.",
            preflightStatus: "approved",
            telegramStatus: "disabled",
            jobs: [
              {
                title: "Format alert message",
                status: "skipped",
                detail: "No candidate alert was produced.",
                input: "AnalysisResult + evidence chain",
                output: "No candidate alert"
              },
              {
                title: "Preflight evidence check",
                status: "approved",
                detail: "Freshness, market-closed state, format, and evidence were checked.",
                input: "Formatted message + provider health",
                output: "approved"
              },
              {
                title: "Telegram delivery",
                status: "disabled",
                detail: "Telegram is used only after all gates pass.",
                input: "Approved alert payload",
                output: "Dashboard only"
              }
            ]
          },
          summary: {
            dataStores: ["monitor_runs", "provider_health", "market_price_bars", "related_asset_bars", "news_items", "calendar_events", "evidence_packets", "analysis_results", "alerts", "timeline_events"]
          }
        }
      } as Parameters<typeof MarketAgentPage>[0]["monitorStatus"]
    });

    fireEvent.click(screen.getByRole("button", { name: /^Activity$/i }));
    const agentActivity = screen.getByLabelText(/Agent activity board/i);

    expect(within(agentActivity).getByText(/Signal Map/i)).toBeInTheDocument();
    expect(within(agentActivity).getByRole("button", { name: /Assets/i })).toBeInTheDocument();
    expect(within(agentActivity).getAllByRole("button", { name: /News/i }).length).toBeGreaterThan(0);
    expect(within(agentActivity).getByRole("button", { name: /Calendar/i })).toBeInTheDocument();
    expect(within(agentActivity).getByRole("button", { name: /AI Analysis/i })).toBeInTheDocument();
    expect(within(agentActivity).getAllByText(/Storage/i).length).toBeGreaterThan(0);
    expect(within(agentActivity).getByText(/Raw collected/i)).toBeInTheDocument();
    expect(within(agentActivity).getByText(/Processed \/ derived/i)).toBeInTheDocument();
    expect(within(agentActivity).getAllByText(/market_agent_timeline\.sqlite/i).length).toBeGreaterThan(0);
    expect(within(agentActivity).queryByRole("button", { name: /DXY|US2Y|WTI/i })).not.toBeInTheDocument();

    fireEvent.click(within(agentActivity).getByRole("button", { name: /Assets/i }));
    const assetsDetail = within(agentActivity).getByRole("dialog", { name: /Assets/i });
    expect(within(assetsDetail).getByText(/Where it comes from/i)).toBeInTheDocument();
    expect(within(assetsDetail).getByText(/What is happening now/i)).toBeInTheDocument();
    expect(within(assetsDetail).getByText(/AI involvement/i)).toBeInTheDocument();
    expect(within(assetsDetail).getAllByText(/^Storage$/i).length).toBeGreaterThan(0);
    expect(within(assetsDetail).getByText(/market_price_bars/i)).toBeInTheDocument();
    expect(within(assetsDetail).getByText(/related_asset_bars/i)).toBeInTheDocument();
    expect(within(assetsDetail).getByText(/provider mapping and allowlists/i)).toBeInTheDocument();
    expect(screen.queryByText(/Background activity/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/News feeds not configured|No news provider configured|disabled/i)).not.toBeInTheDocument();
  });

  it("shows a readable local CSV fallback warning", () => {
    render(
      <MarketAgentPage
        snapshot={{
          ...snapshot,
          state: {
            ...snapshot.state!,
            current_bias: "neutral",
            main_driver: "unknown",
            cause_status: "NO_MEANINGFUL_CHANGE",
            confidence: "low"
          }
        }}
        providerConfig={providerConfig}
        telegramConfig={telegramConfig}
        llmConfig={llmConfig}
        providerHealth={localCsvProviderHealth}
        driverAttention={{ ok: true, available: true, states: [] }}
        replay={replay}
        selectedEvidence={{ ok: true, available: false, message: "No run selected.", payload: {} }}
        monitorStatus={monitorStatus}
        selectedMonitorRunId={null}
        rangePreset="day"
        rangeStartInput=""
        rangeEndInput=""
        onPresetChange={() => {}}
        onRangeStartChange={() => {}}
        onRangeEndChange={() => {}}
        onApplyRange={() => {}}
        onSelectRun={() => {}}
        onSaveProviderConfig={() => {}}
        onClearProviderConfig={() => {}}
        onTestCTraderConnection={async () => ({ ok: true })}
        onResolveCTraderSymbol={async () => ({ ok: true })}
        onGetCTraderQuoteTest={async () => ({ ok: true })}
        onSaveTelegramConfig={async () => telegramConfig}
        onTestTelegramMessage={async () => ({ ok: true, status: "sent", message: "Telegram test message sent." })}
        onSaveLLMConfig={async () => llmConfig}
        onTestLLMConnection={async () => ({ ok: true, status: "available", message: "Local AI is available." })}
        onTestLLMJsonResponse={async () => ({ ok: true, status: "available", message: "Model returned valid JSON." })}
        onRunMonitorOnce={async () => monitorStatus}
        onRunBackfillRecovery={async () => ({ ...monitorStatus, phase: "recovery_completed", message: "Backfill recovery completed." })}
        onStartMonitorLoop={async () => ({ ...monitorStatus, running: true, phase: "running" })}
        onStopMonitorLoop={async () => monitorStatus}
      />
    );

    expect(screen.queryByText(/No meaningful XAUUSD move detected/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Using local CSV fallback\. Configure cTrader or Yahoo provider for live monitoring\./i)).not.toBeInTheDocument();
    expect(screen.getByText(/CURRENT PAUSED/i)).toBeInTheDocument();
    expect(screen.getAllByText(/No live price/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Waiting/i).length).toBeGreaterThan(0);
    expect(screen.queryByText("LOCAL_CSV_FALLBACK")).not.toBeInTheDocument();
  });

  it("pauses only current conclusions when XAUUSD is not live cTrader spot", () => {
    renderMarketAgentPage({
      providerHealth: localCsvProviderHealth,
      driverAttention,
      selectedEvidence: evidence
    });

    expect(screen.getAllByText(/No live price/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/CURRENT PAUSED/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Fed headline/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Context/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/US10Y fresh and supporting the move/i)).toBeInTheDocument();
    expect(screen.queryByText(/No accepted evidence yet/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Driver Attention$/i }));
    expect(screen.getByText(/Driver scores hidden/i)).toBeInTheDocument();
    expect(screen.getByText(/Required price inputs/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Live XAUUSD Spot/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Context still watched/i)).toBeInTheDocument();
    expect(screen.getAllByText(/US10Y fresh and confirming/i).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: /^Evidence$/i }));
    expect(screen.getByText(/No current conclusion/i)).toBeInTheDocument();
    expect(screen.queryByText(/Accepted Driver/i)).not.toBeInTheDocument();
  });

  it("keeps news and calendar visible when XAUUSD spot is market closed", () => {
    const closedProviderHealth: MarketAgentProviderHealthResponse = {
      ok: true,
      available: true,
      monitor_run_id: 25,
      items: [
        {
          provider_key: "xauusd",
          source: "cTrader",
          source_type: "spot",
          data_mode: "stale",
          is_available: true,
          is_stale: true,
          stale_reason: "Market is closed.",
          current_value: 4504.8,
          data_timestamp: "2026-05-19T07:15:00+08:00",
          fetched_at: "2026-05-19T07:16:00+08:00"
        },
        {
          provider_key: "news",
          source: "News",
          source_type: "news",
          data_mode: "live_seen",
          is_available: true,
          is_stale: false,
          data_timestamp: freshProviderTimestamp(),
          fetched_at: freshProviderTimestamp()
        },
        {
          provider_key: "calendar",
          source: "Calendar",
          source_type: "calendar",
          data_mode: "live_seen",
          is_available: true,
          is_stale: false,
          data_timestamp: freshProviderTimestamp(),
          fetched_at: freshProviderTimestamp()
        }
      ]
    };

    renderMarketAgentPage({
      providerHealth: closedProviderHealth,
      selectedEvidence: {
        ...evidence,
        payload: {
          ...evidence.payload,
          evidence_packet: {
            ...evidence.payload.evidence_packet,
            evidence_chain_status: {
              status: "context_only",
              can_show_current_conclusion: false,
              reason: "Market is closed. The last spot price can be shown, but current driver conclusions are paused.",
              missing_required: ["live_xauusd_spot", "xauusd_recent_history"],
              usable_inputs: ["news_context", "calendar_context"],
              context_only_inputs: ["market_closed_last_xauusd_spot"]
            }
          }
        }
      }
    });

    expect(screen.getAllByText(/Market closed/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Current driver ranking paused/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Fed headline/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/US session opens/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Evidence Status:/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Context only/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/No accepted evidence yet/i)).not.toBeInTheDocument();
  });

  it("uses backend evidence chain readiness instead of live price alone", () => {
    const incompleteEvidence: MarketAgentEvidenceForRunResponse = {
      ...evidence,
      payload: {
        ...evidence.payload,
        evidence_packet: {
          ...evidence.payload.evidence_packet,
          evidence_chain_status: {
            status: "context_only",
            can_show_current_conclusion: false,
            reason: "Current conclusion is paused until live XAUUSD price and recent price history are available.",
            missing_required: ["xauusd_recent_history"],
            usable_inputs: ["live_xauusd_spot", "news_context"],
            context_only_inputs: ["llm_unavailable"],
            llm_status: "unavailable"
          }
        }
      }
    };

    renderMarketAgentPage({
      providerHealth,
      driverAttention,
      selectedEvidence: incompleteEvidence
    });

    expect(screen.getByText(/CURRENT PAUSED/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Current conclusion is paused until live XAUUSD price and recent price history are available/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Current Paused/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/US10Y fresh and supporting the move/i)).toBeInTheDocument();
  });

  it("shows useful empty states when sqlite-backed data is unavailable", () => {
    render(
      <MarketAgentPage
        snapshot={{ ok: true, available: false, message: "SQLite missing.", state: null, alerts: [] }}
        providerConfig={{ ok: true, available: false, message: "Provider config unavailable.", ctrader: null }}
        telegramConfig={{ ok: true, available: false, message: "Telegram config unavailable.", telegram: null }}
        llmConfig={{ ok: true, available: false, message: "LLM config unavailable.", llm: null }}
        providerHealth={{ ok: true, available: false, message: "Provider health unavailable.", items: [] }}
        driverAttention={{ ok: true, available: false, message: "Driver attention unavailable.", states: [] }}
        replay={{
          ok: true,
          available: false,
          message: "Replay unavailable.",
          replay: {
            price_series: [],
            related_assets: {},
            news_items: [],
            calendar_events: [],
            driver_attention_timeline: [],
            timeline_events: [],
            state_transitions: [],
            alerts: [],
            suppressed_alerts: []
          }
        }}
        selectedEvidence={{ ok: true, available: false, message: "Evidence unavailable.", payload: {} }}
        monitorStatus={monitorStatus}
        selectedMonitorRunId={null}
        rangePreset="day"
        rangeStartInput=""
        rangeEndInput=""
        onPresetChange={() => {}}
        onRangeStartChange={() => {}}
        onRangeEndChange={() => {}}
        onApplyRange={() => {}}
        onSelectRun={() => {}}
        onSaveProviderConfig={() => {}}
        onClearProviderConfig={() => {}}
        onTestCTraderConnection={async () => ({ ok: true })}
        onResolveCTraderSymbol={async () => ({ ok: true })}
        onGetCTraderQuoteTest={async () => ({ ok: true })}
        onSaveTelegramConfig={async () => telegramConfig}
        onTestTelegramMessage={async () => ({ ok: false, status: "failed", error: "telegram unavailable" })}
        onSaveLLMConfig={async () => llmConfig}
        onTestLLMConnection={async () => ({ ok: false, status: "unavailable", error: "Local AI unavailable" })}
        onTestLLMJsonResponse={async () => ({ ok: false, status: "invalid_json", error: "invalid json" })}
        onRunMonitorOnce={async () => monitorStatus}
        onRunBackfillRecovery={async () => ({ ...monitorStatus, phase: "recovery_failed", lastError: "recovery unavailable" })}
        onStartMonitorLoop={async () => ({ ...monitorStatus, running: true, phase: "running" })}
        onStopMonitorLoop={async () => monitorStatus}
      />
    );

    expect(screen.getAllByText(/No live price/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Waiting/i).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /^Data Sources$/i }));
    expect(screen.getByText(/Provider config unavailable\./i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Provider Health$/i }));
    expect(screen.getByText(/Provider health unavailable\./i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Replay \/ Timeline/i }));
    expect(screen.getByText(/Replay unavailable\./i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Evidence$/i }));
    expect(screen.getByText(/Evidence unavailable\./i)).toBeInTheDocument();
  });
});

