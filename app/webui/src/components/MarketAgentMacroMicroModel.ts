import type {
  MarketAgentDriverAttentionResponse,
  MarketAgentEvidenceForRunResponse
} from "../types";
import {
  formatDriverLabel,
  humanizeMarketAgentValue,
  normalizeMarketAgentValue
} from "../utils/marketAgentUi";

export type MarketAgentMacroMicroTone = "good" | "warn" | "bad" | "neutral" | "info";

export type MarketAgentDriverRow = {
  id: string;
  label: string;
  status: string;
  tone: MarketAgentMacroMicroTone;
  detail: string;
  meta: string;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const asRecordList = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(asRecord(item))) : [];

const asStringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((item) => String(item ?? "").trim()).filter(Boolean) : [];

const textValue = (value: unknown, fallback = "") => {
  const text = String(value ?? "").trim();
  return text || fallback;
};

const numberValue = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const firstEvidenceRefTitle = (value: unknown) => {
  const refs = asRecordList(value);
  for (const ref of refs) {
    const title = textValue(ref.title);
    if (title) return title;
  }
  return "";
};

const shortDetail = (value: unknown, fallback = "") => {
  const text = textValue(value, fallback);
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
};

const isCountOnlyThemeDetail = (value: string) => {
  const normalized = normalizeMarketAgentValue(value);
  return /^(\d+_)?headline_s?_from_\d+_source_s?/.test(normalized) || normalized.includes("no_cross_asset_confirmation_yet");
};

export const isUsefulMarketStoryDetail = (row: MarketAgentDriverRow) => {
  const detail = normalizeMarketAgentValue(row.detail);
  const meta = normalizeMarketAgentValue(row.meta);
  if (!detail || detail.includes("no_detail_recorded") || detail.includes("no_linked_headline_yet")) return false;
  if (meta.includes("0_news") && meta.includes("0_calendar")) return false;
  if (
    [
      "driver_is_monitored_but_not_yet_causal",
      "no_timestamped_geopolitical_headline",
      "no_direct_fed_headline",
      "background_only",
      "lacks_a_fresh_confirming_channel",
      "not_fresh_and_confirming",
      "attention_is_not_active",
      "evidence_gate",
      "current_conclusion_is_paused",
      "current_driver_conclusions_are_paused",
      "theme_is_watched_as_context",
      "confirmation_is_missing",
      "confirmation_missing",
      "confirmation_is_stale",
      "cannot_confirm",
      "does_not_confirm",
      "is_stale",
      "stale",
      "incomplete",
      "waiting_for_market_confirmation"
    ].some((needle) => detail.includes(needle) || meta.includes(needle))
  ) {
    return false;
  }
  if (isCountOnlyThemeDetail(row.detail)) return false;
  return true;
};

export const isFormalMarketMacroResult = (row: MarketAgentDriverRow) => {
  const status = normalizeMarketAgentValue(row.status);
  if (["blocked", "watching", "emerging", "dormant", "cooling", "missing", "unavailable"].includes(status)) {
    return false;
  }
  return isUsefulMarketStoryDetail(row);
};

export const isFormalMarketMicroTheme = (row: MarketAgentDriverRow) => {
  const meta = normalizeMarketAgentValue(row.meta);
  const detail = normalizeMarketAgentValue(row.detail);
  return (
    (meta.includes("news") || meta.includes("sources") || detail.includes("headline")) &&
    !detail.includes("no_micro_themes") &&
    !detail.includes("not_yet_causal") &&
    isUsefulMarketStoryDetail(row)
  );
};

const statusTone = (status: string): MarketAgentMacroMicroTone => {
  const normalized = normalizeMarketAgentValue(status);
  if (["accepted", "allowed", "ready", "reviewed", "live", "active"].some((word) => normalized.includes(word))) return "good";
  if (["blocked", "missing", "unavailable", "gap", "stale", "paused"].some((word) => normalized.includes(word))) return "bad";
  if (["watching", "emerging", "context", "mixed"].some((word) => normalized.includes(word))) return "warn";
  if (["validated", "recorded"].some((word) => normalized.includes(word))) return "info";
  return "neutral";
};

const stateById = (driverAttention: MarketAgentDriverAttentionResponse | null) => {
  const map = new Map<string, MarketAgentDriverAttentionResponse["states"][number]>();
  (driverAttention?.states ?? []).forEach((state) => {
    map.set(normalizeMarketAgentValue(state.driver_id), state);
  });
  return map;
};

export const buildMarketAgentMacroDrivers = (
  selectedEvidence: MarketAgentEvidenceForRunResponse | null,
  driverAttention: MarketAgentDriverAttentionResponse | null,
  limit = 4
): MarketAgentDriverRow[] => {
  const packet = asRecord(selectedEvidence?.payload?.evidence_packet);
  const allowed = new Set(asStringList(packet?.allowed_candidate_drivers).map(normalizeMarketAgentValue));
  const blocked = asRecord(packet?.blocked_drivers) ?? {};
  const blockedIds = Object.keys(blocked).map(normalizeMarketAgentValue);
  const states = stateById(driverAttention);
  const stateIds = Array.from(states.entries())
    .filter(([id, state]) => {
      if (id.startsWith("theme:")) return false;
      const normalized = normalizeMarketAgentValue(state.current_state);
      if (["active", "active_macro", "watching", "emerging", "cooling", "faded"].includes(normalized)) return true;
      return (state.relevance_score ?? 0) > 0;
    })
    .map(([id]) => id);
  const ids = Array.from(new Set([...Array.from(allowed), ...blockedIds, ...stateIds]))
    .filter((id) => id && id !== "unknown")
    .sort((left, right) => {
      const leftAllowed = allowed.has(left) ? 0 : 1;
      const rightAllowed = allowed.has(right) ? 0 : 1;
      if (leftAllowed !== rightAllowed) return leftAllowed - rightAllowed;
      const leftBlocked = blockedIds.includes(left) ? 0 : 1;
      const rightBlocked = blockedIds.includes(right) ? 0 : 1;
      if (leftBlocked !== rightBlocked) return leftBlocked - rightBlocked;
      return (states.get(right)?.relevance_score ?? 0) - (states.get(left)?.relevance_score ?? 0);
    });

  return ids.slice(0, limit).map((id) => {
    const state = states.get(id);
    const status = allowed.has(id) ? "Accepted" : blocked[id] ? "Blocked" : humanizeMarketAgentValue(state?.current_state, "Watching");
    const evidenceTitle = firstEvidenceRefTitle(state?.evidence_refs);
    const stateDetail =
      evidenceTitle ||
      state?.current_evidence_summary ||
      state?.activation_reason ||
      state?.deactivation_reason ||
      "Driver is monitored but not yet causal.";
    const detail = blocked[id] ?? stateDetail;
    const relatedNews = numberValue(state?.related_news_count);
    const relatedCalendar = numberValue(state?.related_calendar_events);
    const meta = [
      relatedNews === null ? "" : `${relatedNews} news`,
      relatedCalendar === null ? "" : `${relatedCalendar} calendar`,
      state?.confidence ? humanizeMarketAgentValue(state.confidence) : ""
    ].filter(Boolean).join(" / ");
    return {
      id,
      label: state?.label || formatDriverLabel(id),
      status,
      tone: statusTone(status),
      detail: shortDetail(detail),
      meta: meta || "Evidence gate"
    };
  });
};

export const buildMarketAgentMicroThemes = (
  selectedEvidence: MarketAgentEvidenceForRunResponse | null,
  driverAttention: MarketAgentDriverAttentionResponse | null,
  limit = 3
): MarketAgentDriverRow[] => {
  const packet = asRecord(selectedEvidence?.payload?.evidence_packet);
  const packetThemes = asRecordList(packet?.dynamic_themes);
  const attentionThemes = (driverAttention?.states ?? [])
    .filter((state) => normalizeMarketAgentValue(state.driver_id).startsWith("theme:"))
    .map((state) => state as unknown as Record<string, unknown>);
  const themeMap = new Map<string, Record<string, unknown>>();
  [...attentionThemes, ...packetThemes].forEach((theme) => {
    const id = normalizeMarketAgentValue(theme.driver_id);
    if (!id || normalizeMarketAgentValue(theme.current_state) === "retired") return;
    themeMap.set(id, { ...(themeMap.get(id) ?? {}), ...theme });
  });
  return Array.from(themeMap.entries())
    .sort(([, left], [, right]) => (numberValue(right.relevance_score) ?? 0) - (numberValue(left.relevance_score) ?? 0))
    .slice(0, limit)
    .map(([id, theme]) => {
      const status = humanizeMarketAgentValue(theme.current_state, "Watching");
      const evidenceTitle = firstEvidenceRefTitle(theme.evidence_refs);
      const detail =
        evidenceTitle ||
        textValue(theme.current_evidence_summary) ||
        textValue(theme.current_counter_evidence) ||
        textValue(theme.activation_reason) ||
        "Theme is watched as context until market confirmation appears.";
      const relatedNews = numberValue(theme.related_news_count);
      const sourceCount = numberValue(theme.source_count);
      const requested = asStringList(theme.requested_sensor_ids);
      const meta = [
        relatedNews === null ? "" : `${relatedNews} news`,
        sourceCount === null ? "" : `${sourceCount} sources`,
        requested.length ? `needs ${requested.join(", ")}` : ""
      ].filter(Boolean).join(" / ");
      return {
        id,
        label: textValue(theme.label, formatDriverLabel(id.replace(/^theme:/, ""))),
        status,
        tone: statusTone(status),
        detail: shortDetail(detail),
        meta: meta || "Theme discovery"
      };
    });
};
