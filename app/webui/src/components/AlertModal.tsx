import "./AlertModal.css";

type AlertModalTone = "info" | "error";

type AlertModalProps = {
  isOpen: boolean;
  isClosing: boolean;
  isEntering: boolean;
  title: string;
  message: string;
  tone: AlertModalTone;
  secondsRemaining: number;
  onClose: () => void;
};

export function AlertModal({
  isOpen,
  isClosing,
  isEntering,
  title,
  message,
  tone,
  secondsRemaining,
  onClose
}: AlertModalProps) {
  if (!isOpen) return null;

  const blocks = (message || "").split(/\n\s*\n/g).filter(Boolean);
  const paragraphs =
    blocks.length > 0
      ? blocks.map((block, index) => {
          const parts = block.split("\n");
          const lines = parts.map((part, lineIndex) => (
            <span key={`${index}-${lineIndex}`} className="alert-line">
              {part}
              {lineIndex < parts.length - 1 ? <br /> : null}
            </span>
          ));
          return (
            <p key={index} className="alert-paragraph">
              {lines}
            </p>
          );
        })
      : null;

  return (
    <div
      className={`modal-backdrop${isClosing ? " closing" : isEntering ? "" : " open"}`}
      data-qa="qa:modal-backdrop:alert"
    >
      <div
        className={`modal modal-alert${isClosing ? " closing" : isEntering ? "" : " open"}`}
        data-qa="qa:modal:alert"
        data-tone={tone}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="alert-header" data-qa="qa:modal-header:alert">
          <h3 className="alert-title">{title}</h3>
        </div>
        <div className="alert-divider" aria-hidden="true" />
        <div className="alert-body" data-qa="qa:modal-body:alert">
          {paragraphs}
        </div>
        <div className="alert-footer" data-qa="qa:modal-footer:alert">
          <button
            type="button"
            className="alert-close-btn"
            onClick={onClose}
            data-qa="qa:alert:close"
            aria-label={`Closing in ${Math.max(0, secondsRemaining)} seconds`}
          >
            <span className="close-label">Closing</span>
            <span className="close-count">{Math.max(0, secondsRemaining)}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
