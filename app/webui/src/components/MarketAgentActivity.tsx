import type {
  MarketAgentActivityStatus,
  MarketAgentEvidenceForRunResponse,
  MarketAgentLLMConfigResponse,
  MarketAgentMonitorStatusResponse,
  MarketAgentProviderConfigResponse,
  MarketAgentProviderHealthResponse,
  MarketAgentReplayPayload,
  MarketAgentReplayResponse,
  MarketAgentTelegramConfigResponse
} from "../types";
import {
  findProviderHealth,
  formatShortTime,
  humanizeMarketAgentValue,
  normalizeMarketAgentValue
} from "../utils/marketAgentUi";
import "./MarketAgentActivity.css";

type ActivityKey = "ctrader" | "history" | "context" | "evidence" | "llm" | "replay" | "alerts";

type ActivityStage = {
  key: ActivityKey;
  eyebrow: string;
  title: string;
  fallbackLabel: string;
  fallbackDetail: string;
  fallbackStatus: string;
  chips: string[];
};

type MarketAgentActivityProps = {
  monitorStatus: MarketAgentMonitorStatusResponse | null;
  providerHealth: MarketAgentProviderHealthResponse | null;
  replay: MarketAgentReplayResponse | null;
  selectedEvidence: MarketAgentEvidenceForRunResponse | null;
  providerConfig: MarketAgentProviderConfigResponse | null;
  telegramConfig: MarketAgentTelegramConfigResponse | null;
  llmConfig: MarketAgentLLMConfigResponse | null;
};

const textValue = (entry: MarketAgentActivityStatus | undefined, key: string) => {
  const value = entry?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : "";
};

const numberValue = (entry: MarketAgentActivityStatus | undefined, key: string) => {
  const value = entry?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const listValue = (entry: MarketAgentActivityStatus | undefined, key: string) => {
  const value = entry?.[key];
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean);
};

const recordValue = (entry: MarketAgentActivityStatus | undefined, key: string) => {
  const value = entry?.[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
};

const unique = (items: string[]) => Array.from(new Set(items.filter(Boolean)));

const formatBytes = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "--";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
};

const recordNumberValue = (entry: Record<string, unknown>, key: string) => {
  const value = entry[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const toneForStatus = (status: string) => {
  const normalized = normalizeMarketAgentValue(status);
  if (["live", "active", "ready", "validated", "synced", "stored", "sent"].includes(normalized)) return "good";
  if (["checking", "collecting", "syncing", "preparing", "queued", "market_closed", "partial"].includes(normalized)) return "working";
  if (["context_only", "suppressed", "idle", "skipped", "pending"].includes(normalized)) return "muted";
  if (["unavailable", "failed", "error", "blocked"].includes(normalized)) return "bad";
  return "muted";
};

const compactChip = (label: string, value: unknown) => {
  const text = typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
  return text ? `${label}: ${text}` : "";
};

const userFacingStatus = (value: string) => {
  const normalized = normalizeMarketAgentValue(value);
  if (normalized === "disabled") return "Dashboard only";
  if (normalized === "not_applicable") return "Not needed";
  return value;
};

const replayStats = (payload: MarketAgentReplayPayload | undefined) => {
  const priceRows = payload?.price_series ?? [];
  const related = Object.entries(payload?.related_assets ?? {});
  const relatedRows = related.reduce((total, [, rows]) => total + rows.length, 0);
  const relatedSymbols = related.filter(([, rows]) => rows.length > 0).map(([symbol]) => symbol.toUpperCase());
  const priceSymbols = priceRows.map((row) => String(row.symbol || "XAUUSD").toUpperCase());
  const symbols = unique([...priceSymbols, ...relatedSymbols]);
  const times = [
    ...priceRows.map((row) => String(row.data_timestamp || "")),
    ...(payload?.news_items ?? []).map((row) => String(row.published_at || "")),
    ...(payload?.calendar_events ?? []).map((row) => String(row.scheduled_at || ""))
  ].filter(Boolean).sort();
  const payloadBytes = payload ? JSON.stringify(payload).length : 0;
  return {
    priceRows: priceRows.length,
    relatedRows,
    newsRows: payload?.news_items?.length ?? 0,
    calendarRows: payload?.calendar_events?.length ?? 0,
    timelineEvents: payload?.timeline_events?.length ?? 0,
    alerts: (payload?.alerts?.length ?? 0) + (payload?.suppressed_alerts?.length ?? 0),
    symbols,
    start: times[0] || "",
    end: times[times.length - 1] || "",
    payloadBytes
  };
};

const storedCount = (stored: Record<string, unknown>, key: string, fallback: number) => {
  const value = stored[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
};

export function MarketAgentActivity({
  monitorStatus,
  providerHealth,
  replay,
  selectedEvidence,
  providerConfig,
  telegramConfig,
  llmConfig
}: MarketAgentActivityProps) {
  const activity = monitorStatus?.activity ?? {};
  const xauusdHealth = findProviderHealth(providerHealth?.items, ["xauusd", "gc=f", "xauusd price"]);
  const stats = replayStats(replay?.replay);
  const replayEntry = activity.replay;
  const stored = recordValue(replayEntry, "stored");
  const storageSummary = recordValue(replayEntry, "storageSummary");
  const storageCounts = recordValue(storageSummary, "counts");
  const storageCompaction = recordValue(storageSummary, "compaction");
  const cTraderEntry = activity.ctrader;
  const historyEntry = activity.history;
  const contextEntry = activity.context;
  const evidenceEntry = activity.evidence;
  const llmEntry = activity.llm;
  const alertEntry = activity.alerts;
  const phaseLabel = humanizeMarketAgentValue(monitorStatus?.phase || (monitorStatus?.running ? "running" : "stopped"));
  const phaseMessage = monitorStatus?.message || (monitorStatus?.running ? "Agent is checking the market." : "Agent is idle.");
  const cTraderLive = Boolean(xauusdHealth?.is_available && !xauusdHealth.is_stale);
  const cTraderClosed = Boolean(xauusdHealth?.is_available && xauusdHealth.is_stale && xauusdHealth.current_value != null);
  const contextNewsCount = numberValue(contextEntry, "newsCount") ?? stats.newsRows;
  const contextCalendarCount = numberValue(contextEntry, "calendarCount") ?? stats.calendarRows;
  const selectedEvidencePacket = selectedEvidence?.payload?.evidence_packet as Record<string, unknown> | undefined;
  const evidenceChain = selectedEvidencePacket?.evidence_chain_status as Record<string, unknown> | undefined;

  const stages: ActivityStage[] = [
    {
      key: "ctrader",
      eyebrow: "1 · LIVE",
      title: "cTrader live",
      fallbackStatus: cTraderLive ? "live" : cTraderClosed ? "market_closed" : providerConfig?.ctrader?.enabled ? "checking" : "waiting",
      fallbackLabel: cTraderLive ? "XAUUSD live" : cTraderClosed ? "Market closed" : "Waiting for XAUUSD",
      fallbackDetail: cTraderLive
        ? "Latest XAUUSD quote is available."
        : cTraderClosed
          ? "Last XAUUSD price is fixed; news and calendar continue."
          : "Connect cTrader to start the live XAUUSD feed.",
      chips: unique([
        ...listValue(cTraderEntry, "symbols"),
        compactChip("Source", textValue(cTraderEntry, "source") || "cTrader"),
        compactChip("Mode", textValue(cTraderEntry, "dataMode") || xauusdHealth?.data_mode || ""),
        compactChip("Time", formatShortTime(textValue(cTraderEntry, "dataTimestamp") || xauusdHealth?.data_timestamp || ""))
      ])
    },
    {
      key: "history",
      eyebrow: "2 · HISTORY",
      title: "History sync",
      fallbackStatus: monitorStatus?.running ? "syncing" : "idle",
      fallbackLabel: "History current",
      fallbackDetail: "Backfill runs after the current live check and stores replay data.",
      chips: unique([
        ...listValue(historyEntry, "symbols").slice(0, 4),
        compactChip("Rows", numberValue(historyEntry, "storedRows") ?? stats.priceRows + stats.relatedRows),
        compactChip("From", formatShortTime(textValue(historyEntry, "windowStart"))),
        compactChip("To", formatShortTime(textValue(historyEntry, "windowEnd")))
      ])
    },
    {
      key: "context",
      eyebrow: "3 · CONTEXT",
      title: "Market context",
      fallbackStatus: contextNewsCount || contextCalendarCount ? "active" : "collecting",
      fallbackLabel: "News and calendar",
      fallbackDetail: `${contextNewsCount} headlines and ${contextCalendarCount} calendar events loaded for this range.`,
      chips: unique([
        compactChip("News", contextNewsCount),
        compactChip("Calendar", contextCalendarCount),
        ...listValue(contextEntry, "sources").slice(0, 3),
        compactChip("Latest", formatShortTime(textValue(contextEntry, "latestNewsAt") || textValue(contextEntry, "latestCalendarAt")))
      ])
    },
    {
      key: "evidence",
      eyebrow: "4 · GATE",
      title: "Evidence gate",
      fallbackStatus: String(evidenceChain?.status || "pending"),
      fallbackLabel: "Evidence gate",
      fallbackDetail: String(evidenceChain?.reason || "Provider health, price history, drivers, and context are validated before conclusions."),
      chips: unique([
        compactChip("Status", textValue(evidenceEntry, "chainStatus") || String(evidenceChain?.status || "")),
        compactChip("Usable", listValue(evidenceEntry, "usableInputs").length || (Array.isArray(evidenceChain?.usable_inputs) ? evidenceChain.usable_inputs.length : "")),
        compactChip("Missing", listValue(evidenceEntry, "missingRequired").length || (Array.isArray(evidenceChain?.missing_required) ? evidenceChain.missing_required.length : "")),
        compactChip("Blocked", listValue(evidenceEntry, "blockedDrivers").length)
      ])
    },
    {
      key: "llm",
      eyebrow: "5 · AI",
      title: "Local AI review",
      fallbackStatus: llmConfig?.llm?.enabled ? "queued" : "skipped",
      fallbackLabel: llmConfig?.llm?.enabled ? "Local AI queued" : "Rule-based",
      fallbackDetail: llmConfig?.llm?.enabled
        ? "Local AI can summarize only after deterministic evidence gates."
        : "Rule-based evidence remains active when Local AI is off.",
      chips: unique([
        compactChip("Model", textValue(llmEntry, "model") || llmConfig?.llm?.model || ""),
        compactChip("Engine", textValue(llmEntry, "analysisEngine")),
        compactChip("Result", textValue(llmEntry, "result")),
        compactChip("Cause", textValue(llmEntry, "causeStatus"))
      ])
    },
    {
      key: "replay",
      eyebrow: "6 · STORE",
      title: "Replay store",
      fallbackStatus: stats.priceRows || stats.newsRows || stats.calendarRows ? "stored" : "pending",
      fallbackLabel: "TimelineStore",
      fallbackDetail: replayEntry?.detail || "SQLite stores the run, evidence packet, replay rows, state transition, and alert decision.",
      chips: unique([
        compactChip("Run", textValue(replayEntry, "monitorRunId") || monitorStatus?.latestMonitorRunId || ""),
        compactChip("Price", storedCount(stored, "marketPriceBars", stats.priceRows)),
        compactChip("News", storedCount(stored, "newsItems", stats.newsRows)),
        compactChip("Events", storedCount(stored, "calendarEvents", stats.calendarRows))
      ])
    },
    {
      key: "alerts",
      eyebrow: "7 · ALERT",
      title: "Alert queue",
      fallbackStatus: telegramConfig?.telegram?.enabled ? "ready" : "idle",
      fallbackLabel: telegramConfig?.telegram?.enabled ? "Telegram ready" : "Dashboard only",
      fallbackDetail: "Only current live runs that pass preflight and notification policy can send Telegram.",
      chips: unique([
        compactChip("Preflight", textValue(alertEntry, "preflightStatus")),
        compactChip("Telegram", userFacingStatus(textValue(alertEntry, "telegramStatus") || telegramConfig?.telegram?.lastSendStatus || "")),
        compactChip("Level", textValue(alertEntry, "notificationLevel"))
      ])
    }
  ];

  const loadedRange = replay?.start && replay?.end
    ? `${formatShortTime(replay.start)} -> ${formatShortTime(replay.end)}`
    : stats.start && stats.end
      ? `${formatShortTime(stats.start)} -> ${formatShortTime(stats.end)}`
      : "No replay range loaded";
  const timelineStorePath =
    textValue(replayEntry, "timelineStorePath") ||
    String(storageSummary.path || "") ||
    replay?.timeline_store_path ||
    selectedEvidence?.timeline_store_path ||
    "TimelineStore not loaded";
  const databaseBytes = recordNumberValue(storageSummary, "databaseBytes");
  const storageMode = humanizeMarketAgentValue(String(storageCompaction.mode || "indexed_range_reads"));
  const compactionStatus = humanizeMarketAgentValue(String(storageCompaction.status || "not_needed"));

  return (
    <section className="market-agent-activity-surface" aria-label="Agent activity pipeline">
      <div className="market-agent-activity-hero">
        <div>
          <h2>Agent Activity</h2>
          <p>{phaseMessage}</p>
        </div>
        <span>{phaseLabel}</span>
      </div>

      <div className="market-agent-activity-pipeline">
        {stages.map((stage) => {
          const entry = activity[stage.key];
          const status = textValue(entry, "status") || stage.fallbackStatus;
          const label = textValue(entry, "label") || stage.fallbackLabel;
          const detail = textValue(entry, "detail") || stage.fallbackDetail;
          const progress = numberValue(entry, "progress");
          return (
            <article className={`market-agent-activity-stage tone-${toneForStatus(status)}`} key={stage.key}>
              <div className="market-agent-activity-stage-top">
                <span>{stage.eyebrow}</span>
                <em>{humanizeMarketAgentValue(status)}</em>
              </div>
              <strong>{stage.title}</strong>
              <span className="market-agent-activity-stage-label">{label}</span>
              <p>{detail}</p>
              {progress !== null ? (
                <div className="market-agent-activity-stage-progress" aria-label={`${stage.title} progress ${progress}%`}>
                  <span style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} />
                  <b>{Math.round(progress)}%</b>
                </div>
              ) : null}
              <div className="market-agent-activity-chip-row">
                {stage.chips.filter(Boolean).slice(0, 5).map((chip) => (
                  <small key={chip}>{chip}</small>
                ))}
              </div>
            </article>
          );
        })}
      </div>

      <div className="market-agent-activity-bottom">
        <section className="market-agent-activity-store">
          <div>
            <span>Data persisted</span>
            <h3>TimelineStore</h3>
            <p>{timelineStorePath}</p>
          </div>
          <dl>
            <div>
              <dt>Loaded range</dt>
              <dd>{loadedRange}</dd>
            </div>
            <div>
              <dt>Symbols</dt>
              <dd>{stats.symbols.length ? stats.symbols.slice(0, 8).join(", ") : "Waiting"}</dd>
            </div>
            <div>
              <dt>Price bars</dt>
              <dd>{storedCount(stored, "marketPriceBars", stats.priceRows)}</dd>
            </div>
            <div>
              <dt>Related bars</dt>
              <dd>{storedCount(stored, "relatedAssetBars", stats.relatedRows)}</dd>
            </div>
            <div>
              <dt>News</dt>
              <dd>{storedCount(stored, "newsItems", stats.newsRows)}</dd>
            </div>
            <div>
              <dt>Calendar</dt>
              <dd>{storedCount(stored, "calendarEvents", stats.calendarRows)}</dd>
            </div>
            <div>
              <dt>Stored runs</dt>
              <dd>{storedCount(storageCounts, "monitorRuns", 0)}</dd>
            </div>
            <div>
              <dt>Total news</dt>
              <dd>{storedCount(storageCounts, "newsItems", storedCount(stored, "newsItems", stats.newsRows))}</dd>
            </div>
            <div>
              <dt>Replay payload</dt>
              <dd>{formatBytes(stats.payloadBytes)}</dd>
            </div>
            <div>
              <dt>Database size</dt>
              <dd>{databaseBytes === null ? "--" : formatBytes(databaseBytes)}</dd>
            </div>
            <div>
              <dt>Storage mode</dt>
              <dd>{storageMode}</dd>
            </div>
            <div>
              <dt>Compaction</dt>
              <dd>{compactionStatus}</dd>
            </div>
          </dl>
        </section>

        <section className="market-agent-activity-loop">
          <span>Where it appears</span>
          <ol>
            <li><strong>Dashboard</strong><small>current result after the evidence gate</small></li>
            <li><strong>Evidence</strong><small>packet, provider health, blocked drivers, and validation result</small></li>
            <li><strong>Replay</strong><small>price, related assets, news, calendar, state transitions, and alerts</small></li>
            <li><strong>Telegram</strong><small>alerts only after preflight and notification policy pass</small></li>
          </ol>
        </section>
      </div>
    </section>
  );
}
