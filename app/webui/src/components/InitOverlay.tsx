import "./InitOverlay.css";

type InitOverlayProps = {
  state: "loading" | "ready" | "error";
  error: string;
  onRetry: () => void;
};

export function InitOverlay({ state, error, onRetry }: InitOverlayProps) {
  if (state === "ready") return null;

  return (
    <div className={`status-overlay ${state}`} data-qa="qa:overlay:init">
      <div className="status-card" data-qa="qa:card:init">
        <div className="status-title">
          {state === "loading" ? "Initializing interface" : "Initialization failed"}
        </div>
        {state === "error" ? (
          <>
            <div className="status-message">{error || "Unknown error"}</div>
            <button className="btn primary" onClick={onRetry}>
              Retry
            </button>
          </>
        ) : (
          <div className="status-skeleton">
            <span />
            <span />
            <span />
          </div>
        )}
      </div>
    </div>
  );
}
