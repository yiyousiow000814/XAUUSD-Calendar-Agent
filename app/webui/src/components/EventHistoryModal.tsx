import { useMemo } from "react";
import type { EventHistoryPoint, EventHistoryResponse } from "../types";
import "./EventHistoryModal.css";

type EventHistoryModalProps = {
  isOpen: boolean;
  loading: boolean;
  error: string | null;
  selectionLabel: string;
  data: EventHistoryResponse | null;
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
  onClose
}: EventHistoryModalProps) {
  const points = data?.points ?? [];
  const hasData = points.length > 0;
  const rangeLabel = getRangeLabel(points);

  const chart = useMemo(() => {
    if (!hasData) {
      return null;
    }
    const actualValues = extractSeries(points, "actual");
    const forecastValues = extractSeries(points, "forecast");
    const previousValues = extractSeries(points, "previous");
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
      actualPath: buildPath(actualValues, width, height, min, max),
      forecastPath: buildPath(forecastValues, width, height, min, max),
      previousPath: buildPath(previousValues, width, height, min, max)
    };
  }, [hasData, points]);

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
              <div className="history-modal-meta">
                <span className="history-modal-pill">{points.length} releases</span>
                {rangeLabel ? <span className="history-modal-pill">{rangeLabel}</span> : null}
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
                <div className="history-modal-empty">Values are not available for charting.</div>
              )}
              <div className="history-modal-legend">
                <span className="history-legend-item">
                  <span className="history-legend-swatch history-line-actual" />
                  Actual
                </span>
                <span className="history-legend-item">
                  <span className="history-legend-swatch history-line-forecast" />
                  Forecast
                </span>
                <span className="history-legend-item">
                  <span className="history-legend-swatch history-line-previous" />
                  Previous
                </span>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
