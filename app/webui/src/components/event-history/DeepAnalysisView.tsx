import { useEffect, useMemo, useRef, useState } from "react";
import type { EventDeepAnalysisResponse, EventHistoryPoint, EventImpactWindowStats } from "../../types";
import { backend } from "../../api";
import { formatTimeOffsetMinutes, parseDisplayTimeToUtcMs } from "../../utils/calendarTime";
import {
  DEFAULT_PREDICT_RELEASE_MODEL_USD,
  dotFeatures,
  estimateBacktestAccAtThreshold,
  softmax1d
} from "../../utils/predictReleaseModel";
import { DeepAnalysisMethodModal } from "./DeepAnalysisMethodModal";
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
  selectionActual,
  selectionForecast,
  selectionPrevious
}: DeepAnalysisViewProps) {
  const [methodOpen, setMethodOpen] = useState(false);
  const [fullOpen, setFullOpen] = useState(false);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [showUnifiedPrior, setShowUnifiedPrior] = useState(false);
  const [predictModel, setPredictModel] = useState<any>(DEFAULT_PREDICT_RELEASE_MODEL_USD);
  const zApCacheRef = useRef(new Map<string, { series: Array<{ ms: number; z: number }> }>());
  const [nowcastVsPrev, setNowcastVsPrev] = useState<{
    pred0: ">" | "=" | "<";
    conf: number;
    threshold: number;
    reliable: boolean;
    sourcesUsed: number;
    pEq: number;
    pGt: number;
    pLt: number;
    backtestAcc?: number;
  } | null>(null);

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
    const m = cleaned.match(/^([+-]?\d+(?:\.\d+)?)([kmbt])?$/i);
    if (!m) return null;
    const base = Number(m[1]);
    if (!Number.isFinite(base)) return null;
    const suf = (m[2] || "").toLowerCase();
    if (suf === "k") return base * 1_000;
    if (suf === "m") return base * 1_000_000;
    if (suf === "b") return base * 1_000_000_000;
    if (suf === "t") return base * 1_000_000_000_000;
    return base;
  };

  const median = (arr: number[]) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const mid = (s.length - 1) / 2;
    const lo = s[Math.floor(mid)] ?? 0;
    const hi = s[Math.ceil(mid)] ?? 0;
    return (lo + hi) / 2;
  };

  const labelZ = (z: number, eqFactor: number) => {
    if (!Number.isFinite(z)) return 0;
    if (Math.abs(z) <= eqFactor) return 0;
    return z > 0 ? 1 : 2; // 0="=", 1=">", 2="<"
  };

  const fmtPct = (p: number | null | undefined) =>
    typeof p === "number" && Number.isFinite(p) ? `${Math.round(p * 100)}%` : "--";
  const fmtP = (p?: number) =>
    typeof p === "number" && Number.isFinite(p) ? `${Math.round(p * 100)}%` : "--";
  const fmtN = (n?: number) => (typeof n === "number" && Number.isFinite(n) ? `N=${n}` : "N=--");

  const fmtPctNum = (p: number | null) => {
    if (typeof p !== "number" || !Number.isFinite(p)) return "--";
    if (p > 0 && p < 0.01) return "<1%";
    return `${Math.round(p * 100)}%`;
  };

  const fmtUtcShort = (raw: string) => {
    const ms = Date.parse(String(raw || "").trim());
    if (!Number.isFinite(ms)) return "";
    const d = new Date(ms);
    const pad = (v: number) => String(v).padStart(2, "0");
    const dd = pad(d.getUTCDate());
    const mm = pad(d.getUTCMonth() + 1);
    const hh = pad(d.getUTCHours());
    const min = pad(d.getUTCMinutes());
    return `${dd}-${mm} ${hh}:${min} UTC`;
  };

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

  useEffect(() => {
    const metric = String(metricKey || "").trim();
    const curCode = String(cur || "").trim().toUpperCase();
    const anchorMsRaw = Date.parse(String(anchorDtUtc || "").trim());
    const refMs = Number.isFinite(anchorMsRaw) ? Math.min(anchorMsRaw, Date.now()) : Date.now();

    const f0 = parseNumber(selectionForecast);
    const p0 = parseNumber(selectionPrevious);
    const hasForecast0 =
      typeof f0 === "number" &&
      Number.isFinite(f0) &&
      typeof p0 === "number" &&
      Number.isFinite(p0);

    // Only for USD no-forecast selections (this predictor is trained for USD history).
    if (!isUsdEvent || hasForecast0 || !metric || curCode !== "USD") {
      setNowcastVsPrev(null);
      return;
    }

    const model: any = predictModel;
    const eqFactor =
      typeof model?.meta?.eq_factor === "number" && Number.isFinite(model.meta.eq_factor)
        ? Number(model.meta.eq_factor)
        : 0.10;

    const relRoot = model?.models?.ap_no_forecast?.relationships;
    const predictor = relRoot?.predictor ?? null;
    const enabled = predictor?.enabled_metrics?.[metric] ?? null;
    const rels: Array<{ metric: string; corr: number }> = Array.isArray(relRoot?.by_metric?.[metric])
      ? relRoot.by_metric[metric]
      : [];
    if (!enabled || !rels.length) {
      setNowcastVsPrev(null);
      return;
    }

    const recommendedTh =
      typeof predictor?.recommended_threshold === "number" && Number.isFinite(predictor.recommended_threshold)
        ? Number(predictor.recommended_threshold)
        : 0.10;
    const metricTh =
      typeof enabled?.th === "number" && Number.isFinite(enabled.th)
        ? Number(enabled.th)
        : recommendedTh;
    const recentDays =
      typeof model?.meta?.relationships?.recent_days === "number" && Number.isFinite(model.meta.relationships.recent_days)
        ? Number(model.meta.relationships.recent_days)
        : 180;
    const recentMs = Math.max(1, recentDays) * 86_400_000;

    const parsePointUtcMs = (p: EventHistoryPoint): number | null => {
      const dRaw = String(p.date ?? "").trim();
      const tRaw = String(p.time ?? "").trim();
      if (!dRaw) return null;
      const tt = tRaw || "00:00";
      const m1 = dRaw.match(/^(\d{2})-(\d{2})-(\d{4})$/);
      const dateIso = m1 ? `${m1[3]}-${m1[2]}-${m1[1]}` : dRaw;
      const ms = parseDisplayTimeToUtcMs(dateIso, tt, Number(displayOffsetMinutes) || 0);
      return typeof ms === "number" && Number.isFinite(ms) ? ms : null;
    };

    const buildZApSeries = async (mKey: string, kind: "ap" | "af") => {
      const cacheKey = `${kind}:${mKey}`;
      const cached = zApCacheRef.current.get(cacheKey);
      if (cached) return cached;
      const res = await backend.getEventHistory({ event: mKey, cur: curCode });
      if (!res?.ok || !Array.isArray(res.points)) return null;

      const rows = res.points
        .map((p: EventHistoryPoint) => {
          const ms = parsePointUtcMs(p);
          const a = parseNumber(p.actualRaw ?? p.actual);
          const b =
            kind === "af"
              ? parseNumber(p.forecast)
              : parseNumber(p.previousRaw ?? p.previous);
          if (ms === null || typeof a !== "number" || typeof b !== "number") return null;
          if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
          return { ms, diff: a - b };
        })
        .filter((r): r is { ms: number; diff: number } => Boolean(r))
        .sort((x, y) => x.ms - y.ms);

      if (rows.length < 12) return null;
      const scale = Math.max(1e-9, median(rows.map((r) => Math.abs(r.diff))));
      const series = rows.map((r) => ({ ms: r.ms, z: r.diff / scale }));
      const built = { series };
      zApCacheRef.current.set(cacheKey, built);
      return built;
    };

    let alive = true;
    (async () => {
      let vEq = 0;
      let vGt = 0;
      let vLt = 0;
      let used = 0;
      const candidates = rels
        .map((it) => ({
          srcKey: String(it?.metric || "").trim(),
          kind: String((it as any)?.kind || "ap")
            .trim()
            .toLowerCase(),
          corr: Number(it?.corr ?? 0)
        }))
        .filter(
          (it) =>
            it.srcKey &&
            (it.kind === "ap" || it.kind === "af") &&
            Number.isFinite(it.corr) &&
            Math.abs(it.corr) > 1e-12
        );
      const seriesList = await Promise.all(
        candidates.map((it) => buildZApSeries(it.srcKey, it.kind as "ap" | "af"))
      );

      for (let idx = 0; idx < candidates.length; idx += 1) {
        const { srcKey, corr } = candidates[idx]!;
        const src = seriesList[idx];
        if (!src) continue;
        const series = src.series;
        let j = series.length - 1;
        while (j >= 0) {
          const ms = series[j]!.ms;
          if (ms < refMs && refMs - ms <= recentMs) break;
          j -= 1;
        }
        if (j < 0) continue;
        const z = series[j]!.z;
        let lab = labelZ(z, eqFactor); // 0="=", 1=">", 2="<"
        if (lab === 1 && corr < 0) lab = 2;
        else if (lab === 2 && corr < 0) lab = 1;
        const w = Math.abs(corr) * Math.min(3, Math.abs(z));
        if (!Number.isFinite(w) || w <= 0) continue;
        used += 1;
        if (lab === 0) vEq += w;
        else if (lab === 1) vGt += w;
        else vLt += w;
      }

      if (!alive) return;
      const sum = vEq + vGt + vLt;
      if (!(sum > 0) || used <= 0) {
        setNowcastVsPrev(null);
        return;
      }
      const pEq = vEq / sum;
      const pGt = vGt / sum;
      const pLt = vLt / sum;
      const probs = [pEq, pGt, pLt];
      const idx = probs.reduce((best, v, i) => (v > (probs[best] ?? 0) ? i : best), 0);
      const pred0 = (idx === 1 ? ">" : idx === 2 ? "<" : "=") as ">" | "=" | "<";
      const sorted = [...probs].sort((a, b) => b - a);
      const max1 = sorted[0] ?? 0;
      const max2 = sorted[1] ?? 0;
      const score = max1 * Math.max(0, max1 - max2);
      const backtestAcc =
        typeof enabled?.acc === "number" && Number.isFinite(enabled.acc) ? Number(enabled.acc) : undefined;

      setNowcastVsPrev({
        pred0,
        conf: score,
        threshold: metricTh,
        reliable: score >= metricTh,
        sourcesUsed: used,
        pEq,
        pGt,
        pLt,
        backtestAcc
      });
    })().catch(() => {
      if (alive) setNowcastVsPrev(null);
    });

    return () => {
      alive = false;
    };
  }, [
    anchorDtUtc,
    cur,
    displayOffsetMinutes,
    isUsdEvent,
    metricKey,
    predictModel,
    selectionForecast,
    selectionPrevious
  ]);

  const localPredict = useMemo(() => {
    const EQ_FACTOR = 0.05; // Wider "approx equal" than strict matching; tuned for calendar numeric noise.
    const parsePointUtcMs = (p: EventHistoryPoint): number | null => {
      const dRaw = String(p.date ?? "").trim();
      const tRaw = String(p.time ?? "").trim();
      if (!dRaw) return null;
      const tt = tRaw || "00:00";
      // Support dd-mm-yyyy (repo default) and yyyy-mm-dd.
      const m1 = dRaw.match(/^(\d{2})-(\d{2})-(\d{4})$/);
      const dateIso = m1 ? `${m1[3]}-${m1[2]}-${m1[1]}` : dRaw;
      const ms = parseDisplayTimeToUtcMs(dateIso, tt, Number(displayOffsetMinutes) || 0);
      return typeof ms === "number" && Number.isFinite(ms) ? ms : null;
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
    const label3Sym = (d: number, eps: number) => (Math.abs(d) <= eps ? "=" : d > 0 ? ">" : "<");

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

      const pred0 = label3Sym(proxy0 - p0, eps);

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

        if (label3Sym(proxy - r.prev, eps) === pred0) {
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
      // Light smoothing to avoid hard 0% when one bucket is absent in a small sample.
      const alpha = 0.35;
      const cGt = (useCond ? gtCond : gtAll) + alpha;
      const cEq = (useCond ? eqCond : eqAll) + alpha;
      const cLt = (useCond ? ltCond : ltAll) + alpha;
      const denom = cGt + cEq + cLt;
      const pGt = cGt / denom;
      const pEq = cEq / denom;
      const pLt = cLt / denom;

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

    const buildModelVsPrev = () => {
      const model: any = predictModel;
      const classes: string[] = Array.isArray(model?.classes) ? model.classes : ["=", ">", "<"];
      const sub: any = (typeof f0 === "number" && Number.isFinite(f0))
        ? model?.models?.ap_with_forecast
        : model?.models?.ap_no_forecast;
      const weights: number[][] = Array.isArray(sub?.weights) ? sub.weights : [];
      if (weights.length < 2) return null;

      const diffsAp = rows
        .filter(
          (r) =>
            typeof r.a === "number" &&
            Number.isFinite(r.a) &&
            typeof r.prev === "number" &&
            Number.isFinite(r.prev)
        )
        .map((r) => (r.a as number) - (r.prev as number));
      if (diffsAp.length < 12) return null;
      const scaleAp = Math.max(1e-9, median(diffsAp.map((v) => Math.abs(v))));

      const actualSeries = rows
        .filter((r) => typeof r.a === "number" && Number.isFinite(r.a))
        .map((r) => r.a as number);
      if (actualSeries.length < 12) return null;
      const medianCenter = median(actualSeries);
      const mad = median(actualSeries.map((v) => Math.abs(v - medianCenter)));
      const madA = Math.max(1e-9, mad);

      const diffsFp = rows
        .filter(
          (r) =>
            typeof r.f === "number" &&
            Number.isFinite(r.f) &&
            typeof r.prev === "number" &&
            Number.isFinite(r.prev)
        )
        .map((r) => (r.f as number) - (r.prev as number));
      const scaleFp = Math.max(1e-9, median(diffsFp.map((v) => Math.abs(v))));

      const diffsAf = rows
        .filter((r) => typeof r.a === "number" && Number.isFinite(r.a) && typeof r.f === "number" && Number.isFinite(r.f))
        .map((r) => (r.a as number) - (r.f as number));
      const scaleAf = Math.max(1e-9, median(diffsAf.map((v) => Math.abs(v))));

      const lastDiffs6 = diffsAp.slice(-6);
      const lastDiffs3 = diffsAp.slice(-3);
      const lastA6 = actualSeries.slice(-6);
      const lastA = actualSeries[actualSeries.length - 1] as number;

      const zAp1 = (lastDiffs6[lastDiffs6.length - 1] as number) / scaleAp;
      const zAp3 = (lastDiffs3.reduce((a, b) => a + b, 0) / Math.max(1, lastDiffs3.length)) / scaleAp;
      const zAp6 = (lastDiffs6.reduce((a, b) => a + b, 0) / Math.max(1, lastDiffs6.length)) / scaleAp;
      const zALevel = (lastA - medianCenter) / madA;

      const slope6 = (() => {
        if (lastA6.length < 2) return 0;
        const n = lastA6.length;
        let sumX = 0;
        let sumY = 0;
        let sumXX = 0;
        let sumXY = 0;
        for (let i = 0; i < n; i += 1) {
          const x = i;
          const y = lastA6[i] as number;
          sumX += x;
          sumY += y;
          sumXX += x * x;
          sumXY += x * y;
        }
        const denom = n * sumXX - sumX * sumX;
        if (!denom) return 0;
        return (n * sumXY - sumX * sumY) / denom;
      })();
      const zASlope6 = slope6 / scaleAp;

      const zAf1 = (() => {
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          const r = rows[i];
          if (!r) continue;
          if (typeof r.a !== "number" || typeof r.f !== "number") continue;
          if (!Number.isFinite(r.a) || !Number.isFinite(r.f)) continue;
          return ((r.a as number) - (r.f as number)) / scaleAf;
        }
        return 0;
      })();

      const hasForecast0 = typeof f0 === "number" && Number.isFinite(f0) && typeof p0 === "number" && Number.isFinite(p0);
      const zFp = hasForecast0 ? ((f0 as number) - (p0 as number)) / scaleFp : 0;

      const gapDays = (() => {
        const anchorMs = Date.parse(String(anchorDtUtc || "").trim());
        if (!Number.isFinite(anchorMs)) return 0;
        const last = rows[rows.length - 1];
        if (!last || typeof last.ms !== "number") return 0;
        const d = (anchorMs - (last.ms as number)) / 86_400_000;
        return Number.isFinite(d) ? d : 0;
      })();

      const aHat = !hasForecast0 ? linregForecastHat(actualSeries) : null;
      const zHatAp =
        !hasForecast0 && typeof aHat === "number" && Number.isFinite(aHat) && typeof p0 === "number" && Number.isFinite(p0)
          ? (aHat - (p0 as number)) / scaleAp
          : 0;
      const zHatDa =
        !hasForecast0 && typeof aHat === "number" && Number.isFinite(aHat)
          ? (aHat - lastA) / scaleAp
          : 0;

      const features = hasForecast0
        ? [1, zFp, zAp1, zAp3, zAp6, zALevel, zASlope6, zAf1]
        : [1, zAp1, zAp3, zAp6, zALevel, zASlope6, zHatAp, zHatDa, gapDays];

      const probs = softmax1d(dotFeatures(weights, features));
      if (probs.length < 3) return null;
      const idx = probs.reduce((best, v, i) => (v > (probs[best] ?? 0) ? i : best), 0);
      const pred0 = classes[idx] ?? "";
      const max1 = Math.max(...probs);
      const sorted = [...probs].sort((a, b) => b - a);
      const max2 = sorted[1] ?? 0;
      // Confidence score (matches the offline trainer): maxProb * (maxProb - secondMaxProb)
      const score = max1 * Math.max(0, max1 - max2);
      const th = typeof sub?.recommended_threshold === "number" ? sub.recommended_threshold : hasForecast0 ? 0.25 : 0.5;
      const backtestAcc = estimateBacktestAccAtThreshold(sub);

      return {
        pred0,
        conf: score,
        threshold: th,
        reliable: score >= th,
        n: diffsAp.length,
        pEq: probs[0],
        pGt: probs[1],
        pLt: probs[2],
        backtestAcc
      };
    };

    const modelVsPrev = buildModelVsPrev();

    const buildModelVsForecast = () => {
      const model: any = predictModel;
      const classes: string[] = Array.isArray(model?.classes) ? model.classes : ["=", ">", "<"];
      const sub: any = model?.models?.af_with_forecast;
      const weights: number[][] = Array.isArray(sub?.weights) ? sub.weights : [];
      if (weights.length < 2) return null;

      // A-F requires Forecast for the selected release instance.
      const hasForecast0 = typeof f0 === "number" && Number.isFinite(f0);
      if (!hasForecast0) return null;

      const diffsAp = rows
        .filter(
          (r) =>
            typeof r.a === "number" &&
            Number.isFinite(r.a) &&
            typeof r.prev === "number" &&
            Number.isFinite(r.prev)
        )
        .map((r) => (r.a as number) - (r.prev as number));
      if (diffsAp.length < 12) return null;
      const scaleAp = Math.max(1e-9, median(diffsAp.map((v) => Math.abs(v))));

      const actualSeries = rows
        .filter((r) => typeof r.a === "number" && Number.isFinite(r.a))
        .map((r) => r.a as number);
      if (actualSeries.length < 12) return null;
      const medianCenter = median(actualSeries);
      const mad = median(actualSeries.map((v) => Math.abs(v - medianCenter)));
      const madA = Math.max(1e-9, mad);

      const diffsFp = rows
        .filter(
          (r) =>
            typeof r.f === "number" &&
            Number.isFinite(r.f) &&
            typeof r.prev === "number" &&
            Number.isFinite(r.prev)
        )
        .map((r) => (r.f as number) - (r.prev as number));
      const scaleFp = Math.max(1e-9, median(diffsFp.map((v) => Math.abs(v))));

      const diffsAf = rows
        .filter(
          (r) =>
            typeof r.a === "number" &&
            Number.isFinite(r.a) &&
            typeof r.f === "number" &&
            Number.isFinite(r.f)
        )
        .map((r) => (r.a as number) - (r.f as number));
      if (diffsAf.length < 12) return null;
      const scaleAf = Math.max(1e-9, median(diffsAf.map((v) => Math.abs(v))));

      const lastDiffs6 = diffsAp.slice(-6);
      const lastDiffs3 = diffsAp.slice(-3);
      const lastA6 = actualSeries.slice(-6);
      const lastA = actualSeries[actualSeries.length - 1] as number;

      const zAp1 = (lastDiffs6[lastDiffs6.length - 1] as number) / scaleAp;
      const zAp3 = (lastDiffs3.reduce((a, b) => a + b, 0) / Math.max(1, lastDiffs3.length)) / scaleAp;
      const zAp6 = (lastDiffs6.reduce((a, b) => a + b, 0) / Math.max(1, lastDiffs6.length)) / scaleAp;
      const zALevel = (lastA - medianCenter) / madA;

      const slope6 = (() => {
        if (lastA6.length < 2) return 0;
        const n = lastA6.length;
        let sumX = 0;
        let sumY = 0;
        let sumXX = 0;
        let sumXY = 0;
        for (let i = 0; i < n; i += 1) {
          const x = i;
          const y = lastA6[i] as number;
          sumX += x;
          sumY += y;
          sumXX += x * x;
          sumXY += x * y;
        }
        const denom = n * sumXX - sumX * sumX;
        if (!denom) return 0;
        return (n * sumXY - sumX * sumY) / denom;
      })();
      const zASlope6 = slope6 / scaleAp;

      const zAf1 = (() => {
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          const r = rows[i];
          if (!r) continue;
          if (typeof r.a !== "number" || typeof r.f !== "number") continue;
          if (!Number.isFinite(r.a) || !Number.isFinite(r.f)) continue;
          return ((r.a as number) - (r.f as number)) / scaleAf;
        }
        return 0;
      })();

      const zFp =
        typeof p0 === "number" && Number.isFinite(p0) && typeof f0 === "number" && Number.isFinite(f0)
          ? ((f0 as number) - (p0 as number)) / scaleFp
          : 0;

      const features = [1, zFp, zAp1, zAp3, zAp6, zALevel, zASlope6, zAf1];

      const probs = softmax1d(dotFeatures(weights, features));
      if (probs.length < 3) return null;
      const idx = probs.reduce((best, v, i) => (v > (probs[best] ?? 0) ? i : best), 0);
      const pred0 = classes[idx] ?? "";
      const max1 = Math.max(...probs);
      const sorted = [...probs].sort((a, b) => b - a);
      const max2 = sorted[1] ?? 0;
      const score = max1 * Math.max(0, max1 - max2);
      const th = typeof sub?.recommended_threshold === "number" ? sub.recommended_threshold : 0.25;
      const backtestAcc = estimateBacktestAccAtThreshold(sub);

      return {
        pred0,
        conf: score,
        threshold: th,
        reliable: score >= th,
        n: diffsAf.length,
        pEq: probs[0],
        pGt: probs[1],
        pLt: probs[2],
        backtestAcc
      };
    };

    const modelVsForecast = buildModelVsForecast();

    return { recentMonths, recent, all, proxyVsPrev, modelVsPrev, modelVsForecast };
  }, [points, anchorDtUtc, displayOffsetMinutes, selectionActual, selectionForecast, selectionPrevious, predictModel]);

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

    let dMain = "";
    for (const p of pts) {
      const x = xForIdx(p.idx);
      const y = yForP(p.pUp);
      dMain += dMain ? ` L ${x},${y}` : `M ${x},${y}`;
    }

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
    } else if (usePrior && pUpPrior.length === offsets.length) {
      let d2 = "";
      for (let i = 0; i < offsets.length; i += 1) {
        const base = pUpPrior[i];
        if (typeof base !== "number" || !Number.isFinite(base)) continue;
        const pUp = Math.max(0, Math.min(1, base));
        const x = xForIdx(i);
        const y = yForP(pUp);
        d2 += d2 ? ` L ${x},${y}` : `M ${x},${y}`;
      }
      if (d2) dPrior = d2;
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
      dPrior,
      dWithout,
      baselineY,
      x0,
      firstLabel: typeof firstOffset === "number" ? formatTimeOffsetMinutes(firstOffset) : "",
      lastLabel: typeof lastOffset === "number" ? formatTimeOffsetMinutes(lastOffset) : "",
      anchorLabel,
      hasPrior: useUnified && prior && Array.isArray(prior.pUp) && prior.pUp.length === offsets.length
    };
  }, [deepData, highlightId, impactSeriesItems, anchorLabel, showUnifiedPrior]);

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

  const pvNowcast = nowcastVsPrev && nowcastVsPrev.reliable ? nowcastVsPrev : null;
  const pvChoice = pvNowcast ?? localPredict.modelVsPrev ?? localPredict.proxyVsPrev;
  const pvKind: "nowcast" | "model" | "proxy" =
    pvNowcast ? "nowcast" : localPredict.modelVsPrev ? "model" : "proxy";

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
                ? pv.pGt >= (pv.pEq ?? 0) && pv.pGt >= (pv.pLt ?? 0)
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
            <>
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
            </>
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
              <>
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
              </>
            );
          })()}
        </div>
      </div>

      {(() => {
        const pm = data.predictMarket ?? null;
        const um = pm?.unifiedMeta ?? pm?.fallback ?? null;
        const adjustedByActual = Boolean(um?.adjustedByActual);
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
            const pm = data.predictMarket ?? null;
            const um = pm?.unifiedMeta ?? pm?.fallback ?? null;
            const adjustedByActual = Boolean(um?.adjustedByActual);
            const usedActual =
              typeof um?.usedActualEvents === "number" && Number.isFinite(um.usedActualEvents)
                ? Math.max(0, Math.round(um.usedActualEvents))
                : null;
            const asOf =
              typeof um?.asOfUtc === "string" ? fmtUtcShort(String(um.asOfUtc)) : "";
            return (
              <>
                One main path P(t) is shown. It is computed from the scheduled +/-24h window (using the impact model),
                and it updates as nearby events release Actuals.
                {adjustedByActual ? (
                  <span className="deep-outlook-note-strong">
                    {" "}
                    Adjusted using released Actuals{typeof usedActual === "number" ? ` (${usedActual} events)` : ""}.
                  </span>
                ) : (
                  <span className="deep-outlook-note-strong"> Forecast-only (no released Actuals in-window yet).</span>
                )}
                {asOf ? <span className="deep-outlook-note-sub">{` As of ${asOf}.`}</span> : null}
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
