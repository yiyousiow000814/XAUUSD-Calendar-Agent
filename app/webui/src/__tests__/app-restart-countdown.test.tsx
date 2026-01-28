import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({
  backend: {
    getSnapshot: vi.fn().mockResolvedValue({
      lastPull: "Not yet",
      lastSync: "Not yet",
      lastPullAt: "",
      lastSyncAt: "",
      outputDir: "",
      repoPath: "",
      currency: "USD",
      currencyOptions: ["USD"],
      events: [],
      pastEvents: [],
      logs: [],
      version: "0.0.0",
      modal: null,
      pullActive: false,
      syncActive: false,
      calendarStatus: "loaded",
      restartInSeconds: 5
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

import App from "../App";

describe("App restart countdown", () => {
  it("shows restart countdown inside activity pill", async () => {
    const { unmount } = render(<App />);
    await waitFor(() => {
      const matches = screen.getAllByText(/Restarting in 5s/i);
      const visible = matches.find((node) => node.getAttribute("aria-hidden") !== "true");
      expect(visible).toBeTruthy();
    });
    unmount();
  });
});
