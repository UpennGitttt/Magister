import type { TaskTreeNode, TaskTreeNodeArtifact, TaskTreeNodeEvent } from "../../lib/types";

/** Coarse classification → P3 color token. Errors get red, the model's
 *  cross-turn decision marker gets ochre (so a glance shows where the
 *  loop made a structural choice), terminal "this turn closed cleanly"
 *  gets sage, and everything else falls back to muted ink-3 so the
 *  signal-to-noise on the panel stays sane on busy runtimes. */
function eventTone(eventType: string): "error" | "decision" | "complete" | "muted" {
  if (
    eventType === "leader.model_error" ||
    eventType === "leader.doom_loop_detected" ||
    eventType === "leader.empty_response_detected" ||
    eventType === "leader.max_turns" ||
    eventType === "leader.aborted" ||
    eventType === "leader.tool_timeout"
  ) {
    return "error";
  }
  if (eventType === "leader.decision_trace") return "decision";
  if (
    eventType === "leader.message_complete" ||
    eventType === "leader.turn_complete" ||
    eventType === "leader.session_complete"
  ) {
    return "complete";
  }
  return "muted";
}

/** Relative-time formatter matching the rest of the chat surface
 *  ("just now" / "Xm ago" / "Xh ago" / falls back to local time). */
function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const diff = Date.now() - t;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  try {
    return new Date(t).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/** Read a metadata field as string, falling back to "—" when missing.
 *  Metadata is a free-form `Record<string, unknown>` written by the tree
 *  projector — fields can disappear without notice, so every read needs
 *  a guard. */
function meta(node: TaskTreeNode, key: string, fallback = "—"): string {
  const m = node.metadata;
  if (!m) return fallback;
  const v = m[key];
  if (v == null) return fallback;
  return typeof v === "string" ? v : String(v);
}

function formatStarted(iso: string | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

function formatDuration(ms: number | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function prettyRole(typeOrRole: string): string {
  switch (typeOrRole) {
    case "task": return "root";
    case "leader_response": return "leader";
    case "user_message": return "user";
    case "tool_call": return "tool";
    case "tool_result": return "tool_result";
    case "teammate": return "teammate";
    default: return typeOrRole;
  }
}

export function NodeDetail({ node }: { node: TaskTreeNode }) {
  const rawRole = meta(node, "role", node.type);
  const role = prettyRole(rawRole);
  const model = meta(node, "model");
  const runtime = meta(node, "runtime");
  const provider = meta(node, "provider");
  const tokens = meta(node, "tokens");
  const context = meta(node, "context");
  const turnCount = meta(node, "turnCount");
  const toolCalls = meta(node, "toolCalls");
  const turn = node.metadata?.turn ?? node.metadata?.turnIndex;
  // Mockup subtitle: "node-XXX · turn N · started HH:MM:SS · running for Xm Ys"
  const subtitleParts = [`node-${node.id.slice(-8)}`];
  if (turn != null) subtitleParts.push(`turn ${turn}`);
  if (node.startedAt) subtitleParts.push(`started ${formatStarted(node.startedAt)}`);
  subtitleParts.push(node.state === "running" ? `running for ${formatDuration(node.durationMs)}` : `ran for ${formatDuration(node.durationMs)}`);
  const subtitle = subtitleParts.join(" · ");

  return (
    <div className="task-detail-content">
      <div className="task-detail-head">
        <div className="task-detail-title">
          {role}
          {model && model !== "—"
            ? ` · ${model}`
            : node.label && node.label !== role
              ? ` · ${node.label}`
              : ""}
        </div>
        <div className="task-detail-sub">{subtitle}</div>
      </div>

      <div className="task-detail-kv">
        <div className="task-detail-kv__k">Role</div><div className="task-detail-kv__v">{role}</div>
        <div className="task-detail-kv__k">Model</div><div className="task-detail-kv__v task-detail-kv__v--mono">{model}</div>
        <div className="task-detail-kv__k">Runtime</div><div className="task-detail-kv__v task-detail-kv__v--mono">{runtime}</div>
        <div className="task-detail-kv__k">Provider</div><div className="task-detail-kv__v task-detail-kv__v--mono">{provider}</div>
        <div className="task-detail-kv__k">Tokens</div><div className="task-detail-kv__v task-detail-kv__v--mono">{tokens}</div>
        <div className="task-detail-kv__k">Context</div><div className="task-detail-kv__v task-detail-kv__v--mono">{context}</div>
        <div className="task-detail-kv__k">Turn count</div><div className="task-detail-kv__v task-detail-kv__v--mono">{turnCount}</div>
        <div className="task-detail-kv__k">Tool calls</div><div className="task-detail-kv__v task-detail-kv__v--mono">{toolCalls}</div>
      </div>

      {node.metadata?.fullText ? (
        <div className="task-detail-section">
          <div className="task-detail-section__head">Content</div>
          <pre className="task-detail-code">{String(node.metadata.fullText)}</pre>
        </div>
      ) : null}

      {node.metadata?.input ? (
        <div className="task-detail-section">
          <div className="task-detail-section__head">Input</div>
          <pre className="task-detail-code">{JSON.stringify(node.metadata.input, null, 2)}</pre>
        </div>
      ) : null}

      {node.metadata?.result ? (
        <div className="task-detail-section">
          <div className="task-detail-section__head">Result</div>
          <pre className="task-detail-code">{String(node.metadata.result)}</pre>
        </div>
      ) : null}

      <ArtifactsSection items={node.artifacts} />
      <RecentEventsSection items={node.recentEvents} />
    </div>
  );
}

function ArtifactsSection({ items }: { items: TaskTreeNodeArtifact[] | undefined }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="task-detail-section">
      <div className="task-detail-section__head">Artifacts</div>
      <div className="task-detail-list">
        {items.map((a) => (
          <div key={a.id} className="task-detail-list__row" role="listitem">
            <div className="task-detail-list__primary task-detail-list__primary--mono">{a.path}</div>
            <div className="task-detail-list__secondary">
              {a.summary ? <span className="task-detail-list__summary">{a.summary}</span> : null}
              <span className="task-detail-list__time">{relTime(a.createdAt)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RecentEventsSection({ items }: { items: TaskTreeNodeEvent[] | undefined }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="task-detail-section">
      <div className="task-detail-section__head">Recent events</div>
      <div className="task-detail-list">
        {items.map((e) => {
          const tone = eventTone(e.eventType);
          return (
            <div key={e.id} className="task-detail-list__row" role="listitem">
              <div className="task-detail-list__primary">
                <span className={`task-detail-event-type task-detail-event-type--${tone}`}>
                  {e.eventType.toUpperCase()}
                </span>
                {e.summary ? (
                  <span className="task-detail-list__summary"> · {e.summary}</span>
                ) : null}
              </div>
              <div className="task-detail-list__secondary">
                <span className="task-detail-list__time">{relTime(e.createdAt)}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
