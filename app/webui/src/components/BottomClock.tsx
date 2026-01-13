import { useEffect, useMemo, useState } from "react";
import type { Settings } from "../types";
import "./BottomClock.css";

type BottomClockProps = Pick<Settings, "calendarTimezoneMode" | "calendarUtcOffsetMinutes">;

const formatUtcOffset = (offsetMinutes: number) => {
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const minutesAbs = Math.abs(offsetMinutes);
  const hours = Math.floor(minutesAbs / 60);
  const mins = minutesAbs % 60;
  const hourLabel = String(hours).padStart(2, "0");
  if (mins) {
    return `UTC${sign}${hourLabel}:${String(mins).padStart(2, "0")}`;
  }
  return `UTC${sign}${hourLabel}`;
};

export function BottomClock({ calendarTimezoneMode, calendarUtcOffsetMinutes }: BottomClockProps) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const followSystemTimezone = calendarTimezoneMode === "system";
  const effectiveOffsetMinutes = useMemo(() => {
    if (followSystemTimezone) {
      try {
        return -new Date().getTimezoneOffset();
      } catch {
        return 0;
      }
    }
    return Number.isFinite(calendarUtcOffsetMinutes) ? calendarUtcOffsetMinutes : 0;
  }, [calendarUtcOffsetMinutes, followSystemTimezone]);

  useEffect(() => {
    setNowMs(Date.now());
    const interval = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  const { label, timeText } = useMemo(() => {
    const zoneLabel = formatUtcOffset(effectiveOffsetMinutes);

    if (followSystemTimezone) {
      const formatter = new Intl.DateTimeFormat(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
        hour12: false
      });
      return { label: zoneLabel, timeText: formatter.format(new Date(nowMs)) };
    }

    const shifted = new Date(nowMs + effectiveOffsetMinutes * 60_000);
    const formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: "UTC",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      hour12: false
    });
    return { label: zoneLabel, timeText: formatter.format(shifted) };
  }, [effectiveOffsetMinutes, followSystemTimezone, nowMs]);

  return (
    <div
      className="clock-pill"
      data-qa="qa:status:bottom-clock"
      title={followSystemTimezone ? `System time (${label})` : label}
      aria-label={`Current time ${timeText} ${label}`}
    >
      <span className="clock-time">{timeText}</span>
      <span className="clock-zone">{label}</span>
    </div>
  );
}
