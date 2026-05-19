import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

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
      logs: [{ time: "19-05-2026 08:02", message: "Calendar loaded", level: "INFO" }],
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
      state: {
        current_bias: "neutral",
        main_driver: "unknown",
        confidence: "low",
        cause_status: "no_meaningful_change",
        last_alert_time: "",
        last_alert_summary: "",
        last_analysis_time: "2026-05-19T08:05:00+08:00",
        last_notification_level: "none",
        state_change_reason: ""
      },
      alerts: []
    }),
    getMarketAgentReplay: vi.fn().mockResolvedValue({
      ok: true,
      available: true,
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
    }),
    getMarketAgentProviderHealth: vi.fn().mockResolvedValue({ ok: true, available: true, items: [] }),
    getMarketAgentProviderConfig: vi.fn().mockResolvedValue({ ok: true, available: true, ctrader: null }),
    getMarketAgentTelegramConfig: vi.fn().mockResolvedValue({ ok: true, available: true, telegram: null }),
    getMarketAgentLLMConfig: vi.fn().mockResolvedValue({ ok: true, available: true, llm: null }),
    getMarketAgentDriverAttention: vi.fn().mockResolvedValue({ ok: true, available: true, states: [] }),
    getMarketAgentEvidenceForRun: vi.fn().mockResolvedValue({ ok: true, available: false, payload: {} }),
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
    getUpdateState: vi.fn().mockResolvedValue({ phase: "idle", message: "", progress: 0, availableVersion: "", lastCheckedAt: "" }),
    getTemporaryPathTask: vi.fn().mockResolvedValue({ ok: true, active: false, phase: "idle", progress: 0, message: "", path: "" }),
    frontendBootComplete: vi.fn().mockResolvedValue({ ok: true }),
    setUiState: vi.fn().mockResolvedValue({ ok: true }),
    setCurrency: vi.fn().mockResolvedValue({ ok: true }),
    browseOutputDir: vi.fn().mockResolvedValue({ ok: false }),
    setOutputDir: vi.fn().mockResolvedValue({ ok: true }),
    pullNow: vi.fn().mockResolvedValue({ ok: true }),
    syncNow: vi.fn().mockResolvedValue({ ok: true }),
    checkUpdates: vi.fn().mockResolvedValue({ ok: true }),
    updateNow: vi.fn().mockResolvedValue({ ok: true }),
    installUpdate: vi.fn().mockResolvedValue({ ok: true }),
    saveSettings: vi.fn().mockResolvedValue({ ok: true }),
    probeTemporaryPath: vi.fn().mockResolvedValue({ ok: true, ready: true, needsConfirmation: false, canUseAsIs: false, canReset: false, path: "", message: "" }),
    setTemporaryPathPath: vi.fn().mockResolvedValue({ ok: true }),
    browseTemporaryPath: vi.fn().mockResolvedValue({ ok: false }),
    temporaryPathReset: vi.fn().mockResolvedValue({ ok: true }),
    temporaryPathUseAsIs: vi.fn().mockResolvedValue({ ok: true }),
    openLog: vi.fn().mockResolvedValue({ ok: true }),
    openReleaseNotes: vi.fn().mockResolvedValue({ ok: true }),
    openPath: vi.fn().mockResolvedValue({ ok: true }),
    addLog: vi.fn().mockResolvedValue({ ok: true }),
    clearLogs: vi.fn().mockResolvedValue({ ok: true }),
    dismissModal: vi.fn().mockResolvedValue({ ok: true }),
    runMarketAgentMonitorOnce: vi.fn().mockResolvedValue({ ok: true, available: true, running: false, phase: "stopped" }),
    runMarketAgentBackfillRecovery: vi.fn().mockResolvedValue({ ok: true, available: true, running: false, phase: "recovery_completed" }),
    startMarketAgentMonitorLoop: vi.fn().mockResolvedValue({ ok: true, available: true, running: true, phase: "running" }),
    stopMarketAgentMonitorLoop: vi.fn().mockResolvedValue({ ok: true, available: true, running: false, phase: "stopped" }),
    saveMarketAgentProviderConfig: vi.fn().mockResolvedValue({ ok: true, available: true, ctrader: null }),
    saveMarketAgentTelegramConfig: vi.fn().mockResolvedValue({ ok: true, available: true, telegram: null }),
    saveMarketAgentLLMConfig: vi.fn().mockResolvedValue({ ok: true, available: true, llm: null }),
    testMarketAgentTelegram: vi.fn().mockResolvedValue({ ok: true }),
    testMarketAgentLLMConnection: vi.fn().mockResolvedValue({ ok: true }),
    testMarketAgentLLMJsonResponse: vi.fn().mockResolvedValue({ ok: true }),
    testCTraderConnection: vi.fn().mockResolvedValue({ ok: true }),
    resolveCTraderSymbol: vi.fn().mockResolvedValue({ ok: true }),
    getCTraderQuoteTest: vi.fn().mockResolvedValue({ ok: true }),
    refreshCTraderToken: vi.fn().mockResolvedValue({ ok: true }),
    clearCTraderConfig: vi.fn().mockResolvedValue({ ok: true, available: true, ctrader: null })
  },
  tauriListen: vi.fn().mockResolvedValue(null),
  isWebview: () => true
}));

import App from "../App";

describe("Activity drawer", () => {
  it("keeps Market Situation out of the Activity drawer", async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Market Agent/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /Activity/i }));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /^Activity$/i })).toBeInTheDocument();
    });
    expect(screen.queryByText(/Market Situation Agent/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Open Market Agent/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Market Agent/i }));
    await waitFor(() => {
      expect(screen.getByRole("navigation", { name: /Market Agent sections/i })).toBeInTheDocument();
    });
  });
});
