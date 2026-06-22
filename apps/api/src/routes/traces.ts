import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { ExecutionEventRepository } from "../repositories/execution-event-repository";
import { TaskRepository } from "../repositories/task-repository";

/**
 * Root-level trace API.
 *
 * A trace is the entire work tree under one root task. trace_id =
 * root task_id. These endpoints let the dashboard pull all events
 * of a tree in one O(1) query (indexed on `trace_id`) and aggregate
 * a token/duration summary.
 */
export async function registerTraceRoutes(app: FastifyInstance) {
  const eventRepo = new ExecutionEventRepository();
  const taskRepo = new TaskRepository();

  /**
   * GET /traces/:traceId/events
   * Returns every event stamped with this trace_id, time-ordered.
   * Uses `COALESCE(trace_id, task_id)` so pre-migration single-task
   * traces still respond when called with the task's id.
   */
  app.get("/traces/:traceId/events", async (request, reply) => {
    const params = z.object({ traceId: z.string().min(1) }).parse(request.params);
    const query = z
      .object({
        limit: z.coerce.number().int().positive().max(10_000).optional(),
        order: z.enum(["asc", "desc"]).default("asc"),
      })
      .parse(request.query);

    const events = await eventRepo.listByTraceId(params.traceId, {
      ...(query.limit ? { limit: query.limit } : {}),
      order: query.order,
    });

    if (events.length === 0) {
      // Could be "trace doesn't exist" OR "trace has no events yet".
      // Cheap follow-up: is the trace_id at least a real task id?
      const taskExists = await taskRepo.getById(params.traceId);
      if (!taskExists) {
        reply.status(404);
        return {
          ok: false,
          error: { code: "not_found", message: `No events for trace ${params.traceId}` },
        };
      }
    }

    return {
      ok: true,
      data: { traceId: params.traceId, count: events.length, events },
    };
  });

  /**
   * GET /traces/:traceId/summary
   * Tasks list + duration/token totals. Tasks are picked by either
   * `trace_id` (new rows) or `id = traceId` (legacy single-task
   * fallback).
   */
  app.get("/traces/:traceId/summary", async (request, reply) => {
    const params = z.object({ traceId: z.string().min(1) }).parse(request.params);

    const allTasks = await taskRepo.listAll();
    const tasksInTrace = allTasks.filter(
      (t) => t.traceId === params.traceId || (t.traceId == null && t.id === params.traceId),
    );

    if (tasksInTrace.length === 0) {
      reply.status(404);
      return {
        ok: false,
        error: { code: "not_found", message: `No tasks for trace ${params.traceId}` },
      };
    }

    const rootTask = tasksInTrace.find((t) => t.id === params.traceId) ?? tasksInTrace[0]!;
    const totals = tasksInTrace.reduce(
      (acc, t) => ({
        inputTokens: acc.inputTokens + (t.accumulatedInputTokens ?? 0),
        outputTokens: acc.outputTokens + (t.accumulatedOutputTokens ?? 0),
      }),
      { inputTokens: 0, outputTokens: 0 },
    );

    const tasksSummary = tasksInTrace.map((t) => ({
      taskId: t.id,
      isRoot: t.id === params.traceId,
      title: t.title,
      state: t.state,
      createdAt: t.createdAt,
      completedAt: t.completedAt ?? null,
      durationMs:
        t.completedAt && t.createdAt
          ? t.completedAt.getTime() - t.createdAt.getTime()
          : null,
      tokenUsage: {
        inputTokens: t.accumulatedInputTokens ?? 0,
        outputTokens: t.accumulatedOutputTokens ?? 0,
      },
    }));

    return {
      ok: true,
      data: {
        traceId: params.traceId,
        rootTaskId: rootTask.id,
        rootTitle: rootTask.title,
        tasks: tasksSummary,
        totals,
      },
    };
  });
}
