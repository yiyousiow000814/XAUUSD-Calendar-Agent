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
      source: "Yahoo Finance",
      source_type: "futures_proxy",
      data_mode: "proxy",
      is_available: true,
      is_stale: false,
      data_timestamp: "2026-05-19T08:00:00+08:00",
      fetched_at: "2026-05-19T08:05:00+08:00"
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
    endpoint: "http://localhost:11434",
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
    endpoint: "http://localhost:11434",
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
        symbol: "GC=F",
        data_timestamp: "2026-05-19T07:45:00+08:00",
        close_price: 4520.2,
        bid_price: 4519.92,
        ask_price: 4520.48,
        source_type: "futures_proxy",
        data_mode: "proxy"
      },
      {
        symbol: "GC=F",
        data_timestamp: "2026-05-19T08:00:00+08:00",
        close_price: 4504.8,
        bid_price: 4504.52,
        ask_price: 4505.08,
        source_type: "futures_proxy",
        data_mode: "proxy"
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
    alerts: [{ monitor_run_id: 23, run_started_at: "2026-05-19T08:05:00+08:00", should_notify: true, notification_level: "level_3", message: "XAUUSD dropped 0.48%", semantic_type: "breakout", impact_percent: -0.48 }],
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
      evidence_status: { dxy: "confirming", us10y: "confirming", us2y: "unavailable" }
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
      onTestLLMConnection={async () => ({ ok: true, status: "available", message: "Ollama is available." })}
      onTestLLMJsonResponse={async () => ({ ok: true, status: "available", message: "Model returned valid JSON." })}
      localAiSetup={localAiSetup}
      localAiPullProgress={null}
      onDetectLocalAI={async () => localAiSetup}
      onInstallRecommendedModel={async () => ({ ok: true, status: "model_ready", message: "Model ready." })}
      onCancelModelDownload={async () => ({ ok: true, status: "cancelled" })}
      onBenchmarkLLM={async () => ({ ok: true, status: "model_ready", elapsedMs: 900, message: "Benchmark passed." })}
      onApplyLLMFallbackPolicy={async () => ({ ok: true, status: "model_ready", model: "qwen3.5:4b" })}
      onStartCTraderConnect={async () => ({ ok: true, status: "connected", message: "cTrader CLI credentials saved and checked.", ctrader: providerConfig.ctrader })}
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
        onTestLLMConnection={async () => ({ ok: true, status: "available", message: "Ollama is available." })}
        onTestLLMJsonResponse={async () => ({ ok: true, status: "available", message: "Model returned valid JSON." })}
        localAiSetup={localAiSetup}
        localAiPullProgress={null}
        onDetectLocalAI={async () => localAiSetup}
        onInstallRecommendedModel={async () => ({ ok: true, status: "model_ready", message: "Model ready." })}
        onCancelModelDownload={async () => ({ ok: true, status: "cancelled" })}
        onBenchmarkLLM={async () => ({ ok: true, status: "model_ready", elapsedMs: 900, message: "Benchmark passed." })}
        onApplyLLMFallbackPolicy={async () => ({ ok: true, status: "model_ready", model: "qwen3.5:4b" })}
        onStartCTraderConnect={async () => ({ ok: true, status: "connected", message: "cTrader CLI credentials saved and checked.", ctrader: providerConfig.ctrader })}
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
    expect(navIconNames).toEqual(["dashboard", "drivers", "replay", "evidence", "providers", "sources", "alerts", "settings"]);
    expect(new Set(navIconNames).size).toBe(navIconNames.length);
    const settingsIcon = marketAgentNav.querySelector("[data-market-agent-section='logs'] svg");
    expect(settingsIcon?.getAttribute("data-nav-icon")).toBe("settings");
    expect(settingsIcon?.innerHTML).not.toContain("M12 3.8v2.1");
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
    expect(screen.getByText(/Evidence Quality:/i).textContent).toContain("Contrary (0%)");
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
    const circumference = 2 * Math.PI * 34;
    expect(scoreRing).toHaveAttribute("data-score-target", "80");
    expect(Number(progress?.getAttribute("stroke-dasharray"))).toBeCloseTo(circumference, 6);
    expect(Number(progress?.getAttribute("stroke-dashoffset"))).toBeCloseTo(circumference * 0.2, 6);
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
        onTestLLMConnection={async () => ({ ok: true, status: "available", message: "Ollama is available." })}
        onTestLLMJsonResponse={async () => ({ ok: true, status: "available", message: "Model returned valid JSON." })}
        localAiSetup={localAiSetup}
        localAiPullProgress={null}
        onDetectLocalAI={async () => localAiSetup}
        onInstallRecommendedModel={async () => ({ ok: true, status: "model_ready", message: "Model ready." })}
        onCancelModelDownload={async () => ({ ok: true, status: "cancelled" })}
        onBenchmarkLLM={async () => ({ ok: true, status: "model_ready", elapsedMs: 900, message: "Benchmark passed." })}
        onApplyLLMFallbackPolicy={async () => ({ ok: true, status: "model_ready", model: "qwen3.5:4b" })}
        onStartCTraderConnect={async () => ({ ok: true, status: "connected", message: "cTrader CLI credentials saved and checked.", ctrader: providerConfig.ctrader })}
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
        onTestLLMConnection={async () => ({ ok: true, status: "available", message: "Ollama is available." })}
        onTestLLMJsonResponse={async () => ({ ok: true, status: "available", message: "Model returned valid JSON." })}
        onRunMonitorOnce={async () => monitorStatus}
        onRunBackfillRecovery={async () => ({ ...monitorStatus, phase: "recovery_completed", message: "Backfill recovery completed." })}
        onStartMonitorLoop={async () => ({ ...monitorStatus, running: true, phase: "running" })}
        onStopMonitorLoop={async () => monitorStatus}
      />
    );

    fireEvent.click(screen.getByRole("navigation", { name: /Market Agent sections/i }).querySelectorAll("button")[5]);
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
    expect(alertsButton.querySelector(".market-agent-nav-badge")).toHaveTextContent("2");
    fireEvent.click(alertsButton);
    expect(screen.getByRole("heading", { name: /^Alerts$/i })).toBeInTheDocument();
    expect(container.querySelectorAll(".market-agent-alert-card").length).toBeGreaterThan(0);
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
  });

  it("defaults Data Sources to Connect cTrader and Auto Local AI instead of raw setup forms", () => {
    renderMarketAgentPage();

    fireEvent.click(screen.getByRole("button", { name: /^Data Sources$/i }));

    expect(screen.queryByText(/^Next step$/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /^cTrader connection needed$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Open cTrader setup$/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^cTrader$/i }));
    expect(screen.getByRole("heading", { name: /^Connect cTrader$/i })).toBeInTheDocument();
    expect(screen.getByText(/Market symbols are handled automatically/i)).toBeInTheDocument();
    expect(screen.getByText(/Password is stored locally and masked after save/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Connect cTrader$/i })).toBeInTheDocument();
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
    const noOllamaSetup: MarketAgentLLMSetupResponse = {
      ...localAiSetup,
      ok: false,
      available: true,
      status: "ollama_not_installed",
      message: "Ollama is not installed.",
      ollama: {
        installed: false,
        running: false,
        endpointReachable: false,
        endpoint: "http://localhost:11434",
        installerUrl: "https://ollama.com/download"
      }
    };

    renderMarketAgentPage({ localAiSetup: noOllamaSetup });
    fireEvent.click(screen.getByRole("button", { name: /^Data Sources$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Local AI$/i }));

    expect(screen.getByText(/Ollama not installed/i)).toBeInTheDocument();
    expect(screen.getByText(/https:\/\/ollama\.com\/download/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Download recommended/i })).toBeDisabled();
  });

  it("renders Ollama pull progress bytes and percent while downloading", () => {
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
    expect(screen.getByRole("button", { name: /Downloading Qwen3\.5 4B/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Cancel download/i })).toBeInTheDocument();
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
      status: "connected",
      message: "cTrader CLI credentials saved and checked.",
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
      fireEvent.click(screen.getByRole("button", { name: /^Connect cTrader$/i }));
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
      fireEvent.click(screen.getByRole("button", { name: /Save Telegram alerts/i }));
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
        onTestLLMConnection={async () => ({ ok: true, status: "available", message: "Ollama is available." })}
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
    expect(screen.getAllByText(/Backup/i).length).toBeGreaterThan(0);
    expect(screen.queryByText("futures_proxy")).not.toBeInTheDocument();
    expect(screen.queryByText("core_structural")).not.toBeInTheDocument();
    expect(screen.queryByText("main_driver usd -> yields")).not.toBeInTheDocument();
    expect(screen.queryByText(/Using Yahoo GC=F futures proxy, not true spot XAUUSD\./i)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /XAUUSD \(Spot\)/i })).toBeInTheDocument();
    expect(screen.getByText(/Backup price/i)).toBeInTheDocument();
    expect(screen.getAllByText(/80%/i).length).toBeGreaterThan(0);
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
    expect(screen.getByText(/Market symbols are handled automatically/i)).toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: /Send Test Message/i })).toBeInTheDocument();

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
        onTestLLMConnection={async () => ({ ok: true, status: "available", message: "Ollama is available." })}
        onTestLLMJsonResponse={async () => ({ ok: true, status: "available", message: "Model returned valid JSON." })}
        onRunMonitorOnce={async () => monitorStatus}
        onRunBackfillRecovery={async () => ({ ...monitorStatus, phase: "recovery_completed", message: "Backfill recovery completed." })}
        onStartMonitorLoop={async () => ({ ...monitorStatus, running: true, phase: "running" })}
        onStopMonitorLoop={async () => monitorStatus}
      />
    );

    expect(screen.queryByText(/No meaningful XAUUSD move detected/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Using local CSV fallback\. Configure cTrader or Yahoo provider for live monitoring\./i)).not.toBeInTheDocument();
    expect(screen.getAllByText(/Neutral/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Local CSV fallback/i).length).toBeGreaterThan(0);
    expect(screen.queryByText("LOCAL_CSV_FALLBACK")).not.toBeInTheDocument();
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
        onTestLLMConnection={async () => ({ ok: false, status: "unavailable", error: "ollama unavailable" })}
        onTestLLMJsonResponse={async () => ({ ok: false, status: "invalid_json", error: "invalid json" })}
        onRunMonitorOnce={async () => monitorStatus}
        onRunBackfillRecovery={async () => ({ ...monitorStatus, phase: "recovery_failed", lastError: "recovery unavailable" })}
        onStartMonitorLoop={async () => ({ ...monitorStatus, running: true, phase: "running" })}
        onStopMonitorLoop={async () => monitorStatus}
      />
    );

    expect(screen.getAllByText(/No price/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/No replay events in this window\./i)).toBeInTheDocument();
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

