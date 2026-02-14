import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { 
  EventHistoryPoint, 
  EventHistoryResponse, 
  EventDeepAnalysisResponse,
  EventImpactBucket, 
  EventImpactResponse, 
  EventImpactWindowStats 
} from "../types"; 
import { backend } from "../api";
import { buildEventNotes } from "../utils/eventNotes";
import {
  formatTimeOffsetMinutes,
  getEffectiveCalendarUtcOffsetMinutes,
  parseDisplayTimeToUtcMs
} from "../utils/calendarTime";
import { DeepAnalysisView } from "./event-history/DeepAnalysisView";
import { Select } from "./Select";
import "./EventHistoryModal.css";

type EventHistoryModalProps = {
  isOpen: boolean;
  loading: boolean;
  error: string | null;
  selectionLabel: string;
  selectionImpact?: string;
  selectionActual?: string;
  selectionForecast?: string;
  selectionPrevious?: string;
  data: EventHistoryResponse | null;
  // UTC timestamp for the selected release instance (used for Deep Analysis unified outlook window).
  anchorDtUtc: string;
  calendarTimezoneMode: "utc" | "system";
  calendarUtcOffsetMinutes: number;
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
const IMPACT_BUCKET_STORAGE_KEY = "xauusd:event-history:impact-bucket";
const IMPACT_VIEW_STORAGE_KEY = "xauusd:event-history:impact-view";
const IMPACT_PANEL_STORAGE_KEY = "xauusd:event-history:impact-panel";

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
  const match = cleaned.match(/([+-]?\d+(?:\.\d+)?)([kmbt])?/i);
  if (!match) return null;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return null;
  const suffix = match[2]?.toLowerCase();
  if (suffix === "k") return base * 1_000;
  if (suffix === "m") return base * 1_000_000;
  if (suffix === "b") return base * 1_000_000_000;
  if (suffix === "t") return base * 1_000_000_000_000;
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

const formatCoverage = (isoMin: string | null | undefined, isoMax: string | null | undefined) => {
  const min = (isoMin ?? "").trim();
  const max = (isoMax ?? "").trim();
  if (!min || !max) return "";
  const minDate = min.slice(0, 10);
  const maxDate = max.slice(0, 10);
  if (!minDate || !maxDate) return "";
  return `${formatDisplayDate(minDate)} to ${formatDisplayDate(maxDate)} UTC`;
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

const classifyImpactBucket = (actual: string, previous: string): EventImpactBucket | null => {
  const actualValue = parseComparableNumber(actual);
  const previousValue = parseComparableNumber(previous);
  if (actualValue === null || previousValue === null) return null;
  if (actualValue > previousValue) return "ap_gt_prev";
  if (actualValue < previousValue) return "ap_lt_prev";
  return "ap_eq_prev";
};

const extractSeries = (points: EventHistoryPoint[], key: keyof EventHistoryPoint) =>
  points.map((item) => parseComparableNumber(String(item[key] ?? "")));

const formatTickNumber = (value: number) => {
  const abs = Math.abs(value);
  const format = (num: number) => {
    const text = num.toFixed(abs < 1 ? 2 : abs < 10 ? 2 : abs < 100 ? 1 : 0);
    return text.replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
  };
  if (abs >= 1_000_000_000_000) return `${format(value / 1_000_000_000_000)}T`;
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
      const suffix = raw.match(/[kmbt]$/i)?.[0];
      if (suffix) return suffix.toUpperCase();
    }
  }
  return "";
};

const formatOffsetLabel = (minutes: number) => {
  if (minutes === 0) return "0";
  const abs = Math.abs(minutes);
  const sign = minutes < 0 ? "-" : "+";
  if (abs % (12 * 60) === 0) return `${sign}${abs / (12 * 60)}d`;
  if (abs % 60 === 0) return `${sign}${abs / 60}h`;
  return `${sign}${abs}m`;
};

const IMPACT_AXIS_OFFSETS = [-12 * 60, -4 * 60, -60, 0, 60, 4 * 60, 12 * 60];
// Disable in-chart probability labels (they frequently overlap and add visual noise).
// Tooltip still provides per-window details on hover.
const IMPACT_LABEL_OFFSETS: number[] = [];

const formatPct = (value: number) => {
  const abs = Math.abs(value);
  const digits = abs < 0.1 ? 3 : abs < 1 ? 2 : 2;
  return `${value.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "")}%`;
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
  let hasLineSegment = false;
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
      hasLineSegment = true;
    }
  });
  // A path with only a move command renders nothing; treat it as empty.
  return hasLineSegment ? path : "";
};

export function EventHistoryModal({
  isOpen,
  loading,
  error,
  selectionLabel,
  selectionImpact,
  selectionActual,
  selectionForecast,
  selectionPrevious,
  data,
  anchorDtUtc,
  calendarTimezoneMode,
  calendarUtcOffsetMinutes,
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
  const modalBodyRef = useRef<HTMLDivElement | null>(null);
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
  const [impactOpen, setImpactOpen] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(IMPACT_VIEW_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [impactPanel, setImpactPanel] = useState<"event" | "deep">(() => {
    if (typeof window === "undefined") return "event";
    try {
      return window.localStorage.getItem(IMPACT_PANEL_STORAGE_KEY) === "deep" ? "deep" : "event";
    } catch {
      return "event";
    }
  });
  const prevImpactPanelRef = useRef<"event" | "deep">(impactPanel);
  const [impactBucket, setImpactBucket] = useState<EventImpactBucket>(() => {
    if (typeof window === "undefined") return "ap_gt_prev";
    try {
      const raw = window.localStorage.getItem(IMPACT_BUCKET_STORAGE_KEY);
      if (raw === "ap_gt_prev" || raw === "ap_lt_prev" || raw === "ap_eq_prev") return raw;
    } catch {
      // ignore
    }
    return "ap_gt_prev";
  });
  const [impactLoading, setImpactLoading] = useState(false);
  const [impactError, setImpactError] = useState<string | null>(null);
  const [impactData, setImpactData] = useState<EventImpactResponse | null>(null);
  const [deepLoading, setDeepLoading] = useState(false);
  const [deepError, setDeepError] = useState<string | null>(null);
  const [deepData, setDeepData] = useState<EventDeepAnalysisResponse | null>(null);
  const deepCacheRef = useRef<Map<string, EventDeepAnalysisResponse>>(new Map());
  const [impactChartAnimKey, setImpactChartAnimKey] = useState(0);
  const impactBodyRef = useRef<HTMLDivElement | null>(null);
  // Cache impact payloads per (eventId, bucket) to avoid flicker when switching History <-> Impact.
  const impactCacheRef = useRef<Map<string, EventImpactResponse>>(new Map());
  const [impactViewport, setImpactViewport] = useState<{ width: number; height: number } | null>(
    null
  );
  const [impactViewportReady, setImpactViewportReady] = useState(false);
  const impactViewportStableRef = useRef<{ width: number; height: number; count: number } | null>(
    null
  );
  const impactViewportReadyTimerRef = useRef<number | null>(null);
  const impactViewportReadyDeadlineRef = useRef<number | null>(null);
  const impactViewportReadyFallbackRef = useRef<number | null>(null);
  const [impactHoverOffset, setImpactHoverOffset] = useState<number | null>(null); 
  const impactTooltipRef = useRef<HTMLDivElement | null>(null);
  const [impactTooltipPos, setImpactTooltipPos] = useState<{ leftPct: number; topPct: number } | null>(
    null
  );
  const [impactNowMs, setImpactNowMs] = useState(() => Date.now());
  const effectiveCalendarOffsetMinutes = useMemo(() => {
    return getEffectiveCalendarUtcOffsetMinutes({
      calendarTimezoneMode,
      calendarUtcOffsetMinutes,
      nowMs: impactNowMs
    });
  }, [calendarTimezoneMode, calendarUtcOffsetMinutes, impactNowMs]);
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
  const eventId = (data?.eventId ?? "").trim();
  const isUsdEvent = eventId.startsWith("USD::");
  const bucketCounts = useMemo(() => {
    const counts: Record<EventImpactBucket, number> = {
      ap_gt_prev: 0,
      ap_lt_prev: 0,
      ap_eq_prev: 0
    };
    for (const point of points) {
      // Analysis excludes All Day / missing times. Mirror that rule for bucket availability hints.
      const t = String(point.time ?? "").trim().toLowerCase();
      if (!t || t === "all day" || !t.includes(":")) continue;
      const bucket = classifyImpactBucket(point.actual, point.previous);
      if (!bucket) continue;
      counts[bucket] += 1;
    }
    return counts;
  }, [points]);
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

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(IMPACT_VIEW_STORAGE_KEY, impactOpen ? "1" : "0");
    } catch {
      // ignore
    }
  }, [impactOpen]);

  // Drive the "now" marker in the Impact chart.
  useEffect(() => {
    if (!impactOpen || impactPanel !== "event") return;
    if (typeof window === "undefined") return;
    const id = window.setInterval(() => setImpactNowMs(Date.now()), 15_000);
    return () => window.clearInterval(id);
  }, [impactOpen, impactPanel]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(IMPACT_PANEL_STORAGE_KEY, impactPanel);
    } catch {
      // ignore
    }
  }, [impactPanel]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(IMPACT_BUCKET_STORAGE_KEY, impactBucket);
    } catch {
      // ignore
    }
  }, [impactBucket]);

  const measureViewport = useCallback((node: HTMLElement | null) => {
    if (!node) return null;
    const width = Math.max(1, Math.floor(node.offsetWidth || node.getBoundingClientRect().width));
    const height = Math.max(1, Math.floor(node.offsetHeight || node.getBoundingClientRect().height));
    if (width < 50 || height < 50) return null;
    return { width, height };
  }, []);

  const updateImpactViewport = useCallback(
    (measured: { width: number; height: number }) => {
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      const canReady = phase === "open";
      if (canReady && impactViewportReady) {
        setImpactViewport((current) => {
          if (
            current &&
            Math.abs(current.width - measured.width) <= 1 &&
            Math.abs(current.height - measured.height) <= 1
          ) {
            return current;
          }
          return measured;
        });
        return;
      }
      if (!canReady) {
        impactViewportStableRef.current = {
          width: measured.width,
          height: measured.height,
          count: 1
        };
        setImpactViewportReady(false);
        if (impactViewportReadyTimerRef.current !== null) {
          window.clearTimeout(impactViewportReadyTimerRef.current);
          impactViewportReadyTimerRef.current = null;
        }
        impactViewportReadyDeadlineRef.current = now + 700;
      } else {
        const prev = impactViewportStableRef.current;
        if (
          prev &&
          Math.abs(prev.width - measured.width) <= 1 &&
          Math.abs(prev.height - measured.height) <= 1
        ) {
          const next = { width: measured.width, height: measured.height, count: prev.count + 1 };
          impactViewportStableRef.current = next;
          if (impactViewportReadyDeadlineRef.current === null) {
            impactViewportReadyDeadlineRef.current = now + 700;
          }
          const shouldArmReady =
            next.count >= 3 ||
            (impactViewportReadyDeadlineRef.current !== null &&
              now >= impactViewportReadyDeadlineRef.current);
          if (shouldArmReady && impactViewportReadyTimerRef.current === null) {
            impactViewportReadyTimerRef.current = window.setTimeout(() => {
              impactViewportReadyTimerRef.current = null;
              const stable = impactViewportStableRef.current;
              if (
                stable &&
                Math.abs(stable.width - measured.width) <= 1 &&
                Math.abs(stable.height - measured.height) <= 1 &&
                (stable.count >= 3 ||
                  (impactViewportReadyDeadlineRef.current !== null &&
                    (typeof performance !== "undefined"
                      ? performance.now()
                      : Date.now()) >= impactViewportReadyDeadlineRef.current))
              ) {
                setImpactViewportReady(true);
              }
            }, 260);
          }
        } else {
          impactViewportStableRef.current = {
            width: measured.width,
            height: measured.height,
            count: 1
          };
          setImpactViewportReady(false);
          if (impactViewportReadyTimerRef.current !== null) {
            window.clearTimeout(impactViewportReadyTimerRef.current);
            impactViewportReadyTimerRef.current = null;
          }
          impactViewportReadyDeadlineRef.current = now + 700;
        }
      }

      setImpactViewport((current) => {
        if (
          current &&
          Math.abs(current.width - measured.width) <= 1 &&
          Math.abs(current.height - measured.height) <= 1
        ) {
          return current;
        }
        return measured;
      });
    },
    [impactViewportReady, phase]
  );

  const openImpact = useCallback(() => {
    if (impactOpen) return;

    // Flip the visual state immediately (click only fires on release; this avoids a perceived "lag").
    setImpactOpen(true);

    // Avoid seeding from the History chart; its size can be smaller and cause a flash.

    if (isUsdEvent && impactPanel === "event" && eventId) {
      const cacheKey = `${eventId}::${impactBucket}`;
      const cached = impactCacheRef.current.get(cacheKey);
      if (cached?.ok) {
        setImpactError(null);
        setImpactData(cached);
        setImpactLoading(false);
      } else {
        // Avoid a "not available" flash before the fetch effect kicks in.
        setImpactError(null);
        setImpactLoading(true);
      }
    }

    // Also try measuring the Impact viewport right after it mounts. This fixes a Tauri-specific case
    // where ResizeObserver may not fire immediately on first open, leading to a blank chart until re-toggle.
    if (typeof window !== "undefined") {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          const measured = measureViewport(impactBodyRef.current);
          if (!measured) return;
          updateImpactViewport(measured);
        });
      });
    }
  }, [eventId, impactBucket, impactOpen, impactPanel, isUsdEvent, measureViewport, updateImpactViewport]);

  const ensureImpactViewport = useCallback(() => {
    // Try the direct viewport first.
    const direct = measureViewport(impactBodyRef.current);
    if (direct) {
      updateImpactViewport(direct);
      return true;
    }

    // Fallback: measure the chart container (Tauri sometimes reports 0 for the flex child early on).
    const body = impactBodyRef.current;
    const container = body?.closest?.(".history-impact-chart");
    if (container instanceof HTMLElement) {
      const width = Math.max(
        1,
        Math.floor(container.offsetWidth || container.getBoundingClientRect().width)
      );
      const height = Math.max(
        1,
        Math.floor(container.offsetHeight || container.getBoundingClientRect().height)
      );
      if (width >= 50 && height >= 50) {
        updateImpactViewport({ width, height });
        return true;
      }
    }
    return false;
  }, [measureViewport, updateImpactViewport]);

  // If the modal opens directly in Impact view (saved in localStorage), Tauri may not fire
  // ResizeObserver immediately. Ensure we still get a usable viewport without requiring a manual re-toggle.
  useEffect(() => {
    if (!isOpen) return;
    if (!impactOpen) return;
    if (impactPanel !== "event") return;
    if (impactViewport && impactViewport.width >= 50 && impactViewport.height >= 50) return;

    let cancelled = false;
    let tries = 0;
    const tick = () => {
      if (cancelled) return;
      if (ensureImpactViewport()) return;
      tries += 1;
      if (tries > 24) return;
      window.setTimeout(tick, 60);
    };

    // Give layout a couple of frames to settle.
    window.requestAnimationFrame(() => window.requestAnimationFrame(tick));
    return () => {
      cancelled = true;
    };
  }, [ensureImpactViewport, impactOpen, impactPanel, impactViewport, isOpen]);

  useEffect(() => {
    if (!isOpen || !impactOpen) return;
    if (!eventId) return;
    // Deep Analysis reuses Impact stats for the fallback Unified Outlook P(t).
    // Keep the impact dataset warm for both sub-panels.
    if (impactPanel !== "event" && impactPanel !== "deep") return;
    if (!isUsdEvent) {
      setImpactError("Impact analysis is available for USD events only.");
      setImpactData(null);
      setImpactLoading(false);
      return;
    }

    const cacheKey = `${eventId}::${impactBucket}`;
    const cached = impactCacheRef.current.get(cacheKey);
    if (cached?.ok) {
      setImpactError(null);
      setImpactData(cached);
      setImpactLoading(false);
      return;
    }

    let cancelled = false;
    setImpactLoading(true);
    setImpactError(null);
    setImpactData(null);

    backend
      .getEventImpactUsd({ eventId, bucket: impactBucket })
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          setImpactError(result.message || "Impact analysis unavailable.");
          setImpactData(null);
          return;
        }
        impactCacheRef.current.set(cacheKey, result);
        setImpactData(result);
      })
      .catch((err) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : "Impact analysis failed";
        setImpactError(msg);
        setImpactData(null);
      })
      .finally(() => {
        if (cancelled) return;
        setImpactLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [eventId, impactBucket, impactOpen, impactPanel, isOpen, isUsdEvent]);

  useEffect(() => {
    if (!isOpen || !impactOpen) return;
    if (!eventId) return;
    if (impactPanel !== "deep") return;
    if (!isUsdEvent) {
      setDeepError("Deep analysis is available for USD events only.");
      setDeepData(null);
      setDeepLoading(false);
      return;
    }

    const cacheKey = `${eventId}::${(anchorDtUtc || "").trim()}`;
    const cached = deepCacheRef.current.get(cacheKey);
    if (cached?.ok) {
      setDeepError(null);
      setDeepData(cached);
      setDeepLoading(false);
      return;
    }

    let cancelled = false;
    setDeepLoading(true);
    setDeepError(null);
    setDeepData(null);

    backend
      .getEventDeepAnalysisUsd({ eventId, anchorDtUtc })
      .then((result) => {
        if (cancelled) return;
        setDeepError(null);
        setDeepData(result);
        if (result.ok) deepCacheRef.current.set(cacheKey, result);
      })
      .catch((err) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : "Deep analysis failed";
        setDeepError(msg);
        setDeepData(null);
      })
      .finally(() => {
        if (cancelled) return;
        setDeepLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [eventId, impactOpen, impactPanel, isOpen, isUsdEvent, anchorDtUtc]);

  // Prefetch impact data while the modal is open so switching History -> Impact is instant.
  useEffect(() => {
    if (!isOpen) return;
    if (!eventId) return;
    if (!isUsdEvent) return;
    if (impactPanel !== "event") return;

    const cacheKey = `${eventId}::${impactBucket}`;
    if (impactCacheRef.current.has(cacheKey)) return;
    let cancelled = false;

    backend
      .getEventImpactUsd({ eventId, bucket: impactBucket })
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) return;
        impactCacheRef.current.set(cacheKey, result);
      })
      .catch(() => {
        // ignore: the explicit Impact open flow will surface errors
      });

    return () => {
      cancelled = true;
    };
  }, [eventId, impactBucket, impactPanel, isOpen, isUsdEvent]);

  // Measure the impact viewport during layout so the first paint can render the correct SVG size.
  useLayoutEffect(() => {
    if (!impactOpen) return;
    if (!isOpen) return;
    if (impactPanel !== "event") return;
    const node = impactBodyRef.current;
    if (!node) return;
    let cancelled = false;
    let tries = 0;

    const tick = () => {
      if (cancelled) return;
      const measured = measureViewport(node);
      if (measured) {
        updateImpactViewport(measured);
        return;
      }

      tries += 1;
      if (tries > 18) return;
      window.requestAnimationFrame(tick);
    };

    tick();
    return () => {
      cancelled = true;
    };
  }, [impactOpen, impactPanel, isOpen, measureViewport, updateImpactViewport]);

  useEffect(() => {
    if (!impactOpen) return;
    if (!isOpen) return;
    if (impactPanel !== "event") return;
    const node = impactBodyRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    let cancelled = false;

    const observer = new ResizeObserver(() => {
      if (cancelled) return;
      const measured = measureViewport(node);
      if (!measured) return;
      updateImpactViewport(measured);
    });

    observer.observe(node);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [impactOpen, impactPanel, isOpen, measureViewport, updateImpactViewport]);

  useEffect(() => {
    if (!impactOpen) return;
    if (!isOpen) return;
    if (impactPanel !== "event") return;
    const node = impactBodyRef.current;
    if (!node) return;
    let cancelled = false;

    const remeasure = () => {
      if (cancelled) return;
      const measured = measureViewport(node);
      if (!measured) return;
      updateImpactViewport(measured);
    };

    const t1 = window.setTimeout(remeasure, 280);
    const t2 = window.setTimeout(remeasure, 520);
    return () => {
      cancelled = true;
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [impactOpen, impactPanel, isOpen, measureViewport, updateImpactViewport]);

  useEffect(() => {
    if (!impactOpen || !isOpen || impactPanel !== "event") {
      setImpactViewportReady(false);
      impactViewportStableRef.current = null;
      if (impactViewportReadyTimerRef.current !== null) {
        window.clearTimeout(impactViewportReadyTimerRef.current);
        impactViewportReadyTimerRef.current = null;
      }
      impactViewportReadyDeadlineRef.current = null;
      if (impactViewportReadyFallbackRef.current !== null) {
        window.clearTimeout(impactViewportReadyFallbackRef.current);
        impactViewportReadyFallbackRef.current = null;
      }
    }
  }, [impactOpen, impactPanel, isOpen]);

  useEffect(() => {
    if (phase !== "open") return;
    if (!impactOpen || !isOpen || impactPanel !== "event") return;
    const measured = measureViewport(impactBodyRef.current);
    if (measured) {
      updateImpactViewport(measured);
    }
  }, [impactOpen, impactPanel, isOpen, measureViewport, phase, updateImpactViewport]);

  useEffect(() => {
    if (!impactOpen || !isOpen || impactPanel !== "event") return;
    if (impactViewportReadyFallbackRef.current !== null) {
      window.clearTimeout(impactViewportReadyFallbackRef.current);
      impactViewportReadyFallbackRef.current = null;
    }
    impactViewportReadyFallbackRef.current = window.setTimeout(() => {
      impactViewportReadyFallbackRef.current = null;
      const measured = measureViewport(impactBodyRef.current);
      if (!measured) return;
      updateImpactViewport(measured);
      setImpactViewportReady(true);
    }, 420);
    return () => {
      if (impactViewportReadyFallbackRef.current !== null) {
        window.clearTimeout(impactViewportReadyFallbackRef.current);
        impactViewportReadyFallbackRef.current = null;
      }
    };
  }, [impactOpen, impactPanel, isOpen, measureViewport, updateImpactViewport]);


  useEffect(() => {
    if (!isOpen) return;
    if (!impactOpen) {
      prevImpactPanelRef.current = impactPanel;
      return;
    }
    // Switching Impact sub-panels should not leave the user scrolled mid-modal, otherwise
    // the toolbar appears to "move" when content height changes.
    if (prevImpactPanelRef.current !== impactPanel) {
      modalBodyRef.current?.scrollTo({ top: 0 });
    }
    prevImpactPanelRef.current = impactPanel;
  }, [impactOpen, impactPanel, isOpen]);

  const impactSeries = useMemo(() => {
    const windows = impactData?.windowsMinutes ?? [];
    const raw = impactData?.data ?? {};
    const offsetsAll = Array.from(new Set<number>([...windows, 0])).sort((a, b) => a - b);
    const itemsAll = offsetsAll.map((offset) => {
      const key = String(offset);
      const stats = (raw[key] as EventImpactWindowStats | undefined) ?? undefined;
      return { offset, stats };
    });
    // Hide offsets that have no samples to avoid breaking the path with invisible intermediate points.
    const items = itemsAll.filter((item) => item.offset === 0 || (item.stats?.n ?? 0) > 0);

    const bandValues: number[] = [];
    const lineValues: number[] = [];
    for (const item of items) {
      if (!item.stats || typeof item.stats.n !== "number" || item.stats.n <= 0) continue;
      const s = item.stats;
      // Density band requires the all-samples quantiles. If missing (old cache), we simply don't draw it.
      if (typeof s.p05_all === "number") bandValues.push(s.p05_all);
      if (typeof s.p10_all === "number") bandValues.push(s.p10_all);
      if (typeof s.p25_all === "number") bandValues.push(s.p25_all);
      if (typeof s.p75_all === "number") bandValues.push(s.p75_all);
      if (typeof s.p90_all === "number") bandValues.push(s.p90_all);
      if (typeof s.p95_all === "number") bandValues.push(s.p95_all);
      if (typeof item.stats.best_median_pct === "number") {
        lineValues.push(item.stats.best_median_pct);
      }
    }
    const values = [...bandValues, ...lineValues, 0].filter((v) => Number.isFinite(v));
    const min = values.length ? Math.min(...values) : -1;
    const max = values.length ? Math.max(...values) : 1;
    return { items, min, max };
  }, [impactData]);

  const impactCoverage = useMemo(() => {
    const meta = impactData?.meta;
    if (!meta) return "";
    // Prefer actual sample event range; it's the true coverage of computed stats.
    const range = formatCoverage(meta.event_min_utc, meta.event_max_utc);
    return range;
  }, [impactData]);

  const impactBucketOptions = useMemo(() => {
    const opts = [
      { value: "ap_gt_prev", label: "A > Prev", count: bucketCounts.ap_gt_prev },
      { value: "ap_lt_prev", label: "A < Prev", count: bucketCounts.ap_lt_prev },
      { value: "ap_eq_prev", label: "A = Prev", count: bucketCounts.ap_eq_prev }
    ];
    return opts;
  }, [bucketCounts]);

  const impactSelectedBucketCount = bucketCounts[impactBucket] ?? 0;
  const impactSamplesLabel = useMemo(() => {
    const n = impactData?.meta?.sample_points;
    if (typeof n === "number" && Number.isFinite(n) && n > 0) return String(n);
    if (impactSelectedBucketCount > 0) return String(impactSelectedBucketCount);
    return "";
  }, [impactData, impactSelectedBucketCount]);

  const impactChart = useMemo(() => {
    if (!impactOpen || !impactViewportReady) return null;
    // Match the chart viewport to its on-screen size (avoids letterboxing when the modal
    // layout changes across themes / platforms).
    const measuredWidth = impactViewport?.width ?? 0;
    const measuredHeight = impactViewport?.height ?? 0;
    // Wait for a stable measurement; rendering with a fake size causes letterboxing or stretched text.
    // Only guard the 0/1px transient state during layout switches; allow narrow windows to still render.
    if (measuredWidth < 10 || measuredHeight < 10) return null;
    const width = measuredWidth;
    const height = measuredHeight;
    // Leave enough room for Y axis labels and the X axis title.
    const padding = { left: 56, right: 10, top: 12, bottom: 56 };
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;
    const offsets = impactSeries.items.map((item) => item.offset);

    // Use ordinal spacing so points around 0 (1m/5m/15m...) don't collapse into a blob.
    const offsetIndex = new Map<number, number>();
    offsets.forEach((offset, index) => offsetIndex.set(offset, index));
    const denom = Math.max(1, offsets.length - 1);
    const xForOffset = (offset: number) => {
      const idx = offsetIndex.get(offset) ?? 0;
      return padding.left + (idx / denom) * plotWidth;
    };
    const xForOffsetContinuous = (offset: number) => {
      if (!Number.isFinite(offset)) return xForOffset(0);
      if (offsets.length === 0) return xForOffset(0);
      if (offset <= offsets[0]) return xForOffset(offsets[0]);
      const last = offsets[offsets.length - 1];
      if (offset >= last) return xForOffset(last);
      for (let i = 1; i < offsets.length; i++) {
        const right = offsets[i];
        if (offset <= right) {
          const left = offsets[i - 1];
          const x0 = xForOffset(left);
          const x1 = xForOffset(right);
          const span = right - left;
          if (!Number.isFinite(span) || span === 0) return x0;
          const t = (offset - left) / span;
          return x0 + t * (x1 - x0);
        }
      }
      return xForOffset(last);
    };

    const rawMin = impactSeries.min;
    const rawMax = impactSeries.max;
    const domainSpan = rawMax - rawMin;
    const absMax = Math.max(Math.abs(rawMax), Math.abs(rawMin));
    // Avoid a hardcoded +-1% pad which flattens small-magnitude results.
    // Keep the domain "tight" so small-magnitude results still read clearly.
    // Values are in decimal pct-change (0.001 = 0.1%), so a tiny floor is enough.
    const minPad = Math.max(absMax * 0.02, 0.0008);
    const pad = Math.max(domainSpan * 0.03, minPad);
    const domainMin = rawMin - pad;
    const domainMax = rawMax + pad;
    const spanY = Math.max(1e-9, domainMax - domainMin);
    const yFor = (value: number) => padding.top + ((domainMax - value) / spanY) * plotHeight;

    const niceStep = (span: number, ticks: number) => {
      const raw = span / Math.max(1, ticks);
      if (!Number.isFinite(raw) || raw <= 0) return 1;
      const power = Math.pow(10, Math.floor(Math.log10(raw)));
      const base = raw / power;
      const niceBase = base <= 1 ? 1 : base <= 2 ? 2 : base <= 5 ? 5 : 10;
      return niceBase * power;
    };

    const buildNiceTicks = (min: number, max: number) => {
      const span = max - min;
      if (!Number.isFinite(span) || span <= 0) return [0];
      const step = niceStep(span, 4);
      const start = Math.floor(min / step) * step;
      const end = Math.ceil(max / step) * step;
      const ticks: number[] = [];
      for (let v = start; v <= end + step * 0.5; v += step) {
        ticks.push(Math.abs(v) <= 1e-12 ? 0 : v);
      }
      return ticks;
    };

    const yTicks = buildNiceTicks(domainMin, domainMax);

    const medianByOffset = new Map<number, number>();
    const points = impactSeries.items.map((item) => {
      if (item.offset === 0) {
        medianByOffset.set(0, 0);
        return {
          offset: 0,
          x: xForOffset(0),
          y: yFor(0),
          upLow: null,
          upHigh: null,
          downLow: null,
          downHigh: null,
          bestDirection: null,
          bestP: null
        };
      }
      const s = item.stats;
      if (!s || typeof s.n !== "number" || s.n <= 0) return null;
      const bestMedian = typeof s.best_median_pct === "number" ? s.best_median_pct : null;
      if (bestMedian === null) return null;
      // Density band requires *_all quantiles. If missing (old cache), the band won't render for this point.
      const p05All = typeof s.p05_all === "number" ? s.p05_all : null;
      const p10All = typeof s.p10_all === "number" ? s.p10_all : null;
      const p25All = typeof s.p25_all === "number" ? s.p25_all : null;
      const p75All = typeof s.p75_all === "number" ? s.p75_all : null;
      const p90All = typeof s.p90_all === "number" ? s.p90_all : null;
      const p95All = typeof s.p95_all === "number" ? s.p95_all : null;
      medianByOffset.set(item.offset, bestMedian);
      return {
        offset: item.offset,
        x: xForOffset(item.offset),
        y: yFor(bestMedian),
        p05All,
        p10All,
        p25All,
        p75All,
        p90All,
        p95All,
        bestDirection: s.best_direction ?? null,
        bestP: typeof s.best_p === "number" ? s.best_p : null
      };
    });

    const bandPoints = points.filter(Boolean) as Array<NonNullable<(typeof points)[number]>>;
    const buildBandPath = (
      items: Array<{ x: number; low: number; high: number }>,
      yForValue: (v: number) => number
    ) => {
      if (items.length < 2) return "";
      const upper = items.map((p) => `L ${p.x.toFixed(2)} ${yForValue(p.high).toFixed(2)}`);
      const lower = items
        .slice()
        .reverse()
        .map((p) => `L ${p.x.toFixed(2)} ${yForValue(p.low).toFixed(2)}`);
      return `M ${items[0].x.toFixed(2)} ${yForValue(items[0].high).toFixed(2)} ${upper.join(
        " "
      )} ${lower.join(" ")} Z`;
    };

    const makeItems = (lowKey: "p25All" | "p10All" | "p05All", highKey: "p75All" | "p90All" | "p95All") =>
      bandPoints
        .map((p) =>
          typeof p[lowKey] === "number" && typeof p[highKey] === "number"
            ? { x: p.x, low: p[lowKey] as number, high: p[highKey] as number }
            : null
        )
        .filter(Boolean) as Array<{ x: number; low: number; high: number }>;

    const band50Items = makeItems("p25All", "p75All");
    const band80Items = makeItems("p10All", "p90All");
    const band90Items = makeItems("p05All", "p95All");

    const band50Path = buildBandPath(band50Items, yFor);
    const band80Path = buildBandPath(band80Items, yFor);
    const band90Path = buildBandPath(band90Items, yFor);

    const computeConfidence = (p: number | null | undefined) => {
      if (typeof p !== "number" || !Number.isFinite(p)) return 0;
      // best_p is the probability of best_direction; treat 50% as 0 confidence, 100% as 1.
      return Math.max(0, Math.min(1, (p - 0.5) / 0.5));
    };
    const resolveLineStyle = (stats?: EventImpactWindowStats) => {
      const dir = stats?.best_direction;
      const p = stats?.best_p;
      const confidence = computeConfidence(p);
      const stroke =
        dir === "up" ? "var(--success)" : dir === "down" ? "var(--danger)" : "#ff8f7b";
      const strokeOpacity = 0.5 + confidence * 0.45;
      const strokeWidth = 1.7 + confidence * 1.1;
      return { stroke, strokeOpacity, strokeWidth, confidence };
    };

    const lineStyleByOffset = new Map<
      number,
      { stroke: string; strokeOpacity: number; strokeWidth: number; confidence: number }
    >();
    impactSeries.items.forEach((item) => {
      if (item.offset === 0) return;
      lineStyleByOffset.set(item.offset, resolveLineStyle(item.stats));
    });

    const lineValues = impactSeries.items.map((item) => {
      if (item.offset === 0) return 0;
      const v = item.stats?.best_median_pct;
      return typeof v === "number" ? v : null;
    });
    const linePath = buildPath(
      lineValues,
      (index) => xForOffset(impactSeries.items[index]?.offset ?? 0),
      (value) => yFor(value),
      { connectNulls: false }
    );

    const lineSegments = (() => {
      const segments: Array<{ d: string; stroke: string; strokeOpacity: number; strokeWidth: number }> =
        [];
      for (let i = 1; i < impactSeries.items.length; i += 1) {
        const leftItem = impactSeries.items[i - 1];
        const rightItem = impactSeries.items[i];
        const v0 = leftItem?.offset === 0 ? 0 : leftItem?.stats?.best_median_pct;
        const v1 = rightItem?.offset === 0 ? 0 : rightItem?.stats?.best_median_pct;
        if (typeof v0 !== "number" || typeof v1 !== "number") continue;
        if (!Number.isFinite(v0) || !Number.isFinite(v1)) continue;
        const x0 = xForOffset(leftItem.offset);
        const x1 = xForOffset(rightItem.offset);
        const y0 = yFor(v0);
        const y1 = yFor(v1);

        const style =
          (rightItem.offset !== 0 ? lineStyleByOffset.get(rightItem.offset) : null) ??
          (leftItem.offset !== 0 ? lineStyleByOffset.get(leftItem.offset) : null) ??
          resolveLineStyle(undefined);

        segments.push({
          d: `M ${x0.toFixed(2)} ${y0.toFixed(2)} L ${x1.toFixed(2)} ${y1.toFixed(2)}`,
          ...style
        });
      }
      return segments;
    })();

    const isDrawablePath = (d: string) => {
      const normalized = (d ?? "").trim();
      if (!normalized) return false;
      // Require at least one line command; a single "M" renders nothing.
      return /\bL\b/.test(normalized) && !/NaN|Infinity/.test(normalized);
    };

    const band50PathSafe = /NaN|Infinity/.test(band50Path) ? "" : band50Path;
    const band80PathSafe = /NaN|Infinity/.test(band80Path) ? "" : band80Path;
    const band90PathSafe = /NaN|Infinity/.test(band90Path) ? "" : band90Path;
    const linePathSafe = /NaN|Infinity/.test(linePath) ? "" : linePath;
    const hasBand =
      (band50Items.length >= 2 && !!band50PathSafe) ||
      (band80Items.length >= 2 && !!band80PathSafe) ||
      (band90Items.length >= 2 && !!band90PathSafe);
    const hasLine = lineSegments.length >= 1 && isDrawablePath(linePathSafe);

    const clampY = (y: number) =>
      Math.max(padding.top, Math.min(height - padding.bottom, y));
    const yForClamped = (value: number) => clampY(yFor(value));

    const xTicks = IMPACT_AXIS_OFFSETS.filter((t) => offsetIndex.has(t));
    const hoverPoints = bandPoints.map((p) => ({ offset: p.offset, x: p.x, y: p.y }));
    const hoverSnapDist = (() => {
      if (hoverPoints.length < 2) return 120;
      const sorted = [...hoverPoints].sort((a, b) => a.x - b.x);
      let min = Infinity;
      for (let i = 1; i < sorted.length; i++) {
        const dx = sorted[i].x - sorted[i - 1].x;
        if (dx > 0 && dx < min) min = dx;
      }
      if (!Number.isFinite(min) || min <= 0) return 120;
      // Allow hovering anywhere near the closest point; scale with point spacing so sparse charts still hover.
      return Math.max(120, Math.min(240, min * 0.65));
    })();

    return {
      width,
      height,
      padding,
      xForOffset,
      xForOffsetContinuous,
      yFor,
      band50Path: band50PathSafe,
      band80Path: band80PathSafe,
      band90Path: band90PathSafe,
      linePath: linePathSafe,
      lineSegments,
      lineStyleByOffset,
      hasBand,
      hasLine,
      hoverPoints,
      hoverSnapDist,
      xTicks,
      yTicks,
      yForClamped,
      domainMin,
      domainMax,
      offsets,
      medianByOffset
    };
  }, [impactOpen, impactSeries, impactViewport, impactViewportReady]);

  const impactNowMarker = useMemo(() => {
    if (!impactOpen || impactPanel !== "event") return null;
    if (!impactChart?.offsets?.length) return null;
    if (!impactChart?.medianByOffset) return null;

    // Anchor to the nearest scheduled occurrence (display time) so the marker matches the table time display.
    const WINDOW_MS = 24 * 60 * 60 * 1000;
    const candidates: Array<{ ms: number; delta: number }> = [];
    for (const point of points) {
      const t = String(point.time ?? "").trim();
      if (!t || !t.includes(":")) continue;
      const ms = parseDisplayTimeToUtcMs(point.date, t, effectiveCalendarOffsetMinutes);
      if (ms === null) continue;
      const delta = ms - impactNowMs; // + = future
      candidates.push({ ms, delta });
    }
    if (!candidates.length) return null;

    // Prefer the upcoming occurrence within 24h (matches "countdown" expectation).
    const upcoming = candidates
      .filter((c) => c.delta >= 0 && c.delta <= WINDOW_MS)
      .sort((a, b) => a.delta - b.delta)[0];
    const nearest = candidates
      .filter((c) => Math.abs(c.delta) <= WINDOW_MS)
      .sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta))[0];
    const anchor = upcoming ?? nearest;
    if (!anchor) return null;
    const anchorMs = anchor.ms;

    const offsetMinutesRaw = (impactNowMs - anchorMs) / 60_000;
    const minOffset = impactChart.offsets[0] ?? -1440;
    const maxOffset = impactChart.offsets[impactChart.offsets.length - 1] ?? 1440;
    const offsetMinutesClamped = Math.max(minOffset, Math.min(maxOffset, offsetMinutesRaw));

    const x = impactChart.xForOffsetContinuous(offsetMinutesClamped);

    // Interpolate the median between two neighbor offsets when possible.
    const sorted = impactChart.offsets;
    let left = sorted[0];
    let right = sorted[sorted.length - 1];
    for (let i = 1; i < sorted.length; i++) {
      const r = sorted[i];
      if (offsetMinutesClamped <= r) {
        left = sorted[i - 1];
        right = r;
        break;
      }
    }
    const vL = impactChart.medianByOffset.get(left);
    const vR = impactChart.medianByOffset.get(right);
    let median = vL ?? vR ?? 0;
    if (typeof vL === "number" && typeof vR === "number" && right !== left) {
      const t = (offsetMinutesClamped - left) / (right - left);
      median = vL + t * (vR - vL);
    }
    const y = impactChart.yForClamped(median);

    // Label: signed time relative to the next/nearest scheduled occurrence.
    // Future => negative (e.g. -22h 36m), past => positive (e.g. +48m).
    const label = formatTimeOffsetMinutes(offsetMinutesRaw);

    return { x, y, label };
  }, [effectiveCalendarOffsetMinutes, impactChart, impactNowMs, impactOpen, impactPanel, points]);

  useEffect(() => {
    if (!impactOpen || impactPanel !== "event") return;
    if (!impactViewportReady || !impactData?.ok || !impactChart) return;
    setImpactChartAnimKey((key) => key + 1);
  }, [impactBucket, impactChart, impactData?.ok, impactOpen, impactPanel, impactViewportReady]);

  const updateImpactHoverFromPointer = useCallback(
    (target: SVGSVGElement, clientX: number, clientY: number) => {
      if (!impactOpen) return;
      if (impactPanel !== "event") return;
      if (!impactChart?.hoverPoints?.length) return;

      const rect = target.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1) return;
      const xPx = clientX - rect.left;
      const yPx = clientY - rect.top;

      // Only react inside the plot area, otherwise the hover feels jumpy near labels.
      const xSvg = (xPx / rect.width) * impactChart.width;
      const ySvg = (yPx / rect.height) * impactChart.height;
      if (
        xSvg < impactChart.padding.left ||
        xSvg > impactChart.width - impactChart.padding.right ||
        ySvg < impactChart.padding.top ||
        ySvg > impactChart.height - impactChart.padding.bottom
      ) {
        setImpactHoverOffset(null);
        return;
      }

      let best: { offset: number; dist: number } | null = null;
      for (const p of impactChart.hoverPoints) {
        const dx = p.x - xSvg;
        const d = Math.abs(dx);
        if (!best || d < best.dist) best = { offset: p.offset, dist: d };
      }

      // Snap to the closest point along X; if it's too far, clear.
      if (!best || best.dist > (impactChart.hoverSnapDist ?? 120)) {
        setImpactHoverOffset(null);
        return;
      }
      setImpactHoverOffset(best.offset);
    },
    [impactChart, impactOpen, impactPanel]
  );

  const handleImpactMouseMove = useCallback(
    (event: ReactMouseEvent<SVGSVGElement>) => {
      updateImpactHoverFromPointer(event.currentTarget, event.clientX, event.clientY);
    },
    [updateImpactHoverFromPointer]
  );

  const impactHover = useMemo(() => { 
    if (!impactOpen) return null;
    if (impactPanel !== "event") return null;
    if (!impactChart) return null;
    if (impactHoverOffset === null) return null;
    const stats =
      (impactData?.data?.[String(impactHoverOffset)] as EventImpactWindowStats | undefined) ??
      undefined;
    if (!stats || typeof stats.n !== "number" || stats.n <= 0) return null;
    if (typeof stats.best_median_pct !== "number") return null;
    if (!stats.best_direction || typeof stats.best_p !== "number") return null;

    const x = impactChart.xForOffset(impactHoverOffset);
    const y = impactChart.yFor(stats.best_median_pct);
    const leftPct = (x / impactChart.width) * 100;
    const topPct = (y / impactChart.height) * 100;
    const upP = typeof stats.p_up === "number" ? stats.p_up : null;
    const downP = typeof stats.p_down === "number" ? stats.p_down : null;
    const legacyDirMedian = typeof stats.p50 === "number" ? stats.p50 : null;
    // Back-compat: older analysis files don't have up_p50/down_p50; use the legacy direction-median
    // for the best direction so the tooltip doesn't degrade to "-- --".
    const upMove =
      typeof stats.up_p50 === "number"
        ? stats.up_p50
        : stats.best_direction === "up"
          ? legacyDirMedian
          : null;
    const downMove =
      typeof stats.down_p50 === "number"
        ? stats.down_p50
        : stats.best_direction === "down"
          ? legacyDirMedian
          : null;

    return { 
      x, 
      y, 
      leftPct, 
      topPct, 
      offsetLabel: formatTimeOffsetMinutes(impactHoverOffset),
      upP,
      downP,
      upMove,
      downMove
    };
  }, [impactChart, impactData, impactHoverOffset, impactOpen, impactPanel]); 

  // Keep the impact tooltip fully inside the chart body (no clipping at the edges).
  // We measure the actual tooltip width/height and clamp the anchor point accordingly.
  useLayoutEffect(() => {
    if (!impactHover) {
      setImpactTooltipPos(null);
      return;
    }
    const body = impactBodyRef.current;
    const tip = impactTooltipRef.current;
    if (!body || !tip) {
      setImpactTooltipPos({ leftPct: impactHover.leftPct, topPct: impactHover.topPct });
      return;
    }

    const raf = window.requestAnimationFrame(() => {
      const bodyRect = body.getBoundingClientRect();
      const tipRect = tip.getBoundingClientRect();
      if (bodyRect.width <= 1 || bodyRect.height <= 1 || tipRect.width <= 1 || tipRect.height <= 1) {
        setImpactTooltipPos({ leftPct: impactHover.leftPct, topPct: impactHover.topPct });
        return;
      }

      // Convert current % anchor to px in the body box.
      const xPx = (impactHover.leftPct / 100) * bodyRect.width;
      const yPx = (impactHover.topPct / 100) * bodyRect.height;

      const pad = 10;
      const halfW = tipRect.width / 2;
      const liftY = tipRect.height * 1.2; // matches translateY(-120%)

      const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

      const xClamped = clamp(xPx, pad + halfW, bodyRect.width - pad - halfW);
      // Ensure the tooltip (lifted up) doesn't go above the body.
      const yClamped = clamp(yPx, pad + liftY, bodyRect.height - pad);

      setImpactTooltipPos({
        leftPct: (xClamped / bodyRect.width) * 100,
        topPct: (yClamped / bodyRect.height) * 100
      });
    });

    return () => window.cancelAnimationFrame(raf);
  }, [impactHover]);

  const hasVisibleSeries = visibleSeries.actual || visibleSeries.forecast;
  const rangeKeyForView: RangeKey = impactOpen ? "all" : preferredRange;
  const activeRange = useMemo(
    () => resolveRange(rangeKeyForView, points.length),
    [points.length, rangeKeyForView]
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
    // Default to showing all rows in-range. `fitRowCount` is just an optimization to avoid
    // overflow for small ranges; it should never collapse to a single row before measuring.
    const target = Math.min(listPoints.length, activeRange);
    const limit = fitRowCount > 0 ? Math.min(fitRowCount, target) : target;
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
      const maxRows = Math.min(listPoints.length, activeRange);
      const next = Math.max(1, Math.min(maxRows, Math.floor(available / rowHeight)));
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
  }, [activeRange, contentEnterToken, hasMetricValues, isOpen, listPoints.length, selectionLabel]);

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

  // Only close when the pointer press starts AND ends on the backdrop itself.
  // This avoids accidental closes when a drag starts inside the modal and ends outside.
  const backdropPressStartedOnSelfRef = useRef(false);
  const handleBackdropPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    backdropPressStartedOnSelfRef.current = event.target === event.currentTarget;
  }, []);
  const handleBackdropPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const shouldClose =
        backdropPressStartedOnSelfRef.current && event.target === event.currentTarget;
      backdropPressStartedOnSelfRef.current = false;
      if (shouldClose) requestClose();
    },
    [requestClose]
  );
  const handleBackdropPointerCancel = useCallback(() => {
    backdropPressStartedOnSelfRef.current = false;
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase() ?? "";
      if (tag === "input" || tag === "textarea" || target?.isContentEditable) return;

      event.preventDefault();
      if (impactOpen && impactPanel === "deep") {
        setImpactPanel("event");
        return;
      }
      if (impactOpen) {
        setImpactOpen(false);
        return;
      }
      requestClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [impactOpen, impactPanel, isOpen, requestClose]);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) {
        window.clearTimeout(closeTimerRef.current);
      }
      if (impactViewportReadyTimerRef.current !== null) {
        window.clearTimeout(impactViewportReadyTimerRef.current);
        impactViewportReadyTimerRef.current = null;
      }
      impactViewportReadyDeadlineRef.current = null;
      if (impactViewportReadyFallbackRef.current !== null) {
        window.clearTimeout(impactViewportReadyFallbackRef.current);
        impactViewportReadyFallbackRef.current = null;
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
      onPointerDown={handleBackdropPointerDown}
      onPointerUp={handleBackdropPointerUp}
      onPointerCancel={handleBackdropPointerCancel}
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
          <div className="history-modal-header-actions">
            {!loading && !error && hasData ? (
              <div className="history-modal-header-view" role="group" aria-label="View">
                <div
                  className="segmented history-modal-view-toggle"
                  data-qa="qa:history:view-toggle"
                  data-value={impactOpen ? "impact" : "history"}
                  data-count="2"
                >
                  <button
                    type="button"
                    className={`segment${!impactOpen ? " active" : ""}`}
                    onPointerDown={(event) => {
                      if (event.button !== 0) return;
                      // Update the visual state immediately on press (click only fires on release).
                      setImpactOpen(false);
                    }}
                    onClick={() => setImpactOpen(false)}
                    aria-pressed={!impactOpen}
                  >
                    History
                  </button>
                  <button
                    type="button"
                    className={`segment${impactOpen ? " active" : ""}`}
                    onPointerDown={(event) => {
                      if (event.button !== 0) return;
                      // Update the visual state immediately on press (click only fires on release).
                      openImpact();
                    }}
                    onClick={openImpact}
                    aria-pressed={impactOpen}
                  >
                    Impact
                  </button>
                </div>
              </div>
            ) : null}
            {!loading && !error && hasData ? (
              <span className="history-modal-header-divider" aria-hidden="true" />
            ) : null}
            <button
              type="button"
              className="btn ghost history-close"
              onClick={requestClose}
              data-qa="qa:modal-close:history"
              aria-label="Close"
            >
              X
            </button>
          </div>
        </div>
        <div className="modal-body" ref={modalBodyRef}>
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
                <div
                  className={`history-modal-content${
                    impactOpen ? " history-modal-content--impact" : ""
                  }`}
                >
                  <div className="history-modal-controls">
                    <div className="history-modal-controls-left">
                    {!impactOpen && rangeOptions.length ? (
                      <div className="history-modal-control">
                        <span className="history-modal-label">Range</span>
                        <div className="history-modal-toggle" data-qa="qa:history:range">
                          {rangeOptions.map((option) => (
                            <button
                              key={String(option.key)}
                              type="button"
                              className={`history-toggle${activeRange === option.key ? " active" : ""}`}
                              onClick={() => setPreferredRange(option.key)}
                              aria-pressed={activeRange === option.key}
                            >
                              {option.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    {impactOpen && impactPanel === "event" ? (
                      <>
                        <div
                          className="history-impact-buckets"
                          role="group"
                          aria-label="Impact bucket"
                        >
                          {impactBucketOptions.map((option) => (
                            <button
                              key={option.value}
                              type="button"
                              className={`history-toggle impact-toggle impact-bucket-toggle${
                                impactBucket === option.value ? " active" : ""
                              }`}
                              onClick={() => setImpactBucket(option.value as EventImpactBucket)}
                              aria-pressed={impactBucket === option.value}
                              data-bucket={option.value}
                            >
                              {option.label}
                              {typeof option.count === "number" ? (
                                <span className="impact-badge" aria-hidden="true">
                                  {option.count}
                                </span>
                              ) : null}
                            </button>
                          ))}
                        </div>
                      </>
                    ) : null}
                  </div>

                  <div className="history-modal-controls-right">
                    {impactOpen ? (
                      <div className="history-impact-controls" data-qa="qa:history:impact-controls">
                        <div className="history-impact-controls-row">
                          <div
                            className="segmented history-impact-segmented history-impact-panels"
                            role="group"
                            aria-label="Impact panels"
                            data-count="2"
                            data-value={impactPanel}
                          >
                            <button
                              type="button"
                              className={`segment impact-segment${
                                impactPanel === "event" ? " active" : ""
                              }`}
                              onClick={() => setImpactPanel("event")}
                              aria-pressed={impactPanel === "event"}
                            >
                              Event Analysis
                            </button>
                            <button
                              type="button"
                              className={`segment impact-segment${
                                impactPanel === "deep" ? " active" : ""
                              }`}
                              onClick={() => setImpactPanel("deep")}
                              aria-pressed={impactPanel === "deep"}
                            >
                              Deep Analysis
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : hasMetricValues ? (
                      <div className="history-modal-series" aria-label="Series toggles" role="group">
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
                </div>

                <div
                  className={`history-modal-layout${
                    impactOpen ? " history-modal-layout--impact" : ""
                  }`}
                >
                  <div
                    className={`history-modal-layout-left${
                      hasMetricValues ? "" : " history-modal-layout-left--no-chart"
                    }`}
                  >
                    {impactOpen ? ( 
                      <div className="history-impact"> 
                        {impactPanel === "deep" ? (
                          <DeepAnalysisView
                            points={points}
                            metricKey={String(data?.metric ?? "")}
                            cur={String(data?.cur ?? "")}
                            isUsdEvent={isUsdEvent}
                            deepLoading={deepLoading}
                            deepError={deepError}
                            deepData={deepData}
                            impactSeriesItems={impactSeries.items}
                            anchorDtUtc={anchorDtUtc}
                            displayOffsetMinutes={effectiveCalendarOffsetMinutes}
                            selectionImpact={selectionImpact}
                            selectionActual={selectionActual}
                            selectionForecast={selectionForecast}
                            selectionPrevious={selectionPrevious}
                          />
                        ) : (
                          <div className="history-impact-chart" data-qa="qa:history:impact-chart"> 
                            {!impactLoading && !impactError && impactData?.ok && impactChart ? (
                              <div className="impact-chart-header" aria-hidden="true">
                                <div className="impact-chart-meta">
                                  <span className="impact-chart-meta-item">
                                    Line: most likely direction (color) + confidence (thickness)
                                  </span>
                                  <span className="impact-chart-meta-sep">•</span>
                                  <span className="impact-chart-meta-item">
                                    Bands: P25..P75 (dark) + P10..P90 + P05..P95 (light)
                                  </span>
                                  <span className="impact-chart-meta-sep">•</span>
                                  <span className="impact-chart-meta-item">
                                    {impactSamplesLabel ? `N=${impactSamplesLabel}` : "N=--"}
                                  </span>
                                  {impactCoverage ? (
                                    <>
                                      <span className="impact-chart-meta-sep">•</span>
                                      <span className="impact-chart-meta-item">
                                        Coverage: {impactCoverage}
                                      </span>
                                    </>
                                  ) : null}
                                </div>
                              </div>
                            ) : null}
                            <div className="impact-chart-body" ref={impactBodyRef}>
                            {impactError ? (
                              <div className="history-impact-status error">{impactError}</div>
                            ) : impactLoading || !impactData ? (
                              <div className="history-impact-status">Loading impact analysis...</div>
                            ) : !impactData.ok ? (
                              <div className="history-impact-status">
                                Impact analysis not available. Generate it locally first.
                              </div>
                            ) : !impactChart ? (
                              <div className="history-impact-status">Loading impact chart...</div>
                            ) : impactSeries.items.length < 2 ||
                              (!impactChart.hasBand && !impactChart.hasLine) ? (
                              <div className="history-impact-status">
                                Impact analysis is not available for this bucket (insufficient samples).
                              </div>
                            ) : (
                              <>
                                <div
                                  key={`impact-chart-${impactChartAnimKey}`}
                                  className="impact-chart-anim"
                                >
                                  <svg
                                    viewBox={`0 0 ${impactChart.width} ${impactChart.height}`}
                                    className="impact-chart-svg"
                                    role="img"
                                    aria-label="Impact analysis chart"
                                    onMouseMove={handleImpactMouseMove}
                                    onMouseLeave={() => setImpactHoverOffset(null)}
                                    onTouchMove={(event) => {
                                      const touch = event.touches[0];
                                      if (!touch) return;
                                      updateImpactHoverFromPointer(
                                        event.currentTarget,
                                        touch.clientX,
                                        touch.clientY
                                      );
                                    }}
                                    onTouchEnd={() => setImpactHoverOffset(null)}
                                  >
                              <defs>
                                <clipPath id="impact-clip">
                                  <rect
                                    x={impactChart.padding.left}
                                    y={impactChart.padding.top}
                                    width={
                                      impactChart.width -
                                      impactChart.padding.left -
                                      impactChart.padding.right
                                    }
                                    height={
                                      impactChart.height -
                                      impactChart.padding.top -
                                      impactChart.padding.bottom
                                    }
                                  />
                                </clipPath>
                              </defs>
                              <g className="impact-grid">
                                {impactChart.yTicks
                                  .filter((tick) => {
                                    // Avoid a "double thick" bottom line when a tick lands near the axis baseline.
                                    const y = Math.round(impactChart.yForClamped(tick)) + 0.5;
                                    const baseline =
                                      Math.round(impactChart.height - impactChart.padding.bottom) + 0.5;
                                    return Math.abs(y - baseline) > 12;
                                  })
                                  .map((tick) => (
                                    <line
                                      key={`y-${tick}`}
                                      x1={impactChart.padding.left}
                                      x2={impactChart.width - impactChart.padding.right}
                                      y1={Math.round(impactChart.yForClamped(tick)) + 0.5}
                                      y2={Math.round(impactChart.yForClamped(tick)) + 0.5}
                                      vectorEffect="non-scaling-stroke"
                                    />
                                  ))}
                                {impactChart.xTicks.map((tick) => {
                                  const rawX = impactChart.xForOffset(tick);
                                  const snapped = Math.round(rawX) + 0.5;
                                  const minX = impactChart.padding.left + 0.5;
                                  const maxX =
                                    impactChart.width - impactChart.padding.right - 0.5;
                                  const x = Math.max(minX, Math.min(maxX, snapped));
                                  return (
                                    <line
                                      key={`x-${tick}`}
                                      x1={x}
                                      x2={x}
                                      y1={impactChart.padding.top}
                                      y2={impactChart.height - impactChart.padding.bottom}
                                      vectorEffect="non-scaling-stroke"
                                    />
                                  );
                                })}
                              </g>
                              <g className="impact-axis">
                                <line
                                  x1={impactChart.padding.left + 0.5}
                                  x2={impactChart.padding.left + 0.5}
                                  y1={impactChart.padding.top}
                                  y2={impactChart.height - impactChart.padding.bottom}
                                  vectorEffect="non-scaling-stroke"
                                />
                                <line
                                  x1={impactChart.padding.left}
                                  x2={impactChart.width - impactChart.padding.right}
                                  y1={impactChart.height - impactChart.padding.bottom + 0.5}
                                  y2={impactChart.height - impactChart.padding.bottom + 0.5}
                                  vectorEffect="non-scaling-stroke"
                                />
                              </g>
                                <g clipPath="url(#impact-clip)">
                                <g className="impact-band impact-band-90">
                                  {impactChart.band90Path ? (
                                    <path d={impactChart.band90Path} vectorEffect="non-scaling-stroke" />
                                  ) : null}
                                </g>
                                <g className="impact-band impact-band-80">
                                  {impactChart.band80Path ? (
                                    <path d={impactChart.band80Path} vectorEffect="non-scaling-stroke" />
                                  ) : null}
                                </g>
                                <g className="impact-band impact-band-50">
                                  {impactChart.band50Path ? (
                                    <path d={impactChart.band50Path} vectorEffect="non-scaling-stroke" />
                                  ) : null}
                                </g>
                                {impactNowMarker ? (
                                  <g className="impact-now" aria-hidden="true">
                                    <line
                                      className="impact-now-underlay"
                                      x1={Math.round(impactNowMarker.x) + 0.5}
                                      x2={Math.round(impactNowMarker.x) + 0.5}
                                      y1={impactChart.padding.top}
                                      y2={impactChart.height - impactChart.padding.bottom}
                                      vectorEffect="non-scaling-stroke"
                                    />
                                    <line
                                      className="impact-now-line"
                                      x1={Math.round(impactNowMarker.x) + 0.5}
                                      x2={Math.round(impactNowMarker.x) + 0.5}
                                      y1={impactChart.padding.top}
                                      y2={impactChart.height - impactChart.padding.bottom}
                                      vectorEffect="non-scaling-stroke"
                                    />
                                  </g>
                                ) : null}
                                <g className="impact-line">
                                  {impactChart.lineSegments?.length
                                    ? impactChart.lineSegments.map((seg, idx) => (
                                        <path
                                          key={`seg-${idx}`}
                                          d={seg.d}
                                          vectorEffect="non-scaling-stroke"
                                          stroke={seg.stroke}
                                          strokeOpacity={seg.strokeOpacity}
                                          strokeWidth={seg.strokeWidth}
                                        />
                                      ))
                                    : impactChart.linePath
                                      ? (
                                          <path
                                            d={impactChart.linePath}
                                            vectorEffect="non-scaling-stroke"
                                            stroke="#ff8f7b"
                                            strokeOpacity={0.85}
                                            strokeWidth={2}
                                          />
                                        )
                                      : null}
                                </g>
                                {impactHover ? (
                                  <g className="impact-hover" aria-hidden="true">
                                    <line
                                      x1={Math.round(impactHover.x) + 0.5}
                                      x2={Math.round(impactHover.x) + 0.5}
                                      y1={impactChart.padding.top}
                                      y2={impactChart.height - impactChart.padding.bottom}
                                      vectorEffect="non-scaling-stroke"
                                    />
                                  </g>
                                ) : null}
                              </g>
                              <g className="impact-labels">
                                {impactNowMarker ? (
                                  (() => {
                                    const text = impactNowMarker.label;
                                    // Approximate width: 6.6px per char at 10px font-size + padding.
                                    const w = Math.min(
                                      140,
                                      Math.max(44, Math.round(text.length * 6.6 + 18))
                                    );
                                    const h = 18;
                                    const x = impactNowMarker.x;
                                    const y = impactChart.height - impactChart.padding.bottom + 18;
                                    return (
                                      <g className="impact-now-label" aria-hidden="true">
                                        <rect
                                          x={Math.round(x - w / 2)}
                                          y={Math.round(y - h + 4)}
                                          width={w}
                                          height={h}
                                          rx={9}
                                          ry={9}
                                        />
                                        <text x={x} y={y} textAnchor="middle" className="impact-now-tag">
                                          {text}
                                        </text>
                                      </g>
                                    );
                                  })()
                                ) : null}
                                {(() => {
                                  const minGap = 14;
                                  const baseline = impactChart.height - impactChart.padding.bottom + 0.5;
                                  const minY = impactChart.padding.top + 8;
                                  const maxY = baseline - 10;
                                  const candidates = impactChart.yTicks
                                    .map((tick) => ({
                                      tick,
                                      y: impactChart.yFor(tick),
                                      label: formatPct(tick)
                                    }))
                                    .filter((item) => item.y >= minY && item.y <= maxY)
                                    .sort((a, b) => a.y - b.y);
                                  const filtered: Array<{ tick: number; y: number; label: string }> = [];
                                  let lastY = -Infinity;
                                  let lastLabel = "";
                                  for (const item of candidates) {
                                    if (item.y - lastY < minGap) continue;
                                    if (item.label === lastLabel) continue;
                                    filtered.push(item);
                                    lastY = item.y;
                                    lastLabel = item.label;
                                  }
                                  return filtered.map(({ tick, y }) => {
                                    const yText = Math.max(
                                      impactChart.padding.top + 10,
                                      Math.min(baseline - 10, y + 4)
                                    );
                                    return (
                                    <text
                                      key={`yl-${tick}`}
                                      className="impact-y"
                                      x={impactChart.padding.left - 10}
                                      y={yText}
                                      textAnchor="end"
                                    >
                                    {formatPct(tick)}
                                  </text>
                                  );
                                  });
                                })()}
                                {(() => {
                                  // Compute Y positions for the 4 static labels so they don't overlap.
                                  const labelCandidates = impactSeries.items
                                    .map((item) => {
                                      const offset = item.offset;
                                      const stats = item.stats;
                                      if (offset === 0) return null;
                                      if (!IMPACT_LABEL_OFFSETS.includes(offset)) return null;
                                      if (!stats || typeof stats.n !== "number" || stats.n <= 0) return null;
                                      if (typeof stats.best_p !== "number" || !stats.best_direction) return null;

                                      const dirMedian = (() => {
                                        if (stats.best_direction === "up") {
                                          if (typeof stats.up_p50 === "number") return stats.up_p50;
                                        } else if (stats.best_direction === "down") {
                                          if (typeof stats.down_p50 === "number") return stats.down_p50;
                                        }
                                        return typeof stats.best_median_pct === "number"
                                          ? stats.best_median_pct
                                          : 0;
                                      })();
                                      const x = impactChart.xForOffset(offset);
                                      const y = impactChart.yFor(dirMedian);

                                      const absOffset = Math.abs(offset);
                                      const placeBelow = absOffset <= 60;

                                      // Place labels towards the center so they don't get clipped at chart edges.
                                      const leftBound = impactChart.padding.left + 10;
                                      const rightBound = impactChart.width - impactChart.padding.right - 10;
                                      // Keep static labels off the line: pin them to chart edges.
                                      const xText = offset < 0 ? leftBound : rightBound;
                                      const anchor: "start" | "end" = offset < 0 ? "start" : "end";
                                      const direction = stats.best_direction === "up" ? "Up" : "Down";
                                      const pct = `${Math.round(stats.best_p * 100)}%`;
                                      const move = formatPct(dirMedian);
                                      const labelText = `${direction} ${pct} (${move})`;
                                      const labelW = Math.min(
                                        180,
                                        Math.max(72, Math.round(labelText.length * 6.6 + 14))
                                      );

                                      const yBase = (() => {
                                        // Keep labels far enough away that the series line doesn't visually run through
                                        // the glyphs (we don't mask the line behind text).
                                        const dy = placeBelow ? 30 : -24;
                                        const raw = y + dy;
                                        const top = impactChart.padding.top + 14;
                                        const bottom = impactChart.height - impactChart.padding.bottom - 8;
                                        return Math.max(top, Math.min(bottom, raw));
                                      })();

                                      return {
                                        offset,
                                        xPoint: x,
                                        xText,
                                        anchor,
                                        yText: yBase,
                                        yPoint: y,
                                        preferBelow: placeBelow,
                                        labelW
                                      };
                                    })
                                    .filter(Boolean) as {
                                    offset: number;
                                    xPoint: number;
                                    xText: number;
                                    anchor: "start" | "end";
                                    yText: number;
                                    yPoint: number;
                                    preferBelow: boolean;
                                    labelW: number;
                                  }[];

                                  const top = impactChart.padding.top + 14;
                                  const bottom = impactChart.height - impactChart.padding.bottom - 8;

                                  // Build the polyline for the rendered "most likely" line (best_median_pct).
                                  // We use it to place labels so the line never visually runs through glyphs.
                                  const linePoints = impactSeries.items
                                    .map((it) => {
                                      if (it.offset === 0) {
                                        return { x: impactChart.xForOffset(0), y: impactChart.yFor(0) };
                                      }
                                      const s = it.stats;
                                      if (!s || typeof s.best_median_pct !== "number") return null;
                                      return {
                                        x: impactChart.xForOffset(it.offset),
                                        y: impactChart.yFor(s.best_median_pct)
                                      };
                                    })
                                    .filter(Boolean) as Array<{ x: number; y: number }>;

                                  const rectForLabel = (
                                    xText: number,
                                    yText: number,
                                    anchor: "start" | "end",
                                    w: number,
                                    h: number
                                  ) => {
                                    const x0 = anchor === "start" ? xText : xText - w;
                                    const y0 = yText - h + 2;
                                    return { x0, y0, x1: x0 + w, y1: y0 + h };
                                  };

                                  const segsIntersect = (
                                    ax: number,
                                    ay: number,
                                    bx: number,
                                    by: number,
                                    cx: number,
                                    cy: number,
                                    dx: number,
                                    dy: number
                                  ) => {
                                    const orient = (
                                      x1: number,
                                      y1: number,
                                      x2: number,
                                      y2: number,
                                      x3: number,
                                      y3: number
                                    ) => (x2 - x1) * (y3 - y1) - (y2 - y1) * (x3 - x1);
                                    const onSeg = (
                                      x1: number,
                                      y1: number,
                                      x2: number,
                                      y2: number,
                                      x3: number,
                                      y3: number
                                    ) =>
                                      Math.min(x1, x2) - 1e-9 <= x3 &&
                                      x3 <= Math.max(x1, x2) + 1e-9 &&
                                      Math.min(y1, y2) - 1e-9 <= y3 &&
                                      y3 <= Math.max(y1, y2) + 1e-9;
                                    const o1 = orient(ax, ay, bx, by, cx, cy);
                                    const o2 = orient(ax, ay, bx, by, dx, dy);
                                    const o3 = orient(cx, cy, dx, dy, ax, ay);
                                    const o4 = orient(cx, cy, dx, dy, bx, by);
                                    if (o1 === 0 && onSeg(ax, ay, bx, by, cx, cy)) return true;
                                    if (o2 === 0 && onSeg(ax, ay, bx, by, dx, dy)) return true;
                                    if (o3 === 0 && onSeg(cx, cy, dx, dy, ax, ay)) return true;
                                    if (o4 === 0 && onSeg(cx, cy, dx, dy, bx, by)) return true;
                                    return (o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0);
                                  };

                                  const segmentHitsRect = (
                                    ax: number,
                                    ay: number,
                                    bx: number,
                                    by: number,
                                    r: { x0: number; y0: number; x1: number; y1: number }
                                  ) => {
                                    // Quick reject by bbox.
                                    const minX = Math.min(ax, bx);
                                    const maxX = Math.max(ax, bx);
                                    const minY = Math.min(ay, by);
                                    const maxY = Math.max(ay, by);
                                    if (maxX < r.x0 || minX > r.x1 || maxY < r.y0 || minY > r.y1) return false;

                                    const inside =
                                      (ax >= r.x0 && ax <= r.x1 && ay >= r.y0 && ay <= r.y1) ||
                                      (bx >= r.x0 && bx <= r.x1 && by >= r.y0 && by <= r.y1);
                                    if (inside) return true;

                                    return (
                                      segsIntersect(ax, ay, bx, by, r.x0, r.y0, r.x1, r.y0) ||
                                      segsIntersect(ax, ay, bx, by, r.x1, r.y0, r.x1, r.y1) ||
                                      segsIntersect(ax, ay, bx, by, r.x1, r.y1, r.x0, r.y1) ||
                                      segsIntersect(ax, ay, bx, by, r.x0, r.y1, r.x0, r.y0)
                                    );
                                  };

                                  const hitsLine = (r: { x0: number; y0: number; x1: number; y1: number }) => {
                                    // Inflate a bit so the line doesn't graze text.
                                    const pad = 6;
                                    const rr = { x0: r.x0 - pad, y0: r.y0 - pad, x1: r.x1 + pad, y1: r.y1 + pad };
                                    for (let i = 1; i < linePoints.length; i += 1) {
                                      const a = linePoints[i - 1];
                                      const b = linePoints[i];
                                      if (segmentHitsRect(a.x, a.y, b.x, b.y, rr)) return true;
                                    }
                                    return false;
                                  };

                                  // Keep enough baseline spacing so labels never overlap even with ascent/descent.
                                  const minGap = 26;
                                  const distribute = (
                                    group: Array<{
                                      offset: number;
                                      xPoint: number;
                                      xText: number;
                                      anchor: "start" | "end";
                                      yText: number;
                                      yPoint: number;
                                      preferBelow: boolean;
                                      labelW: number;
                                    }>
                                  ) => {
                                    if (!group.length) return;
                                    // Bigger than the text's ascender/descender so the line/band doesn't sit behind text.
                                    const lineGap = 28;
                                    const clamp = (v: number) => Math.max(top, Math.min(bottom, v));
                                    const labelH = 14;
                                    const now = impactNowMarker;
                                    const nowR = 12;

                                    const leftBound = impactChart.padding.left + 10;
                                    const rightBound = impactChart.width - impactChart.padding.right - 10;

                                    const overlapsRect = (
                                      a: { x0: number; y0: number; x1: number; y1: number },
                                      b: { x0: number; y0: number; x1: number; y1: number }
                                    ) =>
                                      a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

                                    const inflate = (
                                      r: { x0: number; y0: number; x1: number; y1: number },
                                      pad: number
                                    ) => ({ x0: r.x0 - pad, y0: r.y0 - pad, x1: r.x1 + pad, y1: r.y1 + pad });

                                    const hitsNow = (r: { x0: number; y0: number; x1: number; y1: number }) => {
                                      if (!now) return false;
                                      const n = { x0: now.x - nowR, y0: now.y - nowR, x1: now.x + nowR, y1: now.y + nowR };
                                      return overlapsRect(r, n);
                                    };

                                    const buildCandidates = (item: (typeof group)[number]) => {
                                      const preferRight = item.offset < 0;
                                      const dxPrimary = preferRight ? [14, 22, 30] : [-14, -22, -30];
                                      const dxFallback = preferRight ? [-14] : [14];
                                      const dyPrimary = item.preferBelow ? [24, 36, 48] : [-20, -32, -44];
                                      const dyFallback = item.preferBelow ? [-20, -32] : [24, 36];

                                      const candidates: Array<{
                                        xText: number;
                                        yText: number;
                                        anchor: "start" | "end";
                                        edgePinned: boolean;
                                        scoreBase: number;
                                      }> = [];

                                      const push = (dx: number, dy: number, edgePinned: boolean) => {
                                        const anchor: "start" | "end" = dx >= 0 ? "start" : "end";
                                        const xText = clamp(item.xPoint + dx, leftBound, rightBound);
                                        const yText = clamp(item.yPoint + dy, top, bottom);
                                        const r = rectForLabel(xText, yText, anchor, item.labelW, labelH);
                                        // Keep fully inside the plot.
                                        if (r.x0 < leftBound || r.x1 > rightBound) return;
                                        if (r.y0 < top || r.y1 > bottom) return;
                                        const dist = Math.abs(dx) * 0.8 + Math.abs(dy) * 1.1;
                                        candidates.push({ xText, yText, anchor, edgePinned, scoreBase: dist });
                                      };

                                      for (const dx of dxPrimary) {
                                        for (const dy of dyPrimary) push(dx, dy, false);
                                      }
                                      for (const dx of dxPrimary) {
                                        for (const dy of dyFallback) push(dx, dy, false);
                                      }
                                      for (const dx of dxFallback) {
                                        for (const dy of dyPrimary) push(dx, dy, false);
                                      }

                                      // Edge pinned fallback (high penalty) if everything else fails.
                                      const xEdge = item.offset < 0 ? leftBound : rightBound;
                                      const edgeAnchor: "start" | "end" = item.offset < 0 ? "start" : "end";
                                      const yEdge = clamp(item.yPoint + (item.preferBelow ? 30 : -24), top, bottom);
                                      candidates.push({ xText: xEdge, yText: yEdge, anchor: edgeAnchor, edgePinned: true, scoreBase: 220 });

                                      // Sort by score, then by how close it stays to the preferred side.
                                      candidates.sort((a, b) => a.scoreBase - b.scoreBase);
                                      return candidates;
                                    };

                                    // Choose a near-by x/y/anchor per label first, then keep adjusting y to avoid collisions.
                                    const placed: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
                                    const order = [...group].sort((a, b) => Math.abs(a.offset) - Math.abs(b.offset));
                                    for (const item of order) {
                                      const cands = buildCandidates(item);
                                      let chosen = cands[0] ?? null;
                                      for (const cand of cands) {
                                        const r = rectForLabel(cand.xText, cand.yText, cand.anchor, item.labelW, labelH);
                                        if (hitsLine(r) || hitsNow(r)) continue;
                                        if (placed.some((p) => overlapsRect(inflate(p, 6), inflate(r, 6)))) continue;
                                        chosen = cand;
                                        break;
                                      }
                                      if (!chosen) continue;
                                      item.xText = chosen.xText;
                                      item.yText = chosen.yText;
                                      item.anchor = chosen.anchor;
                                      placed.push(rectForLabel(item.xText, item.yText, item.anchor, item.labelW, labelH));
                                    }

                                    // Run a couple of iterations: keep away from the line first, then solve overlaps.
                                    for (let iter = 0; iter < 2; iter += 1) {
                                      for (const item of group) {
                                        if (item.preferBelow) {
                                          item.yText = Math.max(item.yText, item.yPoint + lineGap);
                                        } else {
                                          item.yText = Math.min(item.yText, item.yPoint - lineGap);
                                        }
                                        item.yText = clamp(item.yText);

                                        // Ensure the line doesn't run through the label text (dynamic at render-time).
                                        // Search for the *nearest* Y that avoids the line (and live marker), instead of
                                        // repeatedly pushing by a large fixed amount (which can send labels too far).
                                        {
                                          const yTarget = item.yText;
                                          let bestY = item.yText;
                                          let bestPenalty = Number.POSITIVE_INFINITY;

                                          const step = 6;
                                          const maxSteps = 14; // ~84px
                                          const deltas: number[] = [0];
                                          for (let k = 1; k <= maxSteps; k += 1) {
                                            deltas.push(k * step, -k * step);
                                          }

                                          for (const delta of deltas) {
                                            const yCand = clamp(yTarget + delta);
                                            const r = rectForLabel(
                                              item.xText,
                                              yCand,
                                              item.anchor,
                                              item.labelW,
                                              labelH
                                            );
                                            const collidesLine = hitsLine(r);
                                            const collidesNow = now
                                              ? (() => {
                                                  const nx0 = now.x - nowR;
                                                  const nx1 = now.x + nowR;
                                                  const ny0 = now.y - nowR;
                                                  const ny1 = now.y + nowR;
                                                  return r.x0 < nx1 && r.x1 > nx0 && r.y0 < ny1 && r.y1 > ny0;
                                                })()
                                              : false;

                                            // Hard reject collisions first, but keep a best-effort fallback if needed.
                                            const penalty =
                                              (collidesLine ? 1_000_000 : 0) +
                                              (collidesNow ? 1_000_000 : 0) +
                                              Math.abs(delta) +
                                              // Mild preference: keep the label on the intended side of the point.
                                              (item.preferBelow ? Math.max(0, item.yPoint - yCand) : Math.max(0, yCand - item.yPoint)) *
                                                3;

                                            if (penalty < bestPenalty) {
                                              bestPenalty = penalty;
                                              bestY = yCand;
                                              if (!collidesLine && !collidesNow && delta === 0) break;
                                            }
                                          }

                                          item.yText = bestY;
                                        }

                                        // Keep labels away from the live-now dot (even though the dot is rendered above,
                                        // overlap still looks messy).
                                        if (now) {
                                          const x0 =
                                            item.anchor === "start" ? item.xText : item.xText - item.labelW;
                                          const x1 =
                                            item.anchor === "start" ? item.xText + item.labelW : item.xText;
                                          const y0 = item.yText - labelH + 2;
                                          const y1 = item.yText + 2;
                                          const nx0 = now.x - nowR;
                                          const nx1 = now.x + nowR;
                                          const ny0 = now.y - nowR;
                                          const ny1 = now.y + nowR;
                                          const overlaps =
                                            x0 < nx1 && x1 > nx0 && y0 < ny1 && y1 > ny0;
                                          if (overlaps) {
                                            // Push away from the dot.
                                            const push = item.yText <= now.y ? -minGap : minGap;
                                            item.yText = clamp(item.yText + push);
                                          }
                                        }
                                      }

                                      group.sort((a, b) => a.yText - b.yText);
                                      // Forward pass: push down.
                                      for (let i = 1; i < group.length; i += 1) {
                                        const prev = group[i - 1];
                                        const cur = group[i];
                                        if (cur.yText - prev.yText < minGap) {
                                          cur.yText = prev.yText + minGap;
                                        }
                                      }
                                      // Backward pass if we overflow bottom: pull up.
                                      const last = group[group.length - 1];
                                      if (last.yText > bottom) {
                                        last.yText = bottom;
                                        for (let i = group.length - 2; i >= 0; i -= 1) {
                                          const next = group[i + 1];
                                          const cur = group[i];
                                          cur.yText = Math.min(cur.yText, next.yText - minGap);
                                        }
                                      }
                                      // Clamp top.
                                      group[0].yText = Math.max(top, group[0].yText);
                                    }
                                  };

                                  // Solve left/right label stacks separately so they don't push each other around.
                                  const leftLabels = labelCandidates.filter((c) => c.anchor === "start");
                                  const rightLabels = labelCandidates.filter((c) => c.anchor === "end");
                                  distribute(leftLabels);
                                  distribute(rightLabels);

                                  const yByOffset = new Map<number, number>();
                                  const xByOffset = new Map<number, number>();
                                  const anchorByOffset = new Map<number, "start" | "end">();
                                  for (const c of leftLabels) yByOffset.set(c.offset, c.yText);
                                  for (const c of rightLabels) yByOffset.set(c.offset, c.yText);
                                  for (const c of leftLabels) {
                                    xByOffset.set(c.offset, c.xText);
                                    anchorByOffset.set(c.offset, c.anchor);
                                  }
                                  for (const c of rightLabels) {
                                    xByOffset.set(c.offset, c.xText);
                                    anchorByOffset.set(c.offset, c.anchor);
                                  }

                                  return impactSeries.items.map((item) => {
                                    const offset = item.offset;
                                    const stats = item.stats;
                                    if (offset === 0) return null;
                                    if (!stats || typeof stats.n !== "number" || stats.n <= 0) return null;
                                    if (typeof stats.best_p !== "number" || !stats.best_direction) return null;

                                    const showLabel = IMPACT_LABEL_OFFSETS.includes(offset);
                                    const dirMedian = (() => {
                                      if (stats.best_direction === "up") {
                                        if (typeof stats.up_p50 === "number") return stats.up_p50;
                                      } else if (stats.best_direction === "down") {
                                        if (typeof stats.down_p50 === "number") return stats.down_p50;
                                      }
                                      return typeof stats.best_median_pct === "number"
                                        ? stats.best_median_pct
                                        : 0;
                                    })();
                                    const x = impactChart.xForOffset(offset);
                                    const y = impactChart.yFor(dirMedian);
                                    const direction = stats.best_direction === "up" ? "Up" : "Down";
                                    const pct = `${Math.round(stats.best_p * 100)}%`;
                                    const move = formatPct(dirMedian);

                                    const fallbackLeft = impactChart.padding.left + 10;
                                    const fallbackRight = impactChart.width - impactChart.padding.right - 10;
                                    const xText = showLabel
                                      ? xByOffset.get(offset) ?? (offset < 0 ? fallbackLeft : fallbackRight)
                                      : offset < 0 ? fallbackLeft : fallbackRight;
                                    const anchor: "start" | "end" = showLabel
                                      ? anchorByOffset.get(offset) ?? (offset < 0 ? "start" : "end")
                                      : offset < 0 ? "start" : "end";
                                    const yText = showLabel ? yByOffset.get(offset) ?? y : y;

                                    return (
                                      <g key={`label-${offset}`}>
                                        <g clipPath="url(#impact-clip)">
                                          <circle
                                            className={`impact-dot${impactHoverOffset === offset ? " hover" : ""}`}
                                            cx={x}
                                            cy={y}
                                            r={impactHoverOffset === offset ? 4.2 : 3.1}
                                            style={
                                              impactHoverOffset === offset
                                                ? undefined
                                                : impactChart.lineStyleByOffset?.get(offset)
                                                  ? {
                                                      fill: impactChart.lineStyleByOffset.get(offset)?.stroke,
                                                      opacity: impactChart.lineStyleByOffset.get(offset)?.strokeOpacity
                                                    }
                                                  : undefined
                                            }
                                          />
                                        </g>
                                        {showLabel ? (
                                          <>
                                            <text
                                              className="impact-prob"
                                              x={xText}
                                              y={yText}
                                              textAnchor={anchor}
                                            >
                                              {direction} {pct} ({move})
                                            </text>
                                          </>
                                        ) : null}
                                      </g>
                                    );
                                  });
                                })()}
                                {impactChart.xTicks.map((tick) => (
                                  <text
                                    key={`xt-${tick}`}
                                    className="impact-x"
                                    x={impactChart.xForOffset(tick)}
                                    y={impactChart.height - 22}
                                    textAnchor="middle"
                                  >
                                    {formatOffsetLabel(tick)}
                                  </text>
                                ))}
                                <text
                                  className="impact-axis-label"
                                  x={
                                    impactChart.padding.left +
                                    (impactChart.width -
                                      impactChart.padding.left -
                                      impactChart.padding.right) /
                                      2
                                  }
                                  y={impactChart.height - 8}
                                  textAnchor="middle"
                                >
                                  Time offset
                                </text>
                                <text
                                  className="impact-axis-label"
                                  x={14}
                                  y={
                                    impactChart.padding.top +
                                    (impactChart.height -
                                      impactChart.padding.top -
                                      impactChart.padding.bottom) /
                                      2
                                  }
                                  textAnchor="middle"
                                  transform={`rotate(-90 14 ${
                                    impactChart.padding.top +
                                    (impactChart.height -
                                      impactChart.padding.top -
                                      impactChart.padding.bottom) /
                                      2
                                  })`}
                                >
                                  Median % change
                                </text>
                              </g>
                              {impactNowMarker ? (
                                <g clipPath="url(#impact-clip)">
                                  <g className="impact-now" aria-hidden="true">
                                    <circle
                                      className="impact-now-pulse"
                                      cx={impactNowMarker.x}
                                      cy={impactNowMarker.y}
                                      r={9.5}
                                      vectorEffect="non-scaling-stroke"
                                    />
                                    <circle
                                      className="impact-now-core"
                                      cx={impactNowMarker.x}
                                      cy={impactNowMarker.y}
                                      r={4.6}
                                      vectorEffect="non-scaling-stroke"
                                    />
                                  </g>
                                </g>
                              ) : null}
                                  </svg>
                                </div>
                            {impactHover ? ( 
                              <div 
                                className="impact-chart-tooltip" 
                                ref={impactTooltipRef}
                                style={{ 
                                  left: `${(impactTooltipPos ?? impactHover).leftPct}%`, 
                                  top: `${(impactTooltipPos ?? impactHover).topPct}%` 
                                }} 
                              > 
                                <span className="impact-chart-tooltip-offset">{`@${impactHover.offsetLabel}`}</span>
                                <span className="impact-chart-tooltip-sep">•</span>
                                <span className="impact-chart-tooltip-dir">
                                  {`Up ${impactHover.upP === null ? "--" : Math.round(impactHover.upP * 100)}%`}
                                </span>
                                <span className="impact-chart-tooltip-move">
                                  {impactHover.upMove === null ? "--" : formatPct(impactHover.upMove)}
                                </span>
                                <span className="impact-chart-tooltip-sep">•</span>
                                <span className="impact-chart-tooltip-dir">
                                  {`Down ${impactHover.downP === null ? "--" : Math.round(impactHover.downP * 100)}%`}
                                </span>
                                <span className="impact-chart-tooltip-move">
                                  {impactHover.downMove === null ? "--" : formatPct(impactHover.downMove)}
                                </span>
                              </div>
                            ) : null}
                              </>
                            )}
                            </div>
                          </div>
                        )}
                      </div>
                    ) : null}

                    {!impactOpen && hasMetricValues ? (
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
                    {hasNotes && !impactOpen ? (
                      <div className="history-notes-wrap">
                        <div className="history-notes-card" data-qa="qa:history:notes">
                          <div className="history-notes-title">Description</div>
                          <div className="history-notes-text">{eventNotes.note}</div>
                        </div>
                        <div
                          className="history-notes-disclaimer"
                          data-qa="qa:history:disclaimer"
                        >
                          *XAUUSD impact guidance here is based on rule-of-thumb. For statistically
                          backed analysis, please refer to the Impact page.
                        </div>
                      </div>
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
                                  <span
                                    className="history-value-sub placeholder"
                                    aria-hidden="true"
                                  >
                                    {"\u00A0"}
                                  </span>
                                </span>
                                <span className="history-value">
                                  <span className="history-value-main">
                                    {formatDisplayValue(point.forecast)}
                                  </span>
                                  <span
                                    className="history-value-sub placeholder"
                                    aria-hidden="true"
                                  >
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
                                  <span
                                    className="history-value-sub placeholder"
                                    aria-hidden="true"
                                  >
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
                              <span className="disabled">{point.details || "--"}</span>
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
