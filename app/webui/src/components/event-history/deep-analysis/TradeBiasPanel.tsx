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

type UnifiedStability = {
  flips: number;
  amp: number; // max-min of sampled P(up) values (0..1)
  variance: number;
};

type DecisionGate = {
  minSamples: number;
  currentSamples: number | null;
  minRecentShare: number;
  currentRecentShare: number | null;
  minCoverage: number;
  currentCoverage: number | null;
  minBacktestAcc: number;
  currentBacktestAcc: number | null;
  maxCalibrationGap: number;
  currentCalibrationGap: number | null;
};

type TradeBiasPanelProps = {
  unified: UnifiedQuickRead;
  stability: UnifiedStability | null;
  sameTimeCount: number | null;
  adjustedByActual: boolean;
  usedActualEvents: number | null;
  hasForecast: boolean;
  pvReliable: boolean;
  decisionGate: DecisionGate;
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
  stability,
  sameTimeCount,
  adjustedByActual,
  usedActualEvents,
  hasForecast,
  pvReliable,
  decisionGate
}: TradeBiasPanelProps) {
  const best = pickBest(unified.all);
  if (!best) return null;

  const isSameTimeBatch = typeof sameTimeCount === "number" && sameTimeCount > 1;

  const clear = best.edge + 1e-12 >= unified.edgeTh;
  const edgeThPp = Math.round(unified.edgeTh * 100);
  const passSamples =
    typeof decisionGate.currentSamples === "number" && decisionGate.currentSamples >= decisionGate.minSamples;
  const passRecentShare =
    typeof decisionGate.currentRecentShare === "number" &&
    decisionGate.currentRecentShare + 1e-12 >= decisionGate.minRecentShare;
  const passBacktestAcc =
    typeof decisionGate.currentBacktestAcc === "number" &&
    decisionGate.currentBacktestAcc + 1e-12 >= decisionGate.minBacktestAcc;
  const hasCoverage = typeof decisionGate.currentCoverage === "number" && Number.isFinite(decisionGate.currentCoverage);
  const passCoverage = hasCoverage && decisionGate.currentCoverage + 1e-12 >= decisionGate.minCoverage;
  const hasCalibration =
    typeof decisionGate.currentCalibrationGap === "number" && Number.isFinite(decisionGate.currentCalibrationGap);
  const passCalibration = hasCalibration && decisionGate.currentCalibrationGap - 1e-12 <= decisionGate.maxCalibrationGap;
  const passStability =
    Boolean(stability) &&
    // If the curve flips direction across horizons, treat it as a contested signal.
    stability!.flips === 0 &&
    // Require a meaningful swing (avoid "looks strong" due to scaling noise).
    stability!.amp + 1e-12 >= 0.2 &&
    // Avoid overly wiggly / unstable curves.
    stability!.variance - 1e-12 <= 0.02;
  const passAll =
    clear && passSamples && passRecentShare && passCoverage && passBacktestAcc && passCalibration && passStability;
  const hardFailEdge = best.edge + 1e-12 < 0.06;
  const hardFailSamples =
    typeof decisionGate.currentSamples === "number" &&
    decisionGate.currentSamples < Math.max(8, Math.round(decisionGate.minSamples * 0.25));
  const hardFailAcc =
    typeof decisionGate.currentBacktestAcc === "number" && decisionGate.currentBacktestAcc + 1e-12 < 0.5;
  const hardFailCalibration =
    typeof decisionGate.currentCalibrationGap === "number" &&
    decisionGate.currentCalibrationGap - 1e-12 > 0.18;
  const hardFailStability = Boolean(stability) && stability!.flips >= 2;
  const hardFail = hardFailEdge || hardFailSamples || hardFailAcc || hardFailCalibration || hardFailStability;
  const passProbe = !hardFail;
  const probeAllowed =
    passProbe &&
    // Even for probing, require the curve not to be flipping back and forth.
    Boolean(stability) &&
    stability!.flips <= 1 &&
    // Avoid probing when the model is missing key meta signals (coverage/calibration).
    hasCoverage &&
    hasCalibration &&
    // Keep edge meaningful: otherwise "probe" just becomes noise trading.
    best.edge + 1e-12 >= 0.08;

  // Make the main line "safe by default": only present a directional bias when it is a real Trade setup.
  // Otherwise, keep it neutral to avoid accidental over-trading on weak / contested signals.
  const bias = passAll ? `${best.dir} ${fmtPctNum(best.prob)}` : "No-trade setup";
  const edgeBadge = passAll
    ? `Trade setup · Edge ${best.edgePp}pp`
    : probeAllowed
      ? "Watch / Probe setup"
      : passProbe
        ? "Context only"
        : "Insufficient confidence";
  const confidence = (() => {
    const edgeScore = Math.max(0, Math.min(1, best.edge / 0.25));
    const accScore =
      typeof decisionGate.currentBacktestAcc === "number"
        ? Math.max(0, Math.min(1, decisionGate.currentBacktestAcc))
        : 0;
    const shareScore =
      typeof decisionGate.currentRecentShare === "number"
        ? Math.max(0, Math.min(1, decisionGate.currentRecentShare))
        : 0;
    const raw = 0.45 * edgeScore + 0.35 * accScore + 0.2 * shareScore;
    return Math.round(raw * 100);
  })();
  const action = passAll
    ? adjustedByActual
      ? "Follow bias with risk control"
      : "Wait release confirmation / small probe only"
    : probeAllowed
      ? "Probe small (0.25x-0.5x) / watch"
      : "No-trade setup";
  const invalidation = passAll
    ? "Release+5m if bias flips and edge < 8pp, invalidate."
    : probeAllowed
      ? `If ${best.label} direction changes, stand down.`
      : "Any new data can change this view.";
  const windowTxt = passAll
    ? `${best.label} (primary)`
    : probeAllowed
      ? `${best.label} (probe)`
      : `${best.label} (watch only)`;

  const note = (() => {
    if (!clear) return `Edge is below ${edgeThPp}pp (P is close to 50%).`;
    if (!passAll && probeAllowed) return "Some guardrails are weak, but signal is still usable for small-size probing.";
    if (!passAll && passProbe) return "Guardrails are not strong enough for trading; keep as context only.";
    if (!passAll) return "Prediction is gated off by hard stops; keep as context only.";
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
        <div className="deep-outlook-trade-title">Decision Card</div>
        <div className="deep-outlook-trade-head-pills">
          {isSameTimeBatch ? (
            <span
              className="deep-pill deep-pill--hint"
              title="Multiple releases share the same timestamp. Treat it as ONE setup (avoid stacking positions)."
            >
              {`Batch x${sameTimeCount}`}
            </span>
          ) : null}
          <span className="deep-pill deep-pill--hint">{edgeBadge}</span>
        </div>
      </div>
      <div className="deep-outlook-trade-main">
        <span className={`deep-outlook-trade-bias${passAll ? " is-clear" : " is-unclear"}`}>{bias}</span>
        <span className="deep-outlook-trade-meta">{`Confidence ${confidence}%`}</span>
      </div>
      <div className="deep-outlook-trade-grid">
        <div className="deep-outlook-trade-row">
          <span className="k">Action</span>
          <span className="v">{action}</span>
        </div>
        <div className="deep-outlook-trade-row">
          <span className="k">Window</span>
          <span className="v">{windowTxt}</span>
        </div>
        <div className="deep-outlook-trade-row">
          <span className="k">Invalidation</span>
          <span className="v">{invalidation}</span>
        </div>
      </div>
      <div className="deep-outlook-trade-action deep-outlook-trade-action--checks">
        <span className="k">Guardrails</span>
        <span className="v">
          {passAll ? "Enabled" : probeAllowed ? "Partial (watch/probe)" : passProbe ? "Partial (watch)" : "Disabled by hard stops"}
        </span>
      </div>
      <div className="deep-outlook-trade-checks">
        <span className={passStability ? "ok" : "bad"}>{`Stable ${passStability ? "yes" : "no"}`}</span>
        <span className={passSamples ? "ok" : "bad"}>{`N ${decisionGate.currentSamples ?? "--"}/${decisionGate.minSamples}`}</span>
        <span className={passRecentShare ? "ok" : "bad"}>
          {`Recent ${
            typeof decisionGate.currentRecentShare === "number"
              ? `${Math.round(decisionGate.currentRecentShare * 100)}%`
              : "--"
          }/${Math.round(decisionGate.minRecentShare * 100)}%`}
        </span>
        <span className={passCoverage ? "ok" : "bad"}>
          {`Cov ${
            typeof decisionGate.currentCoverage === "number"
              ? `${Math.round(decisionGate.currentCoverage * 100)}%`
              : "--"
          }/${Math.round(decisionGate.minCoverage * 100)}%`}
        </span>
        <span className={passBacktestAcc ? "ok" : "bad"}>
          {`Acc ${
            typeof decisionGate.currentBacktestAcc === "number"
              ? `${Math.round(decisionGate.currentBacktestAcc * 100)}%`
              : "--"
          }/${Math.round(decisionGate.minBacktestAcc * 100)}%`}
        </span>
        <span className={passCalibration ? "ok" : "bad"}>
          {`Calib ${
            typeof decisionGate.currentCalibrationGap === "number"
              ? `${Math.round(decisionGate.currentCalibrationGap * 100)}%`
              : "--"
          }<=${Math.round(decisionGate.maxCalibrationGap * 100)}%`}
        </span>
      </div>
      <div className="deep-outlook-trade-note">{note}</div>
    </div>
  );
}
