import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MarketAgentPage } from "../components/MarketAgentPage";
import type {
  MarketAgentDriverAttentionResponse,
  MarketAgentEvidenceForRunResponse,
  MarketAgentProviderHealthResponse,
  MarketAgentReplayResponse,
  MarketAgentSnapshotResponse
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

describe("MarketAgentPage", () => {
  it("renders overview, driver attention, provider health, replay, and evidence sections", () => {
    const selected: number[] = [];

    render(
      <MarketAgentPage
        snapshot={snapshot}
        providerHealth={providerHealth}
        driverAttention={driverAttention}
        replay={replay}
        selectedEvidence={evidence}
        selectedMonitorRunId={23}
        rangePreset="4h"
        rangeStartInput="2026-05-19T04:00"
        rangeEndInput="2026-05-19T08:30"
        onPresetChange={() => {}}
        onRangeStartChange={() => {}}
        onRangeEndChange={() => {}}
        onApplyRange={() => {}}
        onSelectRun={(id) => selected.push(id)}
      />
    );

    expect(screen.getByText(/bearish_gold/i)).toBeInTheDocument();
    expect(screen.getAllByText(/yields/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/oil_inflation/i)).toBeInTheDocument();
    expect(screen.getAllByText(/futures_proxy/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/unavailable/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Price series/i)).toBeInTheDocument();
    expect(screen.getByText(/Fed headline/i)).toBeInTheDocument();
    expect(screen.getByText(/Fed speaker/i)).toBeInTheDocument();
    expect(screen.getByText(/Suppressed duplicate/i)).toBeInTheDocument();
    expect(screen.getByText(/allowed_candidate_drivers/i)).toBeInTheDocument();
    expect(screen.getAllByText(/fed_rates/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/No direct headline/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Yields pressure/i }));
    expect(selected).toEqual([23]);
  });

  it("shows useful empty states when sqlite-backed data is unavailable", () => {
    render(
      <MarketAgentPage
        snapshot={{ ok: true, available: false, message: "SQLite missing.", state: null, alerts: [] }}
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
        selectedMonitorRunId={null}
        rangePreset="4h"
        rangeStartInput=""
        rangeEndInput=""
        onPresetChange={() => {}}
        onRangeStartChange={() => {}}
        onRangeEndChange={() => {}}
        onApplyRange={() => {}}
        onSelectRun={() => {}}
      />
    );

    expect(screen.getByText(/SQLite missing\./i)).toBeInTheDocument();
    expect(screen.getByText(/Provider health unavailable\./i)).toBeInTheDocument();
    expect(screen.getByText(/Replay unavailable\./i)).toBeInTheDocument();
    expect(screen.getByText(/Evidence unavailable\./i)).toBeInTheDocument();
  });
});
