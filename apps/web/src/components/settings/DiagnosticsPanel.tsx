import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { Pill } from "../ui/Pill";
import { getCompactionHistory, getCompactionSummary, getUsageByModel, restartSystem, getSystemStatus } from "../../lib/api";
import type {
  CompactionEntry,
  CompactionStats,
  UsageByModelEntry,
} from "../../lib/api";

/**
 * Settings → Diagnostics panel.
 *
 * Phase 1: shows the leader's compaction history. This panel surfaces
 * compaction events so an operator can verify the system is doing what
 * the docs claim, and notice when LLM-summary compaction
 * (`llmCompacted=true`) silently never lands (the runtime degrades
 * to mechanical truncate / drop and the user can't tell from chat).
 *
 * Layout:
 *   - Stats strip: total / hard-cap vs proactive / llm hits/misses
 *     / mean compression ratio
 *   - Table: one row per compaction event, newest first
 *   - Click row → drill into full summaryText (when present)
 */
export function DiagnosticsPanel() {
  const [data, setData] = useState<{
    entries: CompactionEntry[];
    stats: CompactionStats;
    truncated: boolean;
    totalMatching: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [selectedFull, setSelectedFull] = useState<string | null>(null);
  const [selectedFullLoading, setSelectedFullLoading] = useState(false);
  // Model breakdown state — independent fetch (separate endpoint) so
  // a slow compaction-history query doesn't block the usage view.
  const [modelDays, setModelDays] = useState<number>(7);
  const [modelData, setModelData] = useState<{
    entries: UsageByModelEntry[];
    windowDays: number;
  } | null>(null);

  async function load() {
    try {
      setLoading(true);
      setError(null);
      const result = await getCompactionHistory({ limit: 50 });
      setData({
        entries: result.entries,
        stats: result.stats,
        truncated: result.truncated,
        totalMatching: result.totalMatching,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  async function loadModelBreakdown(days: number) {
    try {
      const result = await getUsageByModel(days);
      setModelData({
        entries: result.entries,
        windowDays: result.windowDays,
      });
    } catch {
      // Don't propagate to the global error state — model breakdown is
      // a secondary section. Render "failed to load" inline instead.
      setModelData(null);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    void loadModelBreakdown(modelDays);
  }, [modelDays]);

  async function openSummary(seq: number, fallbackPreview: string | null) {
    setSelectedSeq(seq);
    // If the entry already had a non-truncated preview (rare — preview is
    // capped to 240 chars), that's the most we'll ever show. Fetch full
    // content for the longer cases.
    setSelectedFull(fallbackPreview);
    setSelectedFullLoading(true);
    try {
      const detail = await getCompactionSummary(seq);
      setSelectedFull(detail.summaryText ?? fallbackPreview);
    } catch (err) {
      setSelectedFull(
        `(failed to load full summary: ${err instanceof Error ? err.message : String(err)})`,
      );
    } finally {
      setSelectedFullLoading(false);
    }
  }

  if (loading && !data) return <p className="settings-loading">Loading diagnostics…</p>;
  if (error) {
    return (
      <div className="diagnostics-panel">
        <p className="settings-error">{error}</p>
        <button type="button" className="config-edit-btn" onClick={() => void load()}>Retry</button>
      </div>
    );
  }
  if (!data) return null;

  const { entries, stats, truncated, totalMatching } = data;

  return (
    <div className="diagnostics-panel">
      <header className="settings-section-header">
        <div>
          <h2>Diagnostics</h2>
          <p>Compaction history — what the leader has done to keep the prompt under budget.</p>
        </div>
        <button type="button" className="config-edit-btn" onClick={() => void load()} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </header>

      <ServerControlSection />

      <section className="settings-section">
        <h3>Compaction</h3>
        <StatsStrip stats={stats} totalMatching={totalMatching} />

        {entries.length === 0 ? (
          <p style={{ color: "var(--ink-3)" }}>
            No compaction events recorded yet. The leader compacts when input tokens cross ~70% of
            the model's available context window.
          </p>
        ) : (
          <div className="diagnostics-table-wrap">
            <table className="diagnostics-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Trigger</th>
                  <th>Pre → Post</th>
                  <th>Mode</th>
                  <th>Task</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr
                    key={entry.seq}
                    onClick={() => void openSummary(entry.seq, entry.summaryPreview)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        void openSummary(entry.seq, entry.summaryPreview);
                      }
                    }}
                    style={{ cursor: "pointer" }}
                    role="button"
                    tabIndex={0}
                    aria-label={`Open compaction summary for seq ${entry.seq}`}
                  >
                    <td>
                      <time dateTime={entry.recordedAt}>
                        {new Date(entry.recordedAt).toLocaleString()}
                      </time>
                    </td>
                    <td>
                      <TriggerBadge trigger={entry.triggerReason} />
                    </td>
                    <td>{formatPrePost(entry)}</td>
                    <td>{formatMode(entry)}</td>
                    <td>
                      <code style={{ fontSize: "0.85em" }}>
                        {entry.taskId ? entry.taskId.slice(0, 18) + (entry.taskId.length > 18 ? "…" : "") : "—"}
                      </code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {truncated ? (
              <p className="diagnostics-table-foot">
                Showing newest 50 of {totalMatching} events · click row for full summary text
              </p>
            ) : null}
          </div>
        )}
      </section>

      <section className="settings-section">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>Usage by model</h3>
          <label
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--ink-3)",
              letterSpacing: "0.04em",
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            Window
            <select
              value={modelDays}
              onChange={(e) => setModelDays(Number.parseInt(e.target.value, 10))}
              aria-label="Time window for model breakdown"
            >
              <option value={1}>1 day</option>
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
            </select>
          </label>
        </div>

        {modelData === null ? (
          <p style={{ color: "var(--ink-3)" }}>Loading model breakdown…</p>
        ) : modelData.entries.length === 0 ? (
          <p style={{ color: "var(--ink-3)" }}>
            No usage in the last {modelData.windowDays} day(s).
          </p>
        ) : (
          <div className="diagnostics-table-wrap">
            <table className="diagnostics-table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Provider</th>
                  <th>Calls</th>
                  <th>Input / Output</th>
                  <th
                    title={
                      "Cache hit tokens (prompt-caching). Populated when "
                      + "the upstream API returns `cache_read_input_tokens` "
                      + "(Anthropic) or `prompt_tokens_details.cached_tokens` "
                      + "/ `prompt_cache_hit_tokens` (OpenAI / DeepSeek). "
                      + "Shows `—` when the provider doesn't echo the field "
                      + "in streaming usage (most Chinese compat endpoints) "
                      + "or when no caching occurred for this window."
                    }
                  >
                    Cache hit
                  </th>
                </tr>
              </thead>
              <tbody>
                {modelData.entries.map((entry) => (
                  <tr key={`${entry.model}/${entry.provider}`}>
                    <td><code style={{ fontSize: "0.9em" }}>{entry.model}</code></td>
                    <td style={{ color: "var(--ink-3)", fontSize: "0.9em" }}>
                      {entry.provider}
                    </td>
                    <td>{entry.callCount}</td>
                    <td style={{ fontSize: "0.9em" }}>
                      {formatTokens(entry.inputTokens)} / {formatTokens(entry.outputTokens)}
                    </td>
                    <td
                      style={{ fontSize: "0.9em" }}
                      title={
                        entry.cacheReadTokens > 0
                          ? undefined
                          : "Provider didn't return a cache hit count for this model. Real Anthropic + OpenAI APIs include it; many compat endpoints don't."
                      }
                    >
                      {entry.cacheReadTokens > 0
                        ? `${formatTokens(entry.cacheReadTokens)} (${(entry.cacheReadRatio * 100).toFixed(0)}%)`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selectedSeq !== null ? (
        <SummaryModal
          seq={selectedSeq}
          loading={selectedFullLoading}
          summary={selectedFull}
          onClose={() => {
            setSelectedSeq(null);
            setSelectedFull(null);
          }}
        />
      ) : null}
    </div>
  );
}

function StatsStrip({
  stats,
  totalMatching,
}: {
  stats: CompactionStats;
  totalMatching: number;
}) {
  const llmRate = stats.total > 0 ? Math.round((stats.llmSuccesses / stats.total) * 100) : 0;
  return (
    <div className="diagnostics-stats">
      <Stat label="Total" value={String(totalMatching)} />
      <Stat
        label="Hard-cap"
        value={String(stats.hardCapTriggers)}
        warn={stats.hardCapTriggers > 0}
      />
      <Stat label="Proactive" value={String(stats.proactiveTriggers)} />
      <Stat
        label="LLM-summarized"
        value={`${stats.llmSuccesses} / ${stats.total}`}
        {...(stats.total > 0 ? { sub: `${llmRate}%` } : {})}
        warn={stats.total > 0 && stats.llmSuccesses === 0}
      />
      <Stat
        label="Mean freed"
        value={formatTokens(stats.meanFreedTokens)}
        sub="tok"
      />
      <Stat
        label="Mean ratio"
        value={stats.meanCompressionRatio > 0 ? stats.meanCompressionRatio.toFixed(3) : "—"}
        sub="post / pre"
        hint="post / pre tokens"
      />
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  hint,
  warn,
}: {
  label: string;
  value: string;
  sub?: string;
  hint?: string;
  warn?: boolean;
}) {
  return (
    <div className="diagnostics-stat" title={hint}>
      <div className="diagnostics-stat__label">{label}</div>
      <div className={`diagnostics-stat__value${warn ? " diagnostics-stat__value--warn" : ""}`}>
        {value}
      </div>
      {sub ? <div className="diagnostics-stat__sub">{sub}</div> : null}
    </div>
  );
}

function TriggerBadge({ trigger }: { trigger: "hard_cap" | "proactive" | "user_requested" | null }) {
  if (trigger === "hard_cap") {
    return <Pill tone="red">hard-cap</Pill>;
  }
  if (trigger === "proactive") {
    return <Pill tone="blue">proactive</Pill>;
  }
  if (trigger === "user_requested") {
    return <Pill tone="sage">manual</Pill>;
  }
  return <span style={{ color: "var(--ink-3)" }}>—</span>;
}

function formatPrePost(entry: CompactionEntry): string {
  const pre = entry.preCompactTokens;
  const post = entry.postCompactTokens;
  if (pre === null || post === null) return "—";
  return `${formatTokens(pre)} → ${formatTokens(post)}`;
}

function formatMode(entry: CompactionEntry): ReactNode {
  const parts: string[] = [];
  if (entry.llmCompacted) parts.push("LLM-summary");
  if (entry.truncatedCount > 0) parts.push(`trunc×${entry.truncatedCount}`);
  if (entry.snippedCount > 0) parts.push(`snip×${entry.snippedCount}`);
  if (entry.droppedCount > 0) parts.push(`drop×${entry.droppedCount}`);
  if (entry.breakerOpen) parts.push("breaker-open");
  if (entry.llmFailedThisTurn) parts.push("llm-failed");
  if (parts.length === 0) parts.push("none");
  return <span style={{ fontSize: "0.85em" }}>{parts.join(" · ")}</span>;
}

function formatTokens(n: number): string {
  if (n === 0) return "0";
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function SummaryModal({
  seq,
  loading,
  summary,
  onClose,
}: {
  seq: number;
  loading: boolean;
  summary: string | null;
  onClose: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Compaction summary seq ${seq}`}
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(24,22,20,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--paper)",
          border: "1px solid var(--line)",
          borderRadius: "var(--radius)",
          padding: 24,
          maxWidth: "min(720px, 90vw)",
          maxHeight: "80vh",
          overflowY: "auto",
          color: "var(--ink)",
        }}
      >
        <header style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Compaction summary · seq {seq}</h3>
          <button type="button" className="config-edit-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        {loading && summary === null ? (
          <p>Loading…</p>
        ) : summary === null || summary === "" ? (
          <p style={{ color: "var(--ink-3)" }}>
            No LLM-summary text — this compaction used mechanical truncate / drop only.
          </p>
        ) : (
          <pre
            style={{
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              fontFamily: "var(--font-mono)",
              fontSize: 12.5,
              lineHeight: 1.55,
              margin: 0,
              color: "var(--ink)",
            }}
          >
            {summary}
          </pre>
        )}
      </div>
    </div>
  );
}

/**
 * Server-control section. Single button: "Restart server".
 *
 * Why this exists: the mobile operator can't SSH to run
 * `bash scripts/restart-profile.sh prod` when a leader run hangs.
 * Without this, every restart needs a laptop nearby. Backend's
 * POST /system/restart spawns a detached subprocess that survives
 * the API's own SIGTERM, then re-execs restart-profile.sh after a
 * 2-second grace period to let this HTTP response flush.
 *
 * Flow:
 *   idle → click → confirm modal → restarting (spinner + countdown,
 *   poll /system/status every 2s) → back-online → auto-reload.
 *
 * If the poll keeps failing past ~30s, surface a "still down" error
 * with the log file path so the operator knows what to inspect.
 */
function ServerControlSection() {
  const [phase, setPhase] = useState<"idle" | "confirm" | "restarting" | "online" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [info, setInfo] = useState<{ logPath: string; estimatedReadyInMs: number } | null>(null);

  useEffect(() => {
    if (phase !== "restarting") return;
    let cancelled = false;
    const startedAt = Date.now();
    const tick = window.setInterval(() => {
      if (cancelled) return;
      setElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
    }, 500);
    const checkHealth = async () => {
      if (cancelled) return;
      try {
        await getSystemStatus();
        if (cancelled) return;
        setPhase("online");
      } catch {
        // Not back yet. Loop.
        if (Date.now() - startedAt > 45_000) {
          if (cancelled) return;
          setPhase("failed");
          setError(
            `Server has not returned after 45s. Check the restart log: ${info?.logPath ?? "(unknown path)"}`,
          );
          return;
        }
        window.setTimeout(checkHealth, 2_000);
      }
    };
    // Wait the backend's "estimated ready" then start polling.
    const initialDelay = info?.estimatedReadyInMs ?? 5_000;
    const initialTimer = window.setTimeout(checkHealth, initialDelay);
    return () => {
      cancelled = true;
      window.clearInterval(tick);
      window.clearTimeout(initialTimer);
    };
  }, [phase, info]);

  useEffect(() => {
    if (phase !== "online") return;
    // Give the user 1 second to read "Back online" then reload so
    // they see the freshly restarted UI build.
    const t = window.setTimeout(() => window.location.reload(), 1_000);
    return () => window.clearTimeout(t);
  }, [phase]);

  async function trigger() {
    setError(null);
    setPhase("restarting");
    setElapsedSec(0);
    try {
      const result = await restartSystem();
      setInfo({ logPath: result.logPath, estimatedReadyInMs: result.estimatedReadyInMs });
    } catch (err) {
      setPhase("failed");
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section className="settings-section" style={{ borderColor: "var(--ink-4)" }}>
      <h3>Server control</h3>
      <p style={{ color: "var(--ink-3)", marginTop: 0 }}>
        Restart the API + Web servers. Use when Leader is stuck mid-turn or you need to pick up a
        config change that requires reload. Active tasks will be interrupted.
      </p>

      {phase === "idle" && (
        <button
          type="button"
          className="config-edit-btn"
          style={{
            background: "color-mix(in srgb, #d97706 14%, transparent)",
            borderColor: "#d97706",
            color: "#d97706",
            fontWeight: 600,
          }}
          onClick={() => setPhase("confirm")}
        >
          Restart server
        </button>
      )}

      {phase === "confirm" && (
        <div
          role="alertdialog"
          aria-label="Confirm restart"
          style={{
            border: "1px solid var(--ink-4)",
            borderRadius: 6,
            padding: 12,
            background: "var(--surface-soft)",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <strong>Restart the server now?</strong>
          <span style={{ color: "var(--ink-3)", fontSize: 13 }}>
            Any leader task currently mid-turn will be killed. New API will come up after ~5-10
            seconds; this page will reload automatically.
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="config-edit-btn"
              style={{
                background: "color-mix(in srgb, #ef4444 14%, transparent)",
                borderColor: "#ef4444",
                color: "#ef4444",
                fontWeight: 600,
              }}
              onClick={() => void trigger()}
            >
              Yes, restart
            </button>
            <button
              type="button"
              className="config-edit-btn"
              onClick={() => setPhase("idle")}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {phase === "restarting" && (
        <div
          role="status"
          aria-live="polite"
          style={{
            border: "1px solid color-mix(in srgb, #6f8eff 70%, var(--ink-4))",
            borderRadius: 6,
            padding: 12,
            background: "color-mix(in srgb, #6f8eff 8%, var(--surface))",
          }}
        >
          Restarting… ({elapsedSec}s){" "}
          <span style={{ color: "var(--ink-3)", fontSize: 13 }}>
            Polling for return; this page will reload when the server is back.
          </span>
        </div>
      )}

      {phase === "online" && (
        <div
          role="status"
          aria-live="polite"
          style={{
            border: "1px solid color-mix(in srgb, #16a34a 70%, var(--ink-4))",
            borderRadius: 6,
            padding: 12,
            background: "color-mix(in srgb, #16a34a 12%, var(--surface))",
            color: "#16a34a",
            fontWeight: 600,
          }}
        >
          Back online ✓ — reloading…
        </div>
      )}

      {phase === "failed" && (
        <div
          role="alert"
          style={{
            border: "1px solid var(--error)",
            borderRadius: 6,
            padding: 12,
            background: "rgba(239,68,68,0.08)",
            color: "var(--error)",
          }}
        >
          <strong>Restart failed.</strong> {error ?? "Unknown error."}
          <div style={{ marginTop: 8 }}>
            <button
              type="button"
              className="config-edit-btn"
              onClick={() => {
                setPhase("idle");
                setError(null);
              }}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
