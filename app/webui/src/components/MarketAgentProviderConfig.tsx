import { useEffect, useMemo, useState } from "react";

import type {
  MarketAgentProviderActionResponse,
  MarketAgentProviderConfigInput,
  MarketAgentProviderConfigResponse,
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
};

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
  onTestTelegram
}: MarketAgentProviderConfigProps) {
  const [form, setForm] = useState<MarketAgentProviderConfigInput>(emptyForm);
  const [telegramForm, setTelegramForm] = useState<MarketAgentTelegramConfigInput>(emptyTelegramForm);
  const [actionResult, setActionResult] = useState<MarketAgentProviderActionResponse | null>(null);
  const [telegramResult, setTelegramResult] = useState<MarketAgentTelegramActionResponse | null>(null);
  const [actionLabel, setActionLabel] = useState("");

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
        <>
          <div className="market-agent-provider-config-section-heading">
            <h3>cTrader Spot Source</h3>
            <span>Use Open API tokens only. cTrader account passwords are never requested or stored.</span>
          </div>
          <div className="market-agent-provider-config-grid">
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
              <span>Client ID</span>
              <input
                value={form.clientId}
                onChange={(event) => setForm((current) => ({ ...current, clientId: event.target.value }))}
                placeholder={data.ctrader?.clientIdMasked || ""}
              />
            </label>
            <label>
              <span>Client Secret</span>
              <input
                type="password"
                value={form.clientSecret}
                onChange={(event) => setForm((current) => ({ ...current, clientSecret: event.target.value }))}
                placeholder={data.ctrader?.clientSecretMasked || ""}
              />
            </label>
            <label>
              <span>Access Token</span>
              <input
                type="password"
                value={form.accessToken}
                onChange={(event) => setForm((current) => ({ ...current, accessToken: event.target.value }))}
                placeholder={data.ctrader?.accessTokenMasked || ""}
              />
            </label>
            <label>
              <span>Refresh Token</span>
              <input
                type="password"
                value={form.refreshToken}
                onChange={(event) => setForm((current) => ({ ...current, refreshToken: event.target.value }))}
                placeholder={data.ctrader?.refreshTokenMasked || ""}
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

          <div className="market-agent-provider-config-toggles">
            <label className="market-agent-toggle">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(event) => setForm((current) => ({ ...current, enabled: event.target.checked }))}
              />
              <span>Enable cTrader spot as preferred XAUUSD source</span>
            </label>
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
            <button
              type="button"
              className="btn ghost btn-compact"
              onClick={() => void runAction("Refresh Token", onRefreshToken)}
            >
              Refresh Token
            </button>
            <button type="button" className="btn ghost btn-compact" onClick={() => onSave(form)}>
              Save Config
            </button>
            <button type="button" className="btn ghost btn-compact" onClick={onClear}>
              Clear Config
            </button>
          </div>

          <div className="market-agent-provider-config-meta">
            <span>Config path: {data.ctrader?.configPath || "--"}</span>
            <span>Token store: {data.ctrader?.tokenStorePath || "--"}</span>
            <span>Snapshot path: {data.ctrader?.snapshotPath || "--"}</span>
          </div>

          {actionResult ? (
            <div className="market-agent-provider-config-result" data-qa="qa:market-agent:provider-config-result">
              <div className="market-agent-provider-config-result-head">
                <strong>{actionLabel}</strong>
                <MarketAgentStatusBadge label={actionResult.ok ? "available" : "error"} />
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
          ) : null}

          <div className="market-agent-provider-config-section-heading">
            <h3>Telegram Reporting</h3>
            <span>Disabled unless configured. Sends only policy-approved market situation alerts.</span>
          </div>

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
                <button
                  type="button"
                  className="btn ghost btn-compact"
                  onClick={() => void onSaveTelegram(telegramForm)}
                >
                  Save Telegram
                </button>
                <button
                  type="button"
                  className="btn ghost btn-compact"
                  onClick={() => void runTelegramAction()}
                >
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
        </>
      )}
    </section>
  );
}
