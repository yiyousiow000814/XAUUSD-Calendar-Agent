import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useCallback } from "react";
import { backend, isWebview } from "./api";
import type { FilterOption, Settings, Snapshot, ToastType } from "./types";
import { ActivityDrawer } from "./components/ActivityDrawer";
import { ActivityLog } from "./components/ActivityLog";
import { AlertModal } from "./components/AlertModal";
import { AppBar } from "./components/AppBar";
import { Footer } from "./components/Footer";
import { HistoryPanel } from "./components/HistoryPanel";
import { InitOverlay } from "./components/InitOverlay";
import { NextEvents } from "./components/NextEvents";
import { SettingsModal } from "./components/SettingsModal";
import { SyncRepoWarningModal, type SyncRepoWarningMode } from "./components/SyncRepoWarningModal";
import { ToastStack } from "./components/ToastStack";
import { UninstallModal } from "./components/UninstallModal";
import { impactTone, levelTone } from "./utils/ui";
import "./App.css";

const defaultCurrencyOptions = ["ALL", "USD", "EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "NZD"];

const normalizeCurrencyOptions = (options: string[]) => {
  const normalized = options.map((value) => value.toUpperCase());
  if (normalized.length < 3) {
    return defaultCurrencyOptions;
  }
  const seen = new Set(normalized);
  const ordered = defaultCurrencyOptions.filter((item) => seen.has(item));
  const extras = normalized.filter((item) => !ordered.includes(item));
  return [...ordered, ...extras];
};

const emptySnapshot: Snapshot = {
  lastPull: "Not yet",
  lastSync: "Not yet",
  outputDir: "",
  repoPath: "",
  currency: "USD",
  currencyOptions: defaultCurrencyOptions,
  events: [],
  pastEvents: [],
  logs: [],
  version: "0.0.0",
  restartInSeconds: 0
};

const emptySettings: Settings = {
  autoSyncAfterPull: true,
  autoUpdateEnabled: true,
  runOnStartup: true,
  debug: false,
  autoSave: true,
  splitRatio: 0.66,
  enableSystemTheme: true,
  theme: "system",
  enableSyncRepo: false,
  syncRepoPath: "",
  repoPath: "",
  logPath: "",
  removeLogs: true,
  removeOutput: false,
  removeSyncRepos: true,
  uninstallConfirm: ""
};

type SyncRepoWarningContext = {
  mode: SyncRepoWarningMode;
  status: string;
  message: string;
  path: string;
  details?: string;
  canUseAsIs: boolean;
  canReset: boolean;
};

type AlertContext = {
  id: string;
  title: string;
  message: string;
  tone: "info" | "error";
};

export default function App() {
  const isUiCheckRuntime = useMemo(() => {
    try {
      return Boolean(
        (window as unknown as { __UI_CHECK_RUNTIME__?: boolean }).__UI_CHECK_RUNTIME__
      );
    } catch {
      return false;
    }
  }, []);
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot);
  const [restartCountdown, setRestartCountdown] = useState<number>(0);
  const [restartPillState, setRestartPillState] = useState<"hidden" | "visible" | "closing">(
    "hidden"
  );
  const [updateState, setUpdateState] = useState<{
    phase: string;
    message: string;
    progress: number;
    availableVersion: string;
    lastCheckedAt: string;
  }>(() => ({ phase: "idle", message: "", progress: 0, availableVersion: "", lastCheckedAt: "" }));
  const [settings, setSettings] = useState<Settings>(emptySettings);
  const [savedSettings, setSavedSettings] = useState<Settings>(emptySettings);
  const [filter, setFilter] = useState<FilterOption>("ALL");
  const [outputDir, setOutputDir] = useState<string>("");
  const [currency, setCurrency] = useState<string>("USD");
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  const [settingsClosing, setSettingsClosing] = useState<boolean>(false);
  const [settingsEntering, setSettingsEntering] = useState<boolean>(false);
  const [activityOpen, setActivityOpen] = useState<boolean>(false);
  const [activityClosing, setActivityClosing] = useState<boolean>(false);
  const [activityEntering, setActivityEntering] = useState<boolean>(false);
  const [activityOriginRect, setActivityOriginRect] = useState<DOMRect | null>(null);
  const [splitRatio, setSplitRatio] = useState<number>(0.66);
  const splitRatioRef = useRef(splitRatio);
  const splitGutterPx = 30;
  const [uninstallOpen, setUninstallOpen] = useState<boolean>(false);
  const [uninstallClosing, setUninstallClosing] = useState<boolean>(false);
  const [uninstallEntering, setUninstallEntering] = useState<boolean>(false);
  const [syncRepoNote, setSyncRepoNote] = useState<{
    tone: "info" | "warn" | "error";
    text: string;
  } | null>(null);
  const [syncRepoWarningOpen, setSyncRepoWarningOpen] = useState<boolean>(false);
  const [syncRepoWarningClosing, setSyncRepoWarningClosing] = useState<boolean>(false);
  const [syncRepoWarningEntering, setSyncRepoWarningEntering] = useState<boolean>(false);
  const [syncRepoWarningContext, setSyncRepoWarningContext] = useState<SyncRepoWarningContext | null>(
    null
  );
  const [alertOpen, setAlertOpen] = useState<boolean>(false);
  const [alertClosing, setAlertClosing] = useState<boolean>(false);
  const [alertEntering, setAlertEntering] = useState<boolean>(false);
  const [alertCountdown, setAlertCountdown] = useState<number>(0);
  const [alertCountdownArmed, setAlertCountdownArmed] = useState<boolean>(false);
  const [alertContext, setAlertContext] = useState<AlertContext | null>(null);
  const [syncRepoTask, setSyncRepoTask] = useState<{
    active: boolean;
    phase: string;
    progress: number;
    message: string;
    path: string;
  }>({ active: false, phase: "idle", progress: 0, message: "", path: "" });
  const [syncRepoDisplayActive, setSyncRepoDisplayActive] = useState(false);
  const [syncRepoDisplayProgress, setSyncRepoDisplayProgress] = useState(0);
  const [syncRepoDisplayMessage, setSyncRepoDisplayMessage] = useState("");
  const syncRepoDisplayStartRef = useRef<number | null>(null);
  const syncRepoDisplayTimerRef = useRef<number | null>(null);
  const syncRepoDisplayFinishTimerRef = useRef<number | null>(null);
  const [initState, setInitState] = useState<"loading" | "ready" | "error">("loading");
  const [initError, setInitError] = useState<string>("");
  const initOverlayHoldAppliedRef = useRef(false);
  const [connecting, setConnecting] = useState<boolean>(isWebview());
  const [pullState, setPullState] = useState<"idle" | "loading" | "success" | "error">(
    "idle"
  );
  const [syncState, setSyncState] = useState<"idle" | "loading" | "success" | "error">(
    "idle"
  );
  const [savingState, setSavingState] = useState<"idle" | "saving" | "saved" | "error">(
    "idle"
  );
  const [savingMessage, setSavingMessage] = useState<string>("");
  const [toasts, setToasts] = useState<
    { id: number; type: ToastType; message: string; closing?: boolean }[]
  >([]);
  const [latestLogId, setLatestLogId] = useState<string>("");
  const prefersDark = useRef<MediaQueryList | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const resetTimerRef = useRef<number | null>(null);
  const splitRatioSaveTimerRef = useRef<number | null>(null);
  const themeTransitionTimerRef = useRef<number | null>(null);
  const themeSwapTimerRef = useRef<number | null>(null);
  const allowThemeAnimationRef = useRef(false);
  const pendingPathsScrollRef = useRef(false);
  const pathsRef = useRef<HTMLDivElement | null>(null);
  const splitRef = useRef<HTMLDivElement | null>(null);
  const splitDragRef = useRef<boolean>(false);
  const activityFabRef = useRef<HTMLButtonElement | null>(null);
  const settingsRef = useRef<Settings>(emptySettings);
  const savedSettingsRef = useRef<Settings>(emptySettings);
  const settingsOpenRef = useRef(false);
  const dirtySyncRepoRef = useRef(false);
  const dirtyOutputDirRef = useRef(false);
  const backendSyncRepoPathRef = useRef("");
  const hasLoadedSettingsRef = useRef(false);
  const updatePollTimerRef = useRef<number | null>(null);
  const syncRepoTaskPollTimerRef = useRef<number | null>(null);
  const syncRepoStartupProbeDoneRef = useRef(false);
  const startupSyncRepoEnabledRef = useRef(false);
  const startupSyncRepoPathRef = useRef("");
  const startupSyncRepoCapturedRef = useRef(false);
  const eventRetryRef = useRef(0);
  const eventRetryTimerRef = useRef<number | null>(null);
  const hasManualCurrencyRef = useRef(false);
  const refreshInFlightRef = useRef(false);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const hasLoadedUiPrefsRef = useRef(false);
  const activeAlertIdRef = useRef<string>("");
  const dismissedAlertIdRef = useRef<string>("");

  const refresh = async () => {
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    try {
      let data = await backend.getSnapshot();
      let prefs: Settings | null = null;
      if (!hasLoadedSettingsRef.current || settingsOpenRef.current) {
        prefs = await backend.getSettings();
      }
      if (!hasLoadedSettingsRef.current && prefs) {
        if (!startupSyncRepoCapturedRef.current) {
          startupSyncRepoCapturedRef.current = true;
          startupSyncRepoEnabledRef.current = Boolean(prefs.enableSyncRepo);
          startupSyncRepoPathRef.current = prefs.syncRepoPath || "";
        }
        hasLoadedSettingsRef.current = true;
      }
      let normalizedOptions = normalizeCurrencyOptions(data.currencyOptions || []);
      const nextCurrency = (() => {
        if (!hasManualCurrencyRef.current) {
          if (normalizedOptions.includes("USD")) return "USD";
          if (normalizedOptions.includes("ALL")) return "ALL";
          if (normalizedOptions.length) return normalizedOptions[0];
          return "USD";
        }
        const base = (data.currency || currency || "USD").toUpperCase();
        if (normalizedOptions.includes(base)) return base;
        if (normalizedOptions.includes("USD")) return "USD";
        if (normalizedOptions.includes("ALL")) return "ALL";
        if (normalizedOptions.length) return normalizedOptions[0];
        return "USD";
      })();

      if (nextCurrency !== data.currency) {
        await backend.setCurrency(nextCurrency);
        const refreshed = await backend.getSnapshot();
        data = { ...refreshed, currency: nextCurrency };
        normalizedOptions = normalizeCurrencyOptions(data.currencyOptions || []);
      }

      if (prefs) {
        backendSyncRepoPathRef.current = prefs.syncRepoPath || "";
      }
      setSnapshot(data);
      const modal = data.modal;
      if (
        modal &&
        modal.id &&
        modal.id !== activeAlertIdRef.current &&
        modal.id !== dismissedAlertIdRef.current
      ) {
        openAlertModal({
          id: modal.id,
          title: modal.title || "Notice",
          message: modal.message || "",
          tone: modal.tone || "info"
        });
      }
      if (!settingsOpenRef.current) {
        if (prefs) {
          setSettings(prefs);
          setSavedSettings(prefs);
          if (!hasLoadedUiPrefsRef.current) {
            hasLoadedUiPrefsRef.current = true;
            const ratio = typeof prefs.splitRatio === "number" ? prefs.splitRatio : 0.66;
            setSplitRatio(Math.min(0.75, Math.max(0.55, ratio)));
          }
        }
        setOutputDir(data.outputDir || "");
      } else {
        setSettings((prev) => {
          const next = {
            ...prev,
            repoPath: prefs?.repoPath ?? prev.repoPath,
            logPath: prefs?.logPath ?? prev.logPath
          };
          if (!dirtySyncRepoRef.current) {
            if (prefs) {
              next.syncRepoPath = prefs.syncRepoPath;
              next.enableSyncRepo = prefs.enableSyncRepo;
            }
          }
          return next;
        });
        if (!dirtyOutputDirRef.current) {
          setOutputDir(data.outputDir || "");
        }
      }
      setCurrency(nextCurrency);
      setConnecting(false);
      try {
        const task = await backend.getSyncRepoTask();
        if (task && task.ok) {
          setSyncRepoTask({
            active: Boolean(task.active),
            phase: task.phase || "idle",
            progress: typeof task.progress === "number" ? task.progress : 0,
            message: task.message || "",
            path: task.path || ""
          });
          if (task.active) {
            if (!syncRepoTaskPollTimerRef.current) {
              startSyncRepoTaskPolling();
            }
          } else {
            stopSyncRepoTaskPolling();
          }
        }
      } catch {
        // Ignore.
      }

      if (!initOverlayHoldAppliedRef.current) {
        initOverlayHoldAppliedRef.current = true;
        const holdMs = Number(
          (window as unknown as { __ui_check__?: { holdInitOverlayMs?: number } }).__ui_check__
            ?.holdInitOverlayMs ?? 0
        );
        if (Number.isFinite(holdMs) && holdMs > 0) {
          await new Promise((resolve) => window.setTimeout(resolve, holdMs));
        }
      }

      setInitState("ready");
      setInitError("");
      backend.frontendBootComplete().catch(() => {});
    } catch (err) {
      const message = err instanceof Error ? err.message : "Initialization failed";
      setInitState("error");
      setInitError(message);
      setConnecting(false);
      console.error(err);
      backend
        .addLog({ message: `Frontend init error: ${message}`, level: "ERROR" })
        .catch(() => {});
    } finally {
      refreshInFlightRef.current = false;
    }
  };

  useEffect(() => {
    refreshRef.current = refresh;
  });

  const appendLogEntry = (message: string, level: string) => {
    const timestamp = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    const time = `${pad(timestamp.getDate())}-${pad(
      timestamp.getMonth() + 1
    )}-${timestamp.getFullYear()} ${pad(timestamp.getHours())}:${pad(
      timestamp.getMinutes()
    )}`;
    setSnapshot((prev) => ({
      ...prev,
      logs: [{ time, message, level: level.toUpperCase() }, ...prev.logs]
    }));
  };

  const formatSyncRepoDetails = (details?: Record<string, unknown>) => {
    if (!details) return undefined;

    const asTrimmedString = (value: unknown) => (typeof value === "string" ? value.trim() : "");

    const error = asTrimmedString(details.error);
    if (error) return error;

    const lines: string[] = [];
    const origin = asTrimmedString(details.origin);
    const expectedRepo = asTrimmedString(details.expectedRepo);
    const branch = asTrimmedString(details.branch);
    const head = asTrimmedString(details.head);
    const originMain = asTrimmedString(details.originMain);
    const note = asTrimmedString(details.note);

    if (origin) lines.push(`Detected origin: ${origin}`);
    if (expectedRepo) lines.push(`Expected repo: ${expectedRepo}`);
    if (branch) lines.push(`Current branch: ${branch}`);
    if (head) lines.push(`HEAD: ${head}`);
    if (originMain) lines.push(`origin/main: ${originMain}`);
    if (note) lines.push(note);

    return lines.length ? lines.join("\n") : undefined;
  };

  const stopUpdatePolling = () => {
    if (updatePollTimerRef.current) {
      window.clearInterval(updatePollTimerRef.current);
      updatePollTimerRef.current = null;
    }
  };

  const stopSyncRepoTaskPolling = () => {
    if (syncRepoTaskPollTimerRef.current) {
      window.clearInterval(syncRepoTaskPollTimerRef.current);
      syncRepoTaskPollTimerRef.current = null;
    }
  };

  const refreshSyncRepoTask = async () => {
    try {
      const next = await backend.getSyncRepoTask();
      if (!next || !next.ok) return;
      setSyncRepoTask({
        active: Boolean(next.active),
        phase: next.phase || "idle",
        progress: typeof next.progress === "number" ? next.progress : 0,
        message: next.message || "",
        path: next.path || ""
      });
      if (!next.active) {
        stopSyncRepoTaskPolling();
      }
    } catch {
      // Ignore transient backend errors.
    }
  };

  const startSyncRepoTaskPolling = () => {
    stopSyncRepoTaskPolling();
    void refreshSyncRepoTask();
    syncRepoTaskPollTimerRef.current = window.setInterval(() => {
      void refreshSyncRepoTask();
    }, 180);
  };

  const closeSyncRepoWarningModal = () => {
    setSyncRepoWarningClosing(true);
    window.setTimeout(() => {
      setSyncRepoWarningOpen(false);
      setSyncRepoWarningClosing(false);
      setSyncRepoWarningEntering(false);
      setSyncRepoWarningContext(null);
    }, 240);
  };

  const openSyncRepoWarningModal = (context: SyncRepoWarningContext) => {
    setSyncRepoWarningContext(context);
    setSyncRepoWarningOpen(true);
    setSyncRepoWarningClosing(false);
    setSyncRepoWarningEntering(true);
  };

  const closeAlertModal = useCallback(() => {
    const id = activeAlertIdRef.current;
    if (id) {
      void backend.dismissModal(id);
    }
    if (id) {
      dismissedAlertIdRef.current = id;
    }
    activeAlertIdRef.current = "";
    setAlertClosing(true);
    window.setTimeout(() => {
      setAlertOpen(false);
      setAlertClosing(false);
      setAlertEntering(false);
      setAlertContext(null);
      setAlertCountdown(0);
      setAlertCountdownArmed(false);
    }, 240);
  }, []);

  const openAlertModal = useCallback((context: AlertContext) => {
    activeAlertIdRef.current = context.id;
    setAlertContext(context);
    setAlertOpen(true);
    setAlertClosing(false);
    setAlertEntering(true);
    setAlertCountdown(5);
    setAlertCountdownArmed(false);
  }, []);

  const refreshUpdateState = async () => {
    try {
      const next = await backend.getUpdateState();
      if (!next || !next.ok) return;
      setUpdateState((prev) => ({
        ...prev,
        phase: next.phase || "idle",
        message: next.message || "",
        progress: typeof next.progress === "number" ? next.progress : 0,
        availableVersion: next.availableVersion || "",
        lastCheckedAt: next.lastCheckedAt || prev.lastCheckedAt
      }));
    } catch {
      // Ignore transient backend errors (closing/restarting).
    }
  };

  const startUpdatePolling = (shouldStop: (phase: string) => boolean) => {
    stopUpdatePolling();
    void refreshUpdateState();
    updatePollTimerRef.current = window.setInterval(async () => {
      try {
        const next = await backend.getUpdateState();
        if (!next || !next.ok) return;
        const phase = next.phase || "idle";
        setUpdateState((prev) => ({
          ...prev,
          phase,
          message: next.message || "",
          progress: typeof next.progress === "number" ? next.progress : 0,
          availableVersion: next.availableVersion || "",
          lastCheckedAt: next.lastCheckedAt || prev.lastCheckedAt
        }));
        if (shouldStop(phase)) {
          stopUpdatePolling();
        }
      } catch {
        // Ignore.
      }
    }, 180);
  };

  useEffect(() => {
    const boot = window.requestAnimationFrame(() => {
      void refresh();
    });
    return () => {
      window.cancelAnimationFrame(boot);
      stopSyncRepoTaskPolling();
    };
  }, []);

  useEffect(() => {
    if (isUiCheckRuntime) return;

    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail as
        | {
            id?: string;
            title?: string;
            message?: string;
            tone?: "info" | "error";
          }
        | undefined;

      const id = (detail?.id || "").trim();
      if (!id) return;
      if (id === dismissedAlertIdRef.current) return;
      if (id === activeAlertIdRef.current) return;

      openAlertModal({
        id,
        title: detail?.title || "Notice",
        message: detail?.message || "",
        tone: detail?.tone === "error" ? "error" : "info"
      });
    };

    window.addEventListener("xauusd:modal", handler as EventListener);
    return () => {
      window.removeEventListener("xauusd:modal", handler as EventListener);
    };
  }, [isUiCheckRuntime, openAlertModal]);

  useEffect(() => {
    if (initState !== "ready" || isUiCheckRuntime) return;
    let timer: number | null = null;
    let cancelled = false;

    const schedule = () => {
      if (cancelled) return;
      const focused = document.visibilityState === "visible" && document.hasFocus();
      const delay = focused ? 1200 : 8000;
      timer = window.setTimeout(() => {
        void refreshRef.current();
        schedule();
      }, delay);
    };

    schedule();

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [initState, isUiCheckRuntime]);

  useEffect(() => {
    if (initState !== "ready" || isUiCheckRuntime) return;
    const onFocus = () => {
      void refreshRef.current();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void refreshRef.current();
      }
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [initState, isUiCheckRuntime]);

  useEffect(() => {
    const stopTimers = () => {
      if (syncRepoDisplayTimerRef.current) {
        window.clearInterval(syncRepoDisplayTimerRef.current);
        syncRepoDisplayTimerRef.current = null;
      }
      if (syncRepoDisplayFinishTimerRef.current) {
        window.clearInterval(syncRepoDisplayFinishTimerRef.current);
        syncRepoDisplayFinishTimerRef.current = null;
      }
    };

    const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
    const backendProgress = clamp01(syncRepoTask.progress);

    if (syncRepoTask.active) {
      if (!syncRepoDisplayStartRef.current) {
        syncRepoDisplayStartRef.current = Date.now();
      }
      stopTimers();
      setSyncRepoDisplayActive(true);
      setSyncRepoDisplayMessage(syncRepoTask.message || "Cloning...");
      setSyncRepoDisplayProgress((prev) => Math.max(prev, backendProgress, 0.08));

      if (!syncRepoDisplayTimerRef.current) {
        syncRepoDisplayTimerRef.current = window.setInterval(() => {
          setSyncRepoDisplayProgress((prev) => {
            const base = Math.max(prev, backendProgress);
            if (base >= 0.9) return base;
            const next = base + 0.00115;
            return Math.min(0.9, next);
          });
          if (!syncRepoTask.message) {
            setSyncRepoDisplayMessage("Cloning...");
          }
        }, 180);
      }
      return stopTimers;
    }

    if (!syncRepoDisplayActive) {
      stopTimers();
      syncRepoDisplayStartRef.current = null;
      setSyncRepoDisplayProgress(0);
      setSyncRepoDisplayMessage("");
      return stopTimers;
    }

    stopTimers();

    const finishing = syncRepoTask.phase === "ready";
    if (!finishing) {
      syncRepoDisplayStartRef.current = null;
      setSyncRepoDisplayActive(false);
      setSyncRepoDisplayProgress(0);
      setSyncRepoDisplayMessage("");
      return stopTimers;
    }

    const start = Date.now();
    const startProgress = syncRepoDisplayProgress;
    setSyncRepoDisplayMessage("Finalizing...");
    syncRepoDisplayFinishTimerRef.current = window.setInterval(() => {
      const elapsed = Date.now() - start;
      const t = Math.max(0, Math.min(1, elapsed / 1000));
      const easeOut = 1 - Math.pow(1 - t, 3);
      const next = startProgress + (1 - startProgress) * easeOut;
      setSyncRepoDisplayProgress(next);
      if (t >= 1) {
        stopTimers();
        window.setTimeout(() => {
          syncRepoDisplayStartRef.current = null;
          setSyncRepoDisplayActive(false);
          setSyncRepoDisplayProgress(0);
          setSyncRepoDisplayMessage("");
        }, 220);
      }
    }, 16);

    return stopTimers;
  }, [syncRepoTask.active, syncRepoTask.phase, syncRepoTask.progress, syncRepoTask.message, syncRepoDisplayActive, syncRepoDisplayProgress]);

  useEffect(() => {
    if (initState !== "ready") return;
    if (syncRepoStartupProbeDoneRef.current) return;
    if (!startupSyncRepoCapturedRef.current) return;
    if (!startupSyncRepoEnabledRef.current) return;
    syncRepoStartupProbeDoneRef.current = true;
    (async () => {
      try {
        const probe = await backend.probeSyncRepo({
          enableSyncRepo: true,
          syncRepoPath: startupSyncRepoPathRef.current,
          autoStart: true
        });
        if (probe.action === "auto-clone-started" || probe.taskActive) {
          startSyncRepoTaskPolling();
        }
        if (probe.needsConfirmation) {
          openSyncRepoWarningModal({
            mode: "startup",
            status: probe.status,
            message: probe.message || "Sync repo needs confirmation",
            path: probe.path || startupSyncRepoPathRef.current || "",
            details: formatSyncRepoDetails(probe.details),
            canUseAsIs: Boolean(probe.canUseAsIs),
            canReset: Boolean(probe.canReset)
          });
        }
      } catch {
        // Ignore startup probe failures.
      }
    })();
  }, [initState]);

  useEffect(() => {
    const seconds = snapshot.restartInSeconds ?? 0;
    if (!seconds) {
      setRestartCountdown(0);
      return;
    }

    const deadline = Date.now() + seconds * 1000;
    setRestartCountdown(seconds);
    const timer = window.setInterval(() => {
      const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setRestartCountdown(remaining);
      if (remaining <= 0) {
        window.clearInterval(timer);
      }
    }, 250);
    return () => window.clearInterval(timer);
  }, [snapshot.restartInSeconds]);

  useEffect(() => {
    if (restartCountdown > 0) {
      setRestartPillState("visible");
      return;
    }
    setRestartPillState((prev) => {
      if (prev !== "visible") return prev;
      return "closing";
    });
    const timer = window.setTimeout(() => {
      setRestartPillState((prev) => (prev === "closing" ? "hidden" : prev));
    }, 240);
    return () => window.clearTimeout(timer);
  }, [restartCountdown]);

  useEffect(() => {
    if (!settingsOpen) {
      stopUpdatePolling();
      setSyncRepoNote(null);
      return;
    }
    void refreshUpdateState();
    return () => stopUpdatePolling();
  }, [settingsOpen]);

  useEffect(() => {
    if (!settingsOpen) return;
    const currentPath = (settings.syncRepoPath || "").trim().toLowerCase();
    const taskPath = (syncRepoTask.path || "").trim().toLowerCase();
    const taskForThisPath = Boolean(syncRepoTask.active && currentPath && taskPath === currentPath);
    if (taskForThisPath) {
      setSyncRepoNote({
        tone: "info",
        text: "Sync repo is cloning. Check Activity for progress."
      });
      return;
    }
    if (!settings.enableSyncRepo) {
      setSyncRepoNote(null);
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const probe = await backend.probeSyncRepo({
          enableSyncRepo: true,
          syncRepoPath: settings.syncRepoPath,
          autoStart: false
        });
        if (cancelled) return;
        if (probe.status === "unsafe") {
          setSyncRepoNote({
            tone: "error",
            text: probe.message || "Sync Repo path overlaps Main Path. Choose a separate folder."
          });
          return;
        }
        if (probe.needsConfirmation) {
          setSyncRepoNote({
            tone: "warn",
            text: "Action required: click Review to resolve Sync Repo."
          });
          return;
        }
        if (probe.status === "missing" || probe.status === "empty") {
          setSyncRepoNote({
            tone: "info",
            text: "Folder will be cloned automatically after you close Settings."
          });
          return;
        }
        setSyncRepoNote(null);
      } catch {
        if (cancelled) return;
        setSyncRepoNote(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [settingsOpen, settings.enableSyncRepo, settings.syncRepoPath, syncRepoTask.active, syncRepoTask.path]);

  useEffect(() => {
    if (updateState.phase !== "restarting") return;
    if (settingsOpenRef.current) {
      closeSettingsModal();
    }
    refresh();
    const timers = [120, 380, 900, 1700].map((delay) =>
      window.setTimeout(() => {
        refresh();
      }, delay)
    );
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [updateState.phase]);

  const filteredLogs = useMemo(() => {
    if (filter === "ALL") return snapshot.logs;
    return snapshot.logs.filter((log) => log.level === filter);
  }, [snapshot.logs, filter]);

  const handleBrowse = async () => {
    const result = await backend.browseOutputDir();
    if (result.ok && result.path) {
      dirtyOutputDirRef.current = true;
      setOutputDir(result.path);
      await backend.setOutputDir(result.path);
      await refresh();
    }
  };

  const pushToast = (type: "success" | "error" | "info", message: string) => {
    const id = Date.now();
    setToasts((prev) => [...prev, { id, type, message }]);
    window.setTimeout(() => {
      setToasts((prev) =>
        prev.map((toast) => (toast.id === id ? { ...toast, closing: true } : toast))
      );
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((toast) => toast.id !== id));
      }, 220);
    }, 2200);
  };

  const handlePull = async () => {
    setPullState("loading");
    try {
      await backend.pullNow();
      window.setTimeout(() => {
        setPullState("success");
        refresh();
        window.setTimeout(() => setPullState("idle"), 1700);
      }, 1400);
    } catch (err) {
      setPullState("error");
      pushToast("error", "Pull failed");
      window.setTimeout(() => setPullState("idle"), 1700);
    }
  };

  const handleSync = async () => {
    setSyncState("loading");
    try {
      await backend.syncNow();
      window.setTimeout(() => {
        setSyncState("success");
        refresh();
        window.setTimeout(() => {
          setSyncState("idle");
        }, 1700);
      }, 1400);
    } catch (err) {
      setSyncState("error");
      pushToast("error", "Sync failed");
      window.setTimeout(() => {
        setSyncState("idle");
      }, 1700);
    }
  };

  const handleCheckUpdates = async () => {
    const formatDisplayTime = (date: Date) => {
      const pad = (value: number) => String(value).padStart(2, "0");
      const dd = pad(date.getDate());
      const mm = pad(date.getMonth() + 1);
      const yyyy = String(date.getFullYear());
      const hh = pad(date.getHours());
      const min = pad(date.getMinutes());
      return `${dd}-${mm}-${yyyy} ${hh}:${min}`;
    };
    const optimisticLastChecked = formatDisplayTime(new Date());
    try {
      setUpdateState((prev) => ({
        ...prev,
        phase: "checking",
        progress: 0,
        lastCheckedAt: optimisticLastChecked
      }));
      await backend.checkUpdates();
      startUpdatePolling((phase) => phase !== "checking");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Update check failed";
      setUpdateState((prev) => ({
        ...prev,
        phase: "error",
        message
      }));
    }
  };

  const handleUpdateNow = async () => {
    try {
      const isInstall = updateState.phase === "downloaded";
      const result = await backend.updateNow();
      if (!result.ok) {
        setUpdateState((prev) => ({
          ...prev,
          phase: "error",
          message: result.message || "Update failed"
        }));
        return;
      }
      startUpdatePolling((phase) =>
        isInstall ? phase === "restarting" || phase === "error" : phase === "downloaded" || phase === "error"
      );
    } catch {
      setUpdateState((prev) => ({
        ...prev,
        phase: "error",
        message: "Update failed"
      }));
    }
  };

  const handleCurrency = async (value: string) => {
    hasManualCurrencyRef.current = true;
    setCurrency(value);
    await backend.setCurrency(value);
    await refresh();
  };

  const handleClear = async () => {
    await backend.clearLogs();
    await refresh();
  };

  const getResolvedTheme = () => {
    if (settings.theme !== "system") return settings.theme;
    if (typeof window !== "undefined" && window.matchMedia) {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    return "dark";
  };

  const applyResolvedTheme = (resolved: "light" | "dark") => {
    document.documentElement.dataset.theme = resolved;
  };

  const setThemeTransitionOrigin = () => {
    const root = document.documentElement;
    const source = document.querySelector("[data-qa*='qa:action:theme']") as HTMLElement | null;
    if (!source) {
      root.style.setProperty("--theme-vt-x", "50%");
      root.style.setProperty("--theme-vt-y", "50%");
      return;
    }
    const rect = source.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    root.style.setProperty("--theme-vt-x", `${x}px`);
    root.style.setProperty("--theme-vt-y", `${y}px`);
  };

  const applyResolvedThemeWithTransition = (resolved: "light" | "dark") => {
    if (!allowThemeAnimationRef.current) {
      applyResolvedTheme(resolved);
      return;
    }

    setThemeTransitionOrigin();

    const root = document.documentElement;
    if (root.dataset.theme === resolved) {
      applyResolvedTheme(resolved);
      return;
    }

    const parseCssDurationMs = (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return null;
      if (trimmed.endsWith("ms")) {
        const ms = Number(trimmed.slice(0, -2));
        return Number.isFinite(ms) ? ms : null;
      }
      if (trimmed.endsWith("s")) {
        const s = Number(trimmed.slice(0, -1));
        return Number.isFinite(s) ? s * 1000 : null;
      }
      const ms = Number(trimmed);
      return Number.isFinite(ms) ? ms : null;
    };

    const durationMs = (() => {
      const raw = window.getComputedStyle(root).getPropertyValue("--theme-duration");
      const ms = parseCssDurationMs(raw);
      if (ms === null || ms < 200 || ms > 4000) return 950;
      return ms;
    })();

    if (themeTransitionTimerRef.current) {
      window.clearTimeout(themeTransitionTimerRef.current);
      themeTransitionTimerRef.current = null;
    }
    if (themeSwapTimerRef.current) {
      window.clearTimeout(themeSwapTimerRef.current);
      themeSwapTimerRef.current = null;
    }

    const startViewTransition = (document as unknown as { startViewTransition?: unknown })
      .startViewTransition as ((callback: () => void) => { finished: Promise<void> }) | undefined;

    if (typeof startViewTransition === "function") {
      root.classList.add("theme-vt");
      const transition = startViewTransition.call(document, () => {
        applyResolvedTheme(resolved);
      });
      transition.finished.finally(() => {
        root.classList.remove("theme-vt");
      });
      themeTransitionTimerRef.current = window.setTimeout(() => {
        root.classList.remove("theme-vt");
        themeTransitionTimerRef.current = null;
      }, durationMs + 240);
      return;
    }

    root.classList.add("theme-transition");
    root.getBoundingClientRect();
    applyResolvedTheme(resolved);
    themeTransitionTimerRef.current = window.setTimeout(() => {
      root.classList.remove("theme-transition");
      themeTransitionTimerRef.current = null;
    }, durationMs + 240);
  };

  const toggleTheme = () => {
    setThemeTransitionOrigin();
    setSettings((prev) => {
      const cycle = prev.enableSystemTheme
        ? (["light", "dark", "system"] as Settings["theme"][])
        : (["light", "dark"] as Settings["theme"][]);
      const current =
        prev.theme === "system" ? (prev.enableSystemTheme ? "system" : resolvedTheme) : prev.theme;
      const index = cycle.indexOf(current);
      const nextTheme = cycle[(index + 1) % cycle.length] || cycle[0];
      const next = { ...prev, theme: nextTheme };
      if (prev.autoSave) {
        persistSettingsAutosafe(next);
      }
      return next;
    });
  };

  const isThemeOnlySettingsChange = (before: Settings, after: Settings) => {
    const keys = Object.keys(before) as (keyof Settings)[];
    for (const key of keys) {
      if (key === "theme" || key === "enableSystemTheme") continue;
      if (before[key] !== after[key]) return false;
    }
    return true;
  };

  const hasSettingsChanges = (before: Settings, after: Settings) => {
    const keys = Object.keys(before) as (keyof Settings)[];
    for (const key of keys) {
      if (before[key] !== after[key]) return true;
    }
    return false;
  };

  const persistSettings = async (payload: Settings) => {
    setSavingState("saving");
    setSavingMessage("Saving...");
    try {
      const result = await backend.saveSettings(payload);
      if (!result.ok) {
        throw new Error("save failed");
      }
      setSavingState("saved");
      setSavingMessage("Saved");
      setSavedSettings((prev) => ({
        ...payload,
        syncRepoPath: backendSyncRepoPathRef.current || prev.syncRepoPath
      }));
      window.setTimeout(() => {
        setSavingState("idle");
        setSavingMessage("");
      }, 1400);
      if (isWebview() && !isThemeOnlySettingsChange(savedSettings, payload)) {
        await refresh();
      }
      return true;
    } catch (err) {
      setSavingState("error");
      setSavingMessage("Save failed");
      pushToast("error", "Settings save failed");
      return false;
    }
  };

  const scheduleAutosave = (payload: Settings) => {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      persistSettingsAutosafe(payload);
    }, 600);
  };

  const handleSettingsSave = async () => {
    if (settings.syncRepoPath && settings.syncRepoPath !== savedSettings.syncRepoPath) {
      if (settings.enableSyncRepo) {
        await backend.setSyncRepoPath(settings.syncRepoPath);
        backendSyncRepoPathRef.current = settings.syncRepoPath;
      }
    }
    if (outputDir && outputDir !== snapshot.outputDir) {
      await backend.setOutputDir(outputDir);
    }
    const ok = await persistSettings(settings);
    if (ok) {
      closeSettingsModal();
    }
  };

  const handleSettingsCancel = () => {
    setSettings(savedSettings);
    setSavingState("idle");
    setSavingMessage("");
    closeSettingsModal();
  };

  const handleSyncRepoReview = async () => {
    try {
      const probe = await backend.probeSyncRepo({
        enableSyncRepo: true,
        syncRepoPath: settings.syncRepoPath,
        autoStart: false
      });
      if (probe.needsConfirmation) {
        openSyncRepoWarningModal({
          mode: "settings-close",
          status: probe.status,
          message: probe.message || "Sync repo needs confirmation",
          path: probe.path || settings.syncRepoPath || "",
          details: formatSyncRepoDetails(probe.details),
          canUseAsIs: Boolean(probe.canUseAsIs),
          canReset: Boolean(probe.canReset)
        });
      }
    } catch {
      // Ignore.
    }
  };

  const handleOpenLog = async () => {
    const result = await backend.openLog();
    if (!result.ok) {
      pushToast("error", result.message || "Failed to open log");
      return;
    }
    pushToast("info", "Opening log");
  };

  const handleCopyLog = async () => {
    try {
      await navigator.clipboard.writeText(settings.logPath);
      pushToast("success", "Log path copied");
    } catch (err) {
      pushToast("error", "Failed to copy log path");
    }
  };

  const handleOpenPath = async (path: string) => {
    const result = await backend.openPath(path);
    if (!result.ok) {
      pushToast("error", result.message || "Failed to open path");
      return;
    }
    pushToast("info", "Opening path");
  };

  // Auto-save is always enabled.

  const handleSyncRepoBrowse = async () => {
    const result = await backend.browseSyncRepo();
    if (result.ok && result.path) {
      dirtySyncRepoRef.current = true;
      setSettings((prev) => ({ ...prev, syncRepoPath: result.path }));
    }
  };

  const persistSettingsAutosafe = (payload: Settings) => {
    if (!dirtySyncRepoRef.current) {
      return persistSettings(payload);
    }
    const baseline = savedSettingsRef.current;
    return persistSettings({
      ...payload,
      enableSyncRepo: baseline.enableSyncRepo,
      syncRepoPath: baseline.syncRepoPath
    });
  };

  const smoothScrollTo = (container: HTMLElement, target: number, duration = 650) => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      container.scrollTop = target;
      return;
    }
    const start = container.scrollTop;
    const delta = target - start;
    const startTime = performance.now();
    const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
    const step = (now: number) => {
      const elapsed = Math.min(1, (now - startTime) / duration);
      container.scrollTop = start + delta * easeOut(elapsed);
      if (elapsed < 1) {
        requestAnimationFrame(step);
      }
    };
    requestAnimationFrame(step);
  };

  const openPathsInSettings = () => {
    pendingPathsScrollRef.current = true;
    openSettings();
  };

  const openSettings = () => {
    dirtySyncRepoRef.current = false;
    dirtyOutputDirRef.current = false;
    setSettings(savedSettings);
    setOutputDir(snapshot.outputDir || "");
    setSettingsOpen(true);
    setSettingsClosing(false);
    setSettingsEntering(true);
  };

  const closeSettingsModal = () => {
    setSettingsClosing(true);
    window.setTimeout(() => {
      setSettingsOpen(false);
      setSettingsClosing(false);
      setSettingsEntering(false);
    }, 240);
  };

  const handleSettingsClose = async () => {
    const shouldSaveEnableSyncRepo =
      settings.enableSyncRepo !== savedSettings.enableSyncRepo;
    const shouldSaveSyncRepo =
      settings.enableSyncRepo && settings.syncRepoPath !== savedSettings.syncRepoPath;
    const shouldSaveOutput = outputDir !== snapshot.outputDir;
    const shouldSaveSettings = !settings.autoSave && hasSettingsChanges(savedSettings, settings);
    const shouldProbeSyncRepo = settings.enableSyncRepo && (shouldSaveEnableSyncRepo || shouldSaveSyncRepo);
    const hasAnyChanges = shouldSaveEnableSyncRepo || shouldSaveSyncRepo || shouldSaveOutput || shouldSaveSettings;

    if (!hasAnyChanges) {
      closeSettingsModal();
      if (settings.enableSyncRepo) {
        try {
          const probe = await backend.probeSyncRepo({
            enableSyncRepo: true,
            syncRepoPath: settings.syncRepoPath,
            autoStart: true
          });
          if (probe.action === "auto-clone-started" || probe.taskActive) {
            startSyncRepoTaskPolling();
          }
        } catch {
          // Ignore probe failures on close.
        }
      }
      return;
    }

    try {
      const closeImmediately = shouldProbeSyncRepo;
      if (closeImmediately) {
        closeSettingsModal();
      }

      let effectiveSyncRepoPath = settings.syncRepoPath;
      if (shouldProbeSyncRepo) {
        const probe = await backend.probeSyncRepo({
          enableSyncRepo: true,
          syncRepoPath: effectiveSyncRepoPath,
          autoStart: true
        });
        if (probe.needsConfirmation) {
          openSyncRepoWarningModal({
            mode: "settings-close",
            status: probe.status,
            message: probe.message || "Sync repo needs confirmation",
            path: probe.path || effectiveSyncRepoPath || "",
            details: formatSyncRepoDetails(probe.details),
            canUseAsIs: Boolean(probe.canUseAsIs),
            canReset: Boolean(probe.canReset)
          });
          return;
        }
        if (!effectiveSyncRepoPath && probe.path) {
          effectiveSyncRepoPath = probe.path;
        }
        if (probe.action === "auto-clone-started" || probe.taskActive) {
          startSyncRepoTaskPolling();
        }
      }

      const shouldWriteSyncRepoPath =
        settings.enableSyncRepo &&
        Boolean(effectiveSyncRepoPath) &&
        effectiveSyncRepoPath !== savedSettings.syncRepoPath;
      if (shouldWriteSyncRepoPath) {
        await backend.setSyncRepoPath(effectiveSyncRepoPath);
        backendSyncRepoPathRef.current = effectiveSyncRepoPath;
      }
      if (shouldSaveOutput) {
        await backend.setOutputDir(outputDir);
      }

      if (shouldSaveEnableSyncRepo || shouldSaveSettings) {
        const ok = await persistSettings({ ...settings, syncRepoPath: effectiveSyncRepoPath });
        if (!ok) return;
      } else {
        // Keep local "saved" state aligned when we saved paths only.
        setSavedSettings({ ...settings, syncRepoPath: effectiveSyncRepoPath });
        setSavingState("saved");
        setSavingMessage("Saved");
        window.setTimeout(() => {
          setSavingState("idle");
          setSavingMessage("");
        }, 1400);
      }

      await refresh();
      if (!closeImmediately) {
        closeSettingsModal();
      }
    } catch (err) {
      setSavingState("error");
      setSavingMessage("Save failed");
      pushToast("error", "Settings save failed");
    }
  };

  const openActivity = () => {
    if (activityOpen) return;
    if (activityFabRef.current) {
      setActivityOriginRect(activityFabRef.current.getBoundingClientRect());
    }
    setActivityOpen(true);
    setActivityClosing(false);
    setActivityEntering(true);
  };

  const closeActivity = () => {
    if (activityFabRef.current) {
      setActivityOriginRect(activityFabRef.current.getBoundingClientRect());
    }
    setActivityClosing(true);
  };

  const handleActivityClosed = () => {
    setActivityOpen(false);
    setActivityClosing(false);
    setActivityEntering(false);
  };

  const openUninstall = () => {
    setUninstallOpen(true);
    setUninstallClosing(false);
    setUninstallEntering(true);
  };

  const closeUninstall = () => {
    setUninstallClosing(true);
    window.setTimeout(() => {
      setUninstallOpen(false);
      setUninstallClosing(false);
      setUninstallEntering(false);
    }, 240);
  };

  const handleSyncRepoWarningCancel = async () => {
    const context = syncRepoWarningContext;
    if (!context) {
      closeSyncRepoWarningModal();
      return;
    }
    closeSyncRepoWarningModal();
  };

  const handleSyncRepoWarningReset = async () => {
    const context = syncRepoWarningContext;
    const path = (context?.path || settings.syncRepoPath || "").trim();
    if (!context || !path) {
      pushToast("error", "Sync repo path is empty");
      return;
    }
    const writePath = async () => {
      try {
        await backend.setSyncRepoPath(path);
        backendSyncRepoPathRef.current = path;
      } catch {
        // Ignore.
      }
    };
    await writePath();
    const result = await backend.syncRepoReset(path);
    if (!result.ok) {
      pushToast("error", result.message || "Reset failed");
      return;
    }
    startSyncRepoTaskPolling();
    if (context.mode === "settings-close") {
      const ok = await persistSettings({ ...settings, enableSyncRepo: true, syncRepoPath: path });
      if (!ok) return;
      await refresh();
      closeSettingsModal();
    } else {
      await refresh();
    }
    closeSyncRepoWarningModal();
  };

  const handleSyncRepoWarningUseAsIs = async () => {
    const context = syncRepoWarningContext;
    const path = (context?.path || settings.syncRepoPath || "").trim();
    if (!context || !path) {
      pushToast("error", "Sync repo path is empty");
      return;
    }
    const result = await backend.syncRepoUseAsIs(path);
    if (!result.ok) {
      pushToast("error", result.message || "Use As-Is failed");
      return;
    }
    try {
      await backend.setSyncRepoPath(path);
      backendSyncRepoPathRef.current = path;
    } catch {
      // Ignore.
    }
    if (context.mode === "settings-close") {
      const ok = await persistSettings({ ...settings, enableSyncRepo: true, syncRepoPath: path });
      if (!ok) return;
    }
    pushToast("success", "Sync repo confirmed");
    await refresh();
    if (context.mode === "settings-close") {
      closeSettingsModal();
    }
    closeSyncRepoWarningModal();
  };

  const startSplitDrag = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    splitDragRef.current = true;
    document.body.style.userSelect = "none";
  };

  useEffect(() => {
    if (!settingsOpen) return;
    let raf1 = 0;
    let raf2 = 0;
    raf1 = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(() => setSettingsEntering(false));
    });
    return () => {
      window.cancelAnimationFrame(raf1);
      window.cancelAnimationFrame(raf2);
    };
  }, [settingsOpen]);

  useEffect(() => {
    if (!syncRepoWarningOpen) return;
    let raf1 = 0;
    let raf2 = 0;
    raf1 = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(() => setSyncRepoWarningEntering(false));
    });
    return () => {
      window.cancelAnimationFrame(raf1);
      window.cancelAnimationFrame(raf2);
    };
  }, [syncRepoWarningOpen]);

  useEffect(() => {
    if (!alertOpen || !alertEntering) return;
    let raf1 = 0;
    let raf2 = 0;
    raf1 = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(() => setAlertEntering(false));
    });
    return () => {
      window.cancelAnimationFrame(raf1);
      window.cancelAnimationFrame(raf2);
    };
  }, [alertOpen, alertEntering]);

  useEffect(() => {
    if (!alertOpen) return;
    const alertContextId = alertContext?.id || "";

    const reset = () => {
      setAlertCountdown(5);
      setAlertCountdownArmed(false);
    };

    const onFocus = () => reset();
    const onBlur = () => setAlertCountdownArmed(false);
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        reset();
      } else {
        setAlertCountdownArmed(false);
      }
    };
    const onPointerMove = () => {
      if (activeAlertIdRef.current !== alertContextId) return;
      if (document.visibilityState !== "visible" || !document.hasFocus()) return;
      setAlertCountdownArmed((prev) => {
        if (prev) return prev;
        setAlertCountdown(5);
        return true;
      });
    };

    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("mousemove", onPointerMove);

    const timer = window.setInterval(() => {
      if (activeAlertIdRef.current !== alertContextId) {
        window.clearInterval(timer);
        return;
      }
      if (
        document.visibilityState !== "visible" ||
        !document.hasFocus() ||
        !alertCountdownArmed
      ) {
        return;
      }
      setAlertCountdown((prev) => {
        if (prev <= 1) {
          closeAlertModal();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("mousemove", onPointerMove);
    };
  }, [alertOpen, alertCountdownArmed, closeAlertModal, alertContext?.id]);

  useEffect(() => {
    if (!settingsOpen || !pendingPathsScrollRef.current) return;
    if (resetTimerRef.current) {
      window.clearTimeout(resetTimerRef.current);
    }
    const start = performance.now();
    const attempt = () => {
      const target = pathsRef.current;
      if (!target) {
        if (performance.now() - start < 600) {
          requestAnimationFrame(attempt);
        }
        return;
      }
      const scrollParent = target.closest(".modal-body");
      if (scrollParent instanceof HTMLElement && target instanceof HTMLElement) {
        scrollParent.scrollTop = 0;
        smoothScrollTo(scrollParent, Math.max(0, target.offsetTop - 24), 700);
      } else {
        target.scrollIntoView({
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
            ? "auto"
            : "smooth",
          block: "center"
        });
      }
      pendingPathsScrollRef.current = false;
    };
    resetTimerRef.current = window.setTimeout(() => {
      requestAnimationFrame(attempt);
    }, 120);
  }, [settingsOpen]);

  useEffect(() => {
    if (!activityOpen || !activityEntering) return;
    let raf1 = 0;
    let raf2 = 0;
    raf1 = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(() => setActivityEntering(false));
    });
    return () => {
      window.cancelAnimationFrame(raf1);
      window.cancelAnimationFrame(raf2);
    };
  }, [activityOpen, activityEntering]);

  useEffect(() => {
    if (!uninstallOpen) return;
    const id = window.setTimeout(() => setUninstallEntering(false), 80);
    return () => window.clearTimeout(id);
  }, [uninstallOpen]);

  useEffect(() => {
    splitRatioRef.current = splitRatio;
  }, [splitRatio]);

  const clampSplitRatio = (ratio: number) => {
    const minLeftPx = 560;
    const minRightPx = 440;
    const fallbackMin = 0.55;
    const fallbackMax = 0.75;

    const rect = splitRef.current?.getBoundingClientRect();
    const available = rect ? rect.width - splitGutterPx : null;

    const minRatio = available
      ? Math.max(fallbackMin, minLeftPx / available)
      : fallbackMin;

    const computedMax = available ? 1 - minRightPx / available : fallbackMax;
    const maxRatio = Math.min(
      fallbackMax,
      Number.isFinite(computedMax) ? computedMax : fallbackMax
    );

    const effectiveMax = Math.max(minRatio, maxRatio);
    const clamped = Math.min(effectiveMax, Math.max(minRatio, ratio));

    return Math.min(0.95, Math.max(0.05, clamped));
  };

  const scheduleSplitRatioSave = (ratio: number) => {
    const clamped = clampSplitRatio(ratio);
    if (splitRatioSaveTimerRef.current) {
      window.clearTimeout(splitRatioSaveTimerRef.current);
      splitRatioSaveTimerRef.current = null;
    }
    splitRatioSaveTimerRef.current = window.setTimeout(() => {
      backend
        .saveSettings({ ...settingsRef.current, splitRatio: clamped })
        .catch(() => {});
    }, 450);
  };

  useEffect(() => {
    if (!splitRef.current) return;
    const clamped = clampSplitRatio(splitRatioRef.current);
    if (Math.abs(clamped - splitRatioRef.current) < 1e-6) return;
    setSplitRatio(clamped);
  }, []);

  useEffect(() => {
    const body = document.body;
    const isOpen = settingsOpen || uninstallOpen;
    body.classList.toggle("modal-open", isOpen);
    body.style.paddingRight = "";
    return () => body.classList.remove("modal-open");
  }, [settingsOpen, uninstallOpen]);

  useEffect(() => {
    const handleMove = (event: MouseEvent) => {
      if (!splitDragRef.current || !splitRef.current) return;
      const rect = splitRef.current.getBoundingClientRect();
      const available = rect.width - splitGutterPx;
      if (available <= 0) return;
      const next = (event.clientX - rect.left) / available;
      setSplitRatio(clampSplitRatio(next));
    };
    const handleUp = () => {
      if (!splitDragRef.current) return;
      splitDragRef.current = false;
      document.body.style.userSelect = "";
      scheduleSplitRatioSave(splitRatioRef.current);
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, []);

  useEffect(() => {
    if (!snapshot.logs.length) return;
    const top = snapshot.logs[0];
    const id = `${top.time}-${top.level}-${top.message}`;
    if (id !== latestLogId) {
      setLatestLogId(id);
    }
  }, [snapshot.logs, latestLogId]);

  useEffect(() => {
    if (initState !== "ready") return;
    if (snapshot.events.length > 1) {
      eventRetryRef.current = 0;
      if (eventRetryTimerRef.current) {
        window.clearTimeout(eventRetryTimerRef.current);
        eventRetryTimerRef.current = null;
      }
      return;
    }
    if (eventRetryRef.current >= 12) return;
    eventRetryRef.current += 1;
    if (eventRetryTimerRef.current) {
      window.clearTimeout(eventRetryTimerRef.current);
    }
    eventRetryTimerRef.current = window.setTimeout(() => {
      refresh();
    }, 3000);
  }, [snapshot.events.length, initState]);

  useEffect(() => {
    const handler = () => {
      setConnecting(false);
    };
    window.addEventListener("pywebviewready", handler);
    return () => window.removeEventListener("pywebviewready", handler);
  }, []);

  useEffect(() => {
    allowThemeAnimationRef.current = true;
    return () => {
      if (themeSwapTimerRef.current) {
        window.clearTimeout(themeSwapTimerRef.current);
        themeSwapTimerRef.current = null;
      }
      if (themeTransitionTimerRef.current) {
        window.clearTimeout(themeTransitionTimerRef.current);
        themeTransitionTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    prefersDark.current = media;
    const handler = () => {
      if (!settings.enableSystemTheme || settings.theme !== "system") return;
      applyResolvedThemeWithTransition(media.matches ? "dark" : "light");
    };
    if (media.addEventListener) {
      media.addEventListener("change", handler);
    } else if (media.addListener) {
      media.addListener(handler);
    }
    return () => {
      if (media.removeEventListener) {
        media.removeEventListener("change", handler);
      } else if (media.removeListener) {
        media.removeListener(handler);
      }
    };
  }, [settings.theme, settings.enableSystemTheme]);

  useEffect(() => {
    if (settings.theme === "system") {
      applyResolvedThemeWithTransition(prefersDark.current?.matches ? "dark" : "light");
      return;
    }
    applyResolvedThemeWithTransition(settings.theme);
  }, [settings.theme]);

  useEffect(() => {
    if (settings.enableSystemTheme) return;
    if (settings.theme !== "system") return;
    const fallback = getResolvedTheme();
    setSettings((prev) => ({ ...prev, theme: fallback }));
  }, [settings.enableSystemTheme]);

  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      const message = event.message || "Unknown error";
      console.error(event.error || message);
      backend.addLog({ message: `Frontend error: ${message}`, level: "ERROR" }).catch(() => {});
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      const message =
        event.reason instanceof Error ? event.reason.message : String(event.reason);
      console.error(event.reason);
      backend
        .addLog({ message: `Frontend rejection: ${message}`, level: "ERROR" })
        .catch(() => {});
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  useEffect(() => {
    (window as { __APP_BOOTSTRAPPED__?: boolean }).__APP_BOOTSTRAPPED__ = true;
  }, []);

  useEffect(() => {
    const resolveTheme = (theme: Settings["theme"]) => {
      if (theme !== "system") return theme;
      if (typeof window !== "undefined" && window.matchMedia) {
        return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      }
      return "dark";
    };
    (window as unknown as {
      __ui_check__?: {
        holdInitOverlayMs?: number;
        appendLog?: (message: string, level?: string) => void;
        refresh?: () => void;
        refreshUpdateState?: () => Promise<void>;
        showAlertModal?: (payload: { title?: string; message?: string; tone?: "info" | "error" }) => void;
        hideAlertModal?: () => void;
        showSyncRepoWarning?: (payload: {
          mode?: SyncRepoWarningMode;
          status?: string;
          message?: string;
          path?: string;
          details?: string;
          canUseAsIs?: boolean;
          canReset?: boolean;
        }) => void;
        hideSyncRepoWarning?: () => void;
        setSyncRepoTask?: (payload: {
          active?: boolean;
          phase?: string;
          progress?: number;
          message?: string;
          path?: string;
        }) => void;
        setThemePreference?: (theme: Settings["theme"], enableSystemTheme?: boolean) => void;
        seedHistoryOverflow?: (days?: number, itemsPerDay?: number) => void;
        seedNextEventsImpactOverflow?: (
          lowFirst?: number,
          mediumLater?: number,
          highLater?: number
        ) => void;
        getSettings?: () => Settings;
        toggleTheme?: () => void;
        setSplitRatio?: (value: number) => void;
      };
    }).__ui_check__ = {
      ...(window as unknown as { __ui_check__?: Record<string, unknown> }).__ui_check__,
      appendLog: (message: string, level = "INFO") => appendLogEntry(message, level),
      refresh: () => {
        refresh();
      },
      refreshUpdateState: () => {
        return refreshUpdateState();
      },
      showAlertModal: (payload) => {
        dismissedAlertIdRef.current = "";
        openAlertModal({
          id: `ui-check-alert-${Date.now()}`,
          title: payload?.title ?? "Notice",
          message: payload?.message ?? "Token detected and verified.",
          tone: payload?.tone ?? "info"
        });
      },
      hideAlertModal: () => {
        closeAlertModal();
      },
      showSyncRepoWarning: (payload) => {
        openSyncRepoWarningModal({
          mode: payload?.mode ?? "settings-close",
          status: payload?.status ?? "git-other",
          message: payload?.message ?? "Sync repo needs confirmation",
          path: payload?.path ?? "C:\\\\path\\\\to\\\\sync-repo",
          details: payload?.details,
          canUseAsIs: Boolean(payload?.canUseAsIs),
          canReset: payload?.canReset ?? true
        });
      },
      hideSyncRepoWarning: () => {
        closeSyncRepoWarningModal();
      },
      setSyncRepoTask: (payload) => {
        setSyncRepoTask((prev) => ({
          active: payload?.active ?? prev.active,
          phase: payload?.phase ?? prev.phase,
          progress: typeof payload?.progress === "number" ? payload.progress : prev.progress,
          message: payload?.message ?? prev.message,
          path: payload?.path ?? prev.path
        }));
      },
      setThemePreference: (theme, enableSystemTheme, animate = false) => {
        const resolved = resolveTheme(theme);
        if (!animate) {
          allowThemeAnimationRef.current = false;
        }
        document.documentElement.classList.remove("theme-transition");
        document.documentElement.classList.remove("theme-vt");
        applyResolvedTheme(resolved);
        setSettings((prev) => ({
          ...prev,
          theme,
          enableSystemTheme: enableSystemTheme ?? prev.enableSystemTheme
        }));
        if (!animate) {
          window.setTimeout(() => {
            allowThemeAnimationRef.current = true;
          }, 0);
        }
      },
      seedHistoryOverflow: (days = 18, itemsPerDay = 6) => {
        const makeLabel = (n: number) => String(n).padStart(2, "0");
        const now = new Date();
        const pastEvents = Array.from({ length: days }).flatMap((_, dayIndex) => {
          const date = new Date(now);
          date.setDate(now.getDate() - dayIndex);
          const dd = makeLabel(date.getDate());
          const mm = makeLabel(date.getMonth() + 1);
          const yyyy = String(date.getFullYear());
          return Array.from({ length: itemsPerDay }).map((__, idx) => {
            const hh = makeLabel(2 + (idx * 3) % 20);
            const min = makeLabel((idx * 7) % 60);
            const impact = idx % 7 === 0 ? "High" : idx % 3 === 0 ? "Medium" : "Low";
            const cur =
              idx % 4 === 0 ? "USD" : idx % 4 === 1 ? "EUR" : idx % 4 === 2 ? "GBP" : "JPY";
            return {
              time: `${dd}-${mm}-${yyyy} ${hh}:${min}`,
              cur,
              impact,
              event: `Mock Past Event ${dayIndex + 1}.${idx + 1}`,
              actual: idx % 2 === 0 ? `${(Math.random() * 5 - 2.5).toFixed(1)}` : "--",
              forecast: "--",
              previous: "--"
            };
          });
        });

        setSnapshot((prev) => ({
          ...prev,
          pastEvents
        }));
      },
      seedNextEventsImpactOverflow: (lowFirst = 40, mediumLater = 10, highLater = 10) => {
        const now = new Date();
        const makeLabel = (n: number) => String(n).padStart(2, "0");
        const makeTime = (date: Date) => {
          const dd = makeLabel(date.getDate());
          const mm = makeLabel(date.getMonth() + 1);
          const yyyy = String(date.getFullYear());
          const hh = makeLabel(date.getHours());
          const min = makeLabel(date.getMinutes());
          return `${dd}-${mm}-${yyyy} ${hh}:${min}`;
        };
        const makeCountdown = (minutesAhead: number) => {
          const hours = Math.floor(minutesAhead / 60);
          const mins = minutesAhead % 60;
          if (hours >= 24) {
            const days = Math.floor(hours / 24);
            const remH = hours % 24;
            return `${days}d ${remH}h`;
          }
          return `${hours}h ${makeLabel(mins)}m`;
        };

        const rendered = [];
        const pushEvent = (minutesAhead: number, impact: string, suffix: string) => {
          const date = new Date(now);
          date.setMinutes(now.getMinutes() + minutesAhead);
          rendered.push({
            time: makeTime(date),
            cur: "USD",
            impact,
            event: `${impact} Impact Event ${suffix}`,
            countdown: makeCountdown(minutesAhead)
          });
        };

        const step = 27;
        for (let i = 0; i < lowFirst; i += 1) {
          pushEvent(45 + i * step, "Low", `${i + 1}`);
        }

        const base = 45 + lowFirst * step + 120;
        for (let i = 0; i < mediumLater; i += 1) {
          pushEvent(base + i * 53, "Medium", `${i + 1}`);
        }

        const baseHigh = base + mediumLater * 53 + 180;
        for (let i = 0; i < highLater; i += 1) {
          pushEvent(baseHigh + i * 71, "High", `${i + 1}`);
        }

        setSnapshot((prev) => ({
          ...prev,
          events: rendered
        }));
      },
      getSettings: () => settingsRef.current,
      toggleTheme: () => toggleTheme(),
      setSplitRatio: (value) => {
        const clamped = clampSplitRatio(value);
        setSplitRatio(clamped);
      }
    };
  }, [settings]);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    savedSettingsRef.current = savedSettings;
  }, [savedSettings]);

  useEffect(() => {
    settingsOpenRef.current = settingsOpen;
  }, [settingsOpen]);

  const resolvedTheme = getResolvedTheme();
  const themeMode = settings.enableSystemTheme ? settings.theme : resolvedTheme;
  const currencyOptions = useMemo(
    () => normalizeCurrencyOptions(snapshot.currencyOptions),
    [snapshot.currencyOptions]
  );
  const activityPillContent = (
    <>
      Activity
      <span
        className={`activity-count${syncRepoTask.active ? " progress" : ""}`}
        data-qa="qa:status:activity-count"
        aria-label={
          syncRepoDisplayActive
            ? `Sync repo progress ${Math.round(syncRepoDisplayProgress * 100)}%`
            : "Activity count"
        }
      >
        {syncRepoDisplayActive ? (
          <svg className="activity-count-ring" viewBox="0 0 36 36" aria-hidden="true">
            <circle className="ring-bg" cx="18" cy="18" r="16" pathLength="100" />
            <circle
              className="ring-fg"
              cx="18"
              cy="18"
              r="16"
              pathLength="100"
              strokeDasharray={`${Math.max(
                0,
                Math.min(100, syncRepoDisplayProgress * 100)
              )} 100`}
            />
          </svg>
        ) : null}
        <span className="activity-count-value">{snapshot.logs.length}</span>
      </span>
    </>
  );

  return (
    <div className="app" data-qa="qa:app-shell">
      <InitOverlay state={initState} error={initError} onRetry={refresh} />
      <AppBar
        snapshot={snapshot}
        outputDir={outputDir}
        connecting={connecting}
        pullState={pullState}
        syncState={syncState}
        resolvedTheme={resolvedTheme}
        themeMode={themeMode}
        onPull={handlePull}
        onSync={handleSync}
        onOpenSettings={openSettings}
        onToggleTheme={toggleTheme}
        onOpenPaths={openPathsInSettings}
      />

      <main className="main">
        <div
          className="split-view"
          ref={splitRef}
          style={{
            gridTemplateColumns: `minmax(0, ${splitRatio.toFixed(
              4
            )}fr) ${splitGutterPx}px minmax(0, ${(1 - splitRatio).toFixed(4)}fr)`
          }}
        >
          <div className="split-pane">
            <NextEvents
              events={snapshot.events}
              currency={currency}
              currencyOptions={currencyOptions}
              onCurrencyChange={handleCurrency}
              impactTone={impactTone}
            />
          </div>
          <div className="split-divider" onMouseDown={startSplitDrag} data-qa="qa:split:divider" />
          <div className="split-pane">
            <HistoryPanel events={snapshot.pastEvents} impactTone={impactTone} />
          </div>
        </div>
      </main>

      <Footer version={snapshot.version} />

      <button
        className={`activity-fab${activityOpen ? " hidden" : ""}`}
        type="button"
        onClick={openActivity}
        ref={activityFabRef}
        data-qa="qa:action:activity-fab"
      >
        {activityPillContent}
      </button>

      <SettingsModal
        isOpen={settingsOpen}
        isClosing={settingsClosing}
        isEntering={settingsEntering}
        settings={settings}
        outputDir={outputDir}
        syncRepoNote={syncRepoNote}
        onResolveSyncRepo={handleSyncRepoReview}
        savingMessage={savingMessage}
        pathsRef={pathsRef}
        updatePhase={updateState.phase}
        updateMessage={updateState.message}
        updateProgress={updateState.progress}
        updateLastCheckedAt={updateState.lastCheckedAt}
        appVersion={snapshot.version}
        onClose={handleSettingsClose}
        onSave={handleSettingsSave}
        onCancel={handleSettingsCancel}
        onThemeChange={(value) =>
          setSettings((prev) => {
            const next = { ...prev, theme: value };
            if (prev.autoSave) {
              persistSettingsAutosafe(next);
            }
            return next;
          })
        }
        onSystemThemeToggle={(value) =>
          setSettings((prev) => {
            const nextTheme =
              !value && prev.theme === "system" ? resolvedTheme : prev.theme;
            const next = { ...prev, enableSystemTheme: value, theme: nextTheme };
            if (prev.autoSave) {
              persistSettingsAutosafe(next);
            }
            return next;
          })
        }
        onEnableSyncRepo={(value) =>
          setSettings((prev) => {
            dirtySyncRepoRef.current = true;
            return { ...prev, enableSyncRepo: value };
          })
        }
        onAutoSyncAfterPull={(value) =>
          setSettings((prev) => {
            const next = { ...prev, autoSyncAfterPull: value };
            if (prev.autoSave) {
              persistSettingsAutosafe(next);
            }
            return next;
          })
        }
        onAutoUpdateEnabled={(value) =>
          setSettings((prev) => {
            const next = { ...prev, autoUpdateEnabled: value };
            if (prev.autoSave) {
              persistSettingsAutosafe(next);
            }
            return next;
          })
        }
        onCheckUpdates={handleCheckUpdates}
        onUpdateNow={handleUpdateNow}
        onRunOnStartup={(value) =>
          setSettings((prev) => {
            const next = { ...prev, runOnStartup: value };
            if (prev.autoSave) {
              persistSettingsAutosafe(next);
            }
            return next;
          })
        }
        onDebugToggle={(value) =>
          setSettings((prev) => {
            const next = { ...prev, debug: value };
            if (prev.autoSave) {
              persistSettingsAutosafe(next);
            }
            return next;
          })
        }
        onCopyLog={handleCopyLog}
        onOpenLog={handleOpenLog}
        onSyncRepoChange={(value) =>
          setSettings((prev) => {
            dirtySyncRepoRef.current = true;
            const next = { ...prev, syncRepoPath: value };
            return next;
          })
        }
        onSyncRepoBlur={() => {}}
        onSyncRepoBrowse={handleSyncRepoBrowse}
        onOpenPath={handleOpenPath}
        onOutputDirChange={(value) => {
          dirtyOutputDirRef.current = true;
          setOutputDir(value);
        }}
        onOutputDirBlur={() => {}}
        onBrowseOutput={handleBrowse}
        onOpenUninstall={openUninstall}
      />

      <SyncRepoWarningModal
        isOpen={syncRepoWarningOpen}
        isClosing={syncRepoWarningClosing}
        isEntering={syncRepoWarningEntering}
        mode={syncRepoWarningContext?.mode ?? "settings-close"}
        title={
          syncRepoWarningContext?.status === "git-origin-mismatch"
            ? "Sync Repo folder has a different git origin"
          : syncRepoWarningContext?.status === "git-not-clean"
              ? "Sync Repo folder contains local changes"
          : syncRepoWarningContext?.status === "git-not-main"
              ? "Sync Repo folder is not on branch main"
          : syncRepoWarningContext?.status === "git-verify-failed"
              ? "Sync Repo could not be verified"
          : syncRepoWarningContext?.status === "non-git-nonempty"
              ? "Sync Repo folder contains files"
              : syncRepoWarningContext?.status === "git-origin-missing"
                ? "Sync Repo git origin is missing"
                : syncRepoWarningContext?.status === "git-unusable"
                  ? "Sync Repo git metadata is not usable"
                  : syncRepoWarningContext?.status === "unsafe"
                    ? "Sync Repo folder is unsafe"
                    : "Confirm Sync Repo folder"
        }
        message={syncRepoWarningContext?.message || "Sync repo needs confirmation"}
        path={syncRepoWarningContext?.path || ""}
        details={syncRepoWarningContext?.details}
        canUseAsIs={Boolean(syncRepoWarningContext?.canUseAsIs)}
        canReset={Boolean(syncRepoWarningContext?.canReset)}
        onCancel={handleSyncRepoWarningCancel}
        onUseAsIs={handleSyncRepoWarningUseAsIs}
        onReset={handleSyncRepoWarningReset}
      />

      <UninstallModal
        isOpen={uninstallOpen}
        isClosing={uninstallClosing}
        isEntering={uninstallEntering}
        settings={settings}
        onClose={closeUninstall}
        onRemoveLogs={(value) =>
          setSettings((prev) => ({
            ...prev,
            removeLogs: value
          }))
        }
        onRemoveOutput={(value) =>
          setSettings((prev) => ({
            ...prev,
            removeOutput: value
          }))
        }
        onRemoveSyncRepos={(value) =>
          setSettings((prev) => ({
            ...prev,
            removeSyncRepos: value
          }))
        }
        onConfirmChange={(value) =>
          setSettings((prev) => ({
            ...prev,
            uninstallConfirm: value
          }))
        }
        onConfirm={async () => {
          const confirm = settings.uninstallConfirm.trim().toUpperCase();
          const result = await backend.uninstall({
            confirm,
            removeLogs: settings.removeLogs,
            removeOutput: settings.removeOutput,
            removeSyncRepos: settings.removeSyncRepos
          });
          if (!result.ok) {
            pushToast("error", result.message || "Uninstall failed");
            return;
          }
          pushToast("success", "Uninstall completed");
          closeUninstall();
        }}
      />

      <AlertModal
        isOpen={alertOpen}
        isClosing={alertClosing}
        isEntering={alertEntering}
        title={alertContext?.title || "Notice"}
        message={alertContext?.message || ""}
        tone={alertContext?.tone || "info"}
        secondsRemaining={alertCountdown}
        onClose={closeAlertModal}
      />

      <ActivityDrawer
        isOpen={activityOpen}
        isClosing={activityClosing}
        isEntering={activityEntering}
        originRect={activityOriginRect}
        pillContent={activityPillContent}
        externalPillRef={activityFabRef}
        onClose={closeActivity}
        onClosed={handleActivityClosed}
      >
        <div className="activity-stack">
          <ActivityLog
            filter={filter}
            logs={filteredLogs}
            latestLogId={latestLogId}
            onFilterChange={(value) => setFilter(value)}
            onClear={handleClear}
            levelTone={levelTone}
            showFilter={false}
            className="drawer"
            title="Activity"
            subtitle="Latest first · non-blocking"
            headerActions={
              <button
                className="btn ghost btn-compact"
                onClick={closeActivity}
                data-qa="qa:drawer:activity-close"
              >
                Close
              </button>
            }
          />
          {syncRepoDisplayActive ? (
            <div className="sync-repo-progress" data-qa="qa:sync-repo:progress">
              <div className="sync-repo-progress-header">
                <div className="sync-repo-progress-title">Sync Repo</div>
                <div className="sync-repo-progress-percent">
                  {Math.round(Math.max(0, Math.min(1, syncRepoDisplayProgress)) * 100)}%
                </div>
              </div>
              <div className="sync-repo-progress-bar" aria-hidden="true">
                <div
                  className="sync-repo-progress-fill"
                  style={{
                    width: `${Math.round(
                      Math.max(0, Math.min(1, syncRepoDisplayProgress)) * 100
                    )}%`
                  }}
                />
              </div>
              <div className="sync-repo-progress-message">
                {syncRepoDisplayMessage || syncRepoTask.message || "Working..."}
              </div>
            </div>
          ) : null}
        </div>
      </ActivityDrawer>

      {restartPillState !== "hidden" ? (
        <div
          className={`restart-countdown${restartPillState === "closing" ? " closing" : ""}`}
          data-qa="qa:restart-countdown"
        >
          Restarting in {Math.max(0, restartCountdown)}s…
        </div>
      ) : null}

      <ToastStack toasts={toasts} />
    </div>
  );
}
