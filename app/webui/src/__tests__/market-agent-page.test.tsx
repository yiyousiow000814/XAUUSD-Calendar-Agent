import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MarketAgentPage } from "../components/MarketAgentPage";
import { backend } from "../api";
import type {
  MarketAgentDriverAttentionResponse,
  MarketAgentEvidenceForRunResponse,
  MarketAgentLiveQuoteResponse,
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

const marketAgentPageCss = () =>
  readFileSync(join(process.cwd(), "src/components/MarketAgentPage.css"), "utf8");
const marketAgentReplayCss = () =>
  readFileSync(join(process.cwd(), "src/components/MarketAgentReplay.css"), "utf8");

const freshProviderTimestamp = () => new Date(Date.now() - 30_000).toISOString();

const formatExpectedMarketAgentDateTime = (value: string) => {
  const date = new Date(value);
  const pad2 = (part: number) => String(part).padStart(2, "0");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${pad2(date.getDate())} ${months[date.getMonth()]} ${date.getFullYear()} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
};

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
    snapshotPath: "user-data/ctrader-live-quote.json",
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
    temperature: 0,
    timeoutSeconds: 60,
    keepAlive: "5m",
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
    calendar_events: [{ title: "US session opens", scheduled_at: "2026-05-19T08:15:00+08:00", source: "Economic Calendar", data_mode: "live_seen", semantic_type: "session", impact_percent: -0.08 }],
    driver_attention_timeline: [],
    timeline_events: [
      { monitor_run_id: 23, event_time: "2026-05-19T08:05:00+08:00", event_type: "market_alert", label: "Yields pressure", payload: { semantic_type: "breakout", impact_percent: -0.48, main_driver: "yields" } },
      { monitor_run_id: 22, event_time: "2026-05-19T07:58:00+08:00", event_type: "analysis", label: "Reversal attempt rejected", payload: { semantic_type: "reversal", impact_percent: 0.24, main_driver: "technical_liquidation" } },
      { monitor_run_id: 21, event_time: "2026-05-19T07:56:00+08:00", event_type: "analysis", label: "Range held near session low", payload: { semantic_type: "range", impact_percent: 0.05, main_driver: "unknown" } }
    ],
    state_transitions: [{ monitor_run_id: 23, run_started_at: "2026-05-19T08:05:00+08:00", state_change_reason: "main_driver usd -> yields" }],
    alerts: [{ monitor_run_id: 23, run_started_at: "2026-05-19T08:05:00+08:00", should_notify: true, notification_level: "level_3", message: "XAUUSD dropped 0.48%", main_driver: "yields", semantic_type: "breakout", impact_percent: -0.48, quiet_repeat_count: 2 }],
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
      },
      market_read: {
        status: "current_read",
        headline: "Rates/yields leads the gold read",
        thesis: "Gold remains under pressure from rising yields and a firmer dollar.",
        driver: "yields",
        coverage: {
          live_price: "fresh",
          recent_history: "ready",
          sensors: "8 of 8 usable",
          news: "1 reviewed",
          calendar: "1 reviewed",
          ai: "validated"
        },
        evidence: {
          latest_news: ["Fed headline"],
          calendar: ["US session opens"]
        },
        continuity: "The rates/yields story is continuing from the previous stored read.",
        watch_next: ["DXY/yields confirmation"],
        analyst_read: {
          schema: "market_read.v1",
          conclusion_type: "market_observation",
          now: "Gold remains under pressure from rising yields while the dollar stays firm.",
          past: ["08:00 Fed headline lifted yields"],
          next: ["Confirm: DXY/yields confirmation", "Calendar: US session opens"],
          risks: ["US2Y is unavailable; confidence stays limited"],
          trade_call_ready: false,
          trade_call_blocker: "Cross-market confirmation is incomplete."
        }
      }
    },
    analysis_result: {
      main_driver: "yields",
      cause_status: "likely",
      rejected_driver: "fed_rates",
      rejection_reason: "blocked driver"
    },
    analysis_history: [
      {
        monitor_run_id: 23,
        run_started_at: "2026-05-19T08:03:00+08:00",
        analysis_engine: "llm_validated",
        llm_status: "validated",
        main_driver: "yields",
        cause_status: "likely",
        confidence: "medium_high",
        summary: "Stored Local AI validated yields as the main XAUUSD driver."
      },
      {
        monitor_run_id: 22,
        run_started_at: "2026-05-19T07:45:00+08:00",
        analysis_engine: "llm_validated",
        llm_status: "validated",
        main_driver: "usd",
        cause_status: "possible",
        confidence: "medium",
        summary: "Stored Local AI validated USD pressure as the main XAUUSD driver."
      }
    ],
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
      onStartCTraderConnect={async () => ({ ok: true, status: "waiting_for_live_connector", message: "cTrader account is connected. Live streaming is waiting for the long-running connector snapshot; cTrader CLI cBot streaming is disabled to avoid external algo host windows.", ctrader: providerConfig.ctrader })}
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
    const runningMonitorStatus = { ...monitorStatus, running: true, phase: "running" };
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
        monitorStatus={runningMonitorStatus}
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
        onStartCTraderConnect={async () => ({ ok: true, status: "waiting_for_live_connector", message: "cTrader account is connected. Live streaming is waiting for the long-running connector snapshot; cTrader CLI cBot streaming is disabled to avoid external algo host windows.", ctrader: providerConfig.ctrader })}
        onTestCTraderBackfill={async () => ({ ok: true, message: "M1 backfill is available." })}
        onRunMonitorOnce={async () => runningMonitorStatus}
        onRunBackfillRecovery={async () => ({ ...runningMonitorStatus, phase: "recovery_completed", message: "Backfill recovery completed." })}
        onStartMonitorLoop={async () => runningMonitorStatus}
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
    expect(container.querySelectorAll(".market-agent-value-pulse").length).toBeGreaterThanOrEqual(4);
    expect(container.querySelector(".market-agent-score-ring")).toBeInTheDocument();
    expect(container.querySelector(".market-agent-score-ring.market-agent-score-ring-animated")).not.toBeInTheDocument();
    expect(container.querySelector(".market-agent-score-ring svg.market-agent-score-svg")).toBeInTheDocument();
    expect(container.querySelector(".market-agent-score-progress")).toBeInTheDocument();
    expect(container.querySelector(".market-agent-clock-icon.market-agent-clock-icon-animated")).toBeInTheDocument();
    expect(container.querySelectorAll(".market-agent-animated-row").length).toBeGreaterThanOrEqual(6);
    expect(screen.queryByText(/Analyst read/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Analyst market read/i)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Macro \/ Micro Watch/i })).toBeInTheDocument();
    const driverPanel = screen.getByRole("heading", { name: /Macro \/ Micro Watch/i }).closest("section");
    expect(driverPanel?.querySelectorAll(".market-agent-attention-table-row")).toHaveLength(0);
    expect(driverPanel?.querySelectorAll(".market-agent-mm-row")).toHaveLength(0);
    expect(within(driverPanel as HTMLElement).getAllByText(/Rates/i).length).toBeGreaterThan(0);
    expect(within(driverPanel as HTMLElement).queryByRole("heading", { name: /Macro drivers/i })).not.toBeInTheDocument();
    expect(within(driverPanel as HTMLElement).queryByRole("heading", { name: /Micro themes/i })).not.toBeInTheDocument();
    expect(within(driverPanel as HTMLElement).queryByText(/Current driver ranking paused/i)).not.toBeInTheDocument();
    expect(within(driverPanel as HTMLElement).queryByText(/^Blocked$/i)).not.toBeInTheDocument();
    expect(within(driverPanel as HTMLElement).queryByText(/^Watching$/i)).not.toBeInTheDocument();
    expect(within(driverPanel as HTMLElement).queryByText(/^Allowed$/i)).not.toBeInTheDocument();
    expect(within(driverPanel as HTMLElement).queryByText(/No detail recorded/i)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Market Replay \(Day\)/i })).toBeInTheDocument();
    expect(Array.from(container.querySelectorAll(".market-agent-timeline-node")).every((node) => node.textContent === "")).toBe(true);
    expect(screen.getByRole("heading", { name: /Latest Evidence/i })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Provider Health$/i }).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /View Full Timeline/i })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^View All$/i }).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/BREAKOUT/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/NEWS/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/REVERSAL/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/RANGE/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/SESSION/i)).not.toBeInTheDocument();
    expect(screen.getAllByText(/Impact:/i).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /^Data Sources$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Activity$/i })).toBeInTheDocument();
    expect(screen.queryByText(/Quick Actions/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Configure Data Sources/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /Market Situation/i })).not.toBeInTheDocument();

    expect(screen.queryByRole("heading", { name: /^Data Sources$/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Access Token/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Raw details/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Price series/i)).not.toBeInTheDocument();
    expect(screen.queryByText("futures_proxy")).not.toBeInTheDocument();
    expect(screen.queryByText("core_structural")).not.toBeInTheDocument();
    expect(screen.queryByText(/No reliable free US2Y source is configured\./i)).not.toBeInTheDocument();
  });

  it("opens dashboard replay detail before navigating to an evidence run", async () => {
    const selectedRuns: number[] = [];
    const { container } = renderMarketAgentPage({ onSelectRun: (id) => selectedRuns.push(id) });

    const firstReplayRow = container.querySelector(".market-agent-timeline-track-row");
    expect(firstReplayRow).not.toBeNull();

    fireEvent.click(firstReplayRow as HTMLElement);

    expect(selectedRuns).toEqual([]);
    const dialog = await screen.findByRole("dialog", { name: /Market item detail/i });
    expect(dialog.textContent).toContain((firstReplayRow as HTMLElement).querySelector("strong")?.textContent ?? "");

    fireEvent.click(within(dialog).getByRole("button", { name: /Open evidence run/i }));
    expect(selectedRuns.length).toBe(1);
  });

  it("opens original replay news through the desktop backend", async () => {
    const openUrl = vi.spyOn(backend, "openUrl").mockResolvedValue({ ok: true });
    const replayWithNewsUrl: MarketAgentReplayResponse = {
      ...replay,
      replay: {
        ...replay.replay,
        timeline_events: [],
        alerts: [],
        news_items: [
          {
            title: "Fed headline with source link",
            published_at: "2026-05-19T08:03:00+08:00",
            source: "Reuters",
            data_mode: "live_seen",
            semantic_type: "news",
            included: true,
            link: "https://example.test/fed-headline"
          }
        ]
      }
    };
    renderMarketAgentPage({ replay: replayWithNewsUrl });

    fireEvent.click(screen.getByRole("button", { name: /Replay \/ Timeline/i }));
    fireEvent.click(await screen.findByText(/Fed headline with source link/i));
    const dialog = await screen.findByRole("dialog", { name: /Replay item detail/i });
    fireEvent.click(within(dialog).getByRole("button", { name: /Open original/i }));

    await waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://example.test/fed-headline"));
  });

  it("keeps the Evidence page focused on the evidence panel without a situation briefing", () => {
    const marketBrainProviderHealth: MarketAgentProviderHealthResponse = {
      ok: true,
      available: true,
      monitor_run_id: 422,
      run_started_at: "2026-06-08T00:36:34+08:00",
      items: [
        {
          provider_key: "xauusd",
          source: "cTrader",
          source_type: "spot",
          data_mode: "stale",
          is_available: true,
          is_stale: true,
          current_value: 3310.22,
          data_timestamp: "2026-06-07T16:20:33+00:00",
          fetched_at: "2026-06-08T00:36:30+08:00",
          stale_reason: "Market is closed. Fresh XAUUSD history is required before current conclusions can resume."
        },
        {
          provider_key: "news",
          source: "News",
          source_type: "rss",
          data_mode: "live_seen",
          is_available: true,
          is_stale: false,
          data_timestamp: "2026-06-07T22:18:00+08:00",
          fetched_at: "2026-06-08T00:36:30+08:00"
        },
        {
          provider_key: "calendar",
          source: "Economic Calendar",
          source_type: "local_csv_fallback",
          data_mode: "dataset_gap",
          is_available: false,
          is_stale: true,
          data_timestamp: "2026-04-30T23:59:00+08:00",
          fetched_at: "2026-06-08T00:36:30+08:00",
          stale_reason: "Economic Calendar dataset ends at 30-04-2026; current run is 08-06-2026."
        },
        {
          provider_key: "dxy",
          source: "DXY",
          source_type: "proxy",
          data_mode: "stale",
          is_available: true,
          is_stale: true,
          stale_reason: "DXY snapshot is stale."
        },
        {
          provider_key: "us10y",
          source: "US10Y",
          source_type: "proxy",
          data_mode: "stale",
          is_available: true,
          is_stale: true,
          stale_reason: "US10Y snapshot is stale."
        }
      ]
    };
    const marketBrainReplay: MarketAgentReplayResponse = {
      ...replay,
      start: "2026-06-05T00:00:00+08:00",
      end: "2026-06-08T00:36:34+08:00",
      replay: {
        ...replay.replay,
        price_series: [],
        news_items: [
          { title: "Fed officials keep rates in focus", published_at: "2026-06-05T18:55:00+08:00", source: "CNBC", summary_source: "local_ai", summary: "Fed rate path remains the main macro theme." },
          { title: "Oil jumps after supply concern", published_at: "2026-06-06T21:35:00+08:00", source: "MarketWatch", summary: "Oil is watched but asset confirmation is stale." },
          { title: "Dollar steady before US data", published_at: "2026-06-07T00:38:00+08:00", source: "CNBC" },
          { title: "Fed balance-sheet comments land", published_at: "2026-06-07T22:18:00+08:00", source: "Federal Reserve" }
        ],
        calendar_events: [],
        related_assets: {
          dxy: [{ symbol: "dxy", data_timestamp: "2026-06-07T14:00:00+08:00", data_mode: "stale", is_stale: true }],
          us10y: [{ symbol: "us10y", data_timestamp: "2026-06-07T14:00:00+08:00", data_mode: "stale", is_stale: true }],
          wti: [{ symbol: "wti", data_timestamp: "2026-06-07T14:00:00+08:00", data_mode: "stale", is_stale: true }]
        },
        timeline_events: [],
        alerts: []
      }
    };
    const marketBrainEvidence: MarketAgentEvidenceForRunResponse = {
      ...evidence,
      monitor_run_id: 422,
      payload: {
        ...evidence.payload,
        evidence_packet: {
          ...evidence.payload.evidence_packet,
          data_mode: "stale",
          market_move: { symbol: "XAUUSD", move_percent: 0, window_minutes: 15 },
          allowed_candidate_drivers: ["fed_rates"],
          blocked_drivers: {
            usd: "DXY is stale, so USD cannot confirm the current move.",
            yields: "US10Y is stale and US2Y is unavailable.",
            oil_inflation: "Oil headline is present but oil confirmation is stale.",
            geopolitics: "Headline is present but no cross-asset confirmation passed."
          },
          evidence_chain_status: {
            status: "context_only",
            can_show_current_conclusion: false,
            reason: "XAUUSD market is closed; news, calendar, and cross-market context keep updating, and the next trade read resumes when fresh XAUUSD price action returns.",
            missing_required: ["live_xauusd_spot", "xauusd_recent_history"],
            usable_inputs: ["news_context"],
            context_only_inputs: ["calendar_dataset_gap", "stale_cross_assets"],
            llm_status: "validated"
          },
          dynamic_themes: [
            {
              driver_id: "theme:fed",
              label: "Fed theme",
              current_state: "emerging",
              relevance_score: 0.52,
              related_news_count: 4,
              source_count: 3,
              current_evidence_summary: "4 headline(s) from 3 source(s); no cross-asset confirmation yet.",
              requested_sensor_ids: ["us2y", "us10y", "dxy"]
            },
            {
              driver_id: "theme:oil",
              label: "Oil theme",
              current_state: "emerging",
              relevance_score: 0.5,
              related_news_count: 2,
              source_count: 2,
              current_counter_evidence: "WTI confirmation is stale."
            }
          ],
          driver_attention_summary: {
            active_driver_count: 0,
            emerging_driver_count: 3,
            top_driver: "theme:fed"
          },
          news: [
            { timestamp_myt: "2026-06-05T18:55:00+08:00", title: "Fed officials keep rates in focus", source: "CNBC" },
            { timestamp_myt: "2026-06-06T21:35:00+08:00", title: "Oil jumps after supply concern", source: "MarketWatch" },
            { timestamp_myt: "2026-06-07T00:38:00+08:00", title: "Dollar steady before US data", source: "CNBC" },
            { timestamp_myt: "2026-06-07T22:18:00+08:00", title: "Fed balance-sheet comments land", source: "Federal Reserve" }
          ],
          calendar_events: []
        },
        analysis_result: {
          analysis_engine: "llm_validated",
          llm_status: "validated",
          main_driver: "unknown",
          cause_status: "unconfirmed",
          summary: "XAUUSD market is closed; news, calendar, and cross-market context keep updating, and the next trade read resumes when fresh XAUUSD price action returns."
        },
        monitor_run: {
          run_started_at: "2026-06-08T00:36:34+08:00",
          data_mode: "stale"
        }
      }
    };
    const marketBrainDriverAttention: MarketAgentDriverAttentionResponse = {
      ...driverAttention,
      monitor_run_id: 422,
      run_started_at: "2026-06-08T00:36:34+08:00",
      states: [
        {
          driver_id: "fed_rates",
          label: "Fed / rates",
          current_state: "emerging",
          priority: "core_structural",
          relevance_score: 0.45,
          confidence: "medium",
          related_news_count: 4,
          related_calendar_events: 0,
          activation_reason: "Fed headlines are present, but calendar confirmation is missing.",
          data_mode: "backfilled"
        },
        {
          driver_id: "theme:fed",
          label: "Fed theme",
          current_state: "emerging",
          priority: "micro_theme",
          relevance_score: 0.52,
          confidence: "medium",
          related_news_count: 4,
          source_count: 3,
          current_evidence_summary: "4 headline(s) from 3 source(s); no cross-asset confirmation yet.",
          data_mode: "backfilled"
        },
        {
          driver_id: "theme:oil",
          label: "Oil theme",
          current_state: "emerging",
          priority: "micro_theme",
          relevance_score: 0.5,
          confidence: "medium",
          related_news_count: 2,
          source_count: 2,
          current_counter_evidence: "WTI confirmation is stale.",
          data_mode: "backfilled"
        }
      ]
    };

    renderMarketAgentPage({
      activeSection: "evidence",
      providerHealth: marketBrainProviderHealth,
      replay: marketBrainReplay,
      selectedEvidence: marketBrainEvidence,
      driverAttention: marketBrainDriverAttention
    });

    expect(screen.queryByRole("region", { name: /Market Situation/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/Situation briefing/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/AI input coverage/i)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^Evidence Panel$/i })).toBeInTheDocument();
    expect(screen.getByText(/Market read forming/i)).toBeInTheDocument();
    expect(screen.getByText(/Waiting for price history/i)).toBeInTheDocument();
    expect(screen.getByText(/Market is closed; news and calendar continue/i)).toBeInTheDocument();
    expect(screen.queryByText(/^Allowed$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Blocked$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/No detail recorded/i)).not.toBeInTheDocument();
  });

  it("does not bounce back to Dashboard when a controlled section changes", async () => {
    const onSectionChange = vi.fn();
    renderMarketAgentPage({
      activeSection: "live",
      onSectionChange
    });

    fireEvent.click(screen.getByRole("button", { name: /^Evidence$/i }));

    await waitFor(() => {
      expect(onSectionChange).toHaveBeenCalledWith("evidence");
    });
    expect(onSectionChange).not.toHaveBeenCalledWith("live");
  });

  it("shows the current XAUUSD price from provider health instead of stale replay price", () => {
    const liveProviderHealth: MarketAgentProviderHealthResponse = {
      ...providerHealth,
      items: providerHealth.items.map((item) =>
        item.provider_key === "xauusd"
          ? {
              ...item,
              current_value: 4568.9,
              previous_value: 4567.4,
              change_value: 1.5,
              change_unit: "price",
              data_timestamp: freshProviderTimestamp(),
              fetched_at: freshProviderTimestamp()
            }
          : item
      )
    };
    const staleReplay: MarketAgentReplayResponse = {
      ...replay,
      replay: {
        ...replay.replay,
        price_series: [
          {
            timestamp: "2026-05-19T08:00:00+08:00",
            close_price: 4479,
            change_value: 0,
            change_pct: 0
          } as unknown as MarketAgentReplayResponse["replay"]["price_series"][number]
        ]
      }
    };

    renderMarketAgentPage({ providerHealth: liveProviderHealth, replay: staleReplay });

    const priceCard = screen.getByRole("heading", { name: /XAUUSD \(Spot\)/i }).closest("article") as HTMLElement;
    expect(within(priceCard).getByText("4,568.90")).toBeInTheDocument();
    expect(within(priceCard).queryByText("4,479.00")).not.toBeInTheDocument();
  });

  it("prefers the dedicated live quote stream over stale provider health on the XAUUSD spot card", () => {
    const liveQuote: MarketAgentLiveQuoteResponse = {
      ok: true,
      running: true,
      phase: "running",
      message: "Live quote stream is running.",
      quote: {
        symbol: "XAUUSD",
        bid: 4508.8,
        ask: 4509.2,
        mid: 4509,
        timestamp: freshProviderTimestamp(),
        source: "cTrader",
        source_type: "spot"
      },
      provider_health: {
        provider_key: "xauusd",
        source: "cTrader",
        source_type: "spot",
        data_mode: "live_seen",
        is_available: true,
        is_stale: false,
        current_value: 4509,
        data_timestamp: freshProviderTimestamp(),
        fetched_at: freshProviderTimestamp()
      }
    };
    const staleProviderHealth: MarketAgentProviderHealthResponse = {
      ...providerHealth,
      items: providerHealth.items.map((item) =>
        item.provider_key === "xauusd"
          ? {
              ...item,
              current_value: 4479,
              data_timestamp: "2026-05-19T08:00:00+08:00",
              fetched_at: "2026-05-19T08:00:00+08:00"
            }
          : item
      )
    };

    renderMarketAgentPage({ providerHealth: staleProviderHealth, liveQuote });

    const priceCard = screen.getByRole("heading", { name: /XAUUSD \(Spot\)/i }).closest("article") as HTMLElement;
    expect(within(priceCard).getByText("4,509.00")).toBeInTheDocument();
    expect(within(priceCard).queryByText("4,479.00")).not.toBeInTheDocument();
    expect(within(priceCard).getByText(/^Live$/i)).toBeInTheDocument();
    expect(within(priceCard).queryByText(/\(0s ago\)/i)).not.toBeInTheDocument();
    expect(priceCard.querySelector(".market-agent-value-pulse")).not.toBeInTheDocument();
    expect(priceCard.querySelectorAll(".market-agent-value-stable").length).toBeGreaterThan(0);
  });

  it("does not show replay window movement as cTrader spot change", () => {
    const liveQuote: MarketAgentLiveQuoteResponse = {
      ok: true,
      running: true,
      phase: "running",
      message: "Live quote stream is running.",
      quote: {
        symbol: "XAUUSD",
        bid: 4228.3,
        ask: 4228.35,
        mid: 4228.9,
        timestamp: freshProviderTimestamp(),
        source: "cTrader",
        source_type: "spot"
      },
      provider_health: {
        provider_key: "xauusd",
        source: "cTrader",
        source_type: "spot",
        data_mode: "live_seen",
        is_available: true,
        is_stale: false,
        current_value: 4228.9,
        previous_value: null,
        change_value: null,
        change_unit: "price",
        data_timestamp: freshProviderTimestamp(),
        fetched_at: freshProviderTimestamp()
      }
    };
    const replayWithWindowMove: MarketAgentReplayResponse = {
      ...replay,
      replay: {
        ...replay.replay,
        price_series: [
          {
            symbol: "XAUUSD",
            timestamp: "2026-05-19T08:00:00+08:00",
            data_timestamp: "2026-05-19T08:00:00+08:00",
            close_price: 4228.9,
            change_value: 4.66,
            change_pct: 0.11
          } as unknown as MarketAgentReplayResponse["replay"]["price_series"][number]
        ]
      }
    };

    renderMarketAgentPage({ liveQuote, replay: replayWithWindowMove });

    const priceCard = screen.getByRole("heading", { name: /XAUUSD \(Spot\)/i }).closest("article") as HTMLElement;
    expect(within(priceCard).getByText("4,228.90")).toBeInTheDocument();
    expect(within(priceCard).queryByText(/\+4\.66/)).not.toBeInTheDocument();
    expect(within(priceCard).queryByText(/\+0\.11%/)).not.toBeInTheDocument();
  });

  it("calculates the XAUUSD spot card change from fresh cTrader M1 data when native change is missing", () => {
    const quoteTimestamp = freshProviderTimestamp();
    const liveQuote: MarketAgentLiveQuoteResponse = {
      ok: true,
      running: true,
      phase: "running",
      message: "Live quote stream is running.",
      quote: {
        symbol: "XAUUSD",
        bid: 4228.85,
        ask: 4228.95,
        mid: 4228.9,
        timestamp: quoteTimestamp,
        source: "cTrader",
        source_type: "spot"
      },
      provider_health: {
        provider_key: "xauusd",
        source: "cTrader",
        source_type: "spot",
        data_mode: "live_seen",
        is_available: true,
        is_stale: false,
        current_value: 4228.9,
        previous_value: null,
        change_value: null,
        change_unit: "price",
        data_timestamp: quoteTimestamp,
        fetched_at: quoteTimestamp
      }
    };
    const replayWithFreshCTraderM1: MarketAgentReplayResponse = {
      ...replay,
      replay: {
        ...replay.replay,
        price_series: [
          {
            symbol: "XAUUSD",
            source: "cTrader CLI live stream",
            source_type: "spot_m1",
            data_mode: "live_seen",
            timestamp: quoteTimestamp,
            data_timestamp: quoteTimestamp,
            open_price: 4227.9,
            close_price: 4228.9,
            change_value: 4.66,
            change_pct: 0.11
          } as unknown as MarketAgentReplayResponse["replay"]["price_series"][number]
        ]
      }
    };

    renderMarketAgentPage({ liveQuote, replay: replayWithFreshCTraderM1 });

    const priceCard = screen.getByRole("heading", { name: /XAUUSD \(Spot\)/i }).closest("article") as HTMLElement;
    expect(within(priceCard).getByText("4,228.90")).toBeInTheDocument();
    expect(within(priceCard).getByText("+1.00 (+0.02%)")).toBeInTheDocument();
    expect(within(priceCard).queryByText(/\+4\.66/)).not.toBeInTheDocument();
    expect(within(priceCard).queryByText(/\+0\.11%/)).not.toBeInTheDocument();
  });

  it("does not derive latest evidence direction from the current XAUUSD move", () => {
    const neutralSnapshot: MarketAgentSnapshotResponse = {
      ...snapshot,
      state: {
        ...snapshot.state,
        current_bias: "unknown",
        confidence: "low",
        last_analysis_time: "2026-05-19T08:05:00+08:00"
      }
    };
    const multiNewsReplay: MarketAgentReplayResponse = {
      ...replay,
      replay: {
        ...replay.replay,
        price_series: [
          {
            symbol: "XAUUSD",
            data_timestamp: "2026-05-19T08:00:00+08:00",
            close_price: 4520,
            source_type: "spot",
            data_mode: "live_seen"
          },
          {
            symbol: "XAUUSD",
            data_timestamp: "2026-05-19T08:15:00+08:00",
            close_price: 4510,
            source_type: "spot",
            data_mode: "live_seen"
          }
        ],
        news_items: [
          {
            title: "Oil prices fall after Strait of Hormuz supply update",
            published_at: "2026-05-19T08:14:00+08:00",
            source: "US Top News and Analysis",
            included: true,
            semantic_type: "news"
          },
          {
            title: "Iran deal details keep traders focused on shipping",
            published_at: "2026-05-19T08:10:00+08:00",
            source: "MarketWatch.com - Top Stories",
            included: true,
            semantic_type: "news"
          },
          {
            title: "Fed comments keep dollar attention high",
            published_at: "2026-05-19T08:06:00+08:00",
            source: "Reuters",
            included: true,
            semantic_type: "news"
          }
        ]
      }
    };

    renderMarketAgentPage({ snapshot: neutralSnapshot, replay: multiNewsReplay });

    const latestEvidence = screen.getByRole("heading", { name: /Latest Evidence/i }).closest("section");
    expect(latestEvidence).not.toBeNull();
    expect(within(latestEvidence as HTMLElement).getByText(/Oil prices fall after Strait of Hormuz supply update/i)).toBeInTheDocument();
    expect(within(latestEvidence as HTMLElement).getByText(/Iran deal details keep traders focused on shipping/i)).toBeInTheDocument();
    expect(within(latestEvidence as HTMLElement).queryByText(/^Bearish$/i)).not.toBeInTheDocument();
    expect(within(latestEvidence as HTMLElement).queryByText(/^Bullish$/i)).not.toBeInTheDocument();
    expect(within(latestEvidence as HTMLElement).getAllByText(/^Neutral$/i).length).toBeGreaterThan(0);
    expect(within(latestEvidence as HTMLElement).queryByText(/^Relevant$/i)).not.toBeInTheDocument();
    expect(within(latestEvidence as HTMLElement).queryByText(/^Against$/i)).not.toBeInTheDocument();

    const evidenceCard = screen.getByRole("heading", { name: /Evidence Status/i }).closest("article");
    expect(evidenceCard).not.toBeNull();
    expect(within(evidenceCard as HTMLElement).getAllByText(/^Neutral$/i).length).toBeGreaterThan(0);
    expect(within(evidenceCard as HTMLElement).queryByText(/^Relevant$/i)).not.toBeInTheDocument();
    expect(within(evidenceCard as HTMLElement).queryByText(/^Against$/i)).not.toBeInTheDocument();
  });

  it("shows AI-assigned news direction instead of deriving it from the current XAUUSD move", () => {
    const directionalReplay: MarketAgentReplayResponse = {
      ...replay,
      replay: {
        ...replay.replay,
        price_series: [
          {
            symbol: "XAUUSD",
            data_timestamp: "2026-05-19T08:00:00+08:00",
            close_price: 4520,
            source_type: "spot",
            data_mode: "live_seen"
          },
          {
            symbol: "XAUUSD",
            data_timestamp: "2026-05-19T08:15:00+08:00",
            close_price: 4510,
            source_type: "spot",
            data_mode: "live_seen"
          }
        ],
        news_items: [
          {
            title: "Oil prices fall as supply risks ease",
            summary: "Lower oil pressure can ease inflation risk for gold.",
            published_at: "2026-05-19T08:14:00+08:00",
            source: "US Top News and Analysis",
            included: true,
            semantic_type: "news",
            impact_direction_on_gold: "bullish",
            impact_direction_source: "local_ai"
          }
        ]
      }
    };

    renderMarketAgentPage({ replay: directionalReplay });

    const latestEvidence = screen.getByRole("heading", { name: /Latest Evidence/i }).closest("section");
    expect(latestEvidence).not.toBeNull();
    const newsRow = within(latestEvidence as HTMLElement)
      .getByText(/Oil prices fall as supply risks ease/i)
      .closest("button") as HTMLElement;
    expect(newsRow).not.toBeNull();
    expect(within(newsRow).getByText(/^Bullish$/i)).toBeInTheDocument();
    expect(within(newsRow).queryByText(/^Bearish$/i)).not.toBeInTheDocument();
  });

  it("dedupes repeated latest evidence news by story", () => {
    const repeatedNewsReplay: MarketAgentReplayResponse = {
      ...replay,
      replay: {
        ...replay.replay,
        news_items: [
          {
            title: "Markets price higher Treasury yields after hawkish Fed comments",
            summary: "Repeated mock headline should render once in Latest Evidence.",
            published_at: "2026-05-19T08:03:00+08:00",
            first_seen_at: "2026-05-19T08:06:00+08:00",
            source: "Reuters",
            included: true,
            semantic_type: "news"
          },
          {
            title: "Markets price higher Treasury yields after hawkish Fed comments",
            summary: "Same story arrived again with a later fetch timestamp.",
            published_at: "2026-05-19T08:03:00+08:00",
            first_seen_at: "2026-05-19T08:09:00+08:00",
            source: "Reuters",
            included: true,
            semantic_type: "news"
          }
        ]
      }
    };

    renderMarketAgentPage({ replay: repeatedNewsReplay });

    const latestEvidence = screen.getByRole("heading", { name: /Latest Evidence/i }).closest("section");
    expect(latestEvidence).not.toBeNull();
    expect(
      within(latestEvidence as HTMLElement).getAllByText(/Markets price higher Treasury yields after hawkish Fed comments/i)
    ).toHaveLength(1);
    expect(
      within(latestEvidence as HTMLElement).queryByText(/Same story arrived again with a later fetch timestamp/i)
    ).not.toBeInTheDocument();
  });

  it("labels empty evidence support as neutral instead of inventing direction", () => {
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
    expect(within(scoreRing as HTMLElement).getByText("Neutral")).toBeInTheDocument();
    expect(container.querySelector(".market-agent-score-progress.is-empty")).toBeInTheDocument();
    expect(container.querySelector(".market-agent-evidence-footer")?.textContent).toContain("Neutral (0%)");
    expect(screen.queryByText(/Aligned|Opposing/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Relevant|Against/i)).not.toBeInTheDocument();
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
    expect(within(scoreRing as HTMLElement).getByText("Bearish")).toBeInTheDocument();
    expect(progress).toHaveClass("is-full");
    expect(progress).not.toHaveAttribute("stroke-dashoffset");
    expect(progress).not.toHaveAttribute("stroke-dasharray");
  });

  it("hides accepted macro drivers that have no linked market story", () => {
    const evidenceWithPlaceholderMacro: MarketAgentEvidenceForRunResponse = {
      ...evidence,
      payload: {
        ...evidence.payload,
        evidence_packet: {
          ...evidence.payload.evidence_packet,
          allowed_candidate_drivers: ["oil_inflation", "geopolitics"],
          blocked_drivers: {}
        }
      }
    };
    const driverAttentionWithPlaceholderMacro: MarketAgentDriverAttentionResponse = {
      ...driverAttention,
      states: [
        {
          driver_id: "oil_inflation",
          label: "Oil / inflation",
          current_state: "active",
          priority: "conditional_macro",
          relevance_score: 0.8,
          impact_percent: -0.1,
          confidence: "low",
          current_evidence_summary: "Inflation risk stays in focus",
          related_news_count: 10,
          related_calendar_events: 0,
          data_mode: "live_seen"
        },
        {
          driver_id: "geopolitics",
          label: "Geopolitics",
          current_state: "active",
          priority: "temporary_event",
          relevance_score: 0.7,
          impact_percent: null,
          confidence: "low",
          current_evidence_summary: "No linked headline yet.",
          related_news_count: 0,
          related_calendar_events: 0,
          data_mode: "live_seen"
        }
      ]
    };

    renderMarketAgentPage({
      activeSection: "drivers",
      selectedEvidence: evidenceWithPlaceholderMacro,
      driverAttention: driverAttentionWithPlaceholderMacro,
      replay: {
        ...replay,
        replay: {
          ...replay.replay,
          news_items: [],
          calendar_events: []
        }
      }
    });

    expect(screen.queryByText(/No linked headline yet/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Geopolitics$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Accepted .* 0 news .* 0 calendar/i)).not.toBeInTheDocument();
  });

  it("uses stored evidence refs as the readable market story for active drivers", () => {
    const evidenceWithAcceptedMacro: MarketAgentEvidenceForRunResponse = {
      ...evidence,
      payload: {
        ...evidence.payload,
        evidence_packet: {
          ...evidence.payload.evidence_packet,
          allowed_candidate_drivers: ["geopolitics"],
          blocked_drivers: {}
        }
      }
    };
    const driverAttentionWithEvidenceRefs: MarketAgentDriverAttentionResponse = {
      ...driverAttention,
      states: [
        {
          driver_id: "geopolitics",
          label: "Geopolitics",
          current_state: "active",
          priority: "temporary_event",
          relevance_score: 0.78,
          confidence: "medium",
          current_evidence_summary: "Geopolitics is actively repriced.",
          related_news_count: 6,
          related_calendar_events: 0,
          evidence_refs: [
            {
              kind: "news",
              title: "Iran escalation keeps Hormuz risk in focus",
              source: "US Top News and Analysis",
              timestamp_myt: "13-06-2026 21:57"
            }
          ],
          data_mode: "live_seen"
        }
      ]
    };

    renderMarketAgentPage({
      activeSection: "drivers",
      selectedEvidence: evidenceWithAcceptedMacro,
      driverAttention: driverAttentionWithEvidenceRefs,
      replay: {
        ...replay,
        replay: {
          ...replay.replay,
          news_items: [],
          calendar_events: []
        }
      }
    });

    expect(screen.getByText(/Iran escalation keeps Hormuz risk in focus/i)).toBeInTheDocument();
    expect(screen.queryByText(/Geopolitics is actively repriced/i)).not.toBeInTheDocument();
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

  it("keeps the dashboard replay preview bounded when stored replay is large", () => {
    const heavyReplay: MarketAgentReplayResponse = {
      ...replay,
      replay: {
        ...replay.replay,
        timeline_events: Array.from({ length: 80 }, (_, index) => ({
          monitor_run_id: 1000 + index,
          event_time: `2026-05-19T${String(6 + Math.floor(index / 10)).padStart(2, "0")}:${String(index % 10).padStart(2, "0")}:00+08:00`,
          event_type: "analysis",
          label: `Large replay marker ${index + 1}`,
          payload: {
            semantic_type: index % 2 === 0 ? "breakout" : "reversal",
            impact_percent: index % 2 === 0 ? -0.35 : 0.28,
            main_driver: "yields"
          }
        }))
      }
    };
    const { container } = renderMarketAgentPage({ replay: heavyReplay });

    expect(container.querySelectorAll(".market-agent-timeline-track-row").length).toBeLessThanOrEqual(12);
  });

  it("shows relevant replay news and calendar while keeping paused analysis rows out", () => {
    renderMarketAgentPage({
      replay: {
        ...replay,
        replay: {
          ...replay.replay,
          news_items: [
            {
              title: "Oil prices tumble as deal to end Iran war appears close, though Trump says there is more work",
              published_at: "2026-05-25T11:05:00+08:00",
              source: "MarketWatch.com - Top Stories",
              data_mode: "live_seen",
              included: true
            },
            {
              title: "Celebrity retirement story with no market impact",
              published_at: "2026-05-25T11:05:30+08:00",
              source: "Lifestyle Feed",
              data_mode: "live_seen",
              included: false,
              filter_reason: "no_market_agent_keyword"
            },
            {
              title: "Trump says Iran deal will be signed Sunday as Hormuz reopening remains uncertain",
              summary_title: "Trump peace deal Iran",
              summary: "Fed rate comments kept yields in focus.",
              description: "Trump says the Iran deal will be signed Sunday after Tehran said timing remains uncertain.",
              summary_source: "local_ai",
              published_at: "2026-05-25T11:06:00+08:00",
              source: "Reuters",
              data_mode: "live_seen",
              included: true
            }
          ],
          timeline_events: [
            {
              monitor_run_id: 31,
              event_time: "2026-05-25T11:07:00+08:00",
              event_type: "analysis",
              label: "unknown",
              payload: {
                semantic_type: "range",
                impact_percent: 0,
                main_driver: "unknown",
                cause_status: "unconfirmed",
                summary: "XAUUSD market is closed; news, calendar, and cross-market context keep updating, and the next trade read resumes when fresh XAUUSD price action returns."
              }
            }
          ],
          calendar_events: [
            {
              title: "Michigan Consumer Sentiment (Jun)",
              scheduled_at: "2026-05-25T22:00:00+08:00",
              source: "Economic Calendar",
              data_mode: "live_seen",
              review_status: "unreviewed_context"
            },
            {
              title: "Australia - King's Birthday",
              scheduled_at: "2026-05-25T00:00:00+08:00",
              source: "Economic Calendar",
              data_mode: "live_seen",
              impact: "holiday"
            }
          ]
        }
      }
    });

    fireEvent.click(screen.getByRole("button", { name: /Replay \/ Timeline/i }));
    const replayPanel = document.querySelector(".market-agent-replay-story") as HTMLElement;
    expect(replayPanel).toBeTruthy();

    expect(within(replayPanel).getByText(/Oil prices tumble/i)).toBeInTheDocument();
    expect(within(replayPanel).getByText(/Michigan Consumer Sentiment/i)).toBeInTheDocument();
    expect(within(replayPanel).queryByText(/Celebrity retirement/i)).not.toBeInTheDocument();
    expect(within(replayPanel).queryByText(/King's Birthday/i)).not.toBeInTheDocument();
    expect(within(replayPanel).queryByText(/XAUUSD flat 0\.00%/i)).not.toBeInTheDocument();
    expect(within(replayPanel).queryByText(/Suppressed duplicate/i)).not.toBeInTheDocument();
    expect(within(replayPanel).queryByText(/Impact: watching/i)).not.toBeInTheDocument();
    expect(within(replayPanel).queryByText(/Trump peace deal Iran/i)).not.toBeInTheDocument();
    expect(within(replayPanel).getByText(/Trump says Iran deal will be signed Sunday/i)).toBeInTheDocument();
  });

  it("does not treat an expired cTrader spot payload as live or market closed current evidence", () => {
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

    expect(screen.getAllByText(/cTrader reconnecting/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Last live quote/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Market closed/i)).not.toBeInTheDocument();
    expect(screen.getAllByText(/TRENDING DOWN/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/AWAITING LIVE PRICE/i)).not.toBeInTheDocument();
    expect(screen.getAllByText(/Big picture/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Rates/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/cTrader \(Spot\)/i)).not.toBeInTheDocument();
    expect(screen.getByText(/4,479\.00/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Evidence$/i }));
    expect(screen.getByText(/Collected Context/i)).toBeInTheDocument();
    expect(screen.queryByText(/Xauusd: Live Data/i)).not.toBeInTheDocument();
  });

  it("treats a fresh cTrader quote timestamp as live even when stale metadata lags behind", () => {
    const freshTimestamp = freshProviderTimestamp();
    const freshSpotHealthWithLaggingMetadata: MarketAgentProviderHealthResponse = {
      ...providerHealth,
      items: providerHealth.items.map((item) =>
        item.provider_key === "xauusd"
          ? {
              ...item,
              source: "cTrader",
              source_type: "spot",
              data_mode: "stale",
              is_available: true,
              is_stale: true,
              stale_reason: "Live quote snapshot is stale; waiting for fresh cTrader stream.",
              current_value: 4315.06,
              data_timestamp: freshTimestamp,
              fetched_at: freshTimestamp
            }
          : item
      )
    };

    renderMarketAgentPage({
      providerHealth: freshSpotHealthWithLaggingMetadata,
      liveQuote: {
        ok: true,
        running: false,
        phase: "starting",
        quote: null,
        provider_health: null
      },
      selectedEvidence: { ok: true, available: false, message: "No run selected.", payload: {} }
    });

    expect(screen.getAllByText(/cTrader \(Spot\)/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/TRENDING DOWN/i)).toBeInTheDocument();
    expect(screen.queryByText(/OBSERVING PRICE/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/cTrader reconnecting/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/AWAITING LIVE PRICE/i)).not.toBeInTheDocument();
    expect(screen.getByText(/4,315\.06/i)).toBeInTheDocument();
    expect(screen.queryByText(/\(0s ago\)/i)).not.toBeInTheDocument();
  });

  it("labels a saved cTrader snapshot as waiting instead of market closed", () => {
    const savedSnapshotHealth: MarketAgentProviderHealthResponse = {
      ...providerHealth,
      items: providerHealth.items.map((item) =>
        item.provider_key === "xauusd"
          ? {
              ...item,
              source: "cTrader",
              source_type: "spot_snapshot",
              data_mode: "snapshot",
              is_available: true,
              is_stale: true,
              stale_reason: "Loaded saved cTrader quote snapshot. Live refresh runs only during monitor/connect/test actions.",
              current_value: 4508.1,
              data_timestamp: "2026-05-22T20:56:59Z",
              fetched_at: freshProviderTimestamp()
            }
          : item
      )
    };

    renderMarketAgentPage({ providerHealth: savedSnapshotHealth });

    expect(screen.getAllByText(/cTrader connecting/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Connecting to live/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Market closed/i)).not.toBeInTheDocument();
    expect(screen.getByText(/4,508\.10/i)).toBeInTheDocument();
  });

  it("shows a cTrader market-closed snapshot in Activity instead of ready with no live job", () => {
    const closedProviderHealth: MarketAgentProviderHealthResponse = {
      ...providerHealth,
      items: providerHealth.items.map((item) =>
        item.provider_key === "xauusd"
          ? {
              ...item,
              source: "cTrader",
              source_type: "spot",
              data_mode: "stale",
              is_available: true,
              is_stale: true,
              stale_reason: "Market is closed.",
              current_value: 4508.3,
              data_timestamp: "2026-05-24T04:58:00+08:00",
              fetched_at: "2026-05-24T05:01:00+08:00"
            }
          : item
      )
    };

    renderMarketAgentPage({
      providerHealth: closedProviderHealth,
      monitorStatus: {
        ...monitorStatus,
        running: true,
        phase: "running",
        message: "Monitor loop is running.",
        activity: {}
      } as Parameters<typeof MarketAgentPage>[0]["monitorStatus"]
    });

    fireEvent.click(screen.getByRole("button", { name: /^Activity$/i }));
    const agentActivity = screen.getByLabelText(/Agent activity board/i);
    fireEvent.click(within(agentActivity).getByRole("button", { name: /^Assets/i }));
    const assetsDetail = within(agentActivity).getByRole("complementary", { name: /Assets detail view/i });
    fireEvent.click(within(assetsDetail).getByRole("button", { name: /^Status$/i }));

    expect(within(assetsDetail).getAllByText(/Market closed/i).length).toBeGreaterThan(0);
    expect(within(assetsDetail).getByText(/Last quote snapshot/i)).toBeInTheDocument();
    expect(within(assetsDetail).getByText(/Last quote 4508\.3/i)).toBeInTheDocument();
    const liveIngestSection = within(assetsDetail).getByText(/Live quote stream/i).closest("section") as HTMLElement;
    expect(within(liveIngestSection).queryByText(/No detailed activity jobs were recorded for this step/i)).not.toBeInTheDocument();
  });

  it("prefers fresh runtime XAUUSD health over stale legacy live ingest jobs in Activity", () => {
    renderMarketAgentPage({
      monitorStatus: {
        ...monitorStatus,
        running: true,
        phase: "running",
        message: "Monitor loop is running.",
        activity: {
          ctrader: {
            status: "unavailable",
            detail: "Live cTrader spot is unavailable.",
            jobs: [
              { title: "Live quote request", status: "unavailable", detail: "Price input missing" },
              { title: "cTrader spot freshness", status: "stale", detail: "Waiting for fresh cTrader streaming quote snapshot" }
            ]
          }
        }
      } as Parameters<typeof MarketAgentPage>[0]["monitorStatus"]
    });

    fireEvent.click(screen.getByRole("button", { name: /^Activity$/i }));
    const agentActivity = screen.getByLabelText(/Agent activity board/i);
    fireEvent.click(within(agentActivity).getByRole("button", { name: /^Assets/i }));
    const assetsDetail = within(agentActivity).getByRole("complementary", { name: /Assets detail view/i });
    fireEvent.click(within(assetsDetail).getByRole("button", { name: /^Status$/i }));

    const liveIngestSection = within(assetsDetail).getByText(/Live quote stream/i).closest("section") as HTMLElement;
    expect(within(liveIngestSection).getByText(/Latest live quote/i)).toBeInTheDocument();
    expect(within(liveIngestSection).getByText(/fresh live quote/i)).toBeInTheDocument();
    expect(within(liveIngestSection).queryByText(/^Live quote request$/i)).not.toBeInTheDocument();
    expect(within(liveIngestSection).queryByText(/^cTrader spot freshness$/i)).not.toBeInTheDocument();
  });

  it("shows reconnecting in Activity when the last live cTrader quote is stale", () => {
    const reconnectingProviderHealth: MarketAgentProviderHealthResponse = {
      ...providerHealth,
      items: providerHealth.items.map((item) =>
        item.provider_key === "xauusd"
          ? {
              ...item,
              source: "cTrader",
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

    renderMarketAgentPage({
      providerHealth: reconnectingProviderHealth,
      monitorStatus: {
        ...monitorStatus,
        running: true,
        phase: "running",
        message: "Monitor loop is running.",
        activity: {
          ctrader: {
            status: "unavailable",
            detail: "Live cTrader spot is unavailable.",
            jobs: [
              { title: "GC=F proxy check", status: "unavailable", detail: "No chart rows." },
              { title: "Live quote request", status: "unavailable", detail: "Price input missing" },
              { title: "cTrader spot freshness", status: "stale", detail: "Waiting for fresh cTrader streaming quote snapshot" }
            ]
          }
        }
      } as Parameters<typeof MarketAgentPage>[0]["monitorStatus"]
    });

    fireEvent.click(screen.getByRole("button", { name: /^Activity$/i }));
    const agentActivity = screen.getByLabelText(/Agent activity board/i);
    fireEvent.click(within(agentActivity).getByRole("button", { name: /^Assets/i }));
    const assetsDetail = within(agentActivity).getByRole("complementary", { name: /Assets detail view/i });
    fireEvent.click(within(assetsDetail).getByRole("button", { name: /^Status$/i }));

    const liveIngestSection = within(assetsDetail).getByText(/Live quote stream/i).closest("section") as HTMLElement;
    expect(within(liveIngestSection).getByText(/Last live quote/i)).toBeInTheDocument();
    expect(within(liveIngestSection).getByText(/stream is reconnecting/i)).toBeInTheDocument();
    expect(within(liveIngestSection).queryByText(/^GC=F proxy check$/i)).not.toBeInTheDocument();
    expect(within(liveIngestSection).queryByText(/^Live quote request$/i)).not.toBeInTheDocument();
    expect(within(liveIngestSection).queryByText(/^cTrader spot freshness$/i)).not.toBeInTheDocument();
  });

  it("keeps Activity live quote status aligned with the top live quote card", () => {
    const freshTimestamp = new Date().toISOString();
    const staleProviderHealth: MarketAgentProviderHealthResponse = {
      ...providerHealth,
      items: providerHealth.items.map((item) =>
        item.provider_key === "xauusd"
          ? {
              ...item,
              source: "cTrader",
              source_type: "spot",
              data_mode: "unavailable",
              is_available: false,
              is_stale: false,
              error: "Price input missing"
            }
          : item
      )
    };
    const liveQuote: MarketAgentLiveQuoteResponse = {
      ok: true,
      running: true,
      message: "Live quote stream is running.",
      quote: {
        bid: 4532.73,
        ask: 4532.95,
        mid: 4532.84,
        spread: 0.22,
        timestamp: freshTimestamp,
        symbol: "XAUUSD"
      },
      provider_health: {
        provider_key: "ctrader_spot",
        source: "cTrader",
        source_type: "spot",
        data_mode: "live_seen",
        is_available: true,
        is_stale: false,
        current_value: 4532.84,
        data_timestamp: freshTimestamp,
        fetched_at: freshTimestamp
      }
    };

    renderMarketAgentPage({
      providerHealth: staleProviderHealth,
      liveQuote,
      monitorStatus: {
        ...monitorStatus,
        running: true,
        phase: "running",
        message: "Monitor loop is running.",
        activity: {
          ctrader: {
            status: "unavailable",
            detail: "Live cTrader spot is unavailable.",
            jobs: [
              { title: "GC=F proxy check", status: "unavailable", detail: "No chart rows." },
              { title: "Live quote request", status: "unavailable", detail: "Price input missing" },
              { title: "cTrader spot freshness", status: "stale", detail: "Waiting for fresh cTrader streaming quote snapshot" }
            ]
          }
        }
      } as Parameters<typeof MarketAgentPage>[0]["monitorStatus"]
    });

    expect(screen.getByText(/4,532\.84/i)).toBeInTheDocument();
    expect(screen.getAllByText(/cTrader \(Spot\)/i).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: /^Activity$/i }));
    const agentActivity = screen.getByLabelText(/Agent activity board/i);
    fireEvent.click(within(agentActivity).getByRole("button", { name: /^Assets/i }));
    const assetsDetail = within(agentActivity).getByRole("complementary", { name: /Assets detail view/i });
    fireEvent.click(within(assetsDetail).getByRole("button", { name: /^Status$/i }));

    const liveIngestSection = within(assetsDetail).getByText(/Live quote stream/i).closest("section") as HTMLElement;
    expect(within(liveIngestSection).getByText(/Latest live quote/i)).toBeInTheDocument();
    expect(within(liveIngestSection).getByText(/fresh live quote/i)).toBeInTheDocument();
    expect(within(liveIngestSection).queryByText(/^GC=F proxy check$/i)).not.toBeInTheDocument();
    expect(within(liveIngestSection).queryByText(/^Live quote request$/i)).not.toBeInTheDocument();
    expect(within(liveIngestSection).queryByText(/^cTrader spot freshness$/i)).not.toBeInTheDocument();
  });

  it("hides fixed zero-score dormant drivers from macro and micro watch", () => {
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

    renderMarketAgentPage({ driverAttention: dormantOnlyAttention, selectedEvidence: null });

    const driverPanel = screen.getByRole("heading", { name: /Macro \/ Micro Watch/i }).closest("section");
    expect(driverPanel?.querySelectorAll(".market-agent-mm-row")).toHaveLength(0);
    expect(driverPanel?.querySelectorAll(".market-agent-mm-glance-card").length).toBeGreaterThanOrEqual(2);
    expect(within(driverPanel as HTMLElement).queryByText(/Geopolitics/i)).not.toBeInTheDocument();
    expect(within(driverPanel as HTMLElement).queryByText(/Risk sentiment/i)).not.toBeInTheDocument();
    expect(within(driverPanel as HTMLElement).getAllByText(/Big picture/i).length).toBeGreaterThan(0);
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
    expect(within(latestEvidencePanel as HTMLElement).getByText(/No accepted evidence in this category/i)).toBeInTheDocument();
  });

  it("shows observed price movement in replay when no accepted market event is ready yet", () => {
    const priceOnlyReplay: MarketAgentReplayResponse = {
      ...replay,
      replay: {
        ...replay.replay,
        price_series: [
          {
            symbol: "XAUUSD",
            data_timestamp: "2026-06-11T08:26:00.0000000Z",
            close_price: 4105,
            source_type: "spot",
            data_mode: "live_seen"
          },
          {
            symbol: "XAUUSD",
            data_timestamp: "2026-06-11T08:28:00.0000000Z",
            close_price: 4098,
            source_type: "spot",
            data_mode: "live_seen"
          }
        ],
        news_items: [],
        calendar_events: [],
        timeline_events: [],
        alerts: []
      }
    };
    const pendingEvidence: MarketAgentEvidenceForRunResponse = {
      ...evidence,
      payload: {
        ...evidence.payload,
        evidence_packet: {
          ...evidence.payload.evidence_packet,
          evidence_chain_status: {
            status: "context_only",
            can_show_current_conclusion: false,
            reason: "Waiting for recent history review before driver conclusions can be shown.",
            missing_required: ["xauusd_recent_history"],
            usable_inputs: ["live_xauusd_spot"],
            context_only_inputs: ["news_context"]
          }
        }
      }
    };

    renderMarketAgentPage({ replay: priceOnlyReplay, selectedEvidence: pendingEvidence });

    const replayPanel = screen.getByRole("heading", { name: /Market Replay \(Day\)/i }).closest("section");
    expect(within(replayPanel as HTMLElement).getByText(/Observed XAUUSD drop/i)).toBeInTheDocument();
    expect(within(replayPanel as HTMLElement).queryByText(/No accepted market events/i)).not.toBeInTheDocument();
  });

  it("does not hide valid dashboard replay news before the preview limit", () => {
    const newsOnlyReplay: MarketAgentReplayResponse = {
      ...replay,
      replay: {
        ...replay.replay,
        price_series: [],
        calendar_events: [],
        timeline_events: [],
        month_summary_events: [],
        alerts: [],
        news_items: Array.from({ length: 10 }, (_, index) => ({
          title: `Replay news marker ${index + 1}`,
          summary: `Market context ${index + 1}`,
          source: "Reuters",
          published_at: `2026-06-18T10:${String(index).padStart(2, "0")}:00+08:00`,
          included: true,
          data_mode: "live_seen"
        }))
      }
    };

    const { container } = renderMarketAgentPage({ replay: newsOnlyReplay, selectedEvidence: null });

    const replayPanel = screen.getByRole("heading", { name: /Market Replay \(Day\)/i }).closest("section");
    expect(replayPanel?.querySelectorAll(".market-agent-timeline-track-row")).toHaveLength(10);
    expect(within(replayPanel as HTMLElement).getByText(/Replay news marker 10/i)).toBeInTheDocument();
    expect(container.querySelectorAll(".market-agent-timeline-track-row")).toHaveLength(10);
  });

  it("keeps latest replay news in the dashboard preview when calendar context exceeds the limit", () => {
    const mixedContextReplay: MarketAgentReplayResponse = {
      ...replay,
      replay: {
        ...replay.replay,
        price_series: [],
        timeline_events: [],
        month_summary_events: [],
        alerts: [],
        news_items: [
          {
            title: "Strait of Hormuz reopening may take weeks",
            summary: "Shipping backlog keeps oil pressure in focus.",
            source: "US Top News and Analysis",
            published_at: "2026-06-18T16:10:00+08:00",
            included: true,
            data_mode: "live_seen",
            semantic_type: "news"
          },
          {
            title: "Iran memorandum aimed to end war",
            summary: "Iran memorandum aimed to end war",
            source: "US Top News and Analysis",
            published_at: "2026-06-18T11:09:00+08:00",
            included: true,
            data_mode: "live_seen",
            semantic_type: "news"
          }
        ],
        calendar_events: Array.from({ length: 12 }, (_, index) => ({
          title: `FOMC calendar context ${index + 1}`,
          source: "Economic Calendar",
          scheduled_at: `2026-06-18T02:${String(index).padStart(2, "0")}:00+08:00`,
          data_mode: "calendar_context",
          semantic_type: "calendar"
        }))
      }
    };

    renderMarketAgentPage({ replay: mixedContextReplay, selectedEvidence: null });

    const replayPanel = screen.getByRole("heading", { name: /Market Replay \(Day\)/i }).closest("section");
    expect(replayPanel?.querySelectorAll(".market-agent-timeline-track-row")).toHaveLength(12);
    expect(within(replayPanel as HTMLElement).getByText(/Strait of Hormuz reopening may take weeks/i)).toBeInTheDocument();
    expect(within(replayPanel as HTMLElement).getByText(/Iran memorandum aimed to end war/i)).toBeInTheDocument();
    expect(within(replayPanel as HTMLElement).queryByText(/^FOMC calendar context 1$/i)).not.toBeInTheDocument();
  });

  it("keeps dashboard replay timeline readable without node halos breaking the line", () => {
    const css = marketAgentPageCss();
    const dashboardTrackRule = css.match(/\.market-agent-replay-panel \.market-agent-timeline-track\s*\{[^}]+\}/)?.[0] ?? "";
    const replayCss = marketAgentReplayCss();

    expect(dashboardTrackRule).toContain("--ma-timeline-time-col: 56px");
    expect(css).toContain("--ma-timeline-axis-x:");
    expect(css).toContain("left: var(--ma-timeline-axis-x)");
    expect(css).toContain("justify-self: center");
    expect(css).not.toContain("0 0 0 3px");
    expect(replayCss).toContain("--ma-replay-axis-x:");
    expect(replayCss).toContain("left: var(--ma-replay-axis-x)");
    expect(replayCss).toContain("justify-self: center");
  });

  it("shows unconfirmed market reads as replay observations instead of hiding them", () => {
    const observationReplay: MarketAgentReplayResponse = {
      ...replay,
      replay: {
        ...replay.replay,
        price_series: [],
        news_items: [],
        calendar_events: [],
        alerts: [],
        suppressed_alerts: [],
        timeline_events: [
          {
            monitor_run_id: 78,
            event_time: "2026-06-18T01:15:00+08:00",
            event_type: "analysis",
            label: "unknown",
            payload: {
              semantic_type: "range",
              impact_percent: 0.03,
              main_driver: "unknown",
              cause_status: "unconfirmed",
              summary_title: "No confirmed driver; Hormuz risk is the watch item",
              summary: "Price action is small, but oil and Hormuz headlines remain the next confirmation watch.",
              market_read: {
                status: "no_conclusion",
                headline: "No confirmed driver; Hormuz risk is the watch item",
                thesis: "Price action is small, but oil and Hormuz headlines remain the next confirmation watch.",
                driver: "unknown",
                cause_status: "unconfirmed"
              }
            }
          }
        ]
      }
    };

    renderMarketAgentPage({ replay: observationReplay, selectedEvidence: null });

    const replayPanel = screen.getByRole("heading", { name: /Market Replay \(Day\)/i }).closest("section");
    expect(within(replayPanel as HTMLElement).getByText(/No confirmed driver; Hormuz risk is the watch item/i)).toBeInTheDocument();
    expect(within(replayPanel as HTMLElement).queryByText(/No accepted market events/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Replay \/ Timeline/i }));
    expect(screen.getByRole("heading", { name: /^Market Replay$/i })).toBeInTheDocument();
    expect(screen.getByText(/No confirmed driver; Hormuz risk is the watch item/i)).toBeInTheDocument();
  });

  it("does not show technical evidence from a different monitor run as current evidence", () => {
    const mixedReplay: MarketAgentReplayResponse = {
      ...replay,
      replay: {
        ...replay.replay,
        timeline_events: [
          {
            monitor_run_id: 99,
            event_time: "2026-06-11T13:35:00+08:00",
            event_type: "recovery_analysis",
            label: "reconstructed_move",
            payload: {
              semantic_type: "breakout",
              impact_percent: -0.23,
              main_driver: "price_action",
              cause_status: "likely"
            }
          }
        ]
      }
    };

    renderMarketAgentPage({ replay: mixedReplay, selectedEvidence: evidence });

    const latestEvidencePanel = screen.getByRole("heading", { name: /Latest Evidence/i }).closest("section");
    expect(within(latestEvidencePanel as HTMLElement).queryByText(/Technical Breakout/i)).not.toBeInTheDocument();
    expect(within(latestEvidencePanel as HTMLElement).queryByText(/reconstructed_move/i)).not.toBeInTheDocument();
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

  it("keeps month replay populated when no major-turn summary exists", async () => {
    const replayWithoutMonthSummary: MarketAgentReplayResponse = {
      ...replay,
      replay: {
        ...replay.replay,
        month_summary_events: [],
        timeline_events: [],
        alerts: [],
        suppressed_alerts: [],
        price_series: [],
        news_items: [
          {
            title: "Oil headline remains relevant for gold risk",
            source: "MarketWatch",
            published_at: "2026-05-19T07:10:00+08:00",
            semantic_type: "news",
            data_mode: "live_seen",
            included: true
          }
        ],
        calendar_events: [
          {
            title: "US PMI release window",
            source: "Economic Calendar",
            scheduled_at: "2026-05-19T09:45:00+08:00",
            semantic_type: "calendar",
            data_mode: "live_seen"
          }
        ]
      }
    };

    renderMarketAgentPage({
      replay: replayWithoutMonthSummary,
      rangePreset: "month"
    });

    fireEvent.click(screen.getByRole("button", { name: /Replay \/ Timeline/i }));

    await waitFor(() => {
      expect(screen.getByText(/Oil headline remains relevant for gold risk/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/US PMI release window/i)).toBeInTheDocument();
    expect(screen.queryByText(/No replay markers/i)).not.toBeInTheDocument();
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
        onStartCTraderConnect={async () => ({ ok: true, status: "waiting_for_live_connector", message: "cTrader account is connected. Live streaming is waiting for the long-running connector snapshot; cTrader CLI cBot streaming is disabled to avoid external algo host windows.", ctrader: providerConfig.ctrader })}
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
    expect(within(replayRange).queryByRole("button", { name: "Context" })).not.toBeInTheDocument();
    expect(day).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(month);
    expect(month).toHaveAttribute("aria-pressed", "true");
    expect(day).toHaveAttribute("aria-pressed", "false");

    const evidenceTabs = screen.getByRole("tablist", { name: /Evidence filters/i });
    const allTab = within(evidenceTabs).getByRole("tab", { name: "All" });
    const newsTab = within(evidenceTabs).getByRole("tab", { name: "News" });
    expect(allTab).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByText(/^Confirming$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Supporting$/i)).not.toBeInTheDocument();
    expect(screen.getAllByText(/^Bearish$/i).length).toBeGreaterThan(0);
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
    expect(alertsButton.querySelector(".market-agent-nav-badge")).not.toBeInTheDocument();
    fireEvent.click(alertsButton);
    expect(screen.getByRole("heading", { name: /^Alerts$/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/Alert summary/i)).toBeInTheDocument();
    expect(screen.getByText(/1 attention item/i)).toBeInTheDocument();
    expect(screen.getByText(/3 quiet repeats hidden/i)).toBeInTheDocument();
    expect(screen.getByText(/Telegram is off, so nothing is sent there/i)).toBeInTheDocument();
    expect(screen.getByText(/Driver US yields/i)).toBeInTheDocument();
    expect(screen.getByText(/2 repeats folded/i)).toBeInTheDocument();
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
    expect(screen.getByRole("heading", { name: /^Macro \/ Micro Watch$/i })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /^Macro drivers$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /^Micro themes$/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Big picture/i)).toBeInTheDocument();
    expect(screen.getByText(/Small stories/i)).toBeInTheDocument();
    expect(screen.getByText(/^Now$/i)).toBeInTheDocument();
    expect(screen.getByText(/Gold remains under pressure from rising yields/i)).toBeInTheDocument();
    expect(screen.getByText(/Confirm: DXY\/yields confirmation/i)).toBeInTheDocument();
    expect(screen.getByText(/US2Y is unavailable; confidence stays limited/i)).toBeInTheDocument();
    expect(screen.queryByText(/Technical details/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Evidence$/i }));
    expect(screen.getByRole("heading", { name: /Evidence Panel/i })).toBeInTheDocument();
    expect(screen.getByText(/Accepted driver/i)).toBeInTheDocument();
    expect(screen.queryByText(/Raw details/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Audit details/i)).not.toBeInTheDocument();

    expect(screen.queryByRole("heading", { name: /System Control/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Logs \/ Settings/i })).not.toBeInTheDocument();
  });

  it("shows recent sent alert history when the selected replay window has no alerts", () => {
    const replayWithoutAlerts: MarketAgentReplayResponse = {
      ...replay,
      replay: {
        ...replay.replay,
        alerts: [],
        suppressed_alerts: []
      }
    };
    renderMarketAgentPage({
      replay: replayWithoutAlerts,
      snapshot: {
        ...snapshot,
        alerts: [
          {
            time: "2026-05-19T07:15:00+08:00",
            notification_level: "level_2",
            message: "Gold remains under pressure from rising yields.",
            main_driver: "yields"
          }
        ]
      }
    });

    fireEvent.click(screen.getByRole("button", { name: /^Alerts$/i }));

    expect(screen.getByText(/1 sent \/ 0 reviewed/i)).toBeInTheDocument();
    expect(screen.getByText(/Gold remains under pressure from rising yields/i)).toBeInTheDocument();
    expect(screen.getByText(/^Recent$/i)).toBeInTheDocument();
    expect(screen.queryByText(/No alertable trade call in this window/i)).not.toBeInTheDocument();
  });

  it("shows reviewed no-send alert decisions when no Telegram alert was sent", () => {
    const replayWithReviewedDecision: MarketAgentReplayResponse = {
      ...replay,
      replay: {
        ...replay.replay,
        alerts: [],
        suppressed_alerts: [
          {
            monitor_run_id: 31,
            run_started_at: "2026-05-19T07:20:00+08:00",
            should_notify: false,
            notification_level: "none",
            reason: "Analysis result does not require notification."
          }
        ]
      }
    };

    renderMarketAgentPage({
      replay: replayWithReviewedDecision,
      snapshot: {
        ...snapshot,
        alerts: []
      }
    });

    fireEvent.click(screen.getByRole("button", { name: /^Alerts$/i }));

    expect(screen.getByText(/0 sent \/ 1 reviewed/i)).toBeInTheDocument();
    expect(screen.getByText(/Reviewed: no alert needed/i)).toBeInTheDocument();
    expect(screen.getByText(/Analysis result does not require notification/i)).toBeInTheDocument();
    expect(screen.getByText(/^Not sent$/i)).toBeInTheDocument();
    expect(screen.queryByText(/No alertable trade call in this window/i)).not.toBeInTheDocument();
  });

  it("shows Macro Micro news as latest-first readable lists", () => {
    const geopoliticalReplay: MarketAgentReplayResponse = {
      ...replay,
      replay: {
        ...replay.replay,
        news_items: [
          {
            title: "Iran announces end of military operations against Israel, but warns Lebanon strikes could trigger escalation",
            summary: "Iran announces an end of military operations against Israel, but warns Lebanon strikes could trigger escalation.",
            published_at: "2026-08-06T21:41:00+08:00",
            source: "US Top News and Analysis",
            data_mode: "backfilled",
            semantic_type: "news"
          },
          {
            title: "Strait of Hormuz traffic won't return to normal until end of the year, traders say",
            summary: "Strait of Hormuz traffic remains disrupted and traders expect normal flows only by year-end.",
            published_at: "2026-08-06T23:48:00+08:00",
            source: "MarketWatch",
            data_mode: "backfilled",
            semantic_type: "news"
          },
          {
            title: "100 days of the Iran war: How global markets and the economy have been affected",
            summary: "Charts show how the Iran war affected oil, risk sentiment, and global markets.",
            published_at: "2026-08-06T14:20:00+08:00",
            source: "US Top News and Analysis",
            data_mode: "backfilled",
            semantic_type: "news"
          }
        ]
      }
    };
    const { container } = renderMarketAgentPage({
      replay: geopoliticalReplay,
      selectedEvidence: null,
      driverAttention
    });

    fireEvent.click(screen.getByRole("button", { name: /^Driver Attention$/i }));

    expect(screen.getByRole("heading", { name: /^Macro \/ Micro Watch$/i })).toBeInTheDocument();
    const panel = container.querySelector("[data-qa='qa:market-agent:macro-micro:page']") as HTMLElement;
    expect(panel).toBeTruthy();
    const macroRows = Array.from(panel.querySelectorAll(".market-agent-mm-feed article"));
    const microRows = Array.from(panel.querySelectorAll(".market-agent-mm-tape li"));
    expect(macroRows.length).toBeGreaterThan(0);
    expect(microRows).toHaveLength(3);
    expect(macroRows[0].textContent).toMatch(/Strait of Hormuz traffic won't return to normal until end of the year/i);
    expect(microRows[0].textContent).toMatch(/Strait of Hormuz traffic won't return to normal until end of the year/i);
    expect(microRows[1].textContent).toMatch(/Iran announces end of military operations against Israel/i);
    expect(panel.textContent).toMatch(/100 days of the Iran war/i);
    expect(panel.textContent).toContain(`MarketWatch • ${formatExpectedMarketAgentDateTime("2026-08-06T23:48:00+08:00")}`);
    expect(microRows[0].textContent).not.toEqual(macroRows[0].textContent);
    expect(panel.textContent).not.toContain("...");
    expect(container.querySelector(".market-agent-mm-tape ol")).toBeInTheDocument();
  });

  it("dedupes repeated Macro Micro headlines by story instead of fetch time", () => {
    const duplicateReplay: MarketAgentReplayResponse = {
      ...replay,
      replay: {
        ...replay.replay,
        news_items: [
          {
            title: "A billion-dollar server company loses more than 40% of its value following short-seller report",
            published_at: "2026-06-11T11:50:00+08:00",
            source: "MarketWatch.com - Top Stories",
            included: true,
            data_mode: "live_seen",
            semantic_type: "news"
          },
          {
            title: "A billion-dollar server company just lost more than 40% of its value following a short-seller report",
            published_at: "2026-06-11T11:41:00+08:00",
            source: "MarketWatch.com - Top Stories",
            included: true,
            data_mode: "live_seen",
            semantic_type: "news"
          },
          {
            title: "Oil jumps as U.S. fresh strikes on Iran raise worries of extended disruption to energy flows",
            published_at: "2026-06-11T08:28:00+08:00",
            source: "US Top News and Analysis",
            included: true,
            data_mode: "live_seen",
            semantic_type: "news"
          }
        ]
      }
    };
    const { container } = renderMarketAgentPage({
      replay: duplicateReplay,
      selectedEvidence: null,
      driverAttention
    });

    fireEvent.click(screen.getByRole("button", { name: /^Driver Attention$/i }));

    const panel = container.querySelector("[data-qa='qa:market-agent:macro-micro:page']") as HTMLElement;
    const microRows = Array.from(panel.querySelectorAll(".market-agent-mm-tape li"));
    const tapeText = panel.querySelector(".market-agent-mm-tape")?.textContent ?? "";
    expect(within(panel).getByText("2 stories")).toBeInTheDocument();
    expect(microRows).toHaveLength(2);
    expect(tapeText.match(/billion-dollar server company/g)).toHaveLength(1);
    expect(tapeText).toContain(formatExpectedMarketAgentDateTime("2026-06-11T11:50:00+08:00"));
    expect(tapeText).not.toContain(formatExpectedMarketAgentDateTime("2026-06-11T11:41:00+08:00"));
  });

  it("groups Macro Micro calendar events by driver instead of repeating internal gaps", () => {
    const calendarReplay: MarketAgentReplayResponse = {
      ...replay,
      replay: {
        ...replay.replay,
        news_items: [],
        calendar_events: [
          {
            title: "Initial Jobless Claims",
            scheduled_at: "2026-06-18T20:30:00+08:00",
            source: "Economic Calendar",
            impact: "Medium",
            review_status: "included",
            semantic_type: "calendar"
          },
          {
            title: "Continuing Jobless Claims",
            scheduled_at: "2026-06-18T20:30:00+08:00",
            source: "Economic Calendar",
            impact: "Medium",
            review_status: "included",
            semantic_type: "calendar"
          },
          {
            title: "Fed Balance Sheet",
            scheduled_at: "2026-06-19T04:30:00+08:00",
            source: "Economic Calendar",
            impact: "Low",
            review_status: "included",
            semantic_type: "calendar"
          },
          {
            title: "Reserve Balances with Federal Reserve Banks",
            scheduled_at: "2026-06-19T04:30:00+08:00",
            source: "Economic Calendar",
            impact: "Low",
            review_status: "included",
            semantic_type: "calendar"
          }
        ]
      }
    };
    const { container } = renderMarketAgentPage({
      replay: calendarReplay,
      selectedEvidence: null,
      driverAttention
    });

    fireEvent.click(screen.getByRole("button", { name: /^Driver Attention$/i }));

    const panel = container.querySelector("[data-qa='qa:market-agent:macro-micro:page']") as HTMLElement;
    const macroRows = Array.from(panel.querySelectorAll(".market-agent-mm-feed article"));
    const labels = macroRows.map((row) => row.querySelector("span")?.textContent?.trim());
    expect(labels.filter((label) => label === "Fed / rates")).toHaveLength(1);
    expect(labels.filter((label) => label === "Growth data")).toHaveLength(1);
    expect(panel.textContent).not.toContain("currency not recorded");
    expect(panel.textContent).not.toContain("impact not recorded");
  });

  it("uses Local AI short titles for Macro Micro small stories", () => {
    const summarizedReplay: MarketAgentReplayResponse = {
      ...replay,
      replay: {
        ...replay.replay,
        news_items: [
          {
            title: "Oil prices fall nearly 4% after U.S. Energy Secretary says Hormuz ship traffic is increasing and traders reassess regional supply risk",
            summary_title: "Oil slips on supply relief",
            summary: "Oil fell as Hormuz traffic normalization reduced one inflation-risk input for gold.",
            summary_source: "local_ai",
            published_at: "2026-06-13T23:56:00+08:00",
            source: "US Top News and Analysis",
            included: true,
            data_mode: "live_seen",
            semantic_type: "news"
          }
        ]
      }
    };
    const { container } = renderMarketAgentPage({
      replay: summarizedReplay,
      selectedEvidence: null,
      driverAttention
    });

    fireEvent.click(screen.getByRole("button", { name: /^Driver Attention$/i }));

    const panel = container.querySelector("[data-qa='qa:market-agent:macro-micro:page']") as HTMLElement;
    const tapeText = panel.querySelector(".market-agent-mm-tape")?.textContent ?? "";
    expect(tapeText).toMatch(/Oil slips on supply relief/i);
    expect(tapeText).not.toMatch(/Oil prices fall nearly 4% after U\.S\. Energy Secretary/i);
  });

  it("does not show chopped fallback headlines in Macro Micro stories", () => {
    const messyReplay: MarketAgentReplayResponse = {
      ...replay,
      replay: {
        ...replay.replay,
        news_items: [
          {
            title: "Inflation is set to top 4% for the rest of the year, economists say",
            published_at: "2026-06-09T21:50:00+08:00",
            source: "MarketWatch.com - Top Stories",
            data_mode: "backfilled",
            semantic_type: "news"
          },
          {
            title: "Oil prices fall as Trump tries to convince producers to increase supply",
            published_at: "2026-06-09T21:43:00+08:00",
            source: "US Top News and Analysis",
            data_mode: "backfilled",
            semantic_type: "news"
          },
          {
            title: "Markets are pricing in a rate hike by December as inflation remains sticky",
            published_at: "2026-06-09T20:10:00+08:00",
            source: "MarketWatch.com - Top Stories",
            data_mode: "backfilled",
            semantic_type: "news"
          },
          {
            title: "Strait of Hormuz traffic won't return to normal until end of the year, traders say",
            summary: "Strait of Hormuz traffic remains disrupted and traders expect normal flows only by year-end.",
            published_at: "2026-08-06T23:48:00+08:00",
            source: "US Top News and Analysis",
            data_mode: "backfilled",
            semantic_type: "news"
          },
          {
            title: "Iran announces end of military operations against Israel, but warns Lebanon strikes could trigger escalation",
            published_at: "2026-08-06T21:41:00+08:00",
            source: "US Top News and Analysis",
            data_mode: "backfilled",
            semantic_type: "news"
          },
          {
            title: "100 days of the Iran war: How global markets and the economy have been affected",
            published_at: "2026-08-06T14:20:00+08:00",
            source: "US Top News and Analysis",
            data_mode: "backfilled",
            semantic_type: "news"
          }
        ]
      }
    };
    const { container } = renderMarketAgentPage({
      replay: messyReplay,
      selectedEvidence: null,
      driverAttention
    });

    fireEvent.click(screen.getByRole("button", { name: /^Driver Attention$/i }));

    const panel = container.querySelector("[data-qa='qa:market-agent:macro-micro:page']") as HTMLElement;
    const microRows = Array.from(panel.querySelectorAll(".market-agent-mm-tape li"));
    expect(microRows).toHaveLength(6);
    expect(within(panel).getByText("6 stories")).toBeInTheDocument();
    expect(microRows.map((row) => row.querySelector("i")?.textContent)).toEqual(["01", "02", "03", "04", "05", "06"]);
    expect(panel.textContent).toMatch(/Inflation is set to top 4% for the rest of the year/i);
    expect(panel.textContent).toMatch(/Oil prices fall as Trump tries to convince producers/i);
    expect(panel.textContent).toMatch(/Markets are pricing in a rate hike by December/i);
    expect(panel.textContent).not.toMatch(/for the\s*(US Top|MarketWatch)/i);
    expect(panel.textContent).not.toMatch(/convince\s*US Top/i);
    expect(panel.textContent).not.toMatch(/by\s*MarketWatch/i);
    expect(panel.textContent).not.toContain("...");
    expect(panel.textContent).not.toMatch(/Sep 2026/i);
  });

  it("keeps Small Stories as news headlines instead of driver theme labels", () => {
    const themeAttention: MarketAgentDriverAttentionResponse = {
      ...driverAttention,
      states: [
        ...driverAttention.states,
        {
          driver_id: "theme:iran",
          label: "Iran",
          current_state: "emerging",
          priority: "temporary_event",
          relevance_score: 0.94,
          impact_percent: null,
          confidence: "low",
          activation_reason: "3 news / 2 sources / needs news, xauusd",
          deactivation_reason: "",
          last_confirmed_at: "",
          decay_deadline: "",
          data_mode: "live_seen"
        },
        {
          driver_id: "theme:hormuz",
          label: "Hormuz",
          current_state: "watching",
          priority: "temporary_event",
          relevance_score: 0.88,
          impact_percent: null,
          confidence: "low",
          activation_reason: "2 news / 1 source / needs news, xauusd",
          deactivation_reason: "",
          last_confirmed_at: "",
          decay_deadline: "",
          data_mode: "live_seen"
        }
      ]
    };
    const storyReplay: MarketAgentReplayResponse = {
      ...replay,
      replay: {
        ...replay.replay,
        news_items: [
          {
            title: "Oil climbs as U.S.-Iran conflict escalates and regional tensions mount",
            summary: "Oil climbed as regional tensions mounted.",
            published_at: "2026-06-11T14:40:00+08:00",
            source: "US Top News and Analysis",
            data_mode: "live_seen"
          },
          {
            title: "Kuwait closes airspace, Israel warns of launches from Lebanon after U.S strikes in Iran",
            summary: "Kuwait closed airspace after launches warning.",
            published_at: "2026-06-11T14:16:00+08:00",
            source: "US Top News and Analysis",
            data_mode: "live_seen"
          }
        ]
      }
    };
    const { container } = renderMarketAgentPage({
      replay: storyReplay,
      selectedEvidence: null,
      driverAttention: themeAttention
    });

    fireEvent.click(screen.getByRole("button", { name: /^Driver Attention$/i }));

    const panel = container.querySelector("[data-qa='qa:market-agent:macro-micro:page']") as HTMLElement;
    const tapeText = panel.querySelector(".market-agent-mm-tape")?.textContent ?? "";
    expect(tapeText).toMatch(/Oil climbs as U\.S\.-Iran conflict escalates/i);
    expect(tapeText).toMatch(/Kuwait closes airspace/i);
    expect(tapeText).not.toMatch(/\bIran\b\s*Emerging/i);
    expect(tapeText).not.toMatch(/\bHormuz\b\s*Watching/i);
  });

  it("parses ambiguous numeric news dates as day-month-year", () => {
    const ambiguousDateReplay: MarketAgentReplayResponse = {
      ...replay,
      replay: {
        ...replay.replay,
        news_items: [
          {
            title: "Oil prices fall nearly 4% after U.S. Energy Secretary says Hormuz ship traffic is increasing",
            published_at: "09-06-2026 23:56",
            source: "US Top News and Analysis",
            data_mode: "live_seen",
            semantic_type: "news"
          },
          {
            title: "Inflation is set to hit the highest level since 2023 and the Fed is back in the hot seat",
            published_at: "09-06-2026 21:50",
            source: "MarketWatch.com - Top Stories",
            data_mode: "live_seen",
            semantic_type: "news"
          }
        ]
      }
    };
    const { container } = renderMarketAgentPage({
      replay: ambiguousDateReplay,
      selectedEvidence: null,
      driverAttention
    });

    fireEvent.click(screen.getByRole("button", { name: /^Driver Attention$/i }));

    const panel = container.querySelector("[data-qa='qa:market-agent:macro-micro:page']") as HTMLElement;
    expect(panel).toBeTruthy();
    expect(panel.textContent).toMatch(/09 Jun 2026 23:56/i);
    expect(panel.textContent).toMatch(/09 Jun 2026 21:50/i);
    expect(panel.textContent).not.toMatch(/06 Sep 2026/i);
  });

  it("defaults Data Sources to Connect cTrader and Auto Local AI instead of raw setup forms", () => {
    renderMarketAgentPage();

    fireEvent.click(screen.getByRole("button", { name: /^Data Sources$/i }));

    expect(screen.getByText(/cTrader not connected/i)).toBeInTheDocument();
    expect(screen.queryByText(/Live feed active/i)).not.toBeInTheDocument();
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
    expect(screen.getByText(/Local AI needs a model/i)).toBeInTheDocument();
    expect(screen.getByText(/Download Qwen3\.5 4B once/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Auto$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Qwen3\.5 4B$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Qwen3\.5 0\.8B$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Rule-based only$/i })).toBeInTheDocument();
    expect(screen.getAllByText(/~2\.9 GB/i).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /Download Qwen3\.5 4B/i })).toBeInTheDocument();
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
      status: "runtime_missing",
      message: "Local AI runtime is not installed. Install Ollama manually, then return here.",
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

    expect(screen.getAllByText(/Ollama is not installed/i).length).toBeGreaterThanOrEqual(1);
    expect(
      screen.getAllByText(/prepare Ollama in the background|prepare it automatically in the background/i).length
    ).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("button", { name: /Download Qwen3\.5 4B/i })).toBeEnabled();
  });

  it("shows already downloaded Local AI models instead of asking for another download", async () => {
    const installedSetup: MarketAgentLLMSetupResponse = {
      ...localAiSetup,
      status: "model_ready",
      message: "Recommended model is installed.",
      installedModels: [{ name: "qwen3.5:4b", model: "qwen3.5:4b", size: 3389971840, source: "app_local_models" }]
    };
    const saveLLM = vi.fn(async (input) => ({
      ...llmConfig,
      llm: {
        ...llmConfig.llm!,
        ...input
      }
    }));

    renderMarketAgentPage({
      localAiSetup: installedSetup,
      onDetectLocalAI: async () => installedSetup,
      onSaveLLMConfig: saveLLM
    });
    fireEvent.click(screen.getByRole("button", { name: /^Data Sources$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Local AI$/i }));

    expect(screen.getByText(/Local AI is ready/i)).toBeInTheDocument();
    expect(screen.getByText(/No download is needed/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Qwen3\.5 4B/i).length).toBeGreaterThan(0);
    await waitFor(() =>
      expect(saveLLM).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: true,
          model: "qwen3.5:4b"
        })
      )
    );
    expect(screen.queryByRole("button", { name: /^Use this model$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Enable this model$/i })).not.toBeInTheDocument();
    expect(await screen.findByLabelText(/Using Qwen3\.5 4B/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Download Qwen3\.5 4B/i })).not.toBeInTheDocument();
  });

  it("shows runtime start when Ollama is stopped but the model is already installed", () => {
    const installedRuntimeStoppedSetup: MarketAgentLLMSetupResponse = {
      ...localAiSetup,
      status: "runtime_not_running",
      message: "Local AI runtime is installed but not running yet.",
      ollama: {
        installed: true,
        running: false,
        endpointReachable: false,
        endpoint: "http://127.0.0.1:21434",
        version: "0.12.6"
      },
      installedModels: [{ name: "qwen3.5:4b", model: "qwen3.5:4b", size: 3389971840, source: "app_local_models" }]
    };

    renderMarketAgentPage({ localAiSetup: installedRuntimeStoppedSetup });
    fireEvent.click(screen.getByRole("button", { name: /^Data Sources$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Local AI$/i }));

    expect(screen.getAllByText(/Ollama is not running/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/no model download is needed/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Start Local AI/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Download Qwen3\.5 4B/i })).not.toBeInTheDocument();
  });

  it("keeps the saved Local AI model selected after returning to the tab", () => {
    const installedSetup: MarketAgentLLMSetupResponse = {
      ...localAiSetup,
      status: "model_ready",
      message: "Recommended model is installed.",
      installedModels: [{ name: "qwen3.5:4b", model: "qwen3.5:4b", size: 3389971840, source: "app_local_models" }]
    };
    const savedLLMConfig: MarketAgentLLMConfigResponse = {
      ...llmConfig,
      llm: {
        ...llmConfig.llm!,
        enabled: true,
        model: "qwen3.5:4b",
        lastStatus: "model_ready"
      }
    };

    renderMarketAgentPage({
      localAiSetup: installedSetup,
      llmConfig: savedLLMConfig,
      onDetectLocalAI: async () => installedSetup
    });
    fireEvent.click(screen.getByRole("button", { name: /^Data Sources$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Local AI$/i }));

    expect(screen.getByLabelText(/Using Qwen3\.5 4B/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Use this model$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Enable this model$/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^cTrader$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Local AI$/i }));

    expect(screen.getByLabelText(/Using Qwen3\.5 4B/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Enable this model$/i })).not.toBeInTheDocument();
  });

  it("shows the actual Auto Local AI model when installed model differs from the recommendation", () => {
    const installedSetup: MarketAgentLLMSetupResponse = {
      ...localAiSetup,
      status: "model_ready",
      message: "A local model is installed.",
      recommendedModel: {
        name: "qwen3.5:0.8b",
        tier: "lightweight",
        label: "Lightweight",
        approximateSizeBytes: 650_000_000,
        diskLabel: "~650 MB",
        reason: "CPU-only machines can use the lightweight model."
      },
      installedModels: [{ name: "qwen3.5:4b", model: "qwen3.5:4b", size: 3389971840, source: "app_local_models" }]
    };

    renderMarketAgentPage({ localAiSetup: installedSetup, onDetectLocalAI: async () => installedSetup });
    fireEvent.click(screen.getByRole("button", { name: /^Data Sources$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Local AI$/i }));

    const autoOption = screen.getByRole("button", { name: /^Auto$/i });
    expect(within(autoOption).getByText(/Qwen3\.5 4B/i)).toBeInTheDocument();
    expect(within(autoOption).queryByText(/~650 MB/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Qwen3\.5 4B is available locally/i)).toBeInTheDocument();
  });

  it("treats an installed configured model as ready even when the recommendation differs", () => {
    const installedSetup: MarketAgentLLMSetupResponse = {
      ...localAiSetup,
      status: "model_ready",
      message: "Configured Local AI model is installed.",
      recommendedModel: {
        name: "qwen3.5:0.8b",
        tier: "lightweight",
        label: "Lightweight",
        approximateSizeBytes: 650_000_000,
        diskLabel: "~650 MB",
        reason: "CPU-only machines can use the lightweight model."
      },
      installedModels: [{ name: "qwen3.5:4b", model: "qwen3.5:4b", size: 3389971840, source: "ollama_runtime" }]
    };
    const savedLLMConfig: MarketAgentLLMConfigResponse = {
      ...llmConfig,
      llm: {
        ...llmConfig.llm!,
        enabled: true,
        model: "qwen3.5:4b",
        lastStatus: "model_ready"
      }
    };

    renderMarketAgentPage({
      localAiSetup: installedSetup,
      llmConfig: savedLLMConfig,
      onDetectLocalAI: async () => installedSetup
    });
    fireEvent.click(screen.getByRole("button", { name: /^Data Sources$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Local AI$/i }));

    expect(screen.getByText(/Local AI is ready/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Download Qwen3\.5 4B/i })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Using Qwen3\.5 4B/i)).toBeInTheDocument();
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

    expect(screen.getAllByText(/Needs quote adapter/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Live quote unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(/adapter cannot return live XAUUSD quotes/i)).toBeInTheDocument();
    expect(screen.getByText(/Quote step blocked/i)).toBeInTheDocument();
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
      fireEvent.click(screen.getByRole("button", { name: /Download Qwen3\.5 4B/i }));
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

  it("hides Local AI download progress once the model is ready", () => {
    renderMarketAgentPage({
      localAiSetup: {
        ok: true,
        available: true,
        status: "model_ready",
        message: "Configured Local AI model is installed.",
        ollama: {
          installed: true,
          running: true,
          endpointReachable: true,
          endpoint: "http://127.0.0.1:11434",
          version: "0.12.6"
        },
        installedModels: [{ name: "qwen3.5:4b", model: "qwen3.5:4b", size: 3389971840, source: "app_local_models" }],
        recommendedModel: { name: "qwen3.5:4b", diskLabel: "~2.9 GB" },
        profiles: [{ name: "qwen3.5:4b", diskLabel: "~2.9 GB" }],
        llm: {
          enabled: true,
          provider: "ollama",
          endpoint: "http://127.0.0.1:11434",
          model: "qwen3.5:4b",
          temperature: 0,
          timeoutSeconds: 60,
          keepAlive: "5m",
          maxContext: 8192
        }
      },
      localAiPullProgress: {
        ok: true,
        model: "qwen3.5:4b",
        status: "preparing runtime",
        message: "Preparing Local AI runtime...",
        percent: 5,
        done: false
      }
    });
    fireEvent.click(screen.getByRole("button", { name: /^Data Sources$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Local AI$/i }));

    expect(screen.getByText(/Local AI is ready/i)).toBeInTheDocument();
    expect(screen.queryByText(/Preparing Local AI runtime/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Cancel download/i })).not.toBeInTheDocument();
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
      fireEvent.click(screen.getByRole("button", { name: /Download Qwen3\.5 4B/i }));
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

  it("does not show an auto monitoring countdown when the monitor loop is stopped", () => {
    renderMarketAgentPage({
      monitorStatus: {
        ...monitorStatus,
        available: true,
        running: false,
        phase: "stopped",
        lastRunAt: "2026-06-13T12:00:00+08:00",
        nextRunAt: null
      }
    });

    const nextUpdateCard = screen.getByRole("heading", { name: /Next Update/i }).closest("article");
    expect(nextUpdateCard).toHaveTextContent(/Monitoring stopped/i);
    expect(nextUpdateCard).toHaveTextContent(/Last check/i);
    expect(nextUpdateCard).not.toHaveTextContent(/Auto monitoring/i);
    expect(nextUpdateCard).not.toHaveTextContent(/Every 60 seconds/i);
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

    expect(screen.getByText(/Month: Latest First/i)).toBeInTheDocument();
    expect(screen.queryByText(/^backfill$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^unknown$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Alert$/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Yields pressure/i)).toBeInTheDocument();
    expect(screen.getByText(/3 major turns/i)).toBeInTheDocument();
    expect(screen.getByText(/XAUUSD drop -0\.49%/i)).toBeInTheDocument();
    expect(screen.getAllByText(/US yields · Monitor timeline/i)).toHaveLength(2);
    expect(screen.queryAllByText(/^yields$/i)).toHaveLength(0);
  });

  it("keeps internal context review status out of replay timelines", () => {
    const contextReviewReplay: MarketAgentReplayResponse = {
      ...replay,
      replay: {
        ...replay.replay,
        timeline_events: [
          {
            monitor_run_id: 101,
            event_time: "2026-06-18T05:28:00+08:00",
            event_type: "context_review",
            label: "market_context",
            payload: {
              semantic_type: "context_review",
              trade_conclusion: false,
              data_mode: "unavailable",
              summary_title: "Market context reviewed",
              summary: "A current XAUUSD trade read needs fresh live price and recent price history.",
              causal_chain: "A current XAUUSD trade read needs fresh live price and recent price history.",
              main_driver: "unknown",
              cause_status: "unconfirmed",
              news_count: 15,
              calendar_count: 14
            }
          },
          {
            monitor_run_id: 102,
            event_time: "2026-06-18T06:02:00+08:00",
            event_type: "context_review",
            label: "market_context",
            payload: {
              semantic_type: "context_review",
              trade_conclusion: false,
              data_mode: "unavailable",
              summary_title: "Market context reviewed",
              summary: "A current XAUUSD trade read needs fresh live price and recent price history.",
              main_driver: "unknown",
              cause_status: "unconfirmed"
            }
          },
          {
            monitor_run_id: 103,
            event_time: "2026-06-18T08:05:00+08:00",
            event_type: "market_alert",
            label: "Yields pressure",
            payload: {
              semantic_type: "breakout",
              impact_percent: -0.48,
              main_driver: "yields",
              summary: "Treasury yield pressure drove gold lower."
            }
          }
        ]
      }
    };

    renderMarketAgentPage({ replay: contextReviewReplay });

    expect(screen.queryByText(/A current XAUUSD trade read needs fresh live price/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Unknown$/i)).not.toBeInTheDocument();
    expect(screen.getByText(/XAUUSD drop -0\.48%/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Replay \/ Timeline/i }));

    expect(screen.queryByText(/A current XAUUSD trade read needs fresh live price/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Unknown$/i)).not.toBeInTheDocument();
    expect(screen.getByText(/XAUUSD drop -0\.48%/i)).toBeInTheDocument();
  });

  it("prefers AI-compressed evidence summaries in the dashboard feed", () => {
    const summarizedReplay: MarketAgentReplayResponse = {
      ...replay,
      replay: {
        ...replay.replay,
        news_items: [
          {
            ...replay.replay.news_items[0],
            summary_title: "Fed rate signal keeps gold under pressure",
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
    expect(within(latestEvidencePanel as HTMLElement).getByText(/Fed rate signal keeps gold under pressure/i)).toBeInTheDocument();
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

  it("orders replay markers by event time from newest to oldest", () => {
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
            monitor_run_id: 303,
            event_time: "17-06-2026 21:30 +08:00",
            event_type: "analysis",
            label: "Mixed format evening calendar",
            payload: { semantic_type: "evidence", impact_percent: -0.22, main_driver: "usd" }
          },
          {
            monitor_run_id: 304,
            event_time: "2026-06-18T05:26:00+08:00",
            event_type: "analysis",
            label: "Next morning stock headline",
            payload: { semantic_type: "evidence", impact_percent: -0.23, main_driver: "risk_sentiment" }
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

    const replayRows = Array.from(document.querySelectorAll(".market-agent-replay-track-row"));
    const rowText = replayRows.map((row) => row.textContent ?? "").join("\n");
    const nextMorningIndex = replayRows.findIndex((row) => row.textContent?.includes("Next morning stock headline"));
    const mixedEveningIndex = replayRows.findIndex((row) => row.textContent?.includes("Mixed format evening calendar"));
    const laterIndex = replayRows.findIndex((row) => row.textContent?.includes("Later yield pressure"));
    const earlierIndex = replayRows.findIndex((row) => row.textContent?.includes("Earlier dollar pressure"));
    expect(rowText).toContain("Next morning stock headline");
    expect(rowText).toContain("Mixed format evening calendar");
    expect(rowText).toContain("Later yield pressure");
    expect(rowText).toContain("Earlier dollar pressure");
    expect(nextMorningIndex).toBeLessThan(mixedEveningIndex);
    expect(mixedEveningIndex).toBeLessThan(laterIndex);
    expect(laterIndex).toBeLessThan(earlierIndex);
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
      fireEvent.click(screen.getByRole("button", { name: /Download Qwen3\.5 4B/i }));
    });

    expect(installModel).toHaveBeenCalledWith("qwen3.5:4b");
    expect(screen.queryByText(/Advanced model settings/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Model$/i)).not.toBeInTheDocument();
    expect(screen.getByText(/JSON or benchmark validation failed/i)).toBeInTheDocument();
  });

  it("supports the guided setup path from cTrader CLI credentials through Local AI model install", async () => {
    const startCTraderConnect = vi.fn().mockResolvedValue({
      ok: true,
      status: "waiting_for_live_connector",
      message: "cTrader account is connected. Live streaming is waiting for the long-running connector snapshot; cTrader CLI cBot streaming is disabled to avoid external algo host windows.",
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
      fireEvent.click(screen.getByRole("button", { name: /Download Qwen3\.5 4B/i }));
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
    expect(screen.queryByText(/bearish_gold/i)).not.toBeInTheDocument();
    expect(screen.getAllByText(/Drop/i).length).toBeGreaterThan(0);
    expect(screen.getByText("Move Size")).toBeInTheDocument();
    expect(screen.getAllByText(/US yields/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/WTI Oil/i)).not.toBeInTheDocument();
    expect(screen.getAllByText(/cTrader \(Spot\)/i).length).toBeGreaterThan(0);
    expect(screen.queryByText("futures_proxy")).not.toBeInTheDocument();
    expect(screen.queryByText("core_structural")).not.toBeInTheDocument();
    expect(screen.queryByText("main_driver usd -> yields")).not.toBeInTheDocument();
    expect(screen.queryByText(/Using Yahoo GC=F futures proxy, not true spot XAUUSD\./i)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /XAUUSD \(Spot\)/i })).toBeInTheDocument();
    expect(screen.getByText(/cTrader \(Spot\)/i)).toBeInTheDocument();
    expect(screen.getAllByText(/100%/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/View Full Timeline/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Rates/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/US session opens/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Raw details/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: /Yields pressure/i })[0]);
    const replayDetail = await screen.findByRole("dialog", { name: /Market item detail/i });
    expect(replayDetail).toHaveTextContent(/Yields pressure/i);
    expect(selected).toEqual([]);
    fireEvent.click(within(replayDetail).getByRole("button", { name: /Open evidence run/i }));
    expect(selected).toEqual([23]);

    fireEvent.click(screen.getByRole("button", { name: /^Evidence$/i }));
    expect(screen.getAllByText(/Accepted candidates/i).length).toBeGreaterThan(0);
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
    expect(screen.getByRole("button", { name: /Download Qwen3\.5 4B/i })).toBeInTheDocument();
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
    const repeatedNewsReplay: MarketAgentReplayResponse = {
      ...replay,
      replay: {
        ...replay.replay,
        news_items: [
          {
            title: "Fed headline",
            published_at: "2026-05-19T12:03:00+08:00",
            first_seen_at: "2026-05-19T12:05:00+08:00",
            source: "Reuters",
            data_mode: "backfilled",
            semantic_type: "news",
            impact_percent: -0.21,
            included: false,
            review_status: "filtered"
          },
          {
            title: "Fed headline",
            published_at: "2026-05-19T12:03:00+08:00",
            first_seen_at: "2026-05-19T12:19:00+08:00",
            source: "Reuters",
            data_mode: "backfilled",
            semantic_type: "news",
            impact_percent: -0.21,
            included: false,
            review_status: "filtered",
            summary_source: "Local AI",
            summary: "Repeated headline should render once in History."
          }
        ]
      }
    };
    renderMarketAgentPage({
      replay: repeatedNewsReplay,
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
            ],
            telemetry: [
              {
                task: "cause_review",
                status: "ok",
                model: "qwen3.5:4b",
                elapsed_ms: 1840,
                total_duration_ms: 1630,
                input_tokens: 740,
                output_tokens: 92,
                tokens_per_second: 56.44
              },
              {
                task: "display_summary",
                status: "ok",
                model: "qwen3.5:4b",
                elapsed_ms: 920,
                total_duration_ms: 780,
                input_tokens: 280,
                output_tokens: 44,
                tokens_per_second: 56.41
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
    const sourceGroups = within(agentActivity).getByLabelText(/Source groups/i);
    const backToMap = () => fireEvent.click(within(agentActivity).getByRole("button", { name: /Back to signal map/i }));

    expect(within(agentActivity).getByText(/Signal Map/i)).toBeInTheDocument();
    expect(within(agentActivity).getByRole("button", { name: /Assets/i })).toBeInTheDocument();
    expect(within(agentActivity).getAllByRole("button", { name: /News/i }).length).toBeGreaterThan(0);
    expect(within(agentActivity).getByRole("button", { name: /Calendar/i })).toBeInTheDocument();
    expect(within(agentActivity).getByRole("button", { name: /AI Analysis/i })).toBeInTheDocument();
    expect(within(agentActivity).getByRole("button", { name: /^Outputs:/i })).toBeInTheDocument();
    expect(within(agentActivity).getByRole("button", { name: /^Feedback:/i })).toBeInTheDocument();
    expect(within(agentActivity).getAllByText(/Storage/i).length).toBeGreaterThan(0);
    expect(within(agentActivity).getAllByText(/market_agent_timeline\.sqlite/i).length).toBeGreaterThan(0);
    expect(within(agentActivity).queryByRole("button", { name: /DXY|US2Y|WTI/i })).not.toBeInTheDocument();

    fireEvent.click(within(agentActivity).getByRole("button", { name: /^Storage:/i }));
    const storageDetail = within(agentActivity).getByRole("complementary", { name: /Storage detail view/i });
    fireEvent.click(within(storageDetail).getByRole("button", { name: /^Status$/i }));
    expect(within(storageDetail).getByText(/Persisted audit stores/i)).toBeInTheDocument();
    expect(within(storageDetail).getAllByText(/Raw collected/i).length).toBeGreaterThan(0);
    expect(within(storageDetail).getAllByText(/Processed \/ derived/i).length).toBeGreaterThan(0);
    backToMap();

    fireEvent.click(within(within(agentActivity).getByLabelText(/Source groups/i)).getByRole("button", { name: /Assets/i }));
    const assetsDetail = within(agentActivity).getByRole("complementary", { name: /Assets detail view/i });
    expect(within(assetsDetail).getByText(/Step detail/i)).toBeInTheDocument();
    expect(within(assetsDetail).getByRole("button", { name: /^Summary$/i })).toBeInTheDocument();
    expect(within(assetsDetail).getByRole("button", { name: /^Status$/i })).toBeInTheDocument();
    expect(within(assetsDetail).getByRole("button", { name: /^Needs$/i })).toBeInTheDocument();
    expect(within(assetsDetail).getByText(/Received/i)).toBeInTheDocument();
    expect(within(assetsDetail).getByText(/Handling/i)).toBeInTheDocument();
    expect(within(assetsDetail).getAllByText(/Stored/i).length).toBeGreaterThan(0);
    expect(within(assetsDetail).getByText(/Selected path/i)).toBeInTheDocument();
    expect(within(assetsDetail).getByText(/provider mapping and allowlists/i)).toBeInTheDocument();
    expect(within(assetsDetail).queryByText(/Why users should care/i)).not.toBeInTheDocument();
    fireEvent.click(within(assetsDetail).getByRole("button", { name: /^Status$/i }));
    expect(within(assetsDetail).getByText(/Current records and status/i)).toBeInTheDocument();
    expect(within(assetsDetail).getAllByText(/Source/i).length).toBeGreaterThan(0);
    expect(within(assetsDetail).getAllByText(/Used by/i).length).toBeGreaterThan(0);
    expect(within(assetsDetail).getAllByText(/market_price_bars/i).length).toBeGreaterThan(0);
    expect(within(assetsDetail).getAllByText(/related_asset_bars/i).length).toBeGreaterThan(0);
    expect(within(assetsDetail).getAllByText(/Tracked assets/i).length).toBeGreaterThan(0);
    expect(within(assetsDetail).getAllByText(/^XAUUSD$/i).length).toBeGreaterThan(0);
    expect(within(assetsDetail).getAllByText(/^DXY$/i).length).toBeGreaterThan(0);
    expect(within(assetsDetail).getAllByText(/^US10Y$/i).length).toBeGreaterThan(0);
    expect(within(assetsDetail).getAllByText(/^US2Y$/i).length).toBeGreaterThan(0);
    expect(within(assetsDetail).getAllByText(/unavailable/i).length).toBeGreaterThan(0);
    expect(within(assetsDetail).getAllByText(/Evidence gate \+ Driver Attention \+ Latest Evidence \+ Replay/i).length).toBeGreaterThan(0);
    expect(within(assetsDetail).queryByText(/What is blocking or being watched/i)).not.toBeInTheDocument();
    fireEvent.click(within(assetsDetail).getByRole("button", { name: /^Needs$/i }));
    expect(within(assetsDetail).getByText(/What is blocking or being watched/i)).toBeInTheDocument();
    expect(within(assetsDetail).getAllByText(/blocking/i).length).toBeGreaterThan(0);
    expect(within(assetsDetail).getAllByText(/need refresh/i).length).toBeGreaterThan(0);
    expect(within(assetsDetail).getAllByText(/watched/i).length).toBeGreaterThan(0);
    expect(within(assetsDetail).getByText(/^Action needed$/i)).toBeInTheDocument();
    expect(within(assetsDetail).getByText(/Provider status not reported/i)).toBeInTheDocument();
    expect(within(assetsDetail).getAllByText(/^US2Y$/i).length).toBeGreaterThan(0);
    expect(within(assetsDetail).getAllByText(/Evidence gate/i).length).toBeGreaterThan(0);
    expect(within(assetsDetail).queryByText(/Feedback loop/i)).not.toBeInTheDocument();
    backToMap();

    fireEvent.click(within(within(agentActivity).getByLabelText(/Source groups/i)).getByRole("button", { name: /^News:/i }));
    const newsDetail = within(agentActivity).getByRole("complementary", { name: /News detail view/i });
    expect(within(newsDetail).getByRole("button", { name: /^History$/i })).toBeInTheDocument();
    fireEvent.click(within(newsDetail).getByRole("button", { name: /^History$/i }));
    expect(within(newsDetail).getByRole("list", { name: /News history rows/i })).toBeInTheDocument();
    expect(within(newsDetail).queryByText(/Captured records/i)).not.toBeInTheDocument();
    expect(within(newsDetail).queryByText(/Captured headlines/i)).not.toBeInTheDocument();
    expect(within(newsDetail).queryByText(/No body or summary was recorded/i)).not.toBeInTheDocument();
    expect(within(newsDetail).queryByText(/^Used by$/i)).not.toBeInTheDocument();
    expect(within(newsDetail).getByText(/^Fed headline$/i)).toBeInTheDocument();
    expect(within(newsDetail).getAllByRole("button", { name: /Fed headline history record/i })).toHaveLength(1);
    expect(within(newsDetail).getByText(/^Published$/i)).toBeInTheDocument();
    expect(within(newsDetail).getAllByText(/\d{2} [A-Z][a-z]{2} 2026 \d{2}:\d{2} UTC/).length).toBeGreaterThan(0);
    expect(within(newsDetail).getByText(/AI summarized/i)).toBeInTheDocument();
    expect(within(newsDetail).queryByText("2026-05-19T12:03:00+08:00")).not.toBeInTheDocument();
    fireEvent.click(within(newsDetail).getByRole("button", { name: /Fed headline history record/i }));
    const newsHistoryDialog = within(newsDetail).getByRole("dialog", { name: /Fed headline history detail/i });
    expect(within(newsHistoryDialog).getByText(/AI summarized/i)).toBeInTheDocument();
    expect(within(newsHistoryDialog).getByText(/published_at/i)).toBeInTheDocument();
    expect(within(newsHistoryDialog).getByText(/Captured 2 times/i)).toBeInTheDocument();
    expect(within(newsHistoryDialog).getByText(/^2$/i)).toBeInTheDocument();
    fireEvent.click(within(newsHistoryDialog).getByRole("button", { name: /Close history detail/i }));
    fireEvent.click(within(newsDetail).getByRole("button", { name: /^Status$/i }));
    expect(within(newsDetail).getByText(/Configured news feeds/i)).toBeInTheDocument();
    expect(within(newsDetail).getByText(/Federal Reserve press feed/i)).toBeInTheDocument();
    expect(within(newsDetail).getByText(/CNBC Top News RSS/i)).toBeInTheDocument();
    expect(within(newsDetail).getByText(/MarketWatch Top Stories RSS/i)).toBeInTheDocument();
    expect(within(newsDetail).queryByText(/ForexFactory/i)).not.toBeInTheDocument();
    fireEvent.click(within(newsDetail).getByRole("button", { name: /^Summary$/i }));
    expect(within(newsDetail).getByText(/News processing \+ Storage \+ Evidence review/i)).toBeInTheDocument();
    fireEvent.click(within(newsDetail).getByRole("button", { name: /^Status$/i }));
    expect(within(newsDetail).getAllByText(/Raw capture/i).length).toBeGreaterThan(0);
    expect(within(newsDetail).getByText(/Dedupe \/ source scoring/i)).toBeInTheDocument();
    expect(within(newsDetail).getAllByText(/Theme extraction/i).length).toBeGreaterThan(0);
    expect(within(newsDetail).getAllByText(/Evidence candidate/i).length).toBeGreaterThan(0);
    backToMap();

    fireEvent.click(within(within(agentActivity).getByLabelText(/Source groups/i)).getByRole("button", { name: /Calendar/i }));
    const calendarDetail = within(agentActivity).getByRole("complementary", { name: /Calendar detail view/i });
    fireEvent.click(within(calendarDetail).getByRole("button", { name: /^Status$/i }));
    expect(within(calendarDetail).getByText(/Calendar event windows/i)).toBeInTheDocument();
    expect(within(calendarDetail).getAllByText(/existing Economic Calendar/i).length).toBeGreaterThan(0);
    expect(within(calendarDetail).getByText(/Window alignment/i)).toBeInTheDocument();
    expect(within(calendarDetail).getByText(/evidence_packets/i)).toBeInTheDocument();
    expect(within(calendarDetail).getByText(/Calendar context rows/i)).toBeInTheDocument();
    expect(within(calendarDetail).getByText(/US session opens/i)).toBeInTheDocument();
    backToMap();

    fireEvent.click(within(agentActivity).getByRole("button", { name: /AI Analysis/i }));
    const aiDetail = within(agentActivity).getByRole("complementary", { name: /AI Analysis detail view/i });
    expect(within(aiDetail).getByRole("button", { name: /^Map$/i })).toBeInTheDocument();
    expect(within(aiDetail).getByRole("button", { name: /^Ongoing$/i })).toBeInTheDocument();
    expect(within(aiDetail).getByRole("button", { name: /^History$/i })).toBeInTheDocument();
    expect(within(aiDetail).getByRole("button", { name: /^Status$/i })).toBeInTheDocument();
    expect(within(aiDetail).getByRole("button", { name: /^Needs$/i })).toBeInTheDocument();
    expect(within(aiDetail).getByText(/AI Performance/i)).toBeInTheDocument();
    expect(within(aiDetail).getAllByText(/56\.44 token\/s/i).length).toBeGreaterThan(0);
    expect(within(aiDetail).getByText(/2 Local AI call/i)).toBeInTheDocument();
    fireEvent.click(within(aiDetail).getByRole("button", { name: /^Ongoing$/i }));
    expect(within(aiDetail).getByText(/What AI is working on now/i)).toBeInTheDocument();
    expect(within(aiDetail).getByRole("table", { name: /Current AI work filings/i })).toBeInTheDocument();
    expect(within(aiDetail).queryByRole("row", { name: /Feedback/i })).not.toBeInTheDocument();
    expect(within(aiDetail).getByRole("row", { name: /History/i })).toBeInTheDocument();
    fireEvent.click(within(aiDetail).getByRole("button", { name: /^History$/i }));
    expect(within(aiDetail).getByRole("heading", { name: /Local AI call audit/i })).toBeInTheDocument();
    expect(within(aiDetail).getAllByText(/Driver cause review/i).length).toBeGreaterThan(0);
    expect(within(aiDetail).getByText(/Yields \/ Likely/i)).toBeInTheDocument();
    expect(within(aiDetail).getByText(/Usd \/ Possible/i)).toBeInTheDocument();
    expect(within(aiDetail).getByText(/stored Local AI validated analysis result/i)).toBeInTheDocument();
    expect(within(aiDetail).getAllByText(/AI Validated/i).length).toBeGreaterThan(0);
    expect(within(aiDetail).getAllByText(/\d{2} [A-Z][a-z]{2} 2026 \d{2}:\d{2} UTC/).length).toBeGreaterThan(0);
    expect(within(aiDetail).queryByText(/^Cause review$/i)).not.toBeInTheDocument();
    expect(within(aiDetail).queryByText(/^Display summary$/i)).not.toBeInTheDocument();
    expect(within(aiDetail).queryByText(/2026-06-08T00:21:07\.718468\+08:00/i)).not.toBeInTheDocument();
    expect(within(aiDetail).queryByText(/Raw: Fed headline -> Summary: no AI summary recorded for this item/i)).not.toBeInTheDocument();
    expect(within(aiDetail).queryByText(/Calendar review/i)).not.toBeInTheDocument();
    expect(within(aiDetail).queryByText(/Asset context/i)).not.toBeInTheDocument();
    expect(within(aiDetail).queryByText(/Final analysis/i)).not.toBeInTheDocument();
    expect(within(aiDetail).queryByText(/Notification sent/i)).not.toBeInTheDocument();
    expect(within(aiDetail).queryByText(/Notification suppressed/i)).not.toBeInTheDocument();
    expect(within(aiDetail).queryByText(/Input history/i)).not.toBeInTheDocument();
    expect(within(aiDetail).queryByText(/AI decisions/i)).not.toBeInTheDocument();
    expect(within(aiDetail).queryByText(/User-facing history/i)).not.toBeInTheDocument();
    fireEvent.click(within(aiDetail).getByRole("button", { name: /^Status$/i }));
    expect(within(aiDetail).getByText(/Driver gate/i)).toBeInTheDocument();
    expect(within(aiDetail).getByText(/Input evidence status/i)).toBeInTheDocument();
    expect(within(aiDetail).getByText(/show what can be used now and what is blocked/i)).toBeInTheDocument();
    expect(within(aiDetail).getAllByText(/^usable$/i).length).toBeGreaterThan(0);
    expect(within(aiDetail).getByText(/Not confirming means present but not usable as confirmation/i)).toBeInTheDocument();
    expect(within(aiDetail).getByText(/Driver lifecycle/i)).toBeInTheDocument();
    expect(within(aiDetail).getByText(/LLM analysis/i)).toBeInTheDocument();
    expect(within(aiDetail).getAllByText(/Validator guard/i).length).toBeGreaterThan(0);
    expect(within(aiDetail).getByText(/Notification policy/i)).toBeInTheDocument();
    expect(within(aiDetail).getAllByText(/US2Y/i).length).toBeGreaterThan(0);
    expect(within(aiDetail).queryByText(/What is blocking or being watched/i)).not.toBeInTheDocument();
    fireEvent.click(within(aiDetail).getByRole("button", { name: /^Needs$/i }));
    expect(within(aiDetail).getByText(/What is blocking or being watched/i)).toBeInTheDocument();
    expect(within(aiDetail).getAllByText(/Limits confidence/i).length).toBeGreaterThan(0);
    expect(within(aiDetail).getAllByText(/without promoting it to active/i).length).toBeGreaterThan(0);
    backToMap();

    fireEvent.click(within(agentActivity).getByRole("button", { name: /^Outputs:/i }));
    const outputsDetail = within(agentActivity).getByRole("complementary", { name: /Outputs detail view/i });
    fireEvent.click(within(outputsDetail).getByRole("button", { name: /^Status$/i }));
    expect(within(outputsDetail).getByText(/Per-run trace/i)).toBeInTheDocument();
    expect(within(outputsDetail).getAllByText(/Source rows/i).length).toBeGreaterThan(0);
    expect(within(outputsDetail).getAllByText(/Telegram delivery/i).length).toBeGreaterThan(0);
    expect(within(outputsDetail).getByText(/Notification suppressed/i)).toBeInTheDocument();
    expect(within(outputsDetail).getByText(/Suppressed candidate: Suppressed duplicate/i)).toBeInTheDocument();
    expect(within(outputsDetail).getByText(/No current live alert passed the gate/i)).toBeInTheDocument();
    expect(screen.queryByText(/Background activity/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/News feeds not configured|No news provider configured/i)).not.toBeInTheDocument();
  });

  it("shows a clear AI performance empty state when Local AI did not run", () => {
    renderMarketAgentPage();

    fireEvent.click(screen.getByRole("button", { name: /^Activity$/i }));
    const agentActivity = screen.getByLabelText(/Agent activity board/i);
    fireEvent.click(within(agentActivity).getByRole("button", { name: /AI Analysis/i }));
    const aiDetail = within(agentActivity).getByRole("complementary", { name: /AI Analysis detail view/i });

    expect(within(aiDetail).getByText(/AI Performance/i)).toBeInTheDocument();
    expect(within(aiDetail).getByText(/No Local AI call ran in this selected run/i)).toBeInTheDocument();
    expect(within(aiDetail).getByText(/0 calls recorded/i)).toBeInTheDocument();
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
    expect(screen.getByText(/RANGEBOUND/i)).toBeInTheDocument();
    expect(screen.queryByText(/AWAITING LIVE PRICE/i)).not.toBeInTheDocument();
    expect(screen.getAllByText(/No live price/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Big picture/i).length).toBeGreaterThan(0);
    expect(screen.queryByText("LOCAL_CSV_FALLBACK")).not.toBeInTheDocument();
  });

  it("pauses only current conclusions when XAUUSD is not live cTrader spot", () => {
    renderMarketAgentPage({
      providerHealth: localCsvProviderHealth,
      driverAttention,
      selectedEvidence: evidence
    });

    expect(screen.getAllByText(/No live price/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/TRENDING DOWN/i)).toBeInTheDocument();
    expect(screen.queryByText(/AWAITING LIVE PRICE/i)).not.toBeInTheDocument();
    expect(screen.getAllByText(/Fed headline/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Big picture/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Big picture/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Small stories/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/market context item.*reviewed/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/US10Y fresh and supporting the move/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/No accepted evidence yet/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Driver Attention$/i }));
    expect(screen.getByRole("heading", { name: /^Macro \/ Micro Watch$/i })).toBeInTheDocument();
    expect(screen.getAllByText(/Rates/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Driver scores hidden/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Required price inputs/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Context still watched/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Blocked$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Watching$/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Evidence$/i }));
    expect(screen.getByText(/Market read forming/i)).toBeInTheDocument();
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
    expect(screen.getAllByText(/Big picture/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Fed headline/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Australia - King's Birthday/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Evidence Status:/i)).toBeInTheDocument();
    expect(screen.getAllByText(/No current conclusion/i).length).toBeGreaterThan(0);
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
            reason: "XAUUSD market is closed; news, calendar, and cross-market context keep updating, and the next trade read resumes when fresh XAUUSD price action returns.",
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

    expect(screen.getByText(/TRENDING DOWN/i)).toBeInTheDocument();
    expect(screen.queryByText(/OBSERVING PRICE/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/No trade call/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^No trade call yet$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Watching$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/No reviewed move/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Current conclusion is paused/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/US10Y fresh and supporting the move/i)).not.toBeInTheDocument();
  });

  it("uses a stored current market read even when snapshot state is not populated yet", () => {
    const currentReadEvidence: MarketAgentEvidenceForRunResponse = {
      ...evidence,
      payload: {
        ...evidence.payload,
        evidence_packet: {
          ...evidence.payload.evidence_packet,
          evidence_chain_status: {
            status: "context_only",
            can_show_current_conclusion: false,
            reason: "Current state snapshot has not caught up yet.",
            missing_required: [],
            usable_inputs: ["live_xauusd_spot", "xauusd_recent_history", "news_context"],
            context_only_inputs: []
          },
          market_read: {
            status: "current_read",
            headline: "Yields are pressuring gold",
            thesis: "Gold is trading lower as yields and the dollar firm.",
            driver: "yields",
            driver_label: "Yields",
            cause_status: "likely",
            confidence: "medium",
            move: {
              impact_percent: -0.47,
              detected_at: "2026-05-19T08:08:00+08:00"
            },
            evidence: {
              latest_news: ["Fed headline"],
              drivers: ["DXY confirming", "US10Y confirming"]
            }
          }
        }
      }
    };

    renderMarketAgentPage({
      snapshot: {
        ...snapshot,
        state: {
          ...snapshot.state,
          current_bias: "unknown",
          confidence: "",
          last_analysis_time: ""
        }
      },
      selectedEvidence: currentReadEvidence
    });

    expect(screen.getAllByText(/MARKET READ/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Drop/i)).toBeInTheDocument();
    expect(screen.getByText(/-0\.47%/i)).toBeInTheDocument();
    expect(screen.queryByText(/REVIEW PENDING/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/No conclusion yet/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Market read forming/i)).not.toBeInTheDocument();
  });

  it("uses market read latest news when the replay context has not caught up", () => {
    const marketReadEvidence: MarketAgentEvidenceForRunResponse = {
      ...evidence,
      payload: {
        ...evidence.payload,
        evidence_packet: {
          ...evidence.payload.evidence_packet,
          evidence_chain_status: {
            status: "ready",
            can_show_current_conclusion: true,
            missing_required: [],
            usable_inputs: ["live_xauusd_spot", "news_context"],
            context_only_inputs: []
          },
          market_read: {
            status: "current_read",
            headline: "Oil risk leads the gold read",
            driver: "oil_inflation",
            generated_at: "2026-06-13T23:08:00+08:00",
            evidence: {
              latest_news: [
                "Oil prices jump as Middle East supply risk returns",
                "Iran tensions keep energy markets on alert"
              ],
              confirming: ["DXY", "US10Y"]
            }
          }
        }
      }
    };

    renderMarketAgentPage({
      driverAttention: { ok: true, available: true, states: [] },
      replay: {
        ...replay,
        replay: {
          ...replay.replay,
          news_items: [],
          calendar_events: [],
          timeline_events: []
        }
      },
      selectedEvidence: marketReadEvidence
    });

    const radar = screen.getByLabelText("Macro Micro Watch");
    expect(within(radar).queryByText(/No macro story detected/i)).not.toBeInTheDocument();
    expect(within(radar).queryByText(/No micro story detected/i)).not.toBeInTheDocument();
    expect(within(radar).getByText(/Oil prices jump as Middle East supply risk returns/i)).toBeInTheDocument();
    expect(within(radar).getByText(/Oil prices jump as Middle East supply risk returns/i)).toBeInTheDocument();
  });

  it("uses a concrete headline for dashboard big picture instead of a generic driver phrase", () => {
    renderMarketAgentPage({
      driverAttention: { ok: true, available: true, states: [] },
      replay: {
        ...replay,
        replay: {
          ...replay.replay,
          news_items: [
            {
              title: "Treasury yields slide as Fed begins monetary policy meeting",
              summary: "U.S. Treasury yields fell on Tuesday as the Federal Reserve's two-day policy meeting kicked off.",
              source: "US Top News and Analysis",
              published_at: "2026-06-17T04:01:00+08:00",
              included: true,
              data_mode: "live_seen",
              semantic_type: "news"
            }
          ],
          calendar_events: [],
          timeline_events: []
        }
      },
      selectedEvidence: {
        ...evidence,
        payload: {
          ...evidence.payload,
          evidence_packet: {
            ...evidence.payload.evidence_packet,
            market_read: null,
            allowed_candidate_drivers: []
          }
        }
      }
    });

    const radar = screen.getByLabelText("Macro Micro Watch");
    const bigPicture = within(radar).getByLabelText("Big picture");
    expect(within(bigPicture).getByText(/Treasury yields slide as Fed begins monetary policy meeting/i)).toBeInTheDocument();
    expect(within(radar).queryByText(/Rates pressure remains the main gold test/i)).not.toBeInTheDocument();
    expect(within(radar).queryByText(/Dollar pressure is shaping the gold read/i)).not.toBeInTheDocument();
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
    expect(screen.getByText(/No macro story detected/i)).toBeInTheDocument();
    expect(screen.getByText(/No micro story detected/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Data Sources$/i }));
    expect(screen.getByText(/Provider config unavailable\./i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Provider Health$/i }));
    expect(screen.getByText(/Provider health unavailable\./i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Replay \/ Timeline/i }));
    expect(screen.getByText(/Replay unavailable\./i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Evidence$/i }));
    expect(screen.getByText(/Evidence unavailable\./i)).toBeInTheDocument();
  });

  it("summarizes configured news feeds in Provider Health instead of listing every feed", () => {
    renderMarketAgentPage({
      providerHealth: {
        ...providerHealth,
        items: [
          ...providerHealth.items,
          {
            provider_key: "news",
            source: "News",
            source_type: "news",
            data_mode: "unavailable",
            is_available: false,
            is_stale: false,
            raw_source_id: [
              "https://www.federalreserve.gov/feeds/press_all.xml",
              "https://www.cnbc.com/id/100003114/device/rss/rss.html",
              "https://www.marketwatch.com/rss/topstories"
            ].join("\n")
          }
        ]
      }
    });

    fireEvent.click(screen.getByRole("button", { name: /^Provider Health$/i }));
    const providerHealthView = screen.getByRole("heading", { name: /^Provider Health$/i }).closest("section");
    expect(providerHealthView).not.toBeNull();
    const view = within(providerHealthView as HTMLElement);
    expect(view.getByText(/News collector/i)).toBeInTheDocument();
    expect(view.getByText(/RSS feeds \/ 3 configured/i)).toBeInTheDocument();
    expect(view.queryByText(/Federal Reserve press feed/i)).not.toBeInTheDocument();
    expect(view.queryByText(/CNBC Top News RSS/i)).not.toBeInTheDocument();
    expect(view.queryByText(/MarketWatch Top Stories RSS/i)).not.toBeInTheDocument();
  });

  it("treats market-closed cross-market feeds as usable context in Provider Health", () => {
    renderMarketAgentPage({
      providerHealth: {
        ...providerHealth,
        items: [
          {
            provider_key: "xauusd",
            source: "cTrader",
            source_type: "spot",
            data_mode: "stale",
            is_available: true,
            is_stale: true,
            stale_reason: "XAUUSD is inside the weekend closed window; last cTrader quote is context only until the market reopens.",
            current_value: 4218.7,
            effective_status: "market_closed_context",
            usable_as_context: true
          },
          ...["dxy", "us10y", "us2y", "wti"].map((provider_key) => ({
            provider_key,
            source: provider_key.toUpperCase(),
            source_type: provider_key === "us2y" ? "yield_quote" : "proxy",
            data_mode: "live_seen",
            is_available: true,
            is_stale: true,
            stale_reason: "Latest chart point is older than freshness threshold.",
            effective_status: "market_closed_context",
            usable_as_context: true
          }))
        ]
      }
    });

    fireEvent.click(screen.getByRole("button", { name: /^Provider Health$/i }));
    const providerHealthView = screen.getByRole("heading", { name: /^Provider Health$/i }).closest("section");
    expect(providerHealthView).not.toBeNull();
    const view = within(providerHealthView as HTMLElement);
    expect(view.getByText(/Cross-market sensors/i)).toBeInTheDocument();
    expect(view.getByText(/4 of 4 feeds usable/i)).toBeInTheDocument();
    expect(view.getByText(/^Context$/i)).toBeInTheDocument();
    expect(view.queryByText(/^Partial$/i)).not.toBeInTheDocument();
  });
});


