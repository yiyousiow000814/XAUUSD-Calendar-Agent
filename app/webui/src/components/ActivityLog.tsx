import { useEffect, useRef, useState, type ReactNode } from "react";
import type { FilterOption, LogEntry } from "../types";
import { Select } from "./Select";
import "./ActivityLog.css";

type ActivityLogProps = {
  filter: FilterOption;
  logs: LogEntry[];
  latestLogId: string;
  onFilterChange: (value: FilterOption) => void;
  onClear: () => void;
  levelTone: (level: string) => string;
  className?: string;
  maxRows?: number;
  showHeader?: boolean;
  headerActions?: ReactNode;
  showFilter?: boolean;
  title?: string;
  subtitle?: string;
};

export function ActivityLog({
  filter,
  logs,
  latestLogId,
  onFilterChange,
  onClear,
  levelTone,
  className,
  maxRows,
  showHeader = true,
  headerActions,
  showFilter = true,
  title = "Activity",
  subtitle = "Latest actions first"
}: ActivityLogProps) {
  const visibleLogs = maxRows ? logs.slice(0, maxRows) : logs;
  const isDrawer = className?.split(" ").includes("drawer") ?? false;
  const [flashLogId, setFlashLogId] = useState<string>("");
  const seenLatestIdRef = useRef<string>("");
  const flashTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!latestLogId) return;
    const previous = seenLatestIdRef.current;
    seenLatestIdRef.current = latestLogId;
    if (!previous) return;
    if (previous === latestLogId) return;

    setFlashLogId(latestLogId);
    if (flashTimerRef.current) {
      window.clearTimeout(flashTimerRef.current);
    }
    flashTimerRef.current = window.setTimeout(() => {
      setFlashLogId("");
      flashTimerRef.current = null;
    }, 1200);
  }, [latestLogId]);

  useEffect(
    () => () => {
      if (flashTimerRef.current) {
        window.clearTimeout(flashTimerRef.current);
        flashTimerRef.current = null;
      }
    },
    []
  );

  return (
    <section
      className={`${isDrawer ? "" : "card "}log-card${className ? ` ${className}` : ""}`}
      data-qa="qa:card:activity-log"
    >
      {showHeader ? (
        <div className="card-header">
          <div>
            <h2>{title}</h2>
            <span className="hint">{subtitle}</span>
          </div>
          <div className="controls">
            {showFilter ? (
              <Select
                value={filter}
                options={[
                  { value: "ALL", label: "All" },
                  { value: "INFO", label: "Info" },
                  { value: "WARN", label: "Warn" },
                  { value: "ERROR", label: "Error" }
                ]}
                onChange={(value) => onFilterChange(value as FilterOption)}
                qa="qa:select:log-filter"
              />
            ) : null}
            <button className="btn ghost" onClick={onClear}>
              Clear
            </button>
            {headerActions}
          </div>
        </div>
      ) : null}
      <div className="log-body">
        <div className="table log-table">
          {visibleLogs.length === 0 ? (
            <div className="table-row empty">
              <span>--</span>
              <span>--</span>
              <span>No entries yet</span>
            </div>
          ) : (
            visibleLogs.map((log: LogEntry, index) => {
              const id = `${log.time}-${log.level}-${log.message}`;
              const isNew = index === 0 && id === flashLogId;
              const timeLabel = isDrawer ? log.time.split(" ")[1] || log.time : log.time;
              return (
                <div
                  className={`table-row${isNew ? " log-new" : ""}`}
                  key={id}
                >
                  <span className={`pill ${levelTone(log.level)}`}>{log.level}</span>
                  <span className="mono log-time">{timeLabel}</span>
                  <span>{log.message}</span>
                </div>
              );
            })
          )}
        </div>
      </div>
    </section>
  );
}
