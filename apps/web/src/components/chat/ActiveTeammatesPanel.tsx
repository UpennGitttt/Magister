import { useEffect, useState } from "react";
import { getActiveTeammates, type ActiveTeammate } from "../../lib/api";

type Props = {
  taskId: string | null;
  taskState: string | null;
};

export function ActiveTeammatesPanel({ taskId, taskState }: Props) {
  const [teammates, setTeammates] = useState<ActiveTeammate[]>([]);
  const [expanded, setExpanded] = useState(true);
  const [dismissed, setDismissed] = useState(false);

  const shouldShow = taskState === "AWAITING_TEAMMATES" || teammates.length > 0;

  useEffect(() => {
    if (!taskId || !shouldShow) {
      setTeammates([]);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const result = await getActiveTeammates(taskId);
        if (!cancelled) setTeammates(result.active);
      } catch {
        // best-effort; leave previous state
      }
    };
    void tick();
    // Poll every 5s while task is in awaiting state OR teammates are still showing
    const id = setInterval(tick, 5_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [taskId, shouldShow]);

  // Reset dismissed state when task or state changes
  useEffect(() => {
    setDismissed(false);
  }, [taskId, taskState]);

  if (!shouldShow || dismissed || teammates.length === 0) return null;

  const fmtElapsed = (sec: number) => {
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m${sec % 60}s`;
    return `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m`;
  };

  return (
    <div
      style={{
        background: "var(--surface-soft, rgba(0,0,0,0.04))",
        border: "1px solid var(--border, rgba(0,0,0,0.12))",
        borderRadius: "0.4rem",
        padding: "0.3rem 0.6rem",
        margin: "0 0.75rem 0.3rem",
        fontSize: "0.85em",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <span style={{ animation: "goal-pulse 2s ease-in-out infinite" }}>🤖</span>
        <span style={{ fontWeight: 600 }}>
          {teammates.length} teammate{teammates.length === 1 ? "" : "s"} running
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="config-edit-btn"
          onClick={() => setExpanded((e) => !e)}
          style={{ padding: "0.1rem 0.4rem", fontSize: "0.85em" }}
        >
          {expanded ? "▴" : "▾"}
        </button>
      </div>
      {expanded && (
        <div style={{ marginTop: 4, lineHeight: 1.5 }}>
          {teammates.map((t) => (
            <div key={t.runId} style={{ display: "flex", gap: "0.6rem", opacity: 0.8 }}>
              <span style={{ fontWeight: 600, minWidth: 80 }}>{t.role}</span>
              <span>{fmtElapsed(t.elapsedSec)}</span>
              <span style={{ opacity: 0.6, fontSize: "0.85em" }}>({t.runId.slice(-8)})</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
