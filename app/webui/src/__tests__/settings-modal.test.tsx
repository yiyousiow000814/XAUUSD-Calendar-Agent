import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SettingsModal } from "../components/SettingsModal";
import type { Settings } from "../types";

const baseSettings: Settings = {
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
};

const renderModal = (overrides: Partial<React.ComponentProps<typeof SettingsModal>> = {}) =>
  render(
    <SettingsModal
      isOpen
      isClosing={false}
      isEntering={false}
      settings={baseSettings}
      outputDir=""
      savingMessage=""
      pathsRef={{ current: null }}
      updatePhase="available"
      updateMessage="Update available"
      updateProgress={0}
      updateLastCheckedAt="Not yet"
      appVersion="0.0.0"
      onOpenReleaseNotes={vi.fn()}
      onClose={vi.fn()}
      onSave={vi.fn()}
      onCancel={vi.fn()}
      onThemeChange={vi.fn()}
      onSystemThemeToggle={vi.fn()}
      onAutoSyncAfterPull={vi.fn()}
      onAutoUpdateEnabled={vi.fn()}
      onCheckUpdates={vi.fn()}
      onUpdateNow={vi.fn()}
      onRunOnStartup={vi.fn()}
      onAutostartLaunchModeChange={vi.fn()}
      onCloseBehaviorChange={vi.fn()}
      onDebugToggle={vi.fn()}
      onCalendarTimezoneModeChange={vi.fn()}
      onCalendarUtcOffsetMinutesChange={vi.fn()}
      onCopyLog={vi.fn()}
      onOpenLog={vi.fn()}
      onEnableTemporaryPath={vi.fn()}
      onTemporaryPathChange={vi.fn()}
      onTemporaryPathBlur={vi.fn()}
      onTemporaryPathBrowse={vi.fn()}
      onOpenPath={vi.fn()}
      onOutputDirChange={vi.fn()}
      onOutputDirBlur={vi.fn()}
      onBrowseOutput={vi.fn()}
      {...overrides}
    />
  );

describe("SettingsModal", () => {
  it("shows release notes link when callback provided", () => {
    renderModal();
    expect(screen.getByRole("button", { name: /check release notes/i })).toBeInTheDocument();
  });

  it("hides release notes link when callback missing", () => {
    renderModal({ onOpenReleaseNotes: undefined, updateMessage: "Up to date", updatePhase: "idle" });
    expect(screen.queryByRole("button", { name: /check release notes/i })).not.toBeInTheDocument();
  });
});
