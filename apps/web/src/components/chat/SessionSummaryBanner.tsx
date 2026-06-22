import { useEffect, useState } from "react";

import { getCompactionHistory } from "../../lib/api";
import type { CompactionEntry } from "../../lib/api";

/**
 * P4 — long-task progress anchor. Surfaces the latest compaction's
 * summaryText as a sticky banner at the top of chat. Without this
 * the summary is buried as an inline `[Previous conversation
 * summary]` block far up the scroll, and the user loses sight of
 * what the model "remembers" once the task crosses ~30 turns.
 *
 * Hidden when no compaction has occurred on this task yet (most
 * short tasks). Auto-collapsed by default; click "Show summary" to
 * expand. Re-fetches when the taskId changes or after a SSE-driven
 * compaction event hint (we just poll the diagnostics endpoint
 * cheaply on a 30s cadence — compaction events are rare).
 */
export function SessionSummaryBanner({ taskId }: { taskId: string | null }) {
  const [latest, setLatest] = useState<CompactionEntry | null>(null);
  const [count, setCount] = useState<number>(0);
  const [expanded, setExpanded] = useState(false);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  useEffect(() => {
    if (!taskId) {
      setLatest(null);
      setCount(0);
      setDismissedKey(null);
      return;
    }
    let cancelled = false;
    async function load() {
      try {
        const result = await getCompactionHistory({ taskId, limit: 1 });
        if (cancelled) return;
        setLatest(result.entries[0] ?? null);
        setCount(result.totalMatching);
      } catch {
        if (!cancelled) {
          setLatest(null);
          setCount(0);
        }
      }
    }
    void load();
    // Cheap polling — compaction events fire at most every few minutes.
    // A 30s interval keeps the banner fresh without DB pressure.
    const id = setInterval(() => void load(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [taskId]);

  // Hidden when this task has no compaction events at all.
  if (!latest || count === 0) return null;

  const latestKey = `${latest.taskId ?? taskId ?? "global"}:${latest.seq}`;
  if (dismissedKey === latestKey) return null;

  const hasSummary = !!(latest.summaryText || latest.summaryPreview);
  const summary = latest.summaryText ?? latest.summaryPreview ?? "";
  const recordedAt = new Date(latest.recordedAt);
  const fromTokens = latest.preCompactTokens ?? 0;
  const toTokens = latest.postCompactTokens ?? 0;

  // Title varies by what kind of compaction happened. Mechanical-only
  // ("trunc×N / drop×N", no LLM summary) gets a different title that
  // doesn't promise anchor-text the user can read — telling the truth
  // is better than hiding the fact that compaction happened.
  const title = hasSummary
    ? `Session summary (${count} compaction${count === 1 ? "" : "s"})`
    : `Compacted ${count} time${count === 1 ? "" : "s"} — no LLM summary`;

  return (
    <div className="session-summary-banner" role="region" aria-label="Session summary">
      <div className="session-summary-banner__header">
        <button
          type="button"
          className="session-summary-banner__toggle"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          // Only allow expansion when there's something to expand into.
          disabled={!hasSummary}
          title={!hasSummary ? "Mechanical compaction only — no summary to show" : undefined}
        >
          <span className="session-summary-banner__icon" aria-hidden>📦</span>
          <span className="session-summary-banner__title">{title}</span>
          <span className="session-summary-banner__meta">
            {recordedAt.toLocaleString()} ·{" "}
            {fromTokens > 0 ? `${formatTokens(fromTokens)} → ${formatTokens(toTokens)} tokens` : "compacted"}
          </span>
          <span className="session-summary-banner__chevron" aria-hidden>
            {hasSummary ? (expanded ? "▾" : "▸") : null}
          </span>
        </button>
        <button
          type="button"
          className="session-summary-banner__dismiss"
          aria-label="Dismiss session summary"
          onClick={() => {
            setExpanded(false);
            setDismissedKey(latestKey);
          }}
        >
          ×
        </button>
      </div>
      {expanded && hasSummary ? (
        <div className="session-summary-banner__body">
          <pre className="session-summary-banner__text">{summary}</pre>
        </div>
      ) : null}
    </div>
  );
}

function formatTokens(n: number): string {
  if (n === 0) return "0";
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
