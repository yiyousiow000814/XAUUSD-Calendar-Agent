import { describe, expect, it } from "vitest";

import { buildSignalMapModel } from "../components/market-agent-activity/signalMapModel";

const formatExpectedLocalTimestamp = (value: string) => {
  const date = new Date(value);
  const pad2 = (part: number) => String(part).padStart(2, "0");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  return `${pad2(date.getDate())} ${months[date.getMonth()]} ${date.getFullYear()} ${pad2(date.getHours())}:${pad2(date.getMinutes())} UTC${sign}${pad2(Math.floor(abs / 60))}`;
};

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
    expect(model.phaseMessage).toContain(formatExpectedLocalTimestamp("2026-05-31T18:27:17.534309+08:00"));
    expect(model.phaseMessage).not.toContain("2026-05-31T18:27:17.534309+08:00");
    expect(rows[0]?.status).toBe("market closed");
    expect(JSON.stringify(rows)).not.toContain("Live cTrader spot is unavailable.");
  });

  it("surfaces monitor self-audit instead of generic waiting text", () => {
    const model = buildSignalMapModel({
      monitorStatus: {
        ok: true,
        available: true,
        running: true,
        phase: "idle_between_runs",
        message: "Waiting for the next monitor pass.",
        selfAudit: {
          status: "degraded",
          checked_at: "2026-06-11T19:19:55+08:00",
          summary: "Market Agent is running with partial inputs; context still updates while current trade calls wait for required live evidence.",
          latest_evidence_run_id: 793,
          latest_timeline_event_at: "2026-06-11T19:19:55+08:00",
          checks: [
            { name: "calendar_source", status: "pass", detail: "Calendar dataset reaches 2026-06-20." },
            { name: "news_context", status: "pass", detail: "6 relevant headline(s) in current window." },
            { name: "evidence_gate", status: "warn", detail: "Live XAUUSD is missing; news/calendar can still update context, but no current trade call is shown." }
          ]
        }
      } as never,
      liveQuote: null,
      providerHealth: null,
      replay: emptyReplay as never,
      selectedEvidence: null,
      providerConfig: null,
      telegramConfig: null,
      llmConfig: null
    });

    const auditNode = model.aiNodes.find((node) => node.id === "agent-self-audit");
    const rows = auditNode?.drilldown?.[0]?.rows ?? [];

    expect(model.phaseMessage).toContain("partial inputs");
    expect(model.phaseMessage).not.toContain("Waiting for the next monitor pass");
    expect(auditNode?.status).toBe("degraded");
    expect(rows.map((row) => row.label)).toContain("Calendar Source");
    expect(rows.map((row) => row.label)).toContain("News Context");
    expect(rows.map((row) => row.status)).toContain("warn");
  });

  it("shows user-facing news preview and filter explanation", () => {
    const model = buildSignalMapModel({
      monitorStatus: null,
      liveQuote: null,
      providerHealth: null,
      replay: {
        ...emptyReplay,
        replay: {
          ...emptyReplay.replay,
          news_items: [
            {
              title: "We thought we found the perfect luxury retirement community",
              source: "MarketWatch.com - Top Stories",
              published_at: "2026-06-07T11:50:00+00:00",
              first_seen_at: "2026-06-07T22:36:08+08:00",
              included: false,
              filter_reason: "no_market_agent_keyword",
              preview: "This personal finance story was captured from the RSS feed.",
              link: "https://example.test/retirement-community"
            }
          ]
        }
      } as never,
      selectedEvidence: null,
      providerConfig: null,
      telegramConfig: null,
      llmConfig: null
    });

    const newsNode = model.lanes.flatMap((lane) => lane.nodes).find((node) => node.id === "news-source");
    const rows = newsNode?.history?.find((section) => section.title === "Captured headlines")?.rows ?? [];

    expect(rows[0]?.detail).toContain("This personal finance story was captured from the RSS feed.");
    expect(rows[0]?.detail).toContain("No Market Agent keyword matched");
    expect(JSON.stringify(rows[0])).toContain("https://example.test/retirement-community");
    expect(JSON.stringify(rows[0])).not.toContain("no_market_agent_keyword");
  });

  it("shows day-level news coverage for the selected replay window", () => {
    const model = buildSignalMapModel({
      monitorStatus: null,
      liveQuote: null,
      providerHealth: null,
      replay: {
        ...emptyReplay,
        start: "2026-06-05T00:00:00",
        end: "2026-06-08T00:00:00",
        replay: {
          ...emptyReplay.replay,
          news_items: [
            {
              title: "Fed officials discuss inflation path",
              source: "CNBC Top News RSS",
              published_at: "2026-06-05T12:00:00",
              fetched_at: "2026-06-05T12:04:00",
              included: true,
              summary_source: "local_ai"
            },
            {
              title: "Gold traders watch the dollar",
              source: "MarketWatch.com - Top Stories",
              published_at: "2026-06-07T12:00:00",
              fetched_at: "2026-06-07T12:05:00",
              included: false,
              filter_reason: "score_below_threshold"
            }
          ]
        }
      } as never,
      selectedEvidence: null,
      providerConfig: null,
      telegramConfig: null,
      llmConfig: null
    });

    const newsNode = model.lanes.flatMap((lane) => lane.nodes).find((node) => node.id === "news-source");
    const rows = newsNode?.drilldown?.find((section) => section.title === "News coverage by day")?.rows ?? [];

    expect(rows.map((row) => row.label)).toEqual(["05-06-2026", "06-06-2026", "07-06-2026"]);
    expect(rows[0]?.status).toBe("available");
    expect(rows[0]?.detail).toContain("1 headline row(s), 1 included");
    expect(rows[0]?.meta).toContain("ai_summaries: 1");
    expect(rows[1]?.status).toBe("missing");
    expect(rows[1]?.detail).toContain("No stored news rows");
    expect(rows[2]?.meta).toContain("filtered: 1");
    expect(rows[2]?.meta).toContain("filter_reasons: Relevance score below threshold: 1");
    expect(rows[2]?.meta).toContain("ai_summaries: 0");
  });

  it("explains what each Local AI call completed or failed to do", () => {
    const model = buildSignalMapModel({
      monitorStatus: {
        ok: true,
        available: true,
        running: false,
        phase: "stopped",
        message: "Monitor loop stopped.",
        activity: {
          llm: {
            status: "validated",
            telemetry: [
              {
                task: "cause_review",
                status: "ok",
                model: "qwen3.5:4b",
                elapsed_ms: 22519.48,
                total_duration_ms: 22219.93,
                input_tokens: 5106,
                output_tokens: 714,
                tokens_per_second: 53.85
              },
              {
                task: "display_summary",
                status: "error",
                model: "qwen3.5:4b",
                error: "timeout"
              }
            ]
          }
        }
      } as never,
      liveQuote: null,
      providerHealth: null,
      replay: emptyReplay as never,
      selectedEvidence: null,
      providerConfig: null,
      telegramConfig: null,
      llmConfig: { ok: true, available: true, llm: { enabled: true } } as never
    });

    const rows = model.decisionTrace.items;

    expect(model.decisionTrace.summary).toContain("This is a Local AI call audit");
    expect(rows[0]?.label).toBe("Cause review");
    expect(rows[0]?.status).toBe("completed");
    expect(rows[0]?.detail).toContain("returned a valid cause analysis");
    expect(rows[0]?.detail).toContain("not the whole Market Agent run");
    expect(rows[0]?.meta).toContain("type: Cause analysis");
    expect(rows[0]?.meta).toContain("result: cause analysis completed");
    expect(rows[1]?.label).toBe("Display summary");
    expect(rows[1]?.status).toBe("failed");
    expect(rows[1]?.detail).toContain("failed while creating user-facing summary text");
    expect(rows[1]?.meta).toContain("type: Display text");
    expect(rows[1]?.meta).toContain("task: display_summary");
  });

  it("renders unknown unconfirmed stored AI results as a no-trade-call review", () => {
    const model = buildSignalMapModel({
      monitorStatus: null,
      liveQuote: null,
      providerHealth: null,
      replay: emptyReplay as never,
      selectedEvidence: {
        ok: true,
        available: true,
        monitor_run_id: 711,
        payload: {
          analysis_history: [
            {
              monitor_run_id: 711,
              run_started_at: "2026-06-11T07:28:00+08:00",
              analysis_engine: "llm_validated",
              llm_status: "validated",
              main_driver: "unknown",
              cause_status: "unconfirmed",
              confidence: "low",
              summary: "XAUUSD market is closed; news, calendar, and cross-market context keep updating, and the next trade read resumes when fresh XAUUSD price action returns."
            }
          ]
        }
      } as never,
      providerConfig: null,
      telegramConfig: null,
      llmConfig: { ok: true, available: true, llm: { enabled: true } } as never
    });

    const rows = model.decisionTrace.items;

    expect(rows[0]?.label).toBe("Trade-call review");
    expect(rows[0]?.status).toBe("ai_validated");
    expect(rows[0]?.detail).toContain("did not publish a current market conclusion");
    expect(rows[0]?.meta).toContain("result: Market closed, evidence kept");
    expect(JSON.stringify(rows[0])).not.toContain("Unknown Unconfirmed");
  });

  it("renders stored market observations as observed context instead of a failed trade call", () => {
    const model = buildSignalMapModel({
      monitorStatus: null,
      liveQuote: null,
      providerHealth: null,
      replay: emptyReplay as never,
      selectedEvidence: {
        ok: true,
        available: true,
        monitor_run_id: 812,
        payload: {
          analysis_history: [
            {
              monitor_run_id: 812,
              run_started_at: "2026-06-18T10:00:00+08:00",
              analysis_engine: "llm_validated",
              llm_status: "validated",
              main_driver: "unknown",
              cause_status: "unconfirmed",
              confidence: "low",
              summary: "Fed/rates context is updating, but no directional trade call is ready.",
              market_read: {
                status: "market_observation",
                headline: "Fed officials keep rate-cut debate alive before gold tests resistance",
                thesis: "Fed officials keep rate-cut debate alive before gold tests resistance. No trade call is published until XAUUSD price action and confirming market sensors line up with the news/calendar context.",
                coverage: {
                  news: "1 reviewed",
                  calendar: "1 reviewed",
                  sensors: "0 of 8 usable"
                },
                evidence: {
                  latest_news: ["Fed officials keep rate-cut debate alive before gold tests resistance"],
                  calendar: ["US Initial Jobless Claims"],
                  missing: []
                },
                watch_next: ["DXY/yields confirmation"]
              }
            }
          ]
        }
      } as never,
      providerConfig: null,
      telegramConfig: null,
      llmConfig: { ok: true, available: true, llm: { enabled: true } } as never
    });

    const rows = model.decisionTrace.items;

    expect(rows[0]?.label).toBe("Market observation");
    expect(rows[0]?.detail).toContain("No trade call is published");
    expect(rows[0]?.detail).not.toContain("did not publish a current market conclusion");
    expect(rows[0]?.meta).toContain("result: Fed officials keep rate-cut debate alive before gold tests resistance");
    expect(rows[0]?.meta).toContain("watch_next: DXY/yields confirmation");
  });

  it("uses the actionable no-trade reason instead of a generic market-read headline", () => {
    const model = buildSignalMapModel({
      monitorStatus: null,
      liveQuote: null,
      providerHealth: null,
      replay: emptyReplay as never,
      selectedEvidence: {
        ok: true,
        available: true,
        monitor_run_id: 813,
        payload: {
          analysis_history: [
            {
              monitor_run_id: 813,
              run_started_at: "2026-06-18T10:02:00+08:00",
              analysis_engine: "llm_validated",
              llm_status: "validated",
              main_driver: "unknown",
              cause_status: "unconfirmed",
              confidence: "low",
              summary: "A current XAUUSD trade read needs fresh live price and recent price history.",
              market_read: {
                status: "no_conclusion",
                headline: "No confirmed market driver yet",
                thesis: "XAUUSD is up +0.33%, but price, news, calendar, and sensor evidence do not agree enough to publish a directional market read.",
                coverage: {
                  news: "14 reviewed",
                  calendar: "14 reviewed",
                  sensors: "8 of 8 usable"
                },
                evidence: {
                  missing: ["xauusd_recent_history"],
                  latest_news: ["Treasury yields rise as dollar firms before Fed speakers"]
                },
                watch_next: ["fresh XAUUSD quote"]
              }
            }
          ]
        }
      } as never,
      providerConfig: null,
      telegramConfig: null,
      llmConfig: { ok: true, available: true, llm: { enabled: true } } as never
    });

    const row = model.decisionTrace.items[0];

    expect(row?.label).toBe("Trade-call review");
    expect(row?.meta).toContain("result: Waiting for live price history");
    expect(row?.meta).not.toContain("result: No confirmed market driver yet");
    expect(row?.detail).toContain("Watch next: fresh XAUUSD quote");
  });

  it("collapses repeated stored AI reviews into one readable history row", () => {
    const repeatedRead = {
      status: "context_only",
      headline: "Market closed; news watch continues",
      thesis: "XAUUSD is closed, so the agent keeps the last spot price as context while it reviews news, calendar events, and cross-market sensors for the next tradable read.",
      coverage: {
        news: "6 reviewed",
        calendar: "0 reviewed",
        sensors: "1 of 8 usable"
      },
      evidence: {
        latest_news: ["Oil falls as Hormuz risk fades", "Fed chair debate keeps rates in focus"],
        missing: ["live_xauusd_spot", "xauusd_recent_history"]
      },
      watch_next: ["fresh XAUUSD spot", "DXY/yields confirmation"]
    };
    const model = buildSignalMapModel({
      monitorStatus: null,
      liveQuote: null,
      providerHealth: null,
      replay: emptyReplay as never,
      selectedEvidence: {
        ok: true,
        available: true,
        monitor_run_id: 711,
        payload: {
          analysis_history: [
            {
              monitor_run_id: 713,
              run_started_at: "2026-06-11T07:32:00+08:00",
              analysis_engine: "llm_validated",
              llm_status: "validated",
              main_driver: "unknown",
              cause_status: "unconfirmed",
              confidence: "low",
              summary: "XAUUSD market is closed; news, calendar, and cross-market context keep updating, and the next trade read resumes when fresh XAUUSD price action returns.",
              market_read: repeatedRead
            },
            {
              monitor_run_id: 712,
              run_started_at: "2026-06-11T07:30:00+08:00",
              analysis_engine: "llm_validated",
              llm_status: "validated",
              main_driver: "unknown",
              cause_status: "unconfirmed",
              confidence: "low",
              summary: "XAUUSD market is closed; news, calendar, and cross-market context keep updating, and the next trade read resumes when fresh XAUUSD price action returns.",
              market_read: repeatedRead
            },
            {
              monitor_run_id: 711,
              run_started_at: "2026-06-11T07:28:00+08:00",
              analysis_engine: "llm_validated",
              llm_status: "validated",
              main_driver: "unknown",
              cause_status: "unconfirmed",
              confidence: "low",
              summary: "XAUUSD market is closed; news, calendar, and cross-market context keep updating, and the next trade read resumes when fresh XAUUSD price action returns.",
              market_read: repeatedRead
            }
          ]
        }
      } as never,
      providerConfig: null,
      telegramConfig: null,
      llmConfig: { ok: true, available: true, llm: { enabled: true } } as never
    });

    const rows = model.decisionTrace.items;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.meta).toContain("repeat_count: 3");
    expect(rows[0]?.meta).toContain("latest_news: Oil falls as Hormuz risk fades | Fed chair debate keeps rates in focus");
    expect(rows[0]?.detail).toContain("Reviewed 6 news, 0 calendar, 1 of 8 sensors");
    expect(rows[0]?.detail).toContain("Watch next: fresh XAUUSD spot; DXY/yields confirmation");
  });

  it("treats driver-gate exclusions as guarded instead of broken inputs", () => {
    const model = buildSignalMapModel({
      monitorStatus: null,
      liveQuote: null,
      providerHealth: null,
      replay: emptyReplay as never,
      selectedEvidence: {
        ok: true,
        available: true,
        monitor_run_id: 1215,
        payload: {
          evidence_packet: {
            allowed_candidate_drivers: ["geopolitics"],
            blocked_drivers: {
              fed_rates: "Fed/rates evidence is missing or stale."
            },
            evidence_chain_status: {
              status: "context_only",
              missing_required: ["live_xauusd_spot", "xauusd_recent_history"],
              usable_inputs: ["news_context", "llm_validated"],
              context_only_inputs: ["cross_market_sensors", "calendar_waiting"]
            }
          }
        }
      } as never,
      providerConfig: null,
      telegramConfig: null,
      llmConfig: { ok: true, available: true, llm: { enabled: true } } as never
    });

    const fedRates = model.candidateSensors.find((sensor) => sensor.id === "candidate-fed_rates");
    const request = fedRates?.requests?.[0];

    expect(fedRates?.status).toBe("guarded");
    expect(fedRates?.badges?.[0]?.label).toBe("guarded");
    expect(fedRates?.drilldown?.[0]?.rows?.[0]?.status).toBe("guarded");
    expect(request?.status).toBe("guarded");
    expect(JSON.stringify(fedRates)).not.toContain('"status":"blocked"');
  });

  it("does not show unknown as a watched candidate theme", () => {
    const model = buildSignalMapModel({
      monitorStatus: null,
      liveQuote: null,
      providerHealth: null,
      replay: emptyReplay as never,
      selectedEvidence: {
        ok: true,
        available: true,
        monitor_run_id: 1220,
        payload: {
          evidence_packet: {
            allowed_candidate_drivers: ["unknown"],
            blocked_drivers: {},
            evidence_chain_status: {
              status: "context_only",
              missing_required: ["xauusd_recent_history"],
              usable_inputs: ["news_context"],
              context_only_inputs: ["calendar_waiting"]
            }
          }
        }
      } as never,
      providerConfig: null,
      telegramConfig: null,
      llmConfig: { ok: true, available: true, llm: { enabled: true } } as never
    });

    expect(model.candidateSensors.some((sensor) => sensor.id === "candidate-unknown")).toBe(false);
    expect(JSON.stringify(model.candidateSensors)).not.toContain('"target":"Unknown"');
    expect(JSON.stringify(model.candidateSensors)).not.toContain('"label":"Unknown"');
  });
});
