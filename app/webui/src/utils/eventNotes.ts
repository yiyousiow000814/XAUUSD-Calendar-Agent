import type { EventHistoryResponse } from "../types";
import eventNotes from "../data/event_notes.json";

type EventNotes = {
  note: string;
};

type EventNoteEntry = {
  note: string;
};

const EVENT_NOTES = eventNotes as Record<string, EventNoteEntry>;

const FREQUENCY_ALIASES: Record<string, string> = {
  "m/m": "m/m",
  "mom": "m/m",
  "y/y": "y/y",
  "yoy": "y/y",
  "q/q": "q/q",
  "qoq": "q/q",
  "w/w": "w/w",
  "wow": "w/w"
};

const extractFrequency = (value: string) => {
  const match =
    value.match(/\((m\/m|y\/y|q\/q|w\/w|mom|yoy|qoq|wow)\)/i) ||
    value.match(/\b(m\/m|y\/y|q\/q|w\/w|mom|yoy|qoq|wow)\b/i);
  if (!match) return "none";
  return FREQUENCY_ALIASES[match[1].toLowerCase()] ?? "none";
};

const stripFrequencyTokens = (value: string) =>
  value
    .replace(/\((m\/m|y\/y|q\/q|w\/w|mom|yoy|qoq|wow)\)/gi, " ")
    .replace(/\b(m\/m|y\/y|q\/q|w\/w|mom|yoy|qoq|wow)\b/gi, " ");

const normalizeMetric = (value: string) =>
  stripFrequencyTokens(value)
    .replace(/[^\w\s/-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const resolveEventIdFromLabel = (selectionLabel: string) => {
  const trimmed = selectionLabel.trim();
  if (!trimmed) return "";
  const parts = trimmed.split(/\s+/);
  const cur = (parts.shift() || "").trim();
  if (!/^[A-Z]{3}$/.test(cur)) return "";
  const metricRaw = parts.join(" ").trim();
  if (!metricRaw) return "";
  const frequency = extractFrequency(metricRaw);
  const metric = normalizeMetric(metricRaw);
  if (!metric) return "";
  const candidates = frequency === "none"
    ? [`${cur}::${metric}::none`]
    : [`${cur}::${metric}::${frequency}`, `${cur}::${metric}::none`];
  return candidates.find((id) => EVENT_NOTES[id]?.note) ?? "";
};

export const buildEventNotes = (
  selectionLabel: string,
  data: EventHistoryResponse | null
): EventNotes => {
  const eventId = data?.eventId ?? "";
  const entry = eventId ? EVENT_NOTES[eventId] : null;
  if (entry?.note) {
    return { note: entry.note };
  }
  const fallbackId = resolveEventIdFromLabel(selectionLabel);
  if (fallbackId) {
    return { note: EVENT_NOTES[fallbackId]?.note ?? "" };
  }
  return { note: "" };
};
