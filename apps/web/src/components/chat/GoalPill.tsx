import { useState, useEffect } from "react";

type GoalPillProps = {
  goalObjective: string | null;
  goalStatus: string | null;
  goalStartedAt: number | null;
  goalCompletedAt: number | null;
  goalIterations: number;
  goalTokensUsed: number;
  onClear: () => void;
};

export function GoalPill({
  goalObjective,
  goalStatus,
  goalStartedAt,
  goalCompletedAt,
  goalIterations,
  goalTokensUsed,
  onClear,
}: GoalPillProps) {
  const [expanded, setExpanded] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  const isActive = goalStatus === "active";
  const isTerminal = goalStatus === "complete" || goalStatus === "cancelled";

  useEffect(() => {
    if (!goalStartedAt || isTerminal) return;
    const tick = () => {
      const end = goalCompletedAt ?? Date.now();
      setElapsed(Math.floor((end - goalStartedAt) / 1000));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [goalStartedAt, goalCompletedAt, isTerminal]);

  // Compute frozen elapsed for terminal states
  useEffect(() => {
    if (isTerminal && goalStartedAt) {
      const end = goalCompletedAt ?? Date.now();
      setElapsed(Math.floor((end - goalStartedAt) / 1000));
    }
  }, [isTerminal, goalStartedAt, goalCompletedAt]);

  // Auto-dismiss terminal states after 10s
  useEffect(() => {
    if (!isTerminal) return;
    const timer = setTimeout(() => setDismissed(true), 10_000);
    return () => clearTimeout(timer);
  }, [isTerminal]);

  // Reset dismissed state when goal changes (new goal activation)
  useEffect(() => {
    setDismissed(false);
  }, [goalObjective, goalStatus]);

  if (!goalObjective || !goalStatus || goalStatus === "none" || dismissed) return null;

  const icon = isActive ? "◎" : goalStatus === "paused" ? "⏸" : goalStatus === "complete" ? "✓" : "✗";
  const label = isActive
    ? "Goal active"
    : goalStatus === "paused"
      ? "Goal paused"
      : goalStatus === "complete"
        ? "Goal achieved"
        : "Goal cancelled";
  const elapsedStr = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m${elapsed % 60}s`;
  const tokenStr =
    goalTokensUsed < 1000
      ? `${goalTokensUsed}`
      : goalTokensUsed < 1_000_000
        ? `${(goalTokensUsed / 1000).toFixed(1)}K`
        : `${(goalTokensUsed / 1_000_000).toFixed(2)}M`;

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
        <span
          style={
            isActive ? { animation: "goal-pulse 2s ease-in-out infinite" } : undefined
          }
        >
          {icon}
        </span>
        <span style={{ fontWeight: 600 }}>{label}</span>
        <span style={{ opacity: 0.7 }}>
          · turn {goalIterations} · {elapsedStr}
        </span>
        <span style={{ flex: 1 }} />
        {isActive && (
          <button
            type="button"
            className="config-edit-btn"
            onClick={onClear}
            style={{ padding: "0.1rem 0.4rem", fontSize: "0.85em" }}
          >
            Clear
          </button>
        )}
        {isTerminal && (
          <button
            type="button"
            className="config-edit-btn"
            onClick={() => setDismissed(true)}
            style={{ padding: "0.1rem 0.4rem", fontSize: "0.85em" }}
          >
            ✕
          </button>
        )}
        {!isTerminal && (
          <button
            type="button"
            className="config-edit-btn"
            onClick={() => setExpanded((e) => !e)}
            style={{ padding: "0.1rem 0.4rem", fontSize: "0.85em" }}
          >
            {expanded ? "▴" : "▾"}
          </button>
        )}
      </div>
      {expanded && !isTerminal && (
        <div
          style={{
            marginTop: "0.3rem",
            paddingTop: "0.3rem",
            borderTop: "1px solid var(--border, rgba(0,0,0,0.08))",
            fontSize: "0.9em",
          }}
        >
          <div style={{ opacity: 0.8, wordBreak: "break-word" }}>
            Objective: {goalObjective}
          </div>
          <div style={{ opacity: 0.6, marginTop: "0.15rem" }}>Tokens: {tokenStr}</div>
        </div>
      )}
    </div>
  );
}
