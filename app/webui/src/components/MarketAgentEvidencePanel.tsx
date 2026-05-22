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

const renderCompactRows = (items: EvidenceEntry[], emptyLabel: string, limit?: number) => {
  const visible = typeof limit === "number" ? items.slice(0, limit) : items;
  if (visible.length === 0) {
    return <div className="market-agent-empty-state">{emptyLabel}</div>;
  }
  return (
    <div className="market-agent-evidence-compact-list">
      {visible.map(([key, value]) => (
        <div className="market-agent-evidence-compact-row" key={key}>
          <span>{formatDriverLabel(key, humanizeMarketAgentValue(key))}</span>
          <strong>{formatCompactValue(value)}</strong>
        </div>
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
          <section className="market-agent-evidence-hero" aria-label="Evidence decision">
            <div className="market-agent-evidence-decision">
              <span>Accepted driver</span>
              <strong>{mainDriver}</strong>
              <p>
                {supportingEvidence.length
                  ? `${supportingEvidence.length} confirming evidence checks support this run.`
                  : "No confirming evidence check was stored for this run."}
              </p>
              <div className="market-agent-evidence-badge-list">
                <MarketAgentStatusBadge label={causeStatus} tone={statusTone(causeStatus)} />
                <MarketAgentStatusBadge label={confidence} tone="info" />
              </div>
            </div>
            <div className="market-agent-evidence-rejection">
              <span>Rejected explanation</span>
              <strong>{rejectedDriver}</strong>
              <p>{rejectionReason}</p>
              <div className="market-agent-evidence-badge-list">
                <MarketAgentStatusBadge label={`${blockedEntries.length} blocked`} tone={blockedEntries.length ? "bad" : "good"} />
                <MarketAgentStatusBadge label={`${providerIssues.length} provider issue${providerIssues.length === 1 ? "" : "s"}`} tone={providerIssues.length ? "warn" : "good"} />
              </div>
            </div>
          </section>

          <section className="market-agent-evidence-explain-grid" aria-label="Evidence summary">
            <article className="market-agent-evidence-card">
              <div className="market-agent-evidence-card-title">
                <span>Allowed drivers</span>
                <strong>{allowedDrivers.length}</strong>
              </div>
              {renderBadgeList("Allowed drivers", allowedDrivers, "No allowed drivers passed this run.")}
              {renderCompactRows(supportingEvidence, "No confirming cross-asset evidence recorded.", 4)}
            </article>

            <article className="market-agent-evidence-card">
              <div className="market-agent-evidence-card-title">
                <span>Blocked candidates</span>
                <strong>{blockedEntries.length}</strong>
              </div>
              {renderCompactRows(blockedEntries, "No blocked driver recorded.", 3)}
            </article>

            <article className="market-agent-evidence-card">
              <div className="market-agent-evidence-card-title">
                <span>Data quality</span>
                <strong>{providerIssues.length ? `${providerIssues.length} issue${providerIssues.length === 1 ? "" : "s"}` : "OK"}</strong>
              </div>
              {providerHealth.length ? (
                <div className="market-agent-evidence-provider-strip">
                  {providerHealth.slice(0, 4).map((item, index) => (
                    <div key={`${formatValue(item.provider_key, "provider")}-${index}`}>
                      <span>{formatValue(item.provider_key, `Provider ${index + 1}`)}</span>
                      <MarketAgentStatusBadge
                        label={formatValue(item.is_available ? item.data_mode || "available" : "unavailable")}
                        tone={isUnavailableProvider(item) ? "bad" : statusTone(item.data_mode)}
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="market-agent-empty-state">No provider-health rows stored for this run.</div>
              )}
            </article>
          </section>

          <section className="market-agent-evidence-context" aria-label="Driver context">
            <div className="market-agent-evidence-context-copy">
              <span>Current driver context</span>
              <strong>{activeDriverStates.length ? `${activeDriverStates.length} drivers still relevant` : "No active driver context"}</strong>
              <p>Only current active, watching, or emerging drivers are shown here so the page stays focused on the current explanation.</p>
            </div>
            <div className="market-agent-evidence-driver-strip">
              {activeDriverStates.length ? (
                activeDriverStates.slice(0, 5).map((item, index) => (
                  <article key={`${formatValue(item.driver_id, "driver")}-${index}`}>
                    <span>{formatDriverLabel(item.driver_id ?? `driver ${index + 1}`)}</span>
                    <strong>{formatValue(item.activation_reason, formatValue(item.deactivation_reason, "No state-change note"))}</strong>
                    <div className="market-agent-evidence-badge-list">
                      <MarketAgentStatusBadge label={formatValue(item.current_state, "unknown")} tone={statusTone(item.current_state)} />
                      <MarketAgentStatusBadge label={formatValue(item.confidence, "unknown")} tone="info" />
                    </div>
                  </article>
                ))
              ) : (
                <div className="market-agent-empty-state">No active driver-attention snapshot stored for this run.</div>
              )}
            </div>
          </section>

        </div>
      )}
    </section>
  );
}
