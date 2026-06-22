import { useEffect, useState } from "react";

import { request } from "../../lib/request";

import "./FullTraceModal.css";

interface TraceSummaryTask {
  taskId: string;
  isRoot: boolean;
  title: string;
  state: string;
  createdAt: string;
  completedAt: string | null;
  durationMs: number | null;
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
  };
}

interface TraceSummary {
  traceId: string;
  rootTaskId: string;
  rootTitle: string;
  tasks: TraceSummaryTask[];
  totals: {
    inputTokens: number;
    outputTokens: number;
  };
}

interface FullTraceModalProps {
  traceId: string;
  open: boolean;
  onClose: () => void;
}

/**
 * Spec §5.10 — Full Trace modal.
 *
 * V1: fetches /traces/:traceId/summary and renders the tasks list +
 * totals. Today every "tree" is a single task (spawn_teammate doesn't
 * create child tasks), so this is mostly a placeholder for future
 * cross-task chains. Still useful even for single tasks: click-to-copy
 * trace_id, surface duration/token totals at a glance.
 */
export function FullTraceModal({ traceId, open, onClose }: FullTraceModalProps) {
  const [summary, setSummary] = useState<TraceSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSummary(null);
    setError(null);
    setLoading(true);
    request<TraceSummary>(`/traces/${encodeURIComponent(traceId)}/summary`)
      .then((data) => {
        if (!cancelled) setSummary(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load trace summary");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, traceId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(traceId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignored: clipboard API may be unavailable; the visible trace id covers it
    }
  };

  return (
    <div className="trace-modal-backdrop" role="dialog" aria-label="Full Trace" onClick={onClose}>
      <div className="trace-modal" onClick={(e) => e.stopPropagation()}>
        <header className="trace-modal-header">
          <h2>Full Trace</h2>
          <button type="button" className="trace-modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="trace-modal-id">
          <code title={traceId}>{traceId}</code>
          <button type="button" className="trace-modal-copy" onClick={handleCopy}>
            {copied ? "✓ copied" : "copy"}
          </button>
        </div>
        {loading && <p className="trace-modal-loading">Loading…</p>}
        {error && <p className="trace-modal-error">{error}</p>}
        {summary && (
          <>
            <section className="trace-modal-section">
              <h3>Totals</h3>
              <dl className="trace-modal-dl">
                <div>
                  <dt>Tasks in trace</dt>
                  <dd>{summary.tasks.length}</dd>
                </div>
                <div>
                  <dt>Input tokens</dt>
                  <dd>{summary.totals.inputTokens.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>Output tokens</dt>
                  <dd>{summary.totals.outputTokens.toLocaleString()}</dd>
                </div>
              </dl>
            </section>
            <section className="trace-modal-section">
              <h3>Tasks</h3>
              <table className="trace-modal-table">
                <thead>
                  <tr>
                    <th>Task</th>
                    <th>State</th>
                    <th>Duration</th>
                    <th>Input</th>
                    <th>Output</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.tasks.map((t) => (
                    <tr key={t.taskId} className={t.isRoot ? "trace-modal-row-root" : ""}>
                      <td title={t.taskId}>
                        {t.isRoot ? "★ " : ""}
                        {t.title.length > 60 ? `${t.title.slice(0, 60)}…` : t.title}
                      </td>
                      <td>{t.state}</td>
                      <td>{t.durationMs != null ? `${(t.durationMs / 1000).toFixed(1)}s` : "—"}</td>
                      <td>{t.tokenUsage.inputTokens.toLocaleString()}</td>
                      <td>{t.tokenUsage.outputTokens.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
