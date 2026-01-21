import { useEffect, useMemo, useState } from "react";
import type { EventHistoryPoint, EventHistoryResponse } from "../types";
import { Select } from "./Select";
import "./EventHistoryModal.css";

type EventHistoryModalProps = {
  isOpen: boolean;
  loading: boolean;
  error: string | null;
  selectionLabel: string;
  data: EventHistoryResponse | null;
  eventOptions: Array<{ value: string; label: string }>;
  selectedEventKey: string;
  onSelectEvent: (value: string) => void;
  onClose: () => void;
};

const isMissingValue = (value: string | null | undefined) => {
  const normalized = (value ?? "").trim().toLowerCase();
  return (
    normalized.length === 0 ||
    normalized === "--" ||
    normalized === "\u2014" ||
    normalized === "-" ||
    normalized === "tba" ||
    normalized === "n/a" ||
    normalized === "na" ||
    normalized === "null"
  );
};

const parseComparableNumber = (rawValue: string) => {
  if (isMissingValue(rawValue)) return null;
  const cleaned = rawValue
    .trim()
    .replaceAll(",", "")
    .replaceAll("%", "")
    .replaceAll(" ", "");
  const match = cleaned.match(/^([+-]?\d+(?:\.\d+)?)([kmb])?$/i);
  if (!match) return null;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return null;
  const suffix = match[2]?.toLowerCase();
  if (suffix === "k") return base * 1_000;
  if (suffix === "m") return base * 1_000_000;
  if (suffix === "b") return base * 1_000_000_000;
  return base;
};

const formatDisplayDate = (value: string) => {
  const [year, month, day] = value.split("-");
  if (!year || !month || !day) return value;
  return `${day}-${month}-${year}`;
};

const extractSeries = (points: EventHistoryPoint[], key: keyof EventHistoryPoint) =>
  points.map((item) => parseComparableNumber(String(item[key] ?? "")));

const buildPath = (values: Array<number | null>, width: number, height: number, min: number, max: number) => {
  if (values.length <= 1) return "";
  const span = max - min || 1;
  const step = width / Math.max(1, values.length - 1);
  let path = "";
  let started = false;
  values.forEach((value, index) => {
    if (value === null) {
      started = false;
      return;
    }
    const x = index * step;
    const y = height - ((value - min) / span) * height;
    if (!started) {
      path += `M ${x.toFixed(2)} ${y.toFixed(2)}`;
      started = true;
    } else {
      path += ` L ${x.toFixed(2)} ${y.toFixed(2)}`;
    }
  });
  return path;
};

const getRangeLabel = (points: EventHistoryPoint[]) => {
  if (!points.length) return "";
  const first = points[0]?.date || "";
  const last = points[points.length - 1]?.date || "";
  if (!first || !last) return "";
  return `${formatDisplayDate(first)} -> ${formatDisplayDate(last)}`;
};

export function EventHistoryModal({
  isOpen,
  loading,
  error,
  selectionLabel,
  data,
  eventOptions,
  selectedEventKey,
  onSelectEvent,
  onClose
}: EventHistoryModalProps) {
  const [displayMode, setDisplayMode] = useState<"recent" | "all">("recent");
  const [visibleSeries, setVisibleSeries] = useState({
    actual: true,
    forecast: true,
    previous: true
  });
  const points = data?.points ?? [];
  const hasData = points.length > 0;
  const hasVisibleSeries = visibleSeries.actual || visibleSeries.forecast || visibleSeries.previous;
  const displayPoints = useMemo(() => {
    if (displayMode === "recent") {
      return points.slice(-5);
    }
    return points;
  }, [displayMode, points]);
  const rangeLabel = getRangeLabel(displayPoints);
  const showEventPicker = eventOptions.length > 1;

  useEffect(() => {
    if (!isOpen) return;
    setDisplayMode("recent");
  }, [isOpen, selectionLabel]);

  const chart = useMemo(() => {
    if (!hasData) {
      return null;
    }
    if (!hasVisibleSeries) {
      return null;
    }
    const actualValues = visibleSeries.actual ? extractSeries(displayPoints, "actual") : [];
    const forecastValues = visibleSeries.forecast ? extractSeries(displayPoints, "forecast") : [];
    const previousValues = visibleSeries.previous ? extractSeries(displayPoints, "previous") : [];
    const numericValues = [...actualValues, ...forecastValues, ...previousValues].filter(
      (value): value is number => value !== null
    );
    if (!numericValues.length) {
      return null;
    }
    const min = Math.min(...numericValues);
    const max = Math.max(...numericValues);
    const width = 520;
    const height = 180;
    return {
      width,
      height,
      actualPath: visibleSeries.actual ? buildPath(actualValues, width, height, min, max) : "",
      forecastPath: visibleSeries.forecast ? buildPath(forecastValues, width, height, min, max) : "",
      previousPath: visibleSeries.previous ? buildPath(previousValues, width, height, min, max) : ""
    };
  }, [displayPoints, hasData, hasVisibleSeries, visibleSeries]);

  const toggleSeries = (key: "actual" | "forecast" | "previous") => {
    setVisibleSeries((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      if (!next.actual && !next.forecast && !next.previous) {
        return prev;
      }
      return next;
    });
  };

  if (!isOpen) return null;

  return (
    <div className="modal-backdrop open" role="presentation" onClick={onClose}>
      <div
        className="modal modal-history open"
        role="dialog"
        aria-modal="true"
        aria-label="Event history"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div className="modal-title">
            <div className="modal-title-text">Event history</div>
            <div className="modal-subtitle">{selectionLabel}</div>
          </div>
          <button type="button" className="btn ghost" onClick={onClose} data-qa="qa:modal-close:history">
            Close
          </button>
        </div>
        <div className="modal-body">
          {loading ? <div className="history-modal-loading">Loading history...</div> : null}
          {!loading && error ? <div className="history-modal-error">{error}</div> : null}
          {!loading && !error && !hasData ? (
            <div className="history-modal-empty">No history available yet.</div>
          ) : null}
          {!loading && !error && hasData ? (
            <div className="history-modal-content">
              <div className="history-modal-controls">
                {showEventPicker ? (
                  <div className="history-modal-control">
                    <span className="history-modal-label">Event</span>
                    <Select
                      value={selectedEventKey}
                      options={eventOptions}
                      onChange={(value) => {
                        if (value && value !== selectedEventKey) {
                          onSelectEvent(value);
                        }
                      }}
                      qa="qa:history:event-select"
                    />
                  </div>
                ) : null}
                <div className="history-modal-control">
                  <span className="history-modal-label">Range</span>
                  <div className="history-modal-toggle">
                    <button
                      type="button"
                      className={`history-toggle${displayMode === "recent" ? " active" : ""}`}
                      onClick={() => setDisplayMode("recent")}
                    >
                      Last 5
                    </button>
                    <button
                      type="button"
                      className={`history-toggle${displayMode === "all" ? " active" : ""}`}
                      onClick={() => setDisplayMode("all")}
                    >
                      All
                    </button>
                  </div>
                </div>
              </div>
              <div className="history-modal-meta">
                <span className="history-modal-pill">{points.length} releases</span>
                {rangeLabel ? <span className="history-modal-pill">{rangeLabel}</span> : null}
                {displayMode === "recent" && points.length > 5 ? (
                  <span className="history-modal-pill">Last 5</span>
                ) : null}
                {data?.frequency && data.frequency !== "none" ? (
                  <span className="history-modal-pill">Frequency {data.frequency}</span>
                ) : null}
                {data?.period ? <span className="history-modal-pill">Period {data.period}</span> : null}
              </div>
              {chart ? (
                <div className="history-modal-chart">
                  <svg viewBox={`0 0 ${chart.width} ${chart.height}`} role="img" aria-label="Event history chart">
                    <path className="history-line history-line-previous" d={chart.previousPath} />
                    <path className="history-line history-line-forecast" d={chart.forecastPath} />
                    <path className="history-line history-line-actual" d={chart.actualPath} />
                  </svg>
                </div>
              ) : (
                <div className="history-modal-empty">
                  {hasVisibleSeries ? "Values are not available for charting." : "Select a series to display."}
                </div>
              )}
              <div className="history-modal-legend">
                <button
                  type="button"
                  className={`history-legend-item${visibleSeries.actual ? " active" : ""}`}
                  onClick={() => toggleSeries("actual")}
                  aria-pressed={visibleSeries.actual}
                >
                  <span className="history-legend-swatch history-line-actual" />
                  Actual
                </button>
                <button
                  type="button"
                  className={`history-legend-item${visibleSeries.forecast ? " active" : ""}`}
                  onClick={() => toggleSeries("forecast")}
                  aria-pressed={visibleSeries.forecast}
                >
                  <span className="history-legend-swatch history-line-forecast" />
                  Forecast
                </button>
                <button
                  type="button"
                  className={`history-legend-item${visibleSeries.previous ? " active" : ""}`}
                  onClick={() => toggleSeries("previous")}
                  aria-pressed={visibleSeries.previous}
                >
                  <span className="history-legend-swatch history-line-previous" />
                  Previous
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
