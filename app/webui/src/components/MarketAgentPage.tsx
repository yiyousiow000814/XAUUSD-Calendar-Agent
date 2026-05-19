import type {
  MarketAgentDriverAttentionResponse,
  MarketAgentEvidenceForRunResponse,
  MarketAgentProviderActionResponse,
  MarketAgentProviderConfigInput,
  MarketAgentProviderConfigResponse,
  MarketAgentProviderHealthResponse,
  MarketAgentReplayResponse,
  MarketAgentSnapshotResponse
} from "../types";
import { MarketAgentProviderConfig } from "./MarketAgentProviderConfig";
import { MarketAgentDriverAttention } from "./MarketAgentDriverAttention";
import { MarketAgentEvidencePanel } from "./MarketAgentEvidencePanel";
import { MarketAgentOverview } from "./MarketAgentOverview";
import { MarketAgentProviderHealth } from "./MarketAgentProviderHealth";
import { MarketAgentReplay } from "./MarketAgentReplay";
import "./MarketAgentPage.css";

type MarketAgentPageProps = {
  snapshot: MarketAgentSnapshotResponse | null;
  providerConfig: MarketAgentProviderConfigResponse | null;
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
  onSaveProviderConfig: (ctrader: MarketAgentProviderConfigInput) => void;
  onClearProviderConfig: () => void;
  onTestCTraderConnection: (ctrader: MarketAgentProviderConfigInput) => Promise<MarketAgentProviderActionResponse>;
  onResolveCTraderSymbol: (ctrader: MarketAgentProviderConfigInput) => Promise<MarketAgentProviderActionResponse>;
  onGetCTraderQuoteTest: (ctrader: MarketAgentProviderConfigInput) => Promise<MarketAgentProviderActionResponse>;
  onRefreshCTraderToken: (ctrader: MarketAgentProviderConfigInput) => Promise<MarketAgentProviderActionResponse>;
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

      <MarketAgentProviderConfig
        data={props.providerConfig}
        onSave={props.onSaveProviderConfig}
        onClear={props.onClearProviderConfig}
        onTestConnection={props.onTestCTraderConnection}
        onResolveSymbol={props.onResolveCTraderSymbol}
        onQuoteTest={props.onGetCTraderQuoteTest}
        onRefreshToken={props.onRefreshCTraderToken}
      />
    </div>
  );
}
