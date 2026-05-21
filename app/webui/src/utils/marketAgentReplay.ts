import type {
  MarketAgentAlertTimelineItem,
  MarketAgentReplayPayload,
  MarketAgentStateTransition,
  MarketAgentTimelineEvent
} from "../types";

const arrayOrEmpty = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

const relatedAssetsOrEmpty = (value: unknown): MarketAgentReplayPayload["related_assets"] => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([symbol, rows]) => [
      symbol,
      arrayOrEmpty<Record<string, unknown>>(rows)
    ])
  );
};

export const normalizeMarketAgentReplayPayload = (
  payload: Partial<MarketAgentReplayPayload> | null | undefined
): MarketAgentReplayPayload => ({
  price_series: arrayOrEmpty<Record<string, unknown>>(payload?.price_series),
  related_assets: relatedAssetsOrEmpty(payload?.related_assets),
  news_items: arrayOrEmpty<Record<string, unknown>>(payload?.news_items),
  calendar_events: arrayOrEmpty<Record<string, unknown>>(payload?.calendar_events),
  driver_attention_timeline: arrayOrEmpty<Record<string, unknown>>(payload?.driver_attention_timeline),
  timeline_events: arrayOrEmpty<MarketAgentTimelineEvent>(payload?.timeline_events),
  state_transitions: arrayOrEmpty<MarketAgentStateTransition>(payload?.state_transitions),
  alerts: arrayOrEmpty<MarketAgentAlertTimelineItem>(payload?.alerts),
  suppressed_alerts: arrayOrEmpty<MarketAgentAlertTimelineItem>(payload?.suppressed_alerts)
});
