type QuickReadItem = {
  key: string;
  label: string;
  dir: "Up" | "Down";
  prob: number;
  edge: number;
  edgePp: number;
  className: string;
};

type UnifiedQuickRead = {
  all: QuickReadItem[];
  strong: QuickReadItem[];
  edgeTh: number;
};

type TradeBiasPanelProps = {
  unified: UnifiedQuickRead;
  adjustedByActual: boolean;
  usedActualEvents: number | null;
  hasForecast: boolean;
  pvReliable: boolean;
};

function pickBest(items: QuickReadItem[]): QuickReadItem | null {
  if (!items.length) return null;
  // Highest edge wins; tie-breaker prefers the shorter horizon.
  const order: Record<string, number> = { "+1h": 1, "+4h": 2, "+12h": 3 };
  return [...items].sort((a, b) => {
    if (Math.abs(b.edge - a.edge) > 1e-12) return b.edge - a.edge;
    const oa = order[a.label] ?? 99;
    const ob = order[b.label] ?? 99;
    return oa - ob;
  })[0]!;
}

function fmtPctNum(p: number | null | undefined): string {
  if (typeof p !== "number" || !Number.isFinite(p)) return "--";
  if (p > 0 && p < 0.01) return "<1%";
  return `${Math.round(p * 100)}%`;
}

export function TradeBiasPanel({
  unified,
  adjustedByActual,
  usedActualEvents,
  hasForecast,
  pvReliable
}: TradeBiasPanelProps) {
  const best = pickBest(unified.all);
  if (!best) return null;

  const clear = best.edge + 1e-12 >= unified.edgeTh;
  const edgeThPp = Math.round(unified.edgeTh * 100);
  const bias = clear ? `${best.dir} ${fmtPctNum(best.prob)}` : "No clear edge";
  const edgeBadge = clear ? `Edge ${best.edgePp}pp` : `Edge ${best.edgePp}pp (<${edgeThPp}pp)`;
  const meta = clear ? `at ${best.label}` : `Lean ${best.dir} ${fmtPctNum(best.prob)} at ${best.label}`;

  const action = (() => {
    if (!clear) return "Stand aside";
    if (!adjustedByActual) return "Probe small / wait for release";
    return "Follow the bias";
  })();

  const note = (() => {
    if (!clear) return `Edge is below ${edgeThPp}pp (P is close to 50%).`;
    if (!adjustedByActual) {
      if (!pvReliable) {
        return "This is a pre-release estimate, and the release-side signal is low confidence. Consider waiting for the release.";
      }
      if (hasForecast) {
        return "This is a pre-release estimate. Forecast surprises can dominate short-term moves; re-check after the release updates P(t).";
      }
      return "This is a pre-release estimate. Re-check after the release updates P(t).";
    }
    const used = typeof usedActualEvents === "number" ? Math.max(0, Math.round(usedActualEvents)) : null;
    const usedTxt = used !== null ? ` (${used} events)` : "";
    return `P(t) is adjusted by released Actuals${usedTxt}.`;
  })();

  return (
    <div className="deep-outlook-trade" data-qa="qa:deep:trade-guide">
      <div className="deep-outlook-trade-head">
        <div className="deep-outlook-trade-title">Trade guide</div>
        <span className="deep-pill deep-pill--hint">{edgeBadge}</span>
      </div>
      <div className="deep-outlook-trade-main">
        <span className={`deep-outlook-trade-bias${clear ? " is-clear" : " is-unclear"}`}>{bias}</span>
        <span className="deep-outlook-trade-meta">{meta}</span>
      </div>
      <div className="deep-outlook-trade-action">
        <span className="k">Action</span>
        <span className="v">{action}</span>
      </div>
      <div className="deep-outlook-trade-note">{note}</div>
    </div>
  );
}
