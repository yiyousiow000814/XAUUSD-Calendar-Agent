import { useEffect, useMemo, useState } from "react";
import type { EventDeepAnalysisResponse, EventHistoryPoint, EventImpactWindowStats } from "../../types";
import { backend } from "../../api";
import { formatTimeOffsetMinutes, formatUtcOffset } from "../../utils/calendarTime";
import { DEFAULT_PREDICT_RELEASE_MODEL_USD } from "../../utils/predictReleaseModel";
import { DeepAnalysisMethodModal } from "./DeepAnalysisMethodModal";
import { DeepSignalsPanel } from "./deep-analysis/DeepSignalsPanel";
import { TradeBiasPanel } from "./deep-analysis/TradeBiasPanel";
import { useLocalPredictRelease } from "./deep-analysis/useLocalPredictRelease";
import { useNowcastVsPrev } from "./deep-analysis/useNowcastVsPrev";
import { parseNumber } from "./deep-analysis/utils";
import "./DeepAnalysisView.css";

type ImpactSeriesItem = { offset: number; stats?: EventImpactWindowStats };

type DeepAnalysisViewProps = {
  points: EventHistoryPoint[];
  metricKey: string;
  cur: string;
  isUsdEvent: boolean;
  deepLoading: boolean;
  deepError: string | null;
  deepData: EventDeepAnalysisResponse | null;
  impactSeriesItems: ImpactSeriesItem[];
  // UTC time for the selected release instance (the center of the +/-24h unified window).
  anchorDtUtc: string;
  // Display offset minutes (calendar timezone), used to show the anchor time label without leaking local timezone.
  displayOffsetMinutes: number;
  // "Low/Medium/High" importance label from the calendar list.
  selectionImpact?: string;
  // Values for the selected release instance (from the calendar list). These allow conditional predictions.
  selectionActual?: string;
  selectionForecast?: string;
  selectionPrevious?: string;
};

export function DeepAnalysisView({
  points,
  metricKey,
  cur,
  isUsdEvent,
  deepLoading,
  deepError,
  deepData,
  impactSeriesItems,
  anchorDtUtc,
  displayOffsetMinutes,
  selectionImpact,
  selectionActual,
  selectionForecast,
  selectionPrevious
}: DeepAnalysisViewProps) {
  const [methodOpen, setMethodOpen] = useState(false);
  const [fullOpen, setFullOpen] = useState(false);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [showUnifiedPrior, setShowUnifiedPrior] = useState(false);
  const [predictModel, setPredictModel] = useState<any>(DEFAULT_PREDICT_RELEASE_MODEL_USD);
  const nowcastVsPrev = useNowcastVsPrev({
    isUsdEvent,
    metricKey,
    cur,
    anchorDtUtc,
    displayOffsetMinutes,
    selectionForecast,
    selectionPrevious,
    predictModel
  });

  useEffect(() => {
    if (!methodOpen && !fullOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Close only the top-most deep modal layer.
      if (methodOpen) {
        setMethodOpen(false);
        return;
      }
      if (fullOpen) setFullOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [methodOpen, fullOpen]);

  useEffect(() => {
    if (!deepData?.ok) {
      setHighlightId(null);
    }
  }, [deepData?.ok]);

  useEffect(() => {
    let mounted = true;
    // Optional: desktop backend can provide an updated model from the calendar repo.
    backend
      .getPredictReleaseModelUsd()
      .then((res: any) => {
        if (!mounted) return;
        if (res?.ok && res?.data && Number(res.data.schema) === 1) {
          setPredictModel(res.data);
        }
      })
      .catch(() => {
        // ignore; fallback model stays in use
      });
    return () => {
      mounted = false;
    };
  }, []);

  const fmtPctNum = (p: number | null) => {
    if (typeof p !== "number" || !Number.isFinite(p)) return "--";
    if (p > 0 && p < 0.01) return "<1%";
    return `${Math.round(p * 100)}%`;
  };

  const displayTzLabel = useMemo(() => formatUtcOffset(Number(displayOffsetMinutes) || 0), [displayOffsetMinutes]);

  const anchorLabel = useMemo(() => {
    const raw = String(anchorDtUtc || "").trim();
    if (!raw) return "";
    const utcMs = Date.parse(raw);
    if (!Number.isFinite(utcMs)) return "";
    const shifted = new Date(utcMs + (Number(displayOffsetMinutes) || 0) * 60_000);
    const pad = (v: number) => String(v).padStart(2, "0");
    // Use UTC getters because we've already applied the display offset in ms.
    const dd = pad(shifted.getUTCDate());
    const mm = pad(shifted.getUTCMonth() + 1);
    const hh = pad(shifted.getUTCHours());
    const min = pad(shifted.getUTCMinutes());
    return `${dd}-${mm} ${hh}:${min} ${displayTzLabel}`;
  }, [anchorDtUtc, displayOffsetMinutes, displayTzLabel]);


  const localPredict = useLocalPredictRelease({
    points,
    metricKey,
    anchorDtUtc,
    displayOffsetMinutes,
    selectionImpact,
    selectionActual,
    selectionForecast,
    selectionPrevious,
    predictModel
  });

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
    const prior = pm?.unifiedPathPrior ?? null;
    const useUnified =
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

    const usePrior =
      !highlightId &&
      showUnifiedPrior &&
      prior &&
      Array.isArray(prior.offsetsMinutes) &&
      Array.isArray(prior.pUp) &&
      prior.offsetsMinutes.length === offsets.length &&
      prior.pUp.length === offsets.length;
    const pUpPrior: (number | null)[] = usePrior
      ? prior.pUp.map((v: any) => (typeof v === "number" && Number.isFinite(v) ? v : null))
      : [];

    const w = 520;
    const h = 140;
    const pad = { l: 44, r: 12, t: 10, b: 30 };
    const innerW = w - pad.l - pad.r;
    const innerH = h - pad.t - pad.b;
    const denom = Math.max(1, offsets.length - 1);
    const xForIdx = (i: number) => pad.l + (i / denom) * innerW;
    const yForP = (p: number) => pad.t + (1 - p) * innerH;
    const baselineY = yForP(0.5);

    const idx0 = offsets.findIndex((v) => v === 0);

    const buildPath = (
      vals: (number | null)[],
      startIdx: number,
      endIdx: number,
      opts?: { overrideEnd?: number | null }
    ) => {
      let d = "";
      let started = false;
      const step = startIdx <= endIdx ? 1 : -1;
      for (let i = startIdx; step > 0 ? i <= endIdx : i >= endIdx; i += step) {
        const ov =
          i === endIdx && opts && typeof opts.overrideEnd === "number" && Number.isFinite(opts.overrideEnd)
            ? opts.overrideEnd
            : null;
        const v = ov ?? vals[i];
        if (typeof v !== "number" || !Number.isFinite(v)) {
          started = false;
          continue;
        }
        const pUp = Math.max(0, Math.min(1, v));
        const x = xForIdx(i);
        const y = yForP(pUp);
        d += started ? ` L ${x},${y}` : `M ${x},${y}`;
        started = true;
      }
      return d;
    };

    let dMain = buildPath(pUpSeries, 0, offsets.length - 1);

    let dWithout: string | null = null;
    let dPrior: string | null = null;
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
    } else if (usePrior && pUpPrior.length === offsets.length && idx0 >= 0) {
      // Make the "compare" mode feel like one continuous story: forecast-only leads into adjusted,
      // rather than drawing two full-length overlapping curves.
      const endOverride = pUpSeries[idx0];
      dPrior = buildPath(pUpPrior, 0, idx0, { overrideEnd: endOverride });
      dMain = buildPath(pUpSeries, idx0, offsets.length - 1);
    }
    const x0 = idx0 >= 0 ? xForIdx(idx0) : null;
    const firstOffset = offsets[0] ?? null;
    const lastOffset = offsets[offsets.length - 1] ?? null;

    return {
      w,
      h,
      pad,
      offsets,
      pUpSeries,
      dMain,
      dPrior,
      dWithout,
      baselineY,
      x0,
      idx0,
      firstLabel: typeof firstOffset === "number" ? formatTimeOffsetMinutes(firstOffset) : "",
      lastLabel: typeof lastOffset === "number" ? formatTimeOffsetMinutes(lastOffset) : "",
      anchorLabel,
      hasPrior: useUnified && prior && Array.isArray(prior.pUp) && prior.pUp.length === offsets.length
    };
  }, [deepData, highlightId, impactSeriesItems, anchorLabel, showUnifiedPrior]);

  const unifiedQuickRead = useMemo(() => {
    if (!unifiedOutlook) return { all: [], strong: [], edgeTh: 0.1, best: null };
    const offsets = Array.isArray((unifiedOutlook as any).offsets) ? ((unifiedOutlook as any).offsets as number[]) : [];
    const pUpSeries = Array.isArray((unifiedOutlook as any).pUpSeries)
      ? ((unifiedOutlook as any).pUpSeries as Array<number | null>)
      : [];
    const edgeTh = 0.1; // Show only "usable" edges (>=10pp) in Quick read.
    if (offsets.length < 2 || pUpSeries.length !== offsets.length) return { all: [], strong: [], edgeTh, best: null };

    const at = (m: number) => {
      const idx = offsets.indexOf(m);
      if (idx < 0) return null;
      const v = pUpSeries[idx];
      return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : null;
    };

    const horizons = [
      { label: "+1h", minutes: 60 },
      { label: "+4h", minutes: 240 },
      { label: "+12h", minutes: 720 }
    ];

    const all = horizons
      .map((h) => {
        const pUp = at(h.minutes);
        if (typeof pUp !== "number") return null;
        const up = pUp >= 0.5;
        const prob = up ? pUp : 1 - pUp;
        const edge = Math.abs(pUp - 0.5);
        const edgePp = Math.round(edge * 100);
        const cls = edge + 1e-12 >= edgeTh ? "is-strong" : "is-weak";
        return {
          key: h.label,
          label: h.label,
          minutes: h.minutes,
          dir: up ? "Up" : "Down",
          prob,
          edge,
          edgePp,
          className: cls
        };
      })
      .filter((v): v is NonNullable<typeof v> => Boolean(v));

    const strong = all.filter((it) => it.edge + 1e-12 >= edgeTh);
    const order: Record<string, number> = { "+1h": 1, "+4h": 2, "+12h": 3 };
    const best =
      all.length > 0
        ? [...all].sort((a, b) => {
            if (Math.abs(b.edge - a.edge) > 1e-12) return b.edge - a.edge;
            const oa = order[a.label] ?? 99;
            const ob = order[b.label] ?? 99;
            return oa - ob;
          })[0] ?? null
        : null;
    return { all, strong, edgeTh, best };
  }, [unifiedOutlook]);

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
  const meta = (deepData.meta as any) ?? {};
  const isFallback = String(meta?.source ?? "").toLowerCase() === "fallback";
  const pm = data.predictMarket ?? null;
  const um = pm?.unifiedMeta ?? pm?.fallback ?? null;
  const adjustedByActual = Boolean(um?.adjustedByActual);
  const usedActualEvents =
    typeof um?.usedActualEvents === "number" && Number.isFinite(um.usedActualEvents)
      ? Math.max(0, Math.round(um.usedActualEvents))
      : null;
  const asOfUtcLabel =
    typeof um?.asOfUtc === "string"
      ? (() => {
          const raw = String(um.asOfUtc || "").trim();
          const ms = Date.parse(raw);
          if (!Number.isFinite(ms)) return "";
          const shifted = new Date(ms + (Number(displayOffsetMinutes) || 0) * 60_000);
          const pad = (v: number) => String(v).padStart(2, "0");
          const dd = pad(shifted.getUTCDate());
          const mm = pad(shifted.getUTCMonth() + 1);
          const hh = pad(shifted.getUTCHours());
          const min = pad(shifted.getUTCMinutes());
          return `${dd}-${mm} ${hh}:${min} ${displayTzLabel}`;
        })()
      : "";
  const predictRelease = data.predictRelease ?? {};
  const aGtF = predictRelease.actualGtForecast ?? predictRelease.actual_gt_forecast;
  const aGtP = predictRelease.actualGtPrevious ?? predictRelease.actual_gt_previous;
  // Deep JSON has only two baseline probabilities today; the UI shows a clearer 3-way breakdown from local history.
  // Keep these for future expansions, but don't gate the main Predict Release UI on them.
  const _hasDeepAGtF =
    Boolean(deepData.ok) &&
    typeof aGtF?.p === "number" &&
    Number.isFinite(aGtF.p) &&
    typeof aGtF?.n === "number" &&
    Number.isFinite(aGtF.n) &&
    aGtF.n > 0;
  const _hasDeepAGtP =
    Boolean(deepData.ok) &&
    typeof aGtP?.p === "number" &&
    Number.isFinite(aGtP.p) &&
    typeof aGtP?.n === "number" &&
    Number.isFinite(aGtP.n) &&
    aGtP.n > 0;

  const modelPv = localPredict.modelVsPrev;
  const nowPv = nowcastVsPrev;
  const f0 = parseNumber(selectionForecast);
  const hasForecast0 = typeof f0 === "number" && Number.isFinite(f0);
  const modelAcc =
    modelPv && typeof (modelPv as any).backtestAcc === "number" && Number.isFinite((modelPv as any).backtestAcc)
      ? Number((modelPv as any).backtestAcc)
      : null;
  const nowAcc =
    nowPv && typeof (nowPv as any).backtestAcc === "number" && Number.isFinite((nowPv as any).backtestAcc)
      ? Number((nowPv as any).backtestAcc)
      : null;

  // With Forecast, we already have a stronger dedicated model. Only let the nowcast-chain
  // fill low-confidence gaps when it backtests well; never override a reliable model.
  const NOWCAST_MIN_ACC_WF = 0.75;
  const NOWCAST_MIN_SOURCES_WF = 4;

  const shouldUseNowcast =
    Boolean(nowPv?.reliable) &&
    (hasForecast0
      ? // With Forecast: only fill gaps.
        ((!modelPv || !modelPv.reliable) &&
          typeof nowAcc === "number" &&
          Number.isFinite(nowAcc) &&
          nowAcc + 1e-12 >= NOWCAST_MIN_ACC_WF &&
          typeof (nowPv as any)?.sourcesUsed === "number" &&
          Number.isFinite((nowPv as any).sourcesUsed) &&
          Number((nowPv as any).sourcesUsed) >= NOWCAST_MIN_SOURCES_WF)
      : // No Forecast: allow nowcast to override when it is reliable and at least as good as the model.
        (!modelPv ||
          !modelPv.reliable ||
          (typeof nowAcc === "number" &&
            typeof modelAcc === "number" &&
            Number.isFinite(nowAcc) &&
            Number.isFinite(modelAcc) &&
            nowAcc + 1e-12 >= modelAcc)));

  const pvNowcast = shouldUseNowcast ? nowPv : null;
  const pvChoice = pvNowcast ?? modelPv ?? localPredict.proxyVsPrev;
  const pvKind: "nowcast" | "model" | "proxy" = pvNowcast ? "nowcast" : modelPv ? "model" : "proxy";
  const pvReliable = pvKind !== "proxy" && Boolean((pvChoice as any)?.reliable);

  const content = (
    <>
      <div className="deep-block-title">Predict Release</div>
      <div className="deep-grid">
        <div className="deep-card">
          <div className="deep-card-k">Actual vs Previous</div>
          {(() => {
            const pv = pvChoice;
            if (!pv) return <div className="deep-card-v">--</div>;
            const isModel = pvKind !== "proxy";
            const pred = pv?.pred0 ?? null;
            const predProb =
              pred === ">"
                ? pv?.pGt ?? null
                : pred === "="
                  ? pv?.pEq ?? null
                  : pred === "<"
                    ? pv?.pLt ?? null
                    : null;
            // Fallback to the max bucket if we don't have a specific predicted label.
            const fallbackProb =
              pv ? Math.max(pv.pGt ?? 0, pv.pEq ?? 0, pv.pLt ?? 0) : null;
            const shownProb = predProb ?? fallbackProb;
            const shownLabel =
              pred ??
              (pv
                ? (pv.pGt ?? 0) >= (pv.pEq ?? 0) && (pv.pGt ?? 0) >= (pv.pLt ?? 0)
                  ? ">"
                  : (pv.pEq ?? 0) >= (pv.pLt ?? 0)
                    ? "="
                    : "<"
                : "");
            const isLowConfidence = isModel && pv && !pv.reliable;
            return (
              <div className={`deep-card-v${isLowConfidence ? " is-low" : ""}`}>
                <span className="deep-card-v-main">{`${shownLabel} ${fmtPctNum(shownProb)}`}</span>
                {isLowConfidence ? (
                  <span className="deep-pill deep-pill--low" title="Below confidence threshold">
                    Low confidence
                  </span>
                ) : null}
              </div>
            );
          })()}
          <div className="deep-card-sub">
            <div>
              {(() => {
                if (!localPredict.all.vsPrev.n) return "No previous history";
                if (pvKind === "nowcast" && pvChoice) {
                  const pv = pvChoice as any;
                  const confPct = Math.round((pv?.conf ?? 0) * 100);
                  const thPct = Math.round((pv?.threshold ?? 0) * 100);
                  const src = pv?.sourcesUsed ?? 0;
                  return `Nowcast chain: score=${confPct}% (th>=${thPct}%) · sources=${src}`;
                }
                if (pvKind === "model" && localPredict.modelVsPrev) {
                  const pv = localPredict.modelVsPrev;
                  const confPct = Math.round((pv.conf ?? 0) * 100);
                  const thPct = Math.round((pv.threshold ?? 0) * 100);
                  return `Calendar model: score=${confPct}% (th>=${thPct}%) · N=${pv.n}`;
                }
                const proxy = localPredict.proxyVsPrev;
                if (!proxy) return "Insufficient history for proxy baseline";
                return `${proxy.conditioned ? "Conditioned on " : "Based on "}${proxy.proxyLabel} - Previous: N=${proxy.n}`;
              })()}
            </div>
            {(() => {
              if (pvKind === "nowcast" && pvChoice) {
                const pv = pvChoice as any;
                if (typeof pv?.backtestAcc === "number" && Number.isFinite(pv.backtestAcc)) {
                  const note = pv?.reliable ? "" : " · below confidence threshold";
                  return (
                    <div className="deep-card-sub2">{`Backtest reliability (enabled metric): ${Math.round(
                      pv.backtestAcc * 100
                    )}%${note}`}</div>
                  );
                }
                return pv?.reliable ? null : <div className="deep-card-sub2">Low confidence: treat as a rough guess</div>;
              }
              if (pvKind === "model" && localPredict.modelVsPrev) {
                const pv = localPredict.modelVsPrev;
                if (typeof pv.backtestAcc === "number" && Number.isFinite(pv.backtestAcc)) {
                  const thPct = Math.round((pv.threshold ?? 0) * 100);
                  const note = pv.reliable ? "" : " · below confidence threshold";
                  return (
                    <div className="deep-card-sub2">{`Backtest reliability (score>=${thPct}%): ${Math.round(
                      pv.backtestAcc * 100
                    )}%${note}`}</div>
                  );
                }
                return pv.reliable ? null : <div className="deep-card-sub2">Low confidence: treat as a rough guess</div>;
              }
              return localPredict.proxyVsPrev?.matchRate ? (
                <div className="deep-card-sub2">{`Reliability (recent match rate): ${Math.round(
                  localPredict.proxyVsPrev.matchRate * 100
                )}%`}</div>
              ) : null;
            })()}
            {(() => {
              const a0 = parseNumber(selectionActual);
              const p0 = parseNumber(selectionPrevious);
              if (typeof a0 !== "number" || !Number.isFinite(a0)) return null;
              if (typeof p0 !== "number" || !Number.isFinite(p0)) return null;
              const epsRaw = (localPredict.recent?.vsPrev as any)?.eps ?? (localPredict.all?.vsPrev as any)?.eps ?? 0;
              const eps = typeof epsRaw === "number" && Number.isFinite(epsRaw) ? Math.max(0, epsRaw) : 0;
              const d = a0 - p0;
              const truth = Math.abs(d) <= eps ? "=" : d > 0 ? ">" : "<";
              const pred = (pvChoice as any)?.pred0 as ">" | "=" | "<" | undefined;
              if (!pred) return null;
              const ok = truth === pred;
              return (
                <div className="deep-card-sub2">
                  {`Released: ${truth} (Actual vs Previous) · ${ok ? "matched" : "did not match"} prediction · Unified Outlook uses Actual`}
                </div>
              );
            })()}
            {localPredict.all.vsPrev.n > 0 ? (
              <div className="deep-card-sub2">{`All history: N=${localPredict.all.vsPrev.n}`}</div>
            ) : null}
          </div>
          {pvChoice && localPredict.all.vsPrev.n > 0 ? (
            <div className="deep-card-tail">
              <div className="deep-tri" aria-hidden="true">
                <div
                  className="deep-tri-gt"
                  style={{
                    width: `${Math.round(
                      (((pvChoice as any)?.pGt ?? 0) ?? 0) * 100
                    )}%`
                  }}
                />
                <div
                  className="deep-tri-eq"
                  style={{
                    width: `${Math.round(
                      (((pvChoice as any)?.pEq ?? 0) ?? 0) * 100
                    )}%`
                  }}
                />
                <div
                  className="deep-tri-lt"
                  style={{
                    width: `${Math.round(
                      (((pvChoice as any)?.pLt ?? 0) ?? 0) * 100
                    )}%`
                  }}
                />
              </div>
              <div className="deep-tri-legend">
                <span
                  className={`deep-tri-chip gt${(pvChoice as any)?.pred0 === ">" ? " is-picked" : ""}`}
                >{`> ${fmtPctNum((pvChoice as any)?.pGt ?? null)}`}</span>
                <span
                  className={`deep-tri-chip eq${(pvChoice as any)?.pred0 === "=" ? " is-picked" : ""}`}
                >{`= ${fmtPctNum((pvChoice as any)?.pEq ?? null)}`}</span>
                <span
                  className={`deep-tri-chip lt${(pvChoice as any)?.pred0 === "<" ? " is-picked" : ""}`}
                >{`< ${fmtPctNum((pvChoice as any)?.pLt ?? null)}`}</span>
              </div>
            </div>
          ) : null}
        </div>

        <div className="deep-card">
          <div className="deep-card-k">Actual vs Forecast</div>
          {(() => {
            const f0 = parseNumber(selectionForecast);
            if (typeof f0 !== "number" || !Number.isFinite(f0)) return <div className="deep-card-v">--</div>;

            const afModel = localPredict.modelVsForecast;
            const hist = localPredict.recent.vsForecast;
            const afHist =
              hist?.n > 0
                ? (() => {
                    const pGt = typeof hist.pGt === "number" && Number.isFinite(hist.pGt) ? hist.pGt : 0;
                    const pEq = typeof hist.pEq === "number" && Number.isFinite(hist.pEq) ? hist.pEq : 0;
                    const pLt = typeof hist.pLt === "number" && Number.isFinite(hist.pLt) ? hist.pLt : 0;
                    const items: Array<[">" | "=" | "<", number]> = [
                      ["=", pEq],
                      [">", pGt],
                      ["<", pLt]
                    ];
                    items.sort((a, b) => (b[1] - a[1] !== 0 ? b[1] - a[1] : a[0].localeCompare(b[0])));
                    const pred0 = items[0]?.[0] ?? "=";
                    const sorted = [pEq, pGt, pLt].sort((a, b) => b - a);
                    const max1 = sorted[0] ?? 0;
                    const max2 = sorted[1] ?? 0;
                    const score = max1 * Math.max(0, max1 - max2);
                    const th = 0.12;
                    return {
                      source: "history" as const,
                      pred0,
                      conf: score,
                      threshold: th,
                      reliable: hist.n >= 12 && score >= th,
                      n: hist.n,
                      pEq,
                      pGt,
                      pLt
                    };
                  })()
                : null;

            const usingModel = Boolean(afModel && (afModel.reliable || !afHist));
            const af = usingModel ? afModel : afHist;
            const pred = (af?.pred0 ?? null) as ">" | "=" | "<" | null;
            const predProb =
              pred === ">"
                ? (af?.pGt ?? null)
                : pred === "="
                  ? (af?.pEq ?? null)
                  : pred === "<"
                    ? (af?.pLt ?? null)
                    : null;
            const fallbackProb = af ? Math.max(af.pGt ?? 0, af.pEq ?? 0, af.pLt ?? 0) : null;
            const shownProb = predProb ?? fallbackProb;
            const shownLabel =
              pred ??
              (af
                ? af.pGt >= (af.pEq ?? 0) && af.pGt >= (af.pLt ?? 0)
                  ? ">"
                  : (af.pEq ?? 0) >= (af.pLt ?? 0)
                    ? "="
                    : "<"
                : "");
            const isLowConfidence = Boolean(af && !af.reliable);
            return (
              <div className={`deep-card-v${isLowConfidence ? " is-low" : ""}`}>
                <span className="deep-card-v-main">{`${shownLabel} ${fmtPctNum(shownProb)}`}</span>
                {isLowConfidence ? (
                  <span className="deep-pill deep-pill--low" title="Below confidence threshold">
                    Low confidence
                  </span>
                ) : null}
              </div>
            );
          })()}
          <div className="deep-card-sub">
            <div>
              {(() => {
                const f0 = parseNumber(selectionForecast);
                if (typeof f0 !== "number" || !Number.isFinite(f0)) return "No forecast for this release";
                const afModel = localPredict.modelVsForecast;
                const hist = localPredict.recent.vsForecast;
                const hasHist = Boolean(hist?.n);
                if (afModel && (afModel.reliable || !hasHist)) {
                  const confPct = Math.round((afModel.conf ?? 0) * 100);
                  const thPct = Math.round((afModel.threshold ?? 0) * 100);
                  return `Calendar model (A-F): score=${confPct}% (th>=${thPct}%) · N=${afModel.n}`;
                }
                if (!hist?.n) return "No forecast history";
                return `History baseline (last ${localPredict.recentMonths}m): N=${hist.n}`;
              })()}
            </div>
            {(() => {
              const afModel = localPredict.modelVsForecast;
              const hist = localPredict.recent.vsForecast;
              const hasHist = Boolean(hist?.n);
              const af = afModel && (afModel.reliable || !hasHist) ? afModel : null;
              if (!af) return null;
              if (typeof af.backtestAcc === "number" && Number.isFinite(af.backtestAcc)) {
                const thPct = Math.round((af.threshold ?? 0) * 100);
                const note = af.reliable ? "" : " · below confidence threshold";
                return (
                  <div className="deep-card-sub2">{`Backtest reliability (score>=${thPct}%): ${Math.round(
                    af.backtestAcc * 100
                  )}%${note}`}</div>
                );
              }
              return af.reliable ? null : <div className="deep-card-sub2">Low confidence: treat as a rough guess</div>;
            })()}
            {localPredict.all.vsForecast.n > 0 ? (
              <div className="deep-card-sub2">{`All history: N=${localPredict.all.vsForecast.n}`}</div>
            ) : null}
          </div>
          {(() => {
            const f0 = parseNumber(selectionForecast);
            if (typeof f0 !== "number" || !Number.isFinite(f0)) return null;
            const afModel = localPredict.modelVsForecast;
            const hist = localPredict.recent.vsForecast;
            const hasHist = Boolean(hist?.n);
            const af =
              afModel && (afModel.reliable || !hasHist)
                ? afModel
                : hist?.n
                  ? {
                      pred0:
                        (hist.pGt ?? 0) >= (hist.pEq ?? 0) && (hist.pGt ?? 0) >= (hist.pLt ?? 0)
                          ? ">"
                          : (hist.pEq ?? 0) >= (hist.pLt ?? 0)
                            ? "="
                            : "<",
                      pGt: hist.pGt ?? 0,
                      pEq: hist.pEq ?? 0,
                      pLt: hist.pLt ?? 0
                    }
                  : null;
            if (!af || localPredict.all.vsForecast.n <= 0) return null;
            return (
              <div className="deep-card-tail">
                <div className="deep-tri" aria-hidden="true">
                  <div
                    className="deep-tri-gt"
                    style={{
                      width: `${Math.round((af.pGt ?? 0) * 100)}%`
                    }}
                  />
                  <div
                    className="deep-tri-eq"
                    style={{
                      width: `${Math.round((af.pEq ?? 0) * 100)}%`
                    }}
                  />
                  <div
                    className="deep-tri-lt"
                    style={{
                      width: `${Math.round((af.pLt ?? 0) * 100)}%`
                    }}
                  />
                </div>
                <div className="deep-tri-legend">
                  <span className={`deep-tri-chip gt${af.pred0 === ">" ? " is-picked" : ""}`}>{`> ${fmtPctNum(
                    af.pGt ?? null
                  )}`}</span>
                  <span className={`deep-tri-chip eq${af.pred0 === "=" ? " is-picked" : ""}`}>{`= ${fmtPctNum(
                    af.pEq ?? null
                  )}`}</span>
                  <span className={`deep-tri-chip lt${af.pred0 === "<" ? " is-picked" : ""}`}>{`< ${fmtPctNum(
                    af.pLt ?? null
                  )}`}</span>
                </div>
              </div>
            );
          })()}
        </div>
      </div>

      {(() => {
        return (
          <div className="deep-block-title deep-block-title--row">
            <span>Unified Outlook P(t)</span>
            {adjustedByActual ? (
              <span className="deep-pill deep-pill--adjusted" title="Adjusted using released Actual data">
                Adjusted
              </span>
            ) : null}
          </div>
        );
      })()}
      <div className="deep-outlook">
        {unifiedOutlook ? (
          <TradeBiasPanel
            unified={unifiedQuickRead}
            adjustedByActual={adjustedByActual}
            usedActualEvents={usedActualEvents}
            hasForecast={hasForecast0}
            pvReliable={pvReliable}
          />
        ) : null}

        {unifiedOutlook ? (
          <div className="deep-outlook-quick">
            <div className="deep-outlook-quick-title-row" title="Edge = |P(up) - 50%|. Small edges are usually noise.">
              <div className="deep-outlook-quick-title">Quick read</div>
            </div>
            {unifiedQuickRead.strong.length ? (
              <div className="deep-outlook-quick-row">
                {unifiedQuickRead.strong.map((it) => (
                  <div
                    key={it.key}
                    className={`deep-outlook-quick-item ${it.className}${
                      unifiedQuickRead.best?.key === it.key ? " is-picked" : ""
                    }`}
                  >
                    <span className="k">{it.label}</span>
                    <span className="v">{`${it.dir} ${fmtPctNum(it.prob)}`}</span>
                    <span className="e">{`edge ${it.edgePp}pp`}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="deep-outlook-quick-empty" title="P(up) is close to 50%, so there is no clear advantage.">
                No clear edge (P is close to 50%).
              </div>
            )}
          </div>
        ) : null}

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
              {unifiedOutlook.dPrior ? (
                <path
                  d={unifiedOutlook.dPrior}
                  className="deep-outlook-line deep-outlook-line--prior"
                  vectorEffect="non-scaling-stroke"
                />
              ) : null}
              <path
                d={unifiedOutlook.dMain}
                className="deep-outlook-line"
                vectorEffect="non-scaling-stroke"
              />
              {(() => {
                // Mark the selected "best" horizon on the curve so the number visually maps to the path.
                const best = unifiedQuickRead.best;
                if (!best) return null;
                const idx = unifiedOutlook.offsets.indexOf(best.minutes);
                if (idx < 0) return null;
                const p = unifiedOutlook.pUpSeries[idx];
                if (typeof p !== "number" || !Number.isFinite(p)) return null;
                const denom = Math.max(1, unifiedOutlook.offsets.length - 1);
                const innerW = unifiedOutlook.w - unifiedOutlook.pad.l - unifiedOutlook.pad.r;
                const innerH = unifiedOutlook.h - unifiedOutlook.pad.t - unifiedOutlook.pad.b;
                const x = unifiedOutlook.pad.l + (idx / denom) * innerW;
                const y = unifiedOutlook.pad.t + (1 - Math.max(0, Math.min(1, p))) * innerH;
                const label = `P(up) ${Math.round(p * 100)}%`;
                const placeBelow = y < unifiedOutlook.pad.t + 14;
                const ty = placeBelow ? y + 16 : y - 10;
                return (
                  <g className="deep-outlook-marker">
                    <circle
                      cx={x}
                      cy={y}
                      r={4.2}
                      className="deep-outlook-marker-dot"
                      vectorEffect="non-scaling-stroke"
                    />
                    <text
                      x={x}
                      y={ty}
                      textAnchor="middle"
                      className="deep-outlook-marker-label"
                    >
                      {label}
                    </text>
                  </g>
                );
              })()}
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
              {typeof unifiedOutlook.x0 === "number" && unifiedOutlook.anchorLabel ? (
                <text
                  x={Math.round(unifiedOutlook.x0)}
                  y={unifiedOutlook.h - 10}
                  textAnchor="middle"
                  className="deep-outlook-axis"
                >
                  {unifiedOutlook.anchorLabel}
                </text>
              ) : null}
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
          {(() => {
            return (
              <>
                One main path P(t) is shown. It is computed from the scheduled +/-24h window (using the impact model),
                and it updates as nearby events release Actuals.
                {adjustedByActual ? (
                  <span className="deep-outlook-note-strong">
                    {" "}
                    Adjusted using released Actuals
                    {typeof usedActualEvents === "number" ? ` (${usedActualEvents} events)` : ""}.
                  </span>
                ) : (
                  <span className="deep-outlook-note-strong"> Forecast-only (no released Actuals in-window yet).</span>
                )}
                {asOfUtcLabel ? <span className="deep-outlook-note-sub">{` As of ${asOfUtcLabel}.`}</span> : null}
              </>
            );
          })()}
        </div>
        {unifiedOutlook?.hasPrior ? (
          <div className="deep-outlook-actions">
            <button
              type="button"
              className="deep-help-btn"
              disabled={Boolean(highlightId)}
              onClick={() => setShowUnifiedPrior((v) => !v)}
              title={highlightId ? "Clear the selected contribution to compare forecast-only vs adjusted" : undefined}
            >
              {showUnifiedPrior ? "Hide forecast-only" : "Compare: forecast-only"}
            </button>
          </div>
        ) : null}

        {(() => {
          const pm = data.predictMarket ?? null;
          const contribs = Array.isArray(pm?.contributions) ? pm.contributions : [];
          if (contribs.length === 0) {
            return (
              <div className="deep-muted" style={{ marginTop: 8 }}>
                No nearby-event contributions found in the +/-24h window.
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
                      onClick={() => setHighlightId((prev) => (prev === c.eventId ? null : c.eventId))}
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

      <DeepSignalsPanel signals={(data as any)?.signals} />

      <div className="deep-block-title">Evidence</div>
      <div className="deep-evidence">
        <div className="deep-evidence-row">
          <span className="deep-evidence-k">History points</span>
          <span className="deep-evidence-v">{points.length}</span>
        </div>
        <div className="deep-evidence-row">
          <span className="deep-evidence-k">Model</span>
          <span className="deep-evidence-v">
            {isFallback ? "Fallback model" : "Deep JSON model"}
          </span>
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

      {!isFallback ? null : (
        <div className="deep-muted" style={{ marginTop: 10 }}>
          Deep JSON is not available for this event yet. Showing a fallback unified outlook from the scheduled window.
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

        <DeepAnalysisMethodModal
          open={methodOpen}
          onClose={() => setMethodOpen(false)}
          pointsCount={points.length}
          modelLabel={isFallback ? "Fallback model" : "Deep JSON model"}
          signalsUsed={Array.isArray(data.signalsUsed) ? data.signalsUsed : null}
        />

        {fullOpen ? null : <div className="deep-panel-scroll">{content}</div>}
      </div>
    </div>
  );
}
