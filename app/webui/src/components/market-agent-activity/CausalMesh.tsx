import type { SignalNode } from "./signalMapModel";

type CausalMeshProps = {
  node: SignalNode;
  allNodes: SignalNode[];
  onClose: () => void;
  onSelect: (node: SignalNode) => void;
};

const strengthFor = (node: SignalNode) => {
  if (node.tone === "good" || node.tone === "ai") return "strong";
  if (node.tone === "working" || node.tone === "store") return "watch";
  if (node.tone === "bad") return "blocked";
  return "background";
};

const titleFor = (node: SignalNode) => {
  if (node.id.startsWith("discovered-")) return "unmapped cause";
  if (node.id.startsWith("candidate-")) return "candidate cause";
  return node.group || node.lane;
};

export function CausalMesh({ node, allNodes, onClose, onSelect }: CausalMeshProps) {
  const upstream = allNodes.filter((candidate) => candidate.id !== node.id && node.trace.includes(candidate.id)).slice(0, 5);
  const downstream = allNodes
    .filter((candidate) => candidate.id !== node.id && candidate.trace.includes(node.id))
    .slice(0, 5);
  const leftNodes = upstream.length ? upstream : allNodes.filter((candidate) => candidate.lane.includes("Source") || candidate.lane.includes("Sensors")).slice(0, 4);
  const rightNodes = downstream.length ? downstream : allNodes.filter((candidate) => candidate.lane === "Outputs" || candidate.lane.includes("AI")).slice(0, 4);
  const storageLabels = node.storage.length ? node.storage : ["not persisted"];

  return (
    <section className={`market-agent-causal-mesh tone-${node.tone}`} role="dialog" aria-label={`${node.label} causal mesh`}>
      <header>
        <div>
          <span>Causal Mesh</span>
          <h3>{node.label}</h3>
          <p>{node.detail}</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close causal mesh">
          Close
        </button>
      </header>

      <div className="market-agent-causal-canvas">
        <svg className="market-agent-causal-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {leftNodes.map((candidate, index) => (
            <path
              key={`in-${candidate.id}`}
              className={`mesh-line mesh-line-${strengthFor(candidate)}`}
              d={`M 20 ${22 + index * 16} C 36 ${22 + index * 16}, 38 50, 49 50`}
            />
          ))}
          {rightNodes.map((candidate, index) => (
            <path
              key={`out-${candidate.id}`}
              className={`mesh-line mesh-line-${strengthFor(candidate)}`}
              d={`M 51 50 C 64 50, 66 ${22 + index * 16}, 81 ${22 + index * 16}`}
            />
          ))}
          <path className="mesh-line mesh-line-store" d="M 50 56 C 50 74, 50 84, 50 94" />
        </svg>

        <div className="mesh-column mesh-left">
          {leftNodes.map((candidate) => (
            <button key={candidate.id} type="button" className={`mesh-node ${strengthFor(candidate)}`} onClick={() => onSelect(candidate)}>
              <span>{titleFor(candidate)}</span>
              <strong>{candidate.label}</strong>
              <small>{candidate.output}</small>
            </button>
          ))}
        </div>

        <div className="mesh-focus">
          <span>{node.lane}</span>
          <strong>{node.label}</strong>
          <small>{node.action}</small>
        </div>

        <div className="mesh-column mesh-right">
          {rightNodes.map((candidate) => (
            <button key={candidate.id} type="button" className={`mesh-node ${strengthFor(candidate)}`} onClick={() => onSelect(candidate)}>
              <span>{titleFor(candidate)}</span>
              <strong>{candidate.label}</strong>
              <small>{candidate.action}</small>
            </button>
          ))}
        </div>

        <div className="mesh-storage">
          <span>Storage</span>
          <strong>{storageLabels.join(", ")}</strong>
          <small>{node.storage.length ? "raw / derived audit path" : "visible but not persisted"}</small>
        </div>
      </div>

      <div className="market-agent-causal-detail">
        <section>
          <strong>Where it comes from</strong>
          <p>{node.source}</p>
        </section>
        <section>
          <strong>What is happening now</strong>
          <p>{node.action}</p>
        </section>
        <section>
          <strong>Processing</strong>
          <p>{node.processing}</p>
        </section>
        <section>
          <strong>AI involvement</strong>
          <p>{node.ai}</p>
        </section>
        <section>
          <strong>Output path</strong>
          <p>{node.output}</p>
        </section>
        <section>
          <strong>Trace</strong>
          <p>{node.trace.join(" -> ")}</p>
        </section>
      </div>
    </section>
  );
}
