export type LogEntry = {
  time: string;
  message: string;
  level: string;
};

export type FilterOption = "ALL" | "INFO" | "WARN" | "ERROR";

export type ToastType = "success" | "error" | "info";

export type UiModal = {
  id: string;
  title: string;
  message: string;
  tone: "info" | "error";
};

export type EventItem = {
  id: string;
  state?: "upcoming" | "current";
  time: string;
  cur: string;
  impact: string;
  event: string;
  countdown: string;
};

export type PastEventItem = {
  time: string;
  cur: string;
  impact: string;
  event: string;
  actual: string;
  forecast: string;
  previous: string;
};

export type EventHistoryPoint = {
  date: string;
  time: string;
  actual: string;
  actualRaw?: string;
  actualRevisedFrom?: string;
  forecast: string;
  previous: string;
  previousRaw?: string;
  previousRevisedFrom?: string;
  period?: string;
};

export type EventHistoryResponse = {
  ok: boolean;
  eventId?: string;
  metric?: string;
  frequency?: string;
  period?: string;
  cur?: string;
  points?: EventHistoryPoint[];
  cached?: boolean;
  message?: string;
};

export type EventImpactBucket = "ap_gt_prev" | "ap_lt_prev" | "ap_eq_prev";

export type EventImpactWindowStats = {
  n: number;
  p_up?: number;
  p_down?: number;
  p10?: number;
  p50?: number;
  p90?: number;
  p05_all?: number;
  up_n?: number;
  down_n?: number;
  up_p10?: number | null;
  up_p50?: number | null;
  up_p90?: number | null;
  down_p10?: number | null;
  down_p50?: number | null;
  down_p90?: number | null;
  best_direction?: "up" | "down";
  best_p?: number;
  best_median_pct?: number;
  p10_all?: number;
  p25_all?: number;
  p50_all?: number;
  p75_all?: number;
  p90_all?: number;
  p95_all?: number;
};

export type EventImpactResponse = {
  ok: boolean;
  message?: string;
  eventId?: string;
  bucket?: EventImpactBucket;
  generatedAtUtc?: string;
  meta?: {
    price_min_utc?: string | null;
    price_max_utc?: string | null;
    event_source_tz?: string | null;
    event_min_utc?: string | null;
    event_max_utc?: string | null;
    sample_points?: number | null;
  };
  windowsMinutes?: number[];
  data?: Record<string, EventImpactWindowStats>;
};

export type Snapshot = {
  lastPull: string;
  lastSync: string;
  lastPullAt?: string;
  lastSyncAt?: string;
  outputDir: string;
  repoPath: string;
  currency: string;
  currencyOptions: string[];
  events: EventItem[];
  pastEvents: PastEventItem[];
  logs: LogEntry[];
  version: string;
  pullActive?: boolean;
  syncActive?: boolean;
  calendarStatus?: "loading" | "downloading" | "loaded" | "empty" | "error";
  restartInSeconds?: number;
  modal?: UiModal | null;
};

export type Settings = {
  autoSyncAfterPull: boolean;
  autoUpdateEnabled: boolean;
  runOnStartup: boolean;
  autostartLaunchMode: "tray" | "show";
  closeBehavior: "exit" | "tray";
  traySupported: boolean;
  debug: boolean;
  autoSave: boolean;
  splitRatio: number;
  enableSystemTheme: boolean;
  theme: "system" | "dark" | "light";
  calendarTimezoneMode: "utc" | "system";
  calendarUtcOffsetMinutes: number;
  enableTemporaryPath: boolean;
  temporaryPath: string;
  repoPath: string;
  logPath: string;
};
