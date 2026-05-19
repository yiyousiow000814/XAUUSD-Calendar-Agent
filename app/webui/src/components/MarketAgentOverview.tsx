import type { MarketAgentProviderHealthResponse, MarketAgentSnapshotResponse } from "../types";
import { MarketAgentStatusBadge } from "./MarketAgentStatusBadge";
import "./MarketAgentOverview.css";

type MarketAgentOverviewProps = {
  snapshot: MarketAgentSnapshotResponse | null;
  providerHealth: MarketAgentProviderHealthResponse | null;
};

const formatValue = (value: unknown, fallback = "--") => {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "yes" : "no";
  return fallback;
};

export function MarketAgentOverview({ snapshot, providerHealth }: MarketAgentOverviewProps) {
  const state = snapshot?.state;
  const xauusdHealth = providerHealth?.items?.find((item) => item.provider_key === "xauusd");

  return (
    <section className="market-agent-surface market-agent-overview" data-qa="qa:market-agent:overview">
      <div className="market-agent-surface-header">
        <div>
          <h2>Live Situation</h2>
          <span className="hint">Current thesis, alert state, and data quality</span>
        </div>
        <div className="market-agent-overview-badges">
          <MarketAgentStatusBadge label={formatValue(xauusdHealth?.data_mode, "unavailable")} />
          <MarketAgentStatusBadge label={formatValue(state?.cause_status, "unknown")} />
          <MarketAgentStatusBadge label={formatValue(xauusdHealth?.source_type, "unknown")} tone="info" />
        </div>
      </div>

      {!snapshot?.available ? (
        <div className="market-agent-empty-state">
          {snapshot?.message || "Market agent artifacts are not available yet."}
        </div>
      ) : (
        <>
          <div className="market-agent-overview-grid">
            <div className="market-agent-overview-stat">
              <span className="market-agent-overview-label">Bias</span>
              <strong>{formatValue(state?.current_bias)}</strong>
            </div>
            <div className="market-agent-overview-stat">
              <span className="market-agent-overview-label">Main driver</span>
              <strong>{formatValue(state?.main_driver)}</strong>
            </div>
            <div className="market-agent-overview-stat">
              <span className="market-agent-overview-label">Confidence</span>
              <strong>{formatValue(state?.confidence)}</strong>
            </div>
            <div className="market-agent-overview-stat">
              <span className="market-agent-overview-label">Latest level</span>
              <strong>{formatValue(state?.last_notification_level, "none")}</strong>
            </div>
          </div>

          <div className="market-agent-overview-story">
            <div className="market-agent-overview-story-block">
              <span className="market-agent-overview-label">Current thesis</span>
              <p>{formatValue(state?.last_alert_summary, "No alert summary yet.")}</p>
            </div>
            <div className="market-agent-overview-story-block">
              <span className="market-agent-overview-label">State change reason</span>
              <p>{formatValue(state?.state_change_reason, "No state change reason recorded.")}</p>
            </div>
          </div>

          <div className="market-agent-overview-meta">
            <span>Last analysis: {formatValue(state?.last_analysis_time)}</span>
            <span>Last alert: {formatValue(state?.last_alert_time)}</span>
            <span>
              Source mode: {formatValue(xauusdHealth?.data_mode, "unavailable")} / {formatValue(xauusdHealth?.source_type, "unknown")}
            </span>
          </div>
        </>
      )}
    </section>
  );
}
