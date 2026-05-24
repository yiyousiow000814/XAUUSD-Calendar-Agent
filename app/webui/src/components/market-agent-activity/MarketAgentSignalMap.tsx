import { useMemo, useState } from "react";
import { CausalMesh } from "./CausalMesh";
import type { SignalMapModel, SignalNode } from "./signalMapModel";

type MarketAgentSignalMapProps = {
  model: SignalMapModel;
};

const boardPositions: Record<string, { x: number; y: number }> = {
  "assets-source": { x: 10, y: 24 },
  "news-source": { x: 10, y: 48 },
  "calendar-source": { x: 10, y: 72 },
  "asset-ingest": { x: 31, y: 24 },
  "news-processing": { x: 31, y: 48 },
  "context-gate": { x: 31, y: 72 },
  "storage-bus": { x: 52, y: 80 },
  "evidence-packet": { x: 52, y: 43 },
  "ai-analysis": { x: 70, y: 43 },
  "alert-router": { x: 70, y: 72 },
  "latest-evidence": { x: 88, y: 24 },
  "dashboard-output": { x: 88, y: 43 },
  "replay-output": { x: 88, y: 62 },
  "telegram-output": { x: 88, y: 80 }
};

const fallbackPosition = (index: number) => ({
  x: 18 + (index % 5) * 12,
  y: 91
});

const circuitPath = (from: { x: number; y: number }, to: { x: number; y: number }) => {
  const x1 = from.x + 5;
  const y1 = from.y + 3;
  const x2 = to.x;
  const y2 = to.y + 3;
  const mid = (x1 + x2) / 2;
  return `M ${x1} ${y1} H ${mid} V ${y2} H ${x2}`;
};

const boardPathPairs = [
  ["assets-source", "asset-ingest"],
  ["news-source", "news-processing"],
  ["calendar-source", "context-gate"],
  ["asset-ingest", "storage-bus"],
  ["news-processing", "storage-bus"],
  ["context-gate", "storage-bus"],
  ["asset-ingest", "evidence-packet"],
  ["news-processing", "evidence-packet"],
  ["context-gate", "evidence-packet"],
  ["storage-bus", "evidence-packet"],
  ["evidence-packet", "ai-analysis"],
  ["ai-analysis", "latest-evidence"],
  ["ai-analysis", "dashboard-output"],
  ["ai-analysis", "alert-router"],
  ["storage-bus", "replay-output"],
  ["alert-router", "telegram-output"],
  ["alert-router", "dashboard-output"]
];

const requestPathPairs = [
  ["ai-analysis", "assets-source"],
  ["ai-analysis", "news-source"],
  ["ai-analysis", "calendar-source"]
];

const firstNode = (nodes: SignalNode[], ids: string[]) => nodes.find((node) => ids.includes(node.id));

const countRowsLabel = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

const createBoardNodes = (model: SignalMapModel, allNodes: SignalNode[]) => {
  const price = firstNode(allNodes, ["price-source"]);
  const history = firstNode(allNodes, ["history-source"]);
  const news = firstNode(allNodes, ["news-source"]);
  const calendar = firstNode(allNodes, ["calendar-source"]);
  const evidence = firstNode(allNodes, ["evidence-packet", "evidence-gate"]);
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
  const candidateCount = model.candidateSensors.length + model.discoveredSensors.length;
  const storageTables = model.storageGroups.flatMap((group) => group.tables);

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
      tone: price?.tone || "working"
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
      tone: news?.tone || "working"
    }),
    boardNode({
      id: "calendar-source",
      label: "Calendar",
      lane: "Sources",
      group: "Scheduled context",
      status: calendar?.status || "collecting",
      action: calendar?.action || "Collecting events",
      source: calendar?.source || "Economic calendar",
      processing: "Calendar is already structured; it mainly needs timing alignment and storage.",
      output: "Context gate + Storage + Evidence packet",
      storage: ["calendar_events"],
      ai: "AI can summarize visible calendar rows, but does not invent unscheduled events.",
      trace: ["calendar-source", "context-gate", "storage-bus", "evidence-packet", "ai-analysis", "latest-evidence"],
      detail: calendar?.detail || "Calendar records scheduled macro context around the XAUUSD move.",
      tone: calendar?.tone || "working"
    }),
    boardNode({
      id: "asset-ingest",
      label: "Asset ingest",
      lane: "Processing",
      group: "Live + history",
      status: price?.status || "checking",
      action: `Live / history / anomalies`,
      source: "Assets source group",
      processing: "Live asset rows are usually stored directly; history fills gaps; anomaly detection marks unusual moves for evidence.",
      output: "Storage + Evidence packet",
      storage: ["market_price_bars", "related_asset_bars"],
      ai: "No AI for raw ingest. AI can request data, not bypass provider checks.",
      trace: ["assets-source", "asset-ingest", "storage-bus", "evidence-packet"],
      detail: `${price?.detail || "Live XAUUSD is collected."} ${history?.detail || "History backfill supports replay and analysis windows."}`,
      tone: price?.tone || "working"
    }),
    boardNode({
      id: "news-processing",
      label: "News processing",
      lane: "Processing",
      group: "Filter + summarize",
      status: news?.status || "checking",
      action: "Group, filter, shorten",
      source: "News raw rows",
      processing: "Raw news is grouped, deduped, checked for relevance, then shortened for Latest Evidence.",
      output: "Evidence packet + Latest Evidence",
      storage: ["news_items", "evidence_packets"],
      ai: "Display summarizer participates here; raw news remains persisted.",
      trace: ["news-source", "news-processing", "storage-bus", "evidence-packet", "ai-analysis", "latest-evidence"],
      detail: "Clicking through should let you inspect raw headline, source, publish time, summary, pass/drop reason, and next handoff.",
      tone: display?.tone || "ai"
    }),
    boardNode({
      id: "context-gate",
      label: "Context gate",
      lane: "Processing",
      group: "Calendar + timing",
      status: calendar?.status || "checking",
      action: "Align timing",
      source: "Calendar rows + market time",
      processing: "Keeps scheduled context separate from causal evidence unless it is close enough and relevant.",
      output: "Evidence packet + Replay",
      storage: ["calendar_events", "evidence_packets"],
      ai: "AI may summarize but cannot turn distant calendar rows into causes.",
      trace: ["calendar-source", "context-gate", "storage-bus", "evidence-packet", "ai-analysis", "replay-output"],
      detail: "Calendar usually needs less processing than news because it arrives structured.",
      tone: calendar?.tone || "working"
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
      trace: ["assets-source", "news-source", "calendar-source", "storage-bus", "evidence-packet", "ai-analysis", "replay-output"],
      detail: model.storageGroups.map((group) => `${group.title}: ${group.tables.join(", ")}`).join(" | "),
      tone: "store"
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
      trace: ["assets-source", "news-processing", "context-gate", "storage-bus", "evidence-packet", "ai-analysis", "latest-evidence"],
      detail: evidence?.detail || "Evidence packet is the handoff from collected records to analysis.",
      tone: evidence?.tone || "working"
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
      trace: ["evidence-packet", "ai-analysis", "latest-evidence", "dashboard-output", "alert-router", "storage-bus"],
      detail: "This is the closed loop: AI may need more assets/news/calendar context, but requests go back through sources and storage instead of inventing facts.",
      tone: "ai"
    }),
    boardNode({
      id: "alert-router",
      label: "Alert router",
      lane: "AI",
      group: "Preflight",
      status: alert?.status || "idle",
      action: alert?.action || "Check delivery",
      source: "Analysis result + evidence packet",
      processing: "Formats alert, checks freshness and evidence, then sends Telegram only if all gates pass.",
      output: "Telegram or dashboard only",
      storage: ["alerts"],
      ai: alert?.ai || "Optional alert review can rewrite or block delivery.",
      trace: ["ai-analysis", "alert-router", "telegram-output", "dashboard-output", "storage-bus"],
      detail: alert?.detail || "Alert routing answers: what happened, when, what evidence exists, what is missing, and what is the best unsupported explanation.",
      tone: alert?.tone || "working"
    }),
    ...(latest ? [{ ...latest, trace: ["ai-analysis", "latest-evidence", "storage-bus"] }] : []),
    ...(dashboard ? [{ ...dashboard, trace: ["ai-analysis", "dashboard-output", "storage-bus"] }] : []),
    ...(replayOutput ? [{ ...replayOutput, trace: ["storage-bus", "replay-output", "ai-analysis"] }] : []),
    ...(telegram ? [{ ...telegram, trace: ["alert-router", "telegram-output", "storage-bus"] }] : [])
  ];
};

function SignalNodeButton({
  node,
  selected,
  faded,
  onSelect
}: {
  node: SignalNode;
  selected: boolean;
  faded: boolean;
  onSelect: (node: SignalNode) => void;
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
      <span className="market-agent-signal-node-kicker">{node.group || node.lane}</span>
      <strong>{node.label}</strong>
      <small>{node.action}</small>
      <em>{node.output}</em>
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
    const ids = new Set(Object.keys(boardPositions));
    return boardNodes.filter((node) => ids.has(node.id));
  }, [boardNodes]);
  const nodePositions = useMemo(() => {
    const dynamicNodes = visibleNodes.filter((node) => !boardPositions[node.id]);
    const dynamicPositions = new Map(dynamicNodes.map((node, index) => [node.id, fallbackPosition(index)]));
    return new Map(visibleNodes.map((node) => [node.id, boardPositions[node.id] ?? dynamicPositions.get(node.id) ?? fallbackPosition(0)]));
  }, [visibleNodes]);

  return (
    <section className="market-agent-activity-surface market-agent-signal-map" aria-label="Agent activity board">
      <div className="market-agent-signal-hero">
        <div>
          <span>Signal Map</span>
          <h2>Market Agent circuit board</h2>
          <p>{model.phaseMessage} Follow any signal from source, through processing and AI, into storage and outputs.</p>
        </div>
        <em>{model.phaseLabel}</em>
      </div>

      <div className="market-agent-signal-board" data-selected-trace={selectedNode?.id || ""}>
        <svg className="market-agent-circuit-wires" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {boardPathPairs.map(([fromId, toId]) => {
            const from = nodePositions.get(fromId);
            const to = nodePositions.get(toId);
            if (!from || !to) return null;
            const active = selectedNode ? activeTrace.has(fromId) || activeTrace.has(toId) || selectedNode.id === fromId || selectedNode.id === toId : false;
            return <path key={`${fromId}-${toId}`} className={active ? "wire active" : "wire"} d={circuitPath(from, to)} />;
          })}
          {requestPathPairs.map(([fromId, toId]) => {
            const from = nodePositions.get(fromId);
            const to = nodePositions.get(toId);
            if (!from || !to) return null;
            const active = selectedNode ? selectedNode.id === fromId || selectedNode.id === toId || activeTrace.has(fromId) || activeTrace.has(toId) : false;
            return <path key={`${fromId}-${toId}-request`} className={active ? "wire wire-request active" : "wire wire-request"} d={circuitPath(from, to)} />;
          })}
        </svg>

        <div className="market-agent-board-column-label label-sources">Sources</div>
        <div className="market-agent-board-column-label label-processing">Processing</div>
        <div className="market-agent-board-column-label label-storage">Storage</div>
        <div className="market-agent-board-column-label label-ai">AI Loop</div>
        <div className="market-agent-board-column-label label-outputs">Outputs</div>

        {visibleNodes.map((node) => {
          const position = nodePositions.get(node.id) ?? fallbackPosition(0);
          return (
            <div className="market-agent-circuit-node-wrap" style={{ left: `${position.x}%`, top: `${position.y}%` }} key={node.id}>
              <SignalNodeButton
                node={node}
                selected={selectedId === node.id}
                faded={Boolean(selectedId) && !activeTrace.has(node.id)}
                onSelect={selectNode}
              />
            </div>
          );
        })}
      </div>

      <section className="market-agent-board-legend" aria-label="Activity system summary">
        <div className="market-agent-board-legend-title">
          <span>Assets</span>
          <h3>Grouped watchlist</h3>
        </div>
        <div>
          <span>Configured Assets</span>
          <h3>Core + candidate</h3>
          <strong>{model.coreSensors.length} core / {model.candidateSensors.length} candidate / {model.discoveredSensors.length} unmapped</strong>
        </div>
        <div>
          <span>AI Requests</span>
          <h3>Controlled feedback</h3>
          <strong>Requests need provider mapping and evidence gates</strong>
        </div>
        <div>
          <span>Storage</span>
          <h3>Raw + derived</h3>
          <strong>{model.storageGroups.map((group) => group.title).join(" / ")}</strong>
        </div>
        <div>
          <span>TimelineStore</span>
          <strong>{model.storagePath}</strong>
        </div>
      </section>

      {selectedNode ? <CausalMesh node={selectedNode} allNodes={allNodes} onClose={() => setSelectedId("")} onSelect={selectNode} /> : null}
    </section>
  );
}
