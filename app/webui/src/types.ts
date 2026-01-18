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
  calendarStatus?: "loading" | "loaded" | "empty" | "error";
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
  removeLogs: boolean;
  removeOutput: boolean;
  removeTemporaryPaths: boolean;
  uninstallConfirm: string;
};
