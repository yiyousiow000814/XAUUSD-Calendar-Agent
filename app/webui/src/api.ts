import type { Settings, Snapshot } from "./types";
import { CURRENCY_OPTIONS } from "./constants/currencyOptions";

type ApiResult<T> = Promise<T>;

type UpdateState = {
  ok: boolean;
  phase: string;
  message: string;
  availableVersion?: string;
  progress?: number;
  downloadedBytes?: number;
  totalBytes?: number | null;
  lastCheckedAt?: string;
};

type BackendApi = {
  get_snapshot: () => ApiResult<Snapshot>;
  get_settings: () => ApiResult<Settings>;
  save_settings: (payload: Settings) => ApiResult<{ ok: boolean }>;
  frontend_boot_complete?: () => ApiResult<{ ok: boolean }>;
  set_ui_state?: (payload: { visible: boolean; focused: boolean; lastInputAt: number }) => ApiResult<{ ok: boolean }>;
  get_temporary_path_task: () => ApiResult<{
    ok: boolean;
    active: boolean;
    phase: string;
    progress: number;
    message: string;
    path: string;
  }>;
  probe_temporary_path: (payload: {
    enableTemporaryPath: boolean;
    temporaryPath: string;
    autoStart?: boolean;
  }) => ApiResult<{
    ok: boolean;
    status: string;
    ready: boolean;
    needsConfirmation: boolean;
    canUseAsIs: boolean;
    canReset: boolean;
    path: string;
    message: string;
    details?: Record<string, unknown>;
    action?: string;
    taskActive?: boolean;
    taskPath?: string;
  }>;
  temporary_path_use_as_is: (payload: { temporaryPath: string }) => ApiResult<{ ok: boolean; message?: string }>;
  temporary_path_reset: (payload: { temporaryPath: string }) => ApiResult<{ ok: boolean; message?: string }>;
  get_update_state: () => ApiResult<UpdateState>;
  check_updates: () => ApiResult<{ ok: boolean; message?: string }>;
  update_now: () => ApiResult<{ ok: boolean; message?: string }>;
  open_log: () => ApiResult<{ ok: boolean; message?: string }>;
  open_path: (path: string) => ApiResult<{ ok: boolean; message?: string }>;
  open_url?: (url: string) => ApiResult<{ ok: boolean; message?: string }>;
  add_log: (payload: { message: string; level?: string }) => ApiResult<{ ok: boolean }>;
  browse_temporary_path: () => ApiResult<{ ok: boolean; path?: string }>;
  set_temporary_path: (path: string) => ApiResult<{ ok: boolean }>;
  uninstall: (payload: {
    confirm: string;
    removeLogs: boolean;
    removeOutput: boolean;
    removeTemporaryPaths: boolean;
  }) => ApiResult<{ ok: boolean; message?: string }>;
  pull_now: () => ApiResult<{ ok: boolean }>;
  sync_now: () => ApiResult<{ ok: boolean }>;
  browse_output_dir: () => ApiResult<{ ok: boolean; path?: string }>;
  set_output_dir: (path: string) => ApiResult<{ ok: boolean }>;
  set_currency: (value: string) => ApiResult<{ ok: boolean }>;
  clear_logs: () => ApiResult<{ ok: boolean }>;
  dismiss_modal?: (payload: { id: string }) => ApiResult<{ ok: boolean }>;
};

const DESKTOP_USER_AGENT_TOKEN = "XAUUSDCalendar/";

export const isWebview = () => {
  if (typeof navigator === "undefined") return false;
  return navigator.userAgent.includes(DESKTOP_USER_AGENT_TOKEN);
};

const webviewApiRef = () =>
  (window as unknown as { pywebview?: { api?: BackendApi } }).pywebview?.api ??
  null;

const hasBackendApi = () => {
  const api = webviewApiRef();
  if (!api) return false;
  return typeof api.get_snapshot === "function" && typeof api.get_settings === "function";
};

const waitForBackendApi = (timeoutMs = 30000) =>
  new Promise<void>((resolve, reject) => {
    if (!isWebview()) {
      resolve();
      return;
    }
    if (hasBackendApi()) {
      resolve();
      return;
    }

    let settled = false;
    let readyEventSeen = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("pywebviewready", onReady);
      if (poll) window.clearInterval(poll);
      if (timer) window.clearTimeout(timer);
      fn();
    };

    const onReady = () => {
      readyEventSeen = true;
      if (hasBackendApi()) {
        settle(resolve);
      }
    };
    const poll = window.setInterval(() => {
      if (hasBackendApi()) {
        settle(resolve);
        return;
      }
      // Some pywebview builds fire `pywebviewready` before the API is fully attached.
      // Keep polling briefly after the event to avoid a startup flicker.
      if (readyEventSeen) {
        return;
      }
    }, 100);
    const timer = window.setTimeout(() => {
      settle(() => reject(new Error("Desktop backend not ready")));
    }, timeoutMs);

    window.addEventListener("pywebviewready", onReady, { once: true });
  });

const baseMockSnapshot: Snapshot = {
  lastPull: "04-01-2026 06:51",
  lastSync: "Not yet",
  lastPullAt: "2026-01-04T06:51:00",
  lastSyncAt: "",
  outputDir: "",
  repoPath: "",
  currency: "USD",
  currencyOptions: Array.from(CURRENCY_OPTIONS),
  pullActive: false,
  syncActive: false,
  restartInSeconds: 0,
  events: [
    {
      id: "mock-evt-1",
      state: "upcoming",
      time: "05-01-2026 01:30",
      cur: "USD",
      impact: "Medium",
      event: "FOMC Member Kaplan Speaks",
      countdown: "18h 27m"
    },
    {
      id: "mock-evt-2",
      state: "upcoming",
      time: "05-01-2026 03:10",
      cur: "USD",
      impact: "Low",
      event: "ISM Services PMI",
      countdown: "20h 05m"
    },
    {
      id: "mock-evt-3",
      state: "upcoming",
      time: "05-01-2026 04:00",
      cur: "EUR",
      impact: "High",
      event: "ECB President Speech",
      countdown: "21h 00m"
    },
    {
      id: "mock-evt-4",
      state: "upcoming",
      time: "05-01-2026 06:30",
      cur: "GBP",
      impact: "Low",
      event: "UK Manufacturing PMI",
      countdown: "23h 30m"
    }
  ],
  pastEvents: [
    {
      time: "06-01-2026 15:00",
      cur: "JPY",
      impact: "Low",
      event: "Household Spending",
      actual: "-0.2",
      forecast: "--",
      previous: "--"
    },
    {
      time: "06-01-2026 18:00",
      cur: "USD",
      impact: "Medium",
      event: "Fed Balance Sheet",
      actual: "--",
      forecast: "--",
      previous: "--"
    },
    {
      time: "06-01-2026 21:30",
      cur: "USD",
      impact: "High",
      event: "CPI (MoM)",
      actual: "+0.1",
      forecast: "+0.2",
      previous: "+0.3"
    },
    {
      time: "05-01-2026 03:00",
      cur: "USD",
      impact: "High",
      event: "ISM Services PMI",
      actual: "52.1",
      forecast: "52.0",
      previous: "51.8"
    },
    {
      time: "05-01-2026 12:30",
      cur: "USD",
      impact: "Medium",
      event: "Jobless Claims",
      actual: "217k",
      forecast: "220k",
      previous: "219k"
    }
  ],
  logs: [
    { time: "04-01-2026 07:02", message: "Repo already up to date", level: "INFO" },
    { time: "04-01-2026 07:02", message: "Calendar snapshot loaded", level: "INFO" }
  ],
  // Browser-only mock: the real app version is provided by the desktop backend (APP_VERSION).
  version: "0.0.0",
  modal: null
};

const getMockSnapshot = () =>
  ((window as unknown as { __MOCK_SNAPSHOT__?: Snapshot }).__MOCK_SNAPSHOT__ ??
    baseMockSnapshot) as Snapshot;

const formatDisplayTime = (date: Date) => {
  const pad = (value: number) => String(value).padStart(2, "0");
  const dd = pad(date.getDate());
  const mm = pad(date.getMonth() + 1);
  const yyyy = String(date.getFullYear());
  const hh = pad(date.getHours());
  const min = pad(date.getMinutes());
  return `${dd}-${mm}-${yyyy} ${hh}:${min}`;
};

const setMockSnapshot = (next: Snapshot) => {
  (window as unknown as { __MOCK_SNAPSHOT__?: Snapshot }).__MOCK_SNAPSHOT__ = next;
  return next;
};

const normalizeMockPathKey = (value: string) =>
  String(value || "")
    .trim()
    .replace(/[\\/]+$/, "")
    .toLowerCase();

const getMockOutputLastSync = (outputDir: string) => {
  const key = normalizeMockPathKey(outputDir);
  const map =
    (window as unknown as { __MOCK_OUTPUT_LAST_SYNC__?: Record<string, { lastSyncAt: string; lastSync: string }> })
      .__MOCK_OUTPUT_LAST_SYNC__ ?? {};
  return map[key] || { lastSyncAt: "", lastSync: "Not yet" };
};

const setMockOutputLastSync = (outputDir: string, payload: { lastSyncAt: string; lastSync: string }) => {
  const key = normalizeMockPathKey(outputDir);
  if (!key) return;
  const win = window as unknown as {
    __MOCK_OUTPUT_LAST_SYNC__?: Record<string, { lastSyncAt: string; lastSync: string }>;
  };
  win.__MOCK_OUTPUT_LAST_SYNC__ = { ...(win.__MOCK_OUTPUT_LAST_SYNC__ ?? {}), [key]: payload };
};

const baseMockUpdateState: UpdateState = {
  ok: true,
  phase: "idle",
  message: "",
  availableVersion: "",
  progress: 0,
  lastCheckedAt: ""
};

const getMockUpdateState = () =>
  ((window as unknown as { __MOCK_UPDATE_STATE__?: UpdateState }).__MOCK_UPDATE_STATE__ ??
    baseMockUpdateState) as UpdateState;

const setMockUpdateState = (next: Partial<UpdateState>) => {
  const win = window as unknown as { __MOCK_UPDATE_STATE__?: UpdateState };
  win.__MOCK_UPDATE_STATE__ = { ...getMockUpdateState(), ...next, ok: true };
  return win.__MOCK_UPDATE_STATE__;
};

const mockUpdateTimers: { download?: number } = {};

let mockSettings: Settings = {
  autoSyncAfterPull: true,
  autoUpdateEnabled: true,
  runOnStartup: true,
  autostartLaunchMode: "tray",
  closeBehavior: "exit",
  traySupported: true,
  debug: false,
  autoSave: true,
  splitRatio: 0.66,
  enableSystemTheme: false,
  theme: "dark",
  calendarTimezoneMode: "system",
  calendarUtcOffsetMinutes: 0,
  enableTemporaryPath: false,
  temporaryPath: "",
  repoPath: "",
  logPath: "C:\\\\Users\\\\User\\\\AppData\\\\Roaming\\\\XAUUSDCalendar\\\\logs\\\\app.log",
  removeLogs: true,
  removeOutput: false,
  removeTemporaryPaths: true,
  uninstallConfirm: ""
};

const withApi = async () => {
  await waitForBackendApi();
  return webviewApiRef();
};

const hasMethod = (api: BackendApi | null, key: keyof BackendApi) =>
  Boolean(api && typeof api[key] === "function");

export const backend = {
  getSnapshot: async (): ApiResult<Snapshot> => {
    const api = await withApi();
    if (!api || !hasMethod(api, "get_snapshot")) {
      if (isWebview()) {
        throw new Error("Desktop backend unavailable");
      }
      return Promise.resolve(getMockSnapshot());
    }
    return api.get_snapshot();
  },
  getUpdateState: async () => {
    const api = await withApi();
    if (!api || !hasMethod(api, "get_update_state")) {
      if (isWebview()) {
        throw new Error("Desktop backend unavailable");
      }
      return Promise.resolve(getMockUpdateState());
    }
    return api.get_update_state();
  },
  checkUpdates: async () => {
    const api = await withApi();
    if (!api || !hasMethod(api, "check_updates")) {
      if (isWebview()) {
        throw new Error("Desktop backend unavailable");
      }
      const now = new Date();
      const pad = (value: number) => String(value).padStart(2, "0");
      const lastCheckedAt = `${pad(now.getDate())}-${pad(now.getMonth() + 1)}-${now.getFullYear()} ${pad(
        now.getHours()
      )}:${pad(now.getMinutes())}`;
      setMockUpdateState({
        phase: "available",
        message: "Update available: 9.9.9",
        availableVersion: "9.9.9",
        progress: 0,
        lastCheckedAt
      });
      return Promise.resolve({ ok: true });
    }
    return api.check_updates();
  },
  updateNow: async () => {
    const api = await withApi();
    if (!api || !hasMethod(api, "update_now")) {
      if (isWebview()) {
        throw new Error("Desktop backend unavailable");
      }
      const state = getMockUpdateState();
      if (state.phase === "downloaded") {
        setMockUpdateState({
          phase: "restarting",
          message: "Restarting...",
          progress: 1
        });
        window.setTimeout(() => {
          setMockUpdateState({
            phase: "idle",
            message: "",
            progress: 0,
            availableVersion: ""
          });
        }, 1200);
        return Promise.resolve({ ok: true });
      }
      if (!state.availableVersion) {
        setMockUpdateState({
          phase: "available",
          message: "Update available: 9.9.9",
          availableVersion: "9.9.9",
          progress: 0
        });
      }
      if (mockUpdateTimers.download) {
        window.clearInterval(mockUpdateTimers.download);
        mockUpdateTimers.download = undefined;
      }
      const startedAt = Date.now();
      setMockUpdateState({
        phase: "downloading",
        message: "Downloading...",
        progress: 0
      });
      mockUpdateTimers.download = window.setInterval(() => {
        const elapsed = Date.now() - startedAt;
        const progress = Math.min(1, elapsed / 1600);
        if (progress >= 1) {
          const timer = mockUpdateTimers.download;
          if (typeof timer === "number") {
            window.clearInterval(timer);
          }
          mockUpdateTimers.download = undefined;
          setMockUpdateState({ phase: "downloaded", message: "Download complete", progress: 1 });
          return;
        }
        setMockUpdateState({ progress });
      }, 120);
      return Promise.resolve({ ok: true });
    }
    return api.update_now();
  },
  getSettings: async (): ApiResult<Settings> => {
    const api = await withApi();
    if (!api || !hasMethod(api, "get_settings")) {
      if (isWebview()) {
        throw new Error("Desktop backend unavailable");
      }
      return Promise.resolve(mockSettings);
    }
    return api.get_settings();
  },
  saveSettings: async (payload: Settings) => {
    const api = await withApi();
    if (!api || !hasMethod(api, "save_settings")) {
      if (isWebview()) {
        throw new Error("Desktop backend unavailable");
      }
      mockSettings = { ...mockSettings, ...payload };
      return { ok: true };
    }
    return api.save_settings(payload);
  },
  frontendBootComplete: async () => {
    const api = await withApi();
    if (!api || !hasMethod(api, "frontend_boot_complete")) {
      return Promise.resolve({ ok: true });
    }
    return api.frontend_boot_complete();
  },
  setUiState: async (payload: { visible: boolean; focused: boolean; lastInputAt: number }) => {
    const api = await withApi();
    if (!api || !hasMethod(api, "set_ui_state")) {
      return Promise.resolve({ ok: true });
    }
    return api.set_ui_state(payload);
  },
  openLog: async () => {
    const api = await withApi();
    if (!api || !hasMethod(api, "open_log")) {
      if (isWebview()) {
        throw new Error("Desktop backend unavailable");
      }
      return { ok: true };
    }
    return api.open_log();
  },
  openPath: async (path: string) => {
    const api = await withApi();
    if (!api || !hasMethod(api, "open_path")) {
      if (isWebview()) {
        throw new Error("Desktop backend unavailable");
      }
      return { ok: true };
    }
    return api.open_path(path);
  },
  openUrl: async (url: string) => {
    const api = await withApi();
    if (!api || !hasMethod(api, "open_url")) {
      if (isWebview()) {
        throw new Error("Desktop backend unavailable");
      }
      try {
        window.open(url, "_blank", "noreferrer");
      } catch {
        // ignore
      }
      return { ok: true };
    }
    return api.open_url(url);
  },
  addLog: async (payload: { message: string; level?: string }) => {
    const api = await withApi();
    if (!api || !hasMethod(api, "add_log")) {
      if (isWebview()) {
        return { ok: false };
      }
      return { ok: true };
    }
    return api.add_log(payload);
  },
  browseTemporaryPath: async () => {
    const api = await withApi();
    if (!api || !hasMethod(api, "browse_temporary_path")) {
      if (isWebview()) {
        throw new Error("Desktop backend unavailable");
      }
      return { ok: true, path: "" };
    }
    return api.browse_temporary_path();
  },
  setTemporaryPathPath: async (path: string) => {
    const api = await withApi();
    if (!api || !hasMethod(api, "set_temporary_path")) {
      if (isWebview()) {
        throw new Error("Desktop backend unavailable");
      }
      return { ok: true };
    }
    return api.set_temporary_path(path);
  },
  getTemporaryPathTask: async () => {
    const api = await withApi();
    if (!api || !hasMethod(api, "get_temporary_path_task")) {
      if (isWebview()) {
        throw new Error("Desktop backend unavailable");
      }
      return { ok: true, active: false, phase: "idle", progress: 0, message: "", path: "" };
    }
    return api.get_temporary_path_task();
  },
  probeTemporaryPath: async (payload: { enableTemporaryPath: boolean; temporaryPath: string; autoStart?: boolean }) => {
    const api = await withApi();
    if (!api || !hasMethod(api, "probe_temporary_path")) {
      if (isWebview()) {
        throw new Error("Desktop backend unavailable");
      }
      const uiCheck = (
        window as unknown as {
          __ui_check__?: {
            mockProbeTemporaryPath?:
              | Record<string, unknown>
              | ((payload: { enableTemporaryPath: boolean; temporaryPath: string; autoStart?: boolean }) => unknown);
          };
        }
      ).__ui_check__;
      if (uiCheck?.mockProbeTemporaryPath) {
        const mocked =
          typeof uiCheck.mockProbeTemporaryPath === "function"
            ? uiCheck.mockProbeTemporaryPath(payload)
            : uiCheck.mockProbeTemporaryPath;
        return {
          ok: true,
          status: "mock",
          ready: true,
          needsConfirmation: false,
          canUseAsIs: false,
          canReset: false,
          path: payload.temporaryPath || "",
          message: "",
          ...(mocked as Record<string, unknown>)
        };
      }
      return {
        ok: true,
        status: "mock",
        ready: true,
        needsConfirmation: false,
        canUseAsIs: false,
        canReset: false,
        path: payload.temporaryPath || "",
        message: ""
      };
    }
    return api.probe_temporary_path(payload);
  },
  temporaryPathUseAsIs: async (temporaryPath: string) => {
    const api = await withApi();
    if (!api || !hasMethod(api, "temporary_path_use_as_is")) {
      if (isWebview()) {
        throw new Error("Desktop backend unavailable");
      }
      return { ok: true };
    }
    return api.temporary_path_use_as_is({ temporaryPath });
  },
  temporaryPathReset: async (temporaryPath: string) => {
    const api = await withApi();
    if (!api || !hasMethod(api, "temporary_path_reset")) {
      if (isWebview()) {
        throw new Error("Desktop backend unavailable");
      }
      return { ok: true };
    }
    return api.temporary_path_reset({ temporaryPath });
  },
  uninstall: async (payload: {
    confirm: string;
    removeLogs: boolean;
    removeOutput: boolean;
    removeTemporaryPaths: boolean;
  }) => {
    const api = await withApi();
    if (!api || !hasMethod(api, "uninstall")) {
      if (isWebview()) {
        throw new Error("Desktop backend unavailable");
      }
      return { ok: true };
    }
    return api.uninstall(payload);
  },
  pullNow: async () => {
    const api = await withApi();
    if (!api || !hasMethod(api, "pull_now")) {
      if (isWebview()) {
        throw new Error("Desktop backend unavailable");
      }
      const baseline = getMockSnapshot();
      const startedAt = formatDisplayTime(new Date());
      setMockSnapshot({
        ...baseline,
        pullActive: true,
        logs: [{ time: startedAt, message: "Manual pull started", level: "INFO" }, ...baseline.logs]
      });
      window.setTimeout(() => {
        const current = getMockSnapshot();
        const finishedAt = formatDisplayTime(new Date());
        setMockSnapshot({
          ...current,
          pullActive: false,
          lastPullAt: new Date().toISOString(),
          lastPull: finishedAt,
          logs: [
            { time: finishedAt, message: "Data update completed", level: "INFO" },
            ...current.logs
          ]
        });
      }, 700);
      return { ok: true };
    }
    return api.pull_now();
  },
  syncNow: async () => {
    const api = await withApi();
    if (!api || !hasMethod(api, "sync_now")) {
      if (isWebview()) {
        throw new Error("Desktop backend unavailable");
      }
      const baseline = getMockSnapshot();
      const startedAt = formatDisplayTime(new Date());
      setMockSnapshot({
        ...baseline,
        syncActive: true,
        logs: [{ time: startedAt, message: "Manual sync started", level: "INFO" }, ...baseline.logs]
      });
      window.setTimeout(() => {
        const current = getMockSnapshot();
        const finishedAt = formatDisplayTime(new Date());
        const outputDir = String(current.outputDir || "").trim();
        if (!outputDir) {
          setMockSnapshot({
            ...current,
            syncActive: false,
            logs: [{ time: finishedAt, message: "Sync skipped (no output dir)", level: "WARN" }, ...current.logs]
          });
          return;
        }
        const lastSyncAt = new Date().toISOString();
        setMockOutputLastSync(outputDir, { lastSyncAt, lastSync: finishedAt });
        setMockSnapshot({
          ...current,
          syncActive: false,
          lastSyncAt,
          lastSync: finishedAt,
          logs: [{ time: finishedAt, message: "Sync completed", level: "INFO" }, ...current.logs]
        });
      }, 700);
      return { ok: true };
    }
    return api.sync_now();
  },
  browseOutputDir: async () => {
    const api = await withApi();
    if (!api || !hasMethod(api, "browse_output_dir")) {
      if (isWebview()) {
        throw new Error("Desktop backend unavailable");
      }
      return { ok: true, path: getMockSnapshot().outputDir };
    }
    return api.browse_output_dir();
  },
  setOutputDir: async (path: string) => {
    const api = await withApi();
    if (!api || !hasMethod(api, "set_output_dir")) {
      if (isWebview()) {
        throw new Error("Desktop backend unavailable");
      }
      const value = String(path || "");
      const baseline = getMockSnapshot();
      const sync = value ? getMockOutputLastSync(value) : { lastSyncAt: "", lastSync: "Not yet" };
      setMockSnapshot({ ...baseline, outputDir: value, lastSyncAt: sync.lastSyncAt, lastSync: sync.lastSync });
      return { ok: true };
    }
    return api.set_output_dir(path);
  },
  setCurrency: async (value: string) => {
    const api = await withApi();
    if (!api || !hasMethod(api, "set_currency")) {
      if (isWebview()) {
        throw new Error("Desktop backend unavailable");
      }
      return { ok: true };
    }
    return api.set_currency(value);
  },
  clearLogs: async () => {
    const api = await withApi();
    if (!api || !hasMethod(api, "clear_logs")) {
      if (isWebview()) {
        throw new Error("Desktop backend unavailable");
      }
      return { ok: true };
    }
    return api.clear_logs();
  },
  dismissModal: async (id: string) => {
    const api = await withApi();
    if (!api || !hasMethod(api, "dismiss_modal")) {
      return { ok: true };
    }
    return api.dismiss_modal({ id });
  }
};
