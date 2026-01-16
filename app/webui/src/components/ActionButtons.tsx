import { Fragment } from "react";
import { useAutoWidthTransition } from "../utils/useAutoWidthTransition";

type ActionButtonsVariant = "appbar" | "hero";

type ActionButtonsProps = {
  variant: ActionButtonsVariant;
  connecting: boolean;
  pullState: "idle" | "loading" | "success" | "error";
  syncState: "idle" | "loading" | "success" | "error";
  syncDisabled?: boolean;
  onPull: () => void;
  onSync: () => void;
};

const getIdleLabels = (variant: ActionButtonsVariant) => {
  if (variant === "hero") {
    return { pull: "Pull Now", sync: "Sync Now" };
  }
  return { pull: "Pull", sync: "Sync" };
};

const getButtonClasses = (variant: ActionButtonsVariant) => {
  if (variant === "hero") {
    return { pull: "btn primary", sync: "btn" };
  }
  return { pull: "btn primary btn-compact", sync: "btn btn-compact" };
};

export function ActionButtons({
  variant,
  connecting,
  pullState,
  syncState,
  syncDisabled = false,
  onPull,
  onSync
}: ActionButtonsProps) {
  const labels = getIdleLabels(variant);
  const classes = getButtonClasses(variant);

  const pullButtonRef = useAutoWidthTransition<HTMLButtonElement>([pullState]);
  const syncButtonRef = useAutoWidthTransition<HTMLButtonElement>([syncState]);

  const pullDisabled = connecting || pullState === "loading";
  const syncDisabledComputed = connecting || syncState === "loading" || syncDisabled;

  return (
    <Fragment>
      <button
        className={classes.pull}
        onClick={onPull}
        disabled={pullDisabled}
        data-qa="qa:action:pull qa:action:async"
        data-qa-state={pullState}
        ref={pullButtonRef}
      >
        <span className="btn-label">
          {pullState === "loading" ? (
            <>
              <span className="spinner accent" data-qa="qa:spinner:pull" />
              <span className="btn-label-text">Pulling...</span>
            </>
          ) : pullState === "success" ? (
            <span className="btn-label-text">Pulled</span>
          ) : pullState === "error" ? (
            <span className="btn-label-text">Pull failed</span>
          ) : (
            <span className="btn-label-text">{labels.pull}</span>
          )}
        </span>
      </button>
      <button
        className={classes.sync}
        onClick={onSync}
        disabled={syncDisabledComputed}
        data-qa="qa:action:sync qa:action:async"
        data-qa-state={syncState}
        ref={syncButtonRef}
      >
        <span className="btn-label">
          {syncState === "loading" ? (
            <>
              <span className="spinner accent" data-qa="qa:spinner:sync" />
              <span className="btn-label-text">Syncing...</span>
            </>
          ) : syncState === "success" ? (
            <span className="btn-label-text">Synced</span>
          ) : syncState === "error" ? (
            <span className="btn-label-text">Sync failed</span>
          ) : (
            <span className="btn-label-text">{labels.sync}</span>
          )}
        </span>
      </button>
    </Fragment>
  );
}
