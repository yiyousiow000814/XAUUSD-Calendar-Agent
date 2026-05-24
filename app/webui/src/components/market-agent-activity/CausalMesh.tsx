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

export function CausalMesh({ node, allNodes, onClose }: CausalMeshProps) {
  const [view, setView] = useState<"overview" | "records" | "requests">("overview");
  const upstream = uniqueById(allNodes.filter((candidate) => candidate.id !== node.id && node.trace.includes(candidate.id))).slice(0, 5);
  const downstream = uniqueById(allNodes.filter((candidate) => candidate.id !== node.id && candidate.trace.includes(node.id))).slice(0, 5);
  const traceNodes = useMemo(() => Array.from(new Set(node.trace)).map((id) => allNodes.find((candidate) => candidate.id === id)).filter((candidate): candidate is SignalNode => Boolean(candidate)), [allNodes, node.trace]);
  const requestCount = node.requests?.length ?? 0;
  const nextLabel = downstream.length ? downstream.slice(0, 3).map((candidate) => candidate.label).join(", ") : "End of selected path";
  const storageLabel = node.storage.length ? node.storage.join(" / ") : "not stored";
  const tabClass = (target: typeof view) => `market-agent-focus-tab${view === target ? " active" : ""}`;

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

      {view === "overview" ? (
        <div className="market-agent-focus-overview">
          <section className="market-agent-step-summary" aria-label={`${node.label} current state`}>
            <article>
              <span>Now</span>
              <strong>{node.action}</strong>
              <p>{node.processing}</p>
            </article>
            <article>
              <span>Next handoff</span>
              <strong>{node.output}</strong>
              <p>Next: {nextLabel}</p>
            </article>
            <article>
              <span>Stored as</span>
              <strong>{storageLabel}</strong>
              <p>{node.ai}</p>
            </article>
          </section>
          <section className="market-agent-focus-path" aria-label={`${node.label} trace`}>
            <div>
              <span>Path</span>
              <strong>{node.source}</strong>
              <p>Follow this selected step from source context to output.</p>
            </div>
            <ol>
              {(traceNodes.length ? traceNodes : [node]).slice(0, 6).map((traceNode, index) => (
                <li key={`${traceNode.id}-${index}`}>{traceNode.label}</li>
              ))}
            </ol>
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
              <div className="market-agent-trace-row-list">
                {section.rows.length ? (
                  section.rows.map((row, rowIndex) => (
                    <article key={`${section.title}-${row.label}-${row.status}-${rowIndex}`} className={`market-agent-trace-row tone-${strengthFor({ ...node, tone: node.tone, status: row.status })}`}>
                      <div>
                        <span>{row.status}</span>
                        <strong>{row.label}</strong>
                        <p>{row.detail}</p>
                      </div>
                      <ul>
                        {row.meta.map((item) => (
                          <li key={`${row.label}-${item}`}>{item}</li>
                        ))}
                      </ul>
                    </article>
                  ))
                ) : (
                  <article className="market-agent-trace-row">
                    <div>
                      <span>empty</span>
                      <strong>No rows recorded</strong>
                      <p>This step is visible, but no row-level detail exists in the current payload.</p>
                    </div>
                  </article>
                )}
              </div>
            </section>
          ))}
        </div>
      ) : null}

      {view === "requests" && node.requests?.length ? (
        <div className="market-agent-data-requests" aria-label={`${node.label} data requests`}>
          <header>
            <div>
              <span>Needs from sources</span>
              <h4>Missing, stale, or unavailable inputs</h4>
            </div>
          </header>
          <p className="market-agent-request-note">These are limits or priorities that go back to source groups. They are not treated as confirmed drivers.</p>
          <div className="market-agent-data-request-list">
            {node.requests.map((request) => (
              <article key={`${request.target}-${request.status}-${request.mode}`} className="market-agent-data-request">
                <span>{request.status}</span>
                <strong>{request.target}</strong>
                <p>{request.reason}</p>
                <small>{request.requestedBy} · {request.mode}</small>
              </article>
            ))}
          </div>
        </div>
      ) : null}
    </aside>
  );
}
