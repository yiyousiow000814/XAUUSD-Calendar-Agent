import type {
  MarketAgentDriverAttentionResponse,
  MarketAgentEvidenceForRunResponse,
  MarketAgentProviderHealthResponse,
  MarketAgentReplayResponse,
  MarketAgentSnapshotResponse
} from "../types";
import { MarketAgentDriverAttention } from "./MarketAgentDriverAttention";
import { MarketAgentEvidencePanel } from "./MarketAgentEvidencePanel";
import { MarketAgentOverview } from "./MarketAgentOverview";
import { MarketAgentProviderHealth } from "./MarketAgentProviderHealth";
import { MarketAgentReplay } from "./MarketAgentReplay";
import "./MarketAgentPage.css";

type MarketAgentPageProps = {
  snapshot: MarketAgentSnapshotResponse | null;
  providerHealth: MarketAgentProviderHealthResponse | null;
  driverAttention: MarketAgentDriverAttentionResponse | null;
  replay: MarketAgentReplayResponse | null;
  selectedEvidence: MarketAgentEvidenceForRunResponse | null;
  selectedMonitorRunId: number | null;
  rangePreset: string;
  rangeStartInput: string;
  rangeEndInput: string;
  onPresetChange: (preset: string) => void;
  onRangeStartChange: (value: string) => void;
  onRangeEndChange: (value: string) => void;
  onApplyRange: () => void;
  onSelectRun: (monitorRunId: number) => void;
};

export function MarketAgentPage(props: MarketAgentPageProps) {
  return (
    <div className="market-agent-page" data-qa="qa:page:market-agent">
      <MarketAgentOverview snapshot={props.snapshot} providerHealth={props.providerHealth} />

      <div className="market-agent-page-grid">
        <MarketAgentDriverAttention data={props.driverAttention} />
        <MarketAgentProviderHealth data={props.providerHealth} />
      </div>

      <MarketAgentReplay
        replay={props.replay}
        selectedEvidence={props.selectedEvidence}
        selectedMonitorRunId={props.selectedMonitorRunId}
        rangePreset={props.rangePreset}
        rangeStartInput={props.rangeStartInput}
        rangeEndInput={props.rangeEndInput}
        onPresetChange={props.onPresetChange}
        onRangeStartChange={props.onRangeStartChange}
        onRangeEndChange={props.onRangeEndChange}
        onApplyRange={props.onApplyRange}
        onSelectRun={props.onSelectRun}
      />

      <MarketAgentEvidencePanel data={props.selectedEvidence} />
    </div>
  );
}
