import type { MarketAgentProviderHealthResponse } from "../types";
import { MarketAgentStatusBadge } from "./MarketAgentStatusBadge";
import "./MarketAgentProviderHealth.css";

type MarketAgentProviderHealthProps = {
  data: MarketAgentProviderHealthResponse | null;
};

const formatValue = (value: unknown, fallback = "--") =>
  typeof value === "string" && value.trim() ? value : typeof value === "number" ? String(value) : fallback;

export function MarketAgentProviderHealth({ data }: MarketAgentProviderHealthProps) {
  return (
    <section className="market-agent-surface" data-qa="qa:market-agent:provider-health">
      <div className="market-agent-surface-header">
        <div>
          <h2>Provider Health</h2>
          <span className="hint">Freshness, proxy caveats, unavailable sources, and honest backend status</span>
        </div>
      </div>
      {!data?.available ? (
        <div className="market-agent-empty-state">{data?.message || "Provider health is unavailable."}</div>
      ) : (
        <div className="market-agent-table-wrap">
          <table className="market-agent-table">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Source</th>
                <th>Type</th>
                <th>Mode</th>
                <th>Available</th>
                <th>Stale</th>
                <th>Data timestamp</th>
                <th>Fetched at</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((item) => (
                <tr key={`${item.provider_key ?? item.source}-${item.monitor_run_id ?? "latest"}`}>
                  <td><strong>{formatValue(item.provider_key, item.source)}</strong></td>
                  <td>{formatValue(item.source)}</td>
                  <td><MarketAgentStatusBadge label={formatValue(item.source_type, "unknown")} tone="info" /></td>
                  <td><MarketAgentStatusBadge label={formatValue(item.data_mode, "unknown")} /></td>
                  <td><MarketAgentStatusBadge label={item.is_available ? "available" : "unavailable"} /></td>
                  <td><MarketAgentStatusBadge label={item.is_stale ? "stale" : "live"} /></td>
                  <td>{formatValue(item.data_timestamp)}</td>
                  <td>{formatValue(item.fetched_at)}</td>
                  <td>{formatValue(item.stale_reason, formatValue(item.error, "OK"))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
