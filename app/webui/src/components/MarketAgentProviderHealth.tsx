import type { MarketAgentProviderHealthResponse } from "../types";
import { MarketAgentStatusBadge } from "./MarketAgentStatusBadge";
import {
  findProviderHealth,
  formatShortTime,
  humanizeMarketAgentValue,
  normalizeMarketAgentValue,
  providerGuidance
} from "../utils/marketAgentUi";
import "./MarketAgentProviderHealth.css";

type MarketAgentProviderHealthProps = {
  data: MarketAgentProviderHealthResponse | null;
};

const formatValue = (value: unknown, fallback = "--") =>
  typeof value === "string" && value.trim()
    ? humanizeMarketAgentValue(value, fallback)
    : typeof value === "number"
      ? String(value)
      : fallback;

const providerCards = [
  { title: "XAUUSD (Spot)", keys: ["xauusd", "gc=f", "xauusd price"], action: "Configure cTrader for true spot or Yahoo for proxy." },
  { title: "DXY", keys: ["dxy", "dx-y.nyb"], action: "Needed for USD pressure confirmation." },
  { title: "US10Y", keys: ["us10y", "^tnx"], action: "Needed for yield pressure confirmation." },
  { title: "US2Y", keys: ["us2y"], action: "No reliable free source configured unless provider is added." },
  { title: "Oil", keys: ["wti", "brent", "cl=f", "bz=f", "oil"], action: "Background unless oil channel evidence passes." },
  { title: "VIX / Equities", keys: ["vix", "spx", "nasdaq", "^vix", "^gspc", "^ixic"], action: "Used for risk sentiment confirmation." },
  { title: "RSS News", keys: ["rss", "news", "google_news"], action: "News can be delayed or noisy; evidence gates still apply." },
  { title: "Calendar", keys: ["calendar", "forexfactory", "forex_factory"], action: "Configure ForexFactory source for event windows." },
  { title: "cTrader", keys: ["ctrader", "ctrader_cli"], action: "Connect cTrader CLI for true spot XAUUSD." },
  { title: "Yahoo GC=F", keys: ["yahoo", "yahoo_finance", "gc=f"], action: "Fallback futures proxy, not true spot XAUUSD." }
];

const statusForItem = (item: ReturnType<typeof findProviderHealth>) => {
  if (!item) return "Disabled";
  if (!item.is_available || normalizeMarketAgentValue(item.data_mode) === "unavailable") return "Unavailable";
  if (item.is_stale || normalizeMarketAgentValue(item.data_mode) === "stale") return "Stale data";
  if (normalizeMarketAgentValue(item.source_type) === "futures_proxy" || normalizeMarketAgentValue(item.data_mode) === "proxy") {
    return "Futures proxy";
  }
  if (normalizeMarketAgentValue(item.source_type) === "local_csv_fallback" || normalizeMarketAgentValue(item.data_mode) === "local_csv_fallback") {
    return "Local CSV fallback";
  }
  return normalizeMarketAgentValue(item.source_type) === "spot" ? "Live data" : "Available";
};

export function MarketAgentProviderHealth({ data }: MarketAgentProviderHealthProps) {
  const items = data?.items ?? [];
  const liveCount = items.filter((item) => item.is_available && !item.is_stale && normalizeMarketAgentValue(item.source_type) === "spot").length;
  const proxyCount = items.filter(
    (item) =>
      item.is_available &&
      !item.is_stale &&
      (normalizeMarketAgentValue(item.source_type) === "futures_proxy" || normalizeMarketAgentValue(item.data_mode) === "proxy")
  ).length;
  const issueCount = items.filter((item) => !item.is_available || item.is_stale || normalizeMarketAgentValue(item.data_mode) === "unavailable").length;

  return (
    <section className="market-agent-surface" data-qa="qa:market-agent:provider-health">
      <div className="market-agent-surface-header">
        <div>
          <h2>Data Quality</h2>
          <span className="hint">Which sources are usable, proxy, stale, or missing</span>
        </div>
      </div>
      {!data?.available ? (
        <div className="market-agent-empty-state">{data?.message || "Provider health is unavailable."}</div>
      ) : (
        <div className="market-agent-provider-health-layout">
          <div className="market-agent-provider-summary-strip">
            <article>
              <span>Live spot</span>
              <strong>{liveCount}</strong>
            </article>
            <article>
              <span>Proxy sources</span>
              <strong>{proxyCount}</strong>
            </article>
            <article>
              <span>Needs attention</span>
              <strong>{issueCount}</strong>
            </article>
          </div>
          <div className="market-agent-provider-card-grid">
            {providerCards.map((card) => {
              const item = findProviderHealth(data.items, card.keys);
              return (
                <article className="market-agent-provider-card" key={card.title}>
                  <div className="market-agent-provider-card-head">
                    <div>
                      <h3>{card.title}</h3>
                      <span>{item ? formatValue(item.source, card.title) : "Not configured"}</span>
                    </div>
                    <MarketAgentStatusBadge label={statusForItem(item)} />
                  </div>
                  <p>{providerGuidance(item)}</p>
                  <div className="market-agent-provider-meta">
                    <span>Last data: {formatShortTime(item?.data_timestamp)}</span>
                    <span>Fetched: {formatShortTime(item?.fetched_at)}</span>
                  </div>
                  <div className="market-agent-provider-action">{card.action}</div>
                </article>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
