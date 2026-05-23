import type { ReactNode } from "react";
import type {
  MarketAgentActivityJob,
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

type ActivityNode = {
  id: string;
  owner: string;
  title: string;
  status: string;
  detail: string;
  input: string;
  output: string;
  target: string;
  timestamp?: string;
};

type ActivitySection = {
  id: string;
  step: string;
  title: string;
  detail: string;
  status: string;
  nodes: ActivityNode[];
  wide?: ReactNode;
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

const jobsValue = (entry: MarketAgentActivityStatus | undefined): MarketAgentActivityJob[] =>
  Array.isArray(entry?.jobs) ? entry.jobs : [];

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

const storedCount = (stored: Record<string, unknown>, key: string, fallback: number) => {
  const value = stored[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
};

const statusTone = (status: string) => {
  const normalized = normalizeMarketAgentValue(status);
  if (["live", "active", "ready", "validated", "synced", "stored", "sent", "approved", "rewritten"].includes(normalized)) return "good";
  if (["checking", "collecting", "syncing", "preparing", "queued", "market_closed", "partial", "stale"].includes(normalized)) return "working";
  if (["unavailable", "failed", "error", "blocked"].includes(normalized)) return "bad";
  return "muted";
};

const compactChip = (label: string, value: unknown) => {
  const text = typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
  return text ? `${label}: ${text}` : "";
};

const normalizeStatusLabel = (value: string) => {
  const normalized = normalizeMarketAgentValue(value);
  if (normalized === "disabled") return "Dashboard only";
  if (normalized === "not_applicable") return "Not needed";
  return humanizeMarketAgentValue(value);
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

const jobField = (job: MarketAgentActivityJob, key: keyof MarketAgentActivityJob) => {
  const value = job[key];
  return typeof value === "string" && value.trim() ? value.trim() : "";
};

const jobMetaList = (job: MarketAgentActivityJob | undefined, key: string) => {
  const value = job?.meta?.[key];
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean);
};

const entryStatus = (entry: MarketAgentActivityStatus | undefined, fallback: string) => textValue(entry, "status") || fallback;

const firstJob = (entry: MarketAgentActivityStatus | undefined, title: string) =>
  jobsValue(entry).find((job) => normalizeMarketAgentValue(job.title || "") === normalizeMarketAgentValue(title));

const nodeFromJob = ({
  id,
  owner,
  entry,
  jobTitle,
  fallbackTitle,
  fallbackStatus,
  fallbackDetail,
  fallbackInput,
  fallbackOutput,
  target,
  includeEntryDetail
}: {
  id: string;
  owner: string;
  entry: MarketAgentActivityStatus | undefined;
  jobTitle: string;
  fallbackTitle?: string;
  fallbackStatus: string;
  fallbackDetail: string;
  fallbackInput: string;
  fallbackOutput: string;
  target: string;
  includeEntryDetail?: boolean;
}): ActivityNode => {
  const job = firstJob(entry, jobTitle);
  const entryDetail = includeEntryDetail ? textValue(entry, "detail") : "";
  const detail = [entryDetail, job?.detail || fallbackDetail].filter(Boolean);
  return {
    id,
    owner,
    title: job?.title || fallbackTitle || jobTitle,
    status: job?.status || entryStatus(entry, fallbackStatus),
    detail: unique(detail).join(" "),
    input: jobField(job || {}, "input") || fallbackInput,
    output: jobField(job || {}, "output") || fallbackOutput,
    target,
    timestamp: job?.timestamp
  };
};

function ActivityNodeCard({ node, index }: { node: ActivityNode; index: number }) {
  return (
    <article className={`market-agent-activity-node tone-${statusTone(node.status)}`}>
      <header>
        <span>{String(index + 1).padStart(2, "0")}</span>
        <div>
          <small>{node.owner}</small>
          <strong>{node.title}</strong>
        </div>
        <em>{normalizeStatusLabel(node.status)}</em>
      </header>
      <p>{node.detail}</p>
      <div className="market-agent-activity-node-io">
        <span>
          <b>Receives</b>
          {node.input || "--"}
        </span>
        <span>
          <b>Produces</b>
          {node.output || "--"}
        </span>
        <span>
          <b>Sends to</b>
          {node.target || "--"}
        </span>
      </div>
      {node.timestamp ? <time>{formatShortTime(node.timestamp)}</time> : null}
    </article>
  );
}

function ActivitySectionBlock({ section }: { section: ActivitySection }) {
  return (
    <section className={`market-agent-activity-section section-${section.id}`}>
      <header className="market-agent-activity-section-head">
        <span>{section.step}</span>
        <div>
          <h3>{section.title}</h3>
          <p>{section.detail}</p>
        </div>
        <em>{normalizeStatusLabel(section.status)}</em>
      </header>
      {section.wide}
      <div className="market-agent-activity-node-list">
        {section.nodes.map((node, index) => (
          <ActivityNodeCard node={node} index={index} key={node.id} />
        ))}
      </div>
    </section>
  );
}

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
  const cTraderEntry = activity.ctrader;
  const historyEntry = activity.history;
  const contextEntry = activity.context;
  const evidenceEntry = activity.evidence;
  const llmEntry = activity.llm;
  const replayEntry = activity.replay;
  const alertEntry = activity.alerts;
  const summaryEntry = activity.summary;
  const stored = recordValue(replayEntry, "stored");
  const storageSummary = recordValue(replayEntry, "storageSummary");
  const storageCounts = recordValue(storageSummary, "counts");
  const storageRanges = recordValue(storageSummary, "ranges");
  const storageCompaction = recordValue(storageSummary, "compaction");
  const providerChain = Array.isArray(cTraderEntry?.providerChain) ? cTraderEntry.providerChain : [];
  const phaseLabel = humanizeMarketAgentValue(monitorStatus?.phase || (monitorStatus?.running ? "running" : "stopped"));
  const phaseMessage = monitorStatus?.message || (monitorStatus?.running ? "Agent is checking the market." : "Agent is idle.");
  const cTraderLive = Boolean(xauusdHealth?.is_available && !xauusdHealth.is_stale);
  const cTraderClosed = Boolean(xauusdHealth?.is_available && xauusdHealth.is_stale && xauusdHealth.current_value != null);
  const contextNewsCount = numberValue(contextEntry, "newsCount") ?? stats.newsRows;
  const contextCalendarCount = numberValue(contextEntry, "calendarCount") ?? stats.calendarRows;
  const selectedEvidencePacket = selectedEvidence?.payload?.evidence_packet as Record<string, unknown> | undefined;
  const evidenceChain = selectedEvidencePacket?.evidence_chain_status as Record<string, unknown> | undefined;
  const databaseBytes = recordNumberValue(storageSummary, "databaseBytes");
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
  const symbols = unique([
    ...listValue(cTraderEntry, "symbols"),
    ...listValue(historyEntry, "symbols"),
    ...listValue(replayEntry, "symbols"),
    ...stats.symbols
  ]);
  const cTraderStatus = entryStatus(cTraderEntry, cTraderLive ? "live" : cTraderClosed ? "market_closed" : providerConfig?.ctrader?.enabled ? "checking" : "waiting");
  const historyStatus = entryStatus(historyEntry, monitorStatus?.running ? "syncing" : "idle");
  const historyProgress = numberValue(historyEntry, "progress");
  const historyProgressLabel = historyProgress === null ? "" : `${Math.round(historyProgress)}%`;
  const contextStatus = entryStatus(contextEntry, contextNewsCount || contextCalendarCount ? "active" : "collecting");
  const evidenceStatus = entryStatus(evidenceEntry, String(evidenceChain?.status || "pending"));
  const llmStatus = entryStatus(llmEntry, llmConfig?.llm?.enabled ? "queued" : "skipped");
  const replayStatus = entryStatus(replayEntry, stats.priceRows || stats.newsRows || stats.calendarRows ? "stored" : "pending");
  const alertStatus = entryStatus(alertEntry, telegramConfig?.telegram?.enabled ? "ready" : "idle");
  const newsJob = firstJob(contextEntry, "News collector");
  const calendarJob = firstJob(contextEntry, "Calendar collector");
  const alertReviewJob = firstJob(llmEntry, "Alert review hook");
  const newsSources = unique([
    ...listValue(contextEntry, "sources"),
    ...jobMetaList(newsJob, "sources"),
    ...jobMetaList(calendarJob, "sources")
  ]);
  const newsSamples = unique([...listValue(contextEntry, "newsSamples"), ...jobMetaList(newsJob, "samples")]).slice(0, 6);
  const calendarSamples = unique([...listValue(contextEntry, "calendarSamples"), ...jobMetaList(calendarJob, "samples")]).slice(0, 4);
  const inputNodes: ActivityNode[] = [
    {
      id: "ctrader-live",
      owner: "cTrader",
      title: "XAUUSD live feed",
      status: cTraderStatus,
      detail: textValue(cTraderEntry, "detail") || "Waiting for the latest XAUUSD spot quote.",
      input: compactChip("Provider", textValue(cTraderEntry, "selectedProvider") || textValue(cTraderEntry, "source") || "cTrader"),
      output: textValue(cTraderEntry, "handoff") || "Live price feeds move detection, evidence, replay, and alert preflight.",
      target: "Move detector + Evidence gate",
      timestamp: textValue(cTraderEntry, "dataTimestamp") || String(xauusdHealth?.data_timestamp || "")
    },
    nodeFromJob({
      id: "history-fetch",
      owner: "cTrader",
      entry: historyEntry,
      jobTitle: "History fetch",
      fallbackTitle: "History backfill",
      fallbackStatus: historyStatus,
      fallbackDetail: textValue(historyEntry, "detail") || "History fills replay and evidence gaps without blocking the live quote.",
      fallbackInput: loadedRange,
      fallbackOutput: `${historyProgressLabel ? `${historyProgressLabel} / ` : ""}${numberValue(historyEntry, "storedRows") ?? stats.priceRows + stats.relatedRows} stored row(s)`,
      target: "TimelineStore + move detector"
    }),
    nodeFromJob({
      id: "calendar-collector",
      owner: "Context",
      entry: contextEntry,
      jobTitle: "Calendar collector",
      fallbackStatus: contextStatus,
      fallbackDetail: `${contextCalendarCount} calendar event(s) loaded around the analysis window.`,
      fallbackInput: "App-managed economic calendar",
      fallbackOutput: `${contextCalendarCount} calendar event(s)`,
      target: "Context fixture + Evidence packet"
    }),
    {
      id: "provider-chain",
      owner: "Sensors",
      title: "Provider chain",
      status: cTraderStatus,
      detail: providerChain.length ? `${providerChain.length} provider check(s) reported for the XAUUSD source path.` : "Provider checks have not reported yet.",
      input: "cTrader spot, market proxies, provider health",
      output: providerChain.length
        ? providerChain
            .slice(0, 3)
            .map((item) => {
              const row = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
              const status = row.is_available && !row.is_stale ? "ready" : row.is_stale ? "stale" : "unavailable";
              return `${humanizeMarketAgentValue(String(row.provider || "provider"))}: ${normalizeStatusLabel(status)}`;
            })
            .join(" / ")
        : "Waiting for provider health",
      target: "Evidence readiness"
    }
  ];

  const processingNodes: ActivityNode[] = [
    nodeFromJob({
      id: "context-fixture",
      owner: "Normalize",
      entry: contextEntry,
      jobTitle: "Context fixture",
      fallbackStatus: contextStatus,
      fallbackDetail: `${contextNewsCount} headlines and ${contextCalendarCount} calendar events are normalized into the scenario fixture before evidence and AI review.`,
      fallbackInput: "News rows + calendar rows",
      fallbackOutput: "ScenarioFixture.news and ScenarioFixture.calendar_events",
      target: "Evidence packet"
    }),
    nodeFromJob({
      id: "input-readiness",
      owner: "Gate",
      entry: evidenceEntry,
      jobTitle: "Input readiness",
      fallbackStatus: evidenceStatus,
      fallbackDetail: textValue(evidenceEntry, "detail") || "Checks whether live price, recent history, related sensors, news, and calendar are usable.",
      fallbackInput: "Provider health + price history + market context",
      fallbackOutput: `${listValue(evidenceEntry, "usableInputs").length} usable / ${listValue(evidenceEntry, "missingRequired").length} missing`,
      target: "Evidence gate"
    }),
    nodeFromJob({
      id: "cross-market-sensors",
      owner: "Sensors",
      entry: evidenceEntry,
      jobTitle: "Cross-market sensors",
      fallbackStatus: evidenceStatus,
      fallbackDetail: "Classifies related sensors as confirming, contradicting, stale, unavailable, or background.",
      fallbackInput: "Related asset rows + provider health",
      fallbackOutput: "Sensor status map",
      target: "DriverAttention"
    }),
    nodeFromJob({
      id: "driver-attention",
      owner: "Attention",
      entry: evidenceEntry,
      jobTitle: "Driver attention",
      fallbackStatus: evidenceStatus,
      fallbackDetail: "Known drivers and dynamic themes move between watching, emerging, active, cooling, and retired.",
      fallbackInput: "Evidence status + previous driver states + headlines",
      fallbackOutput: `${listValue(evidenceEntry, "allowedCandidateDrivers").length} allowed candidate(s)`,
      target: "Candidate driver gate"
    }),
    nodeFromJob({
      id: "candidate-gate",
      owner: "Gate",
      entry: evidenceEntry,
      jobTitle: "Candidate driver gate",
      fallbackStatus: evidenceStatus,
      fallbackDetail: "Only allowed candidate drivers can be used by rule or LLM analysis.",
      fallbackInput: "Driver attention states + evidence gates",
      fallbackOutput: `${listValue(evidenceEntry, "allowedCandidateDrivers").length} allowed / ${Object.keys(recordValue(evidenceEntry, "blockedDrivers")).length} blocked`,
      target: "Rule baseline + Local AI"
    }),
  ];

  const aiNodes: ActivityNode[] = [
    {
      id: "headline-grouping",
      owner: "AI / Rules",
      title: "Headline grouping",
      status: contextStatus,
      detail: "Groups repeated headlines into possible themes before anything is allowed to become a market driver.",
      input: `${contextNewsCount} headline(s) from ${newsSources.length || "app-managed"} source(s)`,
      output: "Theme candidates for DriverAttention",
      target: "Evidence summary + Candidate driver gate",
      timestamp: textValue(contextEntry, "latestNewsAt")
    },
    {
      id: "evidence-summary",
      owner: "AI / Rules",
      title: "Evidence packet summary",
      status: evidenceStatus,
      detail: "Compresses price, history, related sensors, news, calendar, provider health, allowed drivers, and blocked drivers into a bounded review packet.",
      input: "ScenarioFixture + EvidenceChainStatus",
      output: "Compact evidence packet",
      target: "Rule baseline + Cause review"
    },
    nodeFromJob({
      id: "rule-baseline",
      owner: "Analysis",
      entry: llmEntry,
      jobTitle: "Rule baseline",
      fallbackStatus: llmStatus === "skipped" ? "ready" : llmStatus,
      fallbackDetail: "Deterministic analysis runs first and remains the fallback if Local AI is off or invalid.",
      fallbackInput: "ScenarioFixture + evidence gate + DriverAttention",
      fallbackOutput: textValue(llmEntry, "result") || "Pending analysis result",
      target: "Dashboard + AI review"
    }),
    nodeFromJob({
      id: "cause-review",
      owner: "Local AI",
      entry: llmEntry,
      jobTitle: "Cause review",
      fallbackStatus: llmStatus,
      fallbackDetail: "Local AI reviews only the compact evidence packet after allowed/blocked drivers are known.",
      fallbackInput: "Evidence packet JSON",
      fallbackOutput: textValue(llmEntry, "analysisEngine") || "Rule fallback remains source of truth",
      target: "Validator and repair",
      includeEntryDetail: true
    }),
    nodeFromJob({
      id: "validator",
      owner: "Validator",
      entry: llmEntry,
      jobTitle: "Validator and repair",
      fallbackStatus: llmStatus,
      fallbackDetail: "LLM output must pass deterministic validation; invalid output is repaired once or rejected.",
      fallbackInput: "LLM JSON + allowed_candidate_drivers + blocked_drivers",
      fallbackOutput: llmStatus,
      target: "Dashboard / Evidence / Replay"
    }),
    {
      id: "replay-narrative",
      owner: "AI / Replay",
      title: "Replay narrative",
      status: replayStatus,
      detail: "Day replay keeps detailed events; Month replay keeps only important XAUUSD turns and the evidence that explains them.",
      input: "TimelineStore rows + validated analysis",
      output: "Replay day/month event summaries",
      target: "Replay tab + Evidence detail"
    },
    {
      id: "alert-review",
      owner: "Local AI",
      title: "Alert message review",
      status: alertReviewJob?.status || textValue(alertEntry, "preflightStatus") || alertStatus,
      detail:
        alertReviewJob?.detail ||
        "Before Telegram delivery, candidate-worthy messages can be approved, rewritten, or blocked without adding unsupported facts.",
      input: alertReviewJob?.input || "Formatted alert + evidence packet",
      output: alertReviewJob?.output || textValue(alertEntry, "preflightReason") || "Waiting for candidate alert",
      target: "Preflight evidence check"
    },
    nodeFromJob({
      id: "alert-preflight",
      owner: "Alert gate",
      entry: alertEntry,
      jobTitle: "Preflight evidence check",
      fallbackStatus: textValue(alertEntry, "preflightStatus") || alertStatus,
      fallbackDetail: textValue(alertEntry, "preflightReason") || "Checks freshness, market-closed state, message format, and supporting evidence.",
      fallbackInput: "Formatted message + provider health",
      fallbackOutput: textValue(alertEntry, "preflightStatus") || "pending",
      target: "Alert queue"
    })
  ];

  const outputNodes: ActivityNode[] = [
    {
      id: "dashboard-output",
      owner: "Dashboard",
      title: "Current situation",
      status: textValue(llmEntry, "result") ? "ready" : evidenceStatus,
      detail: "Shows the final validated situation summary only from evidence-gated analysis.",
      input: "Validated AnalysisResult + evidence chain",
      output: textValue(llmEntry, "result") || "No confirmed driver yet",
      target: "Dashboard top summary"
    },
    {
      id: "driver-output",
      owner: "Driver Attention",
      title: "Drivers and themes",
      status: evidenceStatus,
      detail: "Shows active, watching, cooling, retired, and blocked drivers/themes without making sensor collection look like causation.",
      input: "DriverAttention snapshot + candidate gate",
      output: `${listValue(evidenceEntry, "allowedCandidateDrivers").length} allowed / ${Object.keys(recordValue(evidenceEntry, "blockedDrivers")).length} blocked`,
      target: "Driver Attention tab"
    },
    {
      id: "evidence-output",
      owner: "Evidence",
      title: textValue(evidenceEntry, "label") || "Evidence packet",
      status: evidenceStatus,
      detail: textValue(evidenceEntry, "handoff") || "Evidence packet is the source of truth for rule analysis, Local AI, Dashboard, Replay, and alert preflight.",
      input: "Usable inputs + missing inputs + blocked drivers",
      output: normalizeStatusLabel(evidenceStatus),
      target: "Evidence detail"
    },
    nodeFromJob({
      id: "replay-output",
      owner: "Replay",
      entry: replayEntry,
      jobTitle: "Replay query model",
      fallbackTitle: "Day / Month replay",
      fallbackStatus: replayStatus,
      fallbackDetail: "Day replay reads detailed rows; Month replay filters stored timeline events down to major XAUUSD turns.",
      fallbackInput: "TimelineStore indexed range reads",
      fallbackOutput: "Dashboard replay, Evidence detail, Alerts history",
      target: "Replay tab",
      includeEntryDetail: true
    }),
    nodeFromJob({
      id: "timeline-output",
      owner: "Store",
      entry: replayEntry,
      jobTitle: "Raw evidence rows",
      fallbackTitle: "TimelineStore writer",
      fallbackStatus: replayStatus,
      fallbackDetail: "Stores price bars, related sensors, news, calendar, provider health, evidence packet, analysis, alert, and transitions.",
      fallbackInput: "Runtime context + analysis result",
      fallbackOutput: "SQLite replay/debug rows",
      target: "SQLite replay/debug storage"
    }),
    nodeFromJob({
      id: "telegram-output",
      owner: "Alert",
      entry: alertEntry,
      jobTitle: "Telegram delivery",
      fallbackTitle: "Telegram delivery",
      fallbackStatus: textValue(alertEntry, "telegramStatus") || alertStatus,
      fallbackDetail: "Telegram is used only after all gates pass.",
      fallbackInput: "Approved alert payload",
      fallbackOutput: textValue(alertEntry, "telegramStatus") || "Dashboard only",
      target: "Telegram chat",
      includeEntryDetail: true
    })
  ];

  const newsFanIn = (
    <section className="market-agent-activity-fanin" aria-label="News fan-in">
      <div className="market-agent-activity-fanin-main">
        <span>News fan-in</span>
        <strong>
          {contextNewsCount} headline{contextNewsCount === 1 ? "" : "s"} from {newsSources.length || "app-managed"} source{newsSources.length === 1 ? "" : "s"}
        </strong>
        <p>
          News is collected from app-managed feeds, normalized with calendar context, then used for theme discovery,
          evidence packets, replay, and alert formatting. A single headline stays background until the evidence gate confirms it.
        </p>
      </div>
      <div className="market-agent-activity-fanin-side">
        <div className="market-agent-activity-chip-row">
          {(newsSources.length ? newsSources : ["App-managed feeds"]).slice(0, 8).map((source) => (
            <span key={source}>{source}</span>
          ))}
        </div>
        <ul>
          {(newsSamples.length ? newsSamples : ["Waiting for fresh market headlines."]).map((sample) => (
            <li key={sample}>{sample}</li>
          ))}
        </ul>
      </div>
    </section>
  );

  const calendarStrip = calendarSamples.length ? (
    <div className="market-agent-activity-calendar-strip">
      <strong>Calendar context</strong>
      <span>{calendarSamples.join(" · ")}</span>
    </div>
  ) : null;

  const sections: ActivitySection[] = [
    {
      id: "inputs",
      step: "01",
      title: "Data intake",
      detail: "cTrader live/history, multi-source news, calendar, and provider health enter the agent here.",
      status: contextStatus,
      nodes: inputNodes,
      wide: (
        <>
          {newsFanIn}
          {calendarStrip}
        </>
      )
    },
    {
      id: "processing",
      step: "02",
      title: "Normalize and gate evidence",
      detail: "Rows become a scenario fixture, then the evidence gate decides what is usable, blocked, stale, or only background.",
      status: evidenceStatus,
      nodes: processingNodes
    },
    {
      id: "ai",
      step: "03",
      title: "AI checkpoints",
      detail: "AI participates at several bounded checkpoints, but deterministic gates keep it from inventing causes or bypassing evidence.",
      status: llmStatus,
      nodes: aiNodes
    },
    {
      id: "outputs",
      step: "04",
      title: "Outputs and delivery",
      detail: "Only gated results appear on Dashboard, Driver Attention, Evidence, Replay, storage, alerts, and Telegram.",
      status: replayStatus,
      nodes: outputNodes
    }
  ];

  const storageMetrics = [
    ["Loaded range", loadedRange],
    ["Symbols", symbols.length ? symbols.slice(0, 10).join(", ") : "Waiting"],
    ["Price bars", String(storedCount(stored, "marketPriceBars", stats.priceRows))],
    ["Related bars", String(storedCount(stored, "relatedAssetBars", stats.relatedRows))],
    ["News rows", String(storedCount(stored, "newsItems", stats.newsRows))],
    ["Calendar rows", String(storedCount(stored, "calendarEvents", stats.calendarRows))],
    ["Timeline events", String(storedCount(stored, "timelineEvents", stats.timelineEvents))],
    ["Alert records", String(storedCount(stored, "alerts", stats.alerts))],
    ["Stored runs", String(storedCount(storageCounts, "monitorRuns", 0))],
    ["Total news", String(storedCount(storageCounts, "newsItems", storedCount(stored, "newsItems", stats.newsRows)))],
    ["Replay payload", formatBytes(stats.payloadBytes)],
    ["Database size", databaseBytes === null ? "--" : formatBytes(databaseBytes)],
    ["Storage mode", humanizeMarketAgentValue(String(storageCompaction.mode || "indexed_range_reads"))],
    ["Compaction", humanizeMarketAgentValue(String(storageCompaction.status || "not_needed"))]
  ];

  const tableCounts = Object.entries(storageCounts)
    .filter(([, value]) => typeof value === "number")
    .slice(0, 12);
  const rangeRows = Object.entries(storageRanges)
    .map(([key, value]) => {
      const range = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
      return [humanizeMarketAgentValue(key), `${formatShortTime(String(range.start || "")) || "--"} -> ${formatShortTime(String(range.end || "")) || "--"}`];
    })
    .slice(0, 5);
  const dataStores = Array.isArray(summaryEntry?.dataStores) ? summaryEntry.dataStores.map((item) => String(item)) : [];

  return (
    <section className="market-agent-activity-surface" aria-label="Agent activity board">
      <div className="market-agent-activity-hero">
        <div>
          <span>Transparent chain</span>
          <h2>Market Agent circuit</h2>
          <p>
            {phaseMessage} Every node shows what it receives, what it is doing, what it outputs, and where that output
            goes next.
          </p>
        </div>
        <em>{phaseLabel}</em>
      </div>

      <section className="market-agent-activity-flow" aria-label="Market Agent logic chain">
        {sections.map((pipelineSection) => (
          <ActivitySectionBlock section={pipelineSection} key={pipelineSection.id} />
        ))}
      </section>

      <section className="market-agent-activity-storage">
        <div className="market-agent-activity-storage-head">
          <div>
            <span>Data persisted</span>
            <h3>TimelineStore</h3>
            <p>{timelineStorePath}</p>
          </div>
          <em>{dataStores.length ? `${dataStores.length} tables` : "SQLite"}</em>
        </div>
        <dl className="market-agent-activity-storage-grid">
          {storageMetrics.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <div className="market-agent-activity-storage-detail">
          <section>
            <strong>TimelineStore tables</strong>
            <p>{dataStores.length ? dataStores.join(", ") : tableCounts.map(([key]) => humanizeMarketAgentValue(key)).join(", ") || "Waiting for persisted tables."}</p>
          </section>
          <section>
            <strong>Stored row counts</strong>
            <p>{tableCounts.length ? tableCounts.map(([key, value]) => `${humanizeMarketAgentValue(key)} ${value}`).join(" · ") : "No stored row counts yet."}</p>
          </section>
          <section>
            <strong>Stored time ranges</strong>
            <p>{rangeRows.length ? rangeRows.map(([key, value]) => `${key}: ${value}`).join(" · ") : "No indexed ranges loaded yet."}</p>
          </section>
        </div>
      </section>
    </section>
  );
}
