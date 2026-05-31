import { describe, expect, it } from "vitest";

import { buildSignalMapModel } from "../components/market-agent-activity/signalMapModel";

const emptyReplay = {
  ok: true,
  available: true,
  timeline_store_path: "timeline.sqlite",
  start: "2026-05-31T00:00:00+08:00",
  end: "2026-06-01T00:00:00+08:00",
  replay: {
    price_series: [],
    related_assets: {},
    news_items: [],
    calendar_events: [],
    driver_attention_timeline: [],
    timeline_events: [],
    month_summary_events: [],
    state_transitions: [],
    alerts: [],
    suppressed_alerts: []
  }
};

describe("buildSignalMapModel", () => {
  it("does not reuse stale monitor activity over current provider health", () => {
    const marketClosedHealth = {
      provider_key: "xauusd",
      source: "cTrader",
      source_type: "spot",
      data_mode: "stale",
      is_available: true,
      is_stale: true,
      current_value: 4541.33,
      data_timestamp: "2026-05-29T20:56:59.9470000Z",
      fetched_at: "2026-05-31T18:27:17.534309+08:00",
      stale_reason: "XAUUSD is inside the weekend closed window; last cTrader quote is context only until the market reopens."
    };

    const model = buildSignalMapModel({
      monitorStatus: {
        ok: true,
        available: true,
        running: false,
        phase: "stopped",
        message: "Monitor loop is stopped.",
        latestStoredRunAt: "2026-05-31T18:27:17.534309+08:00",
        activityStale: true,
        activity: {
          ctrader: {
            status: "unavailable",
            detail: "Live cTrader spot is unavailable.",
            jobs: [
              {
                title: "Live quote request",
                status: "unavailable",
                detail: "Live cTrader spot is unavailable.",
                input: "old status snapshot",
                output: "Price input missing"
              }
            ]
          }
        }
      } as never,
      liveQuote: { ok: true, provider_health: marketClosedHealth } as never,
      providerHealth: { ok: true, available: true, items: [marketClosedHealth] } as never,
      replay: emptyReplay as never,
      selectedEvidence: null,
      providerConfig: { ok: true, available: true, ctrader: { enabled: true } } as never,
      telegramConfig: null,
      llmConfig: { ok: true, available: true, llm: { enabled: true } } as never
    });

    const priceNode = model.lanes.flatMap((lane) => lane.nodes).find((node) => node.id === "price-source");
    const rows = priceNode?.drilldown?.[0]?.rows ?? [];

    expect(priceNode?.status).toBe("market closed");
    expect(rows[0]?.status).toBe("market closed");
    expect(JSON.stringify(rows)).not.toContain("Live cTrader spot is unavailable.");
  });
});
