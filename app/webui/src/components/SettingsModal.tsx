import type { Settings } from "../types";
import "./SettingsModal.css";

type SettingsModalProps = {
  isOpen: boolean;
  isClosing: boolean;
  isEntering: boolean;
  settings: Settings;
  outputDir: string;
  syncRepoNote?: { tone: "info" | "warn" | "error"; text: string } | null;
  onResolveSyncRepo?: () => void;
  savingMessage: string;
  pathsRef: React.RefObject<HTMLDivElement>;
  updatePhase: string;
  updateMessage: string;
  updateProgress: number;
  updateLastCheckedAt: string;
  appVersion: string;
  onClose: () => void;
  onSave: () => void;
  onCancel: () => void;
  onThemeChange: (value: Settings["theme"]) => void;
  onSystemThemeToggle: (value: boolean) => void;
  onAutoSyncAfterPull: (value: boolean) => void;
  onAutoUpdateEnabled: (value: boolean) => void;
  onCheckUpdates: () => void;
  onUpdateNow: () => void;
  onRunOnStartup: (value: boolean) => void;
  onDebugToggle: (value: boolean) => void;
  onCopyLog: () => void;
  onOpenLog: () => void;
  onEnableSyncRepo: (value: boolean) => void;
  onSyncRepoChange: (value: string) => void;
  onSyncRepoBlur: () => void;
  onSyncRepoBrowse: () => void;
  onOpenPath: (path: string) => void;
  onOutputDirChange: (value: string) => void;
  onOutputDirBlur: () => void;
  onBrowseOutput: () => void;
  onOpenUninstall: () => void;
};

export function SettingsModal({
  isOpen,
  isClosing,
  isEntering,
  settings,
  outputDir,
  syncRepoNote,
  onResolveSyncRepo,
  savingMessage,
  pathsRef,
  updatePhase,
  updateMessage,
  updateProgress,
  updateLastCheckedAt,
  appVersion,
  onClose,
  onSave,
  onCancel,
  onThemeChange,
  onSystemThemeToggle,
  onAutoSyncAfterPull,
  onAutoUpdateEnabled,
  onCheckUpdates,
  onUpdateNow,
  onRunOnStartup,
  onDebugToggle,
  onCopyLog,
  onOpenLog,
  onEnableSyncRepo,
  onSyncRepoChange,
  onSyncRepoBlur,
  onSyncRepoBrowse,
  onOpenPath,
  onOutputDirChange,
  onOutputDirBlur,
  onBrowseOutput,
  onOpenUninstall
}: SettingsModalProps) {
  if (!isOpen) return null;

  const updateLabelMode =
    updatePhase === "checking"
      ? "checking"
      : updatePhase === "downloaded"
        ? "install"
        : updatePhase === "available" || updatePhase === "downloading" || updatePhase === "restarting"
          ? "update"
          : "check";
  const updateDisabled = updatePhase === "checking" || updatePhase === "downloading" || updatePhase === "restarting";
  const updateOnClick = updateLabelMode === "update" || updateLabelMode === "install" ? onUpdateNow : onCheckUpdates;
  const showProgress = updatePhase === "downloading";
  const lastCheckedLabel = updateLastCheckedAt || "Not yet";
  const updateNote = (() => {
    if (updatePhase === "error") {
      return { tone: "error", text: updateMessage || "Update failed" };
    }
    if (updatePhase !== "idle" || !updateMessage) return null;
    if (updateMessage === "Up to date") {
      return { tone: "info", text: `v${appVersion || "0.0.0"} is the latest version` };
    }
    const warnSignals = ["not configured", "missing", "failed", "unavailable", "shutting down"];
    const tone = warnSignals.some((token) => updateMessage.toLowerCase().includes(token))
      ? "warn"
      : "info";
    return { tone, text: updateMessage };
  })();

  return (
    <div
      className={`modal-backdrop${isClosing ? " closing" : isEntering ? "" : " open"}`}
      data-qa="qa:modal-backdrop:settings"
    >
      <div
        className={`modal modal-settings${isClosing ? " closing" : isEntering ? "" : " open"}`}
        data-qa="qa:modal:settings"
      >
        <div className="modal-header" data-qa="qa:modal-header:settings">
          <div className="modal-title">
            <h3>Settings</h3>
            <div className="modal-subtitle" data-qa="qa:status:autosave">
              Auto-save enabled{savingMessage ? ` · ${savingMessage}` : ""}
            </div>
          </div>
          <button className="btn ghost" onClick={onClose} data-qa="qa:modal-close:settings">
            Close
          </button>
        </div>
        <div className="modal-body" data-qa="qa:modal-body:settings">
          <div className="section updates-section" data-qa="qa:section:updates">
            <div className="section-title updates-title">
              <span>Updates</span>
              <span className="updates-version">v{appVersion || "0.0.0"}</span>
            </div>
            <div className="updates-actions">
              <button
                type="button"
                className={`btn update-cta${updateLabelMode === "update" || updateLabelMode === "install" ? " attention" : ""}${
                  updatePhase === "checking" ? " checking" : ""
                }${updatePhase === "error" ? " error" : ""}${showProgress ? " downloading" : ""}`}
                onClick={updateOnClick}
                disabled={updateDisabled}
                aria-busy={updatePhase === "checking" || updatePhase === "downloading" ? true : undefined}
                data-qa="qa:action:update"
                data-qa-state={updatePhase}
                data-label={updateLabelMode}
                style={
                  {
                    ["--update-progress" as never]: Math.min(1, Math.max(0, updateProgress))
                  } as React.CSSProperties
                }
                title={updatePhase === "error" ? updateMessage || "Update check failed" : undefined}
              >
                <span className="update-cta-labels" aria-hidden="true">
                  <span className="update-cta-label label-check">Check for updates</span>
                  <span className="update-cta-label label-checking">
                    Checking<span className="update-cta-ellipsis" aria-hidden="true" />
                  </span>
                  <span className="update-cta-label label-update">Update now</span>
                  <span className="update-cta-label label-install">Install now</span>
                </span>
                <span className="sr-only">
                  {updateLabelMode === "checking"
                    ? "Checking"
                    : updateLabelMode === "install"
                      ? "Install now"
                      : updateLabelMode === "update"
                        ? "Update now"
                        : "Check for updates"}
                </span>
                <span className="update-cta-affordance" aria-hidden="true" />
                <span className="update-cta-progress" aria-hidden="true" />
              </button>
              {updateNote ? (
                <div className="update-note" data-qa="qa:meta:update-note" data-tone={updateNote.tone}>
                  {updateNote.text}
                </div>
              ) : null}
            </div>
            <div className="updates-meta" data-qa="qa:meta:update">
              <span className="updates-meta-item">Last checked {lastCheckedLabel}</span>
            </div>
          </div>
          <div className="section">
            <div className="section-title">Theme</div>
            <label className="switch">
              <input
                type="checkbox"
                checked={settings.enableSystemTheme}
                onChange={(event) => onSystemThemeToggle(event.target.checked)}
              />
              <span className="switch-track" aria-hidden="true" />
              <span>Enable system theme</span>
            </label>
            <div
              className="segmented"
              data-qa="qa:control:theme"
              data-value={settings.theme}
              data-count={settings.enableSystemTheme ? "3" : "2"}
            >
              {(settings.enableSystemTheme
                ? (["light", "dark", "system"] as Settings["theme"][])
                : (["light", "dark"] as Settings["theme"][])
              ).map((value) => (
                <button
                  key={value}
                  type="button"
                  className={`segment${settings.theme === value ? " active" : ""}`}
                  onClick={() => onThemeChange(value)}
                >
                  {value[0].toUpperCase() + value.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <div className="section">
            <div className="section-title">Automation</div>
            <label className="switch">
              <input
                type="checkbox"
                checked={settings.autoSyncAfterPull}
                onChange={(event) => onAutoSyncAfterPull(event.target.checked)}
              />
              <span className="switch-track" aria-hidden="true" />
              <span>Auto sync after pull</span>
            </label>
            <label className="switch" data-qa="qa:control:auto-update-enabled">
              <input
                type="checkbox"
                checked={settings.autoUpdateEnabled}
                onChange={(event) => onAutoUpdateEnabled(event.target.checked)}
              />
              <span className="switch-track" aria-hidden="true" />
              <span>Auto update enabled</span>
            </label>
            <label className="switch">
              <input
                type="checkbox"
                checked={settings.runOnStartup}
                onChange={(event) => onRunOnStartup(event.target.checked)}
              />
              <span className="switch-track" aria-hidden="true" />
              <span>Run on startup</span>
            </label>
          </div>
          <div className="section">
            <div className="section-title">Debug logging</div>
            <label className="switch">
              <input
                type="checkbox"
                checked={settings.debug}
                onChange={(event) => onDebugToggle(event.target.checked)}
              />
              <span className="switch-track" aria-hidden="true" />
              <span>Enable debug logging</span>
            </label>
            <div className={`log-path${settings.debug ? " visible" : ""}`}>
              <span>Log path</span>
              <div className="log-path-row">
                <code>{settings.logPath || "--"}</code>
                <button className="btn ghost" onClick={onCopyLog}>
                  Copy
                </button>
                <button className="btn ghost" onClick={onOpenLog}>
                  Open
                </button>
              </div>
            </div>
          </div>
          <div className="section" ref={pathsRef}>
            <div className="section-title">Paths & Repos</div>
            <div className="path-row path-card" data-qa="qa:path:main">
              <div>
                <div className="path-label">Main Path</div>
                <p className="path-helper">Read-only. Safe from automated pulls.</p>
                <div className="path-value" title={settings.repoPath || ""}>
                  {settings.repoPath || "--"}
                </div>
              </div>
            </div>
            <div className="path-row path-card" data-qa="qa:path:sync-repo">
              <div className="path-block" data-qa="qa:section:sync-repo">
              <div className="path-block-header">
                <div>
                  <div className="path-label">Sync Repo (Working Copy)</div>
                  {settings.enableSyncRepo ? (
                    <p className="path-helper">
                      Pull/sync happens here, so Main Path is never overwritten. Changes apply when you close Settings.
                    </p>
                  ) : null}
                </div>
                <label
                  className="switch switch-compact"
                  data-qa="qa:control:enable-sync-repo"
                >
                  <input
                    type="checkbox"
                    checked={settings.enableSyncRepo}
                    onChange={(event) => onEnableSyncRepo(event.target.checked)}
                  />
                  <span className="switch-track" aria-hidden="true" />
                  <span>Dev</span>
                </label>
              </div>
              {settings.enableSyncRepo ? (
                <div className="path-input-row">
                  <input
                    className="path-input"
                    type="text"
                    value={settings.syncRepoPath}
                    placeholder="Select or paste a working copy path"
                    onChange={(event) => onSyncRepoChange(event.target.value)}
                    onBlur={onSyncRepoBlur}
                  />
                  <div className="path-actions inline">
                    <button className="btn ghost" onClick={onSyncRepoBrowse}>
                      Browse
                    </button>
                    <button
                      className="btn ghost"
                      onClick={() => onOpenPath(settings.syncRepoPath)}
                      disabled={!settings.syncRepoPath}
                    >
                      Open
                    </button>
                  </div>
                </div>
              ) : (
                <p className="path-note">
                  Off by default. Turn it on only when you need a separate working copy.
                </p>
                )}
              {syncRepoNote?.text ? (
                <div
                  className="sync-repo-note"
                  data-qa="qa:note:sync-repo"
                  data-tone={syncRepoNote.tone}
                >
                  <div className="sync-repo-note-row">
                    <span>{syncRepoNote.text}</span>
                    {onResolveSyncRepo && syncRepoNote.tone !== "info" ? (
                      <button
                        type="button"
                        className="btn ghost btn-compact"
                        onClick={onResolveSyncRepo}
                        data-qa="qa:action:sync-repo-review"
                      >
                        Review
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : null}
              </div>
            </div>
            <div className="path-row path-card" data-qa="qa:path:output">
              <div>
                <div className="path-label">Calendar output</div>
                <p className="path-helper">Sync targets this folder.</p>
                <div className="path-input-row">
                  <input
                    className="path-input"
                    type="text"
                    value={outputDir}
                    placeholder="Select or paste an output folder"
                    onChange={(event) => onOutputDirChange(event.target.value)}
                    onBlur={onOutputDirBlur}
                  />
                  <div className="path-actions inline">
                    <button className="btn ghost" onClick={onBrowseOutput}>
                      Browse
                    </button>
                    <button
                      className="btn ghost"
                      onClick={() => onOpenPath(outputDir)}
                      disabled={!outputDir}
                    >
                      Open
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div className="section danger">
            <div className="section-title">Danger Zone</div>
            <div className="danger-row">
              <button
                className="btn danger"
                onClick={onOpenUninstall}
                data-qa="qa:action:uninstall qa:modal-trigger:uninstall"
              >
                Uninstall...
              </button>
              <p className="path-note">
                Uninstall removes app data plus any folders you choose below.
              </p>
            </div>
          </div>
        </div>
        <div className="modal-footer" data-qa="qa:modal-footer:settings">
          {!settings.autoSave ? (
            <>
              <button className="btn ghost" onClick={onCancel}>
                Cancel
              </button>
              <button className="btn primary" onClick={onSave}>
                Save
              </button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
