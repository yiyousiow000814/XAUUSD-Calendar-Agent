import { useEffect, useMemo, useState } from "react";
import type { EventDeepAnalysisResponse, EventHistoryPoint, EventImpactWindowStats } from "../../types";
import { formatTimeOffsetMinutes } from "../../utils/calendarTime";
import { DeepAnalysisMethodModal } from "./DeepAnalysisMethodModal";
import "./DeepAnalysisView.css";

type ImpactSeriesItem = { offset: number; stats?: EventImpactWindowStats };

type DeepAnalysisViewProps = {
  points: EventHistoryPoint[];
  isUsdEvent: boolean;
  deepLoading: boolean;
  deepError: string | null;
  deepData: EventDeepAnalysisResponse | null;
  impactSeriesItems: ImpactSeriesItem[];
  // UTC time for the selected release instance (the center of the +/-24h unified window).
  anchorDtUtc: string;
  // Display offset minutes (calendar timezone), used to show the anchor time label without leaking local timezone.
  displayOffsetMinutes: number;
  // Values for the selected release instance (from the calendar list). These allow conditional predictions.
  selectionActual?: string;
  selectionForecast?: string;
  selectionPrevious?: string;
};

export function DeepAnalysisView({
  points,
  isUsdEvent,
  deepLoading,
  deepError,
  deepData,
  impactSeriesItems,
  anchorDtUtc,
  displayOffsetMinutes,
  selectionActual,
  selectionForecast,
  selectionPrevious
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

  const fmtPctNum = (p: number | null) =>
    typeof p === "number" && Number.isFinite(p) ? `${Math.round(p * 100)}%` : "--";

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
    return `${dd}-${mm} ${hh}:${min}`;
  }, [anchorDtUtc, displayOffsetMinutes]);

  const localPredict = useMemo(() => {
    const EQ_FACTOR = 0.05; // Wider "approx equal" than strict matching; tuned for calendar numeric noise.
    const parsePointUtcMs = (p: EventHistoryPoint): number | null => {
      const d = String(p.date ?? "").trim();
      const t = String(p.time ?? "").trim();
      if (!d) return null;
      const tt = t || "00:00";
      // Support dd-mm-yyyy (repo default) and yyyy-mm-dd.
      const m1 = d.match(/^(\d{2})-(\d{2})-(\d{4})$/);
      const m2 = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      const h = Number(tt.split(":")[0] ?? 0);
      const min = Number(tt.split(":")[1] ?? 0);
      if (m1) {
        const dd = Number(m1[1]);
        const mm = Number(m1[2]);
        const yy = Number(m1[3]);
        const ms = Date.UTC(yy, mm - 1, dd, h, min, 0, 0);
        return Number.isFinite(ms) ? ms : null;
      }
      if (m2) {
        const yy = Number(m2[1]);
        const mm = Number(m2[2]);
        const dd = Number(m2[3]);
        const ms = Date.UTC(yy, mm - 1, dd, h, min, 0, 0);
        return Number.isFinite(ms) ? ms : null;
      }
      // Last resort: let Date.parse try.
      const ms = Date.parse(`${d} ${tt}`);
      return Number.isFinite(ms) ? ms : null;
    };

    const anchorMs = Date.parse(String(anchorDtUtc || "").trim());
    const refMs = Number.isFinite(anchorMs) ? Math.min(anchorMs, Date.now()) : Date.now();

    const rows = points
      .map((p) => ({
        ms: parsePointUtcMs(p),
        a: parseNumber(p.actualRaw ?? p.actual),
        f: parseNumber(p.forecast),
        prev: parseNumber(p.previousRaw ?? p.previous)
      }))
      .filter((r) => r.ms !== null && typeof r.a === "number" && Number.isFinite(r.a as number))
      .map((r) => ({ ...r, ms: r.ms as number }))
      .filter((r) => r.ms <= refMs)
      .sort((x, y) => x.ms - y.ms);

    const monthStartMsFor = (ref: number, months: number) => {
      const d = new Date(ref);
      d.setUTCMonth(d.getUTCMonth() - Math.max(0, Math.min(6, months)));
      return d.getTime();
    };

    const subsetMonths = (months: number, ref: number) => {
      const start = monthStartMsFor(ref, months);
      return rows.filter((r) => r.ms >= start && r.ms < ref);
    };

    const median = (arr: number[]) => {
      if (!arr.length) return 0;
      const s = [...arr].sort((a, b) => a - b);
      const mid = (s.length - 1) / 2;
      const lo = s[Math.floor(mid)] ?? 0;
      const hi = s[Math.ceil(mid)] ?? 0;
      return (lo + hi) / 2;
    };

    const build3way = (sub: typeof rows, kind: "forecast" | "prev") => {
      const diffs: number[] = [];
      for (const r of sub) {
        const a = r.a as number;
        const b = kind === "forecast" ? r.f : r.prev;
        if (typeof b !== "number" || !Number.isFinite(b)) continue;
        diffs.push(Math.abs(a - b));
      }
      // "Approx equal": dynamic tolerance based on typical surprise magnitude in the chosen window.
      const med = median(diffs);
      const eps = Math.max(1e-9, med * EQ_FACTOR);

      let n = 0;
      let gt = 0;
      let eq = 0;
      let lt = 0;
      for (const r of sub) {
        const a = r.a as number;
        const b = kind === "forecast" ? r.f : r.prev;
        if (typeof b !== "number" || !Number.isFinite(b)) continue;
        const d = a - b;
        n += 1;
        if (Math.abs(d) <= eps) eq += 1;
        else if (d > 0) gt += 1;
        else lt += 1;
      }
      const pGt = n > 0 ? gt / n : null;
      const pEq = n > 0 ? eq / n : null;
      const pLt = n > 0 ? lt / n : null;
      return { n, pGt, pEq, pLt, eps };
    };

    const argmax3 = (pGt: number, pEq: number, pLt: number) => {
      // Prefer "=" in ties (usually safer), then ">".
      const items: Array<[">" | "=" | "<", number]> = [
        ["=", pEq],
        [">", pGt],
        ["<", pLt]
      ];
      items.sort((a, b) => (b[1] - a[1] !== 0 ? b[1] - a[1] : a[0].localeCompare(b[0])));
      return items[0][0];
    };

    const truthLabel = (a: number, b: number, eps: number) => {
      const d = a - b;
      if (Math.abs(d) <= eps) return "=";
      return d > 0 ? ">" : "<";
    };

    const pickBestMonths = (kind: "forecast" | "prev") => {
      const hasAny = kind === "forecast" ? rows.some((r) => typeof r.f === "number") : rows.some((r) => typeof r.prev === "number");
      if (!hasAny) return 6;

      const candidates = [1, 2, 3, 4, 5, 6];
      let bestM = 6;
      let bestAcc = -1;

      // Backtest on the most recent releases first to reduce old-regime influence.
      const evalRows = rows
        .filter((r) => {
          const b = kind === "forecast" ? r.f : r.prev;
          return typeof r.a === "number" && Number.isFinite(r.a) && typeof b === "number" && Number.isFinite(b);
        })
        .slice(-36); // last ~36 releases is enough for a stable choice

      for (const m of candidates) {
        let correct = 0;
        let total = 0;
        for (let i = 0; i < evalRows.length; i += 1) {
          const ref = evalRows[i]!.ms;
          const hist = subsetMonths(m, ref);
          const stats = build3way(hist, kind);
          if (stats.n < 8) continue; // avoid tiny windows dominating by noise
          const pGt = stats.pGt ?? 0;
          const pEq = stats.pEq ?? 0;
          const pLt = stats.pLt ?? 0;
          const pred = argmax3(pGt, pEq, pLt);
          const a = evalRows[i]!.a as number;
          const b = (kind === "forecast" ? evalRows[i]!.f : evalRows[i]!.prev) as number;
          const truth = truthLabel(a, b, stats.eps);
          total += 1;
          if (pred === truth) correct += 1;
        }
        if (total < 8) continue;
        const acc = correct / total;
        // Prefer smaller m on ties (more reactive).
        if (acc > bestAcc + 1e-9 || (Math.abs(acc - bestAcc) <= 1e-9 && m < bestM)) {
          bestAcc = acc;
          bestM = m;
        }
      }
      return bestM;
    };

    const buildPredict = (sub: typeof rows) => ({
      vsForecast: build3way(sub, "forecast"),
      vsPrev: build3way(sub, "prev")
    });

    const all = buildPredict(rows);

    const bestF = pickBestMonths("forecast");
    const bestP = pickBestMonths("prev");
    // Pick one window months for display (single decision): favor Forecast if available, else Previous.
    const recentMonths = all.vsForecast.n > 0 ? bestF : bestP;

    const recentRows = subsetMonths(recentMonths, refMs);
    const recent = buildPredict(recentRows);

    // Conditional predictor for Actual vs Previous using the direction of (Forecast - Previous) for the selected release.
    const f0 = parseNumber(selectionForecast);
    const p0 = parseNumber(selectionPrevious);

    const label3 = (d: number, eps: number) => (Math.abs(d) <= eps ? 0 : d > 0 ? 1 : -1);

    const linregForecastHat = (series: number[]) => {
      // 6-point trend model is intentionally short/higher-reactivity; it backtests better for vsPrevious.
      if (series.length < 6) return null;
      const y = series.slice(-6);
      const n = y.length;
      let sumX = 0;
      let sumY = 0;
      let sumXX = 0;
      let sumXY = 0;
      for (let i = 0; i < n; i += 1) {
        const x = i;
        const yy = y[i] as number;
        sumX += x;
        sumY += yy;
        sumXX += x * x;
        sumXY += x * yy;
      }
      const denom = n * sumXX - sumX * sumX;
      if (!denom) return null;
      const slope = (n * sumXY - sumX * sumY) / denom;
      const intercept = (sumY - slope * sumX) / n;
      // predict next point at x=n
      return slope * n + intercept;
    };

    const buildProxyVsPrev = () => {
      // Use a fixed per-metric tolerance for "approx equal" (mirrors the offline evaluation script):
      // eps = median(|Actual-Previous|) * EQ_FACTOR
      const apDiffs: number[] = [];
      for (const r of rows) {
        if (typeof r.a !== "number" || typeof r.prev !== "number") continue;
        apDiffs.push(Math.abs(r.a - r.prev));
      }
      const eps = Math.max(1e-9, median(apDiffs) * EQ_FACTOR);
      if (eps <= 0) return null;

      // Proxy for the *selected* release instance.
      let proxy0: number | null = null;
      let proxyLabel = "";
      if (typeof p0 === "number" && Number.isFinite(p0)) {
        if (typeof f0 === "number" && Number.isFinite(f0)) {
          proxy0 = f0;
          proxyLabel = "Forecast";
        } else {
          const actualSeries = rows
            .filter((r) => typeof r.a === "number" && Number.isFinite(r.a))
            .map((r) => r.a as number);
          const hat = linregForecastHat(actualSeries);
          if (typeof hat === "number" && Number.isFinite(hat)) {
            proxy0 = hat;
            proxyLabel = "Model";
          }
        }
      }
      if (proxy0 === null || typeof p0 !== "number") return null;

      const pred0 = label3(proxy0 - p0, eps);

      // Backtest the proxy rule on recent history (no leakage):
      // for each point i, if Forecast missing, compute Model from past actuals only.
      let nAll = 0;
      let matchAll = 0;
      let gtAll = 0;
      let eqAll = 0;
      let ltAll = 0;

      let nCond = 0;
      let gtCond = 0;
      let eqCond = 0;
      let ltCond = 0;
      let matchCond = 0;

      const histActualSeries: number[] = [];
      for (const r of rows) {
        if (typeof r.a !== "number" || typeof r.prev !== "number") {
          if (typeof r.a === "number" && Number.isFinite(r.a)) histActualSeries.push(r.a);
          continue;
        }

        const proxy = (() => {
          if (typeof r.f === "number" && Number.isFinite(r.f)) return r.f;
          const hat = linregForecastHat(histActualSeries);
          return typeof hat === "number" && Number.isFinite(hat) ? hat : null;
        })();

        // Update actual series after building proxy (so the model never sees current actual).
        if (typeof r.a === "number" && Number.isFinite(r.a)) histActualSeries.push(r.a);

        if (proxy === null) continue;

        const truth = label3(r.a - r.prev, eps);
        const pred = label3(proxy - r.prev, eps);

        nAll += 1;
        if (truth === 1) gtAll += 1;
        else if (truth === 0) eqAll += 1;
        else ltAll += 1;
        if (truth === pred) matchAll += 1;

        if (pred === pred0) {
          nCond += 1;
          if (truth === 1) gtCond += 1;
          else if (truth === 0) eqCond += 1;
          else ltCond += 1;
          if (truth === pred) matchCond += 1;
        }
      }

      if (nAll < 12) return null;

      const useCond = nCond >= 8;
      const n = useCond ? nCond : nAll;
      const pGt = useCond ? gtCond / nCond : gtAll / nAll;
      const pEq = useCond ? eqCond / nCond : eqAll / nAll;
      const pLt = useCond ? ltCond / nCond : ltAll / nAll;

      return {
        pred0,
        n,
        pGt,
        pEq,
        pLt,
        matchRate: matchAll / nAll,
        proxyLabel,
        conditioned: useCond
      };
    };

    const proxyVsPrev = buildProxyVsPrev();

    return { recentMonths, recent, all, proxyVsPrev };
  }, [points, anchorDtUtc, selectionActual, selectionForecast, selectionPrevious]);

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
      lastLabel: typeof lastOffset === "number" ? formatTimeOffsetMinutes(lastOffset) : "",
      anchorLabel
    };
  }, [deepData, highlightId, impactSeriesItems, anchorLabel]);

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

  const content = (
    <>
      <div className="deep-block-title">Predict Release</div>
      <div className="deep-grid">
        <div className="deep-card">
          <div className="deep-card-k">Actual vs Previous</div>
          {(() => {
            const pv = localPredict.proxyVsPrev;
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
            const shownLabel = pred ?? (pv ? (pv.pGt >= (pv.pEq ?? 0) && pv.pGt >= (pv.pLt ?? 0) ? ">" : (pv.pEq ?? 0) >= (pv.pLt ?? 0) ? "=" : "<") : "");
            return <div className="deep-card-v">{`${shownLabel} ${fmtPctNum(shownProb)}`}</div>;
          })()}
          <div className="deep-card-sub">
            <div>
              {localPredict.proxyVsPrev?.n
                ? `${localPredict.proxyVsPrev.conditioned ? "Conditioned on " : "Based on "}${localPredict.proxyVsPrev.proxyLabel} - Previous: N=${localPredict.proxyVsPrev.n}`
                : "No previous history"}
            </div>
            {localPredict.proxyVsPrev?.matchRate ? (
              <div className="deep-card-sub2">{`Reliability (recent match rate): ${Math.round(
                localPredict.proxyVsPrev.matchRate * 100
              )}%`}</div>
            ) : null}
            {localPredict.all.vsPrev.n > 0 ? (
              <div className="deep-card-sub2">{`All history: N=${localPredict.all.vsPrev.n}`}</div>
            ) : null}
          </div>
          {(localPredict.proxyVsPrev?.n ?? 0) > 0 ? (
            <>
              <div className="deep-tri" aria-hidden="true">
                <div
                  className="deep-tri-gt"
                  style={{
                    width: `${Math.round(((localPredict.proxyVsPrev?.pGt ?? 0) ?? 0) * 100)}%`
                  }}
                />
                <div
                  className="deep-tri-eq"
                  style={{
                    width: `${Math.round(((localPredict.proxyVsPrev?.pEq ?? 0) ?? 0) * 100)}%`
                  }}
                />
                <div
                  className="deep-tri-lt"
                  style={{
                    width: `${Math.round(((localPredict.proxyVsPrev?.pLt ?? 0) ?? 0) * 100)}%`
                  }}
                />
              </div>
              <div className="deep-tri-legend">
                <span
                  className={`deep-tri-chip gt${localPredict.proxyVsPrev?.pred0 === ">" ? " is-picked" : ""}`}
                >{`> ${fmtPctNum(localPredict.proxyVsPrev?.pGt ?? null)}`}</span>
                <span
                  className={`deep-tri-chip eq${localPredict.proxyVsPrev?.pred0 === "=" ? " is-picked" : ""}`}
                >{`= ${fmtPctNum(localPredict.proxyVsPrev?.pEq ?? null)}`}</span>
                <span
                  className={`deep-tri-chip lt${localPredict.proxyVsPrev?.pred0 === "<" ? " is-picked" : ""}`}
                >{`< ${fmtPctNum(localPredict.proxyVsPrev?.pLt ?? null)}`}</span>
              </div>
            </>
          ) : null}
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
          One main path P(t) is shown. When deep JSON is available, nearby events contribute weighted deltas to this
          path; clicking an event highlights its local contribution without switching to a different direction.
        </div>

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

        <div className="deep-panel-scroll">{content}</div>
      </div>
    </div>
  );
}
