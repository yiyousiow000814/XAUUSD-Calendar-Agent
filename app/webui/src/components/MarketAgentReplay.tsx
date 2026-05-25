import type { MarketAgentEvidenceForRunResponse, MarketAgentReplayResponse } from "../types";
import type { CSSProperties } from "react";
import { MarketAgentStatusBadge } from "./MarketAgentStatusBadge";
import {
  formatDriverLabel,
  formatShortTime
} from "../utils/marketAgentUi";
import { normalizeMarketAgentReplayPayload } from "../utils/marketAgentReplay";
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

type TimelineRow = {
  key: string;
  time: string;
  type: string;
  title: string;
  meta: string;
  status: string;
  source: "event" | "news" | "calendar" | "alert" | "suppressed";
  payload?: Record<string, unknown>;
  monitorRunId?: number;
};

type TimelineKind = "breakout" | "news" | "reversal" | "range" | "session" | "recovery" | "suppressed" | "alert" | "calendar" | "evidence";

const timelineKindMeta: Record<TimelineKind, { tag: string; tone: string }> = {
  breakout: { tag: "BREAKOUT", tone: "red" },
  news: { tag: "NEWS", tone: "blue" },
  reversal: { tag: "REVERSAL", tone: "purple" },
  range: { tag: "RANGE", tone: "green" },
  session: { tag: "SESSION", tone: "amber" },
  recovery: { tag: "RECOVERY", tone: "green" },
  suppressed: { tag: "SUPPRESSED", tone: "muted" },
  alert: { tag: "ALERT", tone: "red" },
  calendar: { tag: "CALENDAR", tone: "amber" },
  evidence: { tag: "EVIDENCE", tone: "blue" }
};

const normalizeValue = (value: unknown) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

const numberValue = (value: unknown) => {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
};

const formatSignedValue = (value: number, suffix = "") => `${value > 0 ? "+" : ""}${value.toFixed(2)}${suffix}`;

const rawText = (value: unknown) => String(value ?? "").trim();

const summaryText = (item: Record<string, unknown> | undefined, fallback = "") => {
  for (const value of [
    item?.summary,
    item?.short_summary,
    item?.ai_summary,
    item?.display_summary,
    item?.description,
    fallback
  ]) {
    const text = rawText(value);
    if (text) return text;
  }
  return fallback;
};

const summaryTitle = (item: Record<string, unknown> | undefined, fallback: string) => {
  for (const value of [item?.summary_title, item?.short_title, item?.ai_title, item?.display_title, fallback]) {
    const text = rawText(value);
    if (text) return text;
  }
  return fallback;
};

const driverValue = (row: TimelineRow) => normalizeValue(row.payload?.main_driver ?? row.payload?.driver ?? row.meta);

const inferTimelineKind = (row: TimelineRow): TimelineKind => {
  const semanticType = normalizeValue(row.payload?.semantic_type);
  if (semanticType in timelineKindMeta) return semanticType as TimelineKind;
  const status = normalizeValue(row.status);
  const title = normalizeValue(row.title);
  if (row.source === "news" || title.includes("headline")) return "news";
  if (row.source === "calendar") return "calendar";
  if (row.source === "suppressed" || status.includes("suppressed")) return "suppressed";
  if (status.includes("recovery") || status.includes("backfilled")) return "recovery";
  if (title.includes("rebound") || title.includes("reverse") || title.includes("invalidated")) return "reversal";
  if (title.includes("session")) return "session";
  if (title.includes("range") || title.includes("quiet")) return "range";
  if (status.includes("level") || row.source === "alert") return "alert";
  if (title.includes("breakout") || title.includes("selloff") || title.includes("pressure") || title.includes("drop")) return "breakout";
  return "evidence";
};

const compactTimelineTitle = (row: TimelineRow) => {
  const impact = numberValue(row.payload?.impact_percent);
  const title = normalizeValue(row.title);
  const driver = driverValue(row);
  const titleIsRawDriver = Boolean(driver && title && (title === driver || driver.endsWith(`_${title}`)));
  if (impact !== null && (row.source === "alert" || titleIsRawDriver)) {
    const action = impact < 0 ? "XAUUSD drop" : impact > 0 ? "XAUUSD spike" : "XAUUSD flat";
    return `${action} ${formatSignedValue(impact, "%")}`;
  }
  return row.title;
};

const compactTimelineDetail = (row: TimelineRow) => summaryText(row.payload, replayMetaText(row));

const formatTimelineImpact = (row: TimelineRow) => {
  if (row.source === "calendar") {
    const impact = String(row.payload?.impact ?? "").toLowerCase();
    const contextType = String(row.payload?.context_type ?? "");
    if (impact === "holiday" || contextType === "liquidity_context") return "Liquidity context";
    return "Calendar context";
  }
  const payloadImpact = numberValue(row.payload?.impact_percent);
  const segment = row.payload?.segment as Record<string, unknown> | undefined;
  const segmentImpact = numberValue(segment?.move_percent);
  const impact = payloadImpact ?? segmentImpact;
  if (impact === null) return "Impact: watching";
  return `Impact: ${formatSignedValue(impact, "%")}`;
};

const timelineImpactValue = (row: TimelineRow) => {
  const payloadImpact = numberValue(row.payload?.impact_percent);
  const segment = row.payload?.segment as Record<string, unknown> | undefined;
  const segmentImpact = numberValue(segment?.move_percent);
  return payloadImpact ?? segmentImpact;
};

const replayMode = (rangePreset: string): "day" | "month" => (rangePreset === "month" ? "month" : "day");

const replayModeLabel = (rangePreset: string) => (replayMode(rangePreset) === "month" ? "Month: major turns" : "Day: detailed flow");

const hasConfirmedDriver = (row: TimelineRow) => {
  const driver = driverValue(row);
  return Boolean(driver && !["unknown", "no_state_change"].includes(driver));
};

const isMaintenanceRow = (row: TimelineRow) => {
  const kind = inferTimelineKind(row);
  const status = normalizeValue(row.status);
  const title = normalizeValue(row.title);
  return (
    kind === "recovery" ||
    row.source === "suppressed" ||
    title.includes("backfill") ||
    status.includes("recovery")
  );
};

const isMajorTimelineRow = (row: TimelineRow) => {
  const kind = inferTimelineKind(row);
  const impact = timelineImpactValue(row);
  const status = normalizeValue(row.status);
  const title = normalizeValue(row.title);
  if (isMaintenanceRow(row) || !hasConfirmedDriver(row)) return false;
  if (row.source === "alert") return typeof impact === "number" ? Math.abs(impact) >= 0.2 : true;
  if (["breakout", "reversal"].includes(kind)) return true;
  if (typeof impact === "number" && Math.abs(impact) >= 0.35) return true;
  if (status.includes("level_2") || status.includes("level_3") || status.includes("confirmed")) return true;
  return ["pressure", "breakout", "selloff", "drop", "spike", "reversal", "driver"].some((word) => title.includes(word));
};

const sourceLabel = (row: TimelineRow) => {
  if (row.source === "event") return "Monitor timeline";
  if (row.source === "news") return "News feed";
  if (row.source === "calendar") return "Calendar";
  if (row.source === "alert") return "Alert decision";
  return "Replay";
};

const replayMetaText = (row: TimelineRow) => {
  const meta = row.meta && row.meta !== "Unknown driver" ? row.meta : "Driver not confirmed";
  return `${meta} · ${sourceLabel(row)}`;
};

const majorRowKey = (row: TimelineRow) => {
  const impact = timelineImpactValue(row);
  const parsedTime = new Date(row.time);
  const timeKey = Number.isNaN(parsedTime.getTime())
    ? String(row.time)
    : parsedTime.toISOString().slice(0, 16);
  return [
    timeKey,
    inferTimelineKind(row),
    driverValue(row),
    impact === null ? "watching" : impact.toFixed(2),
    compactTimelineTitle(row).toLowerCase()
  ].join("|");
};

const dedupeMajorRows = (rows: TimelineRow[]) => {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = majorRowKey(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const buildTimelineRows = (payload: MarketAgentReplayResponse["replay"]): TimelineRow[] => {
  const eventRunIds = new Set(payload.timeline_events.map((item) => item.monitor_run_id).filter(Boolean));
  const reviewedCalendarEvents = payload.calendar_events.filter((item) => {
    const reviewStatus = normalizeValue(item.review_status);
    return reviewStatus && reviewStatus !== "unreviewed_context";
  });
  const rows: TimelineRow[] = [
    ...payload.timeline_events.map((item) => ({
      key: `timeline-${item.monitor_run_id}-${item.event_time}-${item.label}`,
      time: item.event_time,
      type: item.event_type,
      title: summaryTitle(item.payload, item.label),
      meta: formatDriverLabel((item.payload?.main_driver as string | undefined) ?? "unknown"),
      status: (item.payload?.cause_status as string | undefined) ?? item.event_type,
      source: "event" as const,
      payload: item.payload,
      monitorRunId: item.monitor_run_id
    })),
    ...payload.news_items.map((item, index) => ({
      key: `news-${index}-${String(item.published_at ?? item.title ?? "")}`,
      time: String(item.published_at ?? item.first_seen_at ?? ""),
      type: "News",
      title: summaryTitle(item, String(item.title ?? "News item")),
      meta: String(item.source ?? formatDriverLabel(item.driver ?? item.category ?? "news")),
      status: String(item.data_mode ?? "possible"),
      source: "news" as const,
      payload: item
    })),
    ...reviewedCalendarEvents.map((item, index) => ({
      key: `calendar-${index}-${String(item.scheduled_at ?? item.title ?? "")}`,
      time: String(item.scheduled_at ?? ""),
      type: "Calendar",
      title: summaryTitle(item, String(item.title ?? "Calendar event")),
      meta: formatDriverLabel(item.driver ?? item.currency ?? "calendar"),
      status: String(item.data_mode ?? "possible"),
      source: "calendar" as const,
      payload: item
    })),
    ...payload.alerts
      .filter((item) => !item.monitor_run_id || !eventRunIds.has(item.monitor_run_id))
      .map((item, index) => ({
        key: `alert-${index}-${item.monitor_run_id ?? index}`,
        time: String(item.run_started_at ?? ""),
        type: "Alert",
        title: summaryTitle(item, String(item.message ?? "Alert")),
        meta: formatDriverLabel(item.main_driver ?? "unknown"),
        status: String(item.notification_level ?? "confirmed"),
        source: "alert" as const,
        payload: item,
        monitorRunId: item.monitor_run_id
      }))
  ];

  return rows
    .filter((row) => row.time || row.title)
    .sort((left, right) => String(left.time).localeCompare(String(right.time)));
};

const buildMonthSummaryRows = (payload: MarketAgentReplayResponse["replay"]): TimelineRow[] => {
  if (!payload.month_summary_events?.length) return [];
  return payload.month_summary_events
    .map((item) => ({
      key: `month-summary-${item.monitor_run_id}-${item.event_time}-${item.label}`,
      time: item.event_time,
      type: item.event_type,
      title: summaryTitle(item.payload, item.label),
      meta: formatDriverLabel((item.payload?.main_driver as string | undefined) ?? "unknown"),
      status: (item.payload?.cause_status as string | undefined) ?? item.event_type,
      source: "event" as const,
      payload: item.payload,
      monitorRunId: item.monitor_run_id
    }))
    .filter((row) => row.time || row.title)
    .sort((left, right) => String(left.time).localeCompare(String(right.time)));
};

export function MarketAgentReplay({
  replay,
  selectedEvidence: _selectedEvidence,
  selectedMonitorRunId: _selectedMonitorRunId,
  rangePreset,
  rangeStartInput,
  rangeEndInput,
  onPresetChange,
  onRangeStartChange,
  onRangeEndChange,
  onApplyRange,
  onSelectRun: _onSelectRun
}: MarketAgentReplayProps) {
  const payload = normalizeMarketAgentReplayPayload(replay?.replay);
  const allRows = buildTimelineRows(payload);
  const mode = replayMode(rangePreset);
  const monthSummaryRows = buildMonthSummaryRows(payload);
  const rows = mode === "month" && monthSummaryRows.length ? monthSummaryRows : mode === "month" ? dedupeMajorRows(allRows.filter(isMajorTimelineRow)) : allRows;
  const modeLabel = replayModeLabel(rangePreset);
  const markerLabel = mode === "month" ? "major turns" : "market markers";

  return (
    <section className="market-agent-surface market-agent-replay-surface" data-qa="qa:market-agent:replay">
      <div className="market-agent-surface-header">
        <div>
          <h2>Market Replay</h2>
          <span className="hint">Price action, drivers, and confirmation sequence</span>
        </div>
      </div>

      <div className="market-agent-replay-controls">
        {[
          { value: "day", label: "Day" },
          { value: "month", label: "Month" }
        ].map((preset) => (
          <button
            key={preset.value}
            type="button"
            className={`btn ghost btn-compact${replayMode(rangePreset) === preset.value ? " primary" : ""}`}
            onClick={() => onPresetChange(preset.value)}
            data-qa={`qa:market-agent:range:${preset.value}`}
          >
            {preset.label}
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

      {!replay?.available ? (
        <div className="market-agent-empty-state">{replay?.message || "Replay data is unavailable."}</div>
      ) : (
        <div className="market-agent-replay-story" data-qa="qa:market-agent:timeline-list">
          <div className="market-agent-replay-story-head">
            <div>
              <span>Market Replay</span>
              <strong>{rows.length ? `${rows.length} ${markerLabel}` : "No replay markers"}</strong>
            </div>
            <MarketAgentStatusBadge label={modeLabel} tone="info" />
          </div>
          <div className="market-agent-replay-track">
            {rows.map((row, index) => {
              const kind = inferTimelineKind(row);
              const meta = timelineKindMeta[kind];
              return (
                <div
                  key={row.key}
                  className={`market-agent-replay-track-row kind-${meta.tone}`}
                  style={{ "--ma-replay-row-index": index } as CSSProperties}
                >
                  <time>{formatShortTime(row.time)}</time>
                  <span className="market-agent-replay-node" aria-hidden="true" />
                  <div className="market-agent-replay-row-body">
                    <div className="market-agent-replay-title-row">
                      <strong>{compactTimelineTitle(row)}</strong>
                      <span className={`market-agent-event-tag tone-${meta.tone}`}>{meta.tag}</span>
                    </div>
                    <div className="market-agent-replay-meta-row">
                      <span>{compactTimelineDetail(row)}</span>
                      <small>{formatTimelineImpact(row)}</small>
                    </div>
                  </div>
                </div>
              );
            })}
            {rows.length === 0 ? (
              <div className="market-agent-empty-state">
                {mode === "month" ? (
                  "No major turns in this window."
                ) : (
                  <>
                    <strong>No reviewed replay events in this window.</strong>
                    {payload.calendar_events.length ? (
                      <span>{payload.calendar_events.length} raw calendar context item(s) are available for evidence review.</span>
                    ) : null}
                  </>
                )}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}
