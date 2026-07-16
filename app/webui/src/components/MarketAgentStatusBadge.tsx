import "./MarketAgentStatusBadge.css";
import { badgeToneForValue, humanizeMarketAgentValue } from "../utils/marketAgentUi";

type MarketAgentStatusBadgeProps = {
  label: string;
  tone?: "neutral" | "good" | "warn" | "bad" | "info";
  className?: string;
};

const normalizeTone = (label: string, tone?: MarketAgentStatusBadgeProps["tone"]) => {
  if (tone) return tone;
  return badgeToneForValue(label);
};

export function MarketAgentStatusBadge({
  label,
  tone,
  className = ""
}: MarketAgentStatusBadgeProps) {
  return (
    <span
      className={`market-agent-status-badge tone-${normalizeTone(label, tone)} ${className}`.trim()}
      title={label}
    >
      {humanizeMarketAgentValue(label)}
    </span>
  );
}
