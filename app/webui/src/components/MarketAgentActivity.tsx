import type {
  MarketAgentEvidenceForRunResponse,
  MarketAgentLLMConfigResponse,
  MarketAgentMonitorStatusResponse,
  MarketAgentProviderConfigResponse,
  MarketAgentProviderHealthResponse,
  MarketAgentReplayResponse,
  MarketAgentTelegramConfigResponse
} from "../types";
import { MarketAgentSignalMap } from "./market-agent-activity/MarketAgentSignalMap";
import { buildSignalMapModel } from "./market-agent-activity/signalMapModel";
import "./MarketAgentActivity.css";
import "./market-agent-activity/CircuitBoard.css";

type MarketAgentActivityProps = {
  monitorStatus: MarketAgentMonitorStatusResponse | null;
  providerHealth: MarketAgentProviderHealthResponse | null;
  replay: MarketAgentReplayResponse | null;
  selectedEvidence: MarketAgentEvidenceForRunResponse | null;
  providerConfig: MarketAgentProviderConfigResponse | null;
  telegramConfig: MarketAgentTelegramConfigResponse | null;
  llmConfig: MarketAgentLLMConfigResponse | null;
};

export function MarketAgentActivity({
  monitorStatus,
  providerHealth,
  replay,
  selectedEvidence,
  providerConfig,
  telegramConfig,
  llmConfig
}: MarketAgentActivityProps) {
  const model = buildSignalMapModel({
    monitorStatus,
    providerHealth,
    replay,
    selectedEvidence,
    providerConfig,
    telegramConfig,
    llmConfig
  });
  return <MarketAgentSignalMap model={model} />;
}
