import { useMemo, useState } from "react";
import type { SignalNode } from "./signalMapModel";

type CausalMeshProps = {
  node: SignalNode;
  allNodes: SignalNode[];
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

const compactStatus = (status: string) => status.replace(/_/g, " ");

const statusKind = (status: string) => {
  const normalized = status.toLowerCase().replace(/_/g, " ");
  if (normalized.includes("unavailable") || normalized.includes("blocked") || normalized.includes("failed")) return "bad";
  if (normalized.includes("stale") || normalized.includes("waiting") || normalized.includes("syncing") || normalized.includes("checking") || normalized.includes("watching") || normalized.includes("emerging")) return "watch";
  if (normalized.includes("market closed") || normalized.includes("snapshot")) return "watch";
  if (normalized.includes("confirming") || normalized.includes("returned") || normalized.includes("filled")) return "confirming";
  if (normalized.includes("live") || normalized.includes("ready") || normalized.includes("stored") || normalized.includes("available") || normalized.includes("approved") || normalized.includes("active") || normalized.includes("validated") || normalized.includes("recorded")) return "good";
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
  if (normalized.includes("stale")) return "Refresh";
  if (normalized.includes("watch")) return "Monitoring";
  return "Open";
};

const requestTone = (status: string) => {
  const normalized = status.toLowerCase();
  if (normalized.includes("unavailable") || normalized.includes("unmapped") || normalized.includes("blocked")) return "bad";
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
    const order = ["Action needed", "Refresh", "Monitoring", "Open"];
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
  if (request.targets.length > 1 && request.status.toLowerCase().includes("watch")) return "Themes under watch";
  if (request.status.toLowerCase().includes("unavailable")) return `${request.target} unavailable`;
  return request.targets.length > 1 ? `${request.targets.length} sensors` : request.target;
};

const requestReason = (request: NonNullable<SignalNode["requests"]>[number] & { targets: string[] }) => {
  if (request.targets.length > 1 && request.reason.toLowerCase().includes("no provider status")) return "These sensors are watched, but the current payload did not include provider health for them.";
  if (request.status.toLowerCase().includes("unavailable")) return "This cannot be used as neutral or confirming evidence until a reliable source is available.";
  return request.reason;
};

const requestTargets = (request: NonNullable<SignalNode["requests"]>[number] & { targets: string[] }) => request.targets.join(", ");

const requestImpact = (status: string) => {
  const bucket = requestBucket(status);
  if (bucket === "Action needed") return "Limits confidence";
  if (bucket === "Refresh") return "Needs fresh data";
  if (bucket === "Monitoring") return "Watch only";
  return "Open request";
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
            <article key={`${sectionTitle}-${row.label}-${row.status}-${rowIndex}`} className={`market-agent-record-matrix-row tone-${strengthFor({ ...node, tone: node.tone, status: row.status })} status-${statusKind(row.status)}`} role="row">
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

export function CausalMesh({ node, allNodes, onClose }: CausalMeshProps) {
  const [view, setView] = useState<"overview" | "records" | "requests">("overview");
  const upstream = uniqueById(allNodes.filter((candidate) => candidate.id !== node.id && node.trace.includes(candidate.id))).slice(0, 5);
  const downstream = uniqueById(allNodes.filter((candidate) => candidate.id !== node.id && candidate.trace.includes(node.id))).slice(0, 5);
  const traceNodes = useMemo(() => Array.from(new Set(node.trace)).map((id) => allNodes.find((candidate) => candidate.id === id)).filter((candidate): candidate is SignalNode => Boolean(candidate)), [allNodes, node.trace]);
  const requestCount = node.requests?.length ?? 0;
  const requestGroups = summarizeRequests(node.requests ?? []);
  const blockingRequests = (node.requests ?? []).filter((request) => ["unavailable", "unmapped", "blocked"].some((status) => request.status.toLowerCase().includes(status))).length;
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
        <button type="button" className={tabClass("overview")} onClick={() => setView("overview")}>
          Summary
        </button>
        {node.drilldown?.length ? (
          <button type="button" className={tabClass("records")} onClick={() => setView("records")}>
            Records
          </button>
        ) : null}
        {node.requests?.length ? (
          <button type="button" className={tabClass("requests")} onClick={() => setView("requests")}>
            Needs ({requestCount})
          </button>
        ) : null}
      </nav>

      <div className="market-agent-detail-viewport">
        {view === "overview" ? (
          <div className="market-agent-focus-overview">
            {node.performance ? (
              <section className={`market-agent-ai-performance status-${statusKind(node.performance.status)}`} aria-label={`${node.label} AI performance`}>
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
          </div>
        ) : null}

        {view === "records" && node.drilldown?.length ? (
          <div className="market-agent-operational-trace" aria-label={`${node.label} operational trace`}>
            <header>
              <div>
                <span>Records</span>
                <h4>What happened in this step</h4>
              </div>
            </header>
            {node.drilldown.map((section, sectionIndex) => (
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

        {view === "requests" && node.requests?.length ? (
          <div className="market-agent-data-requests" aria-label={`${node.label} data requests`}>
            <header>
              <div>
                <span>Data needs</span>
                <h4>What is blocking or being watched</h4>
              </div>
            </header>
            <p className="market-agent-request-note">These are data limits, not market conclusions. Blocking items affect confidence; monitoring items stay visible without becoming a driver.</p>
            <div className="market-agent-request-summary" aria-label={`${node.label} request summary`}>
              <span>{blockingRequests} blocking</span>
              <span>{watchRequests} monitored</span>
              <span>{requestCount} total</span>
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
          </div>
        ) : null}
      </div>
    </aside>
  );
}
