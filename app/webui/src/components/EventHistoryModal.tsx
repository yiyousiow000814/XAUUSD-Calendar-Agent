import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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

const CLOSE_ANIMATION_MS = 320;

const RANGE_OPTIONS = [
  { key: 10, label: "Last 10" },
  { key: 20, label: "Last 20" },
  { key: 50, label: "Last 50" },
  { key: 100, label: "Last 100" },
  { key: "all", label: "All" }
] as const;

type RangeKey = (typeof RANGE_OPTIONS)[number]["key"];

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

const formatDisplayValue = (value: string | null | undefined) =>
  isMissingValue(value) ? "--" : String(value ?? "");

const extractSeries = (points: EventHistoryPoint[], key: keyof EventHistoryPoint) =>
  points.map((item) => parseComparableNumber(String(item[key] ?? "")));

const formatTickNumber = (value: number) => {
  const abs = Math.abs(value);
  const format = (num: number) => {
    const text = num.toFixed(abs < 1 ? 2 : abs < 10 ? 2 : abs < 100 ? 1 : 0);
    return text.replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
  };
  if (abs >= 1_000_000_000) return `${format(value / 1_000_000_000)}B`;
  if (abs >= 1_000_000) return `${format(value / 1_000_000)}M`;
  if (abs >= 1_000) return `${format(value / 1_000)}K`;
  return format(value);
};

const detectUnitLabel = (points: EventHistoryPoint[], keys: Array<keyof EventHistoryPoint>) => {
  for (const point of points) {
    for (const key of keys) {
      const raw = String(point[key] ?? "").trim();
      if (isMissingValue(raw)) continue;
      if (raw.includes("%")) return "%";
      const suffix = raw.match(/[kmb]$/i)?.[0];
      if (suffix) return suffix.toUpperCase();
    }
  }
  return "";
};

const buildPath = (
  values: Array<number | null>,
  xForIndex: (index: number) => number,
  yForValue: (value: number) => number
) => {
  if (values.length <= 1) return "";
  let path = "";
  let started = false;
  values.forEach((value, index) => {
    if (value === null) {
      started = false;
      return;
    }
    const x = xForIndex(index);
    const y = yForValue(value);
    if (!started) {
      path += `M ${x.toFixed(2)} ${y.toFixed(2)}`;
      started = true;
    } else {
      path += ` L ${x.toFixed(2)} ${y.toFixed(2)}`;
    }
  });
  return path;
};

export function EventHistoryModal({
  isOpen,
  loading,
  error,
  selectionLabel,
  data,
  onClose
}: EventHistoryModalProps) {
  const [range, setRange] = useState<RangeKey>(10);
  const [phase, setPhase] = useState<"entering" | "open" | "closing">("entering");
  const closeTimerRef = useRef<number | null>(null);
  const [contentEnterToken, setContentEnterToken] = useState(0);
  const actualPathRef = useRef<SVGPathElement | null>(null);
  const forecastPathRef = useRef<SVGPathElement | null>(null);
  const pointsGroupRef = useRef<SVGGElement | null>(null);
  const animationTimerRef = useRef<number | null>(null);
  const wasLoadingRef = useRef(false);
  const [visibleSeries, setVisibleSeries] = useState({
    actual: true,
    forecast: true
  });
  const points = data?.points ?? [];
  const hasData = points.length > 0;
  const hasVisibleSeries = visibleSeries.actual || visibleSeries.forecast;
  const displayPoints = useMemo(() => {
    if (range === "all") return points;
    return points.slice(-range);
  }, [points, range]);
  const listPoints = useMemo(() => [...displayPoints].reverse(), [displayPoints]);

  useEffect(() => {
    if (!isOpen) return;
    setRange(10);
    setVisibleSeries({ actual: true, forecast: true });
  }, [isOpen, selectionLabel]);

  useEffect(() => {
    if (!isOpen) return;
    setPhase("entering");
    const raf = window.requestAnimationFrame(() => setPhase("open"));
    return () => window.cancelAnimationFrame(raf);
  }, [isOpen]);

  useEffect(() => {
    if (loading) {
      wasLoadingRef.current = true;
      return;
    }
    if (!wasLoadingRef.current) return;
    wasLoadingRef.current = false;
    setContentEnterToken((prev) => prev + 1);
  }, [loading, selectionLabel]);

  const requestClose = () => {
    if (phase === "closing") return;
    setPhase("closing");
    if (closeTimerRef.current) {
      window.clearTimeout(closeTimerRef.current);
    }
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      onClose();
    }, CLOSE_ANIMATION_MS);
  };

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) {
        window.clearTimeout(closeTimerRef.current);
      }
      if (animationTimerRef.current) {
        window.clearTimeout(animationTimerRef.current);
      }
    };
  }, []);

  const chart = useMemo(() => {
    if (!hasData) {
      return null;
    }
    if (!hasVisibleSeries) {
      return null;
    }
    const actualValues = visibleSeries.actual ? extractSeries(displayPoints, "actual") : [];
    const forecastValues = visibleSeries.forecast ? extractSeries(displayPoints, "forecast") : [];
    const numericValues = [...actualValues, ...forecastValues].filter(
      (value): value is number => value !== null
    );
    if (!numericValues.length) {
      return null;
    }
    const min = Math.min(...numericValues);
    const max = Math.max(...numericValues);
    const width = 900;
    const height = 560;
    const padding = { top: 36, right: 32, bottom: 90, left: 84 };
    const innerWidth = Math.max(1, width - padding.left - padding.right);
    const innerHeight = Math.max(1, height - padding.top - padding.bottom);
    const span = max - min || 1;
    const step = displayPoints.length > 1 ? innerWidth / (displayPoints.length - 1) : 0;
    const xForIndex = (index: number) =>
      displayPoints.length > 1 ? padding.left + index * step : padding.left + innerWidth / 2;
    const yForValue = (value: number) =>
      padding.top + ((max - value) / span) * innerHeight;
    const yTickCount = 5;
    const yTicks = Array.from({ length: yTickCount }, (_, idx) => {
      const ratio = yTickCount === 1 ? 0 : idx / (yTickCount - 1);
      const value = max - ratio * span;
      return { value, y: yForValue(value), label: formatTickNumber(value) };
    });
    const xTickIndices = Array.from(
      new Set([0, Math.floor((displayPoints.length - 1) / 2), displayPoints.length - 1])
    ).filter((idx) => idx >= 0 && idx < displayPoints.length);
    const xTicks = xTickIndices.map((index) => ({
      index,
      x: xForIndex(index),
      label: formatDisplayDate(displayPoints[index]?.date || "")
    }));
    const unitLabel = detectUnitLabel(
      displayPoints,
      [
        ...(visibleSeries.actual ? (["actual"] as const) : []),
        ...(visibleSeries.forecast ? (["forecast"] as const) : [])
      ]
    );
    const buildPoints = (series: "actual" | "forecast", values: Array<number | null>) =>
      values
        .map((value, index) => {
          if (value === null) return null;
          const point = displayPoints[index];
          const raw =
            series === "actual"
              ? point?.actual
              : point?.forecast;
          const labelParts = [
            formatDisplayDate(point?.date || ""),
            point?.time || "--",
            series === "actual" ? "Actual" : "Forecast",
            formatDisplayValue(raw)
          ];
          return {
            key: `${series}-${point?.date ?? ""}-${point?.time ?? ""}-${index}`,
            series,
            x: xForIndex(index),
            y: yForValue(value),
            label: labelParts.filter(Boolean).join(" · ")
          };
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item));
    return {
      width,
      height,
      padding,
      plotWidth: innerWidth,
      plotHeight: innerHeight,
      yTicks,
      xTicks,
      unitLabel,
      xAxisLabel: "Date",
      yAxisLabel: "Value",
      actualPath: visibleSeries.actual ? buildPath(actualValues, xForIndex, yForValue) : "",
      forecastPath: visibleSeries.forecast ? buildPath(forecastValues, xForIndex, yForValue) : "",
      points: [
        ...(visibleSeries.actual ? buildPoints("actual", actualValues) : []),
        ...(visibleSeries.forecast ? buildPoints("forecast", forecastValues) : [])
      ]
    };
  }, [displayPoints, hasData, hasVisibleSeries, visibleSeries]);

  useLayoutEffect(() => {
    if (loading) return;
    if (!chart) return;
    if (contentEnterToken === 0) return;

    const paths = [actualPathRef.current, forecastPathRef.current].filter(
      (node): node is SVGPathElement => Boolean(node)
    );

    // Reset point visibility so the fade-in runs reliably.
    if (pointsGroupRef.current) {
      pointsGroupRef.current.style.opacity = "0";
    }

    paths.forEach((path) => {
      try {
        const length = path.getTotalLength();
        path.style.transition = "none";
        path.style.strokeDasharray = `${length}`;
        path.style.strokeDashoffset = `${length}`;
        // Force reflow so the next transition starts from dashoffset=length.
        path.getBoundingClientRect();
        path.style.transition = "stroke-dashoffset 720ms var(--motion-ease)";
        path.style.strokeDashoffset = "0";
      } catch {
        // Ignore path animation failures (older SVG engines / zero-length paths).
      }
    });

    if (animationTimerRef.current) {
      window.clearTimeout(animationTimerRef.current);
      animationTimerRef.current = null;
    }
    animationTimerRef.current = window.setTimeout(() => {
      animationTimerRef.current = null;
      if (pointsGroupRef.current) {
        pointsGroupRef.current.style.opacity = "1";
      }
    }, 260);
  }, [chart, contentEnterToken, loading]);

  const toggleSeries = (key: "actual" | "forecast") => {
    setVisibleSeries((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      if (!next.actual && !next.forecast) {
        return prev;
      }
      return next;
    });
  };

  if (!isOpen) return null;

  return (
    <div
      className={`modal-backdrop modal-backdrop-history${phase === "open" ? " open" : ""}${
        phase === "closing" ? " closing" : ""
      }`}
      role="presentation"
      onClick={requestClose}
    >
      <div
        className={`modal modal-history${phase === "open" ? " open" : ""}${phase === "closing" ? " closing" : ""}`}
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
          <button
            type="button"
            className="btn ghost"
            onClick={requestClose}
            data-qa="qa:modal-close:history"
          >
            Close
          </button>
        </div>
        <div className="modal-body">
          {loading ? (
              <div className="history-modal-loading" data-qa="qa:history:loading">
                <div className="history-loading-head">
                  <span className="history-loading-spinner" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </span>
                  <span className="history-loading-text">
                    Loading history<span className="history-loading-dots" aria-hidden="true" />
                  </span>
                </div>
              <div className="history-loading-layout" aria-hidden="true">
                <div className="history-loading-card history-loading-chart" />
                <div className="history-loading-card history-loading-table" />
              </div>
            </div>
          ) : null}
          {!loading && error ? <div className="history-modal-error">{error}</div> : null}
          {!loading && !error && !hasData ? (
            <div className="history-modal-empty">No history available yet.</div>
          ) : null}
          {!loading && !error && hasData ? (
            <div className="history-modal-content">
              <div className="history-modal-controls">
                <div className="history-modal-control">
                  <span className="history-modal-label">Range</span>
                  <div className="history-modal-toggle">
                    {RANGE_OPTIONS.map((option) => (
                      <button
                        key={String(option.key)}
                        type="button"
                        className={`history-toggle${range === option.key ? " active" : ""}`}
                        onClick={() => setRange(option.key)}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
                  <div className="history-modal-series" aria-label="Series toggles" role="group">
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
                  </div>
                </div>
              <div className="history-modal-layout">
                <div className="history-modal-layout-left">
                  {chart ? (
                    <div className="history-modal-chart">
                      <svg
                        viewBox={`0 0 ${chart.width} ${chart.height}`}
                        role="img"
                        aria-label="Event history chart"
                      >
                        <g className="history-chart-grid">
                          {chart.yTicks.map((tick) => (
                            <line
                              key={`y-${tick.value}`}
                              x1={chart.padding.left}
                              x2={chart.width - chart.padding.right}
                              y1={tick.y}
                              y2={tick.y}
                            />
                          ))}
                          {chart.xTicks.map((tick) => (
                            <line
                              key={`x-${tick.index}`}
                              x1={tick.x}
                              x2={tick.x}
                              y1={chart.padding.top}
                              y2={chart.height - chart.padding.bottom}
                            />
                          ))}
                        </g>
                        <g className="history-chart-axis">
                          <line
                            x1={chart.padding.left}
                            x2={chart.padding.left}
                            y1={chart.padding.top}
                            y2={chart.height - chart.padding.bottom}
                          />
                          <line
                            x1={chart.padding.left}
                            x2={chart.width - chart.padding.right}
                            y1={chart.height - chart.padding.bottom}
                            y2={chart.height - chart.padding.bottom}
                          />
                        </g>
                        <g className="history-chart-labels">
                          {chart.yTicks.map((tick) => (
                            <text
                              key={`y-label-${tick.value}`}
                              x={chart.padding.left - 8}
                              y={tick.y + 4}
                              textAnchor="end"
                            >
                              {tick.label}
                            </text>
                          ))}
                          {chart.xTicks.map((tick) => (
                            <text
                              key={`x-label-${tick.index}`}
                              x={tick.x}
                              y={chart.height - chart.padding.bottom + 22}
                              textAnchor="middle"
                            >
                              {tick.label}
                            </text>
                          ))}
                          <text
                            x={chart.padding.left + chart.plotWidth / 2}
                            y={chart.height - 12}
                            textAnchor="middle"
                            className="history-chart-axis-label"
                          >
                            {chart.xAxisLabel}
                          </text>
                          <text
                            x={16}
                            y={chart.padding.top + chart.plotHeight / 2}
                            textAnchor="middle"
                            className="history-chart-axis-label"
                            transform={`rotate(-90 16 ${chart.padding.top + chart.plotHeight / 2})`}
                          >
                            {chart.yAxisLabel}
                          </text>
                          {chart.unitLabel ? (
                            <text
                              x={chart.padding.left}
                              y={chart.padding.top - 8}
                              className="history-chart-unit"
                            >
                              Unit {chart.unitLabel}
                            </text>
                          ) : null}
                        </g>
                        {visibleSeries.forecast ? (
                          <path
                            ref={forecastPathRef}
                            className="history-line history-line-forecast"
                            d={chart.forecastPath}
                          />
                        ) : null}
                        {visibleSeries.actual ? (
                          <path
                            ref={actualPathRef}
                            className="history-line history-line-actual"
                            d={chart.actualPath}
                          />
                        ) : null}
                        <g className="history-chart-points" ref={pointsGroupRef}>
                          {chart.points.map((point) => (
                            <circle
                              key={point.key}
                              className={`history-point history-point-${point.series}`}
                              cx={point.x}
                              cy={point.y}
                              r={3.8}
                            >
                              <title>{point.label}</title>
                            </circle>
                          ))}
                        </g>
                      </svg>
                    </div>
                  ) : (
                    <div className="history-modal-empty">
                      {hasVisibleSeries
                        ? "Values are not available for charting."
                        : "Select a series to display."}
                    </div>
                  )}
                  <div className="history-modal-placeholder" data-qa="qa:history:placeholder">
                    <div className="history-placeholder-title">Event notes</div>
                    <div className="history-placeholder-body">
                      Placeholder for future notes: release context, anomalies, and quick summaries.
                    </div>
                    <div className="history-placeholder-lines" aria-hidden="true">
                      <span />
                      <span />
                      <span />
                    </div>
                  </div>
                </div>
                <div className="history-modal-layout-right">
                  <div className="history-modal-table" data-qa="qa:history:table">
                    <div className="history-modal-row history-modal-header">
                      <span>Date</span>
                      <span>Time</span>
                      <span>Actual</span>
                      <span>Forecast</span>
                      <span>Previous</span>
                    </div>
                    {listPoints.map((point, index) => (
                      <div
                        className="history-modal-row history-modal-row-animate"
                        key={`${point.date}-${point.time}-${index}-${contentEnterToken}`}
                        style={{ animationDelay: `${Math.min(index * 28, 220)}ms` }}
                      >
                        <span>{formatDisplayDate(point.date)}</span>
                        <span>{point.time || "--"}</span>
                        <span>{formatDisplayValue(point.actual)}</span>
                        <span>{formatDisplayValue(point.forecast)}</span>
                        <span>{formatDisplayValue(point.previous)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
