import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { EventHistoryPoint, EventHistoryResponse } from "../types";
import { buildEventNotes } from "../utils/eventNotes";
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
const CHART_LINE_ANIMATION_MS = 1100;
const ROW_EXIT_ANIMATION_MS = 220;
const HEADER_SHADOW_TRIGGER_PX = 6;

const NUMERIC_RANGE_KEYS = [5, 10, 20, 50, 100] as const;
type NumericRangeKey = (typeof NUMERIC_RANGE_KEYS)[number];
type RangeKey = NumericRangeKey | "all";

const RANGE_STORAGE_KEY = "xauusd:event-history:range";
const SERIES_STORAGE_KEY = "xauusd:event-history:series";

const resolveRange = (preferred: RangeKey, total: number): RangeKey => {
  if (preferred === "all") return "all";
  if (!total || total >= preferred) return preferred;
  const fallback = NUMERIC_RANGE_KEYS.filter((key) => key <= preferred && key <= total).pop();
  return fallback ?? preferred;
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

const valuesMatch = (left: string | null | undefined, right: string | null | undefined) => {
  if (isMissingValue(left) && isMissingValue(right)) return true;
  if (isMissingValue(left) || isMissingValue(right)) return false;
  const leftNum = parseComparableNumber(String(left));
  const rightNum = parseComparableNumber(String(right));
  if (leftNum !== null && rightNum !== null) return Math.abs(leftNum - rightNum) <= 1e-9;
  return String(left).trim() === String(right).trim();
};

const formatDisplayDate = (value: string) => {
  const [year, month, day] = value.split("-");
  if (!year || !month || !day) return value;
  return `${day}-${month}-${year}`;
};

const formatDisplayPeriod = (value: string | null | undefined) => {
  const token = (value ?? "").trim();
  if (!token) return "";
  if (/^(q[1-4]|h[1-2])$/i.test(token)) return token.toUpperCase();
  if (token.length === 3) return `${token[0].toUpperCase()}${token.slice(1).toLowerCase()}`;
  return `${token[0].toUpperCase()}${token.slice(1)}`;
};

const formatDisplayValue = (value: string | null | undefined) =>
  isMissingValue(value) ? "--" : String(value ?? "").trim();

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
  yForValue: (value: number) => number,
  { connectNulls = false }: { connectNulls?: boolean } = {}
) => {
  if (values.length <= 1) return "";
  let path = "";
  let started = false;
  values.forEach((value, index) => {
    if (value === null) {
      if (!connectNulls) {
        started = false;
      }
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
  const [preferredRange, setPreferredRange] = useState<RangeKey>(() => {
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
  const chartContainerRef = useRef<HTMLDivElement | null>(null);
  const actualStrokeCleanupTimerRef = useRef<number | null>(null);
  const forecastStrokeCleanupTimerRef = useRef<number | null>(null);
  const lineAnimationStateRef = useRef<
    | {
        activeRange: RangeKey;
        pointCount: number;
        contentToken: number;
        actualVisible: boolean;
        forecastVisible: boolean;
      }
    | null
  >(null);
  const wasLoadingRef = useRef(false);
  const tableRef = useRef<HTMLDivElement | null>(null);
  const [fitRowCount, setFitRowCount] = useState(0);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [showHeaderShadow, setShowHeaderShadow] = useState(false);
  const [preferredSeries, setPreferredSeries] = useState(() => {
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
  const eventNotes = useMemo(
    () => buildEventNotes(selectionLabel, data),
    [selectionLabel, data]
  );
  const hasNotes = eventNotes.note.trim().length > 0;
  const pointIdByIdentity = useMemo(() => {
    const map = new Map<EventHistoryPoint, number>();
    points.forEach((point, index) => map.set(point, index));
    return map;
  }, [points]);
  const hasData = points.length > 0;
  const hasForecastValues = useMemo(
    () => points.some((point) => !isMissingValue(point.forecast)),
    [points]
  );
  const visibleSeries = useMemo(() => {
    const next = {
      actual: Boolean(preferredSeries.actual),
      forecast: Boolean(preferredSeries.forecast) && hasForecastValues
    };
    if (!next.actual && !next.forecast) {
      return { actual: true, forecast: hasForecastValues };
    }
    return next;
  }, [hasForecastValues, preferredSeries]);
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
  const activeRange = useMemo(
    () => resolveRange(preferredRange, points.length),
    [points.length, preferredRange]
  );

  const headerShadowFrame = useRef<number | null>(null);
  const updateHeaderShadow = useCallback(() => {
    const node = tableRef.current;
    if (!node) {
      setShowHeaderShadow(false);
      return;
    }
    const header = node.querySelector<HTMLElement>(".history-modal-header");
    const row = node.querySelector<HTMLElement>(
      ".history-modal-row:not(.history-modal-header)"
    );
    if (!header || !row) {
      setShowHeaderShadow(false);
      return;
    }
    const headerRect = header.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    setShowHeaderShadow(rowRect.top < headerRect.bottom - HEADER_SHADOW_TRIGGER_PX);
  }, []);
  const displayPoints = useMemo(() => {
    if (activeRange === "all") return points;
    return points.slice(-activeRange);
  }, [activeRange, points]);
  const listPoints = useMemo(() => [...displayPoints].reverse(), [displayPoints]);
  const tablePoints = useMemo(() => {
    if (activeRange === "all") return listPoints;
    if (activeRange > 10) return listPoints;
    const fallback = listPoints.length ? 1 : 0;
    const limit = fitRowCount > 0 ? fitRowCount : fallback;
    return listPoints.slice(0, limit);
  }, [activeRange, fitRowCount, listPoints]);

  type TableRowEntry = {
    key: string;
    point: EventHistoryPoint;
    exiting: boolean;
  };

  const pointKeyPrefix = data?.eventId ?? selectionLabel;
  const buildPointKey = useCallback(
    (point: EventHistoryPoint) =>
      `${pointKeyPrefix}:${point.date}:${point.time}:${point.period ?? ""}`,
    [pointKeyPrefix]
  );

  const [tableRows, setTableRows] = useState<TableRowEntry[]>(() =>
    tablePoints.map((point) => ({ key: buildPointKey(point), point, exiting: false }))
  );
  const tableExitTimerRef = useRef<number | null>(null);
  const lastPointKeyPrefixRef = useRef(pointKeyPrefix);

  useEffect(() => {
    if (!isOpen) return;
    setFitRowCount(0);
    lineAnimationStateRef.current = null;
    setHoverIndex(null);
    setShowHeaderShadow(false);
  }, [isOpen, selectionLabel]);

  useEffect(() => {
    if (!isOpen) return;
    try {
      window.localStorage.setItem(RANGE_STORAGE_KEY, String(preferredRange));
    } catch {
      // Ignore storage errors.
    }
  }, [isOpen, preferredRange]);

  useEffect(() => {
    if (!isOpen) return;
    try {
      window.localStorage.setItem(SERIES_STORAGE_KEY, JSON.stringify(preferredSeries));
    } catch {
      // Ignore storage errors.
    }
  }, [isOpen, preferredSeries]);

  useEffect(() => {
    if (!isOpen) return;
    updateHeaderShadow();
  }, [isOpen, tableRows, updateHeaderShadow]);

  useLayoutEffect(() => {
    if (!isOpen) return;
    if (activeRange === "all") return;
    if (activeRange > 10) return;
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
  }, [activeRange, contentEnterToken, hasMetricValues, isOpen, selectionLabel]);

  useEffect(() => {
    if (!isOpen) return;
    if (lastPointKeyPrefixRef.current === pointKeyPrefix) return;
    lastPointKeyPrefixRef.current = pointKeyPrefix;
    if (tableExitTimerRef.current) {
      window.clearTimeout(tableExitTimerRef.current);
      tableExitTimerRef.current = null;
    }
    setTableRows(tablePoints.map((point) => ({ key: buildPointKey(point), point, exiting: false })));
  }, [buildPointKey, isOpen, pointKeyPrefix, tablePoints]);

  useEffect(() => {
    if (!isOpen) return;
    setTableRows((prev) => {
      const prevByKey = new Map(prev.map((entry) => [entry.key, entry]));
      const nextKeys = new Set<string>();
      const nextRows = tablePoints.map((point) => {
        const key = buildPointKey(point);
        nextKeys.add(key);
        const existing = prevByKey.get(key);
        if (existing) {
          return { ...existing, point, exiting: false };
        }
        return { key, point, exiting: false };
      });
      const exitingRows = prev
        .filter((entry) => !nextKeys.has(entry.key))
        .map((entry) => (entry.exiting ? entry : { ...entry, exiting: true }));
      return [...nextRows, ...exitingRows];
    });
  }, [buildPointKey, isOpen, tablePoints]);

  useEffect(() => {
    if (!isOpen) return;
    if (tableExitTimerRef.current) {
      window.clearTimeout(tableExitTimerRef.current);
      tableExitTimerRef.current = null;
    }
    if (!tableRows.some((row) => row.exiting)) return;
    tableExitTimerRef.current = window.setTimeout(() => {
      tableExitTimerRef.current = null;
      setTableRows((prev) => prev.filter((row) => !row.exiting));
    }, ROW_EXIT_ANIMATION_MS + 40);
  }, [isOpen, tableRows]);

  useEffect(() => {
    if (!isOpen) return;
    setPhase("entering");
    const raf = window.requestAnimationFrame(() => setPhase("open"));
    return () => window.cancelAnimationFrame(raf);
  }, [isOpen]);

  useLayoutEffect(() => {
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
      if (actualStrokeCleanupTimerRef.current) {
        window.clearTimeout(actualStrokeCleanupTimerRef.current);
        actualStrokeCleanupTimerRef.current = null;
      }
      if (forecastStrokeCleanupTimerRef.current) {
        window.clearTimeout(forecastStrokeCleanupTimerRef.current);
        forecastStrokeCleanupTimerRef.current = null;
      }
      if (tableExitTimerRef.current) {
        window.clearTimeout(tableExitTimerRef.current);
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
    const actualValues = extractSeries(displayPoints, "actual");
    const forecastValues = extractSeries(displayPoints, "forecast");
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
    const hasActualNumeric = actualValues.some((value) => value !== null);
    const hasForecastNumeric = forecastValues.some((value) => value !== null);
    const unitKeys: Array<keyof EventHistoryPoint> = [
      ...(hasActualNumeric ? (["actual"] as const) : []),
      ...(hasForecastNumeric ? (["forecast"] as const) : [])
    ];
    const unitLabel = detectUnitLabel(displayPoints, unitKeys);
    // Dense point markers get visually noisy beyond the small ranges.
    const renderPoints = activeRange !== "all" && activeRange <= 20;
    const pointDelayStepMs =
      displayPoints.length > 1 ? CHART_LINE_ANIMATION_MS / (displayPoints.length - 1) : 0;
    const buildPoints = (series: "actual" | "forecast", values: Array<number | null>) =>
      values
        .map((value, index) => {
          if (value === null) return null;
          const point = displayPoints[index];
          const raw =
            series === "actual"
              ? point?.actual
              : point?.forecast;
          const periodLabel = formatDisplayPeriod(point?.period);
          const actualRaw = series === "actual" ? String(point?.actualRaw ?? "") : "";
          const revisedFrom =
            series === "actual" && point
              ? !isMissingValue(point.actualRevisedFrom)
                ? String(point.actualRevisedFrom ?? "")
                : actualRaw && !valuesMatch(actualRaw, point.actual)
                  ? actualRaw
                  : ""
              : "";
          const labelParts = [
            formatDisplayDate(point?.date || ""),
            point?.time || "--",
            periodLabel ? `(${periodLabel})` : "",
            series === "actual" ? "Actual" : "Forecast",
            formatDisplayValue(raw)
          ];
          if (revisedFrom) {
            labelParts.push(`Revised from ${formatDisplayValue(revisedFrom)}`);
          }
          return {
            key: `${series}-${point?.date ?? ""}-${point?.time ?? ""}-${index}`,
            series,
            index,
            delayMs: Math.max(0, Math.round(index * pointDelayStepMs)),
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
      xStep: step,
      lastDataIndex: Math.max(0, displayPoints.length - 1),
      domainMax,
      domainSpan: span,
      yTicks,
      xTicks,
      unitLabel,
      xAxisLabel: "Date",
      yAxisLabel: "Value",
      actualPath: buildPath(actualValues, xForIndex, yForValue),
      forecastPath: buildPath(forecastValues, xForIndex, yForValue, { connectNulls: true }),
      points: renderPoints
        ? [
            ...(visibleSeries.actual ? buildPoints("actual", actualValues) : []),
            ...(visibleSeries.forecast ? buildPoints("forecast", forecastValues) : [])
          ]
        : []
    };
  }, [activeRange, displayPoints, hasData, hasVisibleSeries, visibleSeries]);

  useLayoutEffect(() => {
    if (loading) return;
    if (!chart) return;

    const prev = lineAnimationStateRef.current;
    const rangeChanged =
      !prev ||
      prev.contentToken !== contentEnterToken ||
      prev.activeRange !== activeRange ||
      prev.pointCount !== displayPoints.length;

    const actualAppeared = visibleSeries.actual && (!prev || !prev.actualVisible);
    const forecastAppeared = visibleSeries.forecast && (!prev || !prev.forecastVisible);

    const animateActual =
      visibleSeries.actual && (actualAppeared || (rangeChanged && Boolean(prev?.actualVisible)));
    const animateForecast =
      visibleSeries.forecast &&
      (forecastAppeared || (rangeChanged && Boolean(prev?.forecastVisible)));

    const animatePath = (
      path: SVGPathElement | null,
      timerRef: { current: number | null }
    ) => {
      if (!path) return;

      try {
        const length = path.getTotalLength();
        path.style.transition = "none";
        path.style.strokeDasharray = `${length}`;
        path.style.strokeDashoffset = `${length}`;
        // Force reflow so the next transition starts from dashoffset=length.
        path.getBoundingClientRect();
        path.style.transition = `stroke-dashoffset ${CHART_LINE_ANIMATION_MS}ms var(--motion-ease)`;
        path.style.strokeDashoffset = "0";
      } catch {
        // Ignore path animation failures (older SVG engines / zero-length paths).
      }

      // After the draw animation ends, clear dash styling. Otherwise subsequent path
      // updates can inherit the old dasharray length and look like a broken/dashed line.
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      const target = path;
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        if (!target.isConnected) return;
        target.style.transition = "";
        target.style.strokeDasharray = "";
        target.style.strokeDashoffset = "";
      }, CHART_LINE_ANIMATION_MS + 60);
    };

    if (animateActual) {
      animatePath(actualPathRef.current, actualStrokeCleanupTimerRef);
    }
    if (animateForecast) {
      animatePath(forecastPathRef.current, forecastStrokeCleanupTimerRef);
    }

    lineAnimationStateRef.current = {
      activeRange,
      pointCount: displayPoints.length,
      contentToken: contentEnterToken,
      actualVisible: visibleSeries.actual,
      forecastVisible: visibleSeries.forecast,
    };
  }, [
    activeRange,
    chart,
    contentEnterToken,
    displayPoints.length,
    loading,
    visibleSeries.actual,
    visibleSeries.forecast,
  ]);

  const toggleSeries = (key: "actual" | "forecast") => {
    setPreferredSeries((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      if (!next.actual && !next.forecast) {
        return prev;
      }
      return next;
    });
  };

  const hoverPoint =
    hoverIndex !== null && hoverIndex >= 0 && hoverIndex < displayPoints.length
      ? displayPoints[hoverIndex]
      : null;
  // Period tokens are used internally for stable sorting but are not part of the UI copy.
  const hoverActualRaw = hoverPoint ? String(hoverPoint.actualRaw ?? hoverPoint.actual ?? "") : "";
  const hoverActualRevised =
    hoverPoint && !isMissingValue(hoverPoint.actualRevisedFrom)
      ? String(hoverPoint.actualRevisedFrom ?? "")
      : hoverPoint && hoverActualRaw && !valuesMatch(hoverActualRaw, hoverPoint.actual)
        ? hoverActualRaw
        : "";
  const hoverPreviousValue = hoverPoint
    ? String(hoverPoint.previous ?? "")
    : "";

  const hoverRowKey = useMemo(
    () => (hoverPoint ? buildPointKey(hoverPoint) : null),
    [buildPointKey, hoverPoint]
  );

  const scrollTableToRow = useCallback((rowKey: string) => {
    const node = tableRef.current;
    if (!node) return;
    const selector = `[data-row-key=${JSON.stringify(rowKey)}]`;
    const row = node.querySelector<HTMLElement>(selector);
    if (!row) return;
    row.scrollIntoView({ block: "center", behavior: "smooth" });
  }, []);

  const handleTableScroll = useCallback(
    (_event: React.UIEvent<HTMLDivElement>) => {
      if (headerShadowFrame.current !== null) return;
      headerShadowFrame.current = window.requestAnimationFrame(() => {
        headerShadowFrame.current = null;
        updateHeaderShadow();
      });
    },
    [updateHeaderShadow]
  );

  const resolveHoverIndex = useCallback(
    (clientX: number) => {
      if (!chart) return null;
      const node = chartContainerRef.current;
      if (!node) return null;
      if (!displayPoints.length) return null;

      const rect = node.getBoundingClientRect();
      if (!rect.width) return null;

      const xPx = clientX - rect.left;
      const xSvg = (xPx / rect.width) * chart.width;
      const plotLeft = chart.padding.left;
      const plotRight = chart.padding.left + chart.plotWidth;
      const clamped = Math.max(plotLeft, Math.min(plotRight, xSvg));

      const next =
        displayPoints.length <= 1 || chart.xStep === 0
          ? 0
          : Math.round((clamped - plotLeft) / chart.xStep);
      return Math.max(0, Math.min(displayPoints.length - 1, next));
    },
    [chart, displayPoints.length]
  );

  const updateHoverIndex = (clientX: number) => {
    const bounded = resolveHoverIndex(clientX);
    if (bounded === null) return;
    setHoverIndex((prev) => (prev === bounded ? prev : bounded));
  };

  const hoverOverlay = useMemo(() => {
    if (!chart) return null;
    if (!hoverPoint || hoverIndex === null) return null;

    const x =
      displayPoints.length > 1
        ? chart.padding.left + hoverIndex * chart.xStep
        : chart.padding.left + chart.plotWidth / 2;

    const yFor = (value: number) =>
      chart.padding.top + ((chart.domainMax - value) / chart.domainSpan) * chart.plotHeight;

    const actualValue = visibleSeries.actual ? parseComparableNumber(hoverPoint.actual) : null;
    const forecastValue = visibleSeries.forecast ? parseComparableNumber(hoverPoint.forecast) : null;
    return {
      x,
      actualY: actualValue !== null ? yFor(actualValue) : null,
      forecastY: forecastValue !== null ? yFor(forecastValue) : null
    };
  }, [chart, displayPoints.length, hoverIndex, hoverPoint, visibleSeries]);

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
                            className={`history-toggle${
                              activeRange === option.key ? " active" : ""
                            }`}
                            onClick={() => setPreferredRange(option.key)}
                            aria-pressed={activeRange === option.key}
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
                      {hasForecastValues ? (
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
                      ) : null}
                    </div>
                  ) : null}
                </div>
                <div className="history-modal-layout">
                  <div className="history-modal-layout-left">
                    {hasMetricValues ? (
                      chart ? (
                        <div
                          className="history-modal-chart"
                          ref={chartContainerRef}
                          onMouseMove={(event) => updateHoverIndex(event.clientX)}
                          onMouseLeave={() => setHoverIndex(null)}
                          onClick={(event) => {
                            const index = resolveHoverIndex(event.clientX);
                            if (index === null) return;
                            const point = displayPoints[index];
                            if (!point) return;
                            setHoverIndex(index);
                            if (!(activeRange === "all" || activeRange > 10)) return;
                            scrollTableToRow(buildPointKey(point));
                          }}
                          onTouchMove={(event) => {
                            const touch = event.touches[0];
                            if (!touch) return;
                            updateHoverIndex(touch.clientX);
                          }}
                          onTouchEnd={() => setHoverIndex(null)}
                        >
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
                                  x={
                                    chart.xTicks.length === 1
                                      ? tick.x
                                      : tick.index === 0
                                        ? tick.x + 8
                                        : tick.index === chart.lastDataIndex
                                          ? tick.x - 8
                                          : tick.x
                                  }
                                  y={chart.height - chart.padding.bottom + 22}
                                  textAnchor={
                                    chart.xTicks.length === 1
                                      ? "middle"
                                      : tick.index === 0
                                        ? "start"
                                        : tick.index === chart.lastDataIndex
                                          ? "end"
                                          : "middle"
                                  }
                                >
                                  {tick.label}
                                </text>
                              ))}
                              <text
                                x={chart.padding.left + chart.plotWidth / 2}
                                y={chart.height - 14}
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
                                vectorEffect="non-scaling-stroke"
                                d={chart.forecastPath}
                              />
                            ) : null}
                            {visibleSeries.actual ? (
                              <path
                                ref={actualPathRef}
                                className="history-line history-line-actual"
                                vectorEffect="non-scaling-stroke"
                                d={chart.actualPath}
                              />
                            ) : null}
                            <g className="history-chart-points">
                              {chart.points.map((point) => (
                                <circle
                                  key={point.key}
                                  className={`history-point history-point-${point.series} animate`}
                                  cx={point.x}
                                  cy={point.y}
                                  r={3.8}
                                  style={{ animationDelay: `${point.delayMs}ms` }}
                                >
                                  <title>{point.label}</title>
                                </circle>
                              ))}
                            </g>
                            {hoverOverlay ? (
                              <g className="history-chart-hover" aria-hidden="true">
                                <line
                                  x1={Math.round(hoverOverlay.x) + 0.5}
                                  x2={Math.round(hoverOverlay.x) + 0.5}
                                  y1={chart.padding.top}
                                  y2={chart.height - chart.padding.bottom}
                                  vectorEffect="non-scaling-stroke"
                                />
                                {visibleSeries.actual && hoverOverlay.actualY !== null ? (
                                  <circle
                                    className="history-hover-dot history-point-actual"
                                    cx={hoverOverlay.x}
                                    cy={hoverOverlay.actualY}
                                    r={5.2}
                                  />
                                ) : null}
                                {visibleSeries.forecast && hoverOverlay.forecastY !== null ? (
                                  <circle
                                    className="history-hover-dot history-point-forecast"
                                    cx={hoverOverlay.x}
                                    cy={hoverOverlay.forecastY}
                                    r={5.2}
                                  />
                                ) : null}
                              </g>
                            ) : null}
                          </svg>
                          {hoverPoint ? (
                            <div className="history-chart-tooltip" data-qa="qa:history:tooltip">
                              <div className="history-tooltip-title">
                                {formatDisplayDate(hoverPoint.date)} {hoverPoint.time || "--"}
                              </div>
                              <div className="history-tooltip-body">
                                {visibleSeries.actual ? (
                                  <div className="history-tooltip-row">
                                    <span className="history-tooltip-key">
                                      <span
                                        className="history-tooltip-swatch actual"
                                        aria-hidden="true"
                                      />
                                      Actual
                                    </span>
                                    <span
                                      className={`history-tooltip-value${
                                        hoverActualRevised ? " revised" : ""
                                      }`}
                                    >
                                      {formatDisplayValue(hoverPoint.actual)}
                                    </span>
                                  </div>
                                ) : null}
                                {visibleSeries.actual && hoverActualRevised ? (
                                  <div className="history-tooltip-sub">
                                    Revised from {formatDisplayValue(hoverActualRevised)}
                                  </div>
                                ) : null}
                                {visibleSeries.forecast ? (
                                  <div className="history-tooltip-row">
                                    <span className="history-tooltip-key">
                                      <span
                                        className="history-tooltip-swatch forecast"
                                        aria-hidden="true"
                                      />
                                      Forecast
                                    </span>
                                    <span className="history-tooltip-value">
                                      {formatDisplayValue(hoverPoint.forecast)}
                                    </span>
                                  </div>
                                ) : null}
                                <div className="history-tooltip-row">
                                  <span className="history-tooltip-key">
                                    <span
                                      className="history-tooltip-swatch previous"
                                      aria-hidden="true"
                                    />
                                    Previous
                                  </span>
                                  <span className="history-tooltip-value">
                                    {formatDisplayValue(hoverPreviousValue)}
                                  </span>
                                </div>
                              </div>
                            </div>
                          ) : null}
                        </div>
                      ) : (
                        <div className="history-modal-empty">
                          {hasVisibleSeries
                            ? "Values are not available for charting."
                            : "Select a series to display."}
                        </div>
                      )
                    ) : null}
                    {hasNotes ? (
                      <>
                        <div className="history-notes-card" data-qa="qa:history:notes">
                          <div className="history-notes-title">Description</div>
                          <div className="history-notes-text">{eventNotes.note}</div>
                        </div>
                        <div
                          className="history-notes-disclaimer"
                          data-qa="qa:history:disclaimer"
                        >
                          XAUUSD impact guidance is based on experience, not yet backed by
                          statistical analysis; quantitative validation will be added later.
                        </div>
                      </>
                    ) : null}
                  </div>
                  <div className="history-modal-layout-right">
                    <div
                      className={`history-modal-table${
                        activeRange === "all" || activeRange > 10 ? " scrollable" : ""
                      }${
                        hasMetricValues ? "" : " schedule"
                      }${showHeaderShadow ? " has-header-shadow" : ""}`}
                      data-qa="qa:history:table"
                      onScroll={handleTableScroll}
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
                      {tableRows.map((row, index) => {
                        const point = row.point;
                        const actualValue = String(point.actualRaw ?? point.actual ?? "");
                        const previousValue = String(point.previous ?? "");
                        const previousRevised = !isMissingValue(point.previousRevisedFrom);
                        return (
                          <div
                            className={`history-modal-row${
                              row.exiting
                                ? " history-modal-row-exit"
                                : " history-modal-row-animate"
                            }${hoverRowKey === row.key && !row.exiting ? " active" : ""}`}
                            key={row.key}
                            data-row-key={row.key}
                            style={
                              row.exiting
                                ? undefined
                                : { animationDelay: `${Math.min(index * 28, 220)}ms` }
                            }
                          >
                            <span>{formatDisplayDate(point.date)}</span>
                            <span>{point.time || "--"}</span>
                            {hasMetricValues ? (
                              <>
                                <span className="history-value">
                                  <span className="history-value-main">
                                    {formatDisplayValue(actualValue)}
                                  </span>
                                  <span className="history-value-sub placeholder" aria-hidden="true">
                                    {"\u00A0"}
                                  </span>
                                </span>
                                <span className="history-value">
                                  <span className="history-value-main">
                                    {formatDisplayValue(point.forecast)}
                                  </span>
                                  <span className="history-value-sub placeholder" aria-hidden="true">
                                    {"\u00A0"}
                                  </span>
                                </span>
                                <span
                                  className={`history-value${previousRevised ? " revised" : ""}`}
                                  title={
                                    previousRevised
                                      ? `Revised from ${formatDisplayValue(point.previousRevisedFrom)}`
                                      : undefined
                                  }
                                >
                                  <span className="history-value-main">
                                    {formatDisplayValue(previousValue)}
                                  </span>
                                  <span className="history-value-sub placeholder" aria-hidden="true">
                                    {"\u00A0"}
                                  </span>
                                </span>
                                {previousRevised ? (
                                  <div className="history-row-revision" aria-hidden="true">
                                    <span className="history-revised-prefix">Revised from</span>
                                    <span className="history-revised-value">
                                      {formatDisplayValue(point.previousRevisedFrom)}
                                      <span className="history-revised-star" aria-hidden="true">
                                        *
                                      </span>
                                    </span>
                                  </div>
                                ) : null}
                              </>
                            ) : (
                              <span className="disabled">--</span>
                            )}
                          </div>
                        );
                      })}
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
