import type {
  MarketAgentEvidenceForRunResponse,
  MarketAgentLLMConfigResponse,
  MarketAgentMonitorStatusResponse,
  MarketAgentProviderConfigResponse,
  MarketAgentProviderHealthEntry,
  MarketAgentProviderHealthResponse,
  MarketAgentReplayPayload,
  MarketAgentReplayResponse,
  MarketAgentTelegramConfigResponse
} from "../../types";
import {
  findProviderHealth,
  formatShortTime,
  humanizeMarketAgentValue,
  normalizeMarketAgentValue
} from "../../utils/marketAgentUi";

export type SignalTone = "good" | "working" | "bad" | "muted" | "ai" | "store";

export type SignalNode = {
  id: string;
  label: string;
  lane: string;
  group?: string;
  status: string;
  action: string;
  source: string;
  processing: string;
  output: string;
  storage: string[];
  ai: string;
  trace: string[];
  detail: string;
  tone: SignalTone;
};

export type SignalLane = {
  id: string;
  title: string;
  detail: string;
  nodes: SignalNode[];
};

export type StorageGroup = {
  title: string;
  detail: string;
  tables: string[];
};

export type SignalMapModel = {
  phaseLabel: string;
  phaseMessage: string;
  lanes: SignalLane[];
  coreSensors: SignalNode[];
  candidateSensors: SignalNode[];
  discoveredSensors: SignalNode[];
  aiNodes: SignalNode[];
  storageGroups: StorageGroup[];
  storagePath: string;
  outputs: SignalNode[];
};

export type BuildSignalMapArgs = {
  monitorStatus: MarketAgentMonitorStatusResponse | null;
  providerHealth: MarketAgentProviderHealthResponse | null;
  replay: MarketAgentReplayResponse | null;
  selectedEvidence: MarketAgentEvidenceForRunResponse | null;
  providerConfig: MarketAgentProviderConfigResponse | null;
  telegramConfig: MarketAgentTelegramConfigResponse | null;
  llmConfig: MarketAgentLLMConfigResponse | null;
};

const textValue = (entry: Record<string, unknown> | undefined, key: string) => {
  const value = entry?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : "";
};

const numberValue = (entry: Record<string, unknown> | undefined, key: string) => {
  const value = entry?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const recordValue = (entry: Record<string, unknown> | undefined, key: string) => {
  const value = entry?.[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
};

const listValue = (entry: Record<string, unknown> | undefined, key: string) => {
  const value = entry?.[key];
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean);
};

const statusTone = (status: string): SignalTone => {
  const normalized = normalizeMarketAgentValue(status);
  if (["live", "active", "ready", "validated", "synced", "stored", "sent", "approved", "summarized"].includes(normalized)) return "good";
  if (["checking", "collecting", "syncing", "preparing", "queued", "market_closed", "partial", "stale", "waiting"].includes(normalized)) return "working";
  if (["unavailable", "failed", "error", "blocked"].includes(normalized)) return "bad";
  return "muted";
};

const replayStats = (payload: MarketAgentReplayPayload | undefined) => {
  const priceRows = payload?.price_series ?? [];
  const related = Object.entries(payload?.related_assets ?? {});
  const relatedRows = related.reduce((total, [, rows]) => total + rows.length, 0);
  return {
    priceRows: priceRows.length,
    relatedRows,
    newsRows: payload?.news_items?.length ?? 0,
    calendarRows: payload?.calendar_events?.length ?? 0,
    timelineEvents: payload?.timeline_events?.length ?? 0,
    monthSummaryEvents: payload?.month_summary_events?.length ?? 0,
    alerts: (payload?.alerts?.length ?? 0) + (payload?.suppressed_alerts?.length ?? 0)
  };
};

const latestRelatedAsset = (payload: MarketAgentReplayPayload | undefined, key: string) => {
  const rows = payload?.related_assets?.[key] ?? [];
  return rows.length ? rows[rows.length - 1] : undefined;
};

const assetValue = (row: Record<string, unknown> | undefined) => {
  const value = row?.change_15m ?? row?.change ?? row?.value;
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "waiting";
};

const providerLabel = (health: MarketAgentProviderHealthEntry | undefined, fallback: string) => {
  const source = String(health?.source ?? health?.provider ?? fallback);
  return source || fallback;
};

const normalizeStorageLabel = (value: string) => value.replace(/_/g, " ");

const sensorDefinitions = [
  { id: "dxy", label: "DXY", group: "USD pressure", source: "DX-Y.NYB / CSV fallback", storage: "related_asset_bars" },
  { id: "us10y", label: "US10Y", group: "Rates / yields", source: "^TNX / CSV fallback", storage: "related_asset_bars" },
  { id: "us2y", label: "US2Y", group: "Rates / yields", source: "Yield proxy / CSV fallback", storage: "related_asset_bars" },
  { id: "wti", label: "WTI", group: "Oil / inflation", source: "CL=F / CSV fallback", storage: "related_asset_bars" },
  { id: "brent", label: "Brent", group: "Oil / inflation", source: "BZ=F / CSV fallback", storage: "related_asset_bars" },
  { id: "vix", label: "VIX", group: "Risk sentiment", source: "^VIX / CSV fallback", storage: "related_asset_bars" },
  { id: "spx", label: "S&P 500", group: "Risk sentiment", source: "^GSPC / CSV fallback", storage: "related_asset_bars" },
  { id: "nasdaq", label: "Nasdaq", group: "Risk sentiment", source: "^IXIC / CSV fallback", storage: "related_asset_bars" }
];

const node = (input: Omit<SignalNode, "tone"> & { tone?: SignalTone }): SignalNode => ({
  tone: input.tone ?? statusTone(input.status),
  ...input
});

export const buildSignalMapModel = ({
  monitorStatus,
  providerHealth,
  replay,
  selectedEvidence,
  providerConfig,
  telegramConfig,
  llmConfig
}: BuildSignalMapArgs): SignalMapModel => {
  const activity = monitorStatus?.activity ?? {};
  const cTraderEntry = activity.ctrader;
  const historyEntry = activity.history;
  const contextEntry = activity.context;
  const evidenceEntry = activity.evidence;
  const llmEntry = activity.llm;
  const replayEntry = activity.replay;
  const alertEntry = activity.alerts;
  const summaryEntry = activity.summary;
  const payload = replay?.replay;
  const stats = replayStats(payload);
  const selectedEvidencePacket = selectedEvidence?.payload?.evidence_packet as Record<string, unknown> | undefined;
  const evidenceChain = selectedEvidencePacket?.evidence_chain_status as Record<string, unknown> | undefined;
  const storageSummary = recordValue(replayEntry, "storageSummary");
  const storageCounts = recordValue(storageSummary, "counts");
  const xauusdHealth = findProviderHealth(providerHealth?.items, ["xauusd", "gc=f", "xauusd price"]);
  const cTraderLive = Boolean(xauusdHealth?.is_available && !xauusdHealth.is_stale);
  const cTraderStatus = textValue(cTraderEntry, "status") || (cTraderLive ? "live" : providerConfig?.ctrader?.enabled ? "checking" : "waiting");
  const historyStatus = textValue(historyEntry, "status") || (monitorStatus?.running ? "syncing" : "idle");
  const contextStatus = textValue(contextEntry, "status") || (stats.newsRows || stats.calendarRows ? "active" : "collecting");
  const evidenceStatus = textValue(evidenceEntry, "status") || String(evidenceChain?.status || "pending");
  const llmStatus = textValue(llmEntry, "status") || (llmConfig?.llm?.enabled ? "queued" : "skipped");
  const replayStatus = textValue(replayEntry, "status") || (stats.timelineEvents ? "stored" : "pending");
  const alertStatus = textValue(alertEntry, "status") || (telegramConfig?.telegram?.enabled ? "ready" : "idle");
  const phaseLabel = humanizeMarketAgentValue(monitorStatus?.phase || (monitorStatus?.running ? "running" : "stopped"));
  const phaseMessage = monitorStatus?.message || (monitorStatus?.running ? "Agent is checking the market." : "Agent is idle.");
  const historyProgress = numberValue(historyEntry, "progress");
  const allowedDrivers = listValue(evidenceEntry, "allowedCandidateDrivers");
  const blockedDrivers = recordValue(evidenceEntry, "blockedDrivers");
  const storagePath =
    textValue(replayEntry, "timelineStorePath") ||
    String(storageSummary.path || "") ||
    replay?.timeline_store_path ||
    selectedEvidence?.timeline_store_path ||
    "TimelineStore not loaded";

  const coreSensors = sensorDefinitions.map((sensor) => {
    const row = latestRelatedAsset(payload, sensor.id);
    const health = findProviderHealth(providerHealth?.items, [sensor.id, sensor.label]);
    const status = row ? String(row.data_mode || "live") : health?.is_stale ? "stale" : health?.is_available ? "ready" : "waiting";
    return node({
      id: `sensor-${sensor.id}`,
      label: sensor.label,
      lane: "Market Sensors",
      group: sensor.group,
      status,
      action: `${sensor.group}: ${assetValue(row)}`,
      source: row ? String(row.source || sensor.source) : providerLabel(health, sensor.source),
      processing: "Compare sensor move with XAUUSD direction, then mark confirming, contradicting, not confirming, stale, or unavailable.",
      output: "Evidence gate + Driver Attention + Latest Evidence + Replay",
      storage: [sensor.storage],
      ai: "Display summarizer can compress this row for Latest Evidence; cause review consumes the bounded evidence packet.",
      trace: [`sensor-${sensor.id}`, "sensor-confirmation", "evidence-gate", "driver-attention", "evidence-packet", "latest-evidence", "replay-output", "storage-raw"],
      detail: `${sensor.label} is a ${sensor.group} sensor. It is not a cause by itself; it confirms or challenges an XAUUSD explanation.`
    });
  });

  const candidateNames = Array.from(new Set([...allowedDrivers, ...Object.keys(blockedDrivers)])).filter(Boolean);
  const candidateSensors = (candidateNames.length ? candidateNames : ["geopolitics", "liquidity"]).slice(0, 6).map((name) =>
    node({
      id: `candidate-${normalizeMarketAgentValue(name)}`,
      label: humanizeMarketAgentValue(name),
      lane: "Candidate Sensors",
      status: blockedDrivers[name] ? "blocked" : "watching",
      action: blockedDrivers[name] ? "Needs confirmation" : "Watching evidence",
      source: "Driver Attention, news grouping, evidence gate, or AI review",
      processing: "Track whether a possible driver has enough observed evidence or needs a provider mapping.",
      output: "Candidate driver gate",
      storage: ["driver_attention_states", "evidence_packets"],
      ai: "AI can flag unsupported plausible drivers, but blocked drivers cannot become causes.",
      trace: [`candidate-${normalizeMarketAgentValue(name)}`, "driver-attention", "candidate-gate", "evidence-packet"],
      detail: blockedDrivers[name] ? String(blockedDrivers[name]) : "Candidate sensor is watched because current context may require confirmation."
    })
  );

  const discoveredSensors = ["Geopolitical risk proxy", "Credit stress proxy", "Shipping / supply proxy"].map((label) =>
    node({
      id: `discovered-${normalizeMarketAgentValue(label)}`,
      label,
      lane: "Discovered Sensors",
      status: "unmapped",
      action: "Not monitored yet",
      source: "Repeated evidence can request this sensor",
      processing: "Visible gap state; does not pretend data exists.",
      output: "Provider mapping backlog",
      storage: ["evidence_packets"],
      ai: "AI may identify the gap, but the UI marks it as unmapped until a provider exists.",
      trace: [`discovered-${normalizeMarketAgentValue(label)}`, "candidate-gate"],
      detail: "Discovered sensors represent unknown or newly relevant drivers that need provider coverage."
    })
  );

  const sourceLane: SignalLane = {
    id: "sources",
    title: "Signal Sources",
    detail: "Independent market feeds enter the system here.",
    nodes: [
      node({
        id: "price-source",
        label: "XAUUSD price",
        lane: "Signal Sources",
        status: cTraderStatus,
        action: textValue(cTraderEntry, "detail") || "Fetching live quote",
        source: textValue(cTraderEntry, "source") || "cTrader",
        processing: "Live quote feeds move detection, evidence, replay, and alert preflight.",
        output: "Move detection + Evidence gate",
        storage: ["market_price_bars"],
        ai: "No AI at collection.",
        trace: ["price-source", "move-detection", "evidence-gate", "storage-raw"],
        detail: "Primary XAUUSD price signal from cTrader."
      }),
      node({
        id: "history-source",
        label: "History",
        lane: "Signal Sources",
        status: historyStatus,
        action: historyProgress === null ? "Checking gaps" : `${Math.round(historyProgress)}% sync`,
        source: "cTrader history",
        processing: "Backfill fills replay and evidence gaps without blocking the live quote.",
        output: "Replay rows + TimelineStore",
        storage: ["market_price_bars", "related_asset_bars"],
        ai: "No AI at history fetch.",
        trace: ["history-source", "history-replay", "storage-raw", "replay-output"],
        detail: textValue(historyEntry, "detail") || "Historical rows support replay and gap recovery."
      }),
      node({
        id: "news-source",
        label: "News",
        lane: "Signal Sources",
        status: contextStatus,
        action: `${numberValue(contextEntry, "newsCount") ?? stats.newsRows} headline(s)`,
        source: listValue(contextEntry, "sources").join(", ") || "App-managed feeds",
        processing: "Relevance filtering and grouping before evidence can use a headline.",
        output: "News grouping + Evidence packet",
        storage: ["news_items"],
        ai: "Display summarizer can shorten selected news rows.",
        trace: ["news-source", "news-grouping", "evidence-gate", "display-summarizer", "latest-evidence", "storage-raw"],
        detail: textValue(contextEntry, "detail") || "News rows provide event context and possible driver themes."
      }),
      node({
        id: "calendar-source",
        label: "Calendar",
        lane: "Signal Sources",
        status: contextStatus,
        action: `${numberValue(contextEntry, "calendarCount") ?? stats.calendarRows} event(s)`,
        source: "App-managed economic calendar",
        processing: "Calendar events become timed context for evidence and replay.",
        output: "Calendar context + Evidence packet",
        storage: ["calendar_events"],
        ai: "Display summarizer can shorten selected calendar rows.",
        trace: ["calendar-source", "calendar-context", "evidence-gate", "display-summarizer", "latest-evidence", "storage-raw"],
        detail: "Calendar rows explain scheduled macro risk near the move."
      })
    ]
  };

  const processingLane: SignalLane = {
    id: "processing",
    title: "Processing Fabric",
    detail: "Signals are normalized, checked, gated, and converted into a bounded evidence packet.",
    nodes: [
      node({
        id: "move-detection",
        label: "Move detection",
        lane: "Processing Fabric",
        status: cTraderStatus,
        action: "Detecting XAUUSD move",
        source: "XAUUSD price + recent history",
        processing: "Measure the latest move window before asking what caused it.",
        output: "Evidence gate",
        storage: ["market_price_bars"],
        ai: "No AI.",
        trace: ["price-source", "move-detection", "evidence-gate"],
        detail: "Move detection decides whether the run has a meaningful XAUUSD move to explain."
      }),
      node({
        id: "sensor-confirmation",
        label: "Sensor confirmation",
        lane: "Processing Fabric",
        status: evidenceStatus,
        action: "Confirming cross-market signals",
        source: "Market Sensors + provider health",
        processing: "Classify DXY, yields, oil, and risk sentiment as confirming, contradicting, stale, unavailable, or background.",
        output: "Evidence gate + Driver Attention",
        storage: ["related_asset_bars", "evidence_packets"],
        ai: "No AI required; AI can later summarize the row.",
        trace: ["sensor-confirmation", "evidence-gate", "driver-attention"],
        detail: "This is where market sensors become usable evidence instead of loose context."
      }),
      node({
        id: "evidence-gate",
        label: "Evidence gate",
        lane: "Processing Fabric",
        status: evidenceStatus,
        action: textValue(evidenceEntry, "detail") || "Checking usable inputs",
        source: "Price, history, news, calendar, sensors",
        processing: "Decides what is usable, stale, blocked, or background.",
        output: "Driver Attention + Evidence packet",
        storage: ["evidence_packets"],
        ai: "AI cannot bypass this gate.",
        trace: ["evidence-gate", "driver-attention", "evidence-packet", "storage-derived"],
        detail: textValue(evidenceEntry, "label") || "Evidence readiness and blocking state."
      }),
      node({
        id: "driver-attention",
        label: "Driver Attention",
        lane: "Processing Fabric",
        status: evidenceStatus,
        action: `${allowedDrivers.length} allowed driver(s)`,
        source: "Evidence gate + previous driver states",
        processing: "Move drivers between watching, emerging, active, cooling, retired, and blocked.",
        output: "Candidate gate + Evidence packet",
        storage: ["driver_attention_states"],
        ai: "AI sees only allowed/blocked driver context.",
        trace: ["driver-attention", "candidate-gate", "evidence-packet", "storage-derived"],
        detail: "Driver Attention prevents a raw sensor from being treated as causation too early."
      }),
      node({
        id: "evidence-packet",
        label: "Evidence packet",
        lane: "Processing Fabric",
        status: evidenceStatus,
        action: "Building bounded packet",
        source: "ScenarioFixture + EvidenceChainStatus",
        processing: "Compress raw rows and gate state into the packet reviewed by rules and AI.",
        output: "AI checkpoints + Evidence UI",
        storage: ["evidence_packets"],
        ai: "Cause review and display summaries consume this bounded packet.",
        trace: ["evidence-packet", "display-summarizer", "cause-review", "latest-evidence", "storage-derived"],
        detail: "The evidence packet is the source of truth for downstream explanation."
      })
    ]
  };

  const aiNodes = [
    node({
      id: "display-summarizer",
      label: "Display summarizer",
      lane: "AI Checkpoints",
      status: textValue(summaryEntry, "displaySummaryStatus") || llmStatus,
      action: "Shortening evidence rows",
      source: "News, calendar, related sensor rows",
      processing: "Generate short UI summaries without inventing facts.",
      output: "Latest Evidence",
      storage: ["news_items", "calendar_events", "related_asset_bars"],
      ai: "Local AI when enabled; rule fallback keeps raw text usable.",
      trace: ["evidence-packet", "display-summarizer", "latest-evidence"],
      detail: "This checkpoint prevents long raw evidence from crowding the dashboard.",
      tone: "ai"
    }),
    node({
      id: "cause-review",
      label: "Cause review",
      lane: "AI Checkpoints",
      status: llmStatus,
      action: textValue(llmEntry, "detail") || "Reviewing cause packet",
      source: "Evidence packet JSON",
      processing: "Review the likely driver using only allowed evidence.",
      output: "AnalysisResult",
      storage: ["analysis_results"],
      ai: llmConfig?.llm?.enabled ? "Local AI enabled" : "Rule fallback active",
      trace: ["evidence-packet", "cause-review", "validator-repair", "dashboard-output", "storage-derived"],
      detail: textValue(llmEntry, "result") || "Cause review waits for a bounded evidence packet.",
      tone: "ai"
    }),
    node({
      id: "validator-repair",
      label: "Validator / repair",
      lane: "AI Checkpoints",
      status: llmStatus,
      action: "Validating LLM JSON",
      source: "LLM output + allowed/blocked drivers",
      processing: "Repair once or reject invalid output.",
      output: "Dashboard + analysis_results",
      storage: ["analysis_results"],
      ai: "Deterministic validation controls AI output.",
      trace: ["cause-review", "validator-repair", "dashboard-output", "storage-derived"],
      detail: "AI output cannot reach the dashboard until it passes validation.",
      tone: "ai"
    }),
    node({
      id: "replay-condenser",
      label: "Replay condenser",
      lane: "AI Checkpoints",
      status: replayStatus,
      action: `${stats.monthSummaryEvents} month turn(s)`,
      source: "timeline_events + analysis summaries",
      processing: "Day keeps detailed rows; month keeps important turns and summaries.",
      output: "Replay",
      storage: ["timeline_events", "month_summary_events"],
      ai: "Local AI summaries can be used; rule fallback filters important events.",
      trace: ["storage-derived", "replay-condenser", "replay-output"],
      detail: "This is why month replay should not expand every day marker.",
      tone: "ai"
    }),
    node({
      id: "alert-review",
      label: "Alert review",
      lane: "AI Checkpoints",
      status: textValue(alertEntry, "preflightStatus") || alertStatus,
      action: "Reviewing delivery candidate",
      source: "Formatted alert + evidence packet",
      processing: "Approve, rewrite, or block alert text without adding unsupported facts.",
      output: "Telegram or dashboard only",
      storage: ["alerts"],
      ai: "Optional Local AI review before Telegram.",
      trace: ["evidence-packet", "alert-review", "telegram-output", "storage-derived"],
      detail: textValue(alertEntry, "detail") || "Alert review is only used when an alert candidate exists.",
      tone: "ai"
    })
  ];

  const outputs = [
    node({
      id: "dashboard-output",
      label: "Dashboard",
      lane: "Outputs",
      status: textValue(llmEntry, "result") ? "ready" : evidenceStatus,
      action: "Showing current situation",
      source: "Validated AnalysisResult + display summaries",
      processing: "Show the most recent evidence-gated state.",
      output: "Dashboard view",
      storage: ["analysis_results", "evidence_packets"],
      ai: "Uses AI summary/review only after validation.",
      trace: ["validator-repair", "dashboard-output"],
      detail: "Dashboard is an output surface, not a source of truth.",
      tone: "good"
    }),
    node({
      id: "latest-evidence",
      label: "Latest Evidence",
      lane: "Outputs",
      status: evidenceStatus,
      action: "Showing short summaries",
      source: "Display summarizer + raw row fallback",
      processing: "Prefer short summary fields while keeping raw rows stored.",
      output: "Evidence panel",
      storage: ["news_items", "calendar_events", "related_asset_bars"],
      ai: "Display summarizer participates here.",
      trace: ["display-summarizer", "latest-evidence"],
      detail: "Latest Evidence is where long rows become readable.",
      tone: "good"
    }),
    node({
      id: "replay-output",
      label: "Replay",
      lane: "Outputs",
      status: replayStatus,
      action: "Reading day/month rows",
      source: "TimelineStore indexed range reads",
      processing: "Day reads detailed timeline; month reads condensed major turns.",
      output: "Replay tab",
      storage: ["timeline_events", "month_summary_events"],
      ai: "Replay condenser can summarize important month turns.",
      trace: ["replay-condenser", "replay-output", "storage-derived"],
      detail: textValue(replayEntry, "detail") || "Replay reconstructs what happened from persisted rows.",
      tone: "store"
    }),
    node({
      id: "telegram-output",
      label: "Telegram",
      lane: "Outputs",
      status: textValue(alertEntry, "telegramStatus") || alertStatus,
      action: telegramConfig?.telegram?.enabled ? "Ready for delivery" : "Dashboard only",
      source: "Approved alert payload",
      processing: "Deliver only after alert gates pass.",
      output: "Telegram chat",
      storage: ["alerts"],
      ai: "Alert review can rewrite/block before delivery.",
      trace: ["alert-review", "telegram-output"],
      detail: textValue(alertEntry, "detail") || "Telegram is optional and gated.",
      tone: statusTone(alertStatus)
    })
  ];

  return {
    phaseLabel,
    phaseMessage,
    lanes: [sourceLane, { id: "sensors", title: "Market Sensors", detail: "Core sensors are always visible; candidate and discovered sensors expose gaps.", nodes: coreSensors }, processingLane],
    coreSensors,
    candidateSensors,
    discoveredSensors,
    aiNodes,
    storageGroups: [
      {
        title: "Raw collected",
        detail: `${stats.priceRows + stats.relatedRows + stats.newsRows + stats.calendarRows} row(s) in current replay payload`,
        tables: ["market_price_bars", "related_asset_bars", "news_items", "calendar_events", "provider_health"]
      },
      {
        title: "Processed / derived",
        detail: `${Object.keys(storageCounts).length ? Object.keys(storageCounts).map(normalizeStorageLabel).slice(0, 4).join(", ") : "analysis and replay rows"}`,
        tables: ["evidence_packets", "analysis_results", "driver_attention_states", "timeline_events", "month_summary_events", "state_transitions", "alerts"]
      }
    ],
    storagePath,
    outputs
  };
};
