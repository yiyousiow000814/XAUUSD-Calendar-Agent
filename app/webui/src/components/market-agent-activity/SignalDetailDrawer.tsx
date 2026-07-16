import type { ReactNode } from "react";
import type { SignalNode } from "./signalMapModel";

type SignalDetailDrawerProps = {
  node: SignalNode;
  onClose: () => void;
};

const DetailRow = ({ title, children }: { title: string; children: ReactNode }) => (
  <section>
    <strong>{title}</strong>
    <p>{children}</p>
  </section>
);

export function SignalDetailDrawer({ node, onClose }: SignalDetailDrawerProps) {
  return (
    <aside className={`market-agent-signal-detail tone-${node.tone}`} role="dialog" aria-label={`${node.label} details`}>
      <header>
        <div>
          <span>{node.lane}</span>
          <h3>{node.label}</h3>
        </div>
        <button type="button" onClick={onClose} aria-label="Close signal detail">
          Close
        </button>
      </header>
      <div className="market-agent-signal-detail-grid">
        <DetailRow title="What this is">{node.detail}</DetailRow>
        <DetailRow title="Where it comes from">{node.source}</DetailRow>
        <DetailRow title="What is happening now">{node.action}</DetailRow>
        <DetailRow title="Inputs">{node.source}</DetailRow>
        <DetailRow title="Processing">{node.processing}</DetailRow>
        <DetailRow title="AI involvement">{node.ai}</DetailRow>
        <DetailRow title="Outputs">{node.output}</DetailRow>
        <DetailRow title="Storage">{node.storage.length ? node.storage.join(", ") : "Not persisted"}</DetailRow>
        <DetailRow title="Trace">{node.trace.join(" -> ")}</DetailRow>
      </div>
    </aside>
  );
}
