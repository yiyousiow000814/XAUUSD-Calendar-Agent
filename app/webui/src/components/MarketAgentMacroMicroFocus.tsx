import type {
  MarketAgentDriverAttentionResponse,
  MarketAgentEvidenceForRunResponse,
  MarketAgentReplayResponse
} from "../types";
import { useMemo } from "react";
import { formatUtcOffset, getSystemUtcOffsetMinutes } from "../utils/calendarTime";
import { bestMarketNewsTitle, normalizeMarketAgentValue } from "../utils/marketAgentUi";
import { normalizeMarketAgentReplayPayload } from "../utils/marketAgentReplay";
import {
  buildMarketAgentMacroDrivers,
  buildMarketAgentMicroThemes,
  isFormalMarketMacroResult,
  isFormalMarketMicroTheme,
  isUsefulMarketStoryDetail,
  type MarketAgentDriverRow
} from "./MarketAgentMacroMicroModel";
import "./MarketAgentMacroMicroFocus.css";

type MarketAgentMacroMicroFocusProps = {
  driverAttention: MarketAgentDriverAttentionResponse | null;
  selectedEvidence: MarketAgentEvidenceForRunResponse | null;
  replay?: MarketAgentReplayResponse | null;
  evidenceChainStatus?: Record<string, unknown> | null;
  marketRead?: Record<string, unknown> | null;
  currentConclusionReady: boolean;
  variant: "dashboard" | "page";
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const asRecordList = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(asRecord(item))) : [];

const textList = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((item) => textValue(item)).filter(Boolean) : [];

const textValue = (value: unknown, fallback = "") => {
  const text = String(value ?? "").trim();
  return text || fallback;
};

const firstText = (values: unknown[], fallback = "") => {
  for (const value of values) {
    const text = textValue(value);
    if (text) return text;
  }
  return fallback;
};

const timestampValue = (item: Record<string, unknown>) =>
  item.published_at ??
  item.first_seen_at ??
  item.scheduled_at ??
  item.timestamp_myt ??
  item.event_time ??
  item.timestamp ??
  "";

const parseTimestampMs = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1000;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const raw = value.trim();
  const displayDateMatch = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (displayDateMatch) {
    const [, dayRaw, monthRaw, yearRaw, hourRaw = "0", minuteRaw = "0", secondRaw = "0"] = displayDateMatch;
    const day = Number(dayRaw);
    const month = Number(monthRaw);
    const year = Number(yearRaw);
    const hour = Number(hourRaw);
    const minute = Number(minuteRaw);
    const second = Number(secondRaw);
    if (
      [day, month, year, hour, minute, second].every(Number.isFinite) &&
      month >= 1 && month <= 12 &&
      day >= 1 && day <= 31 &&
      hour >= 0 && hour <= 23 &&
      minute >= 0 && minute <= 59 &&
      second >= 0 && second <= 59
    ) {
      const parsedDate = new Date(year, month - 1, day, hour, minute, second, 0);
      if (
        parsedDate.getFullYear() === year &&
        parsedDate.getMonth() === month - 1 &&
        parsedDate.getDate() === day
      ) {
        return parsedDate.getTime();
      }
    }
    return null;
  }
  const parsed = new Date(raw).getTime();
  return Number.isNaN(parsed) ? null : parsed;
};

const pad2 = (value: number) => String(value).padStart(2, "0");
const monthLabels = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const formatDateTime = (value: unknown, fallback = "time not recorded") => {
  const parsed = parseTimestampMs(value);
  if (parsed === null) return fallback;
  const date = new Date(parsed);
  const offsetLabel = formatUtcOffset(getSystemUtcOffsetMinutes(parsed));
  return `${pad2(date.getDate())} ${monthLabels[date.getMonth()]} ${date.getFullYear()} ${pad2(date.getHours())}:${pad2(date.getMinutes())} ${offsetLabel}`;
};

const sortRecentFirst = (rows: Record<string, unknown>[]) =>
  [...rows].sort((left, right) => (parseTimestampMs(timestampValue(right)) ?? 0) - (parseTimestampMs(timestampValue(left)) ?? 0));

const uniqueRows = (rows: Record<string, unknown>[]) => {
  const seen = new Set<string>();
  return sortRecentFirst(rows).filter((row) => {
    const title = row.title ?? row.summary_title ?? row.display_title ?? row.ai_title ?? row.short_title ?? "";
    const link = row.link ?? row.url ?? row.guid ?? "";
    const source = row.source ?? "";
    const key = normalizeMarketAgentValue(`${title} ${source} ${link}`);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const sourceCount = (rows: Record<string, unknown>[]) =>
  new Set(rows.map((row) => normalizeMarketAgentValue(row.source)).filter(Boolean)).size;

const sourceLabel = (rows: Record<string, unknown>[]) => {
  const count = sourceCount(rows);
  return `${rows.length} headline${rows.length === 1 ? "" : "s"}${count ? ` / ${count} source${count === 1 ? "" : "s"}` : ""}`;
};

const summaryTitle = (item: Record<string, unknown>, fallback: string) =>
  bestMarketNewsTitle([item.display_title, item.ai_title, item.short_title, item.summary_title, item.title], fallback);

const rawNewsTitle = (item: Record<string, unknown>, fallback: string) =>
  bestMarketNewsTitle([item.display_title, item.ai_title, item.short_title, item.summary_title, item.title], fallback);

const summaryDetail = (item: Record<string, unknown>, fallback: string) =>
  firstText([item.display_summary, item.ai_summary, item.short_summary, item.summary, item.description, fallback], fallback);

const newsReviewLabel = (item: Record<string, unknown>) => {
  const summarySource = normalizeMarketAgentValue(item.summary_source ?? item.summarySource);
  if (summarySource === "local_ai" || item.ai_summary || item.ai_title || item.display_summary) {
    return "AI summarized";
  }
  const reviewStatus = normalizeMarketAgentValue(item.review_status ?? item.evidence_status ?? item.included);
  if (["accepted", "used", "included", "supporting", "confirming", "true"].includes(reviewStatus)) {
    return "Accepted input";
  }
  return "Rule kept";
};

const combinedNewsReviewLabel = (rows: Record<string, unknown>[]) =>
  rows.some((item) => newsReviewLabel(item) === "AI summarized") ? "AI summarized" : "Rule kept";

const isReviewedNewsContext = (item: Record<string, unknown>) => {
  const title = textValue(item.title ?? item.summary_title);
  if (!title) return false;
  const filterReason = normalizeMarketAgentValue(item.filter_reason ?? item.reason);
  if (filterReason.includes("no_market_agent_keyword")) return false;
  const reviewStatus = normalizeMarketAgentValue(item.review_status ?? item.evidence_status ?? item.included);
  if (item.included === false || ["false", "filtered", "excluded", "rejected", "dropped", "unreviewed_context"].includes(reviewStatus)) {
    return false;
  }
  return true;
};

const isRelevantCalendarContext = (item: Record<string, unknown>) => {
  const text = normalizeMarketAgentValue(`${item.title ?? ""} ${item.summary ?? ""} ${item.description ?? ""}`);
  if (!text) return false;
  const impact = normalizeMarketAgentValue(item.impact ?? item.importance ?? item.context_type);
  const currency = normalizeMarketAgentValue(item.currency ?? item.country ?? item.region);
  const reviewStatus = normalizeMarketAgentValue(item.review_status ?? item.evidence_status ?? item.included);
  if (reviewStatus === "unreviewed_context") return false;
  if (impact.includes("holiday") || text.includes("holiday") || text.includes("birthday") || text.includes("bank_holiday")) {
    return false;
  }
  if (["accepted", "used", "included", "supporting", "confirming", "true"].includes(reviewStatus)) return true;
  if (currency && currency !== "usd" && !text.includes("fed") && !text.includes("fomc")) return false;
  return [
    "fed",
    "fomc",
    "powell",
    "rate",
    "treasury",
    "yield",
    "cpi",
    "ppi",
    "pce",
    "inflation",
    "nfp",
    "payroll",
    "jobless",
    "unemployment",
    "retail_sales",
    "ism",
    "pmi",
    "gdp",
    "auction",
    "consumer_confidence",
    "sentiment"
  ].some((needle) => text.includes(needle));
};

const macroDefinitions = [
  {
    id: "fed-rates",
    label: "Fed / rates",
    keywords: ["fed", "fomc", "powell", "rate", "rates", "yield", "yields", "treasury", "us10y", "us2y"]
  },
  {
    id: "usd-dollar",
    label: "USD / dollar",
    keywords: ["usd", "dollar", "dxy", "greenback"]
  },
  {
    id: "inflation-oil",
    label: "Inflation / oil",
    keywords: ["inflation", "cpi", "ppi", "pce", "oil", "wti", "brent", "energy"]
  },
  {
    id: "risk-geopolitics",
    label: "Risk / geopolitics",
    keywords: [
      "risk",
      "equities",
      "stocks",
      "vix",
      "geopolitics",
      "iran",
      "israel",
      "russia",
      "ukraine",
      "china",
      "tariff",
      "war",
      "hormuz",
      "red sea",
      "middle east",
      "lebanon",
      "ceasefire",
      "military",
      "missile",
      "attack"
    ]
  },
  {
    id: "growth-data",
    label: "Growth data",
    keywords: ["gdp", "retail_sales", "ism", "pmi", "confidence", "sentiment", "jobs", "payroll", "unemployment", "jobless"]
  }
];

const scoreMacroDefinition = (definition: (typeof macroDefinitions)[number], text: string) =>
  definition.keywords.reduce((score, keyword) => score + (text.includes(normalizeMarketAgentValue(keyword)) ? 1 : 0), 0);

const primaryMacroDefinition = (item: Record<string, unknown>) => {
  const text = normalizeMarketAgentValue(`${item.title ?? ""} ${item.summary ?? ""} ${item.description ?? ""} ${item.driver ?? ""} ${item.main_driver ?? ""}`);
  if (!text) return null;
  const hasOil = ["oil", "wti", "brent", "energy"].some((keyword) => text.includes(keyword));
  const hasGeopoliticalShock = ["iran", "israel", "hormuz", "red_sea", "middle_east", "lebanon", "ceasefire", "military", "missile", "attack", "war"].some((keyword) => text.includes(keyword));
  const hasSupplyRelief = ["slip", "slips", "fall", "falls", "erase", "erases", "supply", "trump", "talk", "talks"].some((keyword) => text.includes(keyword));
  if (hasOil && hasGeopoliticalShock && !hasSupplyRelief) {
    return macroDefinitions.find((definition) => definition.id === "risk-geopolitics") ?? null;
  }
  if (hasOil) {
    return macroDefinitions.find((definition) => definition.id === "inflation-oil") ?? null;
  }
  const scored = macroDefinitions
    .map((definition) => ({ definition, score: scoreMacroDefinition(definition, text) }))
    .filter((itemScore) => itemScore.score > 0)
    .sort((left, right) => right.score - left.score);
  return scored[0]?.definition ?? null;
};

const matchingMacroDefinition = (item: Record<string, unknown>) => {
  return primaryMacroDefinition(item);
};

const macroMarketTitle = (definition: (typeof macroDefinitions)[number], latest: Record<string, unknown>) => {
  const text = normalizeMarketAgentValue(`${latest.title ?? ""} ${latest.summary ?? ""} ${latest.description ?? ""}`);
  if (definition.id === "fed-rates") {
    if (text.includes("job") || text.includes("payroll") || text.includes("employment")) {
      return "Hot labor data keeps Fed pressure on gold";
    }
    if (text.includes("cut")) return "Fed cut hopes weaken gold support";
    if (text.includes("yield") || text.includes("yields")) return "Rates pressure remains the main gold test";
    return "Rates pressure remains the main gold test";
  }
  if (definition.id === "usd-dollar") return "Dollar pressure is shaping the gold read";
  if (definition.id === "inflation-oil") {
    if (["slip", "fall", "erase", "supply", "trump", "talk"].some((keyword) => text.includes(keyword))) {
      return "Oil weakness eases one inflation risk for gold";
    }
    if (text.includes("spike") || text.includes("surge")) return "Oil spike raises inflation pressure on gold";
    return "Inflation and oil remain active gold drivers";
  }
  if (definition.id === "risk-geopolitics") {
    if (text.includes("hormuz")) return "Hormuz disruption keeps geopolitical risk active";
    if (text.includes("iran") || text.includes("israel") || text.includes("lebanon")) {
      return "Middle East risk is still moving market sentiment";
    }
    return "Geopolitical risk remains part of the gold story";
  }
  if (definition.id === "growth-data") return "Growth data is changing the rates path";
  return summaryTitle(latest, "Market driver stays active");
};

const buildNewsMacroRows = (rows: Record<string, unknown>[]) => {
  const grouped = new Map<string, { definition: (typeof macroDefinitions)[number]; rows: Record<string, unknown>[] }>();
  rows.forEach((item) => {
    const definition = primaryMacroDefinition(item);
    if (!definition) return;
    const group = grouped.get(definition.id) ?? { definition, rows: [] };
    group.rows.push(item);
    grouped.set(definition.id, group);
  });
  return Array.from(grouped.values()).flatMap(({ definition, rows: matches }): MarketAgentDriverRow[] => {
    const sortedMatches = sortRecentFirst(matches);
    const latest = sortedMatches[0];
    if (!latest) return [];
    const detail = macroMarketTitle(definition, latest);
    const latestTime = formatDateTime(timestampValue(latest));
    return [{
      id: `news-macro-${definition.id}`,
      label: definition.label,
      status: combinedNewsReviewLabel(sortedMatches),
      tone: "info",
      detail,
      meta: `${sourceLabel(sortedMatches)} | Latest ${latestTime}`
    }];
  });
};

const calendarDriverLabel = (item: Record<string, unknown>) => {
  const definition = matchingMacroDefinition(item);
  if (definition) return definition.label;
  const currency = normalizeMarketAgentValue(item.currency ?? item.country ?? item.region);
  return currency === "usd" ? "USD macro event" : "Macro calendar";
};

const calendarDetail = (item: Record<string, unknown>, relatedCount = 1) => {
  const title = summaryTitle(item, "Calendar event");
  const actual = textValue(item.actual);
  const forecast = textValue(item.forecast);
  const previous = textValue(item.previous);
  const values = [
    actual ? `actual ${actual}` : "",
    forecast ? `forecast ${forecast}` : "",
    previous ? `previous ${previous}` : ""
  ].filter(Boolean);
  if (values.length) {
    return `${title}: ${values.join(", ")}. Watch USD, rates, and XAUUSD reaction.`;
  }
  if (relatedCount > 1) {
    return `${title} anchors ${relatedCount} related calendar events. Watch USD, rates, and XAUUSD reaction.`;
  }
  return `${title} is scheduled. Watch USD, rates, and XAUUSD reaction.`;
};

const buildCalendarMacroRows = (rows: Record<string, unknown>[]) => {
  const grouped = new Map<string, { definition: (typeof macroDefinitions)[number] | null; rows: Record<string, unknown>[] }>();
  sortRecentFirst(rows).forEach((item) => {
    const definition = matchingMacroDefinition(item);
    const key = definition?.id ?? calendarDriverLabel(item);
    const group = grouped.get(key) ?? { definition, rows: [] };
    group.rows.push(item);
    grouped.set(key, group);
  });
  return Array.from(grouped.entries()).map(([key, group]): MarketAgentDriverRow => {
    const sortedMatches = sortRecentFirst(group.rows);
    const latest = sortedMatches[0] ?? {};
    const latestTime = formatDateTime(timestampValue(latest));
    const label = group.definition?.label ?? calendarDriverLabel(latest);
    const impact = textValue(latest.impact ?? latest.importance);
    const metaParts = [
      `${sortedMatches.length} calendar event${sortedMatches.length === 1 ? "" : "s"}`,
      impact,
      `Latest ${latestTime}`
    ].filter(Boolean);
    return {
      id: `calendar-macro-${normalizeMarketAgentValue(key) || "macro"}`,
      label,
      status: "Calendar kept",
      tone: "warn",
      detail: calendarDetail(latest, sortedMatches.length),
      meta: metaParts.join(" | ")
    };
  });
};

const buildNewsStoryRows = (rows: Record<string, unknown>[]) =>
  sortRecentFirst(rows).map((item, index): MarketAgentDriverRow => {
    const title = rawNewsTitle(item, "News headline");
    const detail = summaryDetail(item, title);
    const source = textValue(item.source, "News");
    return {
      id: `news-story-${normalizeMarketAgentValue(title) || index}`,
      label: title,
      status: newsReviewLabel(item),
      tone: "info",
      detail,
      meta: `${source} | ${formatDateTime(timestampValue(item))}`
    };
  });

const marketReadContextRows = (marketRead: Record<string, unknown> | null | undefined) => {
  const evidence = asRecord(marketRead?.evidence);
  const latestNews = Array.isArray(evidence?.latest_news) ? evidence.latest_news : [];
  return latestNews
    .map((item, index): Record<string, unknown> | null => {
      const title = textValue(item);
      if (!title) return null;
      return {
        title,
        summary: title,
        source: "Market read",
        review_status: "accepted",
        published_at: marketRead?.generated_at ?? marketRead?.run_started_at ?? index
      };
    })
    .filter((item): item is Record<string, unknown> => Boolean(item));
};

const buildContextRows = (
  selectedEvidence: MarketAgentEvidenceForRunResponse | null,
  replay: MarketAgentReplayResponse | null | undefined,
  marketRead?: Record<string, unknown> | null
) => {
  const payload = normalizeMarketAgentReplayPayload(replay?.replay);
  const packet = asRecord(selectedEvidence?.payload?.evidence_packet);
  const packetMarketRead = asRecord(packet?.market_read) ?? asRecord(selectedEvidence?.payload?.analysis_result?.market_read);
  const packetNews = asRecordList(packet?.news);
  const packetCalendar = asRecordList(packet?.calendar_events);
  const marketReadNews = marketReadContextRows(marketRead ?? packetMarketRead);
  const newsRows = sortRecentFirst(uniqueRows([...marketReadNews, ...payload.news_items, ...packetNews]).filter(isReviewedNewsContext));
  const calendarRows = sortRecentFirst(uniqueRows([...payload.calendar_events, ...packetCalendar]).filter(isRelevantCalendarContext));
  const macroRows = [...buildCalendarMacroRows(calendarRows), ...buildNewsMacroRows(newsRows)];
  const dedupedMacroRows = Array.from(new Map(macroRows.map((row) => [row.id, row])).values());
  return {
    macroRows: sortDriverRowsRecentFirst(dedupedMacroRows),
    microRows: buildNewsStoryRows(newsRows),
    newsCount: newsRows.length,
    calendarCount: calendarRows.length
  };
};

const rowNeedle = (row: MarketAgentDriverRow) => normalizeMarketAgentValue(`${row.id} ${row.label}`);

const pickDashboardMacroRows = (rows: MarketAgentDriverRow[]) => {
  const picked = new Set<string>();
  const pick = (matcher: (needle: string) => boolean) => {
    const row = rows.find((candidate) => !picked.has(candidate.id) && matcher(rowNeedle(candidate)));
    if (row) {
      picked.add(row.id);
      return row;
    }
    return null;
  };
  const preferred = [
    pick((needle) => needle.includes("usd") || needle.includes("dxy")),
    pick((needle) => needle.includes("yield") || needle.includes("rate") || needle.includes("fed")),
    pick((needle) => needle.includes("oil") || needle.includes("inflation")),
    pick((needle) => needle.includes("geo") || needle.includes("risk"))
  ].filter((row): row is MarketAgentDriverRow => Boolean(row));
  const fill = rows.filter((row) => !picked.has(row.id)).slice(0, Math.max(0, 4 - preferred.length));
  return [...preferred, ...fill].slice(0, 4);
};

const compactStoryText = (value: string, maxWords = 10, maxChars = 92) => {
  const clean = value.replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const words = clean.split(" ");
  const wordLimited = words.length > maxWords ? words.slice(0, maxWords).join(" ") : clean;
  return wordLimited.length > maxChars ? wordLimited.slice(0, maxChars).replace(/\s+\S*$/, "").trim() : wordLimited;
};

const readableStoryTitle = (value: string, maxWords = 14, maxChars = 128) => {
  const clean = tidyMarketTitle(value);
  if (!clean) return "";
  const words = clean.split(" ").filter(Boolean);
  const wordLimited = words.length > maxWords ? words.slice(0, maxWords).join(" ") : clean;
  const charLimited = wordLimited.length > maxChars ? wordLimited.slice(0, maxChars).replace(/\s+\S*$/, "").trim() : wordLimited;
  return endsLikeIncompletePhrase(charLimited) ? clean : charLimited;
};

const tidyMarketTitle = (value: string) =>
  value
    .replace(/\s+/g, " ")
    .replace(/[.。:;,\s]+$/g, "")
    .trim();

const conciseFallbackTitle = (value: string, maxWords = 8) => {
  const clean = tidyMarketTitle(value);
  if (!clean) return "";
  const words = clean.split(" ").filter(Boolean);
  return tidyMarketTitle(words.length > maxWords ? words.slice(0, maxWords).join(" ") : clean);
};

const endsLikeIncompletePhrase = (value: string) => {
  const lastWord = normalizeMarketAgentValue(value).split("_").filter(Boolean).at(-1) ?? "";
  return ["a", "an", "and", "as", "at", "by", "for", "from", "in", "into", "of", "on", "or", "the", "to", "with"].includes(lastWord);
};

const fallbackMarketStoryTitle = (row: MarketAgentDriverRow, raw: string, needle: string) => {
  if (needle.includes("inflation") || needle.includes("cpi") || needle.includes("ppi") || needle.includes("pce")) {
    return "Inflation risk stays in focus";
  }
  if (needle.includes("oil") || needle.includes("brent") || needle.includes("wti")) {
    return "Oil risk stays in focus";
  }
  if (needle.includes("rate_hike") || needle.includes("rate") || needle.includes("rates") || needle.includes("fed")) {
    return "Rates repricing hits gold";
  }
  if (needle.includes("gold")) return "Gold move needs confirmation";
  if (needle.includes("market") || needle.includes("stocks") || needle.includes("equities")) {
    return "Markets reset risk view";
  }
  const short = conciseFallbackTitle(raw, 7);
  if (short && !endsLikeIncompletePhrase(short) && short.split(" ").length <= 7) return short;
  return `${row.label} story stays active`;
};

const marketStoryTitle = (row: MarketAgentDriverRow) => {
  const raw = tidyMarketTitle(
    normalizeMarketAgentValue(row.detail) === normalizeMarketAgentValue(row.label) ? row.label : row.detail
  );
  const needle = normalizeMarketAgentValue(`${row.label} ${row.detail}`);
  if (!raw) return row.label;
  if (needle.includes("inflation") && (needle.includes("top_4") || needle.includes("4"))) {
    return "Inflation risk stays in focus";
  }
  if (needle.includes("market") && needle.includes("rate_hike")) {
    return "Rate hike odds rise";
  }
  if (needle.includes("oil_prices_fall") || (needle.includes("oil") && needle.includes("trump"))) {
    return "Oil slips on supply talks";
  }
  if (needle.includes("hormuz") && (needle.includes("year") || needle.includes("normal"))) {
    return "Hormuz disruption extends into year-end";
  }
  if (needle.includes("hormuz")) return "Hormuz risk keeps oil bid";
  if (needle.includes("iran") && needle.includes("israel") && (needle.includes("lebanon") || needle.includes("escalat"))) {
    return "Iran de-escalates, Lebanon risk remains";
  }
  if (needle.includes("iran") && needle.includes("war") && needle.includes("market")) {
    return "Iran war still moves global markets";
  }
  if (needle.includes("oil") && (needle.includes("spike") || needle.includes("surge"))) {
    return "Oil spike lifts inflation risk";
  }
  if (needle.includes("oil") && (needle.includes("company") || needle.includes("profit"))) {
    return "Oil costs worry firms";
  }
  if ((needle.includes("hot_jobs") || needle.includes("jobs_report") || needle.includes("payroll")) && needle.includes("fed")) {
    return "Hot jobs delay Fed cuts";
  }
  if (needle.includes("gold") && (needle.includes("slump") || needle.includes("drop")) && needle.includes("employment")) {
    return "Gold drops after hot US jobs";
  }
  if (needle.includes("fed") && needle.includes("cut")) return "Fed cut hopes fade";
  if (needle.includes("dollar") || needle.includes("dxy")) return "Dollar pressure drives gold";
  if (needle.includes("yield") || needle.includes("rates")) return "Rates pressure drives gold";
  return fallbackMarketStoryTitle(row, raw, needle);
};

const macroStoryTitle = (row: MarketAgentDriverRow) => {
  const needle = normalizeMarketAgentValue(`${row.id} ${row.label} ${row.detail}`);
  const status = normalizeMarketAgentValue(row.status);
  if (status.includes("accepted") && isUsefulMarketStoryDetail(row)) {
    return readableStoryTitle(row.detail, 14, 150);
  }
  if (needle.includes("fed") && (needle.includes("yield") || needle.includes("yields") || needle.includes("rate"))) {
    return "Rates pressure remains the main gold test";
  }
  if (row.id.startsWith("news-macro-") || row.id.startsWith("calendar-macro-")) {
    return tidyMarketTitle(row.detail) || marketStoryTitle(row);
  }
  return marketStoryTitle(row);
};

const microStoryTitle = (row: MarketAgentDriverRow) => {
  const title = tidyMarketTitle(row.label);
  if (title && normalizeMarketAgentValue(title) !== "news_headline") return title;
  return tidyMarketTitle(row.detail || marketStoryTitle(row));
};

const macroDedupeKey = (row: MarketAgentDriverRow) => {
  const id = normalizeMarketAgentValue(row.id);
  const category = macroDefinitions.find((definition) => id.includes(definition.id));
  return category?.id ?? normalizeMarketAgentValue(row.label || macroStoryTitle(row));
};

const dedupeRowsByMarketTitle = (rows: MarketAgentDriverRow[]) => {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = macroDedupeKey(row);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const dedupeRowsByMicroStory = (rows: MarketAgentDriverRow[]) => {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = normalizeMarketAgentValue(microStoryTitle(row));
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const storyChipLabel = (row: MarketAgentDriverRow) => {
  return microStoryTitle(row);
};

const driverPillLabel = (row: MarketAgentDriverRow) => {
  const needle = normalizeMarketAgentValue(`${row.id} ${row.label}`);
  if (needle.includes("us10y") || needle.includes("us2y") || needle.includes("yield") || needle.includes("rate")) {
    return "Rates / yields";
  }
  if (needle.includes("dxy") || needle.includes("usd") || needle.includes("dollar")) {
    return "USD / dollar";
  }
  return row.label;
};

const compactCountLabel = (count: number, label: string) => {
  const plural = label === "story" ? "stories" : `${label}s`;
  return `${count} ${count === 1 ? label : plural}`;
};

const metaTimeLabel = (meta: string) => {
  const latestMatch = meta.match(/Latest\s+([^|]+)$/i);
  if (latestMatch?.[1]) return latestMatch[1].trim();
  const parts = meta.split("|").map((part) => part.trim()).filter(Boolean);
  return parts.at(-1) ?? "";
};

const parseDriverRowTimeMs = (row: MarketAgentDriverRow) => parseTimestampMs(metaTimeLabel(row.meta));

const sortDriverRowsRecentFirst = (rows: MarketAgentDriverRow[]) =>
  [...rows].sort((left, right) => (parseDriverRowTimeMs(right) ?? 0) - (parseDriverRowTimeMs(left) ?? 0));

const cleanTimeLabel = (value: string) => value.replace(/\s+UTC[+-]\d+$/i, "");

const compactSourceLabel = (row: MarketAgentDriverRow) => {
  const parts = row.meta.split("|").map((part) => part.trim()).filter(Boolean);
  const time = metaTimeLabel(row.meta);
  const cleanTime = cleanTimeLabel(time);
  const nonTimeParts = parts.filter((part) => part !== time && !/^latest\s+/i.test(part));
  const source = nonTimeParts[0] && nonTimeParts[0] !== row.label ? nonTimeParts[0] : row.status;
  if (source && cleanTime && cleanTime !== "time not recorded") return `${source} • ${cleanTime}`;
  if (cleanTime && cleanTime !== "time not recorded") return cleanTime;
  return source || row.label;
};

const compactMetaLabel = (row: MarketAgentDriverRow) => {
  const time = metaTimeLabel(row.meta);
  if (!time || time === "time not recorded") return row.label;
  return `${row.label} / ${cleanTimeLabel(time)}`;
};

export function MarketAgentMacroMicroFocus({
  driverAttention,
  selectedEvidence,
  replay,
  marketRead,
  currentConclusionReady,
  variant
}: MarketAgentMacroMicroFocusProps) {
  const fullMacroDrivers = useMemo(
    () => buildMarketAgentMacroDrivers(selectedEvidence, driverAttention, 8),
    [driverAttention, selectedEvidence]
  );
  const contextRows = useMemo(
    () => buildContextRows(selectedEvidence, replay, marketRead),
    [marketRead, replay, selectedEvidence]
  );
  const resultMacroDrivers = useMemo(
    () => fullMacroDrivers.filter(isFormalMarketMacroResult),
    [fullMacroDrivers]
  );
  const formalMacroDrivers = useMemo(
    () => sortDriverRowsRecentFirst(currentConclusionReady && resultMacroDrivers.length ? resultMacroDrivers : contextRows.macroRows),
    [contextRows.macroRows, currentConclusionReady, resultMacroDrivers]
  );
  const uniqueMacroDrivers = useMemo(
    () => dedupeRowsByMarketTitle(formalMacroDrivers),
    [formalMacroDrivers]
  );
  const formalMicroThemes = useMemo(
    () => sortDriverRowsRecentFirst(contextRows.microRows),
    [contextRows.microRows]
  );
  const storyRows = useMemo(() => dedupeRowsByMicroStory(formalMicroThemes), [formalMicroThemes]);
  const macroDrivers = useMemo(
    () => variant === "page" ? uniqueMacroDrivers.slice(0, 4) : pickDashboardMacroRows(uniqueMacroDrivers).slice(0, 3),
    [uniqueMacroDrivers, variant]
  );
  const microThemes = useMemo(
    () => variant === "page" ? storyRows.slice(0, 5) : storyRows.slice(0, 4),
    [storyRows, variant]
  );
  const leadMacro = macroDrivers[0] ?? null;
  const leadStory = microThemes[0] ?? null;
  const secondaryStories = useMemo(() => microThemes.slice(1, variant === "page" ? 4 : 3), [microThemes, variant]);
  const pageMacroRows = useMemo(() => uniqueMacroDrivers.slice(0, 4), [uniqueMacroDrivers]);
  const pageStories = useMemo(() => storyRows.slice(0, 6), [storyRows]);
  const selectedPacket = asRecord(selectedEvidence?.payload?.evidence_packet);
  const selectedAnalysis = asRecord(selectedEvidence?.payload?.analysis_result);
  const selectedMarketRead = asRecord(selectedPacket?.market_read) ?? asRecord(selectedAnalysis?.market_read);
  const replayMarketRead = useMemo(() => {
    const rows = normalizeMarketAgentReplayPayload(replay?.replay).timeline_events;
    for (const row of rows) {
      const payload = asRecord(row.payload);
      const direct = asRecord(payload?.market_read);
      const nestedAnalysis = asRecord(payload?.analysis);
      const nestedResult = asRecord(payload?.analysis_result);
      const found = direct ?? asRecord(nestedAnalysis?.market_read) ?? asRecord(nestedResult?.market_read);
      if (found) return found;
    }
    return null;
  }, [replay]);
  const analystRead = asRecord((marketRead ?? selectedMarketRead ?? replayMarketRead)?.analyst_read);
  const analystNow = textValue(
    analystRead?.now,
    leadMacro ? macroStoryTitle(leadMacro) : leadStory ? microStoryTitle(leadStory) : "Market context is being reviewed"
  );
  const analystNext = textList(analystRead?.next).slice(0, 3);
  const analystRisks = textList(analystRead?.risks).slice(0, 3);

  return (
    <section
      className={`market-agent-mm-focus market-agent-mm-focus-${variant}`}
      aria-label="Macro Micro Watch"
      data-qa={`qa:market-agent:macro-micro:${variant}`}
    >
      {variant === "page" ? (
        <>
          <div className="market-agent-mm-analyst" aria-label="Analyst read">
            <section>
              <span>Now</span>
              <strong>{analystNow}</strong>
            </section>
            <section>
              <span>Next</span>
              <ul>
                {(analystNext.length ? analystNext : ["Monitor price, news, calendar, and sensor alignment"]).map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>
            <section>
              <span>Risk</span>
              <ul>
                {(analystRisks.length ? analystRisks : ["No major data-quality risk recorded"]).map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>
          </div>
          <div className="market-agent-mm-board" aria-label="Market radar quick read">
            <section
              className="market-agent-mm-narrative"
              aria-label="Big picture"
              key={`page-macro-${pageMacroRows.map((row) => row.id).join("|") || "empty"}`}
            >
              <div className="market-agent-mm-kicker">
                <span>Big picture</span>
                <em>Market impact</em>
              </div>
              <div className="market-agent-mm-feed market-agent-mm-feed-macro">
                {pageMacroRows.length ? pageMacroRows.map((row) => (
                  <article key={row.id} title={row.detail}>
                    <span>{row.label}</span>
                    <strong>{macroStoryTitle(row)}</strong>
                    <small>{compactSourceLabel(row)}</small>
                  </article>
                )) : (
                  <article className="empty">
                    <span>Macro</span>
                    <strong>No macro story detected</strong>
                    <small>Waiting for market context</small>
                  </article>
                )}
              </div>
            </section>
            <aside
              className="market-agent-mm-tape"
              aria-label="Small stories"
              key={`page-micro-${pageStories.map((row) => row.id).join("|") || "empty"}`}
            >
              <div className="market-agent-mm-kicker">
                <span>Small stories</span>
                <em>{compactCountLabel(pageStories.length, "story")}</em>
              </div>
              <ol>
                {pageStories.length ? pageStories.map((row, index) => (
                  <li key={row.id} title={row.detail}>
                    <i>{String(index + 1).padStart(2, "0")}</i>
                    <span>
                      <b>{microStoryTitle(row)}</b>
                      <small>{compactSourceLabel(row)}</small>
                    </span>
                  </li>
                )) : (
                  <li className="empty">
                    <i>--</i>
                    <span>
                      <b>No micro story detected</b>
                      <small>Waiting for market headlines</small>
                    </span>
                  </li>
                )}
              </ol>
            </aside>
          </div>
        </>
      ) : (
        <div className="market-agent-mm-glance" aria-label="Market radar quick read">
        <section
          className="market-agent-mm-glance-card macro"
          aria-label="Big picture"
          key={`dashboard-macro-${leadMacro?.id || "empty"}-${macroDrivers.map((row) => row.id).join("|")}`}
        >
          <span>Big picture <em>{compactCountLabel(formalMacroDrivers.length, "driver")}</em></span>
          <strong className={leadMacro ? undefined : "market-agent-mm-empty"}>{leadMacro ? macroStoryTitle(leadMacro) : "No macro story detected"}</strong>
          <div className="market-agent-mm-driver-pills">
            {macroDrivers.length ? macroDrivers.map((row) => (
              <em key={row.id}>{driverPillLabel(row)}</em>
            )) : null}
          </div>
        </section>
        <section
          className="market-agent-mm-glance-card micro"
          aria-label="Small stories"
          key={`dashboard-micro-${leadStory?.id || "empty"}-${secondaryStories.map((row) => row.id).join("|")}`}
        >
          <span>Small stories <em>{compactCountLabel(Math.max(leadStory ? 1 : 0, microThemes.length), "story")}</em></span>
          <strong className={leadStory ? undefined : "market-agent-mm-empty"}>{leadStory ? storyChipLabel(leadStory) : "No micro story detected"}</strong>
          <div className="market-agent-mm-story-list">
            {secondaryStories.length ? secondaryStories.map((row) => (
              <em key={row.id} title={row.detail}>
                <b>{storyChipLabel(row)}</b>
                <span>{compactMetaLabel(row)}</span>
              </em>
            )) : null}
          </div>
        </section>
        </div>
      )}
    </section>
  );
}
