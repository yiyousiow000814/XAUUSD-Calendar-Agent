import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MarketAgentPanel } from "../components/MarketAgentPanel";
import type { MarketAgentSnapshotResponse } from "../types";

const snapshot: MarketAgentSnapshotResponse = {
  ok: true,
  available: true,
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
    invalidation_conditions: ["US10Y drops more than 7 bps"]
  },
  alerts: [
    {
      time: "2026-05-19T08:00:00+08:00",
      notification_level: "level_3",
      message: "Gold remains under pressure.",
      main_driver: "yields",
      bias: "bearish_gold"
    }
  ]
};

describe("MarketAgentPanel", () => {
  it("renders current state and latest alert history", () => {
    render(<MarketAgentPanel data={snapshot} />);

    expect(screen.getByText(/Market Situation Agent/i)).toBeInTheDocument();
    expect(screen.getByText(/bearish_gold/i)).toBeInTheDocument();
    expect(screen.getAllByText(/yields/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Gold remains under pressure\./i).length).toBe(2);
  });
});
