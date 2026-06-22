import { useState } from "react";

import type { TaskTreeResponse } from "../../lib/types";

import { FullTraceModal } from "../trace/FullTraceModal";

const STATE_TONE: Record<string, "run" | "done" | "fail" | "neutral"> = {
  running: "run",
  completed: "done",
  done: "done",
  failed: "fail",
  pending: "neutral",
};

interface TaskHeaderProps {
  taskId: string;
  tree: TaskTreeResponse | null;
  onBack: () => void;
  /** Spec §5 — root-level trace identifier. Defaults to `taskId`
   *  (correct for the common case where a task is its own root). */
  traceId?: string;
}

function shortIdSuffix(taskId: string): string {
  // P3 §5.5 — render `#XXX` short id. We don't carry an integer
  // task index over the wire, so reuse the last 3 hex chars of the
  // task id for a deterministic per-task tag. Cheap and unique
  // enough at any realistic task count.
  const tail = taskId.replace(/[^a-z0-9]/gi, "").slice(-3);
  return tail ? `#${tail}` : "#---";
}

function shortTraceLabel(traceId: string): string {
  // Spec §5.10 — last 8 chars of trace_id, prefixed for legibility.
  const tail = traceId.replace(/[^a-zA-Z0-9_-]/g, "").slice(-8);
  return tail ? `trace:${tail}` : "trace:?";
}

export function TaskHeader({ taskId, tree, onBack, traceId }: TaskHeaderProps) {
  const root = tree?.root;
  const state = root?.state ?? "pending";
  const tone = STATE_TONE[state] ?? "neutral";
  const title = root?.label ?? `Task ${taskId.slice(0, 8)}`;
  const effectiveTraceId = traceId ?? taskId;
  const [traceModalOpen, setTraceModalOpen] = useState(false);

  return (
    <header className="task-header">
      <button className="task-header-back" onClick={onBack} title="Back to Dashboard">
        ← Back
      </button>
      <h1 className="task-header-title">{title}</h1>
      <span className="task-header-short-id">{shortIdSuffix(taskId)}</span>
      <span className="task-header-task-id" title={taskId}>{taskId}</span>
      <button
        type="button"
        className="task-header-trace-badge"
        onClick={() => setTraceModalOpen(true)}
        title={`Trace: ${effectiveTraceId}\nClick to open Full Trace`}
      >
        {shortTraceLabel(effectiveTraceId)}
      </button>
      <span className={`task-header-state task-header-state--${tone}`}>
        {state}
      </span>
      <FullTraceModal
        traceId={effectiveTraceId}
        open={traceModalOpen}
        onClose={() => setTraceModalOpen(false)}
      />
    </header>
  );
}
