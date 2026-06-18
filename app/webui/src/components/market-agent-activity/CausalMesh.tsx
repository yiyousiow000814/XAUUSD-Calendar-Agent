import { useMemo, useState } from "react";
import type { SignalDecisionTraceItem, SignalMapModel, SignalNode } from "./signalMapModel";
import { formatUtcOffset, getSystemUtcOffsetMinutes } from "../../utils/calendarTime";

type CausalMeshProps = {
  node: SignalNode;
  allNodes: SignalNode[];
  model: SignalMapModel;
  onClose: () => void;
};

const strengthFor = (node: SignalNode) => {
  if (node.tone === "good" || node.tone === "ai") return "strong";
  if (node.tone === "working" || node.tone === "store") return "watch";
  if (node.tone === "bad") return "blocked";
  return "background";
};

const uniqueById = (nodes: SignalNode[]) => Array.from(new Map(nodes.map((node) => [node.id, node])).values());

const metaAfter = (items: string[], prefix: string) => {
  const match = items.find((item) => item.toLowerCase().startsWith(prefix.toLowerCase()));
  return match ? match.slice(prefix.length).trim() : "--";
};

const monthLabels = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad2 = (value: number) => String(value).padStart(2, "0");

const formatHistoryTime = (value: string) => {
  if (!value || value === "--" || value.toLowerCase() === "not recorded") return value || "--";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  const readable = `${pad2(parsed.getDate())} ${monthLabels[parsed.getMonth()]} ${parsed.getFullYear()} ${pad2(parsed.getHours())}:${pad2(parsed.getMinutes())}`;
  return `${readable} ${formatUtcOffset(getSystemUtcOffsetMinutes(parsed.getTime()))}`;
};

const displayMetaValue = (label: string, value: string) => {
  if (/_at$/i.test(label.trim())) return formatHistoryTime(value);
  return value;
};

const splitMeta = (meta: string) => {
  const [label, ...rest] = meta.split(":");
  const value = rest.join(":").trim();
  return {
    label: rest.length ? label : "record",
    value: rest.length ? displayMetaValue(label, value) : meta
  };
};

const compactStatus = (status: string) => status.replace(/_/g, " ");

const titleCaseStatus = (value: string) =>
  compactStatus(value)
    .split(" ")
    .filter(Boolean)
    .map((part) => (part.toLowerCase() === "ai" ? "AI" : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()))
    .join(" ");

const newsHistoryStatusLabel = (status: string, summarySource: string) => {
  const normalizedStatus = status.toLowerCase().replace(/_/g, " ");
  const normalizedSource = summarySource.toLowerCase();
  if (normalizedSource.includes("local ai") || normalizedSource.includes("ai") || normalizedStatus.includes("summar")) {
    return "AI summarized";
  }
  if (normalizedStatus.includes("filtered") || normalizedStatus.includes("excluded") || normalizedStatus.includes("rejected")) {
    return "Filtered out";
  }
  if (normalizedStatus.includes("included") || normalizedStatus.includes("accepted") || normalizedStatus.includes("used")) {
    return "Accepted input";
  }
  if (normalizedStatus.includes("unreviewed")) return "Raw context";
  return "Rule kept";
};

const statusKind = (status: string) => {
  const normalized = status.toLowerCase().replace(/_/g, " ");
  if (normalized.includes("guarded")) return "good";
  if (normalized.includes("unavailable") || normalized.includes("blocked") || normalized.includes("failed")) return "bad";
  if (normalized.includes("stale") || normalized.includes("waiting") || normalized.includes("syncing") || normalized.includes("checking") || normalized.includes("watching") || normalized.includes("emerging")) return "watch";
  if (normalized.includes("market closed") || normalized.includes("snapshot")) return "watch";
  if (normalized.includes("confirming") || normalized.includes("returned") || normalized.includes("filled")) return "confirming";
  if (normalized.includes("live") || normalized.includes("ready") || normalized.includes("stored") || normalized.includes("available") || normalized.includes("approved") || normalized.includes("active") || normalized.includes("validated") || normalized.includes("recorded") || normalized.includes("completed")) return "good";
  if (normalized.includes("dormant") || normalized.includes("skipped") || normalized.includes("not recorded") || normalized.includes("neutral") || normalized.includes("none")) return "muted";
  return "neutral";
};

const statusRank = (status: string) => {
  const kind = statusKind(status);
  if (kind === "bad") return 0;
  if (kind === "watch") return 1;
  if (kind === "confirming") return 2;
  if (kind === "good") return 3;
  if (kind === "muted") return 4;
  return 5;
};

const rowRank = (label: string) => {
  if (label.toLowerCase() === "xauusd") return 0;
  return 1;
};

const requestBucket = (status: string) => {
  const normalized = status.toLowerCase();
  if (normalized.includes("unavailable") || normalized.includes("unmapped") || normalized.includes("blocked")) return "Action needed";
  if (normalized.includes("stale")) return "Needs refresh";
  if (normalized.includes("guarded")) return "Monitoring";
  if (normalized.includes("watch")) return "Monitoring";
  return "Open";
};

const requestTone = (status: string) => {
  const normalized = status.toLowerCase();
  if (normalized.includes("unavailable") || normalized.includes("unmapped") || normalized.includes("blocked")) return "bad";
  if (normalized.includes("guarded")) return "working";
  if (normalized.includes("watch")) return "working";
  if (normalized.includes("stale")) return "working";
  return "muted";
};

const summarizeRequests = (requests: NonNullable<SignalNode["requests"]>) =>
  Array.from(
    requests.reduce((groups, request) => {
      const bucket = requestBucket(request.status);
      const items = groups.get(bucket) ?? [];
      items.push(request);
      groups.set(bucket, items);
      return groups;
    }, new Map<string, NonNullable<SignalNode["requests"]>>())
  ).sort(([left], [right]) => {
    const order = ["Action needed", "Needs refresh", "Monitoring", "Open"];
    return order.indexOf(left) - order.indexOf(right);
  });

const compactRequestRows = (requests: NonNullable<SignalNode["requests"]>) =>
  Array.from(
    requests.reduce((groups, request) => {
      const key = [request.status, request.requestedBy, request.reason, request.mode].join("|");
      const existing = groups.get(key);
      if (existing) {
        existing.targets.push(request.target);
      } else {
        groups.set(key, { ...request, targets: [request.target] });
      }
      return groups;
    }, new Map<string, NonNullable<SignalNode["requests"]>[number] & { targets: string[] }>())
      .values()
  );

const requestTitle = (request: NonNullable<SignalNode["requests"]>[number] & { targets: string[] }) => {
  if (request.targets.length > 1 && request.reason.toLowerCase().includes("no provider status")) return "Provider status not reported";
  if (request.targets.length > 1 && request.status.toLowerCase().includes("unmapped")) return "New sensor candidates";
  if (request.targets.length > 1 && request.status.toLowerCase().includes("guarded")) return "Drivers held out by evidence gate";
  if (request.targets.length > 1 && request.status.toLowerCase().includes("watch")) return "Themes under watch";
  if (request.status.toLowerCase().includes("unavailable")) return `${request.target} unavailable`;
  if (request.status.toLowerCase().includes("guarded")) return `${request.target} guarded`;
  return request.targets.length > 1 ? `${request.targets.length} sensors` : request.target;
};

const requestReason = (request: NonNullable<SignalNode["requests"]>[number] & { targets: string[] }) => {
  if (request.targets.length > 1 && request.reason.toLowerCase().includes("no provider status")) return "These sensors are watched, but the current payload did not include provider health for them.";
  if (request.status.toLowerCase().includes("unavailable")) return "This cannot be used as neutral or confirming evidence until a reliable source is available.";
  if (request.status.toLowerCase().includes("guarded")) return "This is not a data failure. The evidence gate is keeping this driver out of the current market conclusion until fresh confirmation appears.";
  return request.reason;
};

const requestTargets = (request: NonNullable<SignalNode["requests"]>[number] & { targets: string[] }) => request.targets.join(", ");

const requestImpact = (status: string) => {
  const bucket = requestBucket(status);
  if (bucket === "Action needed") return "Limits confidence";
  if (bucket === "Needs refresh") return "Needs fresh data";
  if (status.toLowerCase().includes("guarded")) return "Guarded";
  if (bucket === "Monitoring") return "Watch only";
  return "Open request";
};

const decisionTone = (item: SignalDecisionTraceItem) => `tone-${item.tone}`;

const statusNodesFor = (nodes: SignalNode[]) => {
  const seen = new Set<string>();
  return nodes.filter((node) => {
    const isStatusNode = ["Sources", "Processing", "AI", "Outputs", "Feedback", "Audit"].includes(node.lane) || node.id.includes("source") || node.id.includes("hub");
    if (!isStatusNode || seen.has(node.id)) return false;
    seen.add(node.id);
    return true;
  });
};

const renderRecordRows = (sectionTitle: string, node: SignalNode, rows: NonNullable<SignalNode["drilldown"]>[number]["rows"]) => {
  if (rows.length) {
    const sortedRows = [...rows].sort((left, right) => statusRank(left.status) - statusRank(right.status) || rowRank(left.label) - rowRank(right.label) || left.label.localeCompare(right.label));
    return (
      <div className="market-agent-record-matrix" role="table" aria-label={`${sectionTitle} records`}>
        <div className="market-agent-record-matrix-head" role="row">
          <span>Status</span>
          <span>Signal</span>
          <span>Source</span>
          <span>Stored</span>
          <span>Used by</span>
        </div>
        {sortedRows.map((row, rowIndex) => {
          const provider = metaAfter(row.meta, "provider:");
          const source = metaAfter(row.meta, "source:");
          const input = metaAfter(row.meta, "input:");
          const storage = metaAfter(row.meta, "storage:");
          const output = metaAfter(row.meta, "output:");
          const handoff = metaAfter(row.meta, "handoff:");
          const usedBy = metaAfter(row.meta, "used_by:");
          const why = metaAfter(row.meta, "why:");
          return (
            <article key={`${sectionTitle}-${row.label}-${row.status}-${rowIndex}`} className={`market-agent-record-matrix-row tone-${strengthFor({ ...node, tone: row.tone ?? node.tone, status: row.status })} status-${statusKind(row.status)}`} role="row">
              <div role="cell"><span>{compactStatus(row.status)}</span></div>
              <div role="cell"><strong>{row.label}</strong></div>
              <div role="cell">{provider !== "--" ? provider : source !== "--" ? source : input}</div>
              <div role="cell">{storage !== "--" ? storage : output !== "--" ? output : handoff}</div>
              <div role="cell">{usedBy !== "--" ? usedBy : why !== "--" ? why : row.detail}</div>
            </article>
          );
        })}
      </div>
    );
  }

  return (
    <article className="market-agent-trace-row">
      <div>
        <span>empty</span>
        <strong>No rows recorded</strong>
        <p>This step is visible, but no row-level detail exists in the current payload.</p>
      </div>
    </article>
  );
};

const renderHistoryRows = (sectionTitle: string, node: SignalNode, rows: NonNullable<SignalNode["history"]>[number]["rows"], onSelect: (row: NonNullable<SignalNode["history"]>[number]["rows"][number]) => void) => {
  if (!rows.length) {
    return (
      <article className="market-agent-trace-row">
        <div>
          <span>empty</span>
          <strong>No history rows</strong>
          <p>No captured rows exist for this run/range.</p>
        </div>
      </article>
    );
  }

  return (
    <div className="market-agent-history-record-list" role="list" aria-label={`${sectionTitle} rows`}>
      <div className="market-agent-history-record-head" aria-hidden="true">
        <span>Status</span>
        <span>Headline</span>
        <span>Source</span>
        <span>Published</span>
        <span>Fetched</span>
        <span>AI</span>
      </div>
      {rows.map((row, rowIndex) => {
        const source = metaAfter(row.meta, "source:");
        const publishedAtRaw = metaAfter(row.meta, "published_at:");
        const fetchedAtRaw = metaAfter(row.meta, "fetched_at:");
        const publishedAt = formatHistoryTime(publishedAtRaw);
        const fetchedAt = formatHistoryTime(fetchedAtRaw);
        const summarySource = metaAfter(row.meta, "summary_source:");
        const aiState = summarySource === "--" || summarySource === "not recorded" ? "not processed" : summarySource;
        const statusLabel = newsHistoryStatusLabel(row.status, summarySource);
        return (
          <button
            type="button"
            key={`${sectionTitle}-${row.label}-${row.status}-${rowIndex}`}
            className={`market-agent-history-record status-${statusKind(row.status)} tone-${strengthFor({ ...node, tone: node.tone, status: row.status })}`}
            aria-label={`${row.label} history record`}
            onClick={() => onSelect(row)}
          >
            <span>{statusLabel}</span>
            <strong>{row.label}</strong>
            <em>{source}</em>
            <time dateTime={publishedAtRaw === "--" ? undefined : publishedAtRaw} title={publishedAtRaw === publishedAt ? undefined : publishedAtRaw}>{publishedAt}</time>
            <time dateTime={fetchedAtRaw === "--" ? undefined : fetchedAtRaw} title={fetchedAtRaw === fetchedAt ? undefined : fetchedAtRaw}>{fetchedAt}</time>
            <small>{aiState}</small>
          </button>
        );
      })}
    </div>
  );
};

function AiHistoryPane({ model }: { model: SignalMapModel }) {
  const trace = model.decisionTrace;
  const [selectedItem, setSelectedItem] = useState<SignalDecisionTraceItem | null>(null);
  const hasItems = trace.items.length > 0;
  const runTimeLabel = formatHistoryTime(trace.runLabel);

  return (
    <section className="market-agent-history-ledger compact" aria-label="AI analysis history">
      <header>
        <div>
          <span>AI History</span>
          <h4>Local AI call audit</h4>
          <p>{trace.summary}</p>
        </div>
      </header>
      {hasItems ? (
        <div className="market-agent-history-list" role="table" aria-label="Local AI call audit rows">
          <div className="market-agent-history-head" role="row">
            <span>Time</span>
            <span>AI step</span>
            <span>Decision</span>
            <span>Status</span>
          </div>
          {trace.items.map((item) => {
            const callType = metaAfter(item.meta, "type:");
            const fallbackType = metaAfter(item.meta, "task:");
            const result = metaAfter(item.meta, "result:");
            const itemTimeRaw = metaAfter(item.meta, "run_started_at:");
            const itemTimeLabel = itemTimeRaw !== "--" ? formatHistoryTime(itemTimeRaw) : runTimeLabel;
            return (
              <button
                type="button"
                className={`market-agent-history-row ${decisionTone(item)}`}
                key={`${item.label}-${item.status}-${itemTimeRaw}`}
                onClick={() => setSelectedItem(item)}
                role="row"
                title={item.detail}
              >
                <time role="cell" dateTime={itemTimeRaw !== "--" ? itemTimeRaw : trace.runLabel} title={itemTimeRaw !== "--" ? itemTimeRaw : trace.runLabel}>
                  {itemTimeLabel}
                </time>
                <strong role="cell">{item.label}</strong>
                <span role="cell">{result !== "--" ? result : callType !== "--" ? callType : fallbackType !== "--" ? fallbackType : "AI call"}</span>
                <em role="cell">{titleCaseStatus(item.status)}</em>
              </button>
            );
          })}
        </div>
      ) : (
        <section className="market-agent-quiet-state" aria-label="No AI history recorded">
          <span>Idle</span>
          <strong>No Local AI call recorded for this run</strong>
          <p>Analysis results, source rows, and notification decisions are still available under Status or Outputs audit.</p>
        </section>
      )}
      {selectedItem ? (
        <div className="market-agent-history-modal-backdrop" role="presentation" onClick={() => setSelectedItem(null)}>
          <article
            className={`market-agent-history-modal ${decisionTone(selectedItem)}`}
            role="dialog"
            aria-modal="true"
            aria-label={`${selectedItem.label} history detail`}
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <span>{selectedItem.label}</span>
                <h4>{titleCaseStatus(selectedItem.status)}</h4>
              </div>
              <button type="button" onClick={() => setSelectedItem(null)} aria-label="Close history detail">
                Close
              </button>
            </header>
            <p>{selectedItem.detail}</p>
            <dl>
              {selectedItem.meta.map((meta) => {
                const { label, value } = splitMeta(meta);
                return (
                  <div key={meta}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                );
              })}
            </dl>
          </article>
        </div>
      ) : null}
    </section>
  );
}

function AiOngoingPane({ model, nodes }: { model: SignalMapModel; nodes: SignalNode[] }) {
  const [selectedNode, setSelectedNode] = useState<SignalNode | null>(null);
  const ongoingNodes = statusNodesFor(nodes).filter((node) => {
    const status = node.status.toLowerCase();
    return ["running", "checking", "collecting", "syncing", "queued"].some((keyword) => status.includes(keyword));
  });
  const rows = ongoingNodes;
  const runTimeLabel = formatHistoryTime(model.decisionTrace.runLabel);

  return (
    <section className="market-agent-ongoing-ledger compact" aria-label="AI ongoing work">
      <header>
        <div>
          <span>Ongoing</span>
          <h4>What AI is working on now</h4>
          <p>{model.phaseMessage}</p>
        </div>
        <strong>{model.phaseLabel}</strong>
      </header>
      {rows.length ? (
        <div className="market-agent-history-list" role="table" aria-label="Current AI work filings">
          <div className="market-agent-history-head" role="row">
            <span>Time</span>
            <span>Name</span>
            <span>Area</span>
            <span>Status</span>
          </div>
          {rows.map((node) => (
            <button
              type="button"
              className={`market-agent-history-row tone-${node.tone}`}
              key={node.id}
              onClick={() => setSelectedNode(node)}
              role="row"
            >
              <span role="cell" title={model.decisionTrace.runLabel || undefined}>{runTimeLabel || "Now"}</span>
              <strong role="cell">{node.label}</strong>
              <span role="cell">{node.lane}</span>
              <em role="cell">{node.status}</em>
            </button>
          ))}
        </div>
      ) : (
        <section className="market-agent-quiet-state" aria-label="No active AI work">
          <span>Idle</span>
          <strong>No active AI or data request</strong>
          <p>Completed records are available in History, Status, and Outputs audit.</p>
        </section>
      )}
      {selectedNode ? (
        <div className="market-agent-history-modal-backdrop" role="presentation" onClick={() => setSelectedNode(null)}>
          <article
            className={`market-agent-history-modal tone-${selectedNode.tone}`}
            role="dialog"
            aria-modal="true"
            aria-label={`${selectedNode.label} ongoing detail`}
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <span>{selectedNode.lane}</span>
                <h4>{selectedNode.label}</h4>
              </div>
              <button type="button" onClick={() => setSelectedNode(null)} aria-label="Close ongoing detail">
                Close
              </button>
            </header>
            <p>{selectedNode.action}</p>
            <dl>
              <div>
                <dt>Status</dt>
                <dd>{selectedNode.status}</dd>
              </div>
              <div>
                <dt>Source</dt>
                <dd>{selectedNode.source}</dd>
              </div>
              <div>
                <dt>Handling</dt>
                <dd>{selectedNode.processing}</dd>
              </div>
              <div>
                <dt>Output</dt>
                <dd>{selectedNode.output}</dd>
              </div>
            </dl>
          </article>
        </div>
      ) : null}
    </section>
  );
}

function NodeHistoryPane({ node }: { node: SignalNode }) {
  const [selectedRow, setSelectedRow] = useState<NonNullable<SignalNode["history"]>[number]["rows"][number] | null>(null);
  const historyRows = (node.history ?? []).flatMap((section) => section.rows);
  const historyTitle = node.label === "News" ? "News history" : `${node.label} history`;
  const selectedStatusLabel = selectedRow
    ? node.label === "News"
      ? newsHistoryStatusLabel(selectedRow.status, metaAfter(selectedRow.meta, "summary_source:"))
      : titleCaseStatus(selectedRow.status)
    : "";

  return (
    <div className="market-agent-operational-trace" aria-label={`${node.label} history trace`}>
      {renderHistoryRows(historyTitle, node, historyRows, setSelectedRow)}
      {selectedRow ? (
        <div className="market-agent-history-modal-backdrop" role="presentation" onClick={() => setSelectedRow(null)}>
          <article
            className={`market-agent-history-modal tone-${node.tone}`}
            role="dialog"
            aria-modal="true"
            aria-label={`${selectedRow.label} history detail`}
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <span>{selectedStatusLabel}</span>
                <h4>{selectedRow.label}</h4>
              </div>
              <button type="button" onClick={() => setSelectedRow(null)} aria-label="Close history detail">
                Close
              </button>
            </header>
            {selectedRow.detail ? <p>{selectedRow.detail}</p> : null}
            <dl>
              {selectedRow.meta.map((meta) => {
                const { label, value } = splitMeta(meta);
                return (
                  <div key={meta}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                );
              })}
            </dl>
          </article>
        </div>
      ) : null}
    </div>
  );
}

function AiStatusPane({ model, nodes }: { model: SignalMapModel; nodes: SignalNode[] }) {
  const statusNodes = statusNodesFor(nodes).slice(0, 14);
  return (
    <section className="market-agent-status-ledger compact" aria-label="AI status snapshot">
      <header>
        <div>
          <span>Status</span>
          <h4>Current source and pipeline status</h4>
          <p>{model.phaseMessage} This is the current snapshot, not a completed filing.</p>
        </div>
        <strong>{model.phaseLabel}</strong>
      </header>
      <div className="market-agent-status-table" role="table" aria-label="Current source and pipeline status">
        <div className="market-agent-status-head" role="row">
          <span>Area</span>
          <span>Status</span>
          <span>Doing now</span>
          <span>Needs</span>
        </div>
        {statusNodes.map((node) => (
          <article className={`market-agent-status-row tone-${node.tone}`} key={node.id} role="row">
            <strong role="cell">{node.label}</strong>
            <span role="cell">{node.status}</span>
            <p role="cell">{node.action}</p>
            <em role="cell">{node.requests?.length ? `${node.requests.length} open` : "clear"}</em>
          </article>
        ))}
        {!statusNodes.length ? (
          <article className="market-agent-status-row tone-muted" role="row">
            <strong role="cell">AI Analysis</strong>
            <span role="cell">not recorded</span>
            <p role="cell">No pipeline status rows were returned for this run.</p>
            <em role="cell">clear</em>
          </article>
        ) : null}
      </div>
    </section>
  );
}

export function CausalMesh({ node, allNodes, model, onClose }: CausalMeshProps) {
  const isAiAnalysis = node.id === "ai-analysis";
  const hasNodeHistory = Boolean(node.history?.length);
  const [view, setView] = useState<"map" | "overview" | "history" | "records" | "requests">(isAiAnalysis ? "map" : "overview");
  const upstream = uniqueById(allNodes.filter((candidate) => candidate.id !== node.id && node.trace.includes(candidate.id))).slice(0, 5);
  const downstream = uniqueById(allNodes.filter((candidate) => candidate.id !== node.id && candidate.trace.includes(node.id))).slice(0, 5);
  const traceNodes = useMemo(() => Array.from(new Set(node.trace)).map((id) => allNodes.find((candidate) => candidate.id === id)).filter((candidate): candidate is SignalNode => Boolean(candidate)), [allNodes, node.trace]);
  const requestCount = node.requests?.length ?? 0;
  const requestGroups = summarizeRequests(node.requests ?? []);
  const blockingRequests = (node.requests ?? []).filter((request) => ["unavailable", "unmapped", "blocked"].some((status) => request.status.toLowerCase().includes(status))).length;
  const refreshRequests = (node.requests ?? []).filter((request) => request.status.toLowerCase().includes("stale")).length;
  const watchRequests = (node.requests ?? []).filter((request) => request.status.toLowerCase().includes("watch")).length;
  const nextLabel = downstream.length ? downstream.slice(0, 3).map((candidate) => candidate.label).join(", ") : "End of selected path";
  const storageLabel = node.storage.length ? node.storage.join(" / ") : "not stored";
  const tabClass = (target: typeof view) => `market-agent-focus-tab${view === target ? " active" : ""}`;
  const routeStages = [
    { label: "Received", value: node.source, detail: node.detail },
    { label: "Handling", value: node.action, detail: node.processing },
    { label: "Stored", value: storageLabel, detail: node.storage.length ? "Persisted for replay, audit, or bounded evidence review." : "This step does not write a separate store." },
    { label: "Next", value: node.output, detail: nextLabel }
  ];

  return (
    <aside className={`market-agent-causal-mesh tone-${node.tone}`} aria-label={`${node.label} detail view`}>
      <header>
        <div>
          <span>Step detail</span>
          <h3>{node.label}</h3>
          <p>{node.detail}</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Back to signal map">
          Back to map
        </button>
      </header>
      <nav className="market-agent-focus-tabs" aria-label={`${node.label} detail sections`}>
        {isAiAnalysis ? (
          <>
            <button type="button" className={tabClass("map")} onClick={() => setView("map")}>Map</button>
            <button type="button" className={tabClass("overview")} onClick={() => setView("overview")}>Ongoing</button>
            <button type="button" className={tabClass("history")} onClick={() => setView("history")}>History</button>
            <button type="button" className={tabClass("records")} onClick={() => setView("records")}>Status</button>
            <button type="button" className={tabClass("requests")} onClick={() => setView("requests")}>Needs</button>
          </>
        ) : (
          <>
            <button type="button" className={tabClass("overview")} onClick={() => setView("overview")}>
              Summary
            </button>
            {hasNodeHistory ? (
              <button type="button" className={tabClass("history")} onClick={() => setView("history")}>
                History
              </button>
            ) : null}
            {node.drilldown?.length || node.requests?.length ? (
              <button type="button" className={tabClass("records")} onClick={() => setView("records")}>
                Status
              </button>
            ) : null}
            {node.requests?.length ? (
              <button type="button" className={tabClass("requests")} onClick={() => setView("requests")}>
                Needs
              </button>
            ) : null}
          </>
        )}
      </nav>

      <div className="market-agent-detail-viewport">
        {isAiAnalysis && view === "map" ? (
          <div className="market-agent-focus-overview">
            <section className="market-agent-route-map" aria-label={`${node.label} AI map`}>
              {routeStages.map((stage, index) => (
                <article key={stage.label}>
                  <b>{String(index + 1).padStart(2, "0")}</b>
                  <div>
                    <span>{stage.label}</span>
                    <strong>{stage.value}</strong>
                    <p>{stage.detail}</p>
                  </div>
                </article>
              ))}
            </section>
            <section className="market-agent-route-footer" aria-label={`${node.label} selected path`}>
              <div>
                <span>Selected path</span>
                <ol>
                  {(traceNodes.length ? traceNodes : [node]).slice(0, 6).map((traceNode, index) => (
                    <li key={`${traceNode.id}-${index}`}>{traceNode.label}</li>
                  ))}
                </ol>
              </div>
              <p>{node.ai}</p>
            </section>
            {node.performance ? (
              <section className={`market-agent-ai-performance market-agent-ai-performance-compact status-${statusKind(node.performance.status)}`} aria-label={`${node.label} AI performance`}>
                <div>
                  <span>{node.performance.title}</span>
                  <strong>{node.performance.status}</strong>
                  <p>{node.performance.detail}</p>
                </div>
                <div className="market-agent-ai-performance-metrics">
                  {node.performance.metrics.map((metric) => (
                    <article key={`${metric.label}-${metric.status}`}>
                      <span>{metric.label}</span>
                      <strong>{metric.meta[0]?.replace("token/s:", "").replace("elapsed:", "").replace("input tokens:", "").trim() || metric.status}</strong>
                      <p>{metric.detail}</p>
                    </article>
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        ) : null}

        {isAiAnalysis && view === "overview" ? <AiOngoingPane model={model} nodes={allNodes} /> : null}
        {isAiAnalysis && view === "history" ? <AiHistoryPane model={model} /> : null}
        {isAiAnalysis && view === "records" ? <AiStatusPane model={model} nodes={allNodes} /> : null}
        {!isAiAnalysis && view === "history" && hasNodeHistory ? <NodeHistoryPane node={node} /> : null}

        {view === "overview" && !isAiAnalysis ? (
          <div className="market-agent-focus-overview">
            <section className="market-agent-signal-passport" aria-label={`${node.label} signal passport`}>
              <div>
                <span>Status</span>
                <strong>{node.status}</strong>
              </div>
              <div>
                <span>Group</span>
                <strong>{node.group || node.lane}</strong>
              </div>
              <div>
                <span>Storage</span>
                <strong>{node.storage.length ? `${node.storage.length} store${node.storage.length === 1 ? "" : "s"}` : "none"}</strong>
              </div>
              <div>
                <span>Needs</span>
                <strong>{requestCount ? `${requestCount} open` : "clear"}</strong>
              </div>
            </section>
            <section className="market-agent-route-map" aria-label={`${node.label} route map`}>
              {routeStages.map((stage, index) => (
                <article key={stage.label}>
                  <b>{String(index + 1).padStart(2, "0")}</b>
                  <div>
                    <span>{stage.label}</span>
                    <strong>{stage.value}</strong>
                    <p>{stage.detail}</p>
                  </div>
                </article>
              ))}
            </section>
            <section className="market-agent-route-footer" aria-label={`${node.label} selected path`}>
              <div>
                <span>Selected path</span>
                <ol>
                  {(traceNodes.length ? traceNodes : [node]).slice(0, 6).map((traceNode, index) => (
                    <li key={`${traceNode.id}-${index}`}>{traceNode.label}</li>
                  ))}
                </ol>
              </div>
              <p>{node.ai}</p>
            </section>
            {node.performance ? (
              <section className={`market-agent-ai-performance market-agent-ai-performance-compact status-${statusKind(node.performance.status)}`} aria-label={`${node.label} AI performance`}>
                <div>
                  <span>{node.performance.title}</span>
                  <strong>{node.performance.status}</strong>
                  <p>{node.performance.detail}</p>
                </div>
                <div className="market-agent-ai-performance-metrics">
                  {node.performance.metrics.map((metric) => (
                    <article key={`${metric.label}-${metric.status}`}>
                      <span>{metric.label}</span>
                      <strong>{metric.meta[0]?.replace("token/s:", "").replace("elapsed:", "").replace("input tokens:", "").trim() || metric.status}</strong>
                      <p>{metric.detail}</p>
                    </article>
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        ) : null}

        {view === "records" && node.drilldown?.length ? (
          <div className="market-agent-operational-trace" aria-label={`${node.label} operational trace`}>
            <header>
              <div>
                <span>Status</span>
                <h4>Current records and status</h4>
              </div>
            </header>
            {(node.drilldown ?? []).map((section, sectionIndex) => (
              <section key={`${section.title}-${sectionIndex}`} className="market-agent-trace-section">
                <div className="market-agent-trace-section-head">
                  <strong>{section.title}</strong>
                  <p>{section.detail}</p>
                </div>
                {renderRecordRows(section.title, node, section.rows)}
              </section>
            ))}
          </div>
        ) : null}

        {view === "requests" ? (
          <section className="market-agent-data-requests" aria-label={`${node.label} needs`}>
            <header>
              <div>
                <span>Needs</span>
                <h4>What is blocking or being watched</h4>
              </div>
            </header>
            {requestCount ? (
              <>
                <p className="market-agent-request-note">These are data limits, not market conclusions. Blocking items affect confidence; monitoring items stay visible without becoming a driver.</p>
                <div className="market-agent-request-summary" aria-label={`${node.label} request summary`}>
                  <span>{blockingRequests} blocking</span>
                  <span>{refreshRequests} need refresh</span>
                  <span>{watchRequests} watched</span>
                </div>
                <div className="market-agent-request-groups">
                  {requestGroups.map(([group, requests]) => (
                    <section key={group} className="market-agent-request-group">
                      <header>
                        <strong>{group}</strong>
                        <span>{requests.length}</span>
                      </header>
                      <div className="market-agent-data-request-list">
                        {compactRequestRows(requests).map((request) => (
                          <article key={`${request.targets.join("-")}-${request.status}-${request.mode}`} className={`market-agent-data-request tone-${requestTone(request.status)}`}>
                            <div className="market-agent-request-main">
                              <span>{requestImpact(request.status)}</span>
                              <strong>{requestTitle(request)}</strong>
                              <small>{request.requestedBy}</small>
                            </div>
                            <p>{requestReason(request)}</p>
                            <span>{request.status}</span>
                            <div className="market-agent-request-targets" aria-label={`${request.targets.length} affected sensors`}>
                              <em>{requestTargets(request)}</em>
                            </div>
                          </article>
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
              </>
            ) : (
              <p className="market-agent-request-note">No active data needs are open for this run. AI status and completed analysis records remain available under Status and History.</p>
            )}
          </section>
        ) : null}
      </div>
    </aside>
  );
}
