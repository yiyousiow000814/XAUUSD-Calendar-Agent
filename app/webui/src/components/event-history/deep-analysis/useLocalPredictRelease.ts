import { useMemo } from "react";
import type { EventHistoryPoint } from "../../../types";
import { parseDisplayTimeToUtcMs } from "../../../utils/calendarTime";
import {
  dotFeatures,
  estimateBacktestAccAtThreshold,
  estimateBacktestAccForMetric,
  pickThresholdForMetric,
  softmax1d
} from "../../../utils/predictReleaseModel";

import { labelZ, median, parseNumber } from "./utils";

type UseLocalPredictReleaseArgs = {
  points: EventHistoryPoint[];
  metricKey: string;
  anchorDtUtc: string;
  displayOffsetMinutes: number;
  selectionImpact?: string;
  selectionActual?: string;
  selectionForecast?: string;
  selectionPrevious?: string;
  predictModel: any;
};

export function useLocalPredictRelease({
  points,
  metricKey,
  anchorDtUtc,
  displayOffsetMinutes,
  selectionImpact,
  selectionActual,
  selectionForecast,
  selectionPrevious,
  predictModel
}: UseLocalPredictReleaseArgs) {
  return useMemo(() => {
    const EQ_FACTOR = 0.05; // Wider "approx equal" than strict matching; tuned for calendar numeric noise.
    const metric = String(metricKey || "").trim();
    const isHighImpact = String(selectionImpact || "").trim().toLowerCase() === "high";
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
      const classIndex = {
        eq: classes.indexOf("="),
        gt: classes.indexOf(">"),
        lt: classes.indexOf("<")
      };
      if (classIndex.eq < 0 || classIndex.gt < 0 || classIndex.lt < 0) return null;
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
      const baseTh = typeof sub?.recommended_threshold === "number" ? sub.recommended_threshold : hasForecast0 ? 0.25 : 0.5;
      const metricTh = pickThresholdForMetric(sub as any, metric);
      let th = typeof metricTh === "number" && Number.isFinite(metricTh) ? metricTh : baseTh;
      // High-impact releases: demand stronger confidence before marking the output "reliable".
      if (hasForecast0 && isHighImpact) {
        th = Math.max(th, 0.18);
      }
      const backtestAcc = estimateBacktestAccForMetric(sub as any, metric) ?? estimateBacktestAccAtThreshold(sub);

      return {
        pred0,
        conf: score,
        threshold: th,
        reliable: score >= th,
        n: diffsAp.length,
        pEq: probs[classIndex.eq] ?? 0,
        pGt: probs[classIndex.gt] ?? 0,
        pLt: probs[classIndex.lt] ?? 0,
        backtestAcc
      };
    };

    const modelVsPrev = buildModelVsPrev();

    const buildModelVsForecast = () => {
      const model: any = predictModel;
      const classes: string[] = Array.isArray(model?.classes) ? model.classes : ["=", ">", "<"];
      const classIndex = {
        eq: classes.indexOf("="),
        gt: classes.indexOf(">"),
        lt: classes.indexOf("<")
      };
      if (classIndex.eq < 0 || classIndex.gt < 0 || classIndex.lt < 0) return null;
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
      const baseTh = typeof sub?.recommended_threshold === "number" ? sub.recommended_threshold : 0.25;
      const metricTh = pickThresholdForMetric(sub as any, metric);
      let th = typeof metricTh === "number" && Number.isFinite(metricTh) ? metricTh : baseTh;
      if (isHighImpact) {
        th = Math.max(th, 0.18);
      }
      const backtestAcc = estimateBacktestAccForMetric(sub as any, metric) ?? estimateBacktestAccAtThreshold(sub);

      return {
        pred0,
        conf: score,
        threshold: th,
        reliable: score >= th,
        n: diffsAf.length,
        pEq: probs[classIndex.eq] ?? 0,
        pGt: probs[classIndex.gt] ?? 0,
        pLt: probs[classIndex.lt] ?? 0,
        backtestAcc
      };
    };

    const modelVsForecast = buildModelVsForecast();

    return { recentMonths, recent, all, proxyVsPrev, modelVsPrev, modelVsForecast };
  }, [points, anchorDtUtc, displayOffsetMinutes, selectionActual, selectionForecast, selectionImpact, selectionPrevious, predictModel]);
}
