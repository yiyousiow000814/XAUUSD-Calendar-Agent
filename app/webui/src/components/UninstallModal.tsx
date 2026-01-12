import type { Settings } from "../types";
import "./UninstallModal.css";

type UninstallModalProps = {
  isOpen: boolean;
  isClosing: boolean;
  isEntering: boolean;
  settings: Settings;
  onClose: () => void;
  onRemoveLogs: (value: boolean) => void;
  onRemoveOutput: (value: boolean) => void;
  onRemoveSyncRepos: (value: boolean) => void;
  onConfirmChange: (value: string) => void;
  onConfirm: () => void;
};

export function UninstallModal({
  isOpen,
  isClosing,
  isEntering,
  settings,
  onClose,
  onRemoveLogs,
  onRemoveOutput,
  onRemoveSyncRepos,
  onConfirmChange,
  onConfirm
}: UninstallModalProps) {
  if (!isOpen) return null;

  const isConfirmValid = settings.uninstallConfirm.trim().toUpperCase() === "UNINSTALL";

  return (
    <div
      className={`modal-backdrop${isClosing ? " closing" : isEntering ? "" : " open"}`}
      data-qa="qa:modal-backdrop:uninstall"
    >
      <div
        className={`modal modal-confirm${isClosing ? " closing" : isEntering ? "" : " open"}`}
        data-qa="qa:modal:uninstall"
      >
        <div className="modal-header" data-qa="qa:modal-header:uninstall">
          <h3>Uninstall</h3>
          <button className="btn ghost" onClick={onClose} data-qa="qa:modal-close:uninstall">
            Close
          </button>
        </div>
        <div className="modal-body" data-qa="qa:modal-body:uninstall">
          <p className="modal-note">
            This removes app data and optionally deletes the folders you select below.
          </p>
          <label className="toggle">
            <input
              type="checkbox"
              checked={settings.removeLogs}
              onChange={(event) => onRemoveLogs(event.target.checked)}
            />
            <span className="toggle-label">Remove logs and cache</span>
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={settings.removeOutput}
              onChange={(event) => onRemoveOutput(event.target.checked)}
            />
            <span className="toggle-label">Remove calendar output folder</span>
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={settings.removeSyncRepos}
              onChange={(event) => onRemoveSyncRepos(event.target.checked)}
            />
            <span className="toggle-label">Remove all sync repo folders</span>
          </label>
          <label className="field">
            <span>Type UNINSTALL to confirm</span>
            <input
              type="text"
              value={settings.uninstallConfirm}
              data-qa="qa:uninstall:confirm-input"
              onChange={(event) => onConfirmChange(event.target.value)}
            />
          </label>
        </div>
        <div className="modal-footer" data-qa="qa:modal-footer:uninstall">
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn danger"
            onClick={onConfirm}
            disabled={!isConfirmValid}
            data-qa="qa:uninstall:confirm-button"
          >
            Uninstall
          </button>
        </div>
      </div>
    </div>
  );
}
