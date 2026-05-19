import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AppBar } from "../components/AppBar";
import type { Snapshot } from "../types";

const snapshot: Snapshot = {
  lastPull: "19-05-2026 08:00",
  lastSync: "19-05-2026 08:02",
  outputDir: "",
  repoPath: "",
  currency: "USD",
  currencyOptions: ["USD", "ALL"],
  calendarStatus: "loaded",
  events: [],
  pastEvents: [],
  logs: [],
  version: "0.3.0",
  restartInSeconds: 0
};

describe("AppBar market agent entry", () => {
  it("shows a visible market-agent entry outside the activity drawer", () => {
    const calls: string[] = [];

    render(
      <AppBar
        snapshot={snapshot}
        outputDir="C:\\target"
        activeView="calendar"
        syncTargetPulse={0}
        syncTargetNudgeFlash={false}
        syncDisabled={false}
        connecting={false}
        pullState="idle"
        syncState="idle"
        resolvedTheme="dark"
        themeMode="dark"
        onPull={() => {}}
        onSync={() => {}}
        onOpenSettings={() => {}}
        onToggleTheme={() => {}}
        onOpenPaths={() => {}}
        onOpenCalendar={() => calls.push("calendar")}
        onOpenMarketAgent={() => calls.push("market-agent")}
      />
    );

    expect(screen.getByRole("button", { name: /Market Agent/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Market Agent/i }));
    expect(calls).toContain("market-agent");
  });
});
