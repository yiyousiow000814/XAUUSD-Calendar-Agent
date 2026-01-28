import { useEffect, useMemo, useRef, useState } from "react";
import type { PastEventItem } from "../types";
import "./HistoryPanel.css";

type HistoryRange = "48h" | "7d" | "14d" | "30d";

type HistoryGroup = {
  key: string;
  label: string;
  subLabel: string;
  date: Date;
  items: PastEventItem[];
};

type HistoryRow =
  | { type: "year"; key: string; year: number }
  | { type: "group"; key: string; group: HistoryGroup };

type HistoryPanelProps = {
  events: PastEventItem[];
  loading?: boolean;
  downloading?: boolean;
  impactTone: (impact: string) => string;
  impactFilter: string[];
  onOpenHistory: (item: PastEventItem) => void;
};

type HistoryTrend = "up" | "flat" | "down" | "tba" | "na";

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

const getTrend = (actual: string, forecast: string, previous: string): HistoryTrend => {
  const actualValue = parseComparableNumber(actual);
  const previousValue = parseComparableNumber(previous);
  if (actualValue !== null && previousValue !== null) {
    if (actualValue > previousValue) return "up";
    if (actualValue < previousValue) return "down";
    return "flat";
  }

  const actualMissing = isMissingValue(actual);
  if (actualMissing) {
    const signalExists = !isMissingValue(forecast) || !isMissingValue(previous);
    return signalExists ? "tba" : "na";
  }

  return "na";
};

const formatTrendLabel = (trend: HistoryTrend) => {
  if (trend === "up") return "Up";
  if (trend === "down") return "Down";
  if (trend === "flat") return "Flat";
  if (trend === "tba") return "TBA";
  return "Not available";
};

function TrendIcon({ trend }: { trend: Exclude<HistoryTrend, "tba"> }) {
  const strokeWidth = 1.85;
  if (trend === "flat") {
    return (
      <svg
        className="history-trend-icon"
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M3.25 8H12.2M12.2 8L9.8 5.6M12.2 8L9.8 10.4"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (trend === "up") {
    return (
      <svg
        className="history-trend-icon"
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M3.5 11.9L12.2 3.8M12.2 3.8V7.05M12.2 3.8H8.95"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (trend === "na") {
    return null;
  }

  return (
    <svg
      className="history-trend-icon"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M3.5 4.1L12.2 12.2M12.2 12.2V8.95M12.2 12.2H8.95"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const parseEventDate = (value: string) => {
  const [datePart, timePart] = value.split(" ");
  if (!datePart) return null;
  const [day, month, year] = datePart.split("-").map((part) => Number(part));
  const [hour, minute] = timePart ? timePart.split(":").map((part) => Number(part)) : [0, 0];
  if (!day || !month || !year) return null;
  return new Date(year, month - 1, day, hour || 0, minute || 0);
};

const formatDayLabel = (date: Date) =>
  new Intl.DateTimeFormat("en", { weekday: "short", day: "2-digit", month: "short" }).format(
    date
  );

const getRelativeLabel = (date: Date) => {
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.floor((startOfToday.getTime() - startOfDay.getTime()) / 86400000);
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays <= 7) return "Last week";
  if (diffDays <= 14) return "2 weeks ago";
  if (diffDays <= 21) return "3 weeks ago";
  if (diffDays <= 28) return "4 weeks ago";
  return "";
};

const rangeToMs = (range: HistoryRange) => {
  if (range === "48h") return 2 * 24 * 60 * 60 * 1000;
  if (range === "7d") return 7 * 24 * 60 * 60 * 1000;
  if (range === "14d") return 14 * 24 * 60 * 60 * 1000;
  return 30 * 24 * 60 * 60 * 1000;
};

export function HistoryPanel({
  events,
  loading = false,
  downloading = false,
  impactTone,
  impactFilter,
  onOpenHistory
}: HistoryPanelProps) {
  const rangeStorageKey = "xauusd:history:range";
  const scrollStorageKey = "xauusd:scroll:history";
  const [range, setRange] = useState<HistoryRange>(() => {
    try {
      const raw = window.localStorage.getItem(rangeStorageKey);
      if (raw === "48h" || raw === "7d" || raw === "14d" || raw === "30d") {
        return raw;
      }
    } catch {
      // Ignore storage errors.
    }
    return "7d";
  });
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const showSkeleton = loading && events.length === 0;

  useEffect(() => {
    try {
      window.localStorage.setItem(rangeStorageKey, range);
    } catch {
      // Ignore storage errors.
    }
  }, [range]);

  useEffect(() => {
    const node = bodyRef.current;
    if (!node) return;
    try {
      const raw = window.localStorage.getItem(scrollStorageKey);
      const value = raw ? Number(raw) : 0;
      if (Number.isFinite(value) && value > 0) {
        node.scrollTop = value;
      }
    } catch {
      // Ignore storage errors.
    }
  }, []);

  useEffect(() => {
    const node = bodyRef.current;
    if (!node) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        try {
          window.localStorage.setItem(scrollStorageKey, String(node.scrollTop));
        } catch {
          // Ignore storage errors.
        }
      });
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      node.removeEventListener("scroll", onScroll);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, []);

  const view = useMemo(() => {
    const cutoff = Date.now() - rangeToMs(range);
    const normalizedImpactFilter = impactFilter.map((value) => value.toLowerCase());
    const parsed = events
      .map((entry) => ({
        entry,
        date: parseEventDate(entry.time)
      }))
      .filter((item) => {
        if (!item.date || item.date.getTime() < cutoff) return false;
        if (normalizedImpactFilter.length === 0) return true;
        const impact = item.entry.impact.toLowerCase();
        return normalizedImpactFilter.some((selected) => impact.includes(selected));
      }) as {
      entry: PastEventItem;
      date: Date;
    }[];

    parsed.sort((a, b) => b.date.getTime() - a.date.getTime());

    const includeYear = new Set(parsed.map((item) => item.date.getFullYear())).size > 1;
    const grouped = new Map<string, HistoryGroup>();
    parsed.forEach(({ entry, date }) => {
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
        date.getDate()
      ).padStart(2, "0")}`;
      if (!grouped.has(key)) {
        grouped.set(key, {
          key,
          label: formatDayLabel(date),
          subLabel: getRelativeLabel(date),
          date,
          items: []
        });
      }
      grouped.get(key)?.items.push(entry);
    });

    const groups = Array.from(grouped.values()).sort((a, b) => b.date.getTime() - a.date.getTime());
    const rows: HistoryRow[] = [];
    if (includeYear) {
      let currentYear: number | null = null;
      groups.forEach((group) => {
        const year = group.date.getFullYear();
        if (year !== currentYear) {
          currentYear = year;
          rows.push({ type: "year", key: `year-${year}`, year });
        }
        rows.push({ type: "group", key: `group-${group.key}`, group });
      });
    } else {
      groups.forEach((group) => rows.push({ type: "group", key: `group-${group.key}`, group }));
    }
    return { groups, rows };
  }, [events, range, impactFilter]);
  const groups = view.groups;
  const rows = view.rows;

  const toggleGroup = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const expandAll = () => setCollapsed(new Set());
  const collapseAll = () => setCollapsed(new Set(groups.map((group) => group.key)));

  return (
    <section className="card history-card" data-qa="qa:card:history">
      <div className="history-header">
        <div className="history-title">
          <h2>History</h2>
          <span className="hint single-line">Past events - grouped by day - {range}</span>
        </div>
        <div className="history-controls">
          <div
            className="segmented history-range"
            data-count="4"
            data-value={range}
            data-qa="qa:control:history-range"
          >
            {(["48h", "7d", "14d", "30d"] as HistoryRange[]).map((value) => (
              <button
                type="button"
                key={value}
                className={`segment${range === value ? " active" : ""}`}
                onClick={() => setRange(value)}
              >
                {value}
              </button>
            ))}
          </div>
          <div className="history-actions">
            <button
              className="btn ghost btn-compact"
              onClick={expandAll}
              data-qa="qa:action:history-expand"
            >
              Expand
            </button>
            <button
              className="btn ghost btn-compact"
              onClick={collapseAll}
              data-qa="qa:action:history-collapse"
            >
              Collapse
            </button>
          </div>
        </div>
      </div>
      <div className="history-body" ref={bodyRef}>
        {showSkeleton ? (
          <div className="history-skeleton" data-qa="qa:history:skeleton" aria-busy="true">
            {Array.from({ length: 2 }).map((_, groupIndex) => (
              <div className="history-group history-skeleton-group" key={`skeleton-group-${groupIndex}`}>
                <div className="history-group-header history-skeleton-header">
                  <div className="history-skeleton-lines">
                    <span className="history-skeleton-line" style={{ width: "110px" }} />
                    <span className="history-skeleton-line" style={{ width: "70px" }} />
                  </div>
                  <div className="history-badges">
                    <span className="history-pill history-skeleton-pill" style={{ width: "88px" }} />
                    <span className="history-pill history-pill-impact history-skeleton-pill" style={{ width: "44px" }} />
                  </div>
                </div>
                <div className="history-items">
                  {Array.from({ length: 5 }).map((__, index) => (
                    <div
                      className="history-item history-event history-skeleton-item"
                      key={`skeleton-item-${groupIndex}-${index}`}
                    >
                      <span className="history-time mono history-skeleton-line" style={{ width: "44px" }} />
                      <span className="history-impact" aria-hidden="true">
                        <span className="history-impact-dot history-skeleton-dot" />
                      </span>
                      <span className="history-event-name">
                        <span className="history-event-cur mono history-skeleton-line" style={{ width: "34px" }} />
                        <span
                          className="history-event-title history-skeleton-line"
                          style={{ width: `${46 + (index % 3) * 16}%` }}
                        />
                      </span>
                      <span className="history-trend history-trend-tba history-skeleton-pill" style={{ width: "50px" }} />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : groups.length === 0 ? (
          <div className="history-empty">
            {loading
              ? "Loading history..."
              : "No past events yet."}
          </div>
        ) : (
          rows.map((row) => {
            if (row.type === "year") {
              return (
                <div className="history-year" key={row.key} data-qa="qa:separator:history-year">
                  {row.year}
                </div>
              );
            }

            const group = row.group;
            const isCollapsed = collapsed.has(group.key);
            const highCount = group.items.filter((item) =>
              item.impact.toLowerCase().includes("high")
            ).length;
            return (
              <div className="history-group" key={row.key} data-qa="qa:group:history-day">
                <button
                  type="button"
                  className="history-group-header"
                  onClick={() => toggleGroup(group.key)}
                  data-collapsed={isCollapsed}
                >
                  <div className="history-group-meta">
                    <span className="history-day">{group.label}</span>
                    {group.subLabel ? <span className="history-sub">{group.subLabel}</span> : null}
                  </div>
                  <div className="history-badges">
                    <span className="history-pill">{group.items.length} events</span>
                    <span
                      className="history-pill history-pill-impact"
                      aria-label={`${highCount} high impact`}
                    >
                      <span className="history-pill-dot impact-high" aria-hidden="true" />
                      <span className="history-pill-value">{highCount}</span>
                    </span>
                  </div>
                </button>
                {!isCollapsed && (
                  <div className="history-items">
                    {group.items.map((item, index) => {
                      const trend = getTrend(item.actual, item.forecast, item.previous);
                      const trendText = formatTrendLabel(trend);
                      const title =
                        trend === "tba"
                          ? "Actual: TBA"
                          : trend === "na"
                            ? "Actual: -"
                            : `Actual trend: ${trendText}`;

                      return (
                      <div
                        className="history-item history-event"
                        key={`${group.key}-${index}`}
                        role="button"
                        tabIndex={0}
                        onClick={() => onOpenHistory(item)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            onOpenHistory(item);
                          }
                        }}
                        aria-label={`View history for ${item.cur} ${item.event}`}
                      >
                          <span className="history-time mono">
                            {item.time.split(" ")[1] || item.time}
                          </span>
                          <span className="history-impact" aria-label={item.impact}>
                            <span className={`history-impact-dot ${impactTone(item.impact)}`} />
                          </span>
                          <span className="history-event-name">
                            <span className="history-event-cur mono">{item.cur}</span>
                            <span className="history-event-title">{item.event}</span>
                          </span>
                          <span
                            className={`history-trend history-trend-${trend}`}
                            aria-label={
                              trend === "na" ? "Actual: not available" : `Actual trend: ${trendText}`
                            }
                            title={title}
                          >
                            {trend === "tba" ? <span className="history-trend-label">TBA</span> : null}
                            {trend === "na" ? <span className="history-trend-label">-</span> : null}
                            {trend !== "tba" && trend !== "na" ? <TrendIcon trend={trend} /> : null}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
