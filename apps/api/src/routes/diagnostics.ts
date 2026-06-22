import { desc, eq, and, sql } from "@magister/db";
import type { FastifyInstance } from "fastify";

import { createDb, executionEvents } from "@magister/db";

/**
 * `/diagnostics/*` — operator visibility into long-running runtime
 * behavior that's invisible from the chat surface alone.
 *
 * Phase 1 (P1.5) ships compaction history. The leader emits a
 * `leader.messages_compacted` event every time it compacts; this
 * route surfaces those events with the bits an operator actually
 * cares about (when, why, how much it shrunk the prompt, summary
 * preview). The Settings → Diagnostics tab polls this.
 *
 * Why a separate /diagnostics namespace and not an extension of
 * /status: status is "what is loaded right now", diagnostics is
 * "what has the runtime done over time". Different cardinality
 * (one snapshot vs N rows), different cache/refresh policy.
 */

type CompactionEventData = {
  triggerReason?: "hard_cap" | "proactive" | "user_requested";
  preCompactTokens?: number;
  postCompactTokens?: number;
  truncatedCount?: number;
  snippedCount?: number;
  droppedCount?: number;
  llmCompacted?: boolean;
  llmAttempted?: boolean;
  llmFailedThisTurn?: boolean;
  consecutiveLlmFailures?: number;
  breakerOpen?: boolean;
  summaryText?: string;
  preservedTailTokens?: number;
  tailStartMessageIdx?: number;
  summaryRetryCount?: number;
};

type CompactionEntry = {
  seq: number;
  taskId: string | null;
  runId: string | null;
  recordedAt: string;
  triggerReason: string | null;
  preCompactTokens: number | null;
  postCompactTokens: number | null;
  /** preCompact - postCompact (positive = freed). Null if either input is missing. */
  freedTokens: number | null;
  truncatedCount: number;
  snippedCount: number;
  droppedCount: number;
  llmCompacted: boolean;
  llmAttempted: boolean;
  llmFailedThisTurn: boolean;
  consecutiveLlmFailures: number;
  breakerOpen: boolean;
  summaryText: string | null;
  /** First 240 chars of summaryText for the Settings list render. */
  summaryPreview: string | null;
  preservedTailTokens: number | null;
  tailStartMessageIdx: number | null;
  summaryRetryCount: number | null;
};

type CompactionStats = {
  total: number;
  hardCapTriggers: number;
  proactiveTriggers: number;
  llmSuccesses: number;
  llmFailures: number;
  meanFreedTokens: number;
  meanCompressionRatio: number;
};

const SUMMARY_PREVIEW_CHARS = 240;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function registerDiagnosticsRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: { taskId?: string; limit?: string };
  }>("/diagnostics/compaction-history", async (request) => {
    const taskId =
      typeof request.query.taskId === "string" && request.query.taskId.length > 0
        ? request.query.taskId
        : null;
    const requestedLimit = Number.parseInt(request.query.limit ?? "", 10);
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, MAX_LIMIT)
      : DEFAULT_LIMIT;

    const db = createDb();
    const baseWhere = taskId
      ? and(
          eq(executionEvents.type, "leader.messages_compacted"),
          eq(executionEvents.taskId, taskId),
        )
      : eq(executionEvents.type, "leader.messages_compacted");

    // Kimi P1.5 review M — previously we loaded ALL matching rows
    // into memory just to compute six scalar stats. Now we run two
    // queries: (1) the paged rows for the table; (2) SQL aggregates
    // for the stats. Aggregates use SQLite's `json_extract` over
    // `payload_json` so they don't pay row-materialization cost.
    const rows = await db.query.executionEvents.findMany({
      where: baseWhere,
      orderBy: [desc(executionEvents.seq)],
      limit,
    });

    // Build the WHERE fragment in raw SQL so we can plug it into the
    // aggregate query. drizzle's helpers are nicer for typed queries
    // but the aggregate SQL is faster to express literally.
    const taskFilterFrag = taskId
      ? sql`AND task_id = ${taskId}`
      : sql``;
    const aggRows = await db.all(sql`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN json_extract(payload_json, '$.triggerReason') = 'hard_cap' THEN 1 ELSE 0 END) AS hardCap,
        SUM(CASE WHEN json_extract(payload_json, '$.triggerReason') = 'proactive' THEN 1 ELSE 0 END) AS proactive,
        SUM(CASE WHEN json_extract(payload_json, '$.llmCompacted') = 1 THEN 1 ELSE 0 END) AS llmSucc,
        SUM(CASE WHEN json_extract(payload_json, '$.llmFailedThisTurn') = 1 THEN 1 ELSE 0 END) AS llmFail,
        AVG(
          CASE
            WHEN json_extract(payload_json, '$.preCompactTokens') IS NOT NULL
              AND json_extract(payload_json, '$.postCompactTokens') IS NOT NULL
            THEN json_extract(payload_json, '$.preCompactTokens') - json_extract(payload_json, '$.postCompactTokens')
          END
        ) AS meanFreed,
        AVG(
          CASE
            WHEN json_extract(payload_json, '$.preCompactTokens') > 0
              AND json_extract(payload_json, '$.postCompactTokens') IS NOT NULL
            THEN CAST(json_extract(payload_json, '$.postCompactTokens') AS REAL)
                 / json_extract(payload_json, '$.preCompactTokens')
          END
        ) AS meanRatio
      FROM execution_events
      WHERE type = 'leader.messages_compacted' ${taskFilterFrag}
    `) as Array<{
      total: number;
      hardCap: number | null;
      proactive: number | null;
      llmSucc: number | null;
      llmFail: number | null;
      meanFreed: number | null;
      meanRatio: number | null;
    }>;

    const entries: CompactionEntry[] = rows.map((row) => {
      const data = parsePayload(row.payloadJson);
      const pre = typeof data.preCompactTokens === "number" ? data.preCompactTokens : null;
      const post = typeof data.postCompactTokens === "number" ? data.postCompactTokens : null;
      const freed = pre !== null && post !== null ? pre - post : null;
      const summaryText = typeof data.summaryText === "string" ? data.summaryText : null;
      return {
        seq: row.seq ?? 0,
        taskId: row.taskId ?? null,
        runId: row.roleRuntimeId ?? null,
        recordedAt: row.occurredAt instanceof Date
          ? row.occurredAt.toISOString()
          : new Date(row.occurredAt as unknown as string | number).toISOString(),
        triggerReason: data.triggerReason ?? null,
        preCompactTokens: pre,
        postCompactTokens: post,
        freedTokens: freed,
        truncatedCount: data.truncatedCount ?? 0,
        snippedCount: data.snippedCount ?? 0,
        droppedCount: data.droppedCount ?? 0,
        llmCompacted: data.llmCompacted === true,
        llmAttempted: data.llmAttempted === true,
        llmFailedThisTurn: data.llmFailedThisTurn === true,
        consecutiveLlmFailures: data.consecutiveLlmFailures ?? 0,
        breakerOpen: data.breakerOpen === true,
        summaryText,
        summaryPreview: summaryText
          ? summaryText.slice(0, SUMMARY_PREVIEW_CHARS)
          : null,
        preservedTailTokens: data.preservedTailTokens ?? null,
        tailStartMessageIdx: data.tailStartMessageIdx ?? null,
        summaryRetryCount: data.summaryRetryCount ?? null,
      };
    });

    const aggRow = aggRows[0] ?? null;
    const totalMatching = aggRow?.total ?? 0;
    const stats: CompactionStats = {
      total: totalMatching,
      hardCapTriggers: aggRow?.hardCap ?? 0,
      proactiveTriggers: aggRow?.proactive ?? 0,
      llmSuccesses: aggRow?.llmSucc ?? 0,
      llmFailures: aggRow?.llmFail ?? 0,
      meanFreedTokens: aggRow?.meanFreed != null ? Math.round(aggRow.meanFreed) : 0,
      meanCompressionRatio: aggRow?.meanRatio != null
        ? Math.round(aggRow.meanRatio * 1000) / 1000
        : 0,
    };

    return {
      ok: true,
      data: {
        entries,
        stats,
        limit,
        taskId,
        // Tells the UI whether there are more rows than we returned —
        // entries.length will hit `limit` exactly when truncated.
        truncated: totalMatching > entries.length,
        totalMatching,
      },
    };
  });

  /**
   * `/diagnostics/compaction-history/summary/:seq` — return the FULL
   * summaryText for a single compaction event. The list endpoint
   * trims to 240 chars to keep the grid lean; this is the "show
   * full summary" drilldown. Keyed by seq because (taskId, recordedAt)
   * is not unique within a millisecond on burst compactions.
   */
  app.get<{ Params: { seq: string } }>(
    "/diagnostics/compaction-history/summary/:seq",
    async (request, reply) => {
      // Strict digits-only check (kimi P1.5 review M) — `parseInt`
      // alone accepts "123abc" → 123 and would silently load the
      // wrong event instead of returning 400.
      if (!/^\d+$/.test(request.params.seq)) {
        return reply.status(400).send({ ok: false, error: "invalid_seq" });
      }
      const seq = Number.parseInt(request.params.seq, 10);
      if (!Number.isFinite(seq) || seq <= 0) {
        return reply.status(400).send({ ok: false, error: "invalid_seq" });
      }
      const db = createDb();
      const row = await db.query.executionEvents.findFirst({
        where: and(
          eq(executionEvents.seq, seq),
          eq(executionEvents.type, "leader.messages_compacted"),
        ),
      });
      if (!row) {
        return reply.status(404).send({ ok: false, error: "not_found" });
      }
      const data = parsePayload(row.payloadJson);
      return {
        ok: true,
        data: {
          seq: row.seq ?? 0,
          taskId: row.taskId ?? null,
          summaryText: typeof data.summaryText === "string" ? data.summaryText : null,
        },
      };
    },
  );

  /**
   * `/diagnostics/usage-by-model` — token / call breakdown grouped by
   * model over a sliding window. Lets the user spot which model is
   * using context heavily; cheap SQL aggregate over the existing
   * `token_usage_records` table (no extra writes, indexed on
   * `recorded_at`). Default window: 7 days.
   */
  app.get<{ Querystring: { days?: string } }>(
    "/diagnostics/usage-by-model",
    async (request) => {
      const requestedDays = Number.parseInt(request.query.days ?? "", 10);
      const days = Number.isFinite(requestedDays) && requestedDays > 0 && requestedDays <= 90
        ? requestedDays
        : 7;
      const sinceMs = Date.now() - days * 86_400_000;

      const db = createDb();
      const rows = await db.all(sql`
        SELECT
          model,
          provider,
          COUNT(*) AS callCount,
          SUM(input_tokens) AS inputTokens,
          SUM(output_tokens) AS outputTokens,
          SUM(COALESCE(cache_read_tokens, 0)) AS cacheReadTokens,
          SUM(COALESCE(cache_write_tokens, 0)) AS cacheWriteTokens,
          SUM(COALESCE(reasoning_tokens, 0)) AS reasoningTokens,
          MAX(recorded_at) AS latestRecordedAt
        FROM token_usage_records
        WHERE recorded_at >= ${sinceMs}
        GROUP BY model, provider
        ORDER BY (SUM(input_tokens) + SUM(output_tokens)) DESC
      `) as Array<{
        model: string;
        provider: string;
        callCount: number;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        reasoningTokens: number;
        latestRecordedAt: number;
      }>;

      return {
        ok: true,
        data: {
          windowDays: days,
          sinceMs,
          entries: rows.map((r) => {
            const cacheReadRatio = r.inputTokens > 0
              ? r.cacheReadTokens / r.inputTokens
              : 0;
            return {
              model: r.model,
              provider: r.provider,
              callCount: r.callCount ?? 0,
              inputTokens: r.inputTokens ?? 0,
              outputTokens: r.outputTokens ?? 0,
              cacheReadTokens: r.cacheReadTokens ?? 0,
              cacheWriteTokens: r.cacheWriteTokens ?? 0,
              reasoningTokens: r.reasoningTokens ?? 0,
              cacheReadRatio,
              latestRecordedAt: typeof r.latestRecordedAt === "number"
                ? new Date(r.latestRecordedAt).toISOString()
                : null,
            };
          }),
        },
      };
    },
  );

  /**
   * `/diagnostics/memory` — snapshot of the memory subsystem:
   * extractor latency/yield/errors, injection byte distribution +
   * truncation rate, sweeper duration, auth rejects. Process-local;
   * resets on restart.
   */
  app.get("/diagnostics/memory", async () => {
    const { snapshotMemoryTelemetry } = await import(
      "../services/memory/memory-telemetry"
    );
    return { ok: true, data: snapshotMemoryTelemetry() };
  });
}

/** Decode the payload column. Projector stores
 *  `JSON.stringify(truncatedData)` flat (the inner `.data` of the
 *  event envelope) — no extra unwrapping needed. */
function parsePayload(raw: string | null, seqHint?: number): CompactionEventData {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed as CompactionEventData;
    }
  } catch (err) {
    // Don't silently zero-out stats — the projector should never
    // emit malformed JSON, so surfacing this in logs lets us notice
    // history-store corruption (kimi P1.5 review M).
    console.warn(
      `[diagnostics] failed to parse payload_json${seqHint !== undefined ? ` (seq=${seqHint})` : ""}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return {};
}
