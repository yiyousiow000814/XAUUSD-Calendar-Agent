import type { MarketAgentDriverAttentionResponse } from "../types";
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

const formatScorePercent = (value: number | undefined) => `${Math.round((value ?? 0) * 100)}%`;

const formatImpact = (value: number | null | undefined) => {
  if (typeof value !== "number" || !Number.isFinite(value)) return "--";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
};

const stateTone = (state: MarketAgentDriverAttentionResponse["states"][number]) => {
  const normalized = normalizeMarketAgentValue(state.current_state);
  if (["active", "active_macro"].includes(normalized)) return "active";
  if (["watching", "emerging", "cooling", "faded"].includes(normalized)) return "watching";
  return "background";
};

const DriverRow = ({ state }: { state: MarketAgentDriverAttentionResponse["states"][number] }) => {
  const tone = stateTone(state);
  const relevance = Math.max(0, Math.min(100, Math.round((state.relevance_score ?? 0) * 100)));
  return (
    <article className={`market-agent-driver-row tone-${tone}`}>
      <div className="market-agent-driver-main">
        <div>
          <strong>{state.label || formatDriverLabel(state.driver_id)}</strong>
          <span>{reasonForState(state)}</span>
        </div>
        <b>{formatValue(state.current_state, "Unknown")}</b>
      </div>
      <div className="market-agent-driver-signal">
        <span>
          <em>Impact</em>
          <b className={typeof state.impact_percent === "number" && state.impact_percent < 0 ? "negative" : "positive"}>
            {formatImpact(state.impact_percent)}
          </b>
        </span>
        <span>
          <em>Confidence</em>
          <b>{formatValue(state.confidence, "Unknown")}</b>
        </span>
        <span>
          <em>Confirmed</em>
          <b>{formatShortTime(state.last_confirmed_at)}</b>
        </span>
      </div>
      <div className="market-agent-driver-score" aria-label={`Relevance ${formatScorePercent(state.relevance_score)}`}>
        <span style={{ width: `${relevance}%` }} />
      </div>
    </article>
  );
};

const DriverGroup = ({
  title,
  description,
  states
}: {
  title: string;
  description: string;
  states: MarketAgentDriverAttentionResponse["states"];
}) => (
  <section className="market-agent-driver-group">
    <div className="market-agent-driver-group-head">
      <div>
        <h3>{title}</h3>
        <span>{description}</span>
      </div>
      <b>{states.length}</b>
    </div>
    <div className="market-agent-driver-list">
      {states.length ? (
        states.map((state) => (
          <DriverRow key={`${state.driver_id}-${state.monitor_run_id ?? "latest"}`} state={state} />
        ))
      ) : (
        <div className="market-agent-empty-state">No drivers in this lane.</div>
      )}
    </div>
  </section>
);

export function MarketAgentDriverAttention({ data }: MarketAgentDriverAttentionProps) {
  const groups = groupStates(data?.states ?? []);
  const primary = [...groups.active].sort((left, right) => (right.relevance_score ?? 0) - (left.relevance_score ?? 0))[0];

  return (
    <section className="market-agent-surface" data-qa="qa:market-agent:driver-attention">
      <div className="market-agent-surface-header">
        <div>
          <h2>Driver Focus</h2>
          <span className="hint">Current XAUUSD drivers ranked by usable signal</span>
        </div>
      </div>
      {!data?.available ? (
        <div className="market-agent-empty-state">{data?.message || "Driver attention is unavailable."}</div>
      ) : (
        <div className="market-agent-driver-layout">
          <div className="market-agent-driver-summary">
            <div>
              <span>Driving now</span>
              <strong>{primary ? (primary.label || formatDriverLabel(primary.driver_id)) : "No confirmed driver"}</strong>
              <p>{primary ? reasonForState(primary) : "The current move has not passed the evidence gate yet."}</p>
            </div>
            <div className="market-agent-driver-summary-metrics">
              <span><em>Active</em><b>{groups.active.length}</b></span>
              <span><em>Watching</em><b>{groups.watching.length}</b></span>
              <span><em>Background</em><b>{groups.background.length}</b></span>
            </div>
          </div>
          <DriverGroup
            title="Driving Now"
            description="Fresh enough to affect the current conclusion."
            states={groups.active}
          />
          <DriverGroup
            title="Watch Next"
            description="Moving or relevant, but not yet the explanation."
            states={groups.watching}
          />
          <DriverGroup
            title="Background"
            description="Tracked quietly unless confirmation improves."
            states={groups.background}
          />
        </div>
      )}
    </section>
  );
}
