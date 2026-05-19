import type { MarketAgentDriverAttentionResponse } from "../types";
import { MarketAgentStatusBadge } from "./MarketAgentStatusBadge";
import "./MarketAgentDriverAttention.css";

type MarketAgentDriverAttentionProps = {
  data: MarketAgentDriverAttentionResponse | null;
};

const formatValue = (value: unknown, fallback = "--") =>
  typeof value === "string" && value.trim() ? value : typeof value === "number" ? value.toFixed(2) : fallback;

export function MarketAgentDriverAttention({ data }: MarketAgentDriverAttentionProps) {
  return (
    <section className="market-agent-surface" data-qa="qa:market-agent:driver-attention">
      <div className="market-agent-surface-header">
        <div>
          <h2>Driver Attention</h2>
          <span className="hint">Observed, background, emerging, active, and cooling drivers</span>
        </div>
      </div>
      {!data?.available ? (
        <div className="market-agent-empty-state">{data?.message || "Driver attention is unavailable."}</div>
      ) : (
        <div className="market-agent-table-wrap">
          <table className="market-agent-table">
            <thead>
              <tr>
                <th>Driver</th>
                <th>State</th>
                <th>Priority</th>
                <th>Score</th>
                <th>Confidence</th>
                <th>Activation</th>
                <th>Last confirmed</th>
                <th>Decay</th>
                <th>Mode</th>
              </tr>
            </thead>
            <tbody>
              {data.states.map((state) => (
                <tr key={`${state.driver_id}-${state.monitor_run_id ?? "latest"}`}>
                  <td>
                    <div className="market-agent-primary-cell">
                      <strong>{state.driver_id}</strong>
                      <span>{formatValue(state.label, "Background only")}</span>
                    </div>
                  </td>
                  <td><MarketAgentStatusBadge label={formatValue(state.current_state, "unknown")} /></td>
                  <td>{formatValue(state.priority)}</td>
                  <td>{typeof state.relevance_score === "number" ? state.relevance_score.toFixed(2) : "--"}</td>
                  <td>{formatValue(state.confidence)}</td>
                  <td>{formatValue(state.activation_reason, formatValue(state.deactivation_reason, "No change reason"))}</td>
                  <td>{formatValue(state.last_confirmed_at)}</td>
                  <td>{formatValue(state.decay_deadline)}</td>
                  <td><MarketAgentStatusBadge label={formatValue(state.data_mode, "unknown")} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
