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
        snapshotPath: "user-data/ctrader-last-quote.json",
        quoteTimeoutSeconds: 8,
        quoteStaleAfterSeconds: 15,
        allowSavedSnapshotFallback: true,
        configPath: "user-data/ctrader-cli.json"
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
    testCTraderConnection: vi.fn().mockResolvedValue({ ok: true }),
    resolveCTraderSymbol: vi.fn().mockResolvedValue({ ok: true }),
    getCTraderQuoteTest: vi.fn().mockResolvedValue({ ok: true }),
    startCTraderConnect: vi.fn().mockResolvedValue({ ok: true, status: "preparing_live_feed", message: "cTrader is connected. Preparing live XAUUSD and syncing history in the background." }),
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
    expect(screen.getByRole("heading", { name: "Provider Health" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "cTrader" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Market context" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "DXY" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Data Sources$/i }));
    expect(screen.getByRole("heading", { name: "Data Sources" })).toBeInTheDocument();
  });

  it("does not double-load heavy Market Agent backend data on entry", async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Market Agent/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /Market Agent/i }));

    await waitFor(() => {
      expect(screen.getByRole("navigation", { name: /Market Agent sections/i })).toBeInTheDocument();
    });

    expect(backend.getMarketAgentSnapshot).toHaveBeenCalledTimes(1);
    expect(backend.getMarketAgentReplay).toHaveBeenCalledTimes(1);
    expect(backend.getMarketAgentDriverAttention).toHaveBeenCalledTimes(1);
    expect(backend.getMarketAgentProviderHealth).toHaveBeenCalledTimes(1);
    expect(backend.detectMarketAgentLocalAI).not.toHaveBeenCalled();
  });
});
