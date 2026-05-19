import "./MarketAgentStatusBadge.css";

type MarketAgentStatusBadgeProps = {
  label: string;
  tone?: "neutral" | "good" | "warn" | "bad" | "info";
  className?: string;
};

const normalizeTone = (label: string, tone?: MarketAgentStatusBadgeProps["tone"]) => {
  if (tone) return tone;
  const normalized = label.trim().toLowerCase();
  if (["live", "confirmed", "active", "available"].includes(normalized)) return "good";
  if (["backfilled", "proxy", "watching", "emerging", "possible", "likely", "cooling", "suppressed"].includes(normalized)) return "warn";
  if (["stale", "unavailable", "retired", "unknown", "unconfirmed", "blocked", "disabled"].includes(normalized)) return "bad";
  return "neutral";
};

export function MarketAgentStatusBadge({
  label,
  tone,
  className = ""
}: MarketAgentStatusBadgeProps) {
  return (
    <span
      className={`market-agent-status-badge tone-${normalizeTone(label, tone)} ${className}`.trim()}
    >
      {label}
    </span>
  );
}
