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
  MarketAgentCTraderAuthResponse,
  MarketAgentTelegramActionResponse,
  MarketAgentTelegramConfigInput,
  MarketAgentTelegramConfigResponse
} from "../types";
import { MarketAgentStatusBadge } from "./MarketAgentStatusBadge";
import "./MarketAgentProviderConfig.css";

type MarketAgentProviderConfigProps = {
  data: MarketAgentProviderConfigResponse | null;
  telegramData: MarketAgentTelegramConfigResponse | null;
  llmData: MarketAgentLLMConfigResponse | null;
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
  onCancelModelDownload?: () => Promise<MarketAgentLLMActionResponse>;
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
  endpoint: "http://localhost:11434",
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
  const [llmResult, setLLMResult] = useState<MarketAgentLLMActionResponse | null>(null);
  const [localAIResult, setLocalAIResult] = useState<MarketAgentLLMActionResponse | null>(null);
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
  }, [telegramData]);

  useEffect(() => {
    const llm = llmData?.llm;
    if (!llm) return;
    setLLMForm({
      enabled: llm.enabled,
      provider: llm.provider || "ollama",
      endpoint: llm.endpoint || "http://localhost:11434",
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

  const statusTone = useMemo(() => {
    if (!data?.available) return "bad";
    if (data.ctrader?.enabled) return "good";
    return "warn";
  }, [data]);

  const setupComplete = Boolean(
    data?.ctrader?.enabled || telegramData?.telegram?.enabled || llmData?.llm?.enabled || monitorStatus?.running
  );

  const nextSetupStep = (() => {
    if (!data?.ctrader?.enabled) {
      return {
        label: "cTrader connection needed",
        description: "Add the cTrader login used for live XAUUSD. Market context, calendar checks, and missing history run in the background.",
        action: "Open cTrader setup",
        step: "ctrader" as SetupStep
      };
    }
    if (localSetup?.status === "model_missing") {
      return {
        label: "Local AI model missing",
        description: "Rule-based evidence is already active. Download the recommended local model only if you want AI explanations.",
        action: "Enable Local AI",
        step: "llm" as SetupStep
      };
    }
    if (!telegramData?.telegram?.enabled) {
      return {
        label: "Telegram is optional",
        description: "Monitoring can run without Telegram. Enable it only if you want alerts sent out of the app.",
        action: "Enable Telegram",
        step: "telegram" as SetupStep
      };
    }
    if (!monitorStatus?.running) {
      return {
        label: "Ready to monitor",
        description: "Live price, market context, and evidence checks are ready. Start the loop when you want continuous monitoring.",
        action: "Start Monitoring",
        step: "monitoring" as SetupStep
      };
    }
    return {
      label: "Monitoring is running",
      description: "The agent is watching live XAUUSD and related evidence. You can adjust alerts or Local AI any time.",
      action: "View Monitoring",
      step: "monitoring" as SetupStep
    };
  })();

  const setupActions: Array<{ id: SetupStep; label: string; detail: string; status: string }> = [
    {
      id: "ctrader",
      label: "cTrader",
      detail: "Live XAUUSD",
      status: data?.ctrader?.enabled ? "Connected" : "Needed"
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
      status: telegramData?.telegram?.enabled ? "On" : "Off"
    },
    {
      id: "monitoring",
      label: "Monitoring",
      detail: "Agent loop",
      status: monitorStatus?.running ? "Running" : "Stopped"
    }
  ];

  const toggleTelegramLevel = (level: string, checked: boolean) => {
    setTelegramForm((current) => ({
      ...current,
      levels: checked
        ? Array.from(new Set([...current.levels, level]))
        : current.levels.filter((item) => item !== level)
    }));
  };

  const runTelegramAction = async () => {
    const result = await onTestTelegram(telegramForm);
    setTelegramResult(result);
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
    const result = await onInstallRecommendedModel(model);
    setLocalAIResult(result);
    const fallbackModel =
      result.policy && typeof result.policy.model === "string" ? result.policy.model : undefined;
    const fallbackStatus =
      result.policy && typeof result.policy.status === "string" ? result.policy.status : undefined;
    if (fallbackModel) {
      setLLMForm((current) => ({ ...current, model: fallbackModel, enabled: fallbackStatus !== "llm_disabled" }));
    }
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
        </div>
      );
    }

    if (activeStep === "llm") {
      const recommended = localSetup?.recommendedModel;
      const ollama = localSetup?.ollama;
      const pullProgress = localAiPullProgress;
      const selectedModel = selectedLocalAIModel();
      const isDownloadingModel = Boolean(pullProgress && !pullProgress.done && !pullProgress.error);
      const selectedModelInstalled = isLocalModelInstalled(selectedModel);
      const isModelReady = localSetup?.status === "model_ready" || selectedModelInstalled;
      const installDisabled = localAIMode === "off" || ollama?.installed === false || ollama?.running === false || isDownloadingModel;
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
          detail: `Recommended for this machine: ${recommended?.name || "qwen3.5:4b"}.`,
          badge: recommended?.diskLabel || "Recommended",
          model: recommended?.name || "qwen3.5:4b"
        },
        {
          mode: "balanced",
          label: "Balanced",
          detail: "Best choice for most desktops. Uses the larger local model for fast JSON.",
          badge: "~2.9 GB",
          model: "qwen3.5:4b"
        },
        {
          mode: "lightweight",
          label: "Lightweight",
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
          ? "Ollama not installed"
          : ollama?.running === false
            ? "Ollama stopped"
            : localAIMode === "off"
              ? "LLM disabled"
              : isModelReady
                ? "Model ready"
                : "Model missing";
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
                      <strong>{localAIMode === "off" ? "Rule-based only" : selectedModel}</strong>
                      <p>{localAIMode === "auto" ? recommended?.reason || selectedOption.detail : selectedOption.detail}</p>
                    </div>
                    <div className="market-agent-ai-summary-action">
                      <span>{localAIRuntimeLabel} · Rule-based active</span>
                      {localAIMode !== "off" && !isModelReady ? (
                        <button
                          type="button"
                          className="btn primary btn-compact"
                          disabled={installDisabled}
                          title={
                            installDisabled && !isDownloadingModel
                              ? "Install and start Ollama before pulling a local model."
                              : undefined
                          }
                          onClick={() => void installSelectedModel()}
                        >
                          {isDownloadingModel
                            ? `Downloading ${pullProgress?.model || selectedModel}`
                            : localAIMode === "auto"
                              ? "Download recommended"
                              : "Download model"}
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
                        <button type="button" className="btn ghost btn-compact" onClick={() => void (onCancelModelDownload ? onCancelModelDownload().then(setLocalAIResult) : Promise.resolve())}>
                          Cancel download
                        </button>
                      ) : null}
                    </div>
                  </div>
                  {ollama?.installed === false ? (
                    <div className="market-agent-readable-status-line">
                      <span>Install Ollama manually from {ollama.installerUrl || "https://ollama.com/download"} and return here.</span>
                    </div>
                  ) : null}
                  {pullProgress ? (
                    <div className="market-agent-provider-config-result">
                      <div className="market-agent-provider-config-result-head">
                        <strong>Downloading model</strong>
                        <MarketAgentStatusBadge label={pullProgress.status || "downloading model"} />
                      </div>
                      <div className="market-agent-provider-config-result-body">
                        <span>
                          {pullProgress.completedBytes != null && pullProgress.totalBytes != null
                            ? `${pullProgress.completedBytes} / ${pullProgress.totalBytes} bytes`
                            : pullProgress.message || "Waiting for Ollama progress..."}
                        </span>
                        {typeof pullProgress.percent === "number" ? <span>{pullProgress.percent.toFixed(1)}%</span> : null}
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
                      : "No qwen3.5 model is installed locally yet."}
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
                      setTelegramForm((current) => ({ ...current, enabled: event.target.checked }))
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
                          setTelegramForm((current) => ({ ...current, botToken: event.target.value }))
                        }
                        placeholder={telegramData.telegram?.botTokenMasked || ""}
                      />
                    </label>
                    <label>
                      <span>Chat ID</span>
                      <input
                        value={telegramForm.chatId}
                        onChange={(event) =>
                          setTelegramForm((current) => ({ ...current, chatId: event.target.value }))
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
                <button type="button" className="btn primary btn-compact" onClick={() => void onSaveTelegram(telegramForm)}>
                  Save Telegram alerts
                </button>
                <button type="button" className="btn ghost btn-compact" onClick={() => void runTelegramAction()}>
                  Send Test Message
                </button>
              </div>
              {telegramData.telegram?.lastError ? (
                <div className="market-agent-readable-status-line">
                  <span>Last error: {telegramData.telegram.lastError}</span>
                </div>
              ) : null}
              {telegramResult ? (
                <div className="market-agent-provider-config-result">
                  <div className="market-agent-provider-config-result-head">
                    <strong>Telegram Test</strong>
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
              <strong>{String(monitorStatus?.lastRunAt ?? "Not run yet")}</strong>
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
            label={data?.ctrader?.enabled ? "cTrader connected" : "cTrader not connected"}
            tone={statusTone}
          />
        </div>
      </div>

      {!data?.available ? (
        <div className="market-agent-empty-state">{data?.message || "Provider configuration is unavailable."}</div>
      ) : (
        <div className="market-agent-setup-flow">
          <section className="market-agent-setup-status-card">
            <div>
              <span className="market-agent-setup-status-eyebrow">{setupComplete ? "Setup status" : "Next step"}</span>
              <h3>{nextSetupStep.label}</h3>
              <p>{nextSetupStep.description}</p>
            </div>
            <div className="market-agent-setup-status-actions">
              <button type="button" className="btn primary btn-compact" onClick={() => selectStep(nextSetupStep.step)}>
                {nextSetupStep.action}
              </button>
            </div>
          </section>
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
