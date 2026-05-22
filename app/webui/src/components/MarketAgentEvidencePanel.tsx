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

type EvidenceEntry = [string, unknown];

const formatValue = (value: unknown, fallback = "--") => {
  if (typeof value === "string" && value.trim()) return humanizeMarketAgentValue(value, fallback);
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return fallback;
};

const formatCompactValue = (value: unknown, fallback = "--") => {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sourceType = formatValue(record.source_type, "");
    const dataMode = formatValue(record.data_mode, "");
    const bits = [sourceType, dataMode].filter(Boolean);
    return bits.length ? bits.join(" / ") : fallback;
  }
  return formatValue(value, fallback);
};

const entriesOf = (value: Record<string, unknown> | null | undefined): EvidenceEntry[] =>
  value ? Object.entries(value) : [];

const isUnavailableProvider = (item: Record<string, unknown>) =>
  !item.is_available || item.is_stale || Boolean(item.error);

const uniqueEntries = (items: EvidenceEntry[]) => {
  const seen = new Set<string>();
  return items.filter(([key]) => {
    const normalized = key.toLowerCase();
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
};

const statusTone = (value: unknown): "neutral" | "good" | "warn" | "bad" | "info" => {
  const normalized = String(value ?? "").toLowerCase();
  if (["confirming", "active", "available", "live_seen", "live data"].some((token) => normalized.includes(token))) {
    return "good";
  }
  if (["blocked", "unavailable", "stale", "rejected", "missing"].some((token) => normalized.includes(token))) {
    return "bad";
  }
  if (["watching", "backfilled", "proxy", "neutral", "background"].some((token) => normalized.includes(token))) {
    return "warn";
  }
  return "info";
};

const renderBadgeList = (label: string, values: unknown[] | null | undefined, emptyLabel: string) => (
  <div className="market-agent-evidence-badge-list">
    {values && values.length > 0 ? (
      values.map((value, index) => (
        <MarketAgentStatusBadge key={`${label}-${index}`} label={formatDriverLabel(value)} tone="info" />
      ))
    ) : (
      <span className="market-agent-evidence-muted">{emptyLabel}</span>
    )}
  </div>
);

const renderInlineEvidence = (items: EvidenceEntry[], emptyLabel: string, limit?: number) => {
  const visible = typeof limit === "number" ? items.slice(0, limit) : items;
  if (visible.length === 0) {
    return <span className="market-agent-evidence-muted">{emptyLabel}</span>;
  }
  return (
    <div className="market-agent-evidence-inline-list">
      {visible.map(([key, value]) => (
        <span className="market-agent-evidence-inline-item" key={key}>
          <span>{formatDriverLabel(key, humanizeMarketAgentValue(key))}</span>
          <strong>{formatCompactValue(value)}</strong>
        </span>
      ))}
    </div>
  );
};

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

  const blockedEntries = entriesOf(blockedDrivers);
  const evidenceEntries = entriesOf(evidenceStatus);
  const confirmationEntries = entriesOf(crossAssetConfirmation);
  const providerIssues = providerHealth.filter(isUnavailableProvider);
  const activeDriverStates = driverStates.filter((item) =>
    ["active", "watching", "emerging"].includes(String(item.current_state ?? "").toLowerCase())
  );

  const mainDriver = formatValue(analysis?.main_driver, allowedDrivers[0] ? formatDriverLabel(allowedDrivers[0]) : "No accepted driver");
  const causeStatus = formatValue(analysis?.cause_status, allowedDrivers.length ? "Evidence accepted" : "Unconfirmed");
  const confidence = formatValue(analysis?.confidence, "Not scored");
  const rejectedDriver = formatValue(analysis?.rejected_driver, blockedEntries[0]?.[0] ? formatDriverLabel(blockedEntries[0][0]) : "None");
  const rejectionReason = formatValue(analysis?.rejection_reason, blockedEntries[0]?.[1] ? formatCompactValue(blockedEntries[0][1]) : "No blocked driver recorded");
  const supportingEvidence = uniqueEntries(
    [...evidenceEntries, ...confirmationEntries].filter(([, value]) =>
      String(value ?? "").toLowerCase().includes("confirm")
    )
  );
  const caveatCount = blockedEntries.length + providerIssues.length;
  const activeDriverLabels = activeDriverStates.slice(0, 6).map((item, index) => ({
    key: `${formatValue(item.driver_id, "driver")}-${index}`,
    label: formatDriverLabel(item.driver_id ?? `driver ${index + 1}`),
    state: formatValue(item.current_state, "unknown"),
    tone: statusTone(item.current_state)
  }));

  return (
    <section className="market-agent-surface market-agent-evidence-panel" data-qa="qa:market-agent:evidence-panel">
      <div className="market-agent-surface-header">
        <div>
          <h2>Evidence Panel</h2>
          <span className="hint">Why this run accepted one driver and rejected weaker explanations</span>
        </div>
        {data?.monitor_run_id ? <MarketAgentStatusBadge label={`run ${data.monitor_run_id}`} tone="info" /> : null}
      </div>
      {!data?.available ? (
        <div className="market-agent-empty-state">{data?.message || "Evidence payload is unavailable."}</div>
      ) : (
        <div className="market-agent-evidence-layout">
          <section className="market-agent-evidence-chain" aria-label="Evidence relationship chain">
            <div className="market-agent-evidence-chain-step support">
              <span className="market-agent-evidence-step-label">Support</span>
              <strong>{supportingEvidence.length ? `${supportingEvidence.length} confirming checks` : "No confirming checks"}</strong>
              {renderInlineEvidence(supportingEvidence, "No confirming cross-asset evidence recorded.", 3)}
              <div className="market-agent-evidence-allowed-row">
                <span>Allowed drivers</span>
                {renderBadgeList("Allowed drivers", allowedDrivers, "None")}
              </div>
            </div>

            <div className="market-agent-evidence-chain-arrow" aria-hidden="true" />

            <div className="market-agent-evidence-chain-step decision">
              <span className="market-agent-evidence-step-label">Accepted Driver</span>
              <strong>{mainDriver}</strong>
              <div className="market-agent-evidence-badge-list">
                <MarketAgentStatusBadge label={causeStatus} tone={statusTone(causeStatus)} />
                <MarketAgentStatusBadge label={confidence} tone="info" />
              </div>
            </div>

            <div className="market-agent-evidence-chain-arrow" aria-hidden="true" />

            <div className="market-agent-evidence-chain-step outcome">
              <span className="market-agent-evidence-step-label">Run Decision</span>
              <strong>Use {mainDriver}</strong>
              <p>
                {caveatCount
                  ? `${caveatCount} caveat${caveatCount === 1 ? "" : "s"} checked before accepting this explanation.`
                  : "No blocking caveats recorded."}
              </p>
            </div>
          </section>

          <section className="market-agent-evidence-branches" aria-label="Evidence caveats">
            <div className="market-agent-evidence-branch rejected">
              <span>Rejected</span>
              <strong>{rejectedDriver}</strong>
              <p>{rejectionReason}</p>
              {renderInlineEvidence(blockedEntries, "No blocked driver recorded.", 3)}
            </div>
            <div className="market-agent-evidence-branch quality">
              <span>Data Quality</span>
              <strong>{providerIssues.length ? `${providerIssues.length} issue${providerIssues.length === 1 ? "" : "s"}` : "OK"}</strong>
              {providerHealth.length ? (
                <div className="market-agent-evidence-provider-pills">
                  {providerHealth.slice(0, 4).map((item, index) => (
                    <MarketAgentStatusBadge
                      key={`${formatValue(item.provider_key, "provider")}-${index}`}
                      label={`${formatValue(item.provider_key, `Provider ${index + 1}`)}: ${formatValue(item.is_available ? item.data_mode || "available" : "unavailable")}`}
                      tone={isUnavailableProvider(item) ? "bad" : statusTone(item.data_mode)}
                    />
                  ))}
                </div>
              ) : (
                <span className="market-agent-evidence-muted">No provider-health rows stored for this run.</span>
              )}
            </div>
          </section>

          <section className="market-agent-evidence-context-line" aria-label="Driver context">
            <span>Still relevant</span>
            <div>
              {activeDriverLabels.length ? (
                activeDriverLabels.map((item) => (
                  <MarketAgentStatusBadge key={item.key} label={`${item.label}: ${item.state}`} tone={item.tone} />
                ))
              ) : (
                <span className="market-agent-evidence-muted">No active driver context stored for this run.</span>
              )}
            </div>
          </section>

        </div>
      )}
    </section>
  );
}
