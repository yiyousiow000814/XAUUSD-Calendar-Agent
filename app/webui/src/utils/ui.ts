export const impactTone = (impact: string) => {
  const normalized = impact.toLowerCase();
  if (normalized.includes("high")) return "impact-high";
  if (normalized.includes("medium")) return "impact-medium";
  if (normalized.includes("low")) return "impact-low";
  if (normalized.includes("holiday")) return "impact-holiday";
  return "impact-neutral";
};

export const levelTone = (level: string) => {
  const normalized = level.toLowerCase();
  if (normalized.includes("error")) return "level-error";
  if (normalized.includes("warn")) return "level-warn";
  return "level-info";
};
