import type { MarketAgentDriverAttentionResponse } from "../types";
import { MarketAgentStatusBadge } from "./MarketAgentStatusBadge";
import {
  formatDriverLabel,
  formatRelevance,
  formatShortTime,
  humanizeMarketAgentValue,
  normalizeMarketAgentValue
} from "../utils/marketAgentUi";
import "./MarketAgentDriverAttention.css";

type MarketAgentDriverAttentionProps = {
  data: MarketAgentDriverAttentionResponse | null;
};

const formatValue = (value: unknown, fallback = "--") =>
  typeof value === "string" && value.trim()
    ? humanizeMarketAgentValue(value, fallback)
    : typeof value === "number"
      ? value.toFixed(2)
      : fallback;

const groupStates = (states: MarketAgentDriverAttentionResponse["states"]) => {
  const groups = {
    active: states.filter((state) => ["active", "active_macro"].includes(normalizeMarketAgentValue(state.current_state))),
    watching: states.filter((state) => ["watching", "emerging", "cooling", "faded"].includes(normalizeMarketAgentValue(state.current_state))),
    background: states.filter((state) => !["active", "active_macro", "watching", "emerging", "cooling", "faded"].includes(normalizeMarketAgentValue(state.current_state)))
  };
  return groups;
};

const reasonForState = (state: MarketAgentDriverAttentionResponse["states"][number]) =>
  state.activation_reason ||
  state.deactivation_reason ||
  state.current_evidence_summary ||
  state.notes ||
  "Observed as background only. It is not an active explanation unless evidence gates pass.";

const DriverCard = ({ state }: { state: MarketAgentDriverAttentionResponse["states"][number] }) => (
  <article className="market-agent-driver-card">
    <div className="market-agent-driver-card-head">
      <div>
        <h3>{state.label || formatDriverLabel(state.driver_id)}</h3>
        <span>{formatRelevance(state.relevance_score)}</span>
      </div>
      <MarketAgentStatusBadge label={formatValue(state.current_state, "unknown")} />
    </div>
    <p>{reasonForState(state)}</p>
    <div className="market-agent-driver-meta">
      <span>Confidence: {formatValue(state.confidence, "Unknown")}</span>
      <span>Last confirmed: {formatShortTime(state.last_confirmed_at)}</span>
    </div>
    <details className="market-agent-driver-details">
      <summary>Technical details</summary>
      <dl>
        <div>
          <dt>Driver ID</dt>
          <dd>{state.driver_id}</dd>
        </div>
        <div>
          <dt>Priority</dt>
          <dd>{formatValue(state.priority)}</dd>
        </div>
        <div>
          <dt>Decay deadline</dt>
          <dd>{formatShortTime(state.decay_deadline)}</dd>
        </div>
        <div>
          <dt>Data mode</dt>
          <dd>{formatValue(state.data_mode)}</dd>
        </div>
      </dl>
    </details>
  </article>
);

const DriverGroup = ({
  title,
  description,
  states
}: {
  title: string;
  description: string;
  states: MarketAgentDriverAttentionResponse["states"];
}) => (
  <div className="market-agent-driver-group">
    <div className="market-agent-driver-group-head">
      <div>
        <h3>{title}</h3>
        <span>{description}</span>
      </div>
      <MarketAgentStatusBadge label={`${states.length} drivers`} tone="info" />
    </div>
    {states.length ? (
      <div className="market-agent-driver-card-grid">
        {states.map((state) => (
          <DriverCard key={`${state.driver_id}-${state.monitor_run_id ?? "latest"}`} state={state} />
        ))}
      </div>
    ) : (
      <div className="market-agent-empty-state">No drivers in this group.</div>
    )}
  </div>
);

export function MarketAgentDriverAttention({ data }: MarketAgentDriverAttentionProps) {
  const groups = groupStates(data?.states ?? []);

  return (
    <section className="market-agent-surface" data-qa="qa:market-agent:driver-attention">
      <div className="market-agent-surface-header">
        <div>
          <h2>Active Attention</h2>
          <span className="hint">Drivers are observed separately from causal claims</span>
        </div>
      </div>
      {!data?.available ? (
        <div className="market-agent-empty-state">{data?.message || "Driver attention is unavailable."}</div>
      ) : (
        <div className="market-agent-driver-groups">
          <DriverGroup
            title="Active Drivers"
            description="Evidence is fresh enough to influence the current conclusion."
            states={groups.active}
          />
          <DriverGroup
            title="Watching / Emerging"
            description="Important enough to track, not yet a confirmed cause."
            states={groups.watching}
          />
          <DriverGroup
            title="Background / Dormant"
            description="Observed quietly; not treated as the active explanation."
            states={groups.background}
          />
        </div>
      )}
    </section>
  );
}
