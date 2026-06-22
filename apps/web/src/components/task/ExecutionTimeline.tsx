import { useState, useEffect, useRef } from "react";
import { getTaskSnapshotLight } from "../../lib/api";
import type { TaskStreamSnapshot } from "../../lib/types";

interface LeaderEvent {
  id: string;
  type: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return iso;
  }
}

function eventIcon(type: string, payload: Record<string, unknown>): string {
  if (type === "leader.turn_start") return "\u{1F504}";
  if (type === "leader.tool_call") return "\u{1F527}";
  if (type === "leader.tool_result") {
    const status = payload.status ?? payload.success;
    if (status === "failed" || status === "error" || status === false) return "\u274C";
    return "\u2705";
  }
  if (type === "leader.turn_complete") return "\u2713";
  return "\u2022";
}

function eventColor(type: string, payload: Record<string, unknown>): string {
  if (type === "leader.turn_start") return "var(--accent)";
  if (type === "leader.tool_call") return "var(--warning)";
  if (type === "leader.tool_result") {
    const status = payload.status ?? payload.success;
    if (status === "failed" || status === "error" || status === false) return "var(--error)";
    return "var(--success)";
  }
  if (type === "leader.turn_complete") return "var(--success)";
  return "var(--muted)";
}

function eventDescription(type: string, payload: Record<string, unknown>): string {
  if (type === "leader.turn_start") {
    const turn = payload.turnIndex ?? payload.turn;
    return turn != null ? `Turn ${turn} started` : "Turn started";
  }
  if (type === "leader.tool_call") {
    const name = (payload.toolName ?? payload.name ?? "unknown") as string;
    const args = payload.arguments ?? payload.input ?? payload.args;
    let summary = name;
    if (args && typeof args === "object") {
      const keys = Object.keys(args as Record<string, unknown>);
      if (keys.length > 0) {
        summary += `(${keys.slice(0, 3).join(", ")}${keys.length > 3 ? ", ..." : ""})`;
      }
    }
    return summary;
  }
  if (type === "leader.tool_result") {
    const name = (payload.toolName ?? payload.name ?? "") as string;
    const status = payload.status ?? (payload.success === false ? "failed" : "succeeded");
    const output = (payload.output ?? payload.resultSummary ?? "") as string;
    const prefix = name ? `${name}: ` : "";
    const outputSnippet = output.length > 80 ? output.slice(0, 77) + "..." : output;
    return `${prefix}${status}${outputSnippet ? ` - ${outputSnippet}` : ""}`;
  }
  if (type === "leader.turn_complete") {
    const duration = payload.durationMs ?? payload.duration;
    return duration != null ? `Turn complete (${duration}ms)` : "Turn complete";
  }
  return (payload.summary as string) ?? type;
}

/** Group events by turn (between turn_start and turn_complete). */
interface TurnGroup {
  turnIndex: number;
  turnStart?: LeaderEvent;
  turnComplete?: LeaderEvent;
  events: LeaderEvent[];
  durationMs?: number;
}

function groupByTurn(events: LeaderEvent[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  let current: TurnGroup | null = null;
  let turnCounter = 0;

  for (const ev of events) {
    if (ev.type === "leader.turn_start") {
      turnCounter++;
      current = {
        turnIndex: turnCounter,
        turnStart: ev,
        events: [],
      };
      groups.push(current);
    } else if (ev.type === "leader.turn_complete") {
      if (current) {
        current.turnComplete = ev;
        const startTime = current.turnStart
          ? new Date(current.turnStart.occurredAt).getTime()
          : null;
        const endTime = new Date(ev.occurredAt).getTime();
        if (startTime != null) {
          current.durationMs = endTime - startTime;
        }
        const payload = ev.payload;
        if (typeof payload.durationMs === "number") {
          current.durationMs = payload.durationMs;
        }
        current = null;
      } else {
        // orphan turn_complete
        groups.push({
          turnIndex: ++turnCounter,
          turnComplete: ev,
          events: [],
        });
      }
    } else {
      if (current) {
        current.events.push(ev);
      } else {
        // events outside a turn
        if (groups.length === 0) {
          groups.push({ turnIndex: 0, events: [] });
        }
        const last = groups[groups.length - 1];
        if (last) last.events.push(ev);
      }
    }
  }

  return groups;
}

function parsePayload(raw?: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

interface ExecutionTimelineProps {
  taskId: string;
  highlightedNodeId: string | null;
}

export function ExecutionTimeline({ taskId, highlightedNodeId }: ExecutionTimelineProps) {
  const [snapshot, setSnapshot] = useState<TaskStreamSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  useEffect(() => {
    itemRefs.current.clear();
  }, [taskId]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setSnapshot(null);

    let cancelled = false;

    getTaskSnapshotLight(taskId)
      .then((data) => {
        if (!cancelled) {
          setSnapshot(data);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load timeline");
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [taskId]);

  // Auto-scroll to highlighted node
  useEffect(() => {
    if (!highlightedNodeId) return;
    const el = itemRefs.current.get(highlightedNodeId);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [highlightedNodeId]);

  function toggleExpand(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (loading) {
    return <div className="timeline-loading">Loading timeline...</div>;
  }

  if (error) {
    return <div className="timeline-error">{error}</div>;
  }

  const NOISY_TYPES = new Set([
    "leader.session_checkpoint",
    "leader.stream_delta",
    "leader.decision_trace",
  ]);

  const events: LeaderEvent[] = (snapshot?.events ?? [])
    .filter((e) => e.type.startsWith("leader.") && !NOISY_TYPES.has(e.type))
    .sort(
      (a, b) =>
        new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime(),
    )
    .map((e) => ({
      id: e.id,
      type: e.type,
      occurredAt: e.occurredAt,
      payload: parsePayload(e.payloadJson),
    }));

  if (events.length === 0) {
    return <div className="timeline-empty">No leader events yet.</div>;
  }

  const turns = groupByTurn(events);

  // Horizontal axis ticks per P3 §5.5 — colored marks across the elapsed
  // time range. Color rules:
  //   sage  → live (turn_start at index 0 + most-recent event = NOW)
  //   blue  → tool_call
  //   ochre → approval (approval-shaped events)
  //   ink-3 → turn boundary (turn_complete)
  //   red   → failure
  const firstAt = new Date(events[0]!.occurredAt).getTime();
  const lastAt = new Date(events[events.length - 1]!.occurredAt).getTime();
  const span = Math.max(1, lastAt - firstAt);
  type Tick = { left: number; tone: "live" | "tool" | "appr" | "done" | "fail"; label?: string };
  const ticks: Tick[] = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    const left = ((new Date(ev.occurredAt).getTime() - firstAt) / span) * 100;
    let tone: Tick["tone"] = "live";
    if (ev.type === "leader.tool_call") tone = "tool";
    else if (ev.type === "leader.turn_complete") tone = "done";
    else if (ev.type === "leader.tool_result") {
      const status = ev.payload.status ?? ev.payload.success;
      tone = status === "failed" || status === "error" || status === false ? "fail" : "tool";
    } else if (ev.type.includes("approval")) tone = "appr";
    else if (ev.type === "leader.turn_start") tone = "live";
    const label = i === 0 ? "START" : i === events.length - 1 ? "NOW" : undefined;
    ticks.push(label ? { left, tone, label } : { left, tone });
  }

  // Compute a duration string for the timeline subhead (e.g. "4m 23s").
  const elapsedMs = lastAt - firstAt;
  function fmtElapsed(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${s % 60}s`;
  }

  return (
    <div className="timeline-list">
      <div className="timeline-head">
        <div className="timeline-head__title">Execution timeline</div>
        <div className="timeline-head__sub">
          {events.length} events · {formatTime(events[0]!.occurredAt)} → {formatTime(events[events.length - 1]!.occurredAt)} · {fmtElapsed(elapsedMs)}
        </div>
      </div>
      <div className="timeline-axis" role="img" aria-label="Execution event timeline">
        {ticks.map((t, idx) => (
          <span
            key={`tick-${idx}`}
            className={`timeline-axis__tick timeline-axis__tick--${t.tone}`}
            style={{ left: `${t.left}%` }}
          >
            {t.label ? <span className="timeline-axis__label">{t.label}</span> : null}
          </span>
        ))}
      </div>
      <div className="timeline-legend">
        <span className="timeline-legend__item"><span className="timeline-legend__sw timeline-legend__sw--live" />START / NOW</span>
        <span className="timeline-legend__item"><span className="timeline-legend__sw timeline-legend__sw--tool" />tool_call</span>
        <span className="timeline-legend__item"><span className="timeline-legend__sw timeline-legend__sw--appr" />approval</span>
        <span className="timeline-legend__item"><span className="timeline-legend__sw timeline-legend__sw--done" />turn boundary</span>
      </div>

      <details className="timeline-events-details">
        <summary className="timeline-section-title">Recent events ({events.length})</summary>
      {turns.map((turn) => (
        <div key={`turn-${turn.turnIndex}`} className="timeline-turn-group">
          {/* Turn header */}
          <div className="timeline-turn-header">
            <span className="timeline-turn-label">
              Turn {turn.turnIndex}
            </span>
            {turn.durationMs != null && (
              <span className="timeline-turn-duration">
                {turn.durationMs < 1000
                  ? `${turn.durationMs}ms`
                  : `${(turn.durationMs / 1000).toFixed(1)}s`}
              </span>
            )}
            {turn.turnStart && (
              <span className="timeline-event-time">
                {formatTime(turn.turnStart.occurredAt)}
              </span>
            )}
          </div>

          {/* Inner events (tool_call, tool_result) */}
          {turn.events.map((ev) => {
            const isExpanded = expandedIds.has(ev.id);
            const isHighlighted = highlightedNodeId === ev.id;
            const icon = eventIcon(ev.type, ev.payload);
            const color = eventColor(ev.type, ev.payload);
            const desc = eventDescription(ev.type, ev.payload);
            const duration = ev.payload.durationMs ?? ev.payload.latencyMs;

            return (
              <div
                key={ev.id}
                ref={(el) => {
                  if (el) itemRefs.current.set(ev.id, el);
                }}
                className={`timeline-event timeline-event-expandable${isHighlighted ? " timeline-event-highlighted" : ""}`}
                onClick={() => toggleExpand(ev.id)}
              >
                <span className="timeline-event-time">{formatTime(ev.occurredAt)}</span>
                <span
                  className="timeline-event-icon"
                  style={{ minWidth: 24, textAlign: "center" }}
                >
                  {icon}
                </span>
                <span className="timeline-event-type" style={{ color }}>
                  {ev.type.replace("leader.", "")}
                </span>
                <span className="timeline-event-detail">{desc}</span>
                {duration != null && (
                  <span className="timeline-event-duration">
                    {Number(duration) < 1000
                      ? `${duration}ms`
                      : `${(Number(duration) / 1000).toFixed(1)}s`}
                  </span>
                )}
                {isExpanded && (
                  <div
                    className="timeline-event-expanded"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 11 }}>
                      {JSON.stringify(ev.payload, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            );
          })}

          {/* Turn complete marker */}
          {turn.turnComplete && (
            <div className="timeline-event timeline-turn-complete">
              <span className="timeline-event-time">
                {formatTime(turn.turnComplete.occurredAt)}
              </span>
              <span
                className="timeline-event-icon"
                style={{ minWidth: 24, textAlign: "center", color: "var(--success)" }}
              >
                {"\u2713"}
              </span>
              <span className="timeline-event-type" style={{ color: "var(--success)" }}>
                turn complete
              </span>
            </div>
          )}
        </div>
      ))}
      </details>
    </div>
  );
}
