import { useMemo, useState } from "react";
import { CausalMesh } from "./CausalMesh";
import type { SignalDataRequest, SignalDrilldownSection, SignalMapModel, SignalNode } from "./signalMapModel";

type MarketAgentSignalMapProps = {
  model: SignalMapModel;
};

const firstNode = (nodes: SignalNode[], ids: string[]) => nodes.find((node) => ids.includes(node.id));

const countRowsLabel = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

const mergeSections = (sections: Array<SignalDrilldownSection[] | undefined>) => sections.flatMap((section) => section ?? []);
const mergeRequests = (requests: Array<SignalDataRequest[] | undefined>) => requests.flatMap((request) => request ?? []);

const createBoardNodes = (model: SignalMapModel, allNodes: SignalNode[]) => {
  const price = firstNode(allNodes, ["price-source"]);
  const history = firstNode(allNodes, ["history-source"]);
  const news = firstNode(allNodes, ["news-source"]);
  const calendar = firstNode(allNodes, ["calendar-source"]);
  const evidence = firstNode(allNodes, ["evidence-packet", "evidence-gate"]);
  const driverAttention = firstNode(allNodes, ["driver-attention"]);
  const display = firstNode(model.aiNodes, ["display-summarizer"]);
  const cause = firstNode(model.aiNodes, ["cause-review"]);
  const validator = firstNode(model.aiNodes, ["validator-repair"]);
  const replay = firstNode(model.aiNodes, ["replay-condenser"]);
  const alert = firstNode(model.aiNodes, ["alert-review"]);
  const latest = firstNode(model.outputs, ["latest-evidence"]);
  const dashboard = firstNode(model.outputs, ["dashboard-output"]);
  const replayOutput = firstNode(model.outputs, ["replay-output"]);
  const telegram = firstNode(model.outputs, ["telegram-output"]);
  const liveAssets = model.coreSensors.filter((node) => ["ready", "live", "live_seen", "backfilled"].some((status) => node.status.toLowerCase().includes(status))).length;
  const storageTables = model.storageGroups.flatMap((group) => group.tables);
  const dataRequests = mergeRequests([
    ...model.coreSensors.map((sensor) => sensor.requests),
    ...model.candidateSensors.map((sensor) => sensor.requests),
    ...model.discoveredSensors.map((sensor) => sensor.requests)
  ]);

  const boardNode = (input: Omit<SignalNode, "tone"> & { tone?: SignalNode["tone"] }): SignalNode => ({
    tone: input.tone ?? "muted",
    ...input
  });

  return [
    boardNode({
      id: "assets-source",
      label: "Assets",
      lane: "Sources",
      group: "Market data",
      status: price?.status || "waiting",
      action: `${price?.action || "Live quote"} + ${history?.action || "history gaps"}`,
      source: "cTrader / Yahoo / local fallback",
      processing: "Assets groups XAUUSD, related watchlist symbols, provider health, live fetches, and history backfill requests.",
      output: "Asset ingest + Storage + Evidence packet",
      storage: ["market_price_bars", "related_asset_bars", "provider_health"],
      ai: "AI may request more lookback or a new sensor candidate, but provider mapping and allowlists decide what can be added.",
      trace: ["assets-source", "asset-ingest", "storage-bus", "evidence-packet", "ai-analysis", "dashboard-output", "replay-output"],
      detail: `Assets is the source group, not one symbol. It contains ${countRowsLabel(model.coreSensors.length, "core watch item")}, ${countRowsLabel(liveAssets, "currently usable item")}, live XAUUSD, related assets, and history backfill records.`,
      tone: price?.tone || "working",
      badges: [
        { label: "source group", tone: "good" },
        { label: "live/history/backfill", tone: "working" },
        { label: "not individual nodes", tone: "muted" }
      ],
      drilldown: [
        {
          title: "Assets source group",
          detail: "Clicking Assets reveals the tracked sensors without making each one a top-level circuit node.",
          rows: model.coreSensors.map((sensor) => ({
            label: sensor.label,
            status: sensor.status,
            detail: sensor.detail,
            meta: [
              `provider: ${sensor.source}`,
              `storage: ${sensor.storage.join(", ")}`,
              `used_by: ${sensor.output}`,
              `why: ${sensor.processing}`
            ]
          }))
        },
        ...mergeSections([price?.drilldown, history?.drilldown, ...model.coreSensors.map((sensor) => sensor.drilldown)])
      ],
      requests: mergeRequests(model.coreSensors.map((sensor) => sensor.requests))
    }),
    boardNode({
      id: "news-source",
      label: "News",
      lane: "Sources",
      group: "Raw context",
      status: news?.status || "collecting",
      action: news?.action || "Collecting headlines",
      source: news?.source || "App-managed feeds",
      processing: "Raw headlines stay raw at collection, then pass through relevance grouping and summarization before display.",
      output: "News processing + Storage + Evidence packet",
      storage: ["news_items"],
      ai: "AI can summarize display text and help judge relevance after the evidence gate.",
      trace: ["news-source", "news-processing", "storage-bus", "evidence-packet", "ai-analysis", "latest-evidence"],
      detail: news?.detail || "News provides raw, timestamped context that may or may not explain the move.",
      tone: news?.tone || "working",
      badges: [
        { label: "raw -> filtered", tone: "working" },
        { label: "theme discovery", tone: "ai" },
        { label: "stored", tone: "store" }
      ],
      drilldown: mergeSections([news?.drilldown])
    }),
    boardNode({
      id: "calendar-source",
      label: "Calendar",
      lane: "Sources",
      group: "Scheduled context",
      status: calendar?.status || "collecting",
      action: calendar?.action || "Reading calendar context",
      source: calendar?.source || "Existing Economic Calendar",
      processing: "Market Agent reads the existing Economic Calendar and aligns scheduled events to the current XAUUSD move window.",
      output: "Context window + Evidence packet",
      storage: ["calendar context snapshot"],
      ai: "AI can summarize visible calendar rows, but does not invent unscheduled events.",
      trace: ["calendar-source", "context-gate", "evidence-packet", "ai-analysis", "latest-evidence"],
      detail: calendar?.detail || "Market Agent does not fetch a separate calendar feed here; it reads the app's existing Economic Calendar and aligns relevant events to the move.",
      tone: calendar?.tone || "working",
      badges: [
        { label: "existing calendar", tone: "good" },
        { label: "window aligned", tone: "working" },
        { label: "context snapshot", tone: "store" }
      ],
      drilldown: mergeSections([calendar?.drilldown])
    }),
    boardNode({
      id: "ingest-hub",
      label: "Ingest",
      lane: "Processing",
      group: "Live + raw capture",
      status: price?.status || news?.status || calendar?.status || "checking",
      action: "Live, history, raw capture",
      source: "Assets + News + Calendar",
      processing: "Ingest records what arrived, what was stale or unavailable, what was backfilled, and what failed before processing begins.",
      output: "Process + Storage",
      storage: ["market_price_bars", "related_asset_bars", "news_items", "provider_health"],
      ai: "AI can request more data, but ingest only records provider-backed rows.",
      trace: ["assets-source", "news-source", "calendar-source", "ingest-hub", "process-hub", "storage-bus"],
      detail: "Ingest is the intake dock: asset live/history/backfill, raw news capture, and structured calendar rows stay separated but share one auditable handoff.",
      tone: "working",
      badges: [
        { label: "live", tone: "good" },
        { label: "history/backfill", tone: "working" },
        { label: "raw captured", tone: "store" }
      ],
      drilldown: mergeSections([price?.drilldown, history?.drilldown, news?.drilldown, calendar?.drilldown])
    }),
    boardNode({
      id: "process-hub",
      label: "Process",
      lane: "Processing",
      group: "Normalize + filter",
      status: evidence?.status || "checking",
      action: "Normalize, filter, detect",
      source: "Ingested rows",
      processing: "Assets are normalized and checked for freshness/anomalies; news is deduped, scored, filtered, and summarized; calendar is aligned to event windows.",
      output: "Storage + Evidence packet",
      storage: ["related_asset_bars", "news_items", "evidence_packets"],
      ai: "AI helps summarize and discover themes after deterministic gates, not during raw capture.",
      trace: ["ingest-hub", "process-hub", "storage-bus", "evidence-packet", "ai-analysis"],
      detail: "Process keeps each source type honest: assets mostly store and detect moves, news does the heavy filtering, calendar mostly aligns timing windows.",
      tone: "working",
      badges: [
        { label: "assets: normalize + anomaly", tone: "working" },
        { label: "news: dedupe + themes", tone: "ai" },
        { label: "calendar: windows", tone: "good" }
      ],
      drilldown: mergeSections([news?.drilldown, calendar?.drilldown, display?.drilldown, evidence?.drilldown])
    }),
    boardNode({
      id: "storage-bus",
      label: "Storage",
      lane: "Audit",
      group: "TimelineStore",
      status: "stored",
      action: model.storagePath,
      source: "Raw and derived records",
      processing: "Persists raw rows, provider health, evidence packets, analysis results, alerts, timeline events, and month summaries.",
      output: "Replay + Evidence detail + AI read context",
      storage: storageTables,
      ai: "AI reads bounded stored context; storage keeps audit records so one-month-old runs remain inspectable.",
      trace: ["ingest-hub", "process-hub", "storage-bus", "evidence-packet", "ai-analysis", "output-hub"],
      detail: model.storageGroups.map((group) => `${group.title}: ${group.tables.join(", ")}`).join(" | "),
      tone: "store",
      drilldown: [
        {
          title: "Persisted audit stores",
          detail: "Storage keeps raw and derived data so a previous run can be reconstructed later.",
          rows: model.storageGroups.map((group) => ({
            label: group.title,
            status: "stored",
            detail: group.detail,
            meta: group.tables.map((table) => `table: ${table}`)
          }))
        }
      ]
    }),
    boardNode({
      id: "evidence-packet",
      label: "Evidence packet",
      lane: "Processing",
      group: "Bounded packet",
      status: evidence?.status || "pending",
      action: evidence?.action || "Build packet",
      source: "Assets + News + Calendar + Storage",
      processing: evidence?.processing || "Build bounded evidence and pass/drop reasons before AI analysis.",
      output: "AI analysis + Latest Evidence",
      storage: ["evidence_packets"],
      ai: "AI can only review what the packet allows.",
      trace: ["process-hub", "storage-bus", "evidence-packet", "ai-analysis", "output-hub"],
      detail: evidence?.detail || "Evidence packet is the handoff from collected records to analysis.",
      tone: evidence?.tone || "working",
      drilldown: mergeSections([evidence?.drilldown])
    }),
    boardNode({
      id: "ai-analysis",
      label: "AI Analysis",
      lane: "AI",
      group: "Review loop",
      status: cause?.status || "queued",
      action: cause?.action || "Review evidence",
      source: "Evidence packet + stored context",
      processing: "Rule baseline runs first, LLM reviews bounded evidence, validator repairs or rejects invalid JSON, then output surfaces update.",
      output: "Dashboard + Latest Evidence + Alert router",
      storage: ["analysis_results"],
      ai: `${display?.label || "Display summarizer"} / ${cause?.label || "Cause review"} / ${validator?.label || "Validator"} / ${replay?.label || "Replay condenser"}`,
      trace: ["evidence-packet", "ai-analysis", "output-hub", "feedback-hub", "storage-bus"],
      detail: "This is the closed loop: AI may need more assets/news/calendar context, but requests go back through sources and storage instead of inventing facts.",
      tone: "ai",
      badges: [
        { label: "evidence gate", tone: "working" },
        { label: "theme discovery", tone: "ai" },
        { label: "validator guarded", tone: "good" }
      ],
      drilldown: [
        ...mergeSections([evidence?.drilldown, driverAttention?.drilldown, display?.drilldown, cause?.drilldown, validator?.drilldown, replay?.drilldown, alert?.drilldown]),
        {
          title: "Feedback / data requests",
          detail: "Requests loop back to sources and sensors. They are visible limitations or priorities, not invented evidence.",
          rows: mergeRequests([
            ...model.coreSensors.map((sensor) => sensor.requests),
            ...model.candidateSensors.map((sensor) => sensor.requests),
            ...model.discoveredSensors.map((sensor) => sensor.requests)
          ]).map((request) => ({
            label: request.target,
            status: request.status,
            detail: request.reason,
            meta: [`requested_by: ${request.requestedBy}`, `mode: ${request.mode}`]
          }))
        }
      ],
      requests: dataRequests
    }),
    boardNode({
      id: "output-hub",
      label: "Outputs",
      lane: "Outputs",
      group: "User surfaces",
      status: alert?.status || "idle",
      action: "Dashboard, replay, evidence, Telegram",
      source: "Analysis result + evidence packet",
      processing: "Validated results update dashboard, replay, latest evidence, and Telegram only when notification policy allows it.",
      output: "Dashboard + Replay + Evidence + Telegram",
      storage: ["analysis_results", "timeline_events", "month_summary_events", "alerts"],
      ai: alert?.ai || "Output text may be summarized or reviewed, but validated facts remain bounded by evidence.",
      trace: ["ai-analysis", "output-hub", "storage-bus"],
      detail: "Outputs answer what happened, when it happened, what evidence exists, what is missing, and why Telegram was sent or suppressed.",
      tone: alert?.tone || "working",
      drilldown: mergeSections([latest?.drilldown, dashboard?.drilldown, replayOutput?.drilldown, alert?.drilldown, telegram?.drilldown])
    }),
    boardNode({
      id: "feedback-hub",
      label: "Feedback",
      lane: "Feedback",
      group: "Data requests",
      status: dataRequests.length ? "watching" : "idle",
      action: dataRequests.length ? `${dataRequests.length} request(s)` : "No request",
      source: "AI loop + evidence limitations",
      processing: "Missing, stale, unavailable, or theme-specific needs become source requests instead of invented evidence.",
      output: "Source priority changes",
      storage: ["provider_health", "driver_attention_states", "evidence_packets"],
      ai: "AI can propose what is needed; provider mapping, allowlists, freshness, and validator keep it grounded.",
      trace: ["ai-analysis", "feedback-hub", "assets-source", "news-source", "calendar-source", "ingest-hub"],
      detail: "Feedback closes the loop: the system can ask for more lookback, higher-priority sensors, or a provider mapping while showing limitations honestly.",
      tone: dataRequests.length ? "working" : "muted",
      badges: [
        { label: "closed loop", tone: "working" },
        { label: "no hallucinated sensor", tone: "good" }
      ],
      drilldown: [
        {
          title: "Feedback / data requests",
          detail: "Requests return to source groups. They are visible limitations or priorities, not proof of a driver.",
          rows: dataRequests.length
            ? dataRequests.map((request) => ({
                label: request.target,
                status: request.status,
                detail: request.reason,
                meta: [`requested_by: ${request.requestedBy}`, `mode: ${request.mode}`]
              }))
            : [
                {
                  label: "No current request",
                  status: "idle",
                  detail: "The selected run did not require more source data.",
                  meta: ["feedback loop ready"]
                }
              ]
        }
      ],
      requests: dataRequests
    })
  ];
};

function SignalNodeButton({
  node,
  selected,
  faded,
  onSelect,
  handoff
}: {
  node: SignalNode;
  selected: boolean;
  faded: boolean;
  onSelect: (node: SignalNode) => void;
  handoff?: string;
}) {
  return (
    <button
      type="button"
      className={`market-agent-signal-node tone-${node.tone}${selected ? " selected" : ""}${faded ? " faded" : ""}`}
      onClick={() => onSelect(node)}
      aria-pressed={selected}
      aria-label={`${node.label}: ${node.action}`}
    >
      <span className="market-agent-signal-dot" aria-hidden="true" />
      <strong>{node.label}</strong>
      <small>{node.action}</small>
      {handoff ? <span className="market-agent-node-handoff">{handoff}</span> : null}
    </button>
  );
}

export function MarketAgentSignalMap({ model }: MarketAgentSignalMapProps) {
  const detailNodes = useMemo(
    () => [
      ...model.lanes.flatMap((lane) => lane.nodes),
      ...model.candidateSensors,
      ...model.discoveredSensors,
      ...model.aiNodes,
      ...model.outputs
    ],
    [model]
  );
  const boardNodes = useMemo(() => createBoardNodes(model, detailNodes), [model, detailNodes]);
  const allNodes = useMemo(() => [...boardNodes, ...detailNodes], [boardNodes, detailNodes]);
  const [selectedId, setSelectedId] = useState("");
  const selectedNode = selectedId ? allNodes.find((node) => node.id === selectedId) : undefined;
  const activeTrace = useMemo(() => new Set(selectedNode?.trace ?? []), [selectedNode]);
  const selectNode = (node: SignalNode) => setSelectedId(node.id);
  const visibleNodes = useMemo(() => {
    const ids = new Set(["assets-source", "news-source", "calendar-source", "ingest-hub", "process-hub", "storage-bus", "evidence-packet", "ai-analysis", "output-hub", "feedback-hub"]);
    return boardNodes.filter((node) => ids.has(node.id));
  }, [boardNodes]);

  return (
    <section className="market-agent-activity-surface market-agent-signal-map" aria-label="Agent activity board">
      <div className="market-agent-signal-hero">
        <div>
          <span>Signal Map</span>
          <h2>What the agent is doing now</h2>
          <p>{model.phaseMessage} Start with the loop, then click one source or step to follow the exact records behind it.</p>
        </div>
        <em>{model.phaseLabel}</em>
      </div>

      {selectedNode ? (
        <CausalMesh node={selectedNode} allNodes={allNodes} onClose={() => setSelectedId("")} />
      ) : (
        <div className="market-agent-signal-board" data-selected-trace={selectedNode?.id || ""}>
          <section className="market-agent-board-zone source-zone" aria-label="Source groups">
            <span>Sources</span>
            {visibleNodes.filter((node) => ["assets-source", "news-source", "calendar-source"].includes(node.id)).map((node) => (
              <SignalNodeButton key={node.id} node={node} selected={selectedId === node.id} faded={false} onSelect={selectNode} handoff="Next: Ingest" />
            ))}
          </section>

          <section className="market-agent-board-zone trace-zone" aria-label="Run trace">
            <span>Run trace</span>
            {visibleNodes.filter((node) => ["ingest-hub", "process-hub", "storage-bus", "evidence-packet", "ai-analysis", "output-hub"].includes(node.id)).map((node, index) => (
              <div className="market-agent-trace-step" key={node.id}>
                <b>{String(index + 1).padStart(2, "0")}</b>
                <SignalNodeButton
                  node={node}
                  selected={selectedId === node.id}
                  faded={Boolean(selectedId) && !activeTrace.has(node.id)}
                  onSelect={selectNode}
                  handoff={index === 0 ? "From: Assets, News, Calendar" : index === 5 ? "To: user surfaces" : "Next step"}
                />
              </div>
            ))}
          </section>

          <section className="market-agent-board-zone feedback-zone" aria-label="Feedback queue">
            <span>Feedback</span>
            {visibleNodes.filter((node) => node.id === "feedback-hub").map((node) => (
              <SignalNodeButton key={node.id} node={node} selected={selectedId === node.id} faded={false} onSelect={selectNode} handoff="Only when more data is needed" />
            ))}
            <p>Requests go back to source groups only when provider mapping, freshness, and evidence gates allow it.</p>
          </section>
        </div>
      )}
    </section>
  );
}
