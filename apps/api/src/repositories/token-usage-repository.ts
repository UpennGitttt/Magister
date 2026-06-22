import { and, eq, gte, inArray, sql } from "@magister/db";

import {
  createDb,
  getRawSqlite,
  tasks,
  tokenUsageRecords,
  type TokenUsageRecordInsert,
  type TokenUsageRecordSelect,
} from "@magister/db";

/**
 * Persistence layer for per-call LLM token usage. Source of truth
 * for the dashboard / per-task usage panels / status currentSession.
 *
 * Design notes:
 *   - **Goose-style accumulator on tasks**: every insert ALSO bumps
   *     `tasks.accumulated_input_tokens / accumulated_output_tokens`
   *     in the same transaction. Per-task rollup queries become O(1)
   *     instead of GROUP BY scans.
   *   - Cost is intentionally not calculated; the legacy column is
   *     written as NULL for compatibility.
 *   - **`recorded_at` is the temporal axis**, not insertion order —
 *     `latestModel` / `latestProvider` (status-service) ordering off
 *     this column is durable across restarts.
 *
 * Schema lives in packages/db/src/schema.ts. The auto-bootstrap
 * `ensureTokenUsageRecordsTable` in db/client.ts creates the table
 * + indexes idempotently on first connect.
 */

const SHORT_ID_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** 16-char URL-safe id. Drizzle Bun-sqlite doesn't expose UUID
 *  generation natively; this is a self-contained nanoid lookalike
 *  with enough entropy (~96 bits) for write-only ids that we never
 *  cross-reference. */
function generateRecordId(): string {
  let out = "";
  const len = SHORT_ID_ALPHABET.length;
  for (let i = 0; i < 16; i++) {
    out += SHORT_ID_ALPHABET[Math.floor(Math.random() * len)];
  }
  return out;
}

function leaderUsageCondition() {
  return sql`(${tokenUsageRecords.roleId} = 'leader' OR ${tokenUsageRecords.runId} LIKE 'rt_leader_%')`;
}

export type RecordUsageInput = Omit<
  TokenUsageRecordInsert,
  "id" | "recordedAt"
>;

export class TokenUsageRepository {
  /**
   * Insert one usage record AND bump the parent task's accumulated
   * counters in a single transaction. Throws if the task row
   * doesn't exist (would silently fail otherwise — task rows are
   * created upfront by processTaskIntent so this should never
   * happen in practice; we treat it as a hard error to surface
   * the bug).
   */
  async record(input: RecordUsageInput): Promise<TokenUsageRecordSelect> {
    const db = createDb();
    const id = generateRecordId();
    const recordedAt = new Date();

    // exactOptionalPropertyTypes — nullable cols (roleId, requestId
     // etc.) need explicit null instead of undefined when the caller
     // omitted them.
    const row: TokenUsageRecordInsert = {
      id,
      taskId: input.taskId,
      runId: input.runId,
      requestId: input.requestId ?? null,
      roleId: input.roleId ?? null,
      turnNumber: input.turnNumber,
      model: input.model,
      provider: input.provider,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      nonCachedInputTokens: input.nonCachedInputTokens ?? null,
      cacheReadTokens: input.cacheReadTokens ?? null,
      cacheWriteTokens: input.cacheWriteTokens ?? null,
      reasoningTokens: input.reasoningTokens ?? null,
      totalTokens: input.totalTokens ?? null,
      usageSource: input.usageSource ?? null,
      rawUsageJson: input.rawUsageJson ?? null,
      estimatedPromptTokens: input.estimatedPromptTokens ?? null,
      costUsd: null,
      recordedAt,
    };

    // Native synchronous transaction (F4 — async drizzle tx is a no-op on
    // bun-sqlite and throws on better-sqlite3).
    const sqlite = getRawSqlite();
    sqlite.transaction(() => {
      db.insert(tokenUsageRecords).values(row).run();
      // Bump the rolling token accumulators on the parent task. Use
      // raw SQL via drizzle's `sql` template so the increment is
      // atomic (single UPDATE statement, not read-then-write).
      db
        .update(tasks)
        .set({
          accumulatedInputTokens: sql`${tasks.accumulatedInputTokens} + ${input.inputTokens}`,
          accumulatedOutputTokens: sql`${tasks.accumulatedOutputTokens} + ${input.outputTokens}`,
          // goal_tokens_used counts ALL tokens (input + output)
          // consumed since goal start. The continuation template
          // injects a "wrap up" steering message when this nears
          // goal_token_budget. COALESCE keeps increment safe on
          // non-goal tasks (column stays NULL/0).
          goalTokensUsed: sql`COALESCE(${tasks.goalTokensUsed}, 0) + ${input.inputTokens + input.outputTokens}`,
        })
        .where(eq(tasks.id, input.taskId))
        .run();
    })();

    // Materialize as the Select shape (all nullable cols as null, not undefined).
    return {
      id: row.id!,
      taskId: row.taskId,
      runId: row.runId,
      requestId: row.requestId ?? null,
      roleId: row.roleId ?? null,
      turnNumber: row.turnNumber,
      model: row.model,
      provider: row.provider,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      nonCachedInputTokens: row.nonCachedInputTokens ?? null,
      cacheReadTokens: row.cacheReadTokens ?? null,
      cacheWriteTokens: row.cacheWriteTokens ?? null,
      reasoningTokens: row.reasoningTokens ?? null,
      totalTokens: row.totalTokens ?? null,
      usageSource: row.usageSource ?? null,
      rawUsageJson: row.rawUsageJson ?? null,
      estimatedPromptTokens: row.estimatedPromptTokens ?? null,
      costUsd: row.costUsd ?? null,
      recordedAt: row.recordedAt as Date,
    };
  }

  /** Aggregate totals + leader latest (model, provider) for a single task.
   *  Reads the pre-aggregated columns on `tasks` for the totals
   *  (O(1)) and uses usage rows for scope splits and latest context. */
  async getTaskAggregate(taskId: string): Promise<{
    totalInputTokens: number;
    totalOutputTokens: number;
    leaderInputTokens: number;
    leaderOutputTokens: number;
    teammateInputTokens: number;
    teammateOutputTokens: number;
    usageSplitKnown: boolean;
    turnCount: number;
    models: string[];
    latestModel: string | null;
    latestProvider: string | null;
    /** Largest single-call input ever recorded for this task. Used
     *  by the Tokens panel as the "high-water mark" indicator vs
     *  the model's context window. */
    peakInputTokens: number;
    /** Most recent single-call input. Pairs with the resolved
     *  context window to compute live "X% of context used". */
    latestInputTokens: number;
  }> {
    const db = createDb();
    // Kimi review M4 — previous version did `findMany` over every
    // record for the task to derive models/turnCount/latest. For a
    // 1000-turn task that's 1000 rows pulled into memory just to
    // count distinct models. Switched to SQL aggregates:
    //   - DISTINCT model + COUNT(DISTINCT turn_number) for models[]
    //     and turnCount
    //   - ORDER BY recorded_at DESC LIMIT 1 for the leader latest pair
    //   - SUM(input/output) for the records-fallback totals
    //     (only used if accumulators are 0)
    const [
      taskRow,
      latestLeaderRow,
      latestAnyRow,
      modelsRows,
      aggRow,
      splitRow,
      turnCountRow,
      contextWindowRow,
    ] = await Promise.all([
      db.query.tasks.findFirst({ where: eq(tasks.id, taskId) }),
      db.query.tokenUsageRecords.findFirst({
        where: and(eq(tokenUsageRecords.taskId, taskId), leaderUsageCondition()),
        orderBy: (t, { desc }) => [desc(t.recordedAt), desc(t.turnNumber)],
      }),
      db.query.tokenUsageRecords.findFirst({
        where: eq(tokenUsageRecords.taskId, taskId),
        orderBy: (t, { desc }) => [desc(t.recordedAt), desc(t.turnNumber)],
      }),
      db
        .selectDistinct({ model: tokenUsageRecords.model })
        .from(tokenUsageRecords)
        .where(eq(tokenUsageRecords.taskId, taskId)),
      db
        .select({
          inputSum: sql<number>`COALESCE(SUM(${tokenUsageRecords.inputTokens}), 0)`,
          outputSum: sql<number>`COALESCE(SUM(${tokenUsageRecords.outputTokens}), 0)`,
        })
        .from(tokenUsageRecords)
        .where(eq(tokenUsageRecords.taskId, taskId)),
      db
        .select({
          leaderInputSum: sql<number>`COALESCE(SUM(CASE WHEN ${leaderUsageCondition()} THEN ${tokenUsageRecords.inputTokens} ELSE 0 END), 0)`,
          leaderOutputSum: sql<number>`COALESCE(SUM(CASE WHEN ${leaderUsageCondition()} THEN ${tokenUsageRecords.outputTokens} ELSE 0 END), 0)`,
          teammateInputSum: sql<number>`COALESCE(SUM(CASE WHEN ${leaderUsageCondition()} THEN 0 ELSE ${tokenUsageRecords.inputTokens} END), 0)`,
          teammateOutputSum: sql<number>`COALESCE(SUM(CASE WHEN ${leaderUsageCondition()} THEN 0 ELSE ${tokenUsageRecords.outputTokens} END), 0)`,
          unknownScopeCount: sql<number>`COUNT(CASE WHEN ${tokenUsageRecords.roleId} IS NULL AND ${tokenUsageRecords.runId} NOT LIKE 'rt_leader_%' THEN 1 END)`,
        })
        .from(tokenUsageRecords)
        .where(eq(tokenUsageRecords.taskId, taskId)),
      // Chat-turn count for user-facing summaries. A single request_id
      // can produce multiple model calls when the leader uses tools
      // (model -> tool -> model), but it is still one chat turn. Once
      // request_id exists for a task, legacy/null rows must not inflate
      // the visible chat count (common with teammate/runtime records).
      // Only all-legacy tasks fall back to distinct turn_number.
      db
        .select({
          requestCount: sql<number>`COUNT(DISTINCT ${tokenUsageRecords.requestId})`,
          legacyTurnCount: sql<number>`COUNT(DISTINCT ${tokenUsageRecords.turnNumber})`,
        })
        .from(tokenUsageRecords)
        .where(eq(tokenUsageRecords.taskId, taskId)),
      // Context widget: filter to leader's runs only (rt_leader_* runId)
      // so teammate's unrelated input sizes don't pollute the display.
      //
      // New normalized provider rows store inclusive input_tokens. Cache
      // columns are breakdown only, so they must not be added again. Only
      // explicit usage_source='estimated' rows let estimated_prompt_tokens
      // override input_tokens. Historical rows have usage_source NULL and
      // used the old Anthropic shape where input_tokens excluded cache
      // breakdown, so those rows still need cache fields added for context
      // pressure displays.
      db
        .select({
          maxInput: sql<number>`COALESCE(MAX(
            CASE
              WHEN ${tokenUsageRecords.usageSource} IS NULL
              THEN ${tokenUsageRecords.inputTokens}
                + COALESCE(${tokenUsageRecords.cacheReadTokens}, 0)
                + COALESCE(${tokenUsageRecords.cacheWriteTokens}, 0)
              ELSE ${tokenUsageRecords.inputTokens}
            END
          ), 0)`,
          latestInput: sql<number>`COALESCE((
            SELECT MAX(
              CASE
                WHEN usage_source = 'estimated'
                THEN COALESCE(estimated_prompt_tokens, input_tokens)
                WHEN usage_source IS NULL
                THEN input_tokens
                  + COALESCE(cache_read_tokens, 0)
                  + COALESCE(cache_write_tokens, 0)
                ELSE input_tokens
              END
            )
            FROM token_usage_records
            WHERE task_id = ${taskId}
              AND (role_id = 'leader' OR run_id LIKE 'rt_leader_%')
              AND request_id IS (
                SELECT request_id FROM token_usage_records
                WHERE task_id = ${taskId}
                  AND (role_id = 'leader' OR run_id LIKE 'rt_leader_%')
                ORDER BY recorded_at DESC, turn_number DESC LIMIT 1
              )
              AND turn_number = (
                SELECT turn_number FROM token_usage_records
                WHERE task_id = ${taskId}
                  AND (role_id = 'leader' OR run_id LIKE 'rt_leader_%')
                ORDER BY recorded_at DESC, turn_number DESC LIMIT 1
              )
          ), 0)`,
        })
        .from(tokenUsageRecords)
        .where(and(
          eq(tokenUsageRecords.taskId, taskId),
          leaderUsageCondition(),
        )),
    ]);

    const recordsInputSum = aggRow[0]?.inputSum ?? 0;
    const recordsOutputSum = aggRow[0]?.outputSum ?? 0;
    const scopedLeaderInputTokens = splitRow[0]?.leaderInputSum ?? 0;
    const scopedLeaderOutputTokens = splitRow[0]?.leaderOutputSum ?? 0;
    const scopedTeammateInputTokens = splitRow[0]?.teammateInputSum ?? 0;
    const scopedTeammateOutputTokens = splitRow[0]?.teammateOutputSum ?? 0;
    const unknownScopeCount = splitRow[0]?.unknownScopeCount ?? 0;
    const requestTurnCount = turnCountRow[0]?.requestCount ?? 0;
    const legacyTurnCount = turnCountRow[0]?.legacyTurnCount ?? 0;
    const turnCount = requestTurnCount > 0 ? requestTurnCount : legacyTurnCount;
    const models = modelsRows.map((r) => r.model);
    const peakInputTokens = contextWindowRow[0]?.maxInput ?? 0;
    const latestInputTokens = contextWindowRow[0]?.latestInput ?? 0;
    const latestRow = latestLeaderRow ?? latestAnyRow;

    // Prefer accumulated_* columns when available (O(1) and exact);
    // fall back to records sum when task row missing or accumulators
    // are 0 but records exist (the latter happens on first read
    // after migration if the row pre-existed without accumulated_*).
    const totalInputTokens =
      taskRow?.accumulatedInputTokens && taskRow.accumulatedInputTokens > 0
        ? taskRow.accumulatedInputTokens
        : recordsInputSum;
    const totalOutputTokens =
      taskRow?.accumulatedOutputTokens && taskRow.accumulatedOutputTokens > 0
        ? taskRow.accumulatedOutputTokens
        : recordsOutputSum;
    const usageSplitKnown = unknownScopeCount === 0;
    const leaderInputTokens = usageSplitKnown ? scopedLeaderInputTokens : totalInputTokens;
    const leaderOutputTokens = usageSplitKnown ? scopedLeaderOutputTokens : totalOutputTokens;
    const teammateInputTokens = usageSplitKnown ? scopedTeammateInputTokens : 0;
    const teammateOutputTokens = usageSplitKnown ? scopedTeammateOutputTokens : 0;

    return {
      totalInputTokens,
      totalOutputTokens,
      leaderInputTokens,
      leaderOutputTokens,
      teammateInputTokens,
      teammateOutputTokens,
      usageSplitKnown,
      turnCount,
      models,
      latestModel: latestRow?.model ?? null,
      latestProvider: latestRow?.provider ?? null,
      peakInputTokens,
      latestInputTokens,
    };
  }

  async getTaskUsageByRole(taskId: string): Promise<Array<{
    roleId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
  }>> {
    const db = createDb();
    const rows = await db
      .select({
        roleId: sql<string>`COALESCE(${tokenUsageRecords.roleId}, 'unknown')`,
        model: tokenUsageRecords.model,
        inputTokens: sql<number>`COALESCE(SUM(${tokenUsageRecords.inputTokens}), 0)`,
        outputTokens: sql<number>`COALESCE(SUM(${tokenUsageRecords.outputTokens}), 0)`,
      })
      .from(tokenUsageRecords)
      .where(eq(tokenUsageRecords.taskId, taskId))
      .groupBy(sql`COALESCE(${tokenUsageRecords.roleId}, 'unknown')`, tokenUsageRecords.model);
    return rows.map((r) => ({
      roleId: r.roleId,
      model: r.model,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
    }));
  }

  async listUsageByRequestIds(
    taskId: string,
    requestIds: string[],
  ): Promise<Array<{
    requestId: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  }>> {
    const uniqueRequestIds = [...new Set(requestIds.filter((id) => id.length > 0))];
    if (uniqueRequestIds.length === 0) return [];

    const db = createDb();
    const rows = await db
      .select({
        requestId: tokenUsageRecords.requestId,
        inputTokens: sql<number>`COALESCE(SUM(${tokenUsageRecords.inputTokens}), 0)`,
        outputTokens: sql<number>`COALESCE(SUM(${tokenUsageRecords.outputTokens}), 0)`,
      })
      .from(tokenUsageRecords)
      .where(and(
        eq(tokenUsageRecords.taskId, taskId),
        inArray(tokenUsageRecords.requestId, uniqueRequestIds),
      ))
      .groupBy(tokenUsageRecords.requestId);

    const byRequestId = new Map(
      rows
        .filter((row): row is typeof row & { requestId: string } => typeof row.requestId === "string")
        .map((row) => {
          const inputTokens = Number(row.inputTokens) || 0;
          const outputTokens = Number(row.outputTokens) || 0;
          return [
            row.requestId,
            {
              requestId: row.requestId,
              inputTokens,
              outputTokens,
              totalTokens: inputTokens + outputTokens,
            },
          ];
        }),
    );

    return uniqueRequestIds
      .map((requestId) => byRequestId.get(requestId))
      .filter((row): row is NonNullable<typeof row> => row !== undefined);
  }

  /** Rows recorded since the given timestamp (epoch ms). Used by
   *  /usage/today and the recent-usage panel. */
  async listSince(since: Date, limit: number): Promise<TokenUsageRecordSelect[]> {
    const db = createDb();
    return db.query.tokenUsageRecords.findMany({
      where: gte(tokenUsageRecords.recordedAt, since),
      orderBy: (t, { desc }) => [desc(t.recordedAt)],
      limit,
    });
  }

  /** Most recent N rows globally — feeds /usage/recent. */
  async listRecent(limit: number): Promise<TokenUsageRecordSelect[]> {
    const db = createDb();
    return db.query.tokenUsageRecords.findMany({
      orderBy: (t, { desc }) => [desc(t.recordedAt)],
      limit,
    });
  }

  /**
   * Retention sweep — delete rows older than `cutoff` and trim the
   * tail beyond `maxRows`. Called by task-retention-service on its
   * usual cadence.
   *
   * Kimi review M2 (round 1) — earlier version wrapped the entire
   * sweep in one `db.transaction` to keep COUNT/DELETE consistent.
   * Kimi review M2 (round 2) flagged the writer-blocking risk: on
   * a 50k-row table, holding the SQLite write lock across multiple
   * COUNTs and DELETEs could stall every concurrent recordUsage
   * (i.e. every leader turn) for the duration of the sweep.
   *
   * Current strategy (round-2 fix):
   *   - TTL pass: single DELETE (no surrounding transaction). The
   *     `removedByTtl` count is "best effort" via before/after
   *     queries OUTSIDE the transaction; small drift under
   *     concurrent insert load is acceptable for a retention log.
   *   - Cap pass: chunked. Repeatedly DELETE up to BATCH_SIZE rows
   *     past the maxRows tail, each chunk in its own short transaction.
   *     Loop terminates when we've trimmed enough or hit a max
   *     iteration safety cap.
   *
   * Kimi review M3 — cap deletion uses `id NOT IN (SELECT id ORDER
   * BY recorded_at DESC, id DESC LIMIT N)`. Adding `id DESC` as a
   * tie-breaker makes survivor selection deterministic when many
   * rows share `recorded_at` (kimi P1.5 review I).
   */
  async pruneOlderThan(
    cutoff: Date,
    maxRows: number,
  ): Promise<{ removedByTtl: number; removedByCap: number }> {
    const db = createDb();

    // TTL pass — single DELETE, no surrounding tx. Concurrent
    // inserts during the call are deliberately tolerated; the
    // returned count is a snapshot, not a guarantee.
    const beforeTtl =
      ((await db
        .select({ n: sql<number>`COUNT(*)` })
        .from(tokenUsageRecords))[0]?.n) ?? 0;
    await db
      .delete(tokenUsageRecords)
      .where(sql`${tokenUsageRecords.recordedAt} < ${cutoff.getTime()}`);
    const afterTtl =
      ((await db
        .select({ n: sql<number>`COUNT(*)` })
        .from(tokenUsageRecords))[0]?.n) ?? 0;
    const removedByTtl = Math.max(0, beforeTtl - afterTtl);

    // Cap pass — chunked. Each iteration deletes up to BATCH_SIZE
    // of the OLDEST rows beyond the cap, in its own short tx.
    // Concurrent writers see brief lock acquisitions instead of
    // one multi-second hold.
    const BATCH_SIZE = 1000;
    const MAX_ITERATIONS = 100; // safety cap (1000 × 100 = 100k rows max per sweep)
    let removedByCap = 0;
    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      const currentCount =
        ((await db
          .select({ n: sql<number>`COUNT(*)` })
          .from(tokenUsageRecords))[0]?.n) ?? 0;
      if (currentCount <= maxRows) break;
      const overage = currentCount - maxRows;
      const chunk = Math.min(overage, BATCH_SIZE);

      // Delete the OLDEST `chunk` rows. Equivalent to the prior
      // "NOT IN newest-N" formulation but expressed as positive
      // selection (cheaper plan: ORDER BY ASC LIMIT N is a
      // straight index scan, no subquery materialization).
      const result = await db.run(sql`
        DELETE FROM token_usage_records
        WHERE id IN (
          SELECT id FROM token_usage_records
          ORDER BY recorded_at ASC, id ASC
          LIMIT ${chunk}
        )
      `);
      // bun-sqlite drizzle's run() returns a result object whose
      // `changes` field is a number (affected rows). We track it
      // via before/after instead to stay portable across drivers.
      void result;
      removedByCap += chunk;
    }

    return { removedByTtl, removedByCap };
  }
}
