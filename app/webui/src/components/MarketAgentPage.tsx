import { useMemo, useState } from "react";

import type {
  MarketAgentDriverAttentionResponse,
  MarketAgentEvidenceForRunResponse,
  MarketAgentMonitorStatusResponse,
  MarketAgentProviderActionResponse,
  MarketAgentProviderConfigInput,
  MarketAgentProviderConfigResponse,
  MarketAgentProviderHealthEntry,
  MarketAgentProviderHealthResponse,
  MarketAgentLLMActionResponse,
  MarketAgentLLMConfigInput,
  MarketAgentLLMConfigResponse,
  MarketAgentReplayPayload,
  MarketAgentReplayResponse,
  MarketAgentSnapshotResponse,
  MarketAgentTelegramActionResponse,
  MarketAgentTelegramConfigInput,
  MarketAgentTelegramConfigResponse
} from "../types";
import { MarketAgentProviderConfig } from "./MarketAgentProviderConfig";
import { MarketAgentDriverAttention } from "./MarketAgentDriverAttention";
import { MarketAgentEvidencePanel } from "./MarketAgentEvidencePanel";
import { MarketAgentProviderHealth } from "./MarketAgentProviderHealth";
import { MarketAgentReplay } from "./MarketAgentReplay";
import { MarketAgentStatusBadge } from "./MarketAgentStatusBadge";
import {
  buildSituationSummary,
  findProviderHealth,
  formatDriverLabel,
  formatRelevance,
  formatShortTime,
  humanizeMarketAgentReason,
  humanizeMarketAgentValue,
  normalizeMarketAgentValue,
  providerGuidance
} from "../utils/marketAgentUi";
import "./MarketAgentPage.css";

type MarketAgentSection =
  | "live"
  | "drivers"
  | "replay"
  | "evidence"
  | "providers"
  | "sources"
  | "alerts"
  | "logs";

type MarketAgentPageProps = {
  snapshot: MarketAgentSnapshotResponse | null;
  providerConfig: MarketAgentProviderConfigResponse | null;
  telegramConfig: MarketAgentTelegramConfigResponse | null;
  llmConfig: MarketAgentLLMConfigResponse | null;
  providerHealth: MarketAgentProviderHealthResponse | null;
  driverAttention: MarketAgentDriverAttentionResponse | null;
  replay: MarketAgentReplayResponse | null;
  selectedEvidence: MarketAgentEvidenceForRunResponse | null;
  monitorStatus: MarketAgentMonitorStatusResponse | null;
  selectedMonitorRunId: number | null;
  rangePreset: string;
  rangeStartInput: string;
  rangeEndInput: string;
  onPresetChange: (preset: string) => void;
  onRangeStartChange: (value: string) => void;
  onRangeEndChange: (value: string) => void;
  onApplyRange: () => void;
  onSelectRun: (monitorRunId: number) => void;
  onSaveProviderConfig: (ctrader: MarketAgentProviderConfigInput) => void;
  onClearProviderConfig: () => void;
  onTestCTraderConnection: (ctrader: MarketAgentProviderConfigInput) => Promise<MarketAgentProviderActionResponse>;
  onResolveCTraderSymbol: (ctrader: MarketAgentProviderConfigInput) => Promise<MarketAgentProviderActionResponse>;
  onGetCTraderQuoteTest: (ctrader: MarketAgentProviderConfigInput) => Promise<MarketAgentProviderActionResponse>;
  onRefreshCTraderToken: (ctrader: MarketAgentProviderConfigInput) => Promise<MarketAgentProviderActionResponse>;
  onSaveTelegramConfig: (telegram: MarketAgentTelegramConfigInput) => Promise<MarketAgentTelegramConfigResponse>;
  onTestTelegramMessage: (telegram: MarketAgentTelegramConfigInput) => Promise<MarketAgentTelegramActionResponse>;
  onSaveLLMConfig: (llm: MarketAgentLLMConfigInput) => Promise<MarketAgentLLMConfigResponse>;
  onTestLLMConnection: (llm: MarketAgentLLMConfigInput) => Promise<MarketAgentLLMActionResponse>;
  onTestLLMJsonResponse: (llm: MarketAgentLLMConfigInput) => Promise<MarketAgentLLMActionResponse>;
  onRunMonitorOnce: () => Promise<MarketAgentMonitorStatusResponse>;
  onRunBackfillRecovery: () => Promise<MarketAgentMonitorStatusResponse>;
  onStartMonitorLoop: () => Promise<MarketAgentMonitorStatusResponse>;
  onStopMonitorLoop: () => Promise<MarketAgentMonitorStatusResponse>;
};

const sectionGroups: Array<{
  label: string;
  items: Array<{ id: MarketAgentSection; label: string }>;
}> = [
  {
    label: "Overview",
    items: [
      { id: "live", label: "Live Situation" },
      { id: "drivers", label: "Driver Attention" },
      { id: "replay", label: "Replay / Timeline" },
      { id: "evidence", label: "Evidence" }
    ]
  },
  {
    label: "Data & Health",
    items: [
      { id: "providers", label: "Provider Health" },
      { id: "sources", label: "Data Sources" }
    ]
  },
  {
    label: "System",
    items: [
      { id: "alerts", label: "Alerts" },
      { id: "logs", label: "Logs / Settings" }
    ]
  }
];

const providerStrip = [
  { title: "cTrader", keys: ["ctrader", "ctrader_openapi"], fallback: "Configure Open API tokens for spot." },
  { title: "Yahoo GC=F", keys: ["xauusd", "gc=f", "yahoo", "yahoo_finance"], fallback: "Fallback futures proxy." },
  { title: "DXY", keys: ["dxy", "dx-y.nyb"], fallback: "Needed for USD confirmation." },
  { title: "US10Y", keys: ["us10y", "^tnx"], fallback: "Needed for yield confirmation." },
  { title: "US2Y", keys: ["us2y"], fallback: "No reliable free source configured." },
  { title: "RSS News", keys: ["rss", "news", "google_news"], fallback: "Configure feeds for news evidence." },
  { title: "ForexFactory", keys: ["calendar", "forexfactory", "forex_factory"], fallback: "Configure calendar source." }
];

const formatValue = (value: unknown, fallback = "--") =>
  typeof value === "string" && value.trim()
    ? humanizeMarketAgentValue(value, fallback)
    : typeof value === "number"
      ? Number.isInteger(value)
        ? String(value)
        : value.toFixed(2)
      : typeof value === "boolean"
        ? value
          ? "Yes"
          : "No"
        : fallback;

const formatMonitorTime = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return formatShortTime(new Date(value > 10_000_000_000 ? value : value * 1000).toISOString());
  }
  return formatShortTime(value);
};

const statusForProvider = (item: MarketAgentProviderHealthEntry | undefined) => {
  if (!item) return "Disabled";
  const sourceType = normalizeMarketAgentValue(item.source_type);
  const dataMode = normalizeMarketAgentValue(item.data_mode);
  if (!item.is_available || dataMode === "unavailable") return "Unavailable";
  if (item.is_stale || dataMode === "stale") return "Stale data";
  if (sourceType === "futures_proxy" || dataMode === "proxy") return "Futures proxy";
  if (sourceType === "local_csv_fallback" || dataMode === "local_csv_fallback") return "Local CSV fallback";
  if (sourceType === "spot") return "Live data";
  if (dataMode === "backfilled") return "Backfilled";
  return "Live data";
};

const latestPrice = (replay: MarketAgentReplayResponse | null) => {
  const rows = replay?.replay.price_series ?? [];
  return rows[rows.length - 1] as Record<string, unknown> | undefined;
};

const latestTimelineRows = (payload: MarketAgentReplayPayload | undefined) => {
  if (!payload) return [];
  return [
    ...payload.timeline_events.map((item) => ({
      key: `event-${item.monitor_run_id}-${item.event_time}`,
      time: item.event_time,
      title: item.label,
      meta: formatDriverLabel(item.payload?.main_driver ?? "unknown"),
      status: item.event_type,
      monitorRunId: item.monitor_run_id
    })),
    ...payload.news_items.map((item, index) => ({
      key: `news-${index}-${String(item.published_at ?? item.title ?? "")}`,
      time: String(item.published_at ?? item.first_seen_at ?? ""),
      title: String(item.title ?? "News item"),
      meta: String(item.source ?? "News"),
      status: item.data_mode ?? "possible",
      monitorRunId: undefined
    })),
    ...payload.calendar_events.map((item, index) => ({
      key: `calendar-${index}-${String(item.scheduled_at ?? item.title ?? "")}`,
      time: String(item.scheduled_at ?? ""),
      title: String(item.title ?? "Calendar event"),
      meta: String(item.source ?? "Calendar"),
      status: item.data_mode ?? "possible",
      monitorRunId: undefined
    })),
    ...payload.alerts.map((item, index) => ({
      key: `alert-${index}-${item.monitor_run_id ?? index}`,
      time: String(item.run_started_at ?? ""),
      title: String(item.message ?? "Alert"),
      meta: formatDriverLabel(item.main_driver ?? "unknown"),
      status: item.notification_level ?? "alert",
      monitorRunId: item.monitor_run_id
    })),
    ...payload.suppressed_alerts.map((item, index) => ({
      key: `suppressed-${index}-${item.monitor_run_id ?? index}`,
      time: String(item.run_started_at ?? ""),
      title: String(item.message ?? "Suppressed alert"),
      meta: "No state change",
      status: "suppressed",
      monitorRunId: item.monitor_run_id
    }))
  ]
    .filter((item) => item.time || item.title)
    .sort((left, right) => String(right.time).localeCompare(String(left.time)))
    .slice(0, 6);
};

const evidenceItems = (selectedEvidence: MarketAgentEvidenceForRunResponse | null) => {
  const packet = selectedEvidence?.payload?.evidence_packet as Record<string, unknown> | undefined;
  const analysis = selectedEvidence?.payload?.analysis_result as Record<string, unknown> | undefined;
  const evidenceStatus = (packet?.evidence_status as Record<string, unknown> | undefined) ?? {};
  const allowed = Array.isArray(packet?.allowed_candidate_drivers) ? packet.allowed_candidate_drivers : [];
  const blocked = (packet?.blocked_drivers as Record<string, unknown> | undefined) ?? {};
  const rows = [
    ...allowed.map((driver) => ({
      title: formatDriverLabel(driver),
      status: "Supporting",
      detail: "Allowed by evidence gate"
    })),
    ...Object.entries(evidenceStatus).map(([key, value]) => ({
      title: formatDriverLabel(key),
      status: value,
      detail: "Evidence status"
    })),
    ...Object.entries(blocked).map(([key, value]) => ({
      title: formatDriverLabel(key),
      status: "Blocked",
      detail: String(value)
    }))
  ];
  if (analysis?.rejected_driver) {
    rows.push({
      title: formatDriverLabel(analysis.rejected_driver),
      status: "Rejected",
      detail: String(analysis.rejection_reason ?? "Rejected by validator")
    });
  }
  return rows.slice(0, 5);
};

function MarketAgentDashboard({
  snapshot,
  providerHealth,
  driverAttention,
  replay,
  selectedEvidence,
  onSelectRun,
  onNavigate
}: {
  snapshot: MarketAgentSnapshotResponse | null;
  providerHealth: MarketAgentProviderHealthResponse | null;
  driverAttention: MarketAgentDriverAttentionResponse | null;
  replay: MarketAgentReplayResponse | null;
  selectedEvidence: MarketAgentEvidenceForRunResponse | null;
  onSelectRun: (monitorRunId: number) => void;
  onNavigate: (section: MarketAgentSection) => void;
}) {
  const state = snapshot?.state;
  const xauusdHealth = findProviderHealth(providerHealth?.items, ["xauusd", "gc=f", "xauusd price"]);
  const price = latestPrice(replay);
  const timeline = latestTimelineRows(replay?.replay);
  const evidence = evidenceItems(selectedEvidence);
  const activeDrivers = (driverAttention?.states ?? [])
    .filter((item) => ["active", "active_macro"].includes(normalizeMarketAgentValue(item.current_state)))
    .sort((left, right) => (right.relevance_score ?? 0) - (left.relevance_score ?? 0));
  const watchingDrivers = (driverAttention?.states ?? [])
    .filter((item) => ["watching", "emerging", "cooling"].includes(normalizeMarketAgentValue(item.current_state)))
    .sort((left, right) => (right.relevance_score ?? 0) - (left.relevance_score ?? 0));
  const backgroundCount = (driverAttention?.states ?? []).filter((item) =>
    ["dormant", "retired", "unknown", ""].includes(normalizeMarketAgentValue(item.current_state))
  ).length;
  const situationGuidance = !snapshot?.available && snapshot?.message
    ? snapshot.message
    : providerGuidance(xauusdHealth);

  return (
    <section className="market-agent-cockpit" data-qa="qa:market-agent:cockpit">
      <div className="market-agent-cockpit-hero">
        <div>
          <span className="market-agent-section-kicker">Live Situation</span>
          <h2>{buildSituationSummary(snapshot, xauusdHealth)}</h2>
          <p>{situationGuidance}</p>
        </div>
        <div className="market-agent-monitor-chip">
          <span className="market-agent-live-dot" />
          <strong>{snapshot?.available ? "Monitoring live" : "Not running"}</strong>
          <span>Last updated {formatShortTime(state?.last_analysis_time)}</span>
        </div>
      </div>

      <div className="market-agent-kpi-grid">
        <article className="market-agent-kpi-card">
          <div>
            <h3>XAUUSD Price</h3>
            <MarketAgentStatusBadge label={statusForProvider(xauusdHealth)} />
          </div>
          <strong>{formatValue(price?.close_price ?? xauusdHealth?.current_value, "No price")}</strong>
          <span>{formatValue(price?.symbol ?? xauusdHealth?.source, "Source unavailable")}</span>
        </article>
        <article className="market-agent-kpi-card">
          <div>
            <h3>Market State</h3>
            <MarketAgentStatusBadge label={formatValue(state?.cause_status, "unknown")} />
          </div>
          <strong>{formatValue(state?.current_bias, "Unknown")}</strong>
          <span>{humanizeMarketAgentReason(state?.state_change_reason)}</span>
        </article>
        <article className="market-agent-kpi-card">
          <div>
            <h3>Latest Move</h3>
            <MarketAgentStatusBadge label={formatValue(state?.last_notification_level, "none")} />
          </div>
          <strong>{formatDriverLabel(state?.main_driver)}</strong>
          <span>{state?.last_alert_summary || "No alert summary yet."}</span>
        </article>
        <article className="market-agent-kpi-card">
          <div>
            <h3>Evidence Status</h3>
            <MarketAgentStatusBadge label={formatValue(state?.confidence, "unknown")} />
          </div>
          <strong>{formatValue(state?.cause_status, "Unknown")}</strong>
          <span>{evidence.length} evidence items visible</span>
        </article>
        <article className="market-agent-kpi-card">
          <div>
            <h3>Next Update</h3>
            <MarketAgentStatusBadge label={snapshot?.available ? "Live" : "Unavailable"} />
          </div>
          <strong>60 sec</strong>
          <span>Auto monitoring interval</span>
        </article>
      </div>

      <div className="market-agent-cockpit-panels">
        <section className="market-agent-cockpit-panel">
          <div className="market-agent-panel-title-row">
            <h3>Driver Attention Summary</h3>
            <button type="button" className="btn ghost btn-compact" onClick={() => onNavigate("drivers")}>
              View all drivers
            </button>
          </div>
          <div className="market-agent-attention-mini-list">
            {[...activeDrivers, ...watchingDrivers].slice(0, 7).map((driver) => (
              <div className="market-agent-attention-mini-row" key={driver.driver_id}>
                <div>
                  <strong>{driver.label || formatDriverLabel(driver.driver_id)}</strong>
                  <span>
                    {formatValue(driver.current_state, "unknown")} · {formatRelevance(driver.relevance_score)} ·{" "}
                    {driver.activation_reason || driver.deactivation_reason || "Observed as background only."}
                  </span>
                </div>
              </div>
            ))}
            {activeDrivers.length + watchingDrivers.length === 0 ? (
              <div className="market-agent-empty-state">No active or watching drivers.</div>
            ) : null}
          </div>
          <div className="market-agent-attention-counts">
            <span>{activeDrivers.length} active</span>
            <span>{watchingDrivers.length} watching</span>
            <span>{backgroundCount} background</span>
          </div>
        </section>

        <section className="market-agent-cockpit-panel">
          <div className="market-agent-panel-title-row">
            <h3>Market Replay Today</h3>
            <button type="button" className="btn ghost btn-compact" onClick={() => onNavigate("replay")}>
              Open Full Timeline
            </button>
          </div>
          <div className="market-agent-timeline-mini-list">
            {timeline.map((item) => (
              <button
                type="button"
                key={item.key}
                className="market-agent-timeline-mini-row"
                onClick={() => item.monitorRunId && onSelectRun(item.monitorRunId)}
              >
                <span>{formatShortTime(item.time)}</span>
                <strong>{item.title}</strong>
                <em>{item.meta}</em>
                <MarketAgentStatusBadge label={formatValue(item.status, "event")} />
              </button>
            ))}
            {timeline.length === 0 ? <div className="market-agent-empty-state">No replay events in this window.</div> : null}
          </div>
        </section>

        <section className="market-agent-cockpit-panel">
          <div className="market-agent-panel-title-row">
            <h3>Latest Evidence</h3>
            <button type="button" className="btn ghost btn-compact" onClick={() => onNavigate("evidence")}>
              View Evidence
            </button>
          </div>
          <div className="market-agent-evidence-mini-list">
            {evidence.map((item, index) => (
              <div className="market-agent-evidence-mini-row" key={`${item.title}-${index}`}>
                <strong>{item.title}</strong>
                <span>{item.detail}</span>
                <MarketAgentStatusBadge label={formatValue(item.status, "unknown")} />
              </div>
            ))}
            {evidence.length === 0 ? <div className="market-agent-empty-state">No evidence packet selected.</div> : null}
          </div>
        </section>
      </div>

      <section className="market-agent-provider-strip" aria-label="Provider Health">
        <div className="market-agent-provider-strip-head">
          <h3>Provider Health</h3>
          <button type="button" className="btn ghost btn-compact" onClick={() => onNavigate("providers")}>
            View all
          </button>
        </div>
        <div className="market-agent-provider-strip-grid">
          {providerStrip.map((provider) => {
            const item = findProviderHealth(providerHealth?.items, provider.keys);
            return (
              <article key={provider.title} className="market-agent-provider-strip-card">
                <div>
                  <strong>{provider.title}</strong>
                  <MarketAgentStatusBadge label={statusForProvider(item)} />
                </div>
                <span>{item?.source || provider.fallback}</span>
                <small>
                  {formatShortTime(item?.data_timestamp)} ·{" "}
                  {provider.title === "US2Y" ? providerGuidance(item) : item?.error || item?.stale_reason || providerGuidance(item)}
                </small>
              </article>
            );
          })}
        </div>
      </section>
    </section>
  );
}

export function MarketAgentPage(props: MarketAgentPageProps) {
  const [section, setSection] = useState<MarketAgentSection>("live");
  const content = useMemo(() => {
    if (section === "live") {
      return (
        <MarketAgentDashboard
          snapshot={props.snapshot}
          providerHealth={props.providerHealth}
          driverAttention={props.driverAttention}
          replay={props.replay}
          selectedEvidence={props.selectedEvidence}
          onSelectRun={props.onSelectRun}
          onNavigate={setSection}
        />
      );
    }
    if (section === "drivers") {
      return <MarketAgentDriverAttention data={props.driverAttention} />;
    }
    if (section === "replay") {
      return (
        <MarketAgentReplay
          replay={props.replay}
          selectedEvidence={props.selectedEvidence}
          selectedMonitorRunId={props.selectedMonitorRunId}
          rangePreset={props.rangePreset}
          rangeStartInput={props.rangeStartInput}
          rangeEndInput={props.rangeEndInput}
          onPresetChange={props.onPresetChange}
          onRangeStartChange={props.onRangeStartChange}
          onRangeEndChange={props.onRangeEndChange}
          onApplyRange={props.onApplyRange}
          onSelectRun={props.onSelectRun}
        />
      );
    }
    if (section === "evidence") {
      return <MarketAgentEvidencePanel data={props.selectedEvidence} />;
    }
    if (section === "providers") {
      return <MarketAgentProviderHealth data={props.providerHealth} />;
    }
    if (section === "sources") {
      return (
        <MarketAgentProviderConfig
          data={props.providerConfig}
          telegramData={props.telegramConfig}
          llmData={props.llmConfig}
          onSave={props.onSaveProviderConfig}
          onClear={props.onClearProviderConfig}
          onTestConnection={props.onTestCTraderConnection}
          onResolveSymbol={props.onResolveCTraderSymbol}
          onQuoteTest={props.onGetCTraderQuoteTest}
          onRefreshToken={props.onRefreshCTraderToken}
          onSaveTelegram={props.onSaveTelegramConfig}
          onTestTelegram={props.onTestTelegramMessage}
          onSaveLLM={props.onSaveLLMConfig}
          onTestLLMConnection={props.onTestLLMConnection}
          onTestLLMJsonResponse={props.onTestLLMJsonResponse}
          monitorStatus={props.monitorStatus}
          onRunMonitorOnce={props.onRunMonitorOnce}
          onRunBackfillRecovery={props.onRunBackfillRecovery}
          onStartMonitorLoop={props.onStartMonitorLoop}
          onStopMonitorLoop={props.onStopMonitorLoop}
        />
      );
    }
    if (section === "alerts") {
      return (
        <section className="market-agent-surface">
          <div className="market-agent-surface-header">
            <div>
              <h2>Alerts</h2>
              <span className="hint">Recent sent and suppressed market-agent alerts</span>
            </div>
          </div>
          <div className="market-agent-alerts-list">
            {(props.replay?.replay.alerts ?? []).map((alert, index) => (
              <div key={`alert-${index}`} className="market-agent-evidence-mini-row">
                <strong>{formatValue(alert.message, "Alert")}</strong>
                <span>{formatShortTime(alert.run_started_at)}</span>
                <MarketAgentStatusBadge label={formatValue(alert.notification_level, "alert")} />
              </div>
            ))}
            {(props.replay?.replay.suppressed_alerts ?? []).map((alert, index) => (
              <div key={`suppressed-${index}`} className="market-agent-evidence-mini-row">
                <strong>{formatValue(alert.message, "Suppressed alert")}</strong>
                <span>{formatShortTime(alert.run_started_at)}</span>
                <MarketAgentStatusBadge label="Suppressed" />
              </div>
            ))}
          </div>
        </section>
      );
    }
    return (
      <section className="market-agent-surface">
        <div className="market-agent-surface-header">
          <div>
            <h2>Logs / Settings</h2>
            <span className="hint">Control the Windows-friendly monitor loop and inspect last process status.</span>
          </div>
        </div>
        <div className="market-agent-monitor-control">
          <article>
            <div>
              <h3>Monitor Process</h3>
              <MarketAgentStatusBadge label={props.monitorStatus?.running ? "Running" : formatValue(props.monitorStatus?.phase, "Stopped")} />
            </div>
            <p>{props.monitorStatus?.message || "Monitor loop is stopped."}</p>
            <div className="market-agent-monitor-control-grid">
              <span>PID</span>
              <strong>{formatValue(props.monitorStatus?.pid, "--")}</strong>
              <span>Last run</span>
              <strong>{formatMonitorTime(props.monitorStatus?.lastRunAt)}</strong>
              <span>Next run</span>
              <strong>{formatMonitorTime(props.monitorStatus?.nextRunAt)}</strong>
              <span>Last error</span>
              <strong>{props.monitorStatus?.lastError || "None"}</strong>
            </div>
            <div className="market-agent-monitor-actions">
              <button type="button" className="btn ghost btn-compact" onClick={() => void props.onRunMonitorOnce()}>
                Run once
              </button>
              <button type="button" className="btn ghost btn-compact" onClick={() => void props.onStartMonitorLoop()}>
                Start monitor loop
              </button>
              <button type="button" className="btn ghost btn-compact" onClick={() => void props.onStopMonitorLoop()}>
                Stop monitor loop
              </button>
            </div>
          </article>
          <article>
            <div>
              <h3>Telegram Reporting</h3>
              <MarketAgentStatusBadge label="Optional" />
            </div>
            <p>
              Telegram is disabled unless configured by environment or saved settings. Failed sends are recorded with
              alert history and do not stop monitoring.
            </p>
          </article>
        </div>
      </section>
    );
  }, [props, section]);

  return (
    <div className="market-agent-page market-agent-cockpit-shell" data-qa="qa:page:market-agent">
      <aside className="market-agent-side-nav">
        <div className="market-agent-side-brand">
          <span>ALPHA</span>
          <strong>Market Agent</strong>
        </div>
        <nav aria-label="Market Agent sections">
          {sectionGroups.map((group) => (
            <div className="market-agent-side-group" key={group.label}>
              <span>{group.label}</span>
              {group.items.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  aria-pressed={section === item.id}
                  className={section === item.id ? "active" : ""}
                  onClick={() => setSection(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="market-agent-quick-actions">
          <strong>Quick Actions</strong>
          <button type="button" onClick={() => void props.onRunMonitorOnce()}>Run Monitor Once</button>
          <button type="button" onClick={() => void props.onRunBackfillRecovery()}>Backfill & Recover</button>
          <button type="button" onClick={() => setSection("sources")}>Configure Data Sources</button>
        </div>
      </aside>
      <main className="market-agent-cockpit-main">{content}</main>
    </div>
  );
}
