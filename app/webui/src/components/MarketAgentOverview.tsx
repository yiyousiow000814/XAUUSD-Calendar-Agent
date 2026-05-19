import type { MarketAgentProviderHealthResponse, MarketAgentSnapshotResponse } from "../types";
import { MarketAgentStatusBadge } from "./MarketAgentStatusBadge";
import {
  buildSituationSummary,
  findProviderHealth,
  formatDriverLabel,
  formatShortTime,
  humanizeMarketAgentReason,
  humanizeMarketAgentValue,
  normalizeMarketAgentValue,
  providerGuidance
} from "../utils/marketAgentUi";
import "./MarketAgentOverview.css";

type MarketAgentOverviewProps = {
  snapshot: MarketAgentSnapshotResponse | null;
  providerHealth: MarketAgentProviderHealthResponse | null;
};

const formatValue = (value: unknown, fallback = "--") => {
  if (typeof value === "string" && value.trim()) return humanizeMarketAgentValue(value, fallback);
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return fallback;
};

export function MarketAgentOverview({ snapshot, providerHealth }: MarketAgentOverviewProps) {
  const state = snapshot?.state;
  const xauusdHealth = findProviderHealth(providerHealth?.items, ["xauusd", "gc=f", "xauusd price"]);
  const sourceType = normalizeMarketAgentValue(xauusdHealth?.source_type);
  const dataMode = normalizeMarketAgentValue(xauusdHealth?.data_mode);
  const showProxyWarning = sourceType === "futures_proxy" || dataMode === "proxy";
  const showCsvWarning = sourceType === "local_csv_fallback" || dataMode === "local_csv_fallback";
  const summary = buildSituationSummary(snapshot, xauusdHealth);

  return (
    <section className="market-agent-surface market-agent-overview" data-qa="qa:market-agent:overview">
      <div className="market-agent-surface-header">
        <div>
          <h2>Current Situation</h2>
          <span className="hint">What the agent thinks is happening now</span>
        </div>
        <div className="market-agent-overview-badges">
          <MarketAgentStatusBadge label={formatValue(xauusdHealth?.data_mode, "unavailable")} />
          <MarketAgentStatusBadge label={formatValue(state?.cause_status, "unknown")} />
          <MarketAgentStatusBadge label={formatValue(xauusdHealth?.source_type, "unknown")} tone="info" />
        </div>
      </div>

      {!snapshot?.available ? (
        <div className="market-agent-empty-state market-agent-empty-guided">
          <strong>Market Agent has not run yet.</strong>
          <p>{snapshot?.message || "Run monitor once, start the monitor loop, or configure data sources to begin collecting replay data."}</p>
          <div className="market-agent-empty-actions">
            <span>Run monitor once</span>
            <span>Start monitor loop</span>
            <span>Configure data sources</span>
            <span>View setup docs</span>
          </div>
        </div>
      ) : (
        <>
          <div className="market-agent-situation-callout">
            <p>{summary}</p>
            <span>{providerGuidance(xauusdHealth)}</span>
          </div>

          {showCsvWarning ? (
            <div className="market-agent-source-warning" data-qa="qa:market-agent:csv-warning">
              Using local CSV fallback. Configure cTrader or Yahoo provider for live monitoring.
            </div>
          ) : null}
          {showProxyWarning ? (
            <div className="market-agent-source-warning proxy" data-qa="qa:market-agent:proxy-warning">
              Using Yahoo GC=F futures proxy, not true spot XAUUSD.
            </div>
          ) : null}

          <div className="market-agent-overview-grid">
            <div className="market-agent-overview-stat">
              <span className="market-agent-overview-label">Current state</span>
              <strong>{formatValue(state?.current_bias)}</strong>
            </div>
            <div className="market-agent-overview-stat">
              <span className="market-agent-overview-label">Main driver</span>
              <strong>{formatDriverLabel(state?.main_driver)}</strong>
            </div>
            <div className="market-agent-overview-stat">
              <span className="market-agent-overview-label">Cause status</span>
              <strong>{formatValue(state?.cause_status)}</strong>
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
              <p>{state?.last_alert_summary || "No alert summary yet."}</p>
            </div>
            <div className="market-agent-overview-story-block">
              <span className="market-agent-overview-label">State change reason</span>
              <p>{humanizeMarketAgentReason(state?.state_change_reason)}</p>
            </div>
          </div>

          <div className="market-agent-overview-meta">
            <span>Last analysis: {formatShortTime(state?.last_analysis_time)}</span>
            <span>Last alert: {formatShortTime(state?.last_alert_time)}</span>
            <span>Data source: {formatValue(xauusdHealth?.source, "Not available")}</span>
          </div>
        </>
      )}
    </section>
  );
}
