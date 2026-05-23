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
  evidenceChainStatus?: Record<string, unknown> | null;
};

const formatValue = (value: unknown, fallback = "--") =>
  typeof value === "string" && value.trim()
    ? humanizeMarketAgentValue(value, fallback)
    : typeof value === "number"
      ? value.toFixed(2)
      : fallback;

const groupStates = (states: MarketAgentDriverAttentionResponse["states"]) => {
  const meaningful = states.filter((state) => {
    const normalized = normalizeMarketAgentValue(state.current_state);
    if (["active", "active_macro", "watching", "emerging", "cooling", "faded"].includes(normalized)) return true;
    return (state.relevance_score ?? 0) > 0;
  });
  const groups = {
    active: meaningful.filter((state) => ["active", "active_macro"].includes(normalizeMarketAgentValue(state.current_state))),
    watching: meaningful.filter((state) => ["watching", "emerging", "cooling", "faded"].includes(normalizeMarketAgentValue(state.current_state))),
    background: meaningful.filter((state) => !["active", "active_macro", "watching", "emerging", "cooling", "faded"].includes(normalizeMarketAgentValue(state.current_state)))
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

const listValue = (payload: Record<string, unknown> | null | undefined, key: string) =>
  (Array.isArray(payload?.[key]) ? payload?.[key] : []) as unknown[];

export function MarketAgentDriverAttention({ data, evidenceChainStatus }: MarketAgentDriverAttentionProps) {
  const canShowConclusion = evidenceChainStatus?.can_show_current_conclusion !== false;
  const groups = groupStates(data?.states ?? []);
  const primary = canShowConclusion
    ? [...groups.active].sort((left, right) => (right.relevance_score ?? 0) - (left.relevance_score ?? 0))[0]
    : undefined;
  const missingInputs = listValue(evidenceChainStatus, "missing_required");
  const usableInputs = listValue(evidenceChainStatus, "usable_inputs");
  const contextStates = [...groups.active, ...groups.watching, ...groups.background]
    .sort((left, right) => (right.relevance_score ?? 0) - (left.relevance_score ?? 0))
    .slice(0, 6);

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
      ) : !canShowConclusion ? (
        <div className="market-agent-driver-layout market-agent-driver-layout-paused">
          <div className="market-agent-driver-summary">
            <div>
              <span>Current ranking paused</span>
              <strong>Driver scores hidden</strong>
              <p>{formatValue(evidenceChainStatus?.reason, "Live XAUUSD price and recent history are required before current driver scores are shown.")}</p>
            </div>
            <div className="market-agent-driver-summary-metrics">
              <span><em>Confirmed</em><b>0</b></span>
              <span><em>Missing</em><b>{missingInputs.length}</b></span>
              <span><em>Context</em><b>{usableInputs.length + contextStates.length}</b></span>
            </div>
          </div>
          <section className="market-agent-driver-group">
            <div className="market-agent-driver-group-head">
              <div>
                <h3>Required price inputs</h3>
                <span>These resume current driver scoring. News and calendar context still collects.</span>
              </div>
              <b>{missingInputs.length}</b>
            </div>
            <div className="market-agent-driver-list">
              {(missingInputs.length ? missingInputs : ["live_xauusd_spot", "xauusd_recent_history"]).map((item) => (
                <article className="market-agent-driver-row tone-background" key={String(item)}>
                  <div className="market-agent-driver-main">
                    <div>
                      <strong>{formatValue(item)}</strong>
                      <span>Waiting before current driver scores are shown.</span>
                    </div>
                    <b>Waiting</b>
                  </div>
                </article>
              ))}
            </div>
          </section>
          <section className="market-agent-driver-group">
            <div className="market-agent-driver-group-head">
              <div>
                <h3>Context still watched</h3>
                <span>These are stored as context until price evidence can confirm a current driver.</span>
              </div>
              <b>{contextStates.length}</b>
            </div>
            <div className="market-agent-driver-list">
              {contextStates.length ? (
                contextStates.map((state) => (
                  <DriverRow key={`${state.driver_id}-${state.monitor_run_id ?? "paused"}`} state={state} />
                ))
              ) : (
                <div className="market-agent-empty-state">No context drivers recorded yet.</div>
              )}
            </div>
          </section>
        </div>
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
