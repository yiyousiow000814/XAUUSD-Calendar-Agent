import { useEffect, useMemo, useState } from "react";
import type { EventDeepAnalysisResponse, EventHistoryPoint, EventImpactWindowStats } from "../../types";
import { formatTimeOffsetMinutes } from "../../utils/calendarTime";
import "./DeepAnalysisView.css";

type ImpactSeriesItem = { offset: number; stats?: EventImpactWindowStats };

type DeepAnalysisViewProps = {
  points: EventHistoryPoint[];
  isUsdEvent: boolean;
  deepLoading: boolean;
  deepError: string | null;
  deepData: EventDeepAnalysisResponse | null;
  impactSeriesItems: ImpactSeriesItem[];
};

export function DeepAnalysisView({
  points,
  isUsdEvent,
  deepLoading,
  deepError,
  deepData,
  impactSeriesItems
}: DeepAnalysisViewProps) {
  const [methodOpen, setMethodOpen] = useState(false);
  const [fullOpen, setFullOpen] = useState(false);
  const [highlightId, setHighlightId] = useState<string | null>(null);

  useEffect(() => {
    if (!methodOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMethodOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [methodOpen]);

  useEffect(() => {
    if (!fullOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFullOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [fullOpen]);

  useEffect(() => {
    if (!deepData?.ok) {
      setHighlightId(null);
    }
  }, [deepData?.ok]);

  const parseNumber = (raw: unknown): number | null => {
    const text = String(raw ?? "").trim();
    if (!text) return null;
    const lowered = text.toLowerCase();
    if (
      lowered === "--" ||
      lowered === "\u2014" ||
      lowered === "-" ||
      lowered === "tba" ||
      lowered === "n/a" ||
      lowered === "na" ||
      lowered === "null"
    ) {
      return null;
    }
    const cleaned = text.replace(/,/g, "").replace(/%/g, "").replace(/\s+/g, "");
    const m = cleaned.match(/^([+-]?\d+(?:\.\d+)?)([kmb])?$/i);
    if (!m) return null;
    const base = Number(m[1]);
    if (!Number.isFinite(base)) return null;
    const suf = (m[2] || "").toLowerCase();
    if (suf === "k") return base * 1_000;
    if (suf === "m") return base * 1_000_000;
    if (suf === "b") return base * 1_000_000_000;
    return base;
  };

  const fmtPct = (p: number | null | undefined) =>
    typeof p === "number" && Number.isFinite(p) ? `${Math.round(p * 100)}%` : "--";
  const fmtP = (p?: number) =>
    typeof p === "number" && Number.isFinite(p) ? `${Math.round(p * 100)}%` : "--";
  const fmtN = (n?: number) => (typeof n === "number" && Number.isFinite(n) ? `N=${n}` : "N=--");

  const localPredict = useMemo(() => {
    const rows = points
      .map((p) => ({
        a: parseNumber(p.actualRaw ?? p.actual),
        f: parseNumber(p.forecast),
        prev: parseNumber(p.previousRaw ?? p.previous)
      }))
      .filter((r) => r.a !== null);

    const sign = (v: number) => (v > 0 ? 1 : v < 0 ? -1 : 0);
    const sPrev: number[] = [];
    const sFc: number[] = [];
    for (const r of rows) {
      const a = r.a as number;
      if (typeof r.prev === "number") sPrev.push(sign(a - r.prev));
      if (typeof r.f === "number") sFc.push(sign(a - r.f));
    }

    const build = (arr: number[]) => {
      const usable = arr.filter((v) => v !== 0);
      const n = usable.length;
      const up = usable.filter((v) => v > 0).length;
      const baseUp = n > 0 ? up / n : null;
      let repeat: number | null = null;
      let tN = 0;
      let tSame = 0;
      for (let i = 1; i < usable.length; i += 1) {
        tN += 1;
        if (usable[i] === usable[i - 1]) tSame += 1;
      }
      if (tN > 0) repeat = tSame / tN;
      const last = usable.length ? usable[usable.length - 1] : 0;
      const pUpNext =
        repeat === null || last === 0 ? baseUp : last > 0 ? repeat : 1 - repeat;
      return { n, baseUp, repeat, last, pUpNext };
    };

    return { vsPrev: build(sPrev), vsForecast: build(sFc) };
  }, [points]);

  const releaseSpark = useMemo(() => {
    const buildSeries = (maxPoints = 48) => {
      const slice = points.length > maxPoints ? points.slice(-maxPoints) : points;
      return slice.map((p) => ({
        label: `${p.date} ${p.time}`,
        actual: parseNumber(p.actualRaw ?? p.actual),
        forecast: parseNumber(p.forecast),
        previous: parseNumber(p.previousRaw ?? p.previous)
      }));
    };
    const series = buildSeries();

    const hasAny = (k: "actual" | "forecast" | "previous") =>
      series.some((r) => typeof r[k] === "number" && Number.isFinite(r[k] as number));
    if (!hasAny("actual") && !hasAny("forecast") && !hasAny("previous")) return null;

    const w = 560;
    const h = 150;
    const pad = { l: 14, r: 12, t: 12, b: 18 };
    const innerW = w - pad.l - pad.r;
    const innerH = h - pad.t - pad.b;
    const values: number[] = [];
    for (const r of series) {
      if (typeof r.actual === "number") values.push(r.actual);
      if (typeof r.forecast === "number") values.push(r.forecast);
      if (typeof r.previous === "number") values.push(r.previous);
    }
    if (values.length < 2) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const q = (p: number) => {
      const idx = (sorted.length - 1) * p;
      const lo = Math.floor(idx);
      const hi = Math.ceil(idx);
      const t = idx - lo;
      const vLo = sorted[lo] ?? sorted[sorted.length - 1];
      const vHi = sorted[hi] ?? sorted[sorted.length - 1];
      return vLo + (vHi - vLo) * t;
    };
    let min = q(0.05);
    let max = q(0.95);
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    if (min === max) {
      min -= 1;
      max += 1;
    } else {
      const padY = (max - min) * 0.08;
      min -= padY;
      max += padY;
    }
    const xFor = (i: number) =>
      pad.l + (series.length <= 1 ? innerW / 2 : (i / (series.length - 1)) * innerW);
    const yFor = (v: number) => pad.t + (1 - (v - min) / (max - min)) * innerH;

    const pathFor = (k: "actual" | "forecast" | "previous") => {
      let d = "";
      let started = false;
      for (let i = 0; i < series.length; i += 1) {
        const v = series[i]?.[k];
        if (typeof v !== "number" || !Number.isFinite(v)) {
          started = false;
          continue;
        }
        const vv = Math.max(min, Math.min(max, v));
        const x = xFor(i);
        const y = yFor(vv);
        if (!started) {
          d += `M ${x},${y}`;
          started = true;
        } else {
          d += ` L ${x},${y}`;
        }
      }
      return d;
    };

    return {
      w,
      h,
      pad,
      min,
      max,
      dActual: pathFor("actual"),
      dForecast: pathFor("forecast"),
      dPrevious: pathFor("previous")
    };
  }, [points]);

  const unifiedOutlook = useMemo(() => {
    const data = (deepData?.data as any) ?? {};
    const pm = data.predictMarket ?? null;
    const unified = pm?.unifiedPath ?? null;
    const useUnified =
      !!deepData?.ok &&
      unified &&
      Array.isArray(unified.offsetsMinutes) &&
      Array.isArray(unified.pUp) &&
      unified.offsetsMinutes.length >= 2 &&
      unified.offsetsMinutes.length === unified.pUp.length;

    const offsets: number[] = useUnified ? unified.offsetsMinutes : impactSeriesItems.map((it) => it.offset);
    if (offsets.length < 2) return null;

    const pUpSeries: (number | null)[] = useUnified
      ? unified.pUp.map((v: any) => (typeof v === "number" && Number.isFinite(v) ? v : null))
      : impactSeriesItems.map((it) => {
          const s = it.stats;
          if (!s) return null;
          let pUp: number | null = null;
          if (typeof s.best_p === "number" && Number.isFinite(s.best_p)) {
            if (s.best_direction === "up") pUp = s.best_p;
            else if (s.best_direction === "down") pUp = 1 - s.best_p;
          }
          if (pUp === null && typeof s.p_up === "number" && Number.isFinite(s.p_up)) {
            pUp = s.p_up;
          }
          return pUp;
        });

    const pts = offsets
      .map((offset, idx) => {
        const raw = pUpSeries[idx];
        if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
        const clamped = Math.max(0, Math.min(1, raw));
        return { idx, offset, pUp: clamped };
      })
      .filter((v): v is { idx: number; offset: number; pUp: number } => !!v);
    if (pts.length < 2) return null;

    const w = 520;
    const h = 140;
    const pad = { l: 44, r: 12, t: 10, b: 30 };
    const innerW = w - pad.l - pad.r;
    const innerH = h - pad.t - pad.b;
    const denom = Math.max(1, offsets.length - 1);
    const xForIdx = (i: number) => pad.l + (i / denom) * innerW;
    const yForP = (p: number) => pad.t + (1 - p) * innerH;
    const baselineY = yForP(0.5);

    let dMain = "";
    for (const p of pts) {
      const x = xForIdx(p.idx);
      const y = yForP(p.pUp);
      dMain += dMain ? ` L ${x},${y}` : `M ${x},${y}`;
    }

    let dWithout: string | null = null;
    const contribs = Array.isArray(pm?.contributions) ? pm.contributions : [];
    const hlId = (highlightId ?? "").trim();
    if (hlId && contribs.length) {
      const hit = contribs.find((c: any) => String(c?.eventId ?? "") === hlId);
      const delta = Array.isArray(hit?.deltaPUp) ? hit.deltaPUp : null;
      if (delta && delta.length === offsets.length) {
        let d2 = "";
        for (let i = 0; i < offsets.length; i += 1) {
          const base = pUpSeries[i];
          const dv = delta[i];
          if (
            typeof base !== "number" ||
            !Number.isFinite(base) ||
            typeof dv !== "number" ||
            !Number.isFinite(dv)
          ) {
            continue;
          }
          const pUp = Math.max(0, Math.min(1, base - dv));
          const x = xForIdx(i);
          const y = yForP(pUp);
          d2 += d2 ? ` L ${x},${y}` : `M ${x},${y}`;
        }
        if (d2) dWithout = d2;
      }
    }

    const idx0 = offsets.findIndex((v) => v === 0);
    const x0 = idx0 >= 0 ? xForIdx(idx0) : null;
    const firstOffset = offsets[0] ?? null;
    const lastOffset = offsets[offsets.length - 1] ?? null;

    return {
      w,
      h,
      pad,
      dMain,
      dWithout,
      baselineY,
      x0,
      firstLabel: typeof firstOffset === "number" ? formatTimeOffsetMinutes(firstOffset) : "",
      lastLabel: typeof lastOffset === "number" ? formatTimeOffsetMinutes(lastOffset) : ""
    };
  }, [deepData, highlightId, impactSeriesItems]);

  if (!isUsdEvent) {
    return <div className="history-impact-status error">Deep analysis is available for USD events only.</div>;
  }
  if (deepError) {
    return <div className="history-impact-status error">{deepError}</div>;
  }
  if (deepLoading || !deepData) {
    return <div className="history-impact-status">Loading deep analysis...</div>;
  }

  const data = (deepData.data as any) ?? {};
  const predictRelease = data.predictRelease ?? {};
  const aGtF = predictRelease.actualGtForecast ?? predictRelease.actual_gt_forecast;
  const aGtP = predictRelease.actualGtPrevious ?? predictRelease.actual_gt_previous;

  const content = (
    <>
      <div className="deep-block-title">Predict Release (baseline)</div>
      <div className="deep-grid">
        <div className="deep-card">
          <div className="deep-card-k">P(Actual &gt; Forecast)</div>
          <div className="deep-card-v">
            {deepData.ok ? fmtP(aGtF?.p) : fmtPct(localPredict.vsForecast.pUpNext)}
          </div>
          <div className="deep-card-sub">
            {deepData.ok ? fmtN(aGtF?.n) : `N=${localPredict.vsForecast.n}`}
          </div>
        </div>
        <div className="deep-card">
          <div className="deep-card-k">P(Actual &gt; Previous)</div>
          <div className="deep-card-v">
            {deepData.ok ? fmtP(aGtP?.p) : fmtPct(localPredict.vsPrev.pUpNext)}
          </div>
          <div className="deep-card-sub">
            {deepData.ok ? fmtN(aGtP?.n) : `N=${localPredict.vsPrev.n}`}
          </div>
        </div>
      </div>

      <div className="deep-block-title">Unified Outlook P(t)</div>
      <div className="deep-outlook">
        {unifiedOutlook ? (
          <div className="deep-outlook-chart">
            <svg
              viewBox={`0 0 ${unifiedOutlook.w} ${unifiedOutlook.h}`}
              className="deep-outlook-svg"
              role="img"
              aria-label="Unified outlook probability path"
            >
              <line
                x1={unifiedOutlook.pad.l}
                x2={unifiedOutlook.w - unifiedOutlook.pad.r}
                y1={Math.round(unifiedOutlook.baselineY) + 0.5}
                y2={Math.round(unifiedOutlook.baselineY) + 0.5}
                className="deep-outlook-baseline"
                vectorEffect="non-scaling-stroke"
              />
              {typeof unifiedOutlook.x0 === "number" ? (
                <line
                  x1={Math.round(unifiedOutlook.x0) + 0.5}
                  x2={Math.round(unifiedOutlook.x0) + 0.5}
                  y1={unifiedOutlook.pad.t}
                  y2={unifiedOutlook.h - unifiedOutlook.pad.b}
                  className="deep-outlook-now"
                  vectorEffect="non-scaling-stroke"
                />
              ) : null}
              <path
                d={unifiedOutlook.dMain}
                className="deep-outlook-line"
                vectorEffect="non-scaling-stroke"
              />
              {unifiedOutlook.dWithout ? (
                <path
                  d={unifiedOutlook.dWithout}
                  className="deep-outlook-line deep-outlook-line--without"
                  vectorEffect="non-scaling-stroke"
                />
              ) : null}
              <text x={unifiedOutlook.pad.l} y={unifiedOutlook.h - 10} className="deep-outlook-axis">
                {unifiedOutlook.firstLabel}
              </text>
              <text
                x={unifiedOutlook.w - unifiedOutlook.pad.r}
                y={unifiedOutlook.h - 10}
                textAnchor="end"
                className="deep-outlook-axis"
              >
                {unifiedOutlook.lastLabel}
              </text>
              <text x={unifiedOutlook.pad.l} y={unifiedOutlook.pad.t + 12} className="deep-outlook-axis">
                P(up)
              </text>
            </svg>
          </div>
        ) : (
          <div className="history-impact-status">
            {impactSeriesItems.length === 0 ? "Loading unified outlook..." : "Unified outlook is unavailable."}
          </div>
        )}

        <div className="deep-outlook-note">
          One main path P(t) is shown. When deep JSON is available, nearby events contribute weighted deltas to this
          path; clicking an event highlights its local contribution without switching to a different direction.
        </div>

        {(() => {
          const pm = data.predictMarket ?? null;
          const contribs = Array.isArray(pm?.contributions) ? pm.contributions : [];
          if (!deepData.ok || contribs.length === 0) {
            return (
              <div className="deep-muted" style={{ marginTop: 8 }}>
                Per-event contributions are available when deep analysis JSON is present.
              </div>
            );
          }

          const ranked = [...contribs]
            .map((c: any) => ({
              eventId: String(c?.eventId ?? "").trim(),
              label: String(c?.label ?? c?.eventId ?? "").trim(),
              weight: typeof c?.weight === "number" && Number.isFinite(c.weight) ? c.weight : null
            }))
            .filter((c) => c.eventId.length > 0);
          ranked.sort((a, b) => Math.abs(b.weight ?? 0) - Math.abs(a.weight ?? 0));
          const top = ranked.slice(0, 12);

          const hl = (highlightId ?? "").trim();
          return (
            <div className="deep-contrib">
              <div className="deep-contrib-title">Event contributions (top)</div>
              <div className="deep-contrib-list">
                {top.map((c) => {
                  const active = hl === c.eventId;
                  return (
                    <button
                      key={c.eventId}
                      type="button"
                      className={`deep-contrib-item${active ? " active" : ""}`}
                      onClick={() => setHighlightId(c.eventId)}
                    >
                      <span className="deep-contrib-label">{c.label || c.eventId}</span>
                      <span className="deep-contrib-w">
                        {typeof c.weight === "number" ? c.weight.toFixed(2) : "--"}
                      </span>
                    </button>
                  );
                })}
              </div>
              <div className="deep-muted" style={{ marginTop: 8 }}>
                Tip: selecting an event overlays a dashed line showing P(t) without that event (if Delta_i(t) is
                available).
              </div>
            </div>
          );
        })()}
      </div>

      <div className="deep-block-title">Evidence</div>
      <div className="deep-evidence">
        <div className="deep-evidence-row">
          <span className="deep-evidence-k">History points</span>
          <span className="deep-evidence-v">{points.length}</span>
        </div>
        <div className="deep-evidence-row">
          <span className="deep-evidence-k">Model</span>
          <span className="deep-evidence-v">
            {deepData.ok ? "Deep JSON model" : "Fallback: base rate + repeat rate"}
          </span>
        </div>
      </div>

      <div className="deep-grid deep-grid--bars">
        <div className="deep-card deep-card--bar">
          <div className="deep-card-k">Actual vs Forecast (sign)</div>
          <div className="deep-bar">
            {(() => {
              const up = localPredict.vsForecast.baseUp === null ? 0 : localPredict.vsForecast.baseUp;
              const upW = Math.round(up * 100);
              const downW = Math.max(0, 100 - upW);
              return (
                <>
                  <span className="deep-bar-up" style={{ width: `${upW}%` }} />
                  <span className="deep-bar-down" style={{ width: `${downW}%` }} />
                </>
              );
            })()}
          </div>
          <div className="deep-card-sub">
            Up {fmtPct(localPredict.vsForecast.baseUp)} · Repeat {fmtPct(localPredict.vsForecast.repeat)}
          </div>
        </div>

        <div className="deep-card deep-card--bar">
          <div className="deep-card-k">Actual vs Previous (sign)</div>
          <div className="deep-bar">
            {(() => {
              const up = localPredict.vsPrev.baseUp === null ? 0 : localPredict.vsPrev.baseUp;
              const upW = Math.round(up * 100);
              const downW = Math.max(0, 100 - upW);
              return (
                <>
                  <span className="deep-bar-up" style={{ width: `${upW}%` }} />
                  <span className="deep-bar-down" style={{ width: `${downW}%` }} />
                </>
              );
            })()}
          </div>
          <div className="deep-card-sub">
            Up {fmtPct(localPredict.vsPrev.baseUp)} · Repeat {fmtPct(localPredict.vsPrev.repeat)}
          </div>
        </div>
      </div>

      {releaseSpark ? (
        <div className="deep-spark-wrap">
          <div className="deep-spark-legend">
            <span className="deep-spark-key actual">Actual</span>
            <span className="deep-spark-key forecast">Forecast</span>
            <span className="deep-spark-key previous">Previous</span>
          </div>
          <svg viewBox={`0 0 ${releaseSpark.w} ${releaseSpark.h}`} className="deep-spark" role="img">
            <g className="deep-spark-grid">
              <line
                x1={releaseSpark.pad.l}
                x2={releaseSpark.w - releaseSpark.pad.r}
                y1={releaseSpark.pad.t}
                y2={releaseSpark.pad.t}
              />
              <line
                x1={releaseSpark.pad.l}
                x2={releaseSpark.w - releaseSpark.pad.r}
                y1={releaseSpark.h - releaseSpark.pad.b}
                y2={releaseSpark.h - releaseSpark.pad.b}
              />
            </g>
            {releaseSpark.dPrevious ? (
              <path
                d={releaseSpark.dPrevious}
                className="deep-spark-line previous"
                vectorEffect="non-scaling-stroke"
              />
            ) : null}
            {releaseSpark.dForecast ? (
              <path
                d={releaseSpark.dForecast}
                className="deep-spark-line forecast"
                vectorEffect="non-scaling-stroke"
              />
            ) : null}
            {releaseSpark.dActual ? (
              <path
                d={releaseSpark.dActual}
                className="deep-spark-line actual"
                vectorEffect="non-scaling-stroke"
              />
            ) : null}
          </svg>
        </div>
      ) : (
        <div className="deep-muted" style={{ marginTop: 8 }}>
          Release history sparkline is not available (insufficient numeric points).
        </div>
      )}

      {deepData.ok ? null : (
        <div className="deep-muted" style={{ marginTop: 10 }}>
          Deep JSON is not available for this event yet. Showing a baseline fallback from this event’s release history.
        </div>
      )}
    </>
  );

  return (
    <div className="history-impact-deep" data-qa="qa:history:deep-analysis">
      <div className="history-impact-deep-head">
        <div className="history-impact-deep-title">Deep Analysis</div>
        <div className="deep-head-actions">
          <button
            type="button"
            className="deep-help-btn"
            onClick={() => setMethodOpen(true)}
            data-qa="qa:deep:how"
          >
            How it's computed
          </button>
          <button
            type="button"
            className="deep-help-btn deep-expand-btn"
            onClick={() => setFullOpen(true)}
            data-qa="qa:deep:expand"
          >
            Open
          </button>
        </div>
      </div>

      <div className="history-impact-deep-body">
        {fullOpen ? (
          <div
            className="modal-backdrop modal-backdrop-deep-full open"
            data-qa="qa:modal-backdrop:deep-full"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setFullOpen(false);
            }}
          >
            <div
              className="modal modal-deep-full open"
              data-qa="qa:modal:deep-full"
              role="dialog"
              aria-modal="true"
              aria-label="Deep analysis"
            >
              <div className="deep-method-header">
                <div className="deep-method-title">Deep Analysis</div>
                <button
                  type="button"
                  className="deep-method-close"
                  onClick={() => setFullOpen(false)}
                  aria-label="Close"
                >
                  Close
                </button>
              </div>
              <div className="deep-full-body">{content}</div>
            </div>
          </div>
        ) : null}

        {methodOpen ? (
          <div
            className="modal-backdrop modal-backdrop-deep-method open"
            data-qa="qa:modal-backdrop:deep-method"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setMethodOpen(false);
            }}
          >
            <div
              className="modal modal-deep-method open"
              data-qa="qa:modal:deep-method"
              role="dialog"
              aria-modal="true"
              aria-label="How deep analysis is computed"
            >
              <div className="deep-method-header">
                <div className="deep-method-title">How deep analysis is computed</div>
                <button
                  type="button"
                  className="deep-method-close"
                  onClick={() => setMethodOpen(false)}
                  aria-label="Close"
                >
                  Close
                </button>
              </div>

              <div className="deep-method-body">
                <div className="deep-method-block">
                  <div className="deep-method-h">What you are seeing</div>
                  <div className="deep-method-p">
                    This panel has two parts:
                  </div>
                  <ul className="deep-method-ul">
                    <li>
                      <strong>Predict Release</strong>: baseline probabilities like P(Actual &gt; Forecast) and
                      P(Actual &gt; Previous) derived from this event’s past releases.
                    </li>
                    <li>
                      <strong>Unified Outlook P(t)</strong>: one main probability path of the market bias within
                      +/-24h of the selected event. When deep JSON is available, nearby events contribute weighted
                      deltas to this path (clicking an event only highlights its contribution).
                    </li>
                  </ul>
                </div>

                <div className="deep-method-block">
                  <div className="deep-method-h">How it is computed (high level)</div>
                  {(() => {
                    const method = data.method ?? null;
                    const steps = Array.isArray(method?.steps) ? method.steps : null;
                    const fallbackSteps = [
                      "Collect numeric history from past releases for this event (Actual / Forecast / Previous).",
                      "Compute baseline outcome statistics (base rate + repeat rate on the sign of surprises).",
                      "Use the Impact model as the fallback P(t). When deep JSON is available, combine multiple signals and nearby-event contributions into a single unified P(t)."
                    ];
                    const finalSteps = steps && steps.length ? steps : fallbackSteps;
                    return (
                      <ol className="deep-method-ol">
                        {finalSteps.slice(0, 12).map((s: string, idx: number) => (
                          <li key={idx}>{s}</li>
                        ))}
                      </ol>
                    );
                  })()}
                  <div className="deep-method-p" style={{ marginTop: 8 }}>
                    Note: Predict Release does <strong>not</strong> use today’s Forecast as a “feature” to predict the
                    outcome. It is a probability estimate from historical releases (and additional signals when deep
                    JSON is present).
                  </div>
                </div>

                <div className="deep-method-block">
                  <div className="deep-method-h">Credibility / confidence</div>
                  <div className="deep-method-p">
                    Higher N and more stable patterns improve credibility. This is a probabilistic guide, not a
                    guarantee.
                  </div>
                  <div className="deep-method-kv">
                    <span className="deep-method-k">Current history N</span>
                    <span className="deep-method-v">{points.length}</span>
                  </div>
                  <div className="deep-method-kv">
                    <span className="deep-method-k">Current model</span>
                    <span className="deep-method-v">
                      {deepData.ok ? "Deep JSON model" : "Fallback: base rate + repeat rate"}
                    </span>
                  </div>
                </div>

                <div className="deep-method-block">
                  <div className="deep-method-h">Signals</div>
                  <div className="deep-method-p">
                    When deep JSON is present, more signals are used. Without deep JSON, only baseline statistics are
                    used.
                  </div>
                  <div className="deep-method-signals">
                    {(() => {
                      const used = Array.isArray(data.signalsUsed) ? data.signalsUsed : null;
                      if (used && used.length) {
                        return used.slice(0, 24).map((s: any, idx: number) => (
                          <span key={String(s?.id ?? idx)} className="deep-signal-chip">
                            {String(s?.title ?? s?.id ?? s)}
                          </span>
                        ));
                      }
                      return (
                        <>
                          <span className="deep-signal-chip">Base rate</span>
                          <span className="deep-signal-chip">Repeat rate</span>
                        </>
                      );
                    })()}
                  </div>
                </div>

                <div className="deep-method-block">
                  <div className="deep-method-h">Limitations</div>
                  {(() => {
                    const method = data.method ?? null;
                    const limitations = Array.isArray(method?.limitations)
                      ? method.limitations
                      : [
                          "Macro regimes change; correlations can break.",
                          "Events are correlated; attribution is approximate.",
                          "Data quality (revisions / missing values) affects results."
                        ];
                    return (
                      <ul className="deep-method-ul">
                        {limitations.slice(0, 10).map((s: string, idx: number) => (
                          <li key={idx}>{s}</li>
                        ))}
                      </ul>
                    );
                  })()}
                </div>
              </div>
            </div>
          </div>
        ) : null}

        <div className="deep-panel-scroll">{content}</div>
      </div>
    </div>
  );
}
