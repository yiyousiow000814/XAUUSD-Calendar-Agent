import "./TemporaryPathWarningModal.css";

export type TemporaryPathWarningMode = "settings-close" | "startup";

type TemporaryPathWarningModalProps = {
  isOpen: boolean;
  isClosing: boolean;
  isEntering: boolean;
  mode: TemporaryPathWarningMode;
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

export function TemporaryPathWarningModal({
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
}: TemporaryPathWarningModalProps) {
  if (!isOpen) return null;
  const showFooterCancel = canReset || canUseAsIs;

  return (
    <div
      className={`modal-backdrop${isClosing ? " closing" : isEntering ? "" : " open"}`}
      data-qa="qa:modal-backdrop:temporary-path-warning"
    >
      <div
        className={`modal modal-confirm modal-temporary-path-warning${isClosing ? " closing" : isEntering ? "" : " open"}`}
        data-qa="qa:modal:temporary-path-warning"
        role="dialog"
        aria-modal="true"
        aria-label="Temporary path warning"
      >
        <div className="modal-header" data-qa="qa:modal-header:temporary-path-warning">
          <div className="temporary-path-warning-title">
            <h3>{title}</h3>
            <div className="temporary-path-warning-subtitle">
              {mode === "startup" ? "Startup check" : "Before closing Settings"}
            </div>
          </div>
          <button
            className="btn ghost"
            onClick={onCancel}
            data-qa="qa:temporary-path-warning:cancel-x"
          >
            Close
          </button>
        </div>
        <div className="modal-body" data-qa="qa:modal-body:temporary-path-warning">
          <p className="modal-note">{message}</p>
          <div
            className="temporary-path-warning-path"
            data-qa="qa:temporary-path-warning:path"
          >
            <div className="path-label">Target folder</div>
            <div className="path-value mono" title={path}>
              {path || "--"}
            </div>
          </div>
          {details ? (
            <div
              className="temporary-path-warning-details"
              data-qa="qa:temporary-path-warning:details"
            >
              <div className="path-label">Details</div>
              <pre className="path-value mono details-pre">{details}</pre>
            </div>
          ) : null}
          <p className="temporary-path-warning-footer-note">
            Reset only affects the Temporary Path folder and never touches Main Path.
          </p>
        </div>
        <div className="modal-footer" data-qa="qa:modal-footer:temporary-path-warning">
          {showFooterCancel ? (
            <button
              className="btn ghost"
              onClick={onCancel}
              data-qa="qa:temporary-path-warning:cancel"
            >
              Cancel
            </button>
          ) : null}
          {canReset ? (
            <button
              className="btn danger"
              onClick={onReset}
              data-qa="qa:temporary-path-warning:reset"
            >
              {resetLabel}
            </button>
          ) : null}
          {canUseAsIs ? (
            <button
              className="btn primary"
              onClick={onUseAsIs}
              data-qa="qa:temporary-path-warning:use-as-is"
            >
              Use As-Is
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
