import type { EventHistoryResponse, Settings, Snapshot } from "./types";
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
  get_event_history?: (payload: { event: string; cur: string }) => ApiResult<EventHistoryResponse>;
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
  open_release_notes?: () => ApiResult<{ ok: boolean; message?: string }>;
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

type TauriEventListen = (event: string, handler: (event: unknown) => void) => unknown;
type TauriEventUnlisten = (id: unknown) => unknown;

const isUiCheckRuntime = () => {
  if (typeof window === "undefined") return false;
  return (window as { __UI_CHECK_RUNTIME__?: boolean }).__UI_CHECK_RUNTIME__ === true;
};

const getTauriInvoke = () => {
  if (typeof window === "undefined") return null;
  const win = window as unknown as {
    __TAURI__?: { core?: { invoke?: unknown }; invoke?: unknown };
    __TAURI_INTERNALS__?: { invoke?: unknown };
  };
  const invoker =
    (win.__TAURI__?.core?.invoke as unknown) ??
    (win.__TAURI__?.invoke as unknown) ??
    (win.__TAURI_INTERNALS__?.invoke as unknown);
  return typeof invoker === "function"
    ? (invoker as <U>(cmd: string, args?: Record<string, unknown>) => Promise<U>)
    : null;
};

const isTauri = () => {
  return getTauriInvoke() !== null;
};

export const isWebview = () => {
  if (isUiCheckRuntime()) return false;
  return isTauri();
};

const getTauriListen = () => {
  if (typeof window === "undefined") return null;
  const win = window as unknown as {
    __TAURI__?: { event?: { listen?: unknown; unlisten?: unknown } };
    __TAURI_INTERNALS__?: { event?: { listen?: unknown; unlisten?: unknown } };
  };
  const listen =
    (win.__TAURI__?.event?.listen as unknown) ??
    (win.__TAURI_INTERNALS__?.event?.listen as unknown);
  return typeof listen === "function" ? (listen as TauriEventListen) : null;
};

const getTauriUnlisten = () => {
  if (typeof window === "undefined") return null;
  const win = window as unknown as {
    __TAURI__?: { event?: { unlisten?: unknown } };
    __TAURI_INTERNALS__?: { event?: { unlisten?: unknown } };
  };
  const unlisten =
    (win.__TAURI__?.event?.unlisten as unknown) ??
    (win.__TAURI_INTERNALS__?.event?.unlisten as unknown);
  return typeof unlisten === "function" ? (unlisten as TauriEventUnlisten) : null;
};

export const tauriListen = async <T,>(event: string, onPayload: (payload: T) => void) => {
  if (isUiCheckRuntime()) return null;
  const listen = getTauriListen();
  if (!listen) return null;

  const handler = (evt: unknown) => {
    const payload = (evt as { payload?: unknown } | null)?.payload ?? evt;
    onPayload(payload as T);
  };

  const res = listen(event, handler);

  if (typeof res === "function") {
    return res as () => void;
  }
  if (res && typeof (res as Promise<unknown>).then === "function") {
    const awaited = await (res as Promise<unknown>);
    if (typeof awaited === "function") return awaited as () => void;
    const unlisten = getTauriUnlisten();
    if (unlisten) {
      return () => {
        try {
          void unlisten(awaited);
        } catch {
          // Ignore.
        }
      };
    }
    return null;
  }

  const unlisten = getTauriUnlisten();
  if (!unlisten) return null;
  return () => {
    try {
      void unlisten(res);
    } catch {
      // Ignore.
    }
  };
};

const tauriInvoke = async <T,>(command: string, payload?: Record<string, unknown>) => {
  const invokeFn = getTauriInvoke();
  if (!invokeFn) {
    throw new Error("Tauri invoke unavailable");
  }
  const timeoutMs = 8000;
  return Promise.race([
    payload && Object.keys(payload).length > 0
      ? invokeFn<T>(command, payload)
      : invokeFn<T>(command),
    new Promise<T>((_, reject) => {
      window.setTimeout(() => {
        reject(new Error(`Tauri invoke timeout (${timeoutMs}ms): ${command}`));
      }, timeoutMs);
    })
  ]);
};

const tauriApiRef = (): BackendApi | null => {
  if (!isTauri()) return null;
  return new Proxy({} as BackendApi, {
    get: (_target, prop) => {
      if (typeof prop !== "string") return undefined;
      // Prevent the Proxy from being treated as a "thenable" (Promise-like) value.
      // Some async flows (e.g. `await withApi()`) will probe `.then` and accidentally invoke it.
      if (prop === "then") return undefined;
      return (...args: unknown[]) => {
        if (args.length === 0) return tauriInvoke(prop);
        const first = args[0];
        if (prop === "open_path" || prop === "set_output_dir" || prop === "set_temporary_path") {
          return tauriInvoke(prop, { path: String(first ?? "") });
        }
        if (prop === "set_currency") {
          return tauriInvoke(prop, { value: String(first ?? "") });
        }
        if (prop === "open_url") {
          return tauriInvoke(prop, { url: String(first ?? "") });
        }
        return tauriInvoke(prop, { payload: first as Record<string, unknown> });
      };
    }
  });
};

const desktopApiRef = () => tauriApiRef();

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

const withApi = async () => desktopApiRef();

const hasMethod = (api: BackendApi | null, key: keyof BackendApi) =>
  Boolean(api && typeof api[key] === "function");

const buildMockEventHistory = (payload: { event: string; cur: string }): EventHistoryResponse => {
  const points = (() => {
    const count = 120;
    const start = new Date(Date.UTC(2026, 0, 22));
    const pad = (value: number) => String(value).padStart(2, "0");
    const fmtDate = (dt: Date) =>
      `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;

    const result: Array<{
      date: string;
      time: string;
      actual: string;
      actualRaw: string;
      actualRevisedFrom: string;
      forecast: string;
      previous: string;
      previousRaw: string;
      previousRevisedFrom: string;
      period: string;
    }> = [];

    let lastPoint: (typeof result)[number] | null = null;
    // Build oldest -> newest to match backend sorting expectations.
    for (let i = count - 1; i >= 0; i -= 1) {
      const dt = new Date(start);
      dt.setUTCDate(start.getUTCDate() - i * 7);
      const actualK = 220 + Math.round(Math.sin(i / 5) * 12 + (i % 4) * 2);
      const forecastK = 221 + Math.round(Math.cos(i / 6) * 10 - (i % 3));
      const monthTokens = [
        "jan",
        "feb",
        "mar",
        "apr",
        "may",
        "jun",
        "jul",
        "aug",
        "sep",
        "oct",
        "nov",
        "dec"
      ] as const;
      const period = monthTokens[dt.getUTCMonth()] ?? "";

      const actualRaw = `${actualK}k`;
      const forecast = `${forecastK}k`;
      const previousBase = lastPoint && i % 17 !== 0 ? lastPoint.actual : "--";
      let previous = previousBase;
      let previousRaw = previousBase;
      let previousRevisedFrom = "";

      // Simulate occasional revisions: the newer row's Previous value revises the older
      // row's Actual. Keep the old value in `actualRevisedFrom` and surface the revision
      // under the newer row's Previous.
      if (lastPoint && previousBase !== "--" && i % 23 === 0) {
        const base = Number(lastPoint.actualRaw.replace(/k/i, ""));
        const revised = Number.isFinite(base) ? Math.max(0, base - 3) : base;
        const revisedValue = `${revised}k`;
        previous = revisedValue;
        previousRaw = revisedValue;
        previousRevisedFrom = lastPoint.actualRaw;
        lastPoint.actualRevisedFrom = lastPoint.actualRaw;
        lastPoint.actual = revisedValue;
      }

      const point = {
        date: fmtDate(dt),
        time: "08:30",
        actual: actualRaw,
        actualRaw,
        actualRevisedFrom: "",
        forecast,
        previous,
        previousRaw,
        previousRevisedFrom,
        period
      };
      result.push(point);
      lastPoint = point;
    }
    return result;
  })();

  return {
    ok: true,
    eventId: "mock",
    metric: payload.event,
    frequency: "m/m",
    period: "",
    cur: payload.cur,
    points
  };
};

export const backend = {
  getSnapshot: async (): ApiResult<Snapshot> => {
    if (isTauri()) {
      return tauriInvoke("get_snapshot");
    }
    if (isWebview() && !isUiCheckRuntime()) {
      throw new Error("Desktop backend unavailable");
    }
    return Promise.resolve(getMockSnapshot());
  },
  getEventHistory: async (payload: { event: string; cur: string }) => {
    if (isUiCheckRuntime()) {
      return Promise.resolve(buildMockEventHistory(payload));
    }
    const api = await withApi();
    if (!api || !hasMethod(api, "get_event_history")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return Promise.resolve(buildMockEventHistory(payload));
    }
    // Tauri invoke proxy wraps method args as `{ payload: ... }`, so align with that shape.
    return api.get_event_history({ event: payload.event, cur: payload.cur } as any);
  },
  getUpdateState: async () => {
    const api = await withApi();
    if (!api || !hasMethod(api, "get_update_state")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return Promise.resolve(getMockUpdateState());
    }
    return api.get_update_state();
  },
  checkUpdates: async () => {
    const api = await withApi();
    if (!api || !hasMethod(api, "check_updates")) {
      if (isWebview() && !isUiCheckRuntime()) {
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
      if (isWebview() && !isUiCheckRuntime()) {
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
          setMockUpdateState({ phase: "installing", message: "Installing...", progress: 1 });
          window.setTimeout(() => {
            setMockUpdateState({ phase: "downloaded", message: "Install complete", progress: 1 });
          }, 800);
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
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return Promise.resolve(mockSettings);
    }
    return api.get_settings();
  },
  saveSettings: async (payload: Settings) => {
    const api = await withApi();
    if (!api || !hasMethod(api, "save_settings")) {
      if (isWebview() && !isUiCheckRuntime()) {
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
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return { ok: true };
    }
    return api.open_log();
  },
  openPath: async (path: string) => {
    const api = await withApi();
    if (!api || !hasMethod(api, "open_path")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return { ok: true };
    }
    return api.open_path(path);
  },
  openUrl: async (url: string) => {
    const api = await withApi();
    if (!api || !hasMethod(api, "open_url")) {
      if (isWebview() && !isUiCheckRuntime()) {
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
  openReleaseNotes: async () => {
    const api = await withApi();
    if (!api || !hasMethod(api, "open_release_notes")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return { ok: false, message: "Release notes not available" };
    }
    return api.open_release_notes();
  },
  addLog: async (payload: { message: string; level?: string }) => {
    const api = await withApi();
    if (!api || !hasMethod(api, "add_log")) {
      if (isWebview() && !isUiCheckRuntime()) {
        return { ok: false };
      }
      return { ok: true };
    }
    return api.add_log(payload);
  },
  browseTemporaryPath: async () => {
    const api = await withApi();
    if (!api || !hasMethod(api, "browse_temporary_path")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return { ok: true, path: "" };
    }
    return api.browse_temporary_path();
  },
  setTemporaryPathPath: async (path: string) => {
    const api = await withApi();
    if (!api || !hasMethod(api, "set_temporary_path")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return { ok: true };
    }
    return api.set_temporary_path(path);
  },
  getTemporaryPathTask: async () => {
    const api = await withApi();
    if (!api || !hasMethod(api, "get_temporary_path_task")) {
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return { ok: true, active: false, phase: "idle", progress: 0, message: "", path: "" };
    }
    return api.get_temporary_path_task();
  },
  probeTemporaryPath: async (payload: { enableTemporaryPath: boolean; temporaryPath: string; autoStart?: boolean }) => {
    const api = await withApi();
    if (!api || !hasMethod(api, "probe_temporary_path")) {
      if (isWebview() && !isUiCheckRuntime()) {
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
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return { ok: true };
    }
    return api.temporary_path_use_as_is({ temporaryPath });
  },
  temporaryPathReset: async (temporaryPath: string) => {
    const api = await withApi();
    if (!api || !hasMethod(api, "temporary_path_reset")) {
      if (isWebview() && !isUiCheckRuntime()) {
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
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return { ok: true };
    }
    return api.uninstall(payload);
  },
  pullNow: async () => {
    const api = await withApi();
    if (!api || !hasMethod(api, "pull_now")) {
      if (isWebview() && !isUiCheckRuntime()) {
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
      if (isWebview() && !isUiCheckRuntime()) {
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
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return { ok: true, path: getMockSnapshot().outputDir };
    }
    return api.browse_output_dir();
  },
  setOutputDir: async (path: string) => {
    const api = await withApi();
    if (!api || !hasMethod(api, "set_output_dir")) {
      if (isWebview() && !isUiCheckRuntime()) {
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
      if (isWebview() && !isUiCheckRuntime()) {
        throw new Error("Desktop backend unavailable");
      }
      return { ok: true };
    }
    return api.set_currency(value);
  },
  clearLogs: async () => {
    const api = await withApi();
    if (!api || !hasMethod(api, "clear_logs")) {
      if (isWebview() && !isUiCheckRuntime()) {
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
