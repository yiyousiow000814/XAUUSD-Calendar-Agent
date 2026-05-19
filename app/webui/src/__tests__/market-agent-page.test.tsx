import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

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
    clientIdMasked: "cl******id",
    clientSecretMasked: "cl********et",
    accessTokenMasked: "",
    refreshTokenMasked: "",
    hasAccessToken: false,
    hasRefreshToken: false,
    appRedirectUri: "",
    tokenStorePath: "user-data/ctrader-token.json",
    snapshotPath: "user-data/ctrader-last-quote.json",
    quoteTimeoutSeconds: 8,
    quoteStaleAfterSeconds: 15,
    allowSavedSnapshotFallback: true,
    bridgePythonExecutable: "python",
    configPath: "user-data/ctrader-openapi.json"
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
    model: "qwen3:4b",
    temperature: 0.1,
    timeoutSeconds: 20,
    keepAlive: "0",
    maxContext: 8192,
    configPath: "user-data/market-agent-llm.json",
    lastStatus: "disabled",
    lastError: ""
  }
};

const driverAttention: MarketAgentDriverAttentionResponse = {
  ok: true,
  available: true,
  monitor_run_id: 23,
  states: [
    {
      driver_id: "yields",
      current_state: "active",
      priority: "core_structural",
      relevance_score: 0.91,
      confidence: "medium_high",
      activation_reason: "US10Y fresh and confirming.",
      deactivation_reason: "",
      last_confirmed_at: "2026-05-19T08:05:00+08:00",
      decay_deadline: "2026-05-19T10:05:00+08:00",
      data_mode: "backfilled"
    },
    {
      driver_id: "oil_inflation",
      current_state: "cooling",
      priority: "conditional_macro",
      relevance_score: 0.42,
      confidence: "medium",
      activation_reason: "",
      deactivation_reason: "Oil stayed background only.",
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
        data_timestamp: "2026-05-19T08:00:00+08:00",
        close_price: 4504.8,
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
    news_items: [{ title: "Fed headline", published_at: "2026-05-19T07:55:00+08:00", source: "Reuters", data_mode: "backfilled" }],
    calendar_events: [{ title: "Fed speaker", scheduled_at: "2026-05-19T08:15:00+08:00", source: "ForexFactory", data_mode: "live_seen" }],
    driver_attention_timeline: [],
    timeline_events: [{ monitor_run_id: 23, event_time: "2026-05-19T08:05:00+08:00", event_type: "market_alert", label: "Yields pressure", payload: {} }],
    state_transitions: [{ monitor_run_id: 23, run_started_at: "2026-05-19T08:05:00+08:00", state_change_reason: "main_driver usd -> yields" }],
    alerts: [{ monitor_run_id: 23, run_started_at: "2026-05-19T08:05:00+08:00", should_notify: true, notification_level: "level_3", message: "XAUUSD dropped 0.48%" }],
    suppressed_alerts: [{ monitor_run_id: 24, run_started_at: "2026-05-19T08:20:00+08:00", should_notify: false, notification_level: "level_1", message: "Suppressed duplicate" }]
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

describe("MarketAgentPage", () => {
  it("renders a one-screen cockpit dashboard by default", () => {
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
        rangePreset="4h"
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
        onRefreshCTraderToken={async () => ({ ok: true })}
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

    expect(screen.getByRole("navigation", { name: /Market Agent sections/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Dashboard/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("heading", { name: /XAUUSD Price/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Market State/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Latest Move/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Evidence Status/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Next Update/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Driver Attention Summary/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Market Replay Today/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Latest Evidence/i })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Provider Health$/i }).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /Open Full Timeline/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /View Evidence/i })).toBeInTheDocument();
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

  it("switches cockpit sections from the left navigation", () => {
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
        rangePreset="4h"
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
        onRefreshCTraderToken={async () => ({ ok: true })}
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
    expect(screen.getByText(/Market Agent setup is incomplete\./i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Price$/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByLabelText(/Access Token/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Replay \/ Timeline/i }));
    expect(screen.getByText(/Open full replay/i)).toBeInTheDocument();
    expect(screen.getByText(/Price series/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Evidence$/i }));
    expect(screen.getByRole("heading", { name: /Evidence Panel/i })).toBeInTheDocument();
    expect(screen.getByText(/Raw details/i)).toBeInTheDocument();
  });

  it("renders a user-facing market agent page without primary raw enum labels", async () => {
    const selected: number[] = [];
    const refreshToken = vi.fn().mockResolvedValue({ ok: true, message: "cTrader access token refreshed and saved." });

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
        rangePreset="4h"
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
        onRefreshCTraderToken={refreshToken}
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
    expect(screen.getByText(/Bearish/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Drop/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Move Size:/i)).toBeInTheDocument();
    expect(screen.getAllByText(/US yields/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Oil \/ inflation/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Backup/i).length).toBeGreaterThan(0);
    expect(screen.queryByText("futures_proxy")).not.toBeInTheDocument();
    expect(screen.queryByText("core_structural")).not.toBeInTheDocument();
    expect(screen.queryByText("main_driver usd -> yields")).not.toBeInTheDocument();
    expect(screen.queryByText(/Using Yahoo GC=F futures proxy, not true spot XAUUSD\./i)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /XAUUSD Price/i })).toBeInTheDocument();
    expect(screen.getByText(/Backup price/i)).toBeInTheDocument();
    expect(screen.getByText(/80%/i)).toBeInTheDocument();
    expect(screen.getByText(/Open Full Timeline/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Fed headline/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Fed speaker/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Suppressed duplicate/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Raw details/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: /Yields pressure/i })[0]);
    expect(selected).toEqual([23]);

    fireEvent.click(screen.getByRole("button", { name: /^Evidence$/i }));
    expect(screen.getAllByText(/Allowed drivers/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Fed \/ rates/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/No direct headline/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Raw details/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Data Sources$/i }));
    expect(screen.getByRole("heading", { name: /^Data Sources$/i })).toBeInTheDocument();
    expect(screen.getByText(/Market Agent setup is incomplete\./i)).toBeInTheDocument();
    expect(screen.getAllByText(/Price source/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Market context/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/News/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Calendar/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Telegram/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Analysis/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Monitor loop/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Price source/i })).toBeInTheDocument();
    expect(screen.getByText(/Live XAUUSD price and missed-history recovery/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Access Token/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Refresh Token/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Config path:/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("navigation", { name: /Data source setup steps/i }).querySelectorAll("button")[1]);
    expect(screen.getByRole("heading", { name: /Connect cTrader/i })).toBeInTheDocument();
    expect(screen.getByText(/No cTrader password is needed/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Access Token/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Refresh Token/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Broker-specific options/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Bridge Python/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByText(/Broker-specific options/i));
    expect(screen.getByLabelText(/Refresh Token/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Bridge Python/i)).toBeInTheDocument();
    expect(screen.getByText(/Config path:/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("navigation", { name: /Data source setup steps/i }).querySelectorAll("button")[5]);
    expect(screen.getByRole("heading", { name: /Alerts/i })).toBeInTheDocument();
    expect(screen.getByText(/Telegram is optional/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Bot token/i)).toHaveAttribute("placeholder", "12********90");
    expect(screen.getByLabelText(/Chat ID/i)).toHaveValue("123456789");
    expect(screen.getByRole("button", { name: /Send Test Message/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("navigation", { name: /Data source setup steps/i }).querySelectorAll("button")[4]);
    expect(screen.getByRole("heading", { name: /Analysis/i })).toBeInTheDocument();
    expect(screen.getByText(/Optional local model/i)).toBeInTheDocument();
    expect(screen.getByText(/Rule-based/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Endpoint/i)).not.toBeVisible();
    expect(screen.getByRole("button", { name: /Test model/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Test JSON/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("navigation", { name: /Data source setup steps/i }).querySelectorAll("button")[6]);
    expect(screen.getByRole("heading", { name: /Start monitoring/i })).toBeInTheDocument();
    expect(screen.getByText(/Monitoring is stopped\./i)).toBeInTheDocument();
    expect(screen.queryByText(/Backfill & Recover runs one monitor pass/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Recovery fills missed data/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Check Now/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Start Monitoring/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Stop Monitoring/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Recover Missed Data/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("navigation", { name: /Data source setup steps/i }).querySelectorAll("button")[1]);
    expect(screen.getByRole("heading", { name: /Connect cTrader/i })).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Refresh Token/i }));
    });
    expect(refreshToken).toHaveBeenCalledTimes(1);
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
        rangePreset="1h"
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
        onRefreshCTraderToken={async () => ({ ok: true })}
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
        rangePreset="4h"
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
        onRefreshCTraderToken={async () => ({ ok: true })}
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
