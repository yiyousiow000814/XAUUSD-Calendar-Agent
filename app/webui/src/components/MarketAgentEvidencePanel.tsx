import type { MarketAgentEvidenceForRunResponse } from "../types";
import { MarketAgentStatusBadge } from "./MarketAgentStatusBadge";
import {
  formatDriverLabel,
  humanizeMarketAgentValue
} from "../utils/marketAgentUi";
import "./MarketAgentEvidencePanel.css";

type MarketAgentEvidencePanelProps = {
  data: MarketAgentEvidenceForRunResponse | null;
};

const formatValue = (value: unknown, fallback = "--") => {
  if (typeof value === "string" && value.trim()) return humanizeMarketAgentValue(value, fallback);
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return fallback;
};

const renderScalarMap = (value: Record<string, unknown> | null | undefined, emptyLabel: string) => {
  if (!value || Object.keys(value).length === 0) {
    return <div className="market-agent-empty-state">{emptyLabel}</div>;
  }
  return Object.entries(value).map(([key, item]) => (
    <div key={key} className="market-agent-evidence-row">
      <span className="market-agent-overview-label">{formatDriverLabel(key, humanizeMarketAgentValue(key))}</span>
      <div className="market-agent-evidence-value">{formatValue(item)}</div>
    </div>
  ));
};

const renderValueList = (label: string, values: unknown[] | null | undefined, emptyLabel: string) => (
  <div className="market-agent-evidence-row">
    <span className="market-agent-overview-label">{humanizeMarketAgentValue(label)}</span>
    <div className="market-agent-evidence-value">
      {values && values.length > 0 ? (
        <div className="market-agent-overview-badges">
          {values.map((value, index) => (
            <MarketAgentStatusBadge key={`${label}-${index}`} label={formatDriverLabel(value)} tone="info" />
          ))}
        </div>
      ) : (
        emptyLabel
      )}
    </div>
  </div>
);

export function MarketAgentEvidencePanel({ data }: MarketAgentEvidencePanelProps) {
  const payload = data?.payload;
  const evidencePacket = (payload?.evidence_packet as Record<string, unknown> | null | undefined) ?? null;
  const analysis = (payload?.analysis_result as Record<string, unknown> | null | undefined) ?? null;
  const providerHealth = ((payload?.provider_health as Record<string, unknown>[] | null | undefined) ?? []).filter(Boolean);
  const driverStates = ((payload?.driver_attention_states as Record<string, unknown>[] | null | undefined) ?? []).filter(Boolean);
  const allowedDrivers = (Array.isArray(evidencePacket?.allowed_candidate_drivers)
    ? evidencePacket?.allowed_candidate_drivers
    : []) as unknown[];
  const blockedDrivers = ((evidencePacket?.blocked_drivers as Record<string, unknown> | null | undefined) ?? null);
  const evidenceStatus = ((evidencePacket?.evidence_status as Record<string, unknown> | null | undefined) ?? null);
  const crossAssetConfirmation = ((evidencePacket?.cross_asset_confirmation as Record<string, unknown> | null | undefined) ?? null);
  const embeddedProviderHealth = ((evidencePacket?.provider_health as Record<string, unknown> | null | undefined) ?? null);

  return (
    <section className="market-agent-surface" data-qa="qa:market-agent:evidence-panel">
      <div className="market-agent-surface-header">
        <div>
          <h2>Evidence Panel</h2>
          <span className="hint">Allowed drivers, blocked drivers, cross-asset gates, and validator outcome</span>
        </div>
        {data?.monitor_run_id ? <MarketAgentStatusBadge label={`run ${data.monitor_run_id}`} tone="info" /> : null}
      </div>
      {!data?.available ? (
        <div className="market-agent-empty-state">{data?.message || "Evidence payload is unavailable."}</div>
      ) : (
        <div className="market-agent-evidence-grid">
          <div className="market-agent-evidence-section">
            <h3>Evidence packet</h3>
            {renderValueList("Allowed drivers", allowedDrivers, "No allowed drivers passed this run.")}
            {renderScalarMap(blockedDrivers, "No blocked drivers recorded.")}
            {renderScalarMap(evidenceStatus, "No evidence status recorded.")}
            {renderScalarMap(crossAssetConfirmation, "No cross-asset confirmation recorded.")}
            {renderScalarMap(embeddedProviderHealth, "No embedded provider-health summary recorded.")}
          </div>
          <div className="market-agent-evidence-section">
            <h3>Analysis result</h3>
            {renderScalarMap(analysis, "No analysis result loaded.")}
          </div>
          <div className="market-agent-evidence-section">
            <h3>Provider health at run</h3>
            {providerHealth.length === 0 ? (
              <div className="market-agent-empty-state">No provider-health rows stored for this run.</div>
            ) : (
              providerHealth.map((item, index) => (
                <div key={`provider-health-${index}`} className="market-agent-evidence-row">
                  <span className="market-agent-overview-label">{formatValue(item.provider_key, `provider ${index + 1}`)}</span>
                  <div className="market-agent-evidence-value">
                    <div>{formatValue(item.source, "unknown source")}</div>
                    <div className="market-agent-overview-badges">
                      <MarketAgentStatusBadge label={formatValue(item.source_type, "unknown")} tone="info" />
                      <MarketAgentStatusBadge label={formatValue(item.data_mode, "unknown")} />
                      <MarketAgentStatusBadge label={formatValue(item.is_available ? "available" : "unavailable")} />
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
          <div className="market-agent-evidence-section">
            <h3>Driver states at run</h3>
            {driverStates.length === 0 ? (
              <div className="market-agent-empty-state">No driver-attention snapshot stored for this run.</div>
            ) : (
              driverStates.map((item, index) => (
                <div key={`driver-state-${index}`} className="market-agent-evidence-row">
                  <span className="market-agent-overview-label">{formatDriverLabel(item.driver_id ?? `driver ${index + 1}`)}</span>
                  <div className="market-agent-evidence-value">
                    <div>{formatValue(item.activation_reason, formatValue(item.deactivation_reason, "No state-change note"))}</div>
                    <div className="market-agent-overview-badges">
                      <MarketAgentStatusBadge label={formatValue(item.current_state, "unknown")} />
                      <MarketAgentStatusBadge label={formatValue(item.data_mode, "unknown")} />
                      <MarketAgentStatusBadge label={formatValue(item.confidence, "unknown")} tone="info" />
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
          <details className="market-agent-evidence-raw">
            <summary>Raw details</summary>
            <pre>{JSON.stringify(payload, null, 2)}</pre>
          </details>
        </div>
      )}
    </section>
  );
}
