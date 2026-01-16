import type { ReactNode } from "react";
import type { Settings, Snapshot } from "../types";
import "./HeroHeader.css";
import { useAutoWidthTransition } from "../utils/useAutoWidthTransition";

type HeroHeaderProps = {
  snapshot: Snapshot;
  outputDir: string;
  connecting: boolean;
  pullState: "idle" | "loading" | "success" | "error";
  syncState: "idle" | "loading" | "success" | "error";
  settings: Settings;
  resolvedTheme: "light" | "dark";
  themeMode: "system" | "light" | "dark";
  onPull: () => void;
  onSync: () => void;
  onOpenSettings: () => void;
  onToggleTheme: () => void;
  onOpenPaths: () => void;
  logPanel: ReactNode;
};

export function HeroHeader({
  snapshot,
  outputDir,
  connecting,
  pullState,
  syncState,
  settings,
  resolvedTheme,
  themeMode,
  onPull,
  onSync,
  onOpenSettings,
  onToggleTheme,
  onOpenPaths,
  logPanel
}: HeroHeaderProps) {
  const pullButtonRef = useAutoWidthTransition<HTMLButtonElement>([pullState], {
    durationMs: 220
  });
  const syncButtonRef = useAutoWidthTransition<HTMLButtonElement>([syncState], {
    durationMs: 220
  });

  return (
    <header className="hero" data-qa="qa:header:main">
      <div className="hero-toolbar" data-qa="qa:toolbar:global">
        <button
          className="icon-btn"
          onClick={onOpenSettings}
          data-qa="qa:action:settings qa:modal-trigger:settings"
          data-icon="gear"
          aria-label="Settings"
          title="Settings"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle
              cx="12"
              cy="12"
              r="3"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.09A1.65 1.65 0 0 0 9 3.09V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.09a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button
          className="icon-btn theme-toggle"
          onClick={onToggleTheme}
          data-qa="qa:action:theme"
          data-icon="sun-moon"
          data-theme-mode={themeMode}
          data-theme-resolved={resolvedTheme}
          aria-label="Toggle theme"
          title="Toggle theme"
        >
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            className="theme-icon theme-icon-light"
          >
            <path
              d="M12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity="0.75"
            />
          </svg>
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            className="theme-icon theme-icon-dark"
          >
            <path
              d="M21 14.5A8.5 8.5 0 1 1 9.5 3a6.6 6.6 0 0 0 11.5 11.5Z"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity="0.9"
            />
          </svg>
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            className="theme-icon theme-icon-system"
          >
            <rect
              x="3"
              y="5"
              width="18"
              height="11"
              rx="2"
              ry="2"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            />
            <path
              d="M8 19.5h8M12 16v4.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
      <div className="hero-grid">
        <div className="hero-title">
          <p className="eyebrow">Market Infrastructure</p>
          <h1>XAUUSD Calendar Agent</h1>
          <p className="subtitle">
            Economic calendar sync, pull automation, and mirror delivery.
          </p>
          <div className="hero-cta" data-qa="qa:toolbar:header">
            <button
              className="btn primary"
              onClick={onPull}
              disabled={connecting || pullState === "loading"}
              data-qa="qa:action:pull qa:action:async"
              data-qa-state={pullState}
              ref={pullButtonRef}
            >
              <span className="btn-label">
                {pullState === "loading" ? (
                  <>
                    <span className="spinner accent" data-qa="qa:spinner:pull" /> Pulling...
                  </>
                ) : pullState === "success" ? (
                  "Pulled"
                ) : pullState === "error" ? (
                  "Pull failed"
                ) : (
                  "Pull Now"
                )}
              </span>
            </button>
            <button
              className="btn"
              onClick={onSync}
              disabled={connecting || syncState === "loading"}
              data-qa="qa:action:sync qa:action:async"
              data-qa-state={syncState}
              ref={syncButtonRef}
            >
              <span className="btn-label">
                {syncState === "loading" ? (
                  <>
                    <span className="spinner accent" data-qa="qa:spinner:sync" /> Syncing...
                  </>
                ) : syncState === "success" ? (
                  "Synced"
                ) : syncState === "error" ? (
                  "Sync failed"
                ) : (
                  "Sync Now"
                )}
              </span>
            </button>
            <button
              className={`pill-link${outputDir ? "" : " attention"}`}
              onClick={onOpenPaths}
              data-qa="qa:action:sync-target"
            >
              {outputDir ? `Sync to: ${outputDir}` : "Sync target: Not set"}
            </button>
          </div>
          <div className="hero-status" data-qa="qa:status:sync">
            <span className="status-pill">
              <span className="meta-label">Last Pull</span>
              <span className="meta-value">{snapshot.lastPull}</span>
            </span>
            <span className="status-pill">
              <span className="meta-label">Last Sync</span>
              <span className="meta-value">{snapshot.lastSync}</span>
            </span>
          </div>
        </div>
        <div className="hero-log">{logPanel}</div>
      </div>
    </header>
  );
}
