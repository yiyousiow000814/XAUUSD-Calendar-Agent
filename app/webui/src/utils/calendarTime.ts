import type { Settings } from "../types";

export type CalendarTimezoneMode = Settings["calendarTimezoneMode"];

export const getSystemUtcOffsetMinutes = (atMs: number) => {
  try {
    // JS returns "minutes behind UTC" (e.g. UTC+8 => -480). We invert to match our "UTC+X" convention.
    return -new Date(atMs).getTimezoneOffset();
  } catch {
    return 0;
  }
};

export const getEffectiveCalendarUtcOffsetMinutes = ({
  calendarTimezoneMode,
  calendarUtcOffsetMinutes,
  nowMs
}: {
  calendarTimezoneMode: CalendarTimezoneMode;
  calendarUtcOffsetMinutes: number;
  nowMs: number;
}) => {
  if (calendarTimezoneMode === "system") return getSystemUtcOffsetMinutes(nowMs);
  return Number.isFinite(calendarUtcOffsetMinutes) ? calendarUtcOffsetMinutes : 0;
};

export const formatUtcOffset = (offsetMinutes: number) => {
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

export const formatLocalDateTime = (date: Date) => {
  // dd-mm-yyyy HH:mm (local time). Keep consistent across UI logs/tooltips.
  const pad = (value: number) => String(value).padStart(2, "0");
  const dd = pad(date.getDate());
  const mm = pad(date.getMonth() + 1);
  const yyyy = String(date.getFullYear());
  const hh = pad(date.getHours());
  const min = pad(date.getMinutes());
  return `${dd}-${mm}-${yyyy} ${hh}:${min}`;
};

export const parseDisplayTimeToUtcMs = (
  dateIso: string,
  time24h: string,
  displayOffsetMinutes: number
) => {
  // dateIso: YYYY-MM-DD, time24h: HH:mm (as displayed in the UI / selected display timezone)
  // Returns UTC ms so it can be compared with Date.now() regardless of the user's local timezone.
  const [y, m, d] = dateIso.split("-").map((t) => Number(t));
  const [hh, mm] = time24h.split(":").map((t) => Number(t));
  if (![y, m, d, hh, mm].every((v) => Number.isFinite(v))) return null;
  const ms = Date.UTC(y, m - 1, d, hh, mm, 0, 0) - displayOffsetMinutes * 60_000;
  return Number.isFinite(ms) ? ms : null;
};

export const parseDisplayDateTimeToUtcMs = (value: string, displayOffsetMinutes: number) => {
  // value: dd-mm-yyyy HH:mm (as displayed in the UI / selected display timezone)
  const [datePart, timePart] = String(value || "").trim().split(" ");
  if (!datePart) return null;
  const [dd, mm, yyyy] = datePart.split("-").map((t) => Number(t));
  const [hh, min] = timePart ? timePart.split(":").map((t) => Number(t)) : [0, 0];
  if (![dd, mm, yyyy, hh, min].every((v) => Number.isFinite(v))) return null;
  if (!dd || !mm || !yyyy) return null;
  const ms = Date.UTC(yyyy, mm - 1, dd, hh || 0, min || 0, 0, 0) - displayOffsetMinutes * 60_000;
  return Number.isFinite(ms) ? ms : null;
};

export const toDisplayMs = (utcMs: number, displayOffsetMinutes: number) =>
  utcMs + displayOffsetMinutes * 60_000;

export const formatTimeOffsetMinutes = (offsetMinutes: number) => {
  if (!Number.isFinite(offsetMinutes)) return "--";
  if (offsetMinutes === 0) return "0";
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const total = Math.abs(Math.round(offsetMinutes));
  const days = Math.floor(total / (24 * 60));
  const remAfterDays = total % (24 * 60);
  const hours = Math.floor(remAfterDays / 60);
  const minutes = remAfterDays % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (!days && !hours) parts.push(`${minutes}m`);
  if ((days || hours) && minutes) parts.push(`${String(minutes).padStart(2, "0")}m`);
  return `${sign}${parts.join(" ")}`;
};
