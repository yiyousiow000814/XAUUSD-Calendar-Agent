import { useEffect, useMemo, useRef, useState } from "react";

import type {
  MarketAgentProviderActionResponse,
  MarketAgentProviderConfigInput,
  MarketAgentProviderConfigResponse,
  MarketAgentLLMActionResponse,
  MarketAgentLLMConfigInput,
  MarketAgentLLMConfigResponse,
  MarketAgentLLMSetupResponse,
  MarketAgentMonitorStatusResponse,
  MarketAgentOllamaPullProgress,
  MarketAgentProviderHealthResponse,
  MarketAgentCTraderAuthResponse,
  MarketAgentTelegramActionResponse,
  MarketAgentTelegramConfigInput,
  MarketAgentTelegramConfigResponse
} from "../types";
import { formatShortTime } from "../utils/marketAgentUi";
import { MarketAgentStatusBadge } from "./MarketAgentStatusBadge";
import "./MarketAgentProviderConfig.css";

type MarketAgentProviderConfigProps = {
  data: MarketAgentProviderConfigResponse | null;
  telegramData: MarketAgentTelegramConfigResponse | null;
  llmData: MarketAgentLLMConfigResponse | null;
  providerHealth?: MarketAgentProviderHealthResponse | null;
  localAiSetup?: MarketAgentLLMSetupResponse | null;
  localAiPullProgress?: MarketAgentOllamaPullProgress | null;
  onSave: (ctrader: MarketAgentProviderConfigInput) => void;
  onClear: () => void;
  onTestConnection: (ctrader: MarketAgentProviderConfigInput) => Promise<MarketAgentProviderActionResponse>;
  onResolveSymbol: (ctrader: MarketAgentProviderConfigInput) => Promise<MarketAgentProviderActionResponse>;
  onQuoteTest: (ctrader: MarketAgentProviderConfigInput) => Promise<MarketAgentProviderActionResponse>;
  onStartCTraderConnect?: (ctrader: MarketAgentProviderConfigInput) => Promise<MarketAgentCTraderAuthResponse>;
  onTestCTraderBackfill?: (ctrader: MarketAgentProviderConfigInput) => Promise<MarketAgentProviderActionResponse>;
  onSaveTelegram: (telegram: MarketAgentTelegramConfigInput) => Promise<MarketAgentTelegramConfigResponse>;
  onTestTelegram: (telegram: MarketAgentTelegramConfigInput) => Promise<MarketAgentTelegramActionResponse>;
  onSaveLLM: (llm: MarketAgentLLMConfigInput) => Promise<MarketAgentLLMConfigResponse>;
  onTestLLMConnection: (llm: MarketAgentLLMConfigInput) => Promise<MarketAgentLLMActionResponse>;
  onTestLLMJsonResponse: (llm: MarketAgentLLMConfigInput) => Promise<MarketAgentLLMActionResponse>;
  onDetectLocalAI?: () => Promise<MarketAgentLLMSetupResponse>;
  onInstallRecommendedModel?: (model: string) => Promise<MarketAgentLLMActionResponse>;
  onCancelModelDownload?: (model?: string) => Promise<MarketAgentLLMActionResponse>;
  onBenchmarkLLM?: (llm: MarketAgentLLMConfigInput) => Promise<MarketAgentLLMActionResponse>;
  onApplyLLMFallbackPolicy?: (payload: Record<string, unknown>) => Promise<MarketAgentLLMActionResponse>;
  monitorStatus: MarketAgentMonitorStatusResponse | null;
  onRunMonitorOnce: () => Promise<MarketAgentMonitorStatusResponse>;
  onRunBackfillRecovery: () => Promise<MarketAgentMonitorStatusResponse>;
  onStartMonitorLoop: () => Promise<MarketAgentMonitorStatusResponse>;
  onStopMonitorLoop: () => Promise<MarketAgentMonitorStatusResponse>;
};

type SetupStep = "ctrader" | "llm" | "telegram" | "monitoring";
type LocalAIMode = "auto" | "balanced" | "lightweight" | "off";

const formatLocalModelName = (model?: string | null) => {
  if (!model) return "";
  const match = model.match(/^(qwen\d+(?:\.\d+)?):(.+)$/i);
  if (!match) return model;
  return `${match[1].replace(/^qwen/i, "Qwen")} ${match[2].toUpperCase()}`;
};

const localAIProgressPercent = (progress: MarketAgentOllamaPullProgress | null) => {
  if (!progress) return 0;
  if (progress.status === "cancelled") return 0;
  if (progress.done) return progress.ok === false ? 100 : 100;
  if (typeof progress.percent === "number") return Math.max(0, Math.min(100, progress.percent));
  const status = progress.status.toLowerCase();
  if (status.includes("request")) return 25;
  if (status.includes("start")) return 15;
  if (status.includes("prepar")) return 5;
  return 8;
};

const localAIProgressStage = (progress: MarketAgentOllamaPullProgress | null) => {
  if (!progress) return "";
  if (progress.status === "cancelled") return "Cancelled";
  if (progress.done) return progress.ok === false ? "Stopped" : "Ready";
  const status = progress.status.toLowerCase();
  if (
    (progress.completedBytes != null || progress.totalBytes != null || status.includes("download") || status.includes("pull")) &&
    typeof progress.percent === "number"
  ) {
    return `Downloading · ${localAIProgressPercent(progress).toFixed(0)}%`;
  }
  if (status.includes("request")) return "Requesting model · 25%";
  if (status.includes("start")) return "Starting runtime · 15%";
  return "Preparing runtime · 5%";
};

const emptyForm: MarketAgentProviderConfigInput = {
  enabled: false,
  environment: "demo",
  accountId: "",
  ctid: "",
  password: "",
  symbol: "XAUUSD",
  symbolId: null,
  snapshotPath: "",
  quoteTimeoutSeconds: 8,
  quoteStaleAfterSeconds: 15,
  allowSavedSnapshotFallback: true
};

const emptyTelegramForm: MarketAgentTelegramConfigInput = {
  enabled: false,
  botToken: "",
  chatId: "",
  timeoutSeconds: 10,
  levels: ["level_2", "level_3"]
};

const emptyLLMForm: MarketAgentLLMConfigInput = {
  enabled: false,
  provider: "ollama",
  endpoint: "http://127.0.0.1:21434",
  model: "qwen3.5:4b",
  temperature: 0.1,
  timeoutSeconds: 20,
  keepAlive: "0",
  maxContext: 8192
};

export function MarketAgentProviderConfig({
  data,
  telegramData,
  llmData,
  providerHealth,
  localAiSetup,
  localAiPullProgress,
  onSave,
  onClear,
  onTestConnection,
  onResolveSymbol,
  onQuoteTest,
  onStartCTraderConnect,
  onTestCTraderBackfill,
  onSaveTelegram,
  onTestTelegram,
  onSaveLLM,
  onTestLLMConnection,
  onTestLLMJsonResponse,
  onDetectLocalAI,
  onInstallRecommendedModel,
  onCancelModelDownload,
  onBenchmarkLLM,
  onApplyLLMFallbackPolicy,
  monitorStatus,
  onRunMonitorOnce,
  onRunBackfillRecovery,
  onStartMonitorLoop,
  onStopMonitorLoop
}: MarketAgentProviderConfigProps) {
  const [form, setForm] = useState<MarketAgentProviderConfigInput>(emptyForm);
  const [telegramForm, setTelegramForm] = useState<MarketAgentTelegramConfigInput>(emptyTelegramForm);
  const [llmForm, setLLMForm] = useState<MarketAgentLLMConfigInput>(emptyLLMForm);
  const [ctraderAuthResult, setCTraderAuthResult] = useState<MarketAgentCTraderAuthResponse | null>(null);
  const [telegramResult, setTelegramResult] = useState<MarketAgentTelegramActionResponse | null>(null);
  const [telegramSaveState, setTelegramSaveState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [telegramTestState, setTelegramTestState] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const [localTelegramEnabled, setLocalTelegramEnabled] = useState<boolean | null>(null);
  const [llmResult, setLLMResult] = useState<MarketAgentLLMActionResponse | null>(null);
  const [localAIResult, setLocalAIResult] = useState<MarketAgentLLMActionResponse | null>(null);
  const [pendingPullProgress, setPendingPullProgress] = useState<MarketAgentOllamaPullProgress | null>(null);
  const [localSetup, setLocalSetup] = useState<MarketAgentLLMSetupResponse | null>(localAiSetup ?? null);
  const [activeStep, setActiveStep] = useState<SetupStep>("ctrader");
  const [localAIMode, setLocalAIMode] = useState<LocalAIMode>("auto");
  const surfaceRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const ctrader = data?.ctrader;
    if (!ctrader) return;
    setForm((current) => ({
      ...current,
      enabled: ctrader.enabled,
      environment: ctrader.environment || "demo",
      accountId: ctrader.accountId || "",
      ctid: "",
      password: "",
      symbol: ctrader.symbol || "XAUUSD",
      symbolId: ctrader.symbolId ?? null,
      snapshotPath: ctrader.snapshotPath || "",
      quoteTimeoutSeconds: ctrader.quoteTimeoutSeconds || 8,
      quoteStaleAfterSeconds: ctrader.quoteStaleAfterSeconds || 15,
      allowSavedSnapshotFallback: ctrader.allowSavedSnapshotFallback
    }));
  }, [data]);

  useEffect(() => {
    const telegram = telegramData?.telegram;
    if (!telegram) return;
    setTelegramForm((current) => ({
      ...current,
      enabled: telegram.enabled,
      chatId: telegram.chatId || "",
      timeoutSeconds: telegram.timeoutSeconds || 10,
      levels: telegram.levels?.length ? telegram.levels : ["level_2", "level_3"]
    }));
    setLocalTelegramEnabled(telegram.enabled);
  }, [telegramData]);

  useEffect(() => {
    const llm = llmData?.llm;
    if (!llm) return;
    setLLMForm({
      enabled: llm.enabled,
      provider: llm.provider || "ollama",
      endpoint: llm.endpoint || "http://127.0.0.1:21434",
      model: llm.model || "qwen3.5:4b",
      temperature: typeof llm.temperature === "number" ? llm.temperature : 0.1,
      timeoutSeconds: llm.timeoutSeconds || 20,
      keepAlive: llm.keepAlive || "0",
      maxContext: llm.maxContext || 8192
    });
  }, [llmData]);

  useEffect(() => {
    if (localAiSetup) {
      setLocalSetup(localAiSetup);
      if (localAiSetup.recommendedModel?.name) {
        setLLMForm((current) => ({ ...current, model: localAiSetup.recommendedModel?.name || current.model }));
      }
    }
  }, [localAiSetup]);

  useEffect(() => {
    if (localAiPullProgress) {
      setPendingPullProgress((current) => (current?.status === "cancelled" ? current : null));
    }
  }, [localAiPullProgress]);

  const cTraderHealth = useMemo(
    () =>
      providerHealth?.items?.find((item) => {
        const key = String(item.provider_key || "").toLowerCase();
        const source = String(item.source || "").toLowerCase();
        const type = String(item.source_type || "").toLowerCase();
        return key.includes("ctrader") || source.includes("ctrader") || type === "spot";
      }) || null,
    [providerHealth]
  );
  const cTraderLive = Boolean(
    cTraderHealth?.is_available && !cTraderHealth.is_stale && cTraderHealth.data_mode === "live_seen"
  );
  const cTraderConfigured = Boolean(data?.ctrader?.enabled);
  const cTraderStatusLabel = cTraderLive ? "Live" : cTraderConfigured ? "Preparing live feed" : "Connect";
  const cTraderHealthMessage =
    cTraderLive
      ? "Live XAUUSD feed is active."
      : cTraderConfigured
        ? "Preparing the live XAUUSD feed. History sync continues in the background."
        : "Connect cTrader to let the app prepare live monitoring.";

  const statusTone = useMemo(() => {
    if (!data?.available) return "bad";
    if (cTraderLive) return "good";
    if (cTraderConfigured) return "warn";
    return "bad";
  }, [data, cTraderConfigured, cTraderLive]);

  const setupActions: Array<{ id: SetupStep; label: string; detail: string; status: string }> = [
    {
      id: "ctrader",
      label: "cTrader",
      detail: "Live XAUUSD",
      status: cTraderStatusLabel
    },
    {
      id: "llm",
      label: "Local AI",
      detail: "Optional explanation",
      status: llmData?.llm?.enabled ? "On" : "Rule-based"
    },
    {
      id: "telegram",
      label: "Telegram",
      detail: "Optional alerts",
      status: (localTelegramEnabled ?? telegramData?.telegram?.enabled) ? "On" : "Off"
    },
    {
      id: "monitoring",
      label: "Monitoring",
      detail: "Agent loop",
      status: monitorStatus?.running ? "Running" : "Stopped"
    }
  ];

  const toggleTelegramLevel = (level: string, checked: boolean) => {
    setTelegramSaveState("idle");
    setTelegramForm((current) => ({
      ...current,
      levels: checked
        ? Array.from(new Set([...current.levels, level]))
        : current.levels.filter((item) => item !== level)
    }));
  };

  const runTelegramAction = async () => {
    setTelegramTestState("sending");
    setTelegramResult(null);
    try {
      const result = await onTestTelegram(telegramForm);
      setTelegramResult(result);
      setTelegramTestState(result.ok ? "sent" : "failed");
      window.setTimeout(() => setTelegramTestState((current) => (current === "sent" ? "idle" : current)), 6000);
    } catch (error) {
      setTelegramResult({
        ok: false,
        status: "failed",
        error: error instanceof Error ? error.message : "Telegram test failed."
      });
      setTelegramTestState("failed");
    }
  };

  const saveTelegram = async () => {
    setTelegramSaveState("saving");
    setTelegramResult(null);
    try {
      const result = await onSaveTelegram(telegramForm);
      setLocalTelegramEnabled(Boolean(result.telegram?.enabled ?? telegramForm.enabled));
      setTelegramSaveState("saved");
      window.setTimeout(() => setTelegramSaveState((current) => (current === "saved" ? "idle" : current)), 4000);
    } catch (error) {
      setTelegramSaveState("failed");
      setTelegramResult({
        ok: false,
        status: "failed",
        error: error instanceof Error ? error.message : "Telegram settings could not be saved."
      });
    }
  };

  const technicalHelp: Record<string, string> = {
    "Account ID": "Trading account number used by the local cTrader CLI.",
    "cTID": "Your cTrader ID or email used by the local cTrader CLI.",
    Password: "Your cTrader password for the local CLI login. Stored locally, masked in the UI, and never logged."
  };

  const helpButton = (label: keyof typeof technicalHelp) => (
    <button type="button" className="market-agent-help-dot" aria-label="Field help" title={technicalHelp[label]}>
      ?
    </button>
  );

  const runCTraderConnect = async () => {
    if (!onStartCTraderConnect) return;
    const payload = { ...form, enabled: true };
    setForm(payload);
    onSave(payload);
    const result = await onStartCTraderConnect(payload);
    setCTraderAuthResult(result);
  };

  const selectedLocalAIModel = () => {
    if (localAIMode === "off") return "";
    if (localAIMode === "balanced") return "qwen3.5:4b";
    if (localAIMode === "lightweight") return "qwen3.5:0.8b";
    return localSetup?.recommendedModel?.name || llmForm.model || "qwen3.5:4b";
  };

  const isLocalModelInstalled = (model: string) => {
    if (!model) return false;
    return Boolean(
      localSetup?.installedModels?.some((entry) => {
        const name =
          typeof entry.name === "string"
            ? entry.name
            : typeof entry.model === "string"
              ? entry.model
              : typeof entry.modelName === "string"
                ? entry.modelName
                : "";
        return name === model;
      })
    );
  };

  const selectLocalAIMode = (mode: LocalAIMode) => {
    setLocalAIMode(mode);
    const model =
      mode === "balanced"
        ? "qwen3.5:4b"
        : mode === "lightweight"
          ? "qwen3.5:0.8b"
          : localSetup?.recommendedModel?.name || llmForm.model || "qwen3.5:4b";
    setLLMForm((current) => ({
      ...current,
      enabled: mode !== "off",
      model: mode === "off" ? current.model : model
    }));
  };

  const installSelectedModel = async () => {
    const model = selectedLocalAIModel();
    if (!model || !onInstallRecommendedModel) return;
    setLocalAIResult(null);
    setPendingPullProgress({
      model,
      status: "preparing runtime",
      message: "Preparing Local AI runtime...",
      percent: 5,
      done: false
    });
    const result = await onInstallRecommendedModel(model);
    setLocalAIResult(result);
    if (result.done || result.status !== "download_started") {
      setPendingPullProgress(null);
    }
    const fallbackModel =
      result.policy && typeof result.policy.model === "string" ? result.policy.model : undefined;
    const fallbackStatus =
      result.policy && typeof result.policy.status === "string" ? result.policy.status : undefined;
    if (fallbackModel) {
      setLLMForm((current) => ({ ...current, model: fallbackModel, enabled: fallbackStatus !== "llm_disabled" }));
    }
  };

  const cancelSelectedModelDownload = async () => {
    const model = selectedLocalAIModel();
    const cancelledProgress: MarketAgentOllamaPullProgress = {
      ok: false,
      model: model || pendingPullProgress?.model || localAiPullProgress?.model || llmForm.model,
      status: "cancelled",
      message: "Model download cancelled.",
      percent: 0,
      done: true
    };
    setPendingPullProgress(cancelledProgress);
    if (!onCancelModelDownload) {
      setLocalAIResult({ ok: true, status: "cancelled", model: cancelledProgress.model, message: "Model download cancelled.", done: true });
      return;
    }
    const result = await onCancelModelDownload(cancelledProgress.model);
    setLocalAIResult(result);
    setPendingPullProgress({ ...cancelledProgress, message: result.message || cancelledProgress.message });
  };

  const selectStep = (step: SetupStep) => {
    setActiveStep(step);
    const scrollTarget = surfaceRef.current;
    if (!scrollTarget) return;
    if (typeof scrollTarget.scrollTo === "function") {
      scrollTarget.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    scrollTarget.scrollTop = 0;
  };

  const renderStep = () => {
    if (activeStep === "ctrader") {
      return (
        <div className="market-agent-setup-panel market-agent-ctrader-panel">
          <div className="market-agent-step-copy">
            <span>Connect cTrader</span>
            <h3>Connect cTrader</h3>
            <p>Enter the cTrader CLI account this app can use. Market symbols are handled automatically.</p>
          </div>
          <p className="market-agent-security-note">
            Password is stored locally and masked after save. It is not shown in logs or UI snapshots.
          </p>
          <div className="market-agent-provider-config-grid primary market-agent-ctrader-primary-grid">
            <div className="market-agent-provider-config-field">
              <div className="market-agent-provider-config-field-label">
                <label htmlFor="ctrader-account-id">Account ID</label>
                {helpButton("Account ID")}
              </div>
              <input
                id="ctrader-account-id"
                value={form.accountId}
                onChange={(event) => setForm((current) => ({ ...current, accountId: event.target.value }))}
                placeholder="123456"
              />
            </div>
            <div className="market-agent-provider-config-field">
              <div className="market-agent-provider-config-field-label">
                <label htmlFor="ctrader-ctid">cTID / email</label>
                {helpButton("cTID")}
              </div>
              <input
                id="ctrader-ctid"
                value={form.ctid}
                autoComplete="username"
                onChange={(event) => setForm((current) => ({ ...current, ctid: event.target.value }))}
                placeholder={data?.ctrader?.ctidMasked || "name@example.com"}
              />
            </div>
            <div className="market-agent-provider-config-field">
              <div className="market-agent-provider-config-field-label">
                <label htmlFor="ctrader-password">Password</label>
                {helpButton("Password")}
              </div>
              <input
                id="ctrader-password"
                type="password"
                value={form.password}
                autoComplete="current-password"
                onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))}
                placeholder={data?.ctrader?.passwordMasked || ""}
              />
            </div>
          </div>
          <div className="market-agent-provider-config-actions market-agent-action-bar market-agent-action-bar-float">
            <button type="button" className="btn primary btn-compact" onClick={() => void runCTraderConnect()}>
              Connect cTrader
            </button>
            <button type="button" className="btn ghost btn-compact" onClick={onClear}>
              Clear
            </button>
          </div>
          {ctraderAuthResult ? (
            <div className="market-agent-provider-config-result">
              <div className="market-agent-provider-config-result-head">
                <strong>cTrader connect</strong>
                <MarketAgentStatusBadge label={ctraderAuthResult.status || (ctraderAuthResult.ok ? "ready" : "failed")} />
              </div>
              <div className="market-agent-provider-config-result-body">
                <span>{ctraderAuthResult.message || ctraderAuthResult.error || "Connection step completed."}</span>
              </div>
            </div>
          ) : null}
          {cTraderConfigured && !cTraderLive ? (
            <div className="market-agent-readable-status-line">
              <span>{cTraderHealthMessage}</span>
            </div>
          ) : null}
        </div>
      );
    }

    if (activeStep === "llm") {
      const recommended = localSetup?.recommendedModel;
      const ollama = localSetup?.ollama;
      const pullProgress = pendingPullProgress || localAiPullProgress;
      const selectedModel = selectedLocalAIModel();
      const selectedModelLabel = formatLocalModelName(selectedModel);
      const isDownloadingModel = Boolean(pullProgress && !pullProgress.done && !pullProgress.error);
      const progressPercent = localAIProgressPercent(pullProgress);
      const progressStage = localAIProgressStage(pullProgress);
      const pullStatus = String(pullProgress?.status || "").toLowerCase();
      const isPullingModel =
        pullProgress?.completedBytes != null ||
        pullProgress?.totalBytes != null ||
        pullStatus.includes("download") ||
        pullStatus.includes("pull");
      const selectedModelInstalled = isLocalModelInstalled(selectedModel);
      const isModelReady = localSetup?.status === "model_ready" || selectedModelInstalled;
      const installDisabled = localAIMode === "off" || isDownloadingModel;
      const localAIOptions: Array<{
        mode: LocalAIMode;
        label: string;
        detail: string;
        badge: string;
        model?: string;
        warning?: boolean;
      }> = [
        {
          mode: "auto",
          label: "Auto",
          detail: `Recommended for this machine: ${formatLocalModelName(recommended?.name || "qwen3.5:4b")}.`,
          badge: recommended?.diskLabel || "Recommended",
          model: recommended?.name || "qwen3.5:4b"
        },
        {
          mode: "balanced",
          label: "Qwen3.5 4B",
          detail: "Best choice for most desktops. Uses the larger local model for fast JSON.",
          badge: "~2.9 GB",
          model: "qwen3.5:4b"
        },
        {
          mode: "lightweight",
          label: "Qwen3.5 0.8B",
          detail: "Smaller download for laptops or CPU-only machines.",
          badge: "~650 MB",
          model: "qwen3.5:0.8b"
        },
        {
          mode: "off",
          label: "Rule-based only",
          detail: "Disables Local AI explanations. Evidence gate and reports still run.",
          badge: "LLM off",
          warning: true
        }
      ];
      const localAIRuntimeLabel =
        ollama?.installed === false
          ? "Runtime will be prepared"
          : ollama?.running === false
            ? "Runtime preparing"
            : localAIMode === "off"
              ? "LLM disabled"
              : isModelReady
                ? "Model ready"
                : "Ready to download";
      const selectedOption = localAIOptions.find((option) => option.mode === localAIMode) || localAIOptions[0];
      const installedLocalAIModels = localAIOptions.filter((option) => option.model && isLocalModelInstalled(option.model));
      return (
        <div className="market-agent-setup-panel">
          <div className="market-agent-step-copy">
            <span>Analysis</span>
            <h3>Auto Local AI</h3>
            <p>Optional local model. Rule-based evidence remains the source of truth.</p>
          </div>
          {!llmData?.available ? (
            <div className="market-agent-empty-state">{llmData?.message || "LLM configuration is unavailable."}</div>
          ) : (
            <>
              <div className="market-agent-ai-console">
                <div className="market-agent-ai-console-main">
                  <div className="market-agent-ai-summary-row">
                    <div>
                      <span>Selected model</span>
                      <strong>{localAIMode === "off" ? "Rule-based only" : selectedModelLabel}</strong>
                      <p>{localAIMode === "auto" ? recommended?.reason || selectedOption.detail : selectedOption.detail}</p>
                    </div>
                    <div className="market-agent-ai-summary-action">
                      <span>{localAIRuntimeLabel} · Rule-based active</span>
                      {localAIMode !== "off" && !isModelReady ? (
                        <button
                          type="button"
                          className="btn primary btn-compact market-agent-model-download-button"
                          disabled={installDisabled}
                          onClick={() => void installSelectedModel()}
                        >
                          {isDownloadingModel ? <span className="market-agent-inline-spinner" aria-hidden="true" /> : null}
                          <span className="market-agent-model-download-label">
                            {isDownloadingModel
                              ? isPullingModel
                                ? "Downloading"
                                : "Preparing"
                              : localAIMode === "auto"
                                ? "Download recommended"
                                : "Download model"}
                          </span>
                        </button>
                      ) : null}
                      {localAIMode !== "off" && isModelReady ? (
                        <button
                          type="button"
                          className="btn primary btn-compact"
                          onClick={() => void onSaveLLM({ ...llmForm, enabled: true, model: selectedModel || llmForm.model })}
                        >
                          Use this model
                        </button>
                      ) : null}
                      {localAIMode === "off" ? (
                        <button
                          type="button"
                          className="btn primary btn-compact"
                          onClick={() => void onSaveLLM({ ...llmForm, enabled: false, model: selectedModel || llmForm.model })}
                        >
                          Disable Local AI
                        </button>
                      ) : null}
                      {isDownloadingModel ? (
                        <button type="button" className="btn ghost btn-compact" onClick={() => void cancelSelectedModelDownload()}>
                          Cancel download
                        </button>
                      ) : null}
                    </div>
                  </div>
                  {ollama?.installed === false ? (
                    <div className="market-agent-readable-status-line">
                      <span>Local AI runtime will be prepared automatically when you download a model.</span>
                    </div>
                  ) : null}
                  {pullProgress ? (
                    <div className="market-agent-provider-config-result market-agent-model-download-card">
                      <div className="market-agent-provider-config-result-head">
                        <strong>{pullProgress.done ? "Model ready" : isPullingModel ? "Downloading model" : "Preparing Local AI"}</strong>
                        <MarketAgentStatusBadge label={pullProgress.status || "downloading model"} />
                      </div>
                      <div className="market-agent-provider-config-result-body">
                        {progressStage ? <strong className="market-agent-download-stage">{progressStage}</strong> : null}
                        <span>
                          {pullProgress.completedBytes != null && pullProgress.totalBytes != null
                            ? `${pullProgress.completedBytes} / ${pullProgress.totalBytes} bytes`
                            : pullProgress.message || "Waiting for Local AI progress..."}
                        </span>
                        {typeof pullProgress.percent === "number" && isPullingModel ? <span>{progressPercent.toFixed(1)}%</span> : null}
                        <div
                          className={`market-agent-download-progress${pullProgress.done || pullProgress.status === "cancelled" ? " settled" : ""}`}
                          aria-hidden="true"
                        >
                          <span style={{ width: `${Math.max(0, Math.min(100, progressPercent))}%` }} />
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
                <div className="market-agent-ai-mode-panel" aria-label="Local AI model options">
                  {localAIOptions.map((option) => (
                    <button
                      key={option.mode}
                      className={`market-agent-local-ai-option${localAIMode === option.mode ? " active" : ""}${option.warning ? " warning" : ""}`}
                      type="button"
                      aria-label={option.label}
                      aria-pressed={localAIMode === option.mode}
                      onClick={() => selectLocalAIMode(option.mode)}
                    >
                      <strong>{option.label}</strong>
                      <span>
                        {option.model && isLocalModelInstalled(option.model)
                          ? "Installed"
                          : option.mode === "off"
                            ? "LLM off"
                            : option.badge}
                      </span>
                    </button>
                  ))}
                </div>
                <p className="market-agent-ai-footnote">
                  {installedLocalAIModels.length > 0
                    ? `Installed locally: ${installedLocalAIModels.map((option) => option.label).join(", ")}.`
                    : localAIMode === "off"
                      ? "Local AI is disabled. The rule-based engine still runs."
                      : "The app can prepare the local model automatically when needed."}
                </p>
              </div>
              {llmResult || localAIResult ? (
                <div className="market-agent-provider-config-result">
                  <div className="market-agent-provider-config-result-head">
                    <strong>Model check</strong>
                    <MarketAgentStatusBadge
                      label={(localAIResult || llmResult)?.status || ((localAIResult || llmResult)?.ok ? "model ready" : "failed")}
                    />
                  </div>
                  <div className="market-agent-provider-config-result-body">
                    <span>{(localAIResult || llmResult)?.message || (localAIResult || llmResult)?.error || "Completed."}</span>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </div>
      );
    }

    if (activeStep === "telegram") {
      return (
        <div className="market-agent-setup-panel market-agent-telegram-panel">
          <div className="market-agent-step-copy">
            <span>Alerts</span>
            <h3>Telegram alerts</h3>
            <p>Telegram is optional. It only sends meaningful changes.</p>
          </div>
          {!telegramData?.available ? (
            <div className="market-agent-empty-state">
              {telegramData?.message || "Telegram configuration is unavailable."}
            </div>
          ) : (
            <>
              <div className="market-agent-telegram-console">
                <label className={`market-agent-telegram-master${telegramForm.enabled ? " active" : ""}`}>
                  <input
                    type="checkbox"
                    aria-label="Enable Telegram alerts"
                    checked={telegramForm.enabled}
                    onChange={(event) =>
                      setTelegramForm((current) => {
                        setTelegramSaveState("idle");
                        return { ...current, enabled: event.target.checked };
                      })
                    }
                  />
                  <span className="market-agent-switch-track" aria-hidden="true">
                    <span />
                  </span>
                  <span className="market-agent-telegram-master-copy">
                    <strong>Telegram delivery</strong>
                    <small>
                      {telegramForm.enabled
                        ? "Enabled. Meaningful market changes can be sent."
                        : "Off. Monitoring and dashboard still run normally."}
                    </small>
                  </span>
                  <MarketAgentStatusBadge
                    label={telegramData.telegram?.lastSendStatus || "Not tested"}
                    tone={telegramData.telegram?.lastError ? "bad" : "neutral"}
                  />
                </label>
                <div className="market-agent-telegram-form">
                  <div className="market-agent-provider-config-grid telegram">
                    <label>
                      <span>Bot token</span>
                      <input
                        type="password"
                        value={telegramForm.botToken}
                        onChange={(event) =>
                          setTelegramForm((current) => {
                            setTelegramSaveState("idle");
                            return { ...current, botToken: event.target.value };
                          })
                        }
                        placeholder={telegramData.telegram?.botTokenMasked || ""}
                      />
                    </label>
                    <label>
                      <span>Chat ID</span>
                      <input
                        value={telegramForm.chatId}
                        onChange={(event) =>
                          setTelegramForm((current) => {
                            setTelegramSaveState("idle");
                            return { ...current, chatId: event.target.value };
                          })
                        }
                      />
                    </label>
                  </div>
                  <div className="market-agent-telegram-section-label">
                    <span>Alert types</span>
                    <small>Choose what is worth interrupting you for.</small>
                  </div>
                  <div className="market-agent-telegram-preferences">
                    {["level_2", "level_3"].map((level) => (
                      <label
                        className={`market-agent-alert-choice${telegramForm.levels.includes(level) ? " active" : ""}`}
                        key={level}
                      >
                        <input
                          type="checkbox"
                          checked={telegramForm.levels.includes(level)}
                          onChange={(event) => toggleTelegramLevel(level, event.target.checked)}
                        />
                        <span>{level === "level_3" ? "Breaking drivers" : "Situation changes"}</span>
                        <small>
                          {level === "level_3"
                            ? "High-priority driver changes and invalidation."
                            : "Meaningful shifts in the current market state."}
                        </small>
                      </label>
                    ))}
                  </div>
                </div>
              </div>
              <div className="market-agent-provider-config-actions market-agent-action-bar market-agent-action-bar-float">
                <button
                  type="button"
                  className="btn primary btn-compact"
                  onClick={() => void saveTelegram()}
                  disabled={telegramSaveState === "saving"}
                >
                  {telegramSaveState === "saving"
                    ? "Saving..."
                    : telegramSaveState === "saved"
                      ? "Saved"
                      : "Save changes"}
                </button>
                <button
                  type="button"
                  className="btn ghost btn-compact"
                  onClick={() => void runTelegramAction()}
                  disabled={telegramTestState === "sending"}
                >
                  {telegramTestState === "sending" ? "Sending..." : "Send test"}
                </button>
              </div>
              <div className="market-agent-telegram-inline-status" aria-live="polite">
                <span className={`dot ${telegramForm.enabled ? "on" : "off"}`} />
                <strong>{telegramForm.enabled ? "Alerts on" : "Alerts off"}</strong>
                <span>
                  {telegramSaveState === "saved"
                    ? "Settings saved locally."
                    : telegramSaveState === "saving"
                      ? "Saving settings..."
                      : telegramSaveState === "failed"
                        ? "Save failed. Check token and chat ID."
                        : telegramTestState === "sending"
                          ? "Sending test message..."
                          : telegramTestState === "sent"
                            ? "Test message sent."
                            : telegramTestState === "failed"
                              ? "Test message failed."
                              : "Changes apply after saving."}
                </span>
              </div>
              {telegramData.telegram?.lastError ? (
                <div className="market-agent-readable-status-line">
                  <span>Last error: {telegramData.telegram.lastError}</span>
                </div>
              ) : null}
              {telegramResult ? (
                <div className="market-agent-provider-config-result">
                  <div className="market-agent-provider-config-result-head">
                    <strong>Telegram status</strong>
                    <MarketAgentStatusBadge label={telegramResult.ok ? "sent" : "failed"} />
                  </div>
                  <div className="market-agent-provider-config-result-body">
                    <span>{telegramResult.message || telegramResult.error || "Completed."}</span>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </div>
      );
    }

    return (
      <div className="market-agent-setup-panel market-agent-monitoring-panel">
          <div className="market-agent-step-copy">
            <span>Monitoring</span>
            <h3>Start monitoring</h3>
            <p>
            {monitorStatus?.running
              ? "Monitoring is running."
              : "Monitoring is stopped."}
            </p>
          </div>
        {!data?.ctrader?.enabled ? (
          <p className="market-agent-warning-line">Connect cTrader before live monitoring.</p>
        ) : null}
        <div className="market-agent-run-console">
          <div className={`market-agent-run-indicator${monitorStatus?.running ? " running" : ""}`} aria-hidden="true" />
          <div className="market-agent-run-status">
            <span>Monitor loop</span>
            <strong>{monitorStatus?.running ? "Running" : "Stopped"}</strong>
            <p>When monitoring starts, the app automatically backfills missing cTrader history before analysis.</p>
          </div>
          <div className="market-agent-run-metrics">
            <div>
              <span>Last check</span>
              <strong>{monitorStatus?.lastRunAt ? formatShortTime(monitorStatus.lastRunAt) : "Not run yet"}</strong>
            </div>
            <div>
              <span>Telegram</span>
              <strong>{telegramData?.telegram?.lastSendStatus || "Not tested"}</strong>
            </div>
          </div>
        </div>
        <div className="market-agent-provider-config-actions market-agent-action-bar market-agent-action-bar-float">
          {monitorStatus?.running ? (
            <button type="button" className="btn primary btn-compact market-agent-stop-action" onClick={() => void onStopMonitorLoop()}>
              Stop Monitoring
            </button>
          ) : (
            <button type="button" className="btn primary btn-compact" onClick={() => void onStartMonitorLoop()}>
              Start Monitoring
            </button>
          )}
            <button type="button" className="btn ghost btn-compact" onClick={() => void onRunMonitorOnce()}>
              Check Now
            </button>
        </div>
      </div>
    );
  };

  return (
    <section className="market-agent-surface" data-qa="qa:market-agent:provider-config" ref={surfaceRef}>
      <div className="market-agent-surface-header">
        <div>
          <h2>Data Sources</h2>
          <span className="hint">Connect cTrader and start monitoring</span>
        </div>
        <div className="market-agent-provider-config-statuses">
          <MarketAgentStatusBadge
            label={
              cTraderLive
                ? "cTrader live"
                : cTraderConfigured
                  ? "Preparing live feed"
                  : "cTrader not connected"
            }
            tone={statusTone}
          />
        </div>
      </div>

      {!data?.available ? (
        <div className="market-agent-empty-state">{data?.message || "Provider configuration is unavailable."}</div>
      ) : (
        <div className="market-agent-setup-flow">
          <div className="market-agent-setup-body">
            <nav className="market-agent-setup-tabs" aria-label="Data source setup actions">
              {setupActions.map((step) => (
                <button
                  type="button"
                  key={step.id}
                  aria-label={step.label}
                  aria-pressed={activeStep === step.id}
                  className={activeStep === step.id ? "active" : ""}
                  onClick={() => selectStep(step.id)}
                >
                  <span>
                    <strong>{step.label}</strong>
                    <small>{step.detail}</small>
                  </span>
                  <em>{step.status}</em>
                </button>
              ))}
            </nav>
            {renderStep()}
          </div>
        </div>
      )}
    </section>
  );
}
