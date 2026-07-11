import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  createSchedule,
  deleteSchedule,
  getSchedule,
  listSchedules,
  updateSchedule,
  validateCronExpression,
} from "../services/scheduled-task-service";

const createScheduleSchema = z.object({
  name: z.string().trim().min(1).max(200),
  cronExpr: z.string().trim().min(1).max(100),
  prompt: z.string().trim().min(1).max(20_000),
  workspaceId: z.string().min(1).optional().nullable(),
  enabled: z.boolean().optional(),
});

const updateScheduleSchema = createScheduleSchema.partial();

function serialize(row: NonNullable<Awaited<ReturnType<typeof getSchedule>>>) {
  return {
    id: row.id,
    name: row.name,
    cronExpr: row.cronExpr,
    prompt: row.prompt,
    workspaceId: row.workspaceId,
    enabled: row.enabled === 1,
    lastRunAt: row.lastRunAt,
    lastTaskId: row.lastTaskId,
    lastError: row.lastError,
    nextRunAt: row.nextRunAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function registerScheduleRoutes(app: FastifyInstance) {
  app.get("/schedules", async () => {
    const rows = await listSchedules();
    return { ok: true, data: { items: rows.map(serialize) } };
  });

  app.post("/schedules", async (request, reply) => {
    const input = createScheduleSchema.parse(request.body);
    const cronError = validateCronExpression(input.cronExpr);
    if (cronError) {
      reply.status(400);
      return { ok: false, error: { code: "invalid_cron", message: cronError } };
    }
    const row = await createSchedule(input);
    return { ok: true, data: serialize(row) };
  });

  app.patch<{ Params: { id: string } }>("/schedules/:id", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const input = updateScheduleSchema.parse(request.body ?? {});
    if (input.cronExpr !== undefined) {
      const cronError = validateCronExpression(input.cronExpr);
      if (cronError) {
        reply.status(400);
        return { ok: false, error: { code: "invalid_cron", message: cronError } };
      }
    }
    const row = await updateSchedule(params.id, input);
    if (!row) {
      reply.status(404);
      return { ok: false, error: { code: "not_found", message: `Schedule ${params.id} not found` } };
    }
    return { ok: true, data: serialize(row) };
  });

  app.delete<{ Params: { id: string } }>("/schedules/:id", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const deleted = await deleteSchedule(params.id);
    if (!deleted) {
      reply.status(404);
      return { ok: false, error: { code: "not_found", message: `Schedule ${params.id} not found` } };
    }
    return { ok: true, data: { deleted: params.id } };
  });
}
