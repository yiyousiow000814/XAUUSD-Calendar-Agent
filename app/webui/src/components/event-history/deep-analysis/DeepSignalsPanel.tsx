type DeepSignalsPanelProps = {
  signals: any;
};

function safeNum(v: any): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function fmtPct01(v: any): string {
  const n = safeNum(v);
  return n === null ? "--" : `${Math.round(n * 100)}%`;
}

function fmtPct100(v: any): string {
  const n = safeNum(v);
  return n === null ? "--" : `${Math.round(n)}%`;
}

function fmtSignedPct100(v: any, digits = 3): string {
  const n = safeNum(v);
  if (n === null) return "--";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(digits)}%`;
}

export function DeepSignalsPanel({ signals }: DeepSignalsPanelProps) {
  if (!signals || typeof signals !== "object") return null;

  const preheat = (signals as any)?.preheat ?? null;
  const trend = (signals as any)?.trend ?? null;
  const components = (signals as any)?.components ?? null;
  const priority = (signals as any)?.priorityRouting ?? null;
  const uncertainty = (signals as any)?.uncertainty ?? null;

  const hasAny =
    preheat != null || trend != null || components != null || priority != null || uncertainty != null;
  if (!hasAny) return null;

  const uRows: any[] = Array.isArray(uncertainty?.intervalSummary) ? uncertainty.intervalSummary : [];
  const uTop = uRows.slice(0, 3);

  const comp0: any = Array.isArray(components) && components.length > 0 ? components[0] : null;

  const prRules = priority?.rules ?? null;

  return (
    <>
      <div className="deep-block-title">Deep Signals</div>
      <div className="deep-grid">
        <div className="deep-card">
          <div className="deep-card-k">Preheat (early move)</div>
          <div className="deep-card-v">
            <span className="deep-card-v-main">{fmtPct01(preheat?.flaggedShare)}</span>
          </div>
          <div className="deep-card-sub">
            {typeof preheat?.flaggedEvents === "number" && typeof preheat?.totalEvents === "number"
              ? `Flagged: ${preheat.flaggedEvents}/${preheat.totalEvents}`
              : "Not available"}
          </div>
        </div>

        <div className="deep-card">
          <div className="deep-card-k">Trend & Seasonality</div>
          <div className="deep-card-v">
            <span className="deep-card-v-main">
              {(() => {
                const slope = safeNum(trend?.trend_slope_per_year);
                if (slope === null) return "--";
                const dir = slope > 0 ? "Up" : slope < 0 ? "Down" : "Flat";
                return `${dir} ${slope.toFixed(4)}`;
              })()}
            </span>
          </div>
          <div className="deep-card-sub">
            {`Seasonality: ${fmtPct01(trend?.seasonality_strength)} · Years: ${
              typeof trend?.years_covered === "number" ? String(trend.years_covered) : "--"
            }`}
          </div>
        </div>

        <div className="deep-card">
          <div className="deep-card-k">Uncertainty (post windows)</div>
          <div className="deep-card-sub">
            {uTop.length > 0 ? (
              <div style={{ display: "grid", gap: 6 }}>
                {uTop.map((r, idx) => (
                  <div key={idx} style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <span>{`${typeof r?.window === "number" ? r.window : "--"}m`}</span>
                    <span>{`Up: ${fmtPct100(r?.positive_share_pct)}`}</span>
                    <span>{`Mean: ${fmtSignedPct100(r?.mean_return_pct)}`}</span>
                    <span>{`Std: ${fmtSignedPct100(r?.std_return_pct)}`}</span>
                  </div>
                ))}
              </div>
            ) : (
              "Not available"
            )}
          </div>
        </div>

        <div className="deep-card">
          <div className="deep-card-k">Components (quick read)</div>
          <div className="deep-card-sub">
            {comp0 ? (
              <>
                <div>{`${String(comp0?.base_indicator ?? "").trim() || "Indicator"} · ${
                  String(comp0?.frequency_tag ?? "").trim() || "?"
                } · ${String(comp0?.core_category ?? "").trim() || "?"}`}</div>
                <div style={{ marginTop: 4 }}>
                  {`Post 60m: Up ${fmtPct100(comp0?.return_post_60_positive_share_pct)} · Mean ${fmtSignedPct100(
                    comp0?.return_post_60_avg
                  )}`}
                </div>
              </>
            ) : (
              "Not available"
            )}
          </div>
        </div>

        <div className="deep-card">
          <div className="deep-card-k">Priority Routing</div>
          <div className="deep-card-v">
            <span className="deep-card-v-main">
              {(() => {
                const s = safeNum(priority?.avgScore);
                return s === null ? "--" : s.toFixed(1);
              })()}
            </span>
          </div>
          <div className="deep-card-sub">
            {prRules?.weights ? `Weights: I ${prRules.weights.importance} · S ${prRules.weights.surprise} · R ${prRules.weights.return} · D ${prRules.weights.dominance}` : "Not available"}
          </div>
        </div>
      </div>
    </>
  );
}

