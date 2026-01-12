import "./DiagnosticsPanel.css";

type DiagnosticsPanelProps = {
  visible: boolean;
  initState: "loading" | "ready" | "error";
  eventsCount: number;
  lastError: string;
};

export function DiagnosticsPanel({
  visible,
  initState,
  eventsCount,
  lastError
}: DiagnosticsPanelProps) {
  if (!visible) return null;

  return (
    <div className="diagnostics">
      <div>View: main</div>
      <div>Mounted: true</div>
      <div>Init: {initState}</div>
      <div>Data loaded: {eventsCount > 0 ? "yes" : "no"}</div>
      <div>Last error: {lastError || "none"}</div>
    </div>
  );
}
