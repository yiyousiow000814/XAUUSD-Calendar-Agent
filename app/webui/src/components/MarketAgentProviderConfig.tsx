import { useEffect, useMemo, useRef, useState } from "react";

import type {
  MarketAgentProviderActionResponse,
  MarketAgentProviderConfigInput,
  MarketAgentProviderConfigResponse,
  MarketAgentLLMActionResponse,
  MarketAgentLLMConfigInput,
  MarketAgentLLMConfigResponse,
  MarketAgentMonitorStatusResponse,
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
  onSave: (ctrader: MarketAgentProviderConfigInput) => void;
  onClear: () => void;
  onTestConnection: (ctrader: MarketAgentProviderConfigInput) => Promise<MarketAgentProviderActionResponse>;
  onResolveSymbol: (ctrader: MarketAgentProviderConfigInput) => Promise<MarketAgentProviderActionResponse>;
  onQuoteTest: (ctrader: MarketAgentProviderConfigInput) => Promise<MarketAgentProviderActionResponse>;
  onRefreshToken: (ctrader: MarketAgentProviderConfigInput) => Promise<MarketAgentProviderActionResponse>;
  onSaveTelegram: (telegram: MarketAgentTelegramConfigInput) => Promise<MarketAgentTelegramConfigResponse>;
  onTestTelegram: (telegram: MarketAgentTelegramConfigInput) => Promise<MarketAgentTelegramActionResponse>;
  onSaveLLM: (llm: MarketAgentLLMConfigInput) => Promise<MarketAgentLLMConfigResponse>;
  onTestLLMConnection: (llm: MarketAgentLLMConfigInput) => Promise<MarketAgentLLMActionResponse>;
  onTestLLMJsonResponse: (llm: MarketAgentLLMConfigInput) => Promise<MarketAgentLLMActionResponse>;
  monitorStatus: MarketAgentMonitorStatusResponse | null;
  onRunMonitorOnce: () => Promise<MarketAgentMonitorStatusResponse>;
  onRunBackfillRecovery: () => Promise<MarketAgentMonitorStatusResponse>;
  onStartMonitorLoop: () => Promise<MarketAgentMonitorStatusResponse>;
  onStopMonitorLoop: () => Promise<MarketAgentMonitorStatusResponse>;
};

type SetupStep = "price" | "ctrader" | "fallbacks" | "news" | "llm" | "telegram" | "monitoring";

const emptyForm: MarketAgentProviderConfigInput = {
  enabled: false,
  environment: "demo",
  clientId: "",
  clientSecret: "",
  accessToken: "",
  refreshToken: "",
  accountId: "",
  symbol: "XAUUSD",
  symbolId: null,
  appRedirectUri: "",
  tokenStorePath: "",
  snapshotPath: "",
  quoteTimeoutSeconds: 8,
  quoteStaleAfterSeconds: 15,
  allowSavedSnapshotFallback: true,
  bridgePythonExecutable: "python"
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
  model: "qwen3:4b",
  temperature: 0.1,
  timeoutSeconds: 20,
  keepAlive: "0",
  maxContext: 8192
};

export function MarketAgentProviderConfig({
  data,
  telegramData,
  llmData,
  onSave,
  onClear,
  onTestConnection,
  onResolveSymbol,
  onQuoteTest,
  onRefreshToken,
  onSaveTelegram,
  onTestTelegram,
  onSaveLLM,
  onTestLLMConnection,
  onTestLLMJsonResponse,
  monitorStatus,
  onRunMonitorOnce,
  onRunBackfillRecovery,
  onStartMonitorLoop,
  onStopMonitorLoop
}: MarketAgentProviderConfigProps) {
  const [form, setForm] = useState<MarketAgentProviderConfigInput>(emptyForm);
  const [telegramForm, setTelegramForm] = useState<MarketAgentTelegramConfigInput>(emptyTelegramForm);
  const [llmForm, setLLMForm] = useState<MarketAgentLLMConfigInput>(emptyLLMForm);
  const [actionResult, setActionResult] = useState<MarketAgentProviderActionResponse | null>(null);
  const [telegramResult, setTelegramResult] = useState<MarketAgentTelegramActionResponse | null>(null);
  const [llmResult, setLLMResult] = useState<MarketAgentLLMActionResponse | null>(null);
  const [actionLabel, setActionLabel] = useState("");
  const [activeStep, setActiveStep] = useState<SetupStep>("price");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const surfaceRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const ctrader = data?.ctrader;
    if (!ctrader) return;
    setForm((current) => ({
      ...current,
      enabled: ctrader.enabled,
      environment: ctrader.environment || "demo",
      accountId: ctrader.accountId || "",
      symbol: ctrader.symbol || "XAUUSD",
      symbolId: ctrader.symbolId ?? null,
      appRedirectUri: ctrader.appRedirectUri || "",
      tokenStorePath: ctrader.tokenStorePath || "",
      snapshotPath: ctrader.snapshotPath || "",
      quoteTimeoutSeconds: ctrader.quoteTimeoutSeconds || 8,
      quoteStaleAfterSeconds: ctrader.quoteStaleAfterSeconds || 15,
      allowSavedSnapshotFallback: ctrader.allowSavedSnapshotFallback,
      bridgePythonExecutable: ctrader.bridgePythonExecutable || "python"
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
      model: llm.model || "qwen3:4b",
      temperature: typeof llm.temperature === "number" ? llm.temperature : 0.1,
      timeoutSeconds: llm.timeoutSeconds || 20,
      keepAlive: llm.keepAlive || "0",
      maxContext: llm.maxContext || 8192
    });
  }, [llmData]);

  const statusTone = useMemo(() => {
    if (!data?.available) return "bad";
    if (data.ctrader?.enabled) return "good";
    return "warn";
  }, [data]);

  const setupComplete = Boolean(
    data?.ctrader?.enabled || telegramData?.telegram?.enabled || llmData?.llm?.enabled || monitorStatus?.running
  );

  const checklist = [
    {
      label: "Price source",
      value: data?.ctrader?.enabled ? "cTrader spot" : "Not configured",
      tone: data?.ctrader?.enabled ? "good" : "warn"
    },
    { label: "Market context", value: "Automatic", tone: "neutral" },
    { label: "News", value: "Automatic", tone: "neutral" },
    { label: "Calendar", value: "Automatic", tone: "neutral" },
    {
      label: "Telegram",
      value: telegramData?.telegram?.enabled ? "Enabled" : "Disabled",
      tone: telegramData?.telegram?.enabled ? "good" : "warn"
    },
    {
      label: "Analysis",
      value: llmData?.llm?.enabled ? llmData.llm.lastStatus || "Enabled" : "Rule-based",
      tone: llmData?.llm?.enabled ? (llmData.llm.lastError ? "bad" : "good") : "neutral"
    },
    {
      label: "Monitor loop",
      value: monitorStatus?.running ? "Running" : "Stopped",
      tone: monitorStatus?.running ? "good" : "warn"
    }
  ] as const;

  const steps: Array<{ id: SetupStep; label: string }> = [
    { id: "price", label: "Price" },
    { id: "ctrader", label: "cTrader" },
    { id: "fallbacks", label: "Market data" },
    { id: "news", label: "News" },
    { id: "llm", label: "Analysis" },
    { id: "telegram", label: "Alerts" },
    { id: "monitoring", label: "Monitoring" }
  ];

  const runAction = async (
    label: string,
    action: (ctrader: MarketAgentProviderConfigInput) => Promise<MarketAgentProviderActionResponse>
  ) => {
    setActionLabel(label);
    const result = await action(form);
    setActionResult(result);
  };

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

  const runLLMAction = async (action: (llm: MarketAgentLLMConfigInput) => Promise<MarketAgentLLMActionResponse>) => {
    const result = await action(llmForm);
    setLLMResult(result);
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

  const renderCTraderResult = () => {
    if (!actionResult) return null;
    return (
      <div className="market-agent-provider-config-result" data-qa="qa:market-agent:provider-config-result">
      <div className="market-agent-provider-config-result-head">
        <strong>{actionLabel || "Test result"}</strong>
        <MarketAgentStatusBadge label={actionResult.ok ? "success" : "failed"} />
      </div>
      <div className="market-agent-provider-config-result-body">
        <span>{actionResult.message || actionResult.error || "Completed."}</span>
        {actionResult.symbol ? (
          <span>
            Symbol: {String(actionResult.symbol.symbolName ?? "unknown")} / ID{" "}
            {String(actionResult.symbol.symbolId ?? "--")}
          </span>
        ) : null}
        {actionResult.quote ? (
          <span>
            Quote: {String(actionResult.quote.symbol ?? "XAUUSD")} {String(actionResult.quote.mid ?? "--")} (
            {String(actionResult.quote.source_type ?? "spot")})
          </span>
        ) : null}
      </div>
    </div>
    );
  };

  const renderStep = () => {
    if (activeStep === "price") {
      return (
        <div className="market-agent-setup-panel">
          <h3>Price source</h3>
          <p>Use cTrader for live XAUUSD. Backup price data is automatic when cTrader is unavailable.</p>
          <div className="market-agent-source-options">
            <article className="recommended">
              <span>Primary</span>
              <strong>cTrader</strong>
              <p>Live XAUUSD price and missed-history recovery.</p>
              <button type="button" className="btn ghost btn-compact" onClick={() => selectStep("ctrader")}>
                Connect cTrader
              </button>
            </article>
            <article>
              <span>Automatic</span>
              <strong>XAUUSD backup price</strong>
              <p>Only used when cTrader is not connected or stale.</p>
              <MarketAgentStatusBadge label="Futures proxy" tone="warn" />
            </article>
            <article>
              <span>Support only</span>
              <strong>Local CSV</strong>
              <p>Fixture import and debugging only.</p>
            </article>
          </div>
        </div>
      );
    }

    if (activeStep === "ctrader") {
      return (
        <div className="market-agent-setup-panel market-agent-ctrader-panel">
          <h3>Connect cTrader</h3>
          <p>Paste Open API details. Market Agent uses them for live XAUUSD and missed-history recovery.</p>
          <p className="market-agent-security-note">
            No cTrader password is needed. Use Open API tokens only.
          </p>
          <div className="market-agent-provider-config-grid primary market-agent-ctrader-primary-grid">
            <label>
              <span>Account ID</span>
              <input
                value={form.accountId}
                onChange={(event) => setForm((current) => ({ ...current, accountId: event.target.value }))}
                placeholder="cTrader Open API account ID"
              />
            </label>
            <label>
              <span>Client ID</span>
              <input
                value={form.clientId}
                onChange={(event) => setForm((current) => ({ ...current, clientId: event.target.value }))}
                placeholder={data?.ctrader?.clientIdMasked || ""}
              />
            </label>
            <label>
              <span>Client Secret</span>
              <input
                type="password"
                value={form.clientSecret}
                onChange={(event) => setForm((current) => ({ ...current, clientSecret: event.target.value }))}
                placeholder={data?.ctrader?.clientSecretMasked || ""}
              />
            </label>
            <label>
              <span>Access Token</span>
              <input
                type="password"
                value={form.accessToken}
                onChange={(event) => setForm((current) => ({ ...current, accessToken: event.target.value }))}
                placeholder={data?.ctrader?.accessTokenMasked || ""}
              />
            </label>
          </div>
          <div className="market-agent-provider-config-toggles single">
            <label className="market-agent-toggle">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(event) => setForm((current) => ({ ...current, enabled: event.target.checked }))}
              />
              <span>Use cTrader for XAUUSD data</span>
            </label>
          </div>
          <div className="market-agent-provider-config-actions primary">
            <button
              type="button"
              className="btn primary btn-compact"
              onClick={() => {
                onSave(form);
                void runAction("Connection check", onTestConnection);
              }}
            >
              Save & test
            </button>
            <button type="button" className="btn ghost btn-compact" onClick={onClear}>
              Clear
            </button>
          </div>
          <details
            className="market-agent-advanced-settings"
            open={advancedOpen}
          >
            <summary
              onClick={(event) => {
                event.preventDefault();
                setAdvancedOpen((current) => !current);
              }}
            >
              Broker-specific options
            </summary>
            {advancedOpen ? (
              <>
                <p className="market-agent-support-note">
                  Leave these unchanged unless your broker uses a custom XAUUSD symbol or support asks for a quote test.
                </p>
                <div className="market-agent-provider-config-grid">
                  <label>
                    <span>Trading environment</span>
                    <select
                      value={form.environment}
                      onChange={(event) => setForm((current) => ({ ...current, environment: event.target.value }))}
                    >
                      <option value="demo">demo</option>
                      <option value="live">live</option>
                    </select>
                  </label>
                  <label>
                    <span>Symbol name</span>
                    <input
                      value={form.symbol}
                      onChange={(event) => setForm((current) => ({ ...current, symbol: event.target.value }))}
                    />
                  </label>
                  <label>
                    <span>Refresh Token</span>
                    <input
                      type="password"
                      value={form.refreshToken}
                      onChange={(event) => setForm((current) => ({ ...current, refreshToken: event.target.value }))}
                      placeholder={data?.ctrader?.refreshTokenMasked || ""}
                    />
                  </label>
                  <label>
                    <span>Symbol ID override</span>
                    <input
                      value={form.symbolId ?? ""}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          symbolId: event.target.value ? Number(event.target.value) : null
                        }))
                      }
                    />
                  </label>
                  <label>
                    <span>Redirect URI</span>
                    <input
                      value={form.appRedirectUri || ""}
                      onChange={(event) => setForm((current) => ({ ...current, appRedirectUri: event.target.value }))}
                    />
                  </label>
                  <label>
                    <span>Snapshot path</span>
                    <input
                      value={form.snapshotPath || ""}
                      onChange={(event) => setForm((current) => ({ ...current, snapshotPath: event.target.value }))}
                    />
                  </label>
                  <label>
                    <span>Token store path</span>
                    <input
                      value={form.tokenStorePath || ""}
                      onChange={(event) => setForm((current) => ({ ...current, tokenStorePath: event.target.value }))}
                    />
                  </label>
                  <label>
                    <span>Bridge Python</span>
                    <input
                      value={form.bridgePythonExecutable || "python"}
                      onChange={(event) =>
                        setForm((current) => ({ ...current, bridgePythonExecutable: event.target.value }))
                      }
                    />
                  </label>
                </div>
                <div className="market-agent-provider-config-toggles single">
                  <label className="market-agent-toggle">
                    <input
                      type="checkbox"
                      checked={form.allowSavedSnapshotFallback}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          allowSavedSnapshotFallback: event.target.checked
                        }))
                      }
                    />
                    <span>Allow saved snapshot fallback when spot fetch fails</span>
                  </label>
                </div>
                <div className="market-agent-provider-config-meta">
                  <span>Config path: {data?.ctrader?.configPath || "--"}</span>
                  <span>Token store: {data?.ctrader?.tokenStorePath || "--"}</span>
                  <span>Snapshot path: {data?.ctrader?.snapshotPath || "--"}</span>
                </div>
              </>
            ) : null}
          </details>
          {advancedOpen ? (
            <div className="market-agent-provider-config-actions compact">
              <button type="button" className="btn ghost btn-compact" onClick={() => void runAction("Resolve Symbol", onResolveSymbol)}>
                Check broker symbol
              </button>
              <button type="button" className="btn ghost btn-compact" onClick={() => void runAction("Live quote test", onQuoteTest)}>
                Run quote test
              </button>
              <button type="button" className="btn ghost btn-compact" onClick={() => void runAction("Refresh Token", onRefreshToken)}>
                Refresh token
              </button>
            </div>
          ) : null}
          {renderCTraderResult()}
        </div>
      );
    }

    if (activeStep === "fallbacks") {
      return (
        <div className="market-agent-setup-panel">
          <h3>Market data</h3>
          <p>These are automatic. You do not need to configure them.</p>
          <div className="market-agent-source-options compact market-agent-managed-sources">
            {["XAUUSD backup price", "DXY", "US10Y", "US2Y", "Oil", "VIX / Equities"].map((name) => (
              <article key={name}>
                <strong>{name}</strong>
                <p>
                  {name === "US2Y"
                    ? "Used when a reliable source is available."
                    : name === "XAUUSD backup price"
                      ? "Only used if cTrader is unavailable."
                      : "Used as market context when fresh."}
                </p>
                <MarketAgentStatusBadge
                  label={name === "XAUUSD backup price" ? "Backup proxy" : name === "US2Y" ? "When available" : "Automatic"}
                  tone={name === "XAUUSD backup price" ? "warn" : "neutral"}
                />
              </article>
            ))}
          </div>
        </div>
      );
    }

    if (activeStep === "news") {
      return (
        <div className="market-agent-setup-panel">
          <h3>News</h3>
          <p>Headlines and calendar events are collected automatically.</p>
          <div className="market-agent-source-options market-agent-managed-sources">
            <article>
              <strong>Headlines</strong>
              <p>Used only when timing and market confirmation support the explanation.</p>
              <MarketAgentStatusBadge label="Automatic" tone="neutral" />
            </article>
            <article>
              <strong>Calendar</strong>
              <p>Scheduled catalysts are matched against XAUUSD moves.</p>
              <MarketAgentStatusBadge label="Automatic" tone="neutral" />
            </article>
            <article>
              <strong>Evidence</strong>
              <p>Accepted sources appear in the Evidence view.</p>
              <MarketAgentStatusBadge label="Auditable" tone="info" />
            </article>
          </div>
        </div>
      );
    }

    if (activeStep === "llm") {
      return (
        <div className="market-agent-setup-panel">
          <h3>Analysis</h3>
          <p>Optional local model. Evidence checks still decide what is allowed.</p>
          {!llmData?.available ? (
            <div className="market-agent-empty-state">{llmData?.message || "LLM configuration is unavailable."}</div>
          ) : (
            <>
              <label className="market-agent-toggle market-agent-full-toggle">
                <input
                  type="checkbox"
                  checked={llmForm.enabled}
                  onChange={(event) => setLLMForm((current) => ({ ...current, enabled: event.target.checked }))}
                />
                <span>Use local model for explanations</span>
              </label>
              <div className="market-agent-readable-card-grid">
                <article>
                  <span>Status</span>
                  <strong>{llmForm.enabled ? llmData.llm?.lastStatus || "Enabled" : "Rule-based"}</strong>
                  <p>{llmForm.enabled ? "Uses Ollama after meaningful triggers." : "No local model calls."}</p>
                </article>
                <article>
                  <span>Model</span>
                  <strong>{llmData.llm?.model || "qwen3:4b"}</strong>
                  <p>Local only. Not a source of truth.</p>
                </article>
              </div>
              <div className="market-agent-provider-config-actions primary">
                <button type="button" className="btn primary btn-compact" onClick={() => void onSaveLLM(llmForm)}>
                  Save analysis setting
                </button>
                <button type="button" className="btn ghost btn-compact" onClick={() => void runLLMAction(onTestLLMConnection)}>
                  Test model
                </button>
                <button type="button" className="btn ghost btn-compact" onClick={() => void runLLMAction(onTestLLMJsonResponse)}>
                  Test JSON
                </button>
              </div>
              <details className="market-agent-advanced-settings">
                <summary>Model settings</summary>
                <div className="market-agent-provider-config-grid llm">
                  <label>
                    <span>Provider</span>
                    <select
                      value={llmForm.provider}
                      onChange={(event) => setLLMForm((current) => ({ ...current, provider: event.target.value }))}
                    >
                      <option value="ollama">Ollama</option>
                    </select>
                  </label>
                  <label>
                    <span>Endpoint</span>
                    <input
                      value={llmForm.endpoint}
                      onChange={(event) => setLLMForm((current) => ({ ...current, endpoint: event.target.value }))}
                    />
                  </label>
                  <label>
                    <span>Model</span>
                    <input
                      value={llmForm.model}
                      onChange={(event) => setLLMForm((current) => ({ ...current, model: event.target.value }))}
                    />
                  </label>
                </div>
              </details>
              {llmResult ? (
                <div className="market-agent-provider-config-result">
                  <div className="market-agent-provider-config-result-head">
                    <strong>Model check</strong>
                    <MarketAgentStatusBadge label={llmResult.status || (llmResult.ok ? "available" : "failed")} />
                  </div>
                  <div className="market-agent-provider-config-result-body">
                    <span>{llmResult.message || llmResult.error || "Completed."}</span>
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
          <h3>Alerts</h3>
          <p>Telegram is optional. It only sends meaningful changes.</p>
          {!telegramData?.available ? (
            <div className="market-agent-empty-state">
              {telegramData?.message || "Telegram configuration is unavailable."}
            </div>
          ) : (
            <>
              <div className="market-agent-provider-config-statuses">
                <MarketAgentStatusBadge
                  label={telegramData.telegram?.enabled ? "Telegram enabled" : "Telegram disabled"}
                  tone={telegramData.telegram?.enabled ? "good" : "warn"}
                />
                <MarketAgentStatusBadge
                  label={telegramData.telegram?.lastSendStatus || "Not tested"}
                  tone={telegramData.telegram?.lastError ? "bad" : "neutral"}
                />
              </div>
              <div className="market-agent-readable-card-grid telegram-intro">
                <article>
                  <span>Current state</span>
                  <strong>{telegramData.telegram?.enabled ? "Alerts enabled" : "Alerts off"}</strong>
                  <p>Repeated states are suppressed.</p>
                </article>
                <article>
                  <span>Sends when</span>
                  <strong>Situation changes</strong>
                  <p>Driver changes, invalidation, large unexplained moves, recovery.</p>
                </article>
              </div>
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
              <label className="market-agent-toggle market-agent-full-toggle">
                <input
                  type="checkbox"
                  checked={telegramForm.enabled}
                  onChange={(event) =>
                    setTelegramForm((current) => ({ ...current, enabled: event.target.checked }))
                  }
                />
                <span>Enable Telegram alerts</span>
              </label>
              <div className="market-agent-provider-config-toggles">
                {["level_2", "level_3"].map((level) => (
                  <label className="market-agent-toggle" key={level}>
                    <input
                      type="checkbox"
                      checked={telegramForm.levels.includes(level)}
                      onChange={(event) => toggleTelegramLevel(level, event.target.checked)}
                    />
                    <span>{level === "level_3" ? "Breaking driver alerts" : "Situation change alerts"}</span>
                  </label>
                ))}
              </div>
              <div className="market-agent-provider-config-actions">
                <button type="button" className="btn ghost btn-compact" onClick={() => void onSaveTelegram(telegramForm)}>
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
      <div className="market-agent-setup-panel">
          <h3>Start monitoring</h3>
          <p>
            {monitorStatus?.running
              ? "Monitoring is running."
              : "Monitoring is stopped."}
        </p>
        {!data?.ctrader?.enabled ? (
          <p className="market-agent-warning-line">Configure a price source before live monitoring.</p>
        ) : null}
        <p className="market-agent-monitor-note">
          Recovery fills missed data after the app was closed.
        </p>
        <div className="market-agent-readable-card-grid monitoring">
          <article>
            <span>Status</span>
            <strong>{monitorStatus?.running ? "Running" : "Stopped"}</strong>
            <p>{monitorStatus?.running ? "Watching XAUUSD." : "Live alerts are paused."}</p>
          </article>
          <article>
            <span>Last check</span>
            <strong>{String(monitorStatus?.lastRunAt ?? "Not run yet")}</strong>
            <p>{monitorStatus?.lastError ? `Last error: ${monitorStatus.lastError}` : "No recent monitor error."}</p>
          </article>
          <article>
            <span>Telegram</span>
            <strong>{telegramData?.telegram?.lastSendStatus || "Not tested"}</strong>
            <p>Uses alert policy and cooldown.</p>
          </article>
        </div>
        <div className="market-agent-provider-config-actions">
          <button type="button" className="btn ghost btn-compact" onClick={() => void onRunMonitorOnce()}>
            Check Now
          </button>
          <button type="button" className="btn ghost btn-compact" onClick={() => void onStartMonitorLoop()}>
            Start Monitoring
          </button>
          <button type="button" className="btn ghost btn-compact" onClick={() => void onStopMonitorLoop()}>
            Stop Monitoring
          </button>
          <button type="button" className="btn ghost btn-compact" onClick={() => void onRunBackfillRecovery()}>
            Recover Missed Data
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
          <MarketAgentStatusBadge label="Backup price ready" tone="warn" />
        </div>
      </div>

      {!data?.available ? (
        <div className="market-agent-empty-state">{data?.message || "Provider configuration is unavailable."}</div>
      ) : (
        <div className="market-agent-setup-flow">
          <section className="market-agent-setup-status-card">
            <div>
              <h3>{setupComplete ? "Market Agent setup is ready." : "Market Agent setup is incomplete."}</h3>
              <p>Connect cTrader for live XAUUSD. Everything else runs automatically.</p>
            </div>
            <div className="market-agent-setup-checklist">
              {checklist.map((item) => (
                <div key={item.label}>
                  <span>{item.label}</span>
                  <MarketAgentStatusBadge label={item.value} tone={item.tone} />
                </div>
              ))}
            </div>
          </section>
          <div className="market-agent-setup-body">
            <nav className="market-agent-setup-stepper" aria-label="Data source setup steps">
              {steps.map((step) => (
                <button
                  type="button"
                  key={step.id}
                  aria-pressed={activeStep === step.id}
                  className={activeStep === step.id ? "active" : ""}
                  onClick={() => selectStep(step.id)}
                >
                  <strong>{step.label}</strong>
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
