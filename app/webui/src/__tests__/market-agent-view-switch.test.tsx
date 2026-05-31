import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({
  backend: {
    getSnapshot: vi.fn().mockResolvedValue({
      lastPull: "19-05-2026 08:00",
      lastSync: "19-05-2026 08:02",
      lastPullAt: "2026-05-19T08:00:00+08:00",
      lastSyncAt: "2026-05-19T08:02:00+08:00",
      outputDir: "",
      repoPath: "",
      currency: "USD",
      currencyOptions: ["USD"],
      events: [],
      pastEvents: [],
      logs: [],
      version: "0.3.0",
      modal: null,
      pullActive: false,
      syncActive: false,
      calendarStatus: "loaded",
      restartInSeconds: 0
    }),
    getSettings: vi.fn().mockResolvedValue({
      autoSyncAfterPull: false,
      autoUpdateEnabled: true,
      runOnStartup: false,
      autostartLaunchMode: "tray",
      closeBehavior: "tray",
      traySupported: true,
      debug: false,
      autoSave: true,
      splitRatio: 0.66,
      enableSystemTheme: false,
      theme: "dark",
      calendarTimezoneMode: "utc",
      calendarUtcOffsetMinutes: 0,
      enableTemporaryPath: false,
      temporaryPath: "",
      repoPath: "",
      logPath: ""
    }),
    getMarketAgentSnapshot: vi.fn().mockResolvedValue({
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
    }),
    getMarketAgentReplay: vi.fn().mockResolvedValue({
      ok: true,
      available: true,
      replay: {
        price_series: [],
        related_assets: {
          dxy: [],
          us10y: [],
          us2y: [],
          wti: [],
          brent: [],
          vix: [],
          spx: [],
          nasdaq: []
        },
        news_items: [],
        calendar_events: [],
        driver_attention_timeline: [],
        timeline_events: [],
        state_transitions: [],
        alerts: [],
        suppressed_alerts: []
      }
    }),
    getMarketAgentProviderHealth: vi.fn().mockResolvedValue({
      ok: true,
      available: true,
      items: [
        {
          provider_key: "xauusd",
          source: "cTrader",
          source_type: "spot_snapshot",
          data_mode: "snapshot",
          is_available: true,
          is_stale: true,
          current_value: 4479.12,
          stale_reason: "Loaded saved cTrader quote snapshot."
        },
        {
          provider_key: "gc=f",
          source: "Yahoo Finance",
          source_type: "futures_proxy",
          data_mode: "proxy",
          is_available: true,
          is_stale: false
        }
      ]
    }),
    getMarketAgentProviderConfig: vi.fn().mockResolvedValue({
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
        snapshotPath: "user-data/ctrader-live-quote.json",
        quoteTimeoutSeconds: 8,
        quoteStaleAfterSeconds: 15,
        allowSavedSnapshotFallback: false,
        configPath: "user-data/ctrader-cli.json"
      }
    }),
    getMarketAgentTelegramConfig: vi.fn().mockResolvedValue({
      ok: true,
      available: true,
      telegram: {
        enabled: false,
        botTokenMasked: "",
        chatIdMasked: "",
        hasBotToken: false,
        hasChatId: false,
        levels: ["level_3"],
        minLevel: "level_3",
        configPath: "user-data/market-agent-telegram.json"
      }
    }),
    getMarketAgentLLMConfig: vi.fn().mockResolvedValue({
      ok: true,
      available: true,
      llm: {
        enabled: false,
        provider: "ollama",
        endpoint: "http://127.0.0.1:21434",
        model: "qwen3.5:4b",
        temperature: 0.2,
        timeoutSeconds: 45,
        keepAlive: "5m",
        maxContext: 8192,
        configPath: "user-data/market-agent-llm.json"
      }
    }),
    getMarketAgentDriverAttention: vi.fn().mockResolvedValue({
      ok: true,
      available: true,
      states: [
        {
          driver_id: "yields",
          current_state: "active",
          priority: "core_structural",
          confidence: "high",
          data_mode: "proxy"
        }
      ]
    }),
    getMarketAgentEvidenceForRun: vi.fn().mockResolvedValue({
      ok: true,
      available: false,
      message: "No run selected.",
      payload: {}
    }),
    getMarketAgentTimeline: vi.fn().mockResolvedValue({ ok: true, available: true, items: [] }),
    getMarketAgentStateTransitions: vi.fn().mockResolvedValue({ ok: true, available: true, items: [] }),
    getMarketAgentSuppressedAlerts: vi.fn().mockResolvedValue({ ok: true, available: true, items: [] }),
    getMarketAgentMonitorStatus: vi.fn().mockResolvedValue({
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
    }),
    getMarketAgentLiveQuote: vi.fn().mockResolvedValue({
      ok: true,
      running: false,
      phase: "stale",
      message: "Live quote snapshot is stale; waiting for fresh cTrader stream.",
      quote: null,
      provider_health: null,
      status: { running: false, phase: "stale" }
    }),
    ensureMarketAgentLiveQuoteStream: vi.fn().mockResolvedValue({
      ok: true,
      running: true,
      phase: "running",
      message: "Live quote stream is running."
    }),
    stopMarketAgentLiveQuoteStream: vi.fn().mockResolvedValue({
      ok: true,
      running: false,
      phase: "stopped",
      message: "Live quote stream is stopped."
    }),
    detectMarketAgentLocalAI: vi.fn().mockResolvedValue({
      ok: true,
      available: true,
      status: "model_missing",
      message: "Recommended model is missing.",
      ruleBasedActive: true
    }),
    runMarketAgentMonitorOnce: vi.fn().mockResolvedValue({ ok: true, available: true, running: false, phase: "stopped" }),
    startMarketAgentMonitorLoop: vi.fn().mockResolvedValue({ ok: true, available: true, running: true, phase: "running" }),
    stopMarketAgentMonitorLoop: vi.fn().mockResolvedValue({ ok: true, available: true, running: false, phase: "stopped" }),
    saveMarketAgentProviderConfig: vi.fn().mockResolvedValue({ ok: true, available: true, ctrader: null }),
    saveMarketAgentTelegramConfig: vi.fn().mockResolvedValue({ ok: true, available: true, telegram: null }),
    saveMarketAgentLLMConfig: vi.fn().mockResolvedValue({ ok: true, available: true, llm: null }),
    testMarketAgentTelegram: vi.fn().mockResolvedValue({ ok: true, status: "sent" }),
    testMarketAgentLLMConnection: vi.fn().mockResolvedValue({ ok: true, status: "model_ready" }),
    testMarketAgentLLMJsonResponse: vi.fn().mockResolvedValue({ ok: true, status: "model_ready" }),
    pullOllamaModel: vi.fn().mockResolvedValue({ ok: true, status: "download_started", done: false }),
    cancelModelDownload: vi.fn().mockResolvedValue({ ok: true, status: "cancelled", done: true }),
    benchmarkMarketAgentLLM: vi.fn().mockResolvedValue({ ok: true, status: "model_ready" }),
    applyLLMFallbackPolicy: vi.fn().mockResolvedValue({ ok: true, status: "fallback_active" }),
    testCTraderConnection: vi.fn().mockResolvedValue({ ok: true }),
    resolveCTraderSymbol: vi.fn().mockResolvedValue({ ok: true }),
    getCTraderQuoteTest: vi.fn().mockResolvedValue({ ok: true }),
    startCTraderConnect: vi.fn().mockResolvedValue({
      ok: true,
      status: "waiting_for_live_connector",
      message:
        "cTrader account is connected. Live streaming is waiting for the long-running connector snapshot; cTrader CLI cBot streaming is disabled to avoid external algo host windows."
    }),
    clearCTraderConfig: vi.fn().mockResolvedValue({ ok: true, available: true, ctrader: null }),
    setCurrency: vi.fn().mockResolvedValue({ ok: true }),
    frontendBootComplete: vi.fn().mockResolvedValue({ ok: true }),
    setUiState: vi.fn().mockResolvedValue({ ok: true }),
    getUpdateState: vi.fn().mockResolvedValue({
      phase: "idle",
      message: "",
      progress: 0,
      availableVersion: "",
      lastCheckedAt: "Not yet"
    }),
    getTemporaryPathTask: vi.fn().mockResolvedValue({
      ok: true,
      active: false,
      phase: "idle",
      progress: 0,
      message: "",
      path: ""
    }),
    probeTemporaryPath: vi.fn().mockResolvedValue({
      ok: true,
      ready: true,
      needsConfirmation: false,
      canUseAsIs: false,
      canReset: false,
      path: "",
      message: ""
    }),
    browseOutputDir: vi.fn().mockResolvedValue({ ok: false }),
    setOutputDir: vi.fn().mockResolvedValue({ ok: true }),
    pullNow: vi.fn().mockResolvedValue({ ok: true }),
    syncNow: vi.fn().mockResolvedValue({ ok: true }),
    checkUpdates: vi.fn().mockResolvedValue({ ok: true }),
    updateNow: vi.fn().mockResolvedValue({ ok: true }),
    installUpdate: vi.fn().mockResolvedValue({ ok: true }),
    saveSettings: vi.fn().mockResolvedValue({ ok: true }),
    setTemporaryPathPath: vi.fn().mockResolvedValue({ ok: true }),
    openLog: vi.fn().mockResolvedValue({ ok: true }),
    openReleaseNotes: vi.fn().mockResolvedValue({ ok: true }),
    openPath: vi.fn().mockResolvedValue({ ok: true }),
    browseTemporaryPath: vi.fn().mockResolvedValue({ ok: false }),
    temporaryPathReset: vi.fn().mockResolvedValue({ ok: true }),
    temporaryPathUseAsIs: vi.fn().mockResolvedValue({ ok: true }),
    addLog: vi.fn().mockResolvedValue({ ok: true }),
    clearLogs: vi.fn().mockResolvedValue({ ok: true }),
    dismissModal: vi.fn().mockResolvedValue({ ok: true })
  },
  tauriListen: vi.fn().mockResolvedValue(null),
  isWebview: () => true
}));

import { backend } from "../api";
import App from "../App";

describe("Market Agent view switch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens the first-class Market Agent page from the top-level app entry", async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Market Agent/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /Market Agent/i }));

    await waitFor(() => {
      expect(screen.getByRole("navigation", { name: /Market Agent sections/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Dashboard/i })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("heading", { name: "XAUUSD (Spot)" })).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Market State" })).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Driver Attention (Current)" })).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Market Replay (Day)" })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Provider Health" })).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /^Provider Health$/i }));
    await waitFor(() => {
      expect(backend.getMarketAgentProviderHealth).toHaveBeenCalled();
      expect(screen.getByRole("heading", { name: "Provider Health" })).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "cTrader" })).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Cross-market sensors" })).toBeInTheDocument();
    }, { timeout: 2500 });
    expect(screen.queryByRole("heading", { name: "DXY" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Data Sources$/i }));
    expect(screen.getByRole("heading", { name: "Data Sources" })).toBeInTheDocument();
  });

  it("opens Market Agent with live stream startup and detects Local AI only when the Local AI setup step is opened", async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Market Agent/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /Market Agent/i }));

    await waitFor(() => {
      expect(screen.getByRole("navigation", { name: /Market Agent sections/i })).toBeInTheDocument();
    });

    expect(backend.getMarketAgentReplay).not.toHaveBeenCalled();
    expect(backend.getMarketAgentLiveQuote).not.toHaveBeenCalled();
    expect(backend.ensureMarketAgentLiveQuoteStream).not.toHaveBeenCalled();
    expect(backend.detectMarketAgentLocalAI).not.toHaveBeenCalled();
    expect(backend.startMarketAgentMonitorLoop).not.toHaveBeenCalled();
    expect(backend.runMarketAgentMonitorOnce).not.toHaveBeenCalled();
    expect(backend.getCTraderQuoteTest).not.toHaveBeenCalled();
    expect(backend.startCTraderConnect).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(backend.getMarketAgentSnapshot).toHaveBeenCalledTimes(1);
      expect(backend.getMarketAgentDriverAttention).toHaveBeenCalledTimes(1);
      expect(backend.getMarketAgentProviderHealth).toHaveBeenCalledTimes(1);
    }, { timeout: 3000 });
    const providerHealthCallsAfterEntry = vi.mocked(backend.getMarketAgentProviderHealth).mock.calls.length;
    const monitorStatusCallsAfterEntry = vi.mocked(backend.getMarketAgentMonitorStatus).mock.calls.length;
    await new Promise((resolve) => window.setTimeout(resolve, 50));
    expect(backend.getMarketAgentProviderHealth).toHaveBeenCalledTimes(providerHealthCallsAfterEntry);
    expect(backend.getMarketAgentMonitorStatus).toHaveBeenCalledTimes(monitorStatusCallsAfterEntry);
    expect(vi.mocked(backend.getMarketAgentMonitorStatus).mock.calls).not.toContainEqual([
      { includeActivity: true }
    ]);
    expect(backend.getMarketAgentReplay).not.toHaveBeenCalled();
    expect(vi.mocked(backend.getMarketAgentLiveQuote).mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(backend.ensureMarketAgentLiveQuoteStream).toHaveBeenCalledTimes(1);
    expect(backend.detectMarketAgentLocalAI).not.toHaveBeenCalled();
    expect(backend.startMarketAgentMonitorLoop).not.toHaveBeenCalled();
    expect(backend.runMarketAgentMonitorOnce).not.toHaveBeenCalled();
    expect(backend.getCTraderQuoteTest).not.toHaveBeenCalled();
    expect(backend.startCTraderConnect).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Replay \/ Timeline/i }));

    await waitFor(() => {
      expect(backend.getMarketAgentReplay).toHaveBeenCalledTimes(1);
    }, { timeout: 2500 });

    expect(backend.detectMarketAgentLocalAI).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /^Data Sources$/i }));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Data Sources" })).toBeInTheDocument();
      expect(backend.getMarketAgentProviderConfig).toHaveBeenCalledTimes(1);
      expect(backend.getMarketAgentTelegramConfig).toHaveBeenCalledTimes(1);
      expect(backend.getMarketAgentLLMConfig).toHaveBeenCalledTimes(1);
    }, { timeout: 2500 });
    expect(backend.detectMarketAgentLocalAI).not.toHaveBeenCalled();
    expect(vi.mocked(backend.getMarketAgentLiveQuote).mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(backend.ensureMarketAgentLiveQuoteStream).toHaveBeenCalledTimes(1);

    fireEvent.click(await screen.findByRole("button", { name: /^Local AI$/i }));

    await waitFor(() => {
      expect(backend.detectMarketAgentLocalAI).toHaveBeenCalledTimes(1);
    }, { timeout: 2500 });

    fireEvent.click(screen.getByRole("button", { name: /^Activity$/i }));

    await waitFor(() => {
      expect(backend.getMarketAgentMonitorStatus).toHaveBeenCalledWith({ includeActivity: true });
    }, { timeout: 2500 });
  });

  it("loads Evidence without triggering replay workspace refresh", async () => {
    vi.mocked(backend.getMarketAgentDriverAttention).mockResolvedValue({
      ok: true,
      available: true,
      monitor_run_id: 321,
      states: [
        {
          driver_id: "yields",
          current_state: "active",
          priority: "core_structural",
          confidence: "high",
          data_mode: "proxy"
        }
      ]
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Market Agent/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /Market Agent/i }));

    await waitFor(() => {
      expect(screen.getByRole("navigation", { name: /Market Agent sections/i })).toBeInTheDocument();
    });

    expect(backend.getMarketAgentReplay).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /^Evidence$/i }));

    await waitFor(() => {
      expect(backend.getMarketAgentEvidenceForRun).toHaveBeenCalledWith(321);
    });

    expect(backend.getMarketAgentReplay).not.toHaveBeenCalled();
  });

  it("keeps Market Agent entry read-only when cTrader is enabled and monitoring is stopped", async () => {
    vi.mocked(backend.getMarketAgentProviderConfig).mockResolvedValue({
      ok: true,
      available: true,
      ctrader: {
        enabled: true,
        environment: "demo",
        symbol: "XAUUSD",
        symbolId: null,
        accountId: "123",
        ctidMasked: "ct****id",
        passwordMasked: "********",
        hasPassword: true,
        snapshotPath: "user-data/ctrader-live-quote.json",
        quoteTimeoutSeconds: 8,
        quoteStaleAfterSeconds: 45,
        allowSavedSnapshotFallback: false,
        configPath: "user-data/ctrader-cli.json"
      }
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Market Agent/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /Market Agent/i }));

    await waitFor(() => {
      expect(screen.getByRole("navigation", { name: /Market Agent sections/i })).toBeInTheDocument();
    });

    expect(backend.startMarketAgentMonitorLoop).not.toHaveBeenCalled();
    expect(backend.ensureMarketAgentLiveQuoteStream).not.toHaveBeenCalled();
    expect(backend.getCTraderQuoteTest).not.toHaveBeenCalled();
    expect(backend.startCTraderConnect).not.toHaveBeenCalled();
    expect(backend.runMarketAgentMonitorOnce).not.toHaveBeenCalled();
    expect(backend.detectMarketAgentLocalAI).not.toHaveBeenCalled();
  });
});
