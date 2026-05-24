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
  normalizeMarketAgentValue,
  providerGuidance
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
  badges?: SignalBadge[];
  drilldown?: SignalDrilldownSection[];
  requests?: SignalDataRequest[];
};

export type SignalBadge = {
  label: string;
  tone: SignalTone;
};

export type SignalDrilldownRow = {
  label: string;
  status: string;
  detail: string;
  meta: string[];
};

export type SignalDrilldownSection = {
  title: string;
  detail: string;
  rows: SignalDrilldownRow[];
};

export type SignalDataRequest = {
  target: string;
  status: string;
  requestedBy: string;
  reason: string;
  mode: string;
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
  { id: "xauusd", label: "XAUUSD", group: "Primary price", source: "cTrader spot / GC=F fallback", storage: "market_price_bars" },
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

const asRecordList = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : []);

const shortDate = (value: unknown) => {
  if (typeof value !== "string" || !value.trim()) return "not recorded";
  return formatShortTime(value) || value;
};

const healthFreshness = (health: MarketAgentProviderHealthEntry | undefined) => {
  if (!health) return "not recorded";
  if (!health.is_available || normalizeMarketAgentValue(health.source_type) === "unavailable") return "unavailable";
  if (health.is_stale) return "stale";
  return "fresh";
};

const requestFromHealth = (sensorLabel: string, health: MarketAgentProviderHealthEntry | undefined): SignalDataRequest | null => {
  if (!health) {
    return {
      target: sensorLabel,
      status: "watching",
      requestedBy: "Provider health",
      reason: "No provider status has been recorded for this sensor in the current payload.",
      mode: "provider mapping"
    };
  }
  if (!health.is_available || normalizeMarketAgentValue(health.source_type) === "unavailable") {
    return {
      target: sensorLabel,
      status: "unavailable",
      requestedBy: "Evidence gate",
      reason: providerGuidance(health),
      mode: health.data_mode || "unavailable"
    };
  }
  if (health.is_stale) {
    return {
      target: sensorLabel,
      status: "stale",
      requestedBy: "Freshness check",
      reason: health.stale_reason || "The latest value is stale and cannot confirm a fresh move.",
      mode: health.data_mode || "refresh"
    };
  }
  return null;
};

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
  const selectedProviderHealth = asRecordList(selectedEvidence?.payload?.provider_health) as MarketAgentProviderHealthEntry[];
  const healthItems = providerHealth?.items?.length ? providerHealth.items : selectedProviderHealth;
  const driverStates = asRecordList(selectedEvidence?.payload?.driver_attention_states);
  const analysisResult = (selectedEvidence?.payload?.analysis_result ?? {}) as Record<string, unknown>;
  const storageSummary = recordValue(replayEntry, "storageSummary");
  const storageCounts = recordValue(storageSummary, "counts");
  const xauusdHealth = findProviderHealth(healthItems, ["xauusd", "gc=f", "xauusd price"]);
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
  const jobRows = (entry: Record<string, unknown> | undefined, fallbackTitle: string): SignalDrilldownRow[] => {
    const jobs = asRecordList(entry?.jobs);
    if (!jobs.length) {
      return [
        {
          label: fallbackTitle,
          status: textValue(entry, "status") || "not recorded",
          detail: textValue(entry, "detail") || "No detailed activity jobs were recorded for this step.",
          meta: [`input: ${textValue(entry, "input") || "not recorded"}`, `output: ${textValue(entry, "output") || "not recorded"}`]
        }
      ];
    }
    return jobs.map((job) => ({
      label: textValue(job, "title") || fallbackTitle,
      status: textValue(job, "status") || "recorded",
      detail: textValue(job, "detail") || "Step was recorded in the monitor activity snapshot.",
      meta: [
        `input: ${textValue(job, "input") || "not recorded"}`,
        `output: ${textValue(job, "output") || "not recorded"}`,
        `time: ${shortDate(job.timestamp)}`
      ]
    }));
  };
  const storagePath =
    textValue(replayEntry, "timelineStorePath") ||
    String(storageSummary.path || "") ||
    replay?.timeline_store_path ||
    selectedEvidence?.timeline_store_path ||
    "TimelineStore not loaded";

  const evidenceStatusMap = recordValue(selectedEvidencePacket, "evidence_status");
  const crossAssetConfirmation = recordValue(selectedEvidencePacket, "cross_asset_confirmation");
  const sensorRequests: SignalDataRequest[] = [];
  const coreSensors = sensorDefinitions.map((sensor) => {
    const row = sensor.id === "xauusd" ? payload?.price_series?.[payload.price_series.length - 1] : latestRelatedAsset(payload, sensor.id);
    const health = findProviderHealth(healthItems, [sensor.id, sensor.label]);
    const healthRequest = requestFromHealth(sensor.label, health);
    if (healthRequest) sensorRequests.push(healthRequest);
    const evidenceState = String(evidenceStatusMap[sensor.id] || crossAssetConfirmation[sensor.id] || "");
    const status = evidenceState || (row ? String(row.data_mode || "live") : health?.is_stale ? "stale" : health?.is_available ? "ready" : health ? "unavailable" : "waiting");
    const requestedBy = sensor.id === "xauusd" ? "Move detection" : sensor.group.includes("Rates") ? "Yields driver / evidence gate" : sensor.group.includes("Oil") ? "Theme discovery / inflation channel" : "Driver attention";
    const usedBy = sensor.id === "xauusd" ? "Move detection, evidence gate, replay, alerts" : "Driver attention, evidence gate, Latest Evidence";
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
      detail: `${sensor.label} is a ${sensor.group} sensor. It is not a cause by itself; it confirms or challenges an XAUUSD explanation.`,
      badges: [
        { label: healthFreshness(health), tone: statusTone(healthFreshness(health)) },
        { label: String(health?.data_mode || row?.data_mode || "mode unknown"), tone: statusTone(String(health?.data_mode || row?.data_mode || "")) },
        { label: row ? "stored" : "not stored in range", tone: row ? "store" : "muted" }
      ],
      drilldown: [
        {
          title: "Sensor trace",
          detail: "Asset sensors stay inside the Assets source group. They are collected, checked for freshness, stored, then used only if evidence gates allow it.",
          rows: [
            {
              label: sensor.label,
              status,
              detail: providerGuidance(health),
              meta: [
                `provider: ${providerLabel(health, sensor.source)}`,
                `source_type: ${health?.source_type || "unknown"}`,
                `mode: ${health?.data_mode || String(row?.data_mode || "not recorded")}`,
                `data_timestamp: ${shortDate(health?.data_timestamp || row?.timestamp || row?.time)}`,
                `fetched_at: ${shortDate(health?.fetched_at)}`,
                `storage: ${row ? sensor.storage : "not stored in selected range"}`,
                `requested_by: ${requestedBy}`,
                `used_by: ${usedBy}`
              ]
            }
          ]
        }
      ],
      requests: healthRequest ? [healthRequest] : []
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
      detail: blockedDrivers[name] ? String(blockedDrivers[name]) : "Candidate sensor is watched because current context may require confirmation.",
      badges: [
        { label: blockedDrivers[name] ? "blocked" : "watching", tone: blockedDrivers[name] ? "bad" : "working" },
        { label: "not active by default", tone: "muted" }
      ],
      drilldown: [
        {
          title: "Theme lifecycle",
          detail: "A candidate or emerging theme can request data, but it needs repeated evidence, fresh timestamps, source diversity, and market reaction before activation.",
          rows: [
            {
              label: humanizeMarketAgentValue(name),
              status: blockedDrivers[name] ? "blocked" : "watching",
              detail: blockedDrivers[name] ? String(blockedDrivers[name]) : "Watching for repeated evidence and cross-asset confirmation.",
              meta: ["state: observed/watching/emerging before active", "storage: driver_attention_states", "guard: evidence gate"]
            }
          ]
        }
      ],
      requests: blockedDrivers[name]
        ? [
            {
              target: humanizeMarketAgentValue(name),
              status: "blocked",
              requestedBy: "Driver attention",
              reason: String(blockedDrivers[name]),
              mode: "theme confirmation"
            }
          ]
        : [
            {
              target: humanizeMarketAgentValue(name),
              status: "watching",
              requestedBy: "Theme discovery",
              reason: "Watch this theme without promoting it to active until evidence persists.",
              mode: "priority watch"
            }
          ]
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
      detail: "Discovered sensors represent unknown or newly relevant drivers that need provider coverage.",
      badges: [
        { label: "unmapped", tone: "bad" },
        { label: "request only", tone: "working" }
      ],
      drilldown: [
        {
          title: "Discovered sensor request",
          detail: "Unknown themes stay visible as gaps. They do not become evidence until a reliable provider exists.",
          rows: [
            {
              label,
              status: "unmapped",
              detail: "Needs provider mapping, freshness policy, and evidence rules before it can influence conclusions.",
              meta: ["requested_by: theme discovery", "used_by: none yet", "storage: evidence_packets"]
            }
          ]
        }
      ],
      requests: [
        {
          target: label,
          status: "unmapped",
          requestedBy: "Theme discovery",
          reason: "Repeated evidence may require a new sensor, but the provider is not configured.",
          mode: "provider mapping"
        }
      ]
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
        detail: "Primary XAUUSD price signal from cTrader.",
        drilldown: [
          {
            title: "Live asset ingest",
            detail: "Primary price is collected first because every explanation starts with a meaningful XAUUSD move.",
            rows: jobRows(cTraderEntry, "Live quote request")
          }
        ]
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
        detail: textValue(historyEntry, "detail") || "Historical rows support replay and gap recovery.",
        drilldown: [
          {
            title: "History/backfill ingest",
            detail: "Backfill is persisted for replay and evidence windows, but recovered historical moves do not become live Telegram alerts.",
            rows: jobRows(historyEntry, "History/backfill request")
          }
        ]
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
        detail: textValue(contextEntry, "detail") || "News rows provide event context and possible driver themes.",
        drilldown: [
          {
            title: "News processing path",
            detail: "News starts raw, then becomes deduped, filtered/included, summarized, and finally an evidence candidate only when timestamps and relevance pass.",
            rows: [
              {
                label: "Raw capture",
                status: contextStatus,
                detail: `${stats.newsRows} raw headline row(s) are available in the selected replay payload.`,
                meta: [`sources: ${listValue(contextEntry, "sources").join(", ") || "app-managed feeds"}`, "storage: news_items"]
              },
              {
                label: "Dedupe / source scoring",
                status: "checking",
                detail: "Repeated headlines and weak sources are handled before they can crowd Latest Evidence.",
                meta: ["state: filtered or included per row", "storage: news_items"]
              },
              {
                label: "Theme extraction",
                status: allowedDrivers.length || Object.keys(blockedDrivers).length ? "watching" : "waiting",
                detail: "Headlines can suggest themes, but a theme does not become active from one headline.",
                meta: [`allowed: ${allowedDrivers.join(", ") || "none"}`, `blocked: ${Object.keys(blockedDrivers).join(", ") || "none"}`]
              },
              {
                label: "Evidence candidate",
                status: evidenceStatus,
                detail: "Only relevant, timestamped, non-contradicted rows enter the evidence packet.",
                meta: ["handoff: evidence_packets", "display: Latest Evidence short summary"]
              }
            ]
          }
        ]
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
        detail: "Calendar rows explain scheduled macro risk near the move.",
        drilldown: [
          {
            title: "Calendar event windows",
            detail: "Calendar data is already structured, so the key work is timing: pre-risk, first reaction, and confirmation windows.",
            rows: [
              {
                label: "Structured events",
                status: contextStatus,
                detail: `${stats.calendarRows} calendar event row(s) are available in the selected replay payload.`,
                meta: ["provider: ForexFactory / official schedules / local backfill", "storage: calendar_events"]
              },
              {
                label: "Window alignment",
                status: "checking",
                detail: "Events are aligned to XAUUSD movement windows before they can explain a move.",
                meta: ["windows: pre-risk / first reaction / confirmation", "handoff: context gate"]
              },
              {
                label: "Evidence alignment",
                status: evidenceStatus,
                detail: "Actual/forecast/previous values support context when available; distant events stay background.",
                meta: ["storage: evidence_packets", "display: Latest Evidence"]
              }
            ]
          }
        ]
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
        detail: textValue(evidenceEntry, "label") || "Evidence readiness and blocking state.",
        drilldown: [
          {
            title: "Evidence gate decisions",
            detail: "This is the deterministic guard before AI. Unavailable is different from neutral, and blocked drivers cannot become causes.",
            rows: [
              ...Object.entries(evidenceStatusMap).map(([label, status]) => ({
                label: humanizeMarketAgentValue(label),
                status: String(status),
                detail: String(status) === "unavailable" ? `${humanizeMarketAgentValue(label)} is unavailable, so it is not neutral evidence.` : "Evidence status recorded for this run.",
                meta: ["source: evidence packet", "storage: evidence_packets"]
              })),
              ...Object.entries(blockedDrivers).map(([label, reason]) => ({
                label: humanizeMarketAgentValue(label),
                status: "blocked",
                detail: String(reason),
                meta: ["guard: blocked driver", "AI cannot override"]
              }))
            ]
          }
        ]
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
        detail: "Driver Attention prevents a raw sensor from being treated as causation too early.",
        drilldown: [
          {
            title: "Driver lifecycle",
            detail: "Themes move through observed, watching, emerging, active, cooling, retired, or rejected states across monitor runs.",
            rows: driverStates.length
              ? driverStates.map((state) => ({
                  label: textValue(state, "label") || humanizeMarketAgentValue(textValue(state, "driver_id") || "driver"),
                  status: textValue(state, "current_state") || "watching",
                  detail: textValue(state, "current_evidence_summary") || textValue(state, "activation_reason") || "Driver state is stored for this run.",
                  meta: [
                    `priority: ${textValue(state, "priority") || "unknown"}`,
                    `confidence: ${textValue(state, "confidence") || "unknown"}`,
                    `last_evidence_at: ${shortDate(state.last_evidence_at)}`,
                    `storage: driver_attention_states`
                  ]
                }))
              : [
                  {
                    label: "Driver attention",
                    status: "waiting",
                    detail: "No driver attention state rows were returned for the selected run.",
                    meta: ["storage: driver_attention_states"]
                  }
                ]
          }
        ]
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
        detail: "The evidence packet is the source of truth for downstream explanation.",
        drilldown: [
          {
            title: "Packet contents",
            detail: "The AI sees bounded facts from this packet, not the full raw universe.",
            rows: [
              {
                label: "Allowed drivers",
                status: allowedDrivers.length ? "ready" : "none",
                detail: allowedDrivers.join(", ") || "No candidate driver passed the gate.",
                meta: ["source: evidence gate", "storage: evidence_packets"]
              },
              {
                label: "Blocked drivers",
                status: Object.keys(blockedDrivers).length ? "blocked" : "none",
                detail: Object.entries(blockedDrivers).map(([label, reason]) => `${humanizeMarketAgentValue(label)}: ${reason}`).join(" | ") || "No blocked drivers recorded.",
                meta: ["AI cannot promote blocked drivers"]
              },
              {
                label: "Analysis result",
                status: String(analysisResult.cause_status || "pending"),
                detail: `main_driver: ${String(analysisResult.main_driver || "unknown")}`,
                meta: [`confidence: ${String(analysisResult.confidence || "unknown")}`, "storage: analysis_results"]
              }
            ]
          }
        ]
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
      tone: "ai",
      drilldown: [
        {
          title: "LLM display role",
          detail: "The display summarizer shortens rows for UI readability while raw text remains in storage.",
          rows: jobRows(summaryEntry, "Display evidence summary")
        }
      ]
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
      tone: "ai",
      drilldown: [
        {
          title: "LLM analysis",
          detail: "LLM groups evidence into human-readable explanations, but only from the bounded evidence packet.",
          rows: [
            {
              label: "Prompt input",
              status: llmStatus,
              detail: "Evidence packet JSON, allowed drivers, blocked drivers, provider health, and previous state.",
              meta: ["guard: no outside news", "storage: evidence_packets"]
            },
            {
              label: "LLM output",
              status: textValue(llmEntry, "result") ? "returned" : llmStatus,
              detail: textValue(llmEntry, "result") || "No LLM result text recorded in activity snapshot.",
              meta: ["handoff: validator", "storage: analysis_results"]
            }
          ]
        }
      ]
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
      tone: "ai",
      drilldown: [
        {
          title: "Validator guard",
          detail: "Deterministic validation keeps the LLM from inventing drivers or bypassing unavailable evidence.",
          rows: [
            {
              label: "Schema validation",
              status: llmStatus,
              detail: "Invalid JSON is repaired once or rejected.",
              meta: ["guard: JSON contract", "storage: analysis_results"]
            },
            {
              label: "Evidence validation",
              status: evidenceStatus,
              detail: "The main driver must be supported by allowed evidence; unknown remains unknown when evidence is insufficient.",
              meta: [`main_driver: ${String(analysisResult.main_driver || "unknown")}`, `cause_status: ${String(analysisResult.cause_status || "unknown")}`]
            }
          ]
        }
      ]
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
      tone: "ai",
      drilldown: [
        {
          title: "Replay condensation",
          detail: "Day replay keeps detailed rows; month replay keeps important turns and summaries.",
          rows: [
            {
              label: "Day trace",
              status: stats.timelineEvents ? "stored" : "waiting",
              detail: `${stats.timelineEvents} detailed timeline event(s) available.`,
              meta: ["storage: timeline_events"]
            },
            {
              label: "Month summary",
              status: stats.monthSummaryEvents ? "summarized" : "waiting",
              detail: `${stats.monthSummaryEvents} month summary event(s) available.`,
              meta: ["storage: month_summary_events", "AI/rule: important turns only"]
            }
          ]
        }
      ]
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
      tone: "ai",
      drilldown: [
        {
          title: "Notification policy",
          detail: "Alerts are only sent when usefulness and evidence gates pass; otherwise the dashboard updates without paging the user.",
          rows: jobRows(alertEntry, "Alert preflight")
        }
      ]
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
      tone: "good",
      drilldown: [
        {
          title: "Dashboard output",
          detail: "Dashboard shows the latest validated state and evidence-limited explanation.",
          rows: [
            {
              label: "Current situation",
              status: String(analysisResult.cause_status || "pending"),
              detail: `main_driver: ${String(analysisResult.main_driver || "unknown")}`,
              meta: [`confidence: ${String(analysisResult.confidence || "unknown")}`, "source: validated AnalysisResult"]
            }
          ]
        }
      ]
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
      tone: "good",
      drilldown: [
        {
          title: "Evidence panel output",
          detail: "Short display summaries are shown here while raw rows remain auditable in storage.",
          rows: [
            {
              label: "News evidence",
              status: stats.newsRows ? "available" : "waiting",
              detail: `${stats.newsRows} news row(s) available for replay/evidence.`,
              meta: ["display: short summary", "storage: news_items"]
            },
            {
              label: "Calendar evidence",
              status: stats.calendarRows ? "available" : "waiting",
              detail: `${stats.calendarRows} calendar row(s) available for replay/evidence.`,
              meta: ["display: short summary", "storage: calendar_events"]
            }
          ]
        }
      ]
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
      tone: "store",
      drilldown: [
        {
          title: "Per-run trace",
          detail: "Replay follows the persisted path from raw source rows through processing, storage, evidence, and output.",
          rows: [
            {
              label: "Source rows",
              status: "stored",
              detail: `${stats.priceRows} price, ${stats.relatedRows} related asset, ${stats.newsRows} news, ${stats.calendarRows} calendar row(s).`,
              meta: ["storage: market_price_bars / related_asset_bars / news_items / calendar_events"]
            },
            {
              label: "Timeline rows",
              status: stats.timelineEvents ? "stored" : "waiting",
              detail: `${stats.timelineEvents} timeline event(s), ${stats.monthSummaryEvents} month summary event(s).`,
              meta: ["storage: timeline_events / month_summary_events"]
            }
          ]
        }
      ]
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
      tone: statusTone(alertStatus),
      drilldown: [
        {
          title: "Telegram delivery",
          detail: "Telegram may be sent or suppressed. Suppression is an output state, not a missing output.",
          rows: [
            {
              label: "Sent alerts",
              status: payload?.alerts?.length ? "sent" : "none",
              detail: `${payload?.alerts?.length ?? 0} sent alert(s) in the selected replay range.`,
              meta: ["storage: alerts"]
            },
            {
              label: "Suppressed alerts",
              status: payload?.suppressed_alerts?.length ? "suppressed" : alertStatus,
              detail: textValue(alertEntry, "detail") || `${payload?.suppressed_alerts?.length ?? 0} suppressed alert(s) in the selected replay range.`,
              meta: ["reason: evidence/noise/cooldown policy", "storage: alerts"]
            }
          ]
        }
      ]
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
