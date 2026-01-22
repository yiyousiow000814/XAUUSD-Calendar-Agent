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

const NUMERIC_RANGE_KEYS = [5, 10, 20, 50, 100] as const;
type NumericRangeKey = (typeof NUMERIC_RANGE_KEYS)[number];
type RangeKey = NumericRangeKey | "all";

const RANGE_STORAGE_KEY = "xauusd:event-history:range";
const SERIES_STORAGE_KEY = "xauusd:event-history:series";

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
    .replaceAll("−", "-") // normalize unicode minus to ASCII
    .replace(/[\s\u00A0]+/g, "")
    .replaceAll(",", "")
    .replaceAll("%", "");
  // Some calendar sources append notes like "(rev.)" or "*"; accept the first numeric token.
  const match = cleaned.match(/([+-]?\d+(?:\.\d+)?)([kmb])?/i);
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
  const [range, setRange] = useState<RangeKey>(() => {
    if (typeof window === "undefined") return 10;
    try {
      const raw = window.localStorage.getItem(RANGE_STORAGE_KEY);
      if (raw === "all") return "all";
      const parsed = Number(raw);
      if (NUMERIC_RANGE_KEYS.includes(parsed as NumericRangeKey)) {
        return parsed as NumericRangeKey;
      }
    } catch {
      // Ignore storage errors.
    }
    return 10;
  });
  const [phase, setPhase] = useState<"entering" | "open" | "closing">("entering");
  const closeTimerRef = useRef<number | null>(null);
  const [contentEnterToken, setContentEnterToken] = useState(0);
  const actualPathRef = useRef<SVGPathElement | null>(null);
  const forecastPathRef = useRef<SVGPathElement | null>(null);
  const pointsGroupRef = useRef<SVGGElement | null>(null);
  const animationTimerRef = useRef<number | null>(null);
  const chartAnimatedTokenRef = useRef(0);
  const wasLoadingRef = useRef(false);
  const tableRef = useRef<HTMLDivElement | null>(null);
  const [fitRowCount, setFitRowCount] = useState(0);
  const [visibleSeries, setVisibleSeries] = useState(() => {
    if (typeof window === "undefined") return { actual: true, forecast: true };
    try {
      const raw = window.localStorage.getItem(SERIES_STORAGE_KEY);
      if (!raw) return { actual: true, forecast: true };
      const parsed = JSON.parse(raw);
      const actual = Boolean(parsed?.actual);
      const forecast = Boolean(parsed?.forecast);
      if (!actual && !forecast) return { actual: true, forecast: true };
      return { actual, forecast };
    } catch {
      return { actual: true, forecast: true };
    }
  });
  const points = data?.points ?? [];
  const pointIdByIdentity = useMemo(() => {
    const map = new Map<EventHistoryPoint, number>();
    points.forEach((point, index) => map.set(point, index));
    return map;
  }, [points]);
  const hasData = points.length > 0;
  const hasMetricValues = useMemo(
    () =>
      points.some(
        (point) =>
          !isMissingValue(point.actual) ||
          !isMissingValue(point.forecast) ||
          !isMissingValue(point.previous)
      ),
    [points]
  );
  const rangeOptions = useMemo(() => {
    const total = points.length;
    const options: Array<{ key: RangeKey; label: string }> = [];
    for (const key of NUMERIC_RANGE_KEYS) {
      if (total >= key) {
        options.push({ key, label: `Last ${key}` });
      }
    }
    const maxNumeric =
      options.length > 0 ? Math.max(...options.map((item) => Number(item.key))) : 0;
    if (total > maxNumeric) {
      options.push({ key: "all", label: "All" });
    }
    // If there's only one valid option, hide the entire range control.
    return options.length > 1 ? options : [];
  }, [points.length]);
  const hasVisibleSeries = visibleSeries.actual || visibleSeries.forecast;
  const displayPoints = useMemo(() => {
    if (range === "all") return points;
    return points.slice(-range);
  }, [points, range]);
  const listPoints = useMemo(() => [...displayPoints].reverse(), [displayPoints]);
  const tablePoints = useMemo(() => {
    if (range === "all") return listPoints;
    if (range > 10) return listPoints;
    const fallback = listPoints.length ? 1 : 0;
    const limit = fitRowCount > 0 ? fitRowCount : fallback;
    return listPoints.slice(0, limit);
  }, [fitRowCount, listPoints, range]);

  useEffect(() => {
    if (!isOpen) return;
    setFitRowCount(0);
    chartAnimatedTokenRef.current = 0;
  }, [isOpen, selectionLabel]);

  useEffect(() => {
    if (!isOpen) return;
    try {
      window.localStorage.setItem(RANGE_STORAGE_KEY, String(range));
    } catch {
      // Ignore storage errors.
    }
  }, [isOpen, range]);

  useEffect(() => {
    if (!isOpen) return;
    try {
      window.localStorage.setItem(SERIES_STORAGE_KEY, JSON.stringify(visibleSeries));
    } catch {
      // Ignore storage errors.
    }
  }, [isOpen, visibleSeries]);

  useEffect(() => {
    if (!isOpen) return;
    if (range === "all") return;
    if (range > points.length && points.length) {
      setRange("all");
    }
  }, [isOpen, points.length, range]);

  useLayoutEffect(() => {
    if (!isOpen) return;
    if (range === "all") return;
    if (range > 10) return;
    const node = tableRef.current;
    if (!node) return;

    let rafId = 0;
    const measure = () => {
      const containerHeight = node.getBoundingClientRect().height;
      if (!containerHeight) return;
      const header = node.querySelector<HTMLElement>(".history-modal-header");
      const row = node.querySelector<HTMLElement>(".history-modal-row:not(.history-modal-header)");
      const headerHeight = header?.getBoundingClientRect().height ?? 0;
      const rowHeight = row?.getBoundingClientRect().height ?? 0;
      if (!rowHeight) return;
      const available = Math.max(0, containerHeight - headerHeight);
      const next = Math.max(1, Math.floor(available / rowHeight));
      setFitRowCount((prev) => (prev === next ? prev : next));
    };
    const scheduleMeasure = () => {
      if (rafId) window.cancelAnimationFrame(rafId);
      rafId = window.requestAnimationFrame(() => {
        rafId = 0;
        measure();
      });
    };

    // First layout pass: measure immediately to avoid flicker on range changes.
    measure();

    let observer: ResizeObserver | null = null;
    if ("ResizeObserver" in window) {
      observer = new ResizeObserver(scheduleMeasure);
      observer.observe(node);
    } else {
      window.addEventListener("resize", scheduleMeasure);
    }

    return () => {
      if (observer) observer.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
      if (rafId) window.cancelAnimationFrame(rafId);
    };
  }, [hasMetricValues, isOpen, range, contentEnterToken, selectionLabel]);

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
    // Add a small headroom/footroom so points do not stick to the plot bounds.
    const rawSpan = max - min;
    const anchor = rawSpan !== 0 ? rawSpan : Math.abs(max) || 1;
    const domainPad = anchor * 0.08;
    const domainMin = min - domainPad;
    const domainMax = max + domainPad;
    const span = domainMax - domainMin || 1;
    const step = displayPoints.length > 1 ? innerWidth / (displayPoints.length - 1) : 0;
    const xForIndex = (index: number) =>
      displayPoints.length > 1 ? padding.left + index * step : padding.left + innerWidth / 2;
    const yForValue = (value: number) =>
      padding.top + ((domainMax - value) / span) * innerHeight;
    const yTickCount = 5;
    const yTicks = Array.from({ length: yTickCount }, (_, idx) => {
      const ratio = yTickCount === 1 ? 0 : idx / (yTickCount - 1);
      const value = domainMax - ratio * span;
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
    const renderPoints = range !== "all";
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
      points: renderPoints
        ? [
            ...(visibleSeries.actual ? buildPoints("actual", actualValues) : []),
            ...(visibleSeries.forecast ? buildPoints("forecast", forecastValues) : [])
          ]
        : []
    };
  }, [displayPoints, hasData, hasVisibleSeries, range, visibleSeries]);

  useLayoutEffect(() => {
    if (loading) return;
    if (!chart) return;
    if (contentEnterToken === 0) return;
    if (chartAnimatedTokenRef.current === contentEnterToken) return;
    chartAnimatedTokenRef.current = contentEnterToken;

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
                  {rangeOptions.length ? (
                    <div className="history-modal-control">
                      <span className="history-modal-label">Range</span>
                      <div className="history-modal-toggle">
                        {rangeOptions.map((option) => (
                          <button
                            key={String(option.key)}
                            type="button"
                            className={`history-toggle${range === option.key ? " active" : ""}`}
                            onClick={() => setRange(option.key)}
                            aria-pressed={range === option.key}
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {hasMetricValues ? (
                    <div
                      className="history-modal-series"
                      aria-label="Series toggles"
                      role="group"
                    >
                      <button
                        type="button"
                        className={`history-legend-item history-legend-item-actual${
                          visibleSeries.actual ? " active" : ""
                        }`}
                        onClick={() => toggleSeries("actual")}
                        aria-pressed={visibleSeries.actual}
                      >
                        <span className="history-legend-swatch history-line-actual" />
                        Actual
                      </button>
                      <button
                        type="button"
                        className={`history-legend-item history-legend-item-forecast${
                          visibleSeries.forecast ? " active" : ""
                        }`}
                        onClick={() => toggleSeries("forecast")}
                        aria-pressed={visibleSeries.forecast}
                      >
                        <span className="history-legend-swatch history-line-forecast" />
                        Forecast
                      </button>
                    </div>
                  ) : null}
                </div>
                <div className="history-modal-layout">
                  <div className="history-modal-layout-left">
                    {hasMetricValues ? (
                      chart ? (
                        <div className="history-modal-chart">
                          <svg
                            viewBox={`0 0 ${chart.width} ${chart.height}`}
                            shapeRendering="geometricPrecision"
                            textRendering="geometricPrecision"
                            role="img"
                            aria-label="Event history chart"
                          >
                            <g className="history-chart-grid">
                              {chart.yTicks.map((tick) => (
                                <line
                                  key={`y-${tick.value}`}
                                  x1={chart.padding.left}
                                  x2={chart.width - chart.padding.right}
                                  y1={Math.round(tick.y) + 0.5}
                                  y2={Math.round(tick.y) + 0.5}
                                  vectorEffect="non-scaling-stroke"
                                />
                              ))}
                              {chart.xTicks.map((tick) => (
                                <line
                                  key={`x-${tick.index}`}
                                  x1={Math.round(tick.x) + 0.5}
                                  x2={Math.round(tick.x) + 0.5}
                                  y1={chart.padding.top}
                                  y2={chart.height - chart.padding.bottom}
                                  vectorEffect="non-scaling-stroke"
                                />
                              ))}
                            </g>
                            <g className="history-chart-axis">
                              <line
                                x1={chart.padding.left + 0.5}
                                x2={chart.padding.left + 0.5}
                                y1={chart.padding.top}
                                y2={chart.height - chart.padding.bottom}
                                vectorEffect="non-scaling-stroke"
                              />
                              <line
                                x1={chart.padding.left}
                                x2={chart.width - chart.padding.right}
                                y1={chart.height - chart.padding.bottom + 0.5}
                                y2={chart.height - chart.padding.bottom + 0.5}
                                vectorEffect="non-scaling-stroke"
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
                      )
                    ) : null}
                    <div className="history-modal-placeholder" data-qa="qa:history:placeholder">
                      <div className="history-placeholder-title">
                        {hasMetricValues ? "Event notes" : "Event description"}
                      </div>
                      <div className="history-placeholder-body">
                        {hasMetricValues
                          ? "Placeholder for future notes: release context, anomalies, and quick summaries."
                          : "Placeholder for future description: key remarks, themes, and context."}
                      </div>
                      <div className="history-placeholder-lines" aria-hidden="true">
                        <span />
                        <span />
                        <span />
                      </div>
                    </div>
                  </div>
                  <div className="history-modal-layout-right">
                    <div
                      className={`history-modal-table${
                        range === "all" || range > 10 ? " scrollable" : ""
                      }${
                        hasMetricValues ? "" : " schedule"
                      }`}
                      data-qa="qa:history:table"
                      ref={tableRef}
                    >
                      <div className="history-modal-row history-modal-header">
                        <span>Date</span>
                        <span>Time</span>
                        {hasMetricValues ? (
                          <>
                            <span>Actual</span>
                            <span>Forecast</span>
                            <span>Previous</span>
                          </>
                        ) : (
                          <span>Details</span>
                        )}
                      </div>
                      {tablePoints.map((point, index) => (
                        <div
                          className="history-modal-row history-modal-row-animate"
                          key={`${pointIdByIdentity.get(point) ?? `${point.date}-${point.time}`}-${
                            contentEnterToken
                          }`}
                          style={{ animationDelay: `${Math.min(index * 28, 220)}ms` }}
                        >
                          <span>{formatDisplayDate(point.date)}</span>
                          <span>{point.time || "--"}</span>
                          {hasMetricValues ? (
                            <>
                              <span>{formatDisplayValue(point.actual)}</span>
                              <span>{formatDisplayValue(point.forecast)}</span>
                              <span>{formatDisplayValue(point.previous)}</span>
                            </>
                          ) : (
                            <span className="disabled">--</span>
                          )}
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
