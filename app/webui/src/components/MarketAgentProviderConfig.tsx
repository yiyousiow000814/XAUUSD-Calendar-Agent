import { useEffect, useMemo, useState } from "react";

import type {
  MarketAgentProviderActionResponse,
  MarketAgentProviderConfigInput,
  MarketAgentProviderConfigResponse,
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
  onSave: (ctrader: MarketAgentProviderConfigInput) => void;
  onClear: () => void;
  onTestConnection: (ctrader: MarketAgentProviderConfigInput) => Promise<MarketAgentProviderActionResponse>;
  onResolveSymbol: (ctrader: MarketAgentProviderConfigInput) => Promise<MarketAgentProviderActionResponse>;
  onQuoteTest: (ctrader: MarketAgentProviderConfigInput) => Promise<MarketAgentProviderActionResponse>;
  onRefreshToken: (ctrader: MarketAgentProviderConfigInput) => Promise<MarketAgentProviderActionResponse>;
  onSaveTelegram: (telegram: MarketAgentTelegramConfigInput) => Promise<MarketAgentTelegramConfigResponse>;
  onTestTelegram: (telegram: MarketAgentTelegramConfigInput) => Promise<MarketAgentTelegramActionResponse>;
  monitorStatus: MarketAgentMonitorStatusResponse | null;
  onRunMonitorOnce: () => Promise<MarketAgentMonitorStatusResponse>;
  onStartMonitorLoop: () => Promise<MarketAgentMonitorStatusResponse>;
  onStopMonitorLoop: () => Promise<MarketAgentMonitorStatusResponse>;
};

type SetupStep = "price" | "ctrader" | "fallbacks" | "news" | "telegram" | "monitoring";

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

export function MarketAgentProviderConfig({
  data,
  telegramData,
  onSave,
  onClear,
  onTestConnection,
  onResolveSymbol,
  onQuoteTest,
  onRefreshToken,
  onSaveTelegram,
  onTestTelegram,
  monitorStatus,
  onRunMonitorOnce,
  onStartMonitorLoop,
  onStopMonitorLoop
}: MarketAgentProviderConfigProps) {
  const [form, setForm] = useState<MarketAgentProviderConfigInput>(emptyForm);
  const [telegramForm, setTelegramForm] = useState<MarketAgentTelegramConfigInput>(emptyTelegramForm);
  const [actionResult, setActionResult] = useState<MarketAgentProviderActionResponse | null>(null);
  const [telegramResult, setTelegramResult] = useState<MarketAgentTelegramActionResponse | null>(null);
  const [actionLabel, setActionLabel] = useState("");
  const [activeStep, setActiveStep] = useState<SetupStep>("price");
  const [advancedOpen, setAdvancedOpen] = useState(false);

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

  const statusTone = useMemo(() => {
    if (!data?.available) return "bad";
    if (data.ctrader?.enabled) return "good";
    return "warn";
  }, [data]);

  const setupComplete = Boolean(
    data?.ctrader?.enabled || telegramData?.telegram?.enabled || monitorStatus?.running
  );

  const checklist = [
    {
      label: "Price source",
      value: data?.ctrader?.enabled ? "cTrader spot" : "Not configured",
      tone: data?.ctrader?.enabled ? "good" : "warn"
    },
    { label: "Related assets", value: "Available through providers", tone: "neutral" },
    { label: "News", value: "Configure RSS feeds", tone: "warn" },
    { label: "Calendar", value: "ForexFactory fallback", tone: "neutral" },
    {
      label: "Telegram",
      value: telegramData?.telegram?.enabled ? "Enabled" : "Disabled",
      tone: telegramData?.telegram?.enabled ? "good" : "warn"
    },
    {
      label: "Monitor loop",
      value: monitorStatus?.running ? "Running" : "Stopped",
      tone: monitorStatus?.running ? "good" : "warn"
    }
  ] as const;

  const steps: Array<{ id: SetupStep; label: string; summary: string }> = [
    { id: "price", label: "Price Source", summary: "Pick spot, proxy, or debug import." },
    { id: "ctrader", label: "cTrader", summary: "Add Open API tokens and test spot." },
    { id: "fallbacks", label: "Fallbacks", summary: "Keep proxy and related assets honest." },
    { id: "news", label: "News & Calendar", summary: "Connect headlines and event windows." },
    { id: "telegram", label: "Telegram", summary: "Send only meaningful alerts." },
    { id: "monitoring", label: "Monitoring", summary: "Run, loop, and recover on Windows." }
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

  const renderCTraderResult = () => (
    <div className="market-agent-provider-config-result" data-qa="qa:market-agent:provider-config-result">
      <div className="market-agent-provider-config-result-head">
        <strong>{actionLabel || "Test result"}</strong>
        <MarketAgentStatusBadge label={actionResult?.ok ? "success" : actionResult ? "failed" : "pending"} />
      </div>
      <div className="market-agent-provider-config-result-body">
        {actionResult ? (
          <>
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
          </>
        ) : (
          <>
            <span>Run a test to verify app auth, account auth, symbol resolution, quote receipt, and snapshot save.</span>
            <ul>
              <li>App auth: pending</li>
              <li>Account auth: pending</li>
              <li>Symbol resolved: pending</li>
              <li>Latest quote received: pending</li>
              <li>Snapshot saved: pending</li>
              <li>Provider selected: pending</li>
            </ul>
          </>
        )}
      </div>
    </div>
  );

  const renderStep = () => {
    if (activeStep === "price") {
      return (
        <div className="market-agent-setup-panel">
          <h3>Choose price source</h3>
          <p>
            Start with the XAUUSD price feed. The evidence gate can only evaluate market moves when price data is
            available and fresh.
          </p>
          <div className="market-agent-source-options">
            <article className="recommended">
              <span>Recommended</span>
              <strong>cTrader Spot</strong>
              <p>cTrader gives true spot XAUUSD when Open API tokens and account access are configured.</p>
              <button type="button" className="btn ghost btn-compact" onClick={() => setActiveStep("ctrader")}>
                Set up cTrader
              </button>
            </article>
            <article>
              <span>Fallback</span>
              <strong>Yahoo GC=F</strong>
              <p>Yahoo GC=F is useful when cTrader is unavailable, but it is a futures proxy, not true spot XAUUSD.</p>
              <MarketAgentStatusBadge label="Futures proxy" tone="warn" />
            </article>
            <article>
              <span>Debug / import only</span>
              <strong>Local CSV</strong>
              <p>Local CSV is not ideal for live monitoring. Use it for fixture imports and debugging only.</p>
            </article>
          </div>
        </div>
      );
    }

    if (activeStep === "ctrader") {
      return (
        <div className="market-agent-setup-panel">
          <h3>Set up cTrader Open API</h3>
          <p className="market-agent-security-note">
            We never ask for or store your cTrader password. Use cTrader Open API tokens only.
          </p>
          <div className="market-agent-provider-config-grid primary">
            <label>
              <span>Environment</span>
              <select
                value={form.environment}
                onChange={(event) => setForm((current) => ({ ...current, environment: event.target.value }))}
              >
                <option value="demo">demo</option>
                <option value="live">live</option>
              </select>
            </label>
            <label>
              <span>Symbol</span>
              <input
                value={form.symbol}
                onChange={(event) => setForm((current) => ({ ...current, symbol: event.target.value }))}
              />
            </label>
            <label>
              <span>Account ID</span>
              <input
                value={form.accountId}
                onChange={(event) => setForm((current) => ({ ...current, accountId: event.target.value }))}
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
              <span>Enable cTrader spot as preferred XAUUSD source</span>
            </label>
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
              Advanced settings
            </summary>
            {advancedOpen ? (
              <>
                <div className="market-agent-provider-config-grid">
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
          <div className="market-agent-provider-config-actions">
            <button type="button" className="btn ghost btn-compact" onClick={() => void runAction("Test Connection", onTestConnection)}>
              Test Connection
            </button>
            <button type="button" className="btn ghost btn-compact" onClick={() => void runAction("Resolve Symbol", onResolveSymbol)}>
              Resolve Symbol
            </button>
            <button type="button" className="btn ghost btn-compact" onClick={() => void runAction("Start Live Quote Test", onQuoteTest)}>
              Start Live Quote Test
            </button>
            <button type="button" className="btn ghost btn-compact" onClick={() => void runAction("Refresh Token", onRefreshToken)}>
              Refresh Token
            </button>
            <button type="button" className="btn ghost btn-compact" onClick={() => onSave(form)}>
              Save Config
            </button>
            <button type="button" className="btn ghost btn-compact" onClick={onClear}>
              Clear Config
            </button>
          </div>
          {renderCTraderResult()}
        </div>
      );
    }

    if (activeStep === "fallbacks") {
      return (
        <div className="market-agent-setup-panel">
          <h3>Configure fallback sources</h3>
          <p>
            Fallbacks keep the agent useful when cTrader is unavailable or stale. They never change the source labels:
            GC=F remains a futures proxy.
          </p>
          <div className="market-agent-source-options compact">
            {["Yahoo GC=F", "DXY", "US10Y", "US2Y", "Oil", "VIX / Equities"].map((name) => (
              <article key={name}>
                <strong>{name}</strong>
                <p>
                  {name === "US2Y"
                    ? "US2Y is unavailable unless a reliable source is configured."
                    : name === "Yahoo GC=F"
                      ? "Fallback futures proxy for XAUUSD price, not true spot."
                      : "Used as confirmation evidence when fresh and available."}
                </p>
              </article>
            ))}
          </div>
        </div>
      );
    }

    if (activeStep === "news") {
      return (
        <div className="market-agent-setup-panel">
          <h3>Configure news and calendar</h3>
          <p>
            News and calendar data explain moves only when timestamps, relevance, and cross-asset confirmation pass the
            evidence gate. Delayed or noisy headlines stay low confidence.
          </p>
          <div className="market-agent-source-options">
            <article>
              <strong>RSS News</strong>
              <p>Connect RSS feeds for Fed, macro, geopolitical, and XAUUSD-relevant headlines.</p>
              <MarketAgentStatusBadge label="Configure feeds" tone="warn" />
            </article>
            <article>
              <strong>ForexFactory Calendar</strong>
              <p>Use economic event windows to separate scheduled catalysts from unsupported narratives.</p>
              <MarketAgentStatusBadge label="Calendar windows" tone="neutral" />
            </article>
          </div>
        </div>
      );
    }

    if (activeStep === "telegram") {
      return (
        <div className="market-agent-setup-panel">
          <h3>Configure Telegram alerts</h3>
          <p>
            Telegram sends only meaningful alerts: Level 2 situation changes, Level 3 breaking drivers, large
            unconfirmed moves, and useful recovery summaries. No meaningful change is suppressed.
          </p>
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
              <div className="market-agent-provider-config-grid telegram">
                <label className="market-agent-toggle">
                  <input
                    type="checkbox"
                    checked={telegramForm.enabled}
                    onChange={(event) =>
                      setTelegramForm((current) => ({ ...current, enabled: event.target.checked }))
                    }
                  />
                  <span>Enable Telegram alerts</span>
                </label>
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
                <label>
                  <span>Timeout seconds</span>
                  <input
                    value={telegramForm.timeoutSeconds}
                    onChange={(event) =>
                      setTelegramForm((current) => ({
                        ...current,
                        timeoutSeconds: Number(event.target.value) || 10
                      }))
                    }
                  />
                </label>
              </div>
              <div className="market-agent-provider-config-toggles">
                {["level_2", "level_3"].map((level) => (
                  <label className="market-agent-toggle" key={level}>
                    <input
                      type="checkbox"
                      checked={telegramForm.levels.includes(level)}
                      onChange={(event) => toggleTelegramLevel(level, event.target.checked)}
                    />
                    <span>{level === "level_3" ? "Level 3 breaking driver" : "Level 2 situation change"}</span>
                  </label>
                ))}
              </div>
              <div className="market-agent-provider-config-actions">
                <button type="button" className="btn ghost btn-compact" onClick={() => void onSaveTelegram(telegramForm)}>
                  Save Telegram
                </button>
                <button type="button" className="btn ghost btn-compact" onClick={() => void runTelegramAction()}>
                  Send Test Message
                </button>
              </div>
              <div className="market-agent-provider-config-meta">
                <span>Config path: {telegramData.telegram?.configPath || "--"}</span>
                <span>Last send: {telegramData.telegram?.lastSendStatus || "Not tested"}</span>
                <span>Last error: {telegramData.telegram?.lastError || "None"}</span>
              </div>
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
            ? "Monitoring is running. The app will continue checking for meaningful market changes."
            : "Monitoring is not running. Start the loop to receive live alerts."}
        </p>
        {!data?.ctrader?.enabled ? (
          <p className="market-agent-warning-line">Configure a price source before live monitoring.</p>
        ) : null}
        <p className="market-agent-monitor-note">
          Backfill & Recover runs one monitor pass and reconstructs missed data when the monitor detects an offline gap.
        </p>
        <div className="market-agent-monitor-control-grid guided">
          <span>Status</span>
          <strong>{monitorStatus?.running ? "Running" : "Stopped"}</strong>
          <span>Last run</span>
          <strong>{String(monitorStatus?.lastRunAt ?? "--")}</strong>
          <span>Next run</span>
          <strong>{String(monitorStatus?.nextRunAt ?? "--")}</strong>
          <span>Last error</span>
          <strong>{monitorStatus?.lastError || "None"}</strong>
          <span>Last Telegram send</span>
          <strong>{telegramData?.telegram?.lastSendStatus || "Not tested"}</strong>
        </div>
        <div className="market-agent-provider-config-actions">
          <button type="button" className="btn ghost btn-compact" onClick={() => void onRunMonitorOnce()}>
            Run Monitor Once
          </button>
          <button type="button" className="btn ghost btn-compact" onClick={() => void onStartMonitorLoop()}>
            Start Monitor Loop
          </button>
          <button type="button" className="btn ghost btn-compact" onClick={() => void onStopMonitorLoop()}>
            Stop Monitor Loop
          </button>
          <button type="button" className="btn ghost btn-compact" onClick={() => void onRunMonitorOnce()}>
            Backfill & Recover
          </button>
        </div>
        <details className="market-agent-advanced-settings">
          <summary>Technical details</summary>
          <div className="market-agent-provider-config-meta">
            <span>PID: {String(monitorStatus?.pid ?? "--")}</span>
            <span>Interval: {String(monitorStatus?.intervalSeconds ?? 60)} sec</span>
            <span>Last provider health: see Provider Health section</span>
          </div>
        </details>
      </div>
    );
  };

  return (
    <section className="market-agent-surface" data-qa="qa:market-agent:provider-config">
      <div className="market-agent-surface-header">
        <div>
          <h2>Data Sources</h2>
          <span className="hint">Configure cTrader spot, inspect fallback paths, and test the active provider chain</span>
        </div>
        <div className="market-agent-provider-config-statuses">
          <MarketAgentStatusBadge
            label={data?.ctrader?.enabled ? "cTrader enabled" : "cTrader disabled"}
            tone={statusTone}
          />
          <MarketAgentStatusBadge label="Yahoo proxy fallback" tone="warn" />
        </div>
      </div>

      {!data?.available ? (
        <div className="market-agent-empty-state">{data?.message || "Provider configuration is unavailable."}</div>
      ) : (
        <div className="market-agent-setup-flow">
          <section className="market-agent-setup-status-card">
            <div>
              <h3>{setupComplete ? "Market Agent setup is ready." : "Market Agent setup is incomplete."}</h3>
              <p>
                Follow the steps below to connect price, fallback, news, Telegram, and monitoring without touching
                backend internals.
              </p>
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
              {steps.map((step, index) => (
                <button
                  type="button"
                  key={step.id}
                  aria-pressed={activeStep === step.id}
                  className={activeStep === step.id ? "active" : ""}
                  onClick={() => setActiveStep(step.id)}
                >
                  <span>{index + 1}</span>
                  <strong>{step.label}</strong>
                  <small>{step.summary}</small>
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
