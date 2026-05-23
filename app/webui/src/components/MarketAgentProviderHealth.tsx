import type { MarketAgentProviderHealthEntry, MarketAgentProviderHealthResponse } from "../types";
import { MarketAgentStatusBadge } from "./MarketAgentStatusBadge";
import {
  formatShortTime,
  humanizeMarketAgentValue,
  normalizeMarketAgentValue
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

const statusForItem = (item: MarketAgentProviderHealthEntry | undefined) => {
  if (!item) return "Waiting";
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

const toneForStatus = (status: string): "neutral" | "good" | "warn" | "bad" | "info" => {
  const normalized = normalizeMarketAgentValue(status);
  if (["connected", "available", "live data", "ready", "built in", "built-in"].includes(normalized)) return "good";
  if (["proxy", "proxy only", "backup only", "partial", "not connected", "waiting", "collecting"].includes(normalized)) return "warn";
  if (["unavailable", "stale data", "missing"].includes(normalized)) return "bad";
  return "neutral";
};

const itemMatches = (item: MarketAgentProviderHealthEntry, keys: string[]) => {
  const haystack = [
    item.provider_key,
    item.source,
    item.source_type,
    item.raw_source_id,
    item.data_mode
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return keys.some((key) => haystack.includes(key.toLowerCase()));
};

const findItems = (items: MarketAgentProviderHealthEntry[], keys: string[]) =>
  items.filter((item) => itemMatches(item, keys));

const countUsable = (items: MarketAgentProviderHealthEntry[]) =>
  items.filter((item) => item.is_available && !item.is_stale && normalizeMarketAgentValue(item.data_mode) !== "unavailable").length;

const newestTime = (items: MarketAgentProviderHealthEntry[]) =>
  {
    const times = items
    .map((item) => item.fetched_at || item.data_timestamp)
    .filter(Boolean)
      .sort();
    return times.length ? times[times.length - 1] : undefined;
  };

const providerSubtitle = (items: MarketAgentProviderHealthEntry[]) => {
  if (!items.length) return "Not connected";
  const names = Array.from(new Set(items.map((item) => formatValue(item.source, "Provider")).filter(Boolean)));
  return names.slice(0, 2).join(", ") || "Configured";
};

export function MarketAgentProviderHealth({ data }: MarketAgentProviderHealthProps) {
  const items = data?.items ?? [];
  const ctraderItems = findItems(items, ["ctrader", "ctrader_cli", "spot"]);
  const yahooItems = findItems(items, ["yahoo", "gc=f", "futures_proxy", "proxy"]);
  const calendarItems = findItems(items, ["calendar", "forexfactory", "forex_factory"]);
  const newsItems = findItems(items, ["rss", "news", "google_news"]);
  const marketContextItems = findItems(items, [
    "dxy",
    "dx-y.nyb",
    "us10y",
    "^tnx",
    "us2y",
    "wti",
    "brent",
    "oil",
    "vix",
    "spx",
    "nasdaq",
    "^gspc",
    "^ixic"
  ]);
  const ctraderReady = ctraderItems.some((item) => item.is_available && !item.is_stale);
  const proxyReady = yahooItems.some((item) => item.is_available && !item.is_stale);
  const blockingIssueCount = ctraderReady ? 0 : 1;
  const usableCount = countUsable(items);
  const providerRows = [
    {
      title: "cTrader",
      subtitle: ctraderItems.length ? providerSubtitle(ctraderItems) : "Primary price provider",
      status: ctraderReady ? "Connected" : "Not connected",
      description: "Primary live XAUUSD price and broker history.",
      updatedAt: newestTime(ctraderItems),
      action: ctraderReady ? "Ready for live monitoring." : "Connect cTrader in Data Sources.",
      items: ctraderItems
    },
    {
      title: "Cross-market sensors",
      subtitle: marketContextItems.length ? `${countUsable(marketContextItems)} of ${marketContextItems.length} feeds usable` : "Automatic feeds",
      status:
        marketContextItems.length === 0
          ? "Waiting"
          : countUsable(marketContextItems) === marketContextItems.length
            ? "Available"
            : countUsable(marketContextItems) > 0
              ? "Partial"
              : "Unavailable",
      description: "USD, yields, risk, oil, and related markets used only when fresh.",
      updatedAt: newestTime(marketContextItems),
      action: "Missing context is ignored instead of becoming evidence.",
      items: marketContextItems
    },
    {
      title: "Calendar",
      subtitle: calendarItems.length ? providerSubtitle(calendarItems) : "Economic calendar",
      status: countUsable(calendarItems) > 0 ? "Available" : "Built-in",
      description: "Built into the app. Calendar events become evidence only when timing and market reaction agree.",
      updatedAt: newestTime(calendarItems),
      action: "Waiting for a relevant event window.",
      items: calendarItems
    },
    {
      title: "News collector",
      subtitle: newsItems.length ? providerSubtitle(newsItems) : "Automatic headlines",
      status: countUsable(newsItems) > 0 ? "Available" : "Collecting",
      description: "Built into the app. Headlines stay as context until repeated, fresh, and market-confirmed.",
      updatedAt: newestTime(newsItems),
      action: "No market-confirmed headline in the latest snapshot.",
      items: newsItems
    },
    {
      title: "Yahoo proxy",
      subtitle: yahooItems.length ? providerSubtitle(yahooItems) : "Backup price provider",
      status: proxyReady ? "Proxy only" : "Backup only",
      description: "Backup futures proxy when true spot is unavailable.",
      updatedAt: newestTime(yahooItems),
      action: "Not used for current conclusions while cTrader is required.",
      items: yahooItems
    }
  ];

  return (
    <section className="market-agent-surface" data-qa="qa:market-agent:provider-health">
      <div className="market-agent-surface-header">
        <div>
          <h2>Provider Health</h2>
          <span className="hint">Main data providers and whether they are usable</span>
        </div>
      </div>
      {!data?.available ? (
        <div className="market-agent-empty-state">{data?.message || "Provider health is unavailable."}</div>
      ) : (
        <div className="market-agent-provider-health-layout">
          <div className="market-agent-provider-health-hero">
            <article className={ctraderReady ? "ready" : proxyReady ? "proxy" : "attention"}>
              <span>Price feed</span>
              <strong>{ctraderReady ? "cTrader live" : proxyReady ? "Proxy only" : "Connect cTrader"}</strong>
              <p>
                {ctraderReady
                  ? "Live XAUUSD is coming from the primary provider."
                  : proxyReady
                    ? "The app can show a futures proxy, but live monitoring needs cTrader."
                    : "Live monitoring starts after cTrader is connected."}
              </p>
            </article>
            <article>
              <span>Context feeds</span>
              <strong>{usableCount}</strong>
              <p>Fresh inputs collected for evidence checks.</p>
            </article>
            <article className={blockingIssueCount > 0 ? "attention" : "ready"}>
              <span>Blocking setup</span>
              <strong>{blockingIssueCount}</strong>
              <p>{ctraderReady ? "Nothing is blocking live monitoring." : "Connect cTrader before current conclusions are shown."}</p>
            </article>
          </div>
          <div className="market-agent-provider-list">
            {providerRows.map((row) => (
              <article className="market-agent-provider-row" key={row.title}>
                <div className="market-agent-provider-row-main">
                  <div>
                    <h3>{row.title}</h3>
                    <span>{row.subtitle}</span>
                  </div>
                  <p>{row.description}</p>
                </div>
                <div className="market-agent-provider-row-state">
                  <MarketAgentStatusBadge label={row.status} tone={toneForStatus(row.status)} />
                  <span>{row.updatedAt ? `Updated ${formatShortTime(row.updatedAt)}` : row.action}</span>
                </div>
              </article>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
