import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { EventItem } from "../types";
import { Select } from "./Select";
import { normalizeAcronyms } from "../utils/normalizeAcronyms";
import "./NextEvents.css";

type NextEventsProps = {
  events: EventItem[];
  loading?: boolean;
  currency: string;
  currencyOptions: string[];
  onCurrencyChange: (value: string) => void;
  impactTone: (impact: string) => string;
  impactFilter: string[];
  onImpactFilterChange: (value: string[]) => void;
  onOpenHistory: (item: EventItem) => void;
};

const impactOptions = ["Low", "Medium", "High"];
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
  impactTone,
  impactFilter,
  onImpactFilterChange,
  onOpenHistory
}: NextEventsProps) {
  const [query, setQuery] = useState("");
  const showSkeleton = loading && events.length === 0;
  const listRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const prevRects = useRef(new Map<string, DOMRect>());
  const prevFilterSignature = useRef("");
  const prevCurrentSignature = useRef("");
  const [pulseGen, setPulseGen] = useState(0);
  const scrollStorageKey = "xauusd:scroll:next-events";

  useEffect(() => {
    const node = listRef.current;
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
    const node = listRef.current;
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

  const getItemKey = (item: EventItem) =>
    item.id || `${item.time}|${item.cur}|${item.impact}|${item.event}`;

  const currentSignature = useMemo(() => {
    const keys = events
      .filter(
        (item) =>
          item.state === "current" || String(item.countdown || "").toLowerCase() === "current"
      )
      .map(getItemKey)
      .sort();
    return keys.join("|");
  }, [events]);

  useLayoutEffect(() => {
    if (prevCurrentSignature.current === currentSignature) return;
    prevCurrentSignature.current = currentSignature;
    // Force a synchronized restart for all Current pulse animations whenever the
    // set of Current items changes (new Current appears / disappears).
    setPulseGen((value) => (value === 0 ? 1 : 0));
  }, [currentSignature]);

  const filterSignature = useMemo(() => {
    const impacts = [...impactFilter].sort().join(",");
    return `${currency}|${impacts}`;
  }, [currency, impactFilter]);

  const parseCountdownMinutes = (value: string) => {
    const text = (value || "").trim().toLowerCase();
    if (!text) return null;
    if (text === "current") return null;

    const hmMatch = text.match(/(\d+)\s*h\s*(\d+)\s*m/);
    if (hmMatch) {
      return Number(hmMatch[1]) * 60 + Number(hmMatch[2]);
    }

    const mMatch = text.match(/(^|\s)(\d+)\s*m($|\s)/);
    if (mMatch) return Number(mMatch[2]);

    return null;
  };

  useLayoutEffect(() => {
    if (showSkeleton) return;
    if (query.trim()) return;
    if (typeof window === "undefined") return;

    const eligibleKeys = new Set<string>();

    // Only animate vertical movement for Current and "about-to-be-current" (<= 1 minute).
    // Everything else should reorder instantly (e.g. impact filter toggles).
    events.forEach((item) => {
      const key = getItemKey(item);
      const isCurrent =
        item.state === "current" || String(item.countdown || "").toLowerCase() === "current";
      if (!isCurrent) return;
      eligibleKeys.add(key);
    });

    events.forEach((item) => {
      const key = getItemKey(item);
      const isCurrent =
        item.state === "current" || String(item.countdown || "").toLowerCase() === "current";
      if (isCurrent) return;

      const minutes = parseCountdownMinutes(item.countdown);
      if (minutes !== null && minutes <= 1 && minutes >= 0) {
        eligibleKeys.add(key);
      }
    });

    const newRects = new Map<string, DOMRect>();

    rowRefs.current.forEach((el, key) => {
      if (!el) return;
      newRects.set(key, el.getBoundingClientRect());
    });

    const prev = prevRects.current;
    prevRects.current = newRects;

    if (prevFilterSignature.current && prevFilterSignature.current !== filterSignature) {
      prevFilterSignature.current = filterSignature;
      return;
    }
    prevFilterSignature.current = filterSignature;

    if (!prev.size || !newRects.size) return;

    newRects.forEach((rect, key) => {
      const prevRect = prev.get(key);
      if (!prevRect) return;
      const dy = prevRect.top - rect.top;
      if (Math.abs(dy) < 1) return;
      if (!eligibleKeys.has(key)) return;

      const el = rowRefs.current.get(key);
      if (!el) return;

      // FLIP: invert, then play (smoothly slide to the new position).
      el.style.transition = "transform 0ms";
      el.style.transform = `translateY(${dy}px)`;
      el.style.willChange = "transform";
      el.dataset.flipAnim = "1";

      window.requestAnimationFrame(() => {
        el.style.transition = "transform var(--motion-med) var(--motion-ease)";
        el.style.transform = "";
        window.setTimeout(() => {
          if (el.style.willChange === "transform") el.style.willChange = "";
          if (el.dataset.flipAnim) delete el.dataset.flipAnim;
        }, 360);
      });
    });
  }, [events, query, showSkeleton, filterSignature]);

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
    // Keep search behavior consistent with what the user sees on screen.
    const queryValue = query.trim().toLowerCase();
    return events.filter((item) => {
      const impactMatch = impactFilter.length
        ? impactFilter.some((impact) => item.impact.toLowerCase().includes(impact.toLowerCase()))
        : true;

      const queryMatch = queryValue
        ? [normalizeAcronyms(item.event), item.cur, item.impact, item.time]
            .join(" ")
            .toLowerCase()
            .includes(queryValue)
        : true;
      return impactMatch && queryMatch;
    });
  }, [events, query, impactFilter]);

  const toggleImpact = (value: string) => {
    if (impactFilter.includes(value)) {
      onImpactFilterChange(impactFilter.filter((item) => item !== value));
      return;
    }
    onImpactFilterChange([...impactFilter, value]);
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
          ref={listRef}
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
                  <span className="event-name">{loading ? "Loading events..." : "No upcoming events"}</span>
                </div>
                <div className="event-meta">
                  <span className="event-cur">--</span>
                </div>
              </div>
              <span className="event-countdown mono align-right">--</span>
            </div>
          ) : (
            filtered.map((item: EventItem) => {
              const key = getItemKey(item);
              const isCurrent = item.state === "current" || item.countdown.toLowerCase() === "current";
              return (
                <div
                  className={`event-row ${impactTone(item.impact)}${isCurrent ? " current" : ""}`}
                  key={key}
                  data-qa="qa:row:next-event"
                  data-qa-row-id={key}
                  data-pulse-gen={isCurrent ? pulseGen : undefined}
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpenHistory(item)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onOpenHistory(item);
                    }
                  }}
                  aria-label={`View history for ${item.cur} ${normalizeAcronyms(item.event)}`}
                  ref={(el) => {
                    if (el) {
                      rowRefs.current.set(key, el);
                      return;
                    }
                    rowRefs.current.delete(key);
                  }}
                >
                  {renderTime(item.time)}
                  <div className="event-main">
                    <div className="event-title">
                      <span className="event-impact" aria-hidden="true" />
                      <span className="event-name">{normalizeAcronyms(item.event)}</span>
                    </div>
                    <div className="event-meta">
                      <span className="event-cur mono">{item.cur}</span>
                    </div>
                  </div>
                  <span
                    className={`event-countdown mono align-right${isCurrent ? " current" : ""}`}
                    data-qa={isCurrent ? "qa:status:current" : undefined}
                  >
                    {isCurrent ? "Current" : item.countdown}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </div>
    </section>
  );
}
