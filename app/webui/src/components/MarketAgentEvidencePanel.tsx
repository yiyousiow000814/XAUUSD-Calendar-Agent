import type { MarketAgentEvidenceForRunResponse } from "../types";
import { MarketAgentStatusBadge } from "./MarketAgentStatusBadge";
import {
  formatDriverLabel,
  humanizeMarketAgentValue
} from "../utils/marketAgentUi";
import "./MarketAgentEvidencePanel.css";

type MarketAgentEvidencePanelProps = {
  data: MarketAgentEvidenceForRunResponse | null;
  evidenceChainStatus?: Record<string, unknown> | null;
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

const formatUserFacingReason = (value: unknown, fallback: string) => {
  const text = formatValue(value, fallback);
  const normalized = text.toLowerCase();
  if (normalized.includes("market is closed")) {
    return "Market is closed; news and calendar continue, but no current XAUUSD call is published.";
  }
  if (normalized.includes("current conclusion is paused") || normalized.includes("current driver conclusions are paused")) {
    return "News and calendar are still collected and filtered; live price history is required before publishing a current XAUUSD market conclusion.";
  }
  return text;
};

const formatUserFacingRejectionReason = (value: unknown, fallback: string) => {
  const text = formatValue(value, fallback);
  const normalized = text.toLowerCase();
  if (normalized.includes("blocked driver")) {
    return "Not enough evidence for current use.";
  }
  return text;
};

const formatMissingInputLabel = (value: unknown, fallback: string) => {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "evidence_packet" || normalized === "ai_review_inputs") return "AI review inputs";
  if (normalized === "xauusd_recent_history") return "XAUUSD recent history";
  if (normalized === "live_xauusd_spot") return "Live XAUUSD spot";
  return formatDriverLabel(value, fallback);
};

const entriesOf = (value: Record<string, unknown> | null | undefined): EvidenceEntry[] =>
  value ? Object.entries(value) : [];

const recordList = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];

const textValue = (value: unknown, fallback = "") => {
  const text = String(value ?? "").trim();
  return text || fallback;
};

const previewTitle = (item: Record<string, unknown>, fallback: string) =>
  textValue(item.display_title ?? item.ai_title ?? item.summary_title ?? item.title ?? item.summary ?? item.description, fallback);

const isUnknownDriver = (value: unknown) => {
  const normalized = String(value ?? "").trim().toLowerCase();
  return !normalized || ["unknown", "unknown_unconfirmed", "unconfirmed", "none"].includes(normalized);
};

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

export function MarketAgentEvidencePanel({ data, evidenceChainStatus }: MarketAgentEvidencePanelProps) {
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
  const chainStatus = evidenceChainStatus ?? ((evidencePacket?.evidence_chain_status as Record<string, unknown> | null | undefined) ?? null);
  const canShowConclusion = chainStatus?.can_show_current_conclusion !== false;
  const missingInputs = (Array.isArray(chainStatus?.missing_required) ? chainStatus?.missing_required : []) as unknown[];
  const packetNewsRows = recordList(evidencePacket?.news);
  const packetCalendarRows = recordList(evidencePacket?.calendar_events);

  const blockedEntries = entriesOf(blockedDrivers);
  const evidenceEntries = entriesOf(evidenceStatus);
  const confirmationEntries = entriesOf(crossAssetConfirmation);
  const providerIssues = providerHealth.filter(isUnavailableProvider);
  const activeDriverStates = driverStates.filter((item) =>
    ["active", "watching", "emerging"].includes(String(item.current_state ?? "").toLowerCase())
  );
  const contextInputEntries: EvidenceEntry[] = [
    ...packetNewsRows.slice(0, 2).map((item, index): EvidenceEntry => [`News ${index + 1}`, previewTitle(item, "Stored news headline")]),
    ...packetCalendarRows.slice(0, 2).map((item, index): EvidenceEntry => [`Calendar ${index + 1}`, previewTitle(item, "Stored calendar event")])
  ];
  const contextInputCount = packetNewsRows.length + packetCalendarRows.length;

  const hasAcceptedDriver = canShowConclusion && !isUnknownDriver(analysis?.main_driver);
  const mainDriver = hasAcceptedDriver
    ? formatValue(analysis?.main_driver, allowedDrivers[0] ? formatDriverLabel(allowedDrivers[0]) : "No accepted driver")
    : canShowConclusion
      ? "No confirmed driver"
      : "Market read forming";
  const causeStatus = canShowConclusion
    ? formatValue(analysis?.cause_status, allowedDrivers.length ? "Evidence accepted" : "Unconfirmed")
    : contextInputCount ? "News/calendar kept" : "Context only";
  const confidence = formatValue(analysis?.confidence, "Not scored");
  const rejectedDriver = formatValue(analysis?.rejected_driver, blockedEntries[0]?.[0] ? formatDriverLabel(blockedEntries[0][0]) : "None");
  const displayRejectedDriver = canShowConclusion ? rejectedDriver : "Not ranked yet";
  const rejectionReason = canShowConclusion
    ? formatUserFacingRejectionReason(
        analysis?.rejection_reason,
        blockedEntries[0]?.[1] ? formatCompactValue(blockedEntries[0][1]) : "No unused driver recorded"
      )
    : "Current driver ranking waits for price history; unused driver details stay in Activity.";
  const supportingEvidence = uniqueEntries(
    canShowConclusion
      ? [...evidenceEntries, ...confirmationEntries].filter(([, value]) =>
          String(value ?? "").toLowerCase().includes("confirm")
        )
      : []
  );
  const contextEvidence = uniqueEntries(
    canShowConclusion
      ? []
      : [...evidenceEntries, ...confirmationEntries].filter(([, value]) => {
          const normalized = String(value ?? "").toLowerCase();
          return normalized && !["unavailable", "stale", "blocked", "rejected"].some((token) => normalized.includes(token));
        })
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
          <span className="hint">How stored checks become a current driver conclusion</span>
        </div>
        {data?.monitor_run_id ? <MarketAgentStatusBadge label={`run ${data.monitor_run_id}`} tone="info" /> : null}
      </div>
      {!data?.available ? (
        <div className="market-agent-empty-state">{data?.message || "Evidence payload is unavailable."}</div>
      ) : (
        <div className="market-agent-evidence-layout">
          <section className="market-agent-evidence-chain" aria-label="Evidence relationship chain">
            <div className="market-agent-evidence-chain-step support">
              <span className="market-agent-evidence-step-label">{canShowConclusion ? "Support" : "Collected Context"}</span>
              <strong>
                {canShowConclusion
                  ? supportingEvidence.length ? `${supportingEvidence.length} confirming checks` : "No confirming checks"
                  : contextInputCount ? `${contextInputCount} news/calendar input${contextInputCount === 1 ? "" : "s"}` : contextEvidence.length ? `${contextEvidence.length} context checks` : "Context waiting"}
              </strong>
              {canShowConclusion
                ? renderInlineEvidence(supportingEvidence, "No confirming cross-asset evidence recorded.", 3)
                : renderInlineEvidence(
                    contextInputEntries.length ? contextInputEntries : contextEvidence,
                    "News and calendar rows are kept as context until price history is ready.",
                    3
                  )}
              <div className="market-agent-evidence-allowed-row">
                <span>{canShowConclusion ? "Accepted candidates" : "Candidate drivers"}</span>
                {canShowConclusion
                  ? renderBadgeList("Accepted candidates", allowedDrivers, "None")
                  : <span className="market-agent-evidence-muted">Not ranked until required inputs are ready.</span>}
              </div>
            </div>

            <div className="market-agent-evidence-chain-arrow" aria-hidden="true" />

            <div className="market-agent-evidence-chain-step decision">
              <span className="market-agent-evidence-step-label">{hasAcceptedDriver ? "Accepted Driver" : "Current Conclusion"}</span>
              <strong>{mainDriver}</strong>
              <div className="market-agent-evidence-badge-list">
                <MarketAgentStatusBadge label={causeStatus} tone={statusTone(causeStatus)} />
                <MarketAgentStatusBadge label={confidence} tone="info" />
                {chainStatus?.llm_status ? <MarketAgentStatusBadge label={`LLM: ${formatValue(chainStatus.llm_status)}`} tone="neutral" /> : null}
              </div>
            </div>

            <div className="market-agent-evidence-chain-arrow" aria-hidden="true" />

            <div className="market-agent-evidence-chain-step outcome">
              <span className="market-agent-evidence-step-label">{hasAcceptedDriver ? "Run Decision" : "Next Step"}</span>
              <strong>{hasAcceptedDriver ? `Use ${mainDriver}` : canShowConclusion ? "No trade call yet" : "Waiting for price history"}</strong>
              <p>
                {chainStatus?.reason
                  ? formatUserFacingReason(chainStatus.reason, "Required inputs are not ready yet.")
                  : caveatCount
                  ? `${caveatCount} caveat${caveatCount === 1 ? "" : "s"} checked before accepting this explanation.`
                  : "No caveats recorded."}
              </p>
            </div>
          </section>

          <section className="market-agent-evidence-branches" aria-label="Evidence caveats">
            <div className="market-agent-evidence-branch rejected">
              <span>{canShowConclusion ? "Rejected" : "Driver ranking"}</span>
              <strong>{displayRejectedDriver}</strong>
              <p>{rejectionReason}</p>
              {canShowConclusion
                ? renderInlineEvidence(blockedEntries, "No unused driver recorded.", 3)
                : <span className="market-agent-evidence-muted">No blocked-driver list is shown until a current market conclusion is ready.</span>}
            </div>
            <div className="market-agent-evidence-branch quality">
              <span>Data Quality</span>
              <strong>
                {canShowConclusion
                  ? providerIssues.length ? `${providerIssues.length} issue${providerIssues.length === 1 ? "" : "s"}` : "OK"
                  : `${missingInputs.length || 1} missing`}
              </strong>
              {!canShowConclusion ? (
                <div className="market-agent-evidence-provider-pills">
                  {(missingInputs.length ? missingInputs : ["live_xauusd_spot"]).slice(0, 4).map((item, index) => (
                    <MarketAgentStatusBadge
                      key={`${formatValue(item, "missing")}-${index}`}
                      label={`${formatMissingInputLabel(item, `Input ${index + 1}`)} missing`}
                      tone="bad"
                    />
                  ))}
                </div>
              ) : providerHealth.length ? (
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
            <span>{canShowConclusion ? "Still relevant" : "Waiting on"}</span>
            <div>
              {canShowConclusion && activeDriverLabels.length ? (
                activeDriverLabels.map((item) => (
                  <MarketAgentStatusBadge key={item.key} label={item.label} tone={item.tone} />
                ))
              ) : (
                <span className="market-agent-evidence-muted">
                  {canShowConclusion ? "No active driver context stored for this run." : "News/calendar context is kept; price history is required before ranking a current driver."}
                </span>
              )}
            </div>
          </section>

        </div>
      )}
    </section>
  );
}
