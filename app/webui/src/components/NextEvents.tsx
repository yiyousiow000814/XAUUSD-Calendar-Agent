import { useEffect, useMemo, useState } from "react";
import type { EventItem } from "../types";
import { Select } from "./Select";
import "./NextEvents.css";

type NextEventsProps = {
  events: EventItem[];
  loading?: boolean;
  currency: string;
  currencyOptions: string[];
  onCurrencyChange: (value: string) => void;
  impactTone: (impact: string) => string;
};

const impactOptions = ["Low", "Medium", "High"];
const impactFilterStorageKey = "xauusd:nextEvents:impactFilter";
const impactShortLabel: Record<string, string> = {
  Low: "L",
  Medium: "M",
  High: "H"
};

const impactHoverLabel: Record<string, string> = {
  Low: "Low Impact",
  Medium: "Medium Impact",
  High: "High Impact"
};

export function NextEvents({
  events,
  loading = false,
  currency,
  currencyOptions,
  onCurrencyChange,
  impactTone
}: NextEventsProps) {
  const [query, setQuery] = useState("");
  const [impactFilter, setImpactFilter] = useState<string[]>(() => {
    try {
      if (typeof window === "undefined") return impactOptions;
      const raw = window.localStorage.getItem(impactFilterStorageKey);
      if (!raw) return impactOptions;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return impactOptions;
      return parsed
        .map((value) => String(value))
        .filter((value) => impactOptions.includes(value));
    } catch {
      return impactOptions;
    }
  });
  const showSkeleton = loading && events.length === 0;

  useEffect(() => {
    try {
      if (typeof window === "undefined") return;
      window.localStorage.setItem(impactFilterStorageKey, JSON.stringify(impactFilter));
    } catch {
      // Ignore storage errors.
    }
  }, [impactFilter]);

  const renderTime = (value: string) => {
    const [datePart, timePart] = value.split(" ");
    return (
      <span className="event-time mono">
        <span className="event-date">{datePart || value}</span>
        {timePart ? <span className="event-clock">{timePart}</span> : null}
      </span>
    );
  };

  const filtered = useMemo(() => {
    const queryValue = query.trim().toLowerCase();
    return events.filter((item) => {
      const impactMatch = impactFilter.length
        ? impactFilter.some((impact) => item.impact.toLowerCase().includes(impact.toLowerCase()))
        : true;
      const queryMatch = queryValue
        ? [item.event, item.cur, item.impact, item.time]
            .join(" ")
            .toLowerCase()
            .includes(queryValue)
        : true;
      return impactMatch && queryMatch;
    });
  }, [events, query, impactFilter]);

  const toggleImpact = (value: string) => {
    setImpactFilter((prev) => {
      if (prev.includes(value)) {
        return prev.filter((item) => item !== value);
      }
      return [...prev, value];
    });
  };

  return (
    <section className="card events-card" data-qa="qa:card:next-events">
      <div className="events-header">
        <div className="events-title">
          <h2>Next Events</h2>
          <span className="hint single-line">Upcoming macro signals</span>
        </div>
        <div className="events-controls">
          <input
            className="search-input"
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search CPI, FOMC, NFP..."
            data-qa="qa:input:search-events"
          />
          <Select
            value={currency}
            options={currencyOptions.map((option) => ({
              value: option,
              label: option
            }))}
            onChange={(value) => onCurrencyChange(value)}
            qa="qa:select:currency"
          />
          <div className="impact-filter" data-qa="qa:filter:impact">
            {impactOptions.map((option) => {
              const tooltipText = impactHoverLabel[option] || `Impact ${option}`;
              const tooltipId = `impact-tooltip-${option.toLowerCase()}`;
              return (
                <button
                  key={option}
                  type="button"
                  className={`impact-toggle${impactFilter.includes(option) ? " active" : ""}`}
                  onClick={() => toggleImpact(option)}
                  aria-label={tooltipText}
                  aria-describedby={tooltipId}
                >
                  <span className={`impact-dot ${impactTone(option)}`} />
                  <span className="impact-label">{impactShortLabel[option] || option}</span>
                  <span className="impact-tooltip" id={tooltipId} role="tooltip">
                    {tooltipText}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
      <div className="events-body">
        <div
          className="events-list"
          data-qa="qa:list:next-events"
          aria-busy={showSkeleton ? true : undefined}
        >
          {showSkeleton ? (
            Array.from({ length: 7 }).map((_, index) => (
              <div
                className="event-row skeleton"
                key={`skeleton-${index}`}
                data-qa="qa:row:next-event:skeleton"
              >
                <span className="event-time mono">
                  <span className="event-date skeleton-block" style={{ width: "72px" }} />
                  <span className="event-clock skeleton-block" style={{ width: "38px" }} />
                </span>
                <div className="event-main">
                  <div className="event-title">
                    <span className="event-impact skeleton-dot" aria-hidden="true" />
                    <span
                      className="event-name skeleton-block"
                      style={{ width: `${52 + (index % 3) * 16}%` }}
                    />
                  </div>
                  <div className="event-meta">
                    <span className="event-cur mono skeleton-block" style={{ width: "34px" }} />
                  </div>
                </div>
                <span className="event-countdown mono align-right skeleton-block" style={{ width: "54px" }} />
              </div>
            ))
          ) : filtered.length === 0 ? (
            <div className="event-row empty" data-qa="qa:row:next-event:empty">
              <span className="event-time mono">--</span>
              <div className="event-main">
                <div className="event-title">
                  <span className="event-name">{loading ? "Loading events…" : "No upcoming events"}</span>
                </div>
                <div className="event-meta">
                  <span className="event-cur">--</span>
                </div>
              </div>
              <span className="event-countdown mono align-right">--</span>
            </div>
          ) : (
            filtered.map((item: EventItem, index) => (
              <div
                className={`event-row ${impactTone(item.impact)}`}
                key={`${item.time}-${index}`}
                data-qa="qa:row:next-event"
              >
                {renderTime(item.time)}
                <div className="event-main">
                  <div className="event-title">
                    <span className="event-impact" aria-hidden="true" />
                    <span className="event-name">{item.event}</span>
                  </div>
                  <div className="event-meta">
                    <span className="event-cur mono">{item.cur}</span>
                  </div>
                </div>
                <span className="event-countdown mono align-right">{item.countdown}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
}
