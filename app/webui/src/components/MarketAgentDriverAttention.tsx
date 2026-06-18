import type {
  MarketAgentDriverAttentionResponse,
  MarketAgentEvidenceForRunResponse,
  MarketAgentReplayResponse
} from "../types";
import { MarketAgentMacroMicroFocus } from "./MarketAgentMacroMicroFocus";

type MarketAgentDriverAttentionProps = {
  data: MarketAgentDriverAttentionResponse | null;
  selectedEvidence: MarketAgentEvidenceForRunResponse | null;
  replay?: MarketAgentReplayResponse | null;
  marketRead?: Record<string, unknown> | null;
  evidenceChainStatus?: Record<string, unknown> | null;
};

export function MarketAgentDriverAttention({
  data,
  selectedEvidence,
  replay,
  marketRead,
  evidenceChainStatus
}: MarketAgentDriverAttentionProps) {
  const currentConclusionReady = evidenceChainStatus?.can_show_current_conclusion !== false;

  return (
    <section className="market-agent-surface" data-qa="qa:market-agent:driver-attention">
      <div className="market-agent-surface-header">
        <div>
          <h2>Macro / Micro Watch</h2>
          <span className="hint">One-screen radar for the market story around XAUUSD.</span>
        </div>
      </div>
      <MarketAgentMacroMicroFocus
        driverAttention={data?.available ? data : null}
        selectedEvidence={selectedEvidence}
        replay={replay}
        marketRead={marketRead}
        evidenceChainStatus={evidenceChainStatus}
        currentConclusionReady={currentConclusionReady}
        variant="page"
      />
    </section>
  );
}
