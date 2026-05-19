import type { MarketAgentSnapshotResponse } from "../types";
import {
  formatDriverLabel,
  formatShortTime,
  humanizeMarketAgentReason,
  humanizeMarketAgentValue
} from "../utils/marketAgentUi";
import "./MarketAgentPanel.css";

type MarketAgentPanelProps = {
  data: MarketAgentSnapshotResponse | null;
  onOpenMarketAgent?: () => void;
};

const formatValue = (value: string | null | undefined, fallback = "--") =>
  value && String(value).trim() ? humanizeMarketAgentValue(value, fallback) : fallback;

export function MarketAgentPanel({ data, onOpenMarketAgent }: MarketAgentPanelProps) {
  if (!data?.available) {
    return (
      <section className="market-agent-card" data-qa="qa:card:market-agent">
        <div className="market-agent-header">
          <div>
            <h2>Market Situation Agent</h2>
            <span className="hint">Preview from state and recent alerts</span>
          </div>
          {onOpenMarketAgent ? (
            <button
              type="button"
              className="btn ghost btn-compact market-agent-open-btn"
              onClick={onOpenMarketAgent}
              data-qa="qa:action:open-market-agent-preview"
            >
              Open Market Agent
            </button>
          ) : null}
        </div>
        <div className="market-agent-empty">
          {data?.message || "Market agent artifacts are not available yet."}
        </div>
      </section>
    );
  }

  const state = data.state;
  const alerts = data.alerts || [];

  return (
    <section className="market-agent-card" data-qa="qa:card:market-agent">
      <div className="market-agent-header">
        <div>
          <h2>Market Situation Agent</h2>
          <span className="hint">Preview from state and recent alerts</span>
        </div>
        {onOpenMarketAgent ? (
          <button
            type="button"
            className="btn ghost btn-compact market-agent-open-btn"
            onClick={onOpenMarketAgent}
            data-qa="qa:action:open-market-agent-preview"
          >
            Open Market Agent
          </button>
        ) : null}
      </div>

      <div className="market-agent-grid">
        <div className="market-agent-stat">
          <span className="market-agent-label">Bias</span>
          <span className="market-agent-value">{formatValue(state?.current_bias)}</span>
        </div>
        <div className="market-agent-stat">
          <span className="market-agent-label">Main driver</span>
          <span className="market-agent-value">{formatDriverLabel(state?.main_driver)}</span>
        </div>
        <div className="market-agent-stat">
          <span className="market-agent-label">Cause status</span>
          <span className="market-agent-value">{formatValue(state?.cause_status)}</span>
        </div>
        <div className="market-agent-stat">
          <span className="market-agent-label">Confidence</span>
          <span className="market-agent-value">{formatValue(state?.confidence)}</span>
        </div>
      </div>

      <div className="market-agent-summary">
        <div className="market-agent-summary-title">Current thesis</div>
        <div className="market-agent-summary-text">
          {formatValue(state?.last_alert_summary, "No alert summary yet.")}
        </div>
        <div className="market-agent-meta">
          <span>Last analysis: {formatShortTime(state?.last_analysis_time)}</span>
          <span>Last level: {formatValue(state?.last_notification_level, "none")}</span>
        </div>
        <div className="market-agent-reason">
          <span className="market-agent-label">State change</span>
          <span>{humanizeMarketAgentReason(state?.state_change_reason)}</span>
        </div>
      </div>

      <div className="market-agent-history">
        <div className="market-agent-history-title">Recent alerts</div>
        {alerts.length === 0 ? (
          <div className="market-agent-empty">No market-agent alerts recorded yet.</div>
        ) : (
          <div className="market-agent-alert-list">
            {alerts.map((alert, index) => (
              <div
                key={`${alert.time}-${alert.notification_level}-${index}`}
                className="market-agent-alert"
              >
                <div className="market-agent-alert-head">
                  <span className="market-agent-pill">{formatValue(alert.notification_level)}</span>
                  <span className="mono market-agent-time">{formatShortTime(alert.time)}</span>
                </div>
                <div className="market-agent-alert-message">{formatValue(alert.message)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
