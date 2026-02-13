import { useEffect, useRef, useState } from "react";
import { backend } from "../../../api";
import type { EventHistoryPoint } from "../../../types";
import { parseDisplayTimeToUtcMs } from "../../../utils/calendarTime";

import { labelZ, median, parseNumber } from "./utils";

export type NowcastVsPrev = {
  pred0: ">" | "=" | "<";
  conf: number;
  threshold: number;
  reliable: boolean;
  sourcesUsed: number;
  pEq: number;
  pGt: number;
  pLt: number;
  backtestAcc?: number;
};

type UseNowcastVsPrevArgs = {
  isUsdEvent: boolean;
  metricKey: string;
  cur: string;
  anchorDtUtc: string;
  displayOffsetMinutes: number;
  selectionForecast?: string;
  selectionPrevious?: string;
  predictModel: any;
};

export function useNowcastVsPrev({
  isUsdEvent,
  metricKey,
  cur,
  anchorDtUtc,
  displayOffsetMinutes,
  selectionForecast,
  selectionPrevious,
  predictModel
}: UseNowcastVsPrevArgs): NowcastVsPrev | null {
  const zApCacheRef = useRef(new Map<string, { series: Array<{ ms: number; z: number }> }>());
  const [nowcastVsPrev, setNowcastVsPrev] = useState<NowcastVsPrev | null>(null);
  const MAX_PARALLEL_HISTORY_FETCH = 4;

  useEffect(() => {
    const metric = String(metricKey || "").trim();
    const curCode = String(cur || "").trim().toUpperCase();
    const anchorMsRaw = Date.parse(String(anchorDtUtc || "").trim());
    const refMs = Number.isFinite(anchorMsRaw) ? Math.min(anchorMsRaw, Date.now()) : Date.now();

    const p0 = parseNumber(selectionPrevious);
    const hasPrev0 = typeof p0 === "number" && Number.isFinite(p0);
    const f0 = parseNumber(selectionForecast);
    const hasForecast0 = typeof f0 === "number" && Number.isFinite(f0);

    // Only for USD selections with a usable Previous (A vs Previous direction).
    // This predictor is trained on USD calendar history.
    // Nowcast-chain is primarily used as the no-forecast fallback, but can also fill
    // low-confidence gaps for forecastable metrics (when the model is unsure).
    if (!isUsdEvent || !hasPrev0 || !metric || curCode !== "USD") {
      setNowcastVsPrev(null);
      return;
    }

    const model: any = predictModel;
    const eqFactor =
      typeof model?.meta?.eq_factor === "number" && Number.isFinite(model.meta.eq_factor)
        ? Number(model.meta.eq_factor)
        : 0.10;

    const relRoot = model?.models?.ap_no_forecast?.relationships;
    const predictorNf = relRoot?.predictor ?? null;
    const predictorWf = relRoot?.predictor_with_forecast ?? null;
    let predictor: any = hasForecast0 ? (predictorWf ?? predictorNf) : predictorNf;
    let enabled: any = predictor?.enabled_metrics?.[metric] ?? null;
    if (!enabled && !hasForecast0 && predictorWf) {
      // Rare: a normally-forecastable metric instance missing Forecast in the calendar export.
      predictor = predictorWf;
      enabled = predictorWf?.enabled_metrics?.[metric] ?? null;
    }
    const rels: Array<{ metric: string; corr: number }> = Array.isArray(relRoot?.by_metric?.[metric])
      ? relRoot.by_metric[metric]
      : [];
    if (!enabled || !rels.length) {
      setNowcastVsPrev(null);
      return;
    }

    const recommendedTh =
      typeof predictor?.recommended_threshold === "number" &&
      Number.isFinite(predictor.recommended_threshold)
        ? Number(predictor.recommended_threshold)
        : 0.10;
    const metricTh =
      typeof enabled?.th === "number" && Number.isFinite(enabled.th) ? Number(enabled.th) : recommendedTh;
    const recentDays =
      typeof model?.meta?.relationships?.recent_days === "number" &&
      Number.isFinite(model.meta.relationships.recent_days)
        ? Number(model.meta.relationships.recent_days)
        : 180;
    const recentMs = Math.max(1, recentDays) * 86_400_000;
    const tailLimit =
      typeof model?.meta?.relationships?.tail_limit === "number" &&
      Number.isFinite(model.meta.relationships.tail_limit)
        ? Math.max(1, Math.min(256, Math.floor(Number(model.meta.relationships.tail_limit))))
        : 6;
    const halfLifeDays =
      typeof model?.meta?.relationships?.vote_half_life_days === "number" &&
      Number.isFinite(model.meta.relationships.vote_half_life_days)
        ? Number(model.meta.relationships.vote_half_life_days)
        : 60;
    const halfLifeMs = Math.max(1, halfLifeDays) * 86_400_000;

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
          const b = kind === "af" ? parseNumber(p.forecast) : parseNumber(p.previousRaw ?? p.previous);
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
          srcKey: String((it as any)?.metric || "").trim(),
          kind: String((it as any)?.kind || "ap")
            .trim()
            .toLowerCase(),
          corr: Number((it as any)?.corr ?? 0),
          cond: (it as any)?.cond
        }))
        .filter(
          (it) =>
            it.srcKey &&
            (it.kind === "ap" || it.kind === "af") &&
            Number.isFinite(it.corr) &&
            Math.abs(it.corr) > 1e-12
        );
      const seriesList: Array<{ series: Array<{ ms: number; z: number }> } | null> = new Array(candidates.length)
        .fill(null);
      let cursor = 0;
      const worker = async () => {
        while (cursor < candidates.length) {
          const idx = cursor;
          cursor += 1;
          const item = candidates[idx];
          if (!item) continue;
          seriesList[idx] = await buildZApSeries(item.srcKey, item.kind as "ap" | "af");
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.max(1, Math.min(MAX_PARALLEL_HISTORY_FETCH, candidates.length)) },
          () => worker()
        )
      );

      for (let idx = 0; idx < candidates.length; idx += 1) {
        const { corr } = candidates[idx]!;
        const src = seriesList[idx];
        if (!src) continue;
        const series = src.series;
        // Use recent 1-6 months worth of signals (within the recent window), but decay older ones
        // so the latest prints dominate without forcing a hard cutoff.
        let j = series.length - 1;
        while (j >= 0) {
          const ms = series[j]!.ms;
          if (ms < refMs && refMs - ms <= recentMs) break;
          j -= 1;
        }
        if (j < 0) continue;

        let edgeUsed = false;
        let taken = 0;
        while (j >= 0 && taken < tailLimit) {
          const ms = series[j]!.ms;
          const age = refMs - ms;
          if (age < 0) {
            j -= 1;
            taken += 1;
            continue;
          }
          if (age > recentMs) break;

          const z = Math.max(-3, Math.min(3, series[j]!.z));
          const wTime = Math.exp(-age / halfLifeMs);

          const srcLab = labelZ(z, eqFactor); // 0="=", 1=">", 2="<"
          const w = Math.abs(corr) * Math.min(3, Math.abs(z)) * wTime;
          if (!Number.isFinite(w) || w <= 0) {
            j -= 1;
            taken += 1;
            continue;
          }

          const condRow =
            Array.isArray((candidates[idx] as any).cond) &&
            Array.isArray(((candidates[idx] as any).cond as any)[srcLab])
              ? ((candidates[idx] as any).cond as any)[srcLab]
              : null;

          if (Array.isArray(condRow) && condRow.length === 3) {
            // Prefer the learned conditional distribution:
            //   P(target_label | source_label), labels in order ["=", ">", "<"].
            // Add the full row to avoid overconfident "winner-take-all" votes
            // (aligns with the offline trainer + Rust fallback).
            const p0 = Number(condRow[0]);
            const p1 = Number(condRow[1]);
            const p2 = Number(condRow[2]);
            if (Number.isFinite(p0) && p0 > 0) vEq += w * p0;
            if (Number.isFinite(p1) && p1 > 0) vGt += w * p1;
            if (Number.isFinite(p2) && p2 > 0) vLt += w * p2;
          } else {
            // Back-compat fallback: treat corr sign as a hard inversion for ">" / "<".
            let lab = srcLab;
            if (lab === 1 && corr < 0) lab = 2;
            else if (lab === 2 && corr < 0) lab = 1;
            if (lab === 0) vEq += w;
            else if (lab === 1) vGt += w;
            else vLt += w;
          }

          edgeUsed = true;
          j -= 1;
          taken += 1;
        }

        if (edgeUsed) used += 1;
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

  return nowcastVsPrev;
}
