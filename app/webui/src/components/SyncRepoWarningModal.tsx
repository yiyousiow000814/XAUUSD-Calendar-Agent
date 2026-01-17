import "./SyncRepoWarningModal.css";

export type SyncRepoWarningMode = "settings-close" | "startup";

type SyncRepoWarningModalProps = {
  isOpen: boolean;
  isClosing: boolean;
  isEntering: boolean;
  mode: SyncRepoWarningMode;
  title: string;
  message: string;
  path: string;
  details?: string;
  canUseAsIs: boolean;
  canReset: boolean;
  resetLabel?: string;
  onCancel: () => void;
  onUseAsIs: () => void;
  onReset: () => void;
};

export function SyncRepoWarningModal({
  isOpen,
  isClosing,
  isEntering,
  mode,
  title,
  message,
  path,
  details,
  canUseAsIs,
  canReset,
  resetLabel = "Reset & Clone",
  onCancel,
  onUseAsIs,
  onReset
}: SyncRepoWarningModalProps) {
  if (!isOpen) return null;
  const showFooterCancel = canReset || canUseAsIs;

  return (
    <div
      className={`modal-backdrop${isClosing ? " closing" : isEntering ? "" : " open"}`}
      data-qa="qa:modal-backdrop:sync-repo-warning"
    >
      <div
        className={`modal modal-confirm modal-sync-repo-warning${isClosing ? " closing" : isEntering ? "" : " open"}`}
        data-qa="qa:modal:sync-repo-warning"
        role="dialog"
        aria-modal="true"
        aria-label="Temporary path warning"
      >
        <div className="modal-header" data-qa="qa:modal-header:sync-repo-warning">
          <div className="sync-repo-warning-title">
            <h3>{title}</h3>
            <div className="sync-repo-warning-subtitle">
              {mode === "startup" ? "Startup check" : "Before closing Settings"}
            </div>
          </div>
          <button className="btn ghost" onClick={onCancel} data-qa="qa:sync-repo-warning:cancel-x">
            Close
          </button>
        </div>
        <div className="modal-body" data-qa="qa:modal-body:sync-repo-warning">
          <p className="modal-note">{message}</p>
          <div className="sync-repo-warning-path" data-qa="qa:sync-repo-warning:path">
            <div className="path-label">Target folder</div>
            <div className="path-value mono" title={path}>
              {path || "--"}
            </div>
          </div>
          {details ? (
            <div className="sync-repo-warning-details" data-qa="qa:sync-repo-warning:details">
              <div className="path-label">Details</div>
              <pre className="path-value mono details-pre">{details}</pre>
            </div>
          ) : null}
          <p className="sync-repo-warning-footer-note">
            Reset only affects the Temporary Path folder and never touches Main Path.
          </p>
        </div>
        <div className="modal-footer" data-qa="qa:modal-footer:sync-repo-warning">
          {showFooterCancel ? (
            <button className="btn ghost" onClick={onCancel} data-qa="qa:sync-repo-warning:cancel">
              Cancel
            </button>
          ) : null}
          {canReset ? (
            <button className="btn danger" onClick={onReset} data-qa="qa:sync-repo-warning:reset">
              {resetLabel}
            </button>
          ) : null}
          {canUseAsIs ? (
            <button className="btn primary" onClick={onUseAsIs} data-qa="qa:sync-repo-warning:use-as-is">
              Use As-Is
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
