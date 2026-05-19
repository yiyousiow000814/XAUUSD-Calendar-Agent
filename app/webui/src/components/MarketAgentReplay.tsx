import type { MarketAgentEvidenceForRunResponse, MarketAgentReplayResponse } from "../types";
import { MarketAgentStatusBadge } from "./MarketAgentStatusBadge";
import {
  formatDriverLabel,
  formatShortTime,
  humanizeMarketAgentReason,
  humanizeMarketAgentValue
} from "../utils/marketAgentUi";
import "./MarketAgentReplay.css";

type MarketAgentReplayProps = {
  replay: MarketAgentReplayResponse | null;
  selectedEvidence: MarketAgentEvidenceForRunResponse | null;
  selectedMonitorRunId: number | null;
  rangePreset: string;
  rangeStartInput: string;
  rangeEndInput: string;
  onPresetChange: (preset: string) => void;
  onRangeStartChange: (value: string) => void;
  onRangeEndChange: (value: string) => void;
  onApplyRange: () => void;
  onSelectRun: (monitorRunId: number) => void;
};

const formatValue = (value: unknown, fallback = "--") =>
  typeof value === "string" && value.trim()
    ? humanizeMarketAgentValue(value, fallback)
    : typeof value === "number"
      ? String(value)
      : fallback;

const renderBadge = (label: unknown, tone: "default" | "info" | "warn" | "good" | "danger" = "default") => (
  <MarketAgentStatusBadge
    label={formatValue(label, "unknown")}
    tone={tone === "default" ? undefined : tone === "danger" ? "bad" : tone}
  />
);

type TimelineRow = {
  key: string;
  time: string;
  type: string;
  title: string;
  driver: string;
  status: string;
  monitorRunId?: number;
};

const buildTimelineRows = (payload: MarketAgentReplayResponse["replay"]): TimelineRow[] => {
  const rows: TimelineRow[] = [
    ...payload.timeline_events.map((item) => ({
      key: `timeline-${item.monitor_run_id}-${item.event_time}-${item.label}`,
      time: item.event_time,
      type: item.event_type,
      title: item.label,
      driver: formatDriverLabel((item.payload?.main_driver as string | undefined) ?? "unknown"),
      status: (item.payload?.cause_status as string | undefined) ?? item.event_type,
      monitorRunId: item.monitor_run_id
    })),
    ...payload.news_items.map((item, index) => ({
      key: `news-${index}-${String(item.published_at ?? item.title ?? "")}`,
      time: String(item.published_at ?? item.first_seen_at ?? ""),
      type: "News",
      title: String(item.title ?? "News item"),
      driver: formatDriverLabel(item.driver ?? item.category ?? "unknown"),
      status: String(item.data_mode ?? "possible")
    })),
    ...payload.calendar_events.map((item, index) => ({
      key: `calendar-${index}-${String(item.scheduled_at ?? item.title ?? "")}`,
      time: String(item.scheduled_at ?? ""),
      type: "Calendar",
      title: String(item.title ?? "Calendar event"),
      driver: formatDriverLabel(item.driver ?? item.currency ?? "calendar"),
      status: String(item.data_mode ?? "possible")
    })),
    ...payload.alerts.map((item, index) => ({
      key: `alert-${index}-${item.monitor_run_id ?? index}`,
      time: String(item.run_started_at ?? ""),
      type: "Alert",
      title: String(item.message ?? "Alert"),
      driver: formatDriverLabel(item.main_driver ?? "unknown"),
      status: String(item.notification_level ?? "confirmed"),
      monitorRunId: item.monitor_run_id
    })),
    ...payload.suppressed_alerts.map((item, index) => ({
      key: `suppressed-${index}-${item.monitor_run_id ?? index}`,
      time: String(item.run_started_at ?? ""),
      type: "Suppressed",
      title: String(item.message ?? "Suppressed alert"),
      driver: "No state change",
      status: "suppressed",
      monitorRunId: item.monitor_run_id
    }))
  ];

  return rows
    .filter((row) => row.time || row.title)
    .sort((left, right) => String(right.time).localeCompare(String(left.time)))
    .slice(0, 12);
};

export function MarketAgentReplay({
  replay,
  selectedEvidence,
  selectedMonitorRunId,
  rangePreset,
  rangeStartInput,
  rangeEndInput,
  onPresetChange,
  onRangeStartChange,
  onRangeEndChange,
  onApplyRange,
  onSelectRun
}: MarketAgentReplayProps) {
  const payload = replay?.replay;

  return (
    <section className="market-agent-surface" data-qa="qa:market-agent:replay">
      <div className="market-agent-surface-header">
        <div>
          <h2>Recent Timeline</h2>
          <span className="hint">Recent price, news, calendar, alert, suppressed, and recovery markers</span>
        </div>
      </div>

      <div className="market-agent-replay-controls">
        {["1h", "4h", "today"].map((preset) => (
          <button
            key={preset}
            type="button"
            className={`btn ghost btn-compact${rangePreset === preset ? " primary" : ""}`}
            onClick={() => onPresetChange(preset)}
            data-qa={`qa:market-agent:range:${preset}`}
          >
            {preset === "1h" ? "Last 1h" : preset === "4h" ? "Last 4h" : "Today"}
          </button>
        ))}
        <input
          type="datetime-local"
          value={rangeStartInput}
          onChange={(event) => onRangeStartChange(event.target.value)}
          data-qa="qa:market-agent:range-start"
        />
        <input
          type="datetime-local"
          value={rangeEndInput}
          onChange={(event) => onRangeEndChange(event.target.value)}
          data-qa="qa:market-agent:range-end"
        />
        <button type="button" className="btn ghost btn-compact" onClick={onApplyRange} data-qa="qa:market-agent:apply-range">
          Apply
        </button>
      </div>

      {!replay?.available || !payload ? (
        <div className="market-agent-empty-state">{replay?.message || "Replay data is unavailable."}</div>
      ) : (
        <>
        <div className="market-agent-recent-timeline" data-qa="qa:market-agent:timeline-list">
          {buildTimelineRows(payload).map((row) => (
            <button
              key={row.key}
              type="button"
              className={`market-agent-timeline-row${selectedMonitorRunId === row.monitorRunId ? " selected" : ""}`}
              onClick={() => row.monitorRunId && onSelectRun(row.monitorRunId)}
            >
              <span className="market-agent-timeline-time">{formatShortTime(row.time)}</span>
              <span className="market-agent-timeline-main">
                <strong>{row.title}</strong>
                <span>{row.driver}</span>
              </span>
              <MarketAgentStatusBadge label={row.type} tone="info" />
              <MarketAgentStatusBadge label={row.status} />
            </button>
          ))}
          {buildTimelineRows(payload).length === 0 ? (
            <div className="market-agent-empty-state">No timeline items in this window.</div>
          ) : null}
        </div>

        <details className="market-agent-full-replay" data-qa="qa:market-agent:full-replay">
          <summary>Open full replay</summary>
          <div className="market-agent-replay-grid">
          <div className="market-agent-replay-column">
            <div className="market-agent-replay-block" data-qa="qa:market-agent:price-series">
              <div className="market-agent-replay-block-head">
                <h3>Price series</h3>
                <span>{payload.price_series.length} rows</span>
              </div>
              <div className="market-agent-list">
                {payload.price_series.map((row, index) => (
                  <div key={`price-${index}`} className="market-agent-list-item">
                    <div className="market-agent-list-title">
                      <strong>{formatValue(row.symbol)}</strong>
                      <MarketAgentStatusBadge label={formatValue(row.source_type, "unknown")} tone="info" />
                    </div>
                    <div className="market-agent-list-meta">
                      <span>{formatValue(row.data_timestamp)}</span>
                      <span>Close {formatValue(row.close_price)}</span>
                      <span>{formatValue(row.data_mode)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="market-agent-replay-block" data-qa="qa:market-agent:related-assets">
              <div className="market-agent-replay-block-head">
                <h3>Related assets</h3>
                <span>Observed, not always active</span>
              </div>
              <div className="market-agent-list">
                {Object.entries(payload.related_assets).map(([symbol, rows]) => {
                  const latest = rows[rows.length - 1] as Record<string, unknown> | undefined;
                  return (
                    <div key={symbol} className="market-agent-list-item">
                      <div className="market-agent-list-title">
                        <strong>{symbol}</strong>
                        <MarketAgentStatusBadge label={formatValue(latest?.data_mode, rows.length ? "live" : "unavailable")} />
                      </div>
                      <div className="market-agent-list-meta">
                        <span>{formatValue(latest?.data_timestamp)}</span>
                        <span>15m {formatValue(latest?.change_15m)}</span>
                        <span>{rows.length ? formatValue(latest?.source_type) : "unavailable"}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="market-agent-replay-column">
            <div className="market-agent-replay-block" data-qa="qa:market-agent:timeline-list">
              <div className="market-agent-replay-block-head">
                <h3>Timeline events</h3>
                <span>{payload.timeline_events.length} items</span>
              </div>
              <div className="market-agent-list">
                {payload.timeline_events.map((item) => (
                  <button
                    key={`${item.monitor_run_id}-${item.event_time}-${item.label}`}
                    type="button"
                    className={`market-agent-list-item action${selectedMonitorRunId === item.monitor_run_id ? " selected" : ""}`}
                    onClick={() => onSelectRun(item.monitor_run_id)}
                  >
                    <div className="market-agent-list-title">
                      <strong>{item.label}</strong>
                      <MarketAgentStatusBadge label={item.event_type} tone="info" />
                    </div>
                    <div className="market-agent-list-meta">
                      <span>{item.event_time}</span>
                      <span>run {item.monitor_run_id}</span>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div className="market-agent-replay-block" data-qa="qa:market-agent:news-items">
              <div className="market-agent-replay-block-head">
                <h3>News items</h3>
                <span>{payload.news_items.length} items</span>
              </div>
              <div className="market-agent-list">
                {payload.news_items.map((item, index) => (
                  <div key={`news-${index}`} className="market-agent-list-item">
                    <div className="market-agent-list-title">
                      <strong>{formatValue(item.title)}</strong>
                      {renderBadge(item.data_mode)}
                    </div>
                    <div className="market-agent-list-meta">
                      <span>{formatValue(item.published_at)}</span>
                      <span>{formatValue(item.source)}</span>
                    </div>
                  </div>
                ))}
                {payload.news_items.length === 0 ? <div className="market-agent-empty-state">No news items in this window.</div> : null}
              </div>
            </div>

            <div className="market-agent-replay-block" data-qa="qa:market-agent:calendar-events">
              <div className="market-agent-replay-block-head">
                <h3>Calendar events</h3>
                <span>{payload.calendar_events.length} items</span>
              </div>
              <div className="market-agent-list">
                {payload.calendar_events.map((item, index) => (
                  <div key={`calendar-${index}`} className="market-agent-list-item">
                    <div className="market-agent-list-title">
                      <strong>{formatValue(item.title)}</strong>
                      {renderBadge(item.data_mode)}
                    </div>
                    <div className="market-agent-list-meta">
                      <span>{formatValue(item.scheduled_at)}</span>
                      <span>{formatValue(item.source)}</span>
                    </div>
                  </div>
                ))}
                {payload.calendar_events.length === 0 ? <div className="market-agent-empty-state">No calendar events in this window.</div> : null}
              </div>
            </div>

            <div className="market-agent-replay-block" data-qa="qa:market-agent:driver-attention-timeline">
              <div className="market-agent-replay-block-head">
                <h3>Driver attention changes</h3>
                <span>{payload.driver_attention_timeline.length} items</span>
              </div>
              <div className="market-agent-list">
                {payload.driver_attention_timeline.map((item, index) => (
                  <div key={`driver-timeline-${index}`} className="market-agent-list-item">
                    <div className="market-agent-list-title">
                      <strong>{formatValue(item.driver_id, `driver ${index + 1}`)}</strong>
                      {renderBadge(item.current_state)}
                    </div>
                    <div className="market-agent-list-meta">
                      <span>{formatValue(item.last_confirmed_at, formatValue(item.run_started_at))}</span>
                      <span>{formatValue(item.data_mode)}</span>
                    </div>
                  </div>
                ))}
                {payload.driver_attention_timeline.length === 0 ? (
                  <div className="market-agent-empty-state">No driver-attention changes in this window.</div>
                ) : null}
              </div>
            </div>

            <div className="market-agent-replay-block" data-qa="qa:market-agent:state-transitions">
              <div className="market-agent-replay-block-head">
                <h3>State transitions</h3>
                <span>{payload.state_transitions.length} items</span>
              </div>
              <div className="market-agent-list">
                {payload.state_transitions.map((item, index) => (
                  <div key={`state-transition-${index}`} className="market-agent-list-item">
                    <div className="market-agent-list-title">
                      <strong>{humanizeMarketAgentReason(item.state_change_reason, "State transition")}</strong>
                      {renderBadge(item.main_driver ?? "state")}
                    </div>
                    <div className="market-agent-list-meta">
                      <span>{formatValue(item.run_started_at)}</span>
                      <span>run {formatValue(item.monitor_run_id)}</span>
                    </div>
                  </div>
                ))}
                {payload.state_transitions.length === 0 ? (
                  <div className="market-agent-empty-state">No state transitions in this window.</div>
                ) : null}
              </div>
            </div>

            <div className="market-agent-replay-block" data-qa="qa:market-agent:alerts">
              <div className="market-agent-replay-block-head">
                <h3>Alerts</h3>
                <span>Click an alert for evidence</span>
              </div>
              <div className="market-agent-list">
                {payload.alerts.map((item, index) => (
                  <button
                    key={`alert-${index}-${item.monitor_run_id ?? index}`}
                    type="button"
                    className={`market-agent-list-item action${selectedMonitorRunId === item.monitor_run_id ? " selected" : ""}`}
                    onClick={() => item.monitor_run_id && onSelectRun(item.monitor_run_id)}
                  >
                    <div className="market-agent-list-title">
                      <strong>{formatValue(item.message)}</strong>
                      {renderBadge(item.notification_level ?? "confirmed")}
                    </div>
                    <div className="market-agent-list-meta">
                      <span>{formatValue(item.run_started_at)}</span>
                      <span>run {formatValue(item.monitor_run_id)}</span>
                    </div>
                  </button>
                ))}
                {payload.alerts.length === 0 ? <div className="market-agent-empty-state">No alerts in this window.</div> : null}
              </div>
            </div>

            <div className="market-agent-replay-block" data-qa="qa:market-agent:suppressed-alerts">
              <div className="market-agent-replay-block-head">
                <h3>Suppressed alerts</h3>
                <span>Still persisted for replay and audit</span>
              </div>
              <div className="market-agent-list">
                {payload.suppressed_alerts.map((item, index) => (
                  <button
                    key={`suppressed-${index}-${item.monitor_run_id ?? index}`}
                    type="button"
                    className={`market-agent-list-item action${selectedMonitorRunId === item.monitor_run_id ? " selected" : ""}`}
                    onClick={() => item.monitor_run_id && onSelectRun(item.monitor_run_id)}
                  >
                    <div className="market-agent-list-title">
                      <strong>{formatValue(item.message)}</strong>
                      {renderBadge("suppressed", "warn")}
                    </div>
                    <div className="market-agent-list-meta">
                      <span>{formatValue(item.run_started_at)}</span>
                      <span>{formatValue(item.notification_level)}</span>
                    </div>
                  </button>
                ))}
                {payload.suppressed_alerts.length === 0 ? (
                  <div className="market-agent-empty-state">No suppressed alerts in this window.</div>
                ) : null}
              </div>
            </div>

            <div className="market-agent-replay-block" data-qa="qa:market-agent:recovery-markers">
              <div className="market-agent-replay-block-head">
                <h3>Recovery / backfilled markers</h3>
                <span>Backfilled and recovery events stay visible</span>
              </div>
              <div className="market-agent-list">
                {payload.timeline_events
                  .filter((item) => {
                    const dataMode = typeof item.payload?.data_mode === "string" ? item.payload.data_mode : "";
                    return item.event_type.includes("recovery") || dataMode === "backfilled";
                  })
                  .map((item) => (
                    <button
                      key={`recovery-${item.monitor_run_id}-${item.event_time}-${item.label}`}
                      type="button"
                      className={`market-agent-list-item action${selectedMonitorRunId === item.monitor_run_id ? " selected" : ""}`}
                      onClick={() => onSelectRun(item.monitor_run_id)}
                    >
                      <div className="market-agent-list-title">
                        <strong>{item.label}</strong>
                        {renderBadge(
                          typeof item.payload?.data_mode === "string" ? item.payload.data_mode : item.event_type
                        )}
                      </div>
                      <div className="market-agent-list-meta">
                        <span>{item.event_time}</span>
                        <span>run {item.monitor_run_id}</span>
                      </div>
                    </button>
                  ))}
                {!payload.timeline_events.some((item) => {
                  const dataMode = typeof item.payload?.data_mode === "string" ? item.payload.data_mode : "";
                  return item.event_type.includes("recovery") || dataMode === "backfilled";
                }) ? (
                  <div className="market-agent-empty-state">No recovery markers in this window.</div>
                ) : null}
              </div>
            </div>
          </div>
          </div>
        </details>
        </>
      )}

      {selectedEvidence?.available && selectedEvidence.payload?.monitor_run ? (
        <div className="market-agent-replay-selection-note">
          Selected run: {formatValue((selectedEvidence.payload.monitor_run as Record<string, unknown>).run_started_at)}
        </div>
      ) : null}
    </section>
  );
}
