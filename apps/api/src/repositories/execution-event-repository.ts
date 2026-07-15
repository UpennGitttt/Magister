import { and, asc, desc, eq, gt, gte, inArray, or, sql } from "@magister/db";

import {
  createDb,
  executionEvents,
  type ExecutionEventInsert,
} from "@magister/db";

let globalSeq = 0;

// Initialize from DB max on first use
async function getNextSeq(db: ReturnType<typeof createDb>): Promise<number> {
  if (globalSeq === 0) {
    const result = db.select({ maxSeq: sql`MAX(seq)` }).from(executionEvents).get();
    globalSeq = (result?.maxSeq as number) ?? 0;
  }
  return ++globalSeq;
}

export class ExecutionEventRepository {
  async create(input: ExecutionEventInsert) {
    const db = createDb();
    const seq = await getNextSeq(db);
    await db.insert(executionEvents).values({ ...input, seq });
    return seq; // return seq so callers can use it for WS broadcast
  }

  /**
   * Reserve the next seq without writing to the DB. Pair with
   * `persistWithSeq` for the broadcast-first path used by
   * high-frequency streaming events (leader.stream_delta) where
   * blocking the SSE broadcast on the DB write made model thinking
   * content arrive perceptibly late on the chat UI.
   */
  async allocSeq(): Promise<number> {
    const db = createDb();
    return getNextSeq(db);
  }

  /**
   * Insert an event row using a pre-allocated seq. Used by the
   * projector's stream_delta hot path: allocSeq → broadcast →
   * persistWithSeq (fire-and-forget). Loss on crash is acceptable
   * because stream_delta accumulates into the next
   * leader.session_checkpoint, which IS awaited.
   */
  async persistWithSeq(input: ExecutionEventInsert, seq: number): Promise<void> {
    const db = createDb();
    await db.insert(executionEvents).values({ ...input, seq });
  }

  async listAll() {
    const db = createDb();
    return db.query.executionEvents.findMany({
      orderBy: [asc(executionEvents.seq)],
    });
  }

  async listByType(type: string, limit?: number) {
    const db = createDb();
    return db.query.executionEvents.findMany({
      where: eq(executionEvents.type, type),
      orderBy: [asc(executionEvents.occurredAt), asc(executionEvents.seq)],
      ...(typeof limit === "number" && limit > 0 ? { limit } : {}),
    });
  }

  /**
   * Time-windowed multi-type query for background workers (sentinel
   * patrol / digest aggregation) that consume system-level events
   * regardless of task. `since` is inclusive.
   */
  async listByTypesSince(types: readonly string[], since: Date, limit = 500) {
    if (types.length === 0) return [];
    const db = createDb();
    return db.query.executionEvents.findMany({
      where: and(
        inArray(executionEvents.type, types as string[]),
        gte(executionEvents.occurredAt, since),
      ),
      orderBy: [asc(executionEvents.occurredAt), asc(executionEvents.seq)],
      limit,
    });
  }

  async listByTaskId(taskId: string) {
    const db = createDb();
    return db.query.executionEvents.findMany({
      where: eq(executionEvents.taskId, taskId),
      orderBy: [asc(executionEvents.seq)],
    });
  }

  /**
   * Plan v2.1 / Step 1 — look up the parentToolUseId for a teammate
   * runtime (used by `wait_for_teammate` to emit a recovery hint when
   * its result gets capped). Best-effort; returns null on miss.
   * Pre-Step-0b runtimes won't find a parent_tool_use_id stamped row.
   */
  async findParentToolUseIdForRuntime(runtimeId: string): Promise<string | null> {
    const db = createDb();
    const row = await db.query.executionEvents.findFirst({
      where: and(
        eq(executionEvents.roleRuntimeId, runtimeId),
        sql`${executionEvents.parentToolUseId} IS NOT NULL`,
      ),
      orderBy: [asc(executionEvents.seq)],
    });
    return row?.parentToolUseId ?? null;
  }

  /**
   * fetch a teammate's full event log,
   * paginated by seq. Backs the `read_teammate_transcript` leader
   * tool and the (future) `/tasks/:id/teammate/:parentToolUseId/
   * transcript` lazy-load endpoint.
   *
   * Uses the partial index `idx_execution_events_parent_tool` on
   * `(task_id, parent_tool_use_id) WHERE parent_tool_use_id IS NOT
   * NULL` (created in Step 0b). Filtering on `parent_tool_use_id`
   * (the denormalized column) instead of `json_extract(agent_json,
   * '$.parentToolUseId')` is what makes this O(log n) rather than
   * a full table scan on tasks with large event histories.
   *
   * `sinceSeq` is exclusive — passing the last seq from a prior
   * call returns the next page without dedupe. Pre-Step-0b rows
   * have parent_tool_use_id=NULL so they don't appear here at all
   * (intentional — those rows can't be paired to a teammate run).
   */
  async listTeammateTranscript(
    taskId: string,
    parentToolUseId: string,
    sinceSeq: number,
    limit: number,
  ) {
    const db = createDb();
    return db.query.executionEvents.findMany({
      where: and(
        eq(executionEvents.taskId, taskId),
        eq(executionEvents.parentToolUseId, parentToolUseId),
        gt(executionEvents.seq, sinceSeq),
      ),
      orderBy: [asc(executionEvents.seq)],
      limit,
    });
  }

  /**
   * Filtered + paginated variant of `listByTaskId` for callers that
   * only need a specific event type. Used by progress-artifacts'
   * compaction-time helpers (loadLatestPlan / loadReadFiles) to
   * avoid scanning every leader.stream_delta on long sessions —
   * stream_delta dominates volume by ~100× over tool_call.
   *
   * Order is DESC by seq so callers walking newest-first don't have
   * to reverse. Use `limit` to cap when only the most recent N
   * matter (e.g. loadLatestPlan = 1, loadReadFiles = 50).
   */
  async deleteById(id: string): Promise<void> {
    const db = createDb();
    await db.delete(executionEvents).where(eq(executionEvents.id, id));
  }

  async listByTaskIdAndType(taskId: string, type: string, limit?: number) {
    const db = createDb();
    return db.query.executionEvents.findMany({
      where: and(eq(executionEvents.taskId, taskId), eq(executionEvents.type, type)),
      orderBy: [desc(executionEvents.seq)],
      ...(typeof limit === "number" && limit > 0 ? { limit } : {}),
    });
  }

  /** Multi-type variant — same DB-side filtering benefit as
   * `listByTaskIdAndType` but for callers that consume several
   * orchestration types at once (e.g. orchestration-read-model). */
  async listByTaskIdAndTypes(taskId: string, types: readonly string[]) {
    if (types.length === 0) return [];
    const db = createDb();
    return db.query.executionEvents.findMany({
      where: and(
        eq(executionEvents.taskId, taskId),
        inArray(executionEvents.type, types as string[]),
      ),
      orderBy: [asc(executionEvents.seq)],
    });
  }

  async getLatestByTaskIdAndType(taskId: string, type: string) {
    const db = createDb();
    return (
      (await db.query.executionEvents.findFirst({
        where: and(eq(executionEvents.taskId, taskId), eq(executionEvents.type, type)),
        orderBy: [desc(executionEvents.occurredAt), desc(executionEvents.seq)],
      })) ?? null
    );
  }

  /**
   * Lean variant for the task-summary materializer. The summary only
   * needs (a) events with severity warn/error (latestBlocker), (b)
   * `task.orchestration.waiting` (waitReason / nextWakeupAt), (c)
   * recovery orchestration markers used for derived session notices, and (d)
   * bounded leader lifecycle events used for blocked/waiting narratives. Loading
   * the full `listByTaskId` set was ~1000×-ing the actual need
   * because stream_delta dominates volume by ~100× over the events
   * the summary uses — that translated into a 3.3 s `/tasks` call on
   * an 84k-row DB. This narrows the fetch to what's actually read.
   */
  async listForTaskSummary(taskId: string) {
    const db = createDb();
    return db.query.executionEvents.findMany({
      where: and(
        eq(executionEvents.taskId, taskId),
        or(
          inArray(executionEvents.severity, ["warn", "error"]),
          eq(executionEvents.type, "task.orchestration.waiting"),
          eq(executionEvents.type, "task.orchestration.transition"),
          eq(executionEvents.type, "task.orchestration.stopped"),
          eq(executionEvents.type, "leader.approval_requested"),
          eq(executionEvents.type, "leader.approval_resolved"),
          eq(executionEvents.type, "leader.plan_proposed"),
          eq(executionEvents.type, "leader.plan_mode_exited"),
          eq(executionEvents.type, "leader.model_error"),
          eq(executionEvents.type, "leader.max_turns"),
          eq(executionEvents.type, "executor_session.failed"),
        ),
      ),
      orderBy: [asc(executionEvents.seq)],
    });
  }

  async listForWorkspaceSummary(limit = 200) {
    const db = createDb();
    return db.query.executionEvents.findMany({
      where: or(
        inArray(executionEvents.severity, ["warn", "error"]),
        inArray(executionEvents.type, [
          "task.orchestration.transition",
          "task.orchestration.waiting",
          "task.orchestration.stopped",
          "task.manager.plan_created",
          "task.work_items.updated",
        ]),
      ),
      orderBy: [desc(executionEvents.occurredAt), desc(executionEvents.seq)],
      limit,
    });
  }

  async listByRoleRuntimeId(roleRuntimeId: string) {
    const db = createDb();
    return db.query.executionEvents.findMany({
      where: eq(executionEvents.roleRuntimeId, roleRuntimeId),
      orderBy: [asc(executionEvents.seq)],
    });
  }

  /**
   * Fetch the entire event tree for a root trace in one indexed query.
   *
   * Backward-compat: pre-migration rows have `trace_id = NULL`. The
   * `OR (trace_id IS NULL AND task_id = traceId)` branch lets callers
   * still see those events when the trace_id happens to equal the
   * original single-task id — the single-task-as-trace fallback. New
   * rows ALWAYS carry trace_id (set at task creation via projector
   * default), so the fallback path narrows over time.
   */
  async listByTraceId(traceId: string, options?: { limit?: number; order?: "asc" | "desc" }) {
    const db = createDb();
    return db.query.executionEvents.findMany({
      where: or(
        eq(executionEvents.traceId, traceId),
        and(
          sql`${executionEvents.traceId} IS NULL`,
          eq(executionEvents.taskId, traceId),
        ),
      ),
      orderBy:
        options?.order === "desc"
          ? [desc(executionEvents.occurredAt), desc(executionEvents.seq)]
          : [asc(executionEvents.occurredAt), asc(executionEvents.seq)],
      ...(typeof options?.limit === "number" && options.limit > 0 ? { limit: options.limit } : {}),
    });
  }

  async listByRoleRuntimeIdAndTypes(roleRuntimeId: string, types: readonly string[]) {
    if (types.length === 0) return [];
    const db = createDb();
    return db.query.executionEvents.findMany({
      where: and(
        eq(executionEvents.roleRuntimeId, roleRuntimeId),
        inArray(executionEvents.type, types as string[]),
      ),
      orderBy: [asc(executionEvents.seq)],
    });
  }

  async listByArtifactIds(artifactIds: string[]) {
    if (artifactIds.length === 0) {
      return [];
    }

    const db = createDb();
    return db.query.executionEvents.findMany({
      where: inArray(executionEvents.artifactId, artifactIds),
    });
  }

  async getLatestByType(type: string) {
    const db = createDb();
    return db.query.executionEvents.findFirst({
      where: eq(executionEvents.type, type),
      orderBy: [desc(executionEvents.occurredAt)],
    });
  }

  async getLatestCheckpointByRunId(runId: string) {
    const db = createDb();
    return (
      (await db.query.executionEvents.findFirst({
        where: and(
          eq(executionEvents.roleRuntimeId, runId),
          eq(executionEvents.type, "leader.session_checkpoint"),
        ),
        orderBy: [desc(executionEvents.occurredAt), desc(executionEvents.seq)],
      })) ?? null
    );
  }

  async listSinceSeq(taskId: string, sinceSeq: number, limit = 100) {
    const db = createDb();
    return db.query.executionEvents.findMany({
      where: and(
        eq(executionEvents.taskId, taskId),
        gt(executionEvents.seq, sinceSeq),
      ),
      orderBy: [asc(executionEvents.seq)],
      limit,
    });
  }

  /**
   * Snapshot the events for the most recent N requestIds (turns) on a
   * task. Used by chat UI hydration: the alternative — `listSinceSeq`
   * with limit=100 — silently truncates large-history tasks to the
   * OLDEST 100 events, surfacing "we are stuck at turn 1" in the UI
   * even after dozens of newer turns landed.
   *
   * Returns events ordered by seq ASC (so the projector can replay
   * deterministically). Pre-PR-1 events with NULL request_id are
   * excluded — they never carried an exchange identity, so
   * including them would only confuse seq ordering anyway.
   */
  async listLatestRequestEvents(
    taskId: string,
    lastNRequests = 30,
    maxRawEvents = 50_000,
    fetchPageSize = 5_000,
  ) {
    const db = createDb();
    // Step 1 — find the latest N requestIds by their first-seen seq.
    // SQLite's GROUP BY + ORDER BY MIN(seq) DESC works fine; for the
    // worst-case 172k-event task it scans the full task partition once.
    const requestIdRows = (await db
      .select({
        requestId: executionEvents.requestId,
        firstSeq: sql<number>`MIN(${executionEvents.seq})`,
        eventCount: sql<number>`COUNT(*)`,
      })
      .from(executionEvents)
      .where(
        and(
          eq(executionEvents.taskId, taskId),
          sql`${executionEvents.requestId} IS NOT NULL`,
        ),
      )
      .groupBy(executionEvents.requestId)
      .orderBy(sql`MIN(${executionEvents.seq}) DESC`)
    .limit(lastNRequests)) as Array<{ requestId: string | null; firstSeq: number; eventCount: number }>;

    const rawEventBudget = Number.isFinite(maxRawEvents) && maxRawEvents > 0
      ? Math.floor(maxRawEvents)
      : Number.POSITIVE_INFINITY;
    const recentRequestIds: string[] = [];
    let selectedRawEvents = 0;
    for (const row of requestIdRows) {
      if (typeof row.requestId !== "string") continue;
      const rowCount = Number(row.eventCount) || 0;
      if (recentRequestIds.length > 0 && selectedRawEvents + rowCount > rawEventBudget) {
        break;
      }
      recentRequestIds.push(row.requestId);
      selectedRawEvents += rowCount;
      if (selectedRawEvents >= rawEventBudget) {
        break;
      }
    }

    if (recentRequestIds.length === 0) return [];

    // Step 2 — fetch selected requestIds in seq pages. A single large
    // request can still exceed the multi-request budget above because
    // dropping part of the newest turn would corrupt the rendered answer;
    // paging keeps that correctness choice from turning into a huge
    // in-memory raw row array.
    const pageSize = Number.isFinite(fetchPageSize) && fetchPageSize > 0
      ? Math.floor(fetchPageSize)
      : 5_000;
    const coalescer = createStreamDeltaCoalescer();
    let lastSeq = 0;
    while (true) {
      const page = await db.query.executionEvents.findMany({
        where: and(
          eq(executionEvents.taskId, taskId),
          inArray(executionEvents.requestId, recentRequestIds),
          gt(executionEvents.seq, lastSeq),
        ),
        orderBy: [asc(executionEvents.seq)],
        limit: pageSize,
      });
      if (page.length === 0) break;
      coalescer.push(page);
      const nextSeq = page[page.length - 1]!.seq;
      if (typeof nextSeq !== "number") break;
      lastSeq = nextSeq;
      if (page.length < pageSize) break;
    }

    // Step 3 — coalesce consecutive `leader.stream_delta` events that
    // append text to the same part. A 30-turn slice of a heavy task
    // had 99% of events as 1-3 char thinking/text deltas (148k of
    // 149k total). The projector only cares about the cumulative
    // content per part, so emitting 1 synthetic delta with the full
    // text is equivalent to N small ones — and shrinks the snapshot
    // from ~80 MB to a few MB. Through Tailscale Funnel that's the
    // difference between "page paints in seconds" and "page never
    // paints." Tool_use_deltas are coalesced per tool_use_id;
    // anything else flushes the in-flight buffer and passes through.
    return coalescer.finish();
  }

  async deleteOlderCheckpoints(runId: string, keepCount: number) {
    const db = createDb();
    const all = await db
      .select({ id: executionEvents.id })
      .from(executionEvents)
      .where(
        and(
          eq(executionEvents.roleRuntimeId, runId),
          eq(executionEvents.type, "leader.session_checkpoint"),
        ),
      )
      .orderBy(desc(executionEvents.occurredAt), desc(executionEvents.seq));

    const toDelete = all.slice(keepCount).map((r) => r.id);
    if (toDelete.length > 0) {
      await db
        .delete(executionEvents)
        .where(inArray(executionEvents.id, toDelete));
    }
  }
}

// ──────────────────────────────────────────────────────────────────────
// Snapshot coalescing
// ──────────────────────────────────────────────────────────────────────

type RawEvent = Awaited<ReturnType<ExecutionEventRepository["listByTaskId"]>>[number];

/**
 * Walk events in seq order; merge runs of `leader.stream_delta` that
 * append to the same part (same request/agent scope + inner-type for
 * text/thinking, same request/agent scope + tool_use_id for
 * tool_use_delta). Anything else flushes any in-flight coalesce buffer
 * and passes through unchanged.
 *
 * Resulting events keep the LAST seq of the run (so seq-based dedup
 * on the client still sees a monotonic stream), and `payloadJson` is
 * rewritten to carry the concatenated text/json. The synthetic
 * payload is structurally identical to a real delta — the projector
 * cannot tell the difference.
 */
function createStreamDeltaCoalescer() {
  const out: RawEvent[] = [];
  // Pending coalesce buffer: { ev (cloned), key, mergedPayload }.
  let pending: { ev: RawEvent; key: string; payload: Record<string, unknown> } | null = null;

  function flush() {
    if (pending) {
      const evWithJson: RawEvent = { ...pending.ev, payloadJson: JSON.stringify(pending.payload) };
      out.push(evWithJson);
      pending = null;
    }
  }

  return {
    push(events: RawEvent[]) {
      for (const ev of events) {
        if (ev.type === "leader.session_checkpoint") continue;
        if (ev.type !== "leader.stream_delta") {
          flush();
          out.push(ev);
          continue;
        }
        let data: Record<string, unknown>;
        try {
          data = ev.payloadJson ? (JSON.parse(ev.payloadJson) as Record<string, unknown>) : {};
        } catch {
          flush();
          out.push(ev);
          continue;
        }
        const innerType = typeof data.type === "string" ? data.type : "";

        const agentScope = [
          ev.requestId ?? "",
          ev.roleRuntimeId ?? "",
          ev.parentToolUseId ?? "",
          ev.agentJson ?? "",
        ].join("|");
        let key: string | null = null;
        if (innerType === "thinking_delta" || innerType === "text_delta") {
          key = `${agentScope}|${innerType}`;
        } else if (innerType === "tool_use_delta") {
          const toolId = (data.tool_use_id ?? data.id ?? "anon") as string;
          key = `${agentScope}|tool_use|${toolId}`;
        }

        if (!key) {
          flush();
          out.push(ev);
          continue;
        }

        if (pending && pending.key === key) {
          // Append: text+text for thinking/text, json+json for tool_use_delta.
          if (innerType === "tool_use_delta") {
            const incoming = (data.partial_json ?? data.json ?? "") as string;
            const existing = (pending.payload.partial_json ?? pending.payload.json ?? "") as string;
            const fieldName: "partial_json" | "json" = "partial_json" in pending.payload ? "partial_json" : "json";
            pending.payload[fieldName] = existing + incoming;
          } else {
            const incoming = (data.text ?? "") as string;
            pending.payload.text = ((pending.payload.text ?? "") as string) + incoming;
          }
          pending.ev = { ...pending.ev, seq: ev.seq, occurredAt: ev.occurredAt };
        } else {
          flush();
          pending = { ev: { ...ev }, key, payload: { ...data } };
        }
      }
    },
    finish(): RawEvent[] {
      flush();
      return out;
    }
  };
}

function coalesceStreamDeltas(events: RawEvent[]): RawEvent[] {
  const coalescer = createStreamDeltaCoalescer();
  coalescer.push(events);
  return coalescer.finish();
}
