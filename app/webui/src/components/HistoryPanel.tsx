import { useMemo, useState } from "react";
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

type HistoryPanelProps = {
  events: PastEventItem[];
  impactTone: (impact: string) => string;
};

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
  return "";
};

const rangeToMs = (range: HistoryRange) => {
  if (range === "48h") return 2 * 24 * 60 * 60 * 1000;
  if (range === "7d") return 7 * 24 * 60 * 60 * 1000;
  if (range === "14d") return 14 * 24 * 60 * 60 * 1000;
  return 30 * 24 * 60 * 60 * 1000;
};

export function HistoryPanel({ events, impactTone }: HistoryPanelProps) {
  const [range, setRange] = useState<HistoryRange>("7d");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const groups = useMemo<HistoryGroup[]>(() => {
    const cutoff = Date.now() - rangeToMs(range);
    const parsed = events
      .map((entry) => ({
        entry,
        date: parseEventDate(entry.time)
      }))
      .filter((item) => item.date && item.date.getTime() >= cutoff) as {
      entry: PastEventItem;
      date: Date;
    }[];

    parsed.sort((a, b) => b.date.getTime() - a.date.getTime());

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

    return Array.from(grouped.values()).sort((a, b) => b.date.getTime() - a.date.getTime());
  }, [events, range]);

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
          <span className="hint single-line">Past events · grouped by day · {range}</span>
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
      <div className="history-body">
        {groups.length === 0 ? (
          <div className="history-empty">No past events yet.</div>
        ) : (
          groups.map((group) => {
            const isCollapsed = collapsed.has(group.key);
            const highCount = group.items.filter((item) =>
              item.impact.toLowerCase().includes("high")
            ).length;
            return (
              <div className="history-group" key={group.key} data-qa="qa:group:history-day">
                <button
                  type="button"
                  className="history-group-header"
                  onClick={() => toggleGroup(group.key)}
                  data-collapsed={isCollapsed}
                >
                  <div>
                    <span className="history-day">{group.label}</span>
                    {group.subLabel ? <span className="history-sub">{group.subLabel}</span> : null}
                  </div>
                  <div className="history-badges">
                    <span className="history-pill">{group.items.length} events</span>
                    <span className="history-pill history-pill-impact" aria-label={`${highCount} high impact`}>
                      <span className="history-pill-dot impact-high" aria-hidden="true" />
                      <span className="history-pill-value">{highCount}</span>
                    </span>
                  </div>
                </button>
                {!isCollapsed && (
                  <div className="history-items">
                    {group.items.map((item, index) => (
                      <div className="history-item history-event" key={`${group.key}-${index}`}>
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
                        <span className="history-event-value mono">
                          {item.actual || item.forecast || item.previous || "—"}
                        </span>
                      </div>
                    ))}
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
