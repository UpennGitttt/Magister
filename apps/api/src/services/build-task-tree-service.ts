import { ArtifactRepository } from "../repositories/artifact-repository";
import { ExecutionEventRepository } from "../repositories/execution-event-repository";
import { RoleRuntimeRepository } from "../repositories/role-runtime-repository";
import { TaskRepository } from "../repositories/task-repository";

/** Lightweight artifact descriptor surfaced on each runtime-backed tree
 *  node. Mirrors the columns we actually render in the Task Detail
 *  sidebar — no body content, just enough metadata for a row + click
 *  affordance later. */
export type TaskTreeNodeArtifact = {
  id: string;
  path: string;
  summary: string | null;
  createdAt: string;
};

/** Structured event descriptor for the "Recent events" section. Body
 *  payloads are filtered to a 1-line summary string at projection time
 *  so the React renderer doesn't need to parse `payloadJson`. */
export type TaskTreeNodeEvent = {
  id: string;
  eventType: string;
  summary: string;
  createdAt: string;
};

export type TaskTreeNode = {
  id: string;
  type: "task" | "user_message" | "leader_response" | "tool_call" | "tool_result" | "teammate";
  label: string;
  state: "running" | "completed" | "failed" | "pending";
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  children: TaskTreeNode[];
  metadata?: Record<string, unknown>;
  /** Last 10 artifacts attached to this node's runtime. Omitted when
   *  the node has no associated runtime (e.g. synthetic user_message /
   *  leader_response / tool_call nodes derived from checkpoint
   *  messages). The web sidebar hides the section entirely when this
   *  is missing or empty. */
  artifacts?: TaskTreeNodeArtifact[];
  /** Last 20 structured events for this runtime (tool_use_start /
   *  message_complete / decision_trace / errors). Streaming deltas and
   *  high-frequency events are filtered server-side to keep the wire
   *  payload bounded. */
  recentEvents?: TaskTreeNodeEvent[];
};

/** Events worth surfacing in the right sidebar's "Recent events"
 *  section. Excludes the high-volume streaming chatter
 *  (`leader.stream_delta`, tool_use_delta, text_delta) and structural
 *  noise like checkpoint dumps. */
const RECENT_EVENT_TYPES = new Set<string>([
  "leader.tool_call",
  "leader.tool_result",
  "leader.tool_timeout",
  "leader.turn_start",
  "leader.turn_complete",
  "leader.decision_trace",
  "leader.doom_loop_detected",
  "leader.model_error",
  "leader.empty_response_detected",
  "leader.max_turns",
  "leader.approval_requested",
  "leader.approval_resolved",
  "leader.teammate_spawned",
  "leader.teammate_completed",
  "leader.session_complete",
  "leader.aborted",
  "leader.system_notice",
  "leader.recovery_attempted",
]);

const RECENT_EVENT_LIMIT = 20;
const ARTIFACT_LIMIT = 10;

export type TaskTreeResponse = {
  root: TaskTreeNode;
  stats: {
    totalNodes: number;
    userMessages: number;
    toolCalls: number;
    teammates: number;
  };
};

export async function buildTaskTree(taskId: string): Promise<TaskTreeResponse | null> {
  const taskRepo = new TaskRepository();
  const runtimeRepo = new RoleRuntimeRepository();
  const eventRepo = new ExecutionEventRepository();
  const artifactRepo = new ArtifactRepository();

  const task = await taskRepo.getById(taskId);
  if (!task) return null;

  const root: TaskTreeNode = {
    id: task.id,
    type: "task",
    label: task.title,
    state: mapTaskState(task.state),
    ...(task.createdAt ? { startedAt: task.createdAt.toISOString() } : {}),
    ...(task.completedAt ? { completedAt: task.completedAt.toISOString() } : {}),
    ...(task.completedAt && task.createdAt
      ? { durationMs: task.completedAt.getTime() - task.createdAt.getTime() }
      : {}),
    children: [],
  };

  // Get the latest checkpoint to build tree from conversation messages
  const events = await eventRepo.listByTaskId(taskId);
  const checkpointEvents = events
    .filter((e) => e.type === "leader.session_checkpoint" && e.payloadJson)
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

  const latestCheckpoint = checkpointEvents[checkpointEvents.length - 1];

  if (latestCheckpoint?.payloadJson) {
    try {
      const payload = JSON.parse(latestCheckpoint.payloadJson) as {
        messages?: Array<{ type: string; content: unknown; toolUseId?: string; isError?: boolean }>;
      };

      if (Array.isArray(payload.messages)) {
        root.children = buildTreeFromMessages(payload.messages, taskId);
      }
    } catch {}
  }

  // Add teammate runtimes
  const runtimes = await runtimeRepo.listByTaskId(taskId);
  const leaderRuntime = runtimes.find((r) => r.roleId === "leader" && !r.parentRunId);

  // Pull all artifacts for the task once + bucket by roleRuntimeId so
  // each runtime-backed node can slice its own. Artifacts without a
  // roleRuntimeId (legacy / task-scoped) bucket under the leader
  // runtime so they still surface on the task root.
  const allArtifacts = await artifactRepo.listByTaskId(taskId);
  const artifactsByRuntime = bucketArtifactsByRuntime(allArtifacts, leaderRuntime?.id);

  // Attach to root (task node) — backed by the leader runtime.
  if (leaderRuntime) {
    root.artifacts = artifactsByRuntime.get(leaderRuntime.id) ?? [];
    root.recentEvents = await loadRecentEvents(eventRepo, leaderRuntime.id);
  }

  if (leaderRuntime) {
    const teammates = runtimes.filter((r) => r.parentRunId === leaderRuntime.id);
    for (const tm of teammates) {
      // Find which user message group the teammate belongs to (by time)
      const teammateNode: TaskTreeNode = {
        id: tm.id,
        type: "teammate",
        label: tm.roleId,
        state: mapTaskState(tm.state),
        ...(tm.startedAt ? { startedAt: tm.startedAt.toISOString() } : {}),
        ...(tm.completedAt ? { completedAt: tm.completedAt.toISOString() } : {}),
        ...(tm.completedAt && tm.startedAt
          ? { durationMs: tm.completedAt.getTime() - tm.startedAt.getTime() }
          : {}),
        children: [],
        metadata: { role: tm.roleId },
        artifacts: artifactsByRuntime.get(tm.id) ?? [],
        recentEvents: await loadRecentEvents(eventRepo, tm.id),
      };
      // Append to the last user message group
      const lastUserGroup = [...root.children].reverse().find((n) => n.type === "user_message");
      if (lastUserGroup) {
        lastUserGroup.children.push(teammateNode);
      } else {
        root.children.push(teammateNode);
      }
    }
  }

  // Count stats
  let userMessages = 0;
  let toolCalls = 0;
  let teammates = 0;
  function countStats(node: TaskTreeNode) {
    if (node.type === "user_message") userMessages++;
    if (node.type === "tool_call") toolCalls++;
    if (node.type === "teammate") teammates++;
    for (const child of node.children) countStats(child);
  }
  countStats(root);

  function countNodes(node: TaskTreeNode): number {
    return 1 + node.children.reduce((sum, child) => sum + countNodes(child), 0);
  }

  return {
    root,
    stats: { totalNodes: countNodes(root), userMessages, toolCalls, teammates },
  };
}

/**
 * Build tree from checkpoint messages.
 * Structure: User Message → Leader Response (with tool calls as children)
 */
function buildTreeFromMessages(
  messages: Array<{ type: string; content: unknown; toolUseId?: string; isError?: boolean }>,
  taskId: string,
): TaskTreeNode[] {
  const children: TaskTreeNode[] = [];
  let currentUserGroup: TaskTreeNode | null = null;
  let msgIndex = 0;

  for (const msg of messages) {
    msgIndex++;
    const nodeId = `${taskId}-msg-${msgIndex}`;

    if (msg.type === "user") {
      // Start a new user message group
      const text = extractTextContent(msg.content);
      currentUserGroup = {
        id: nodeId,
        type: "user_message",
        label: text.slice(0, 50) || "User message",
        state: "completed",
        children: [],
        metadata: { fullText: text },
      };
      children.push(currentUserGroup);
    } else if (msg.type === "assistant") {
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      const textBlocks = blocks.filter((b: any) => b.type === "text" && b.text);
      const toolUseBlocks = blocks.filter((b: any) => b.type === "tool_use");

      // If assistant has text, add as leader response
      if (textBlocks.length > 0) {
        const responseText = textBlocks.map((b: any) => b.text).join("\n");
        const responseNode: TaskTreeNode = {
          id: `${nodeId}-response`,
          type: "leader_response",
          label: responseText.slice(0, 50) || "Leader response",
          state: "completed",
          children: [],
          metadata: { fullText: responseText },
        };
        if (currentUserGroup) {
          currentUserGroup.children.push(responseNode);
        } else {
          children.push(responseNode);
        }
      }

      // Add tool calls as children of the current user group
      for (const tool of toolUseBlocks) {
        const toolNode: TaskTreeNode = {
          id: `${nodeId}-tool-${(tool as any).id ?? msgIndex}`,
          type: "tool_call",
          label: (tool as any).name ?? "tool",
          state: "running", // will be updated by tool_result
          children: [],
          metadata: {
            toolName: (tool as any).name,
            toolUseId: (tool as any).id,
            input: (tool as any).input,
          },
        };
        if (currentUserGroup) {
          currentUserGroup.children.push(toolNode);
        } else {
          children.push(toolNode);
        }
      }
    } else if (msg.type === "tool_result") {
      // Find matching tool_call and update its state
      const toolUseId = msg.toolUseId;
      const isError = msg.isError;
      const resultText = extractTextContent(msg.content);

      if (toolUseId && currentUserGroup) {
        const matchingTool = currentUserGroup.children.find(
          (n) => n.type === "tool_call" && n.metadata?.toolUseId === toolUseId,
        );
        if (matchingTool) {
          matchingTool.state = isError ? "failed" : "completed";
          matchingTool.metadata = {
            ...matchingTool.metadata,
            result: resultText.slice(0, 200),
            isError,
          };
        }
      }
    }
  }

  return children;
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("\n");
  }
  return String(content ?? "");
}

/** Group artifacts by `roleRuntimeId`, sort newest-first, cap to
 *  `ARTIFACT_LIMIT`, and project to the wire shape. Artifacts with a
 *  null runtime id are attributed to the leader runtime so they still
 *  surface on the task root (legacy rows pre-runtime-scoping). */
function bucketArtifactsByRuntime(
  artifacts: Array<{
    id: string;
    roleRuntimeId: string | null;
    storageRef: string;
    title: string;
    summary: string | null;
    createdAt: Date;
  }>,
  leaderRuntimeId: string | undefined,
): Map<string, TaskTreeNodeArtifact[]> {
  const grouped = new Map<string, typeof artifacts>();
  for (const art of artifacts) {
    const key = art.roleRuntimeId ?? leaderRuntimeId;
    if (!key) continue;
    const bucket = grouped.get(key) ?? [];
    bucket.push(art);
    grouped.set(key, bucket);
  }
  const result = new Map<string, TaskTreeNodeArtifact[]>();
  for (const [runtimeId, rows] of grouped) {
    const sorted = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    result.set(
      runtimeId,
      sorted.slice(0, ARTIFACT_LIMIT).map((a) => ({
        id: a.id,
        // `storageRef` is the canonical filesystem path; `title` is a
        // human label. Fall back to title when storageRef is empty
        // (some artifact types persist body-only).
        path: a.storageRef || a.title,
        summary: a.summary ?? null,
        createdAt: a.createdAt.toISOString(),
      })),
    );
  }
  return result;
}

/** Load up to `RECENT_EVENT_LIMIT` structured events for a runtime,
 *  filtered to the allow-list set. Falls back to scanning a small
 *  window (allow-list intersect runtime events) and returns newest
 *  first. The DB-side filter is a typed `inArray` join across
 *  `RECENT_EVENT_TYPES`, so even high-traffic runtimes don't scan the
 *  streaming-delta firehose. */
async function loadRecentEvents(
  eventRepo: ExecutionEventRepository,
  roleRuntimeId: string,
): Promise<TaskTreeNodeEvent[]> {
  const types = Array.from(RECENT_EVENT_TYPES);
  const rows = await eventRepo.listByRoleRuntimeIdAndTypes(roleRuntimeId, types);
  // listByRoleRuntimeIdAndTypes orders ASC by seq; reverse + slice to
  // get newest-first capped at the limit.
  const newestFirst = [...rows].reverse().slice(0, RECENT_EVENT_LIMIT);
  return newestFirst.map((ev) => ({
    id: ev.id,
    eventType: ev.type,
    summary: summarizeEvent(ev.type, ev.payloadJson),
    createdAt: ev.occurredAt.toISOString(),
  }));
}

/** Render a 1-line summary for the recent-events sidebar list. We
 *  intentionally do NOT include the raw payload — most are JSON dumps
 *  with hundreds of fields, and the right panel only has room for one
 *  line. Per-type knowledge keeps the summary informative without
 *  schema-coupling the renderer. */
function summarizeEvent(type: string, payloadJson: string | null): string {
  if (!payloadJson) return type;
  try {
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;
    if (type === "leader.tool_call" || type === "leader.tool_result") {
      const name = typeof payload.toolName === "string" ? payload.toolName : payload.name;
      return typeof name === "string" ? name : type;
    }
    if (type === "leader.decision_trace") {
      const turn = payload.turnIndex ?? payload.turn ?? "?";
      const tools = Array.isArray(payload.toolNames) ? payload.toolNames.length : (payload.toolCount ?? 0);
      return `turn ${turn} · ${tools} tool(s)`;
    }
    if (type === "leader.doom_loop_detected") {
      const fp = typeof payload.fingerprint === "string" ? payload.fingerprint.slice(0, 12) : "";
      return fp ? `fingerprint ${fp}` : "repeated tool calls blocked";
    }
    if (type === "leader.model_error") {
      const msg = typeof payload.message === "string" ? payload.message : payload.error;
      return typeof msg === "string" ? msg.slice(0, 100) : "model error";
    }
    if (type === "leader.teammate_spawned" || type === "leader.teammate_completed") {
      const role = typeof payload.role === "string" ? payload.role : payload.roleId;
      return typeof role === "string" ? role : type;
    }
    if (type === "leader.session_complete") {
      const turns = payload.turnCount ?? payload.turns;
      return turns != null ? `${turns} turn(s)` : "session complete";
    }
    if (type === "leader.approval_requested" || type === "leader.approval_resolved") {
      const kind = typeof payload.toolKind === "string" ? payload.toolKind : payload.kind;
      return typeof kind === "string" ? kind : type;
    }
    return "";
  } catch {
    return "";
  }
}

function mapTaskState(state: string): TaskTreeNode["state"] {
  switch (state) {
    case "DONE":
    case "COMPLETED":
      return "completed";
    case "FAILED":
      return "failed";
    case "EXECUTING":
    case "RUNNING":
    case "IN_PROGRESS":
      return "running";
    default:
      return "pending";
  }
}
