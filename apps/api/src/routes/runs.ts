import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { ExecutionEventRepository } from "../repositories/execution-event-repository";
import { RoleRuntimeRepository } from "../repositories/role-runtime-repository";
import { RunSummaryStore } from "../observability/run-summary-store";
import { cleanupRunArtifacts } from "../services/cleanup-artifacts-service";
import { dispatchRun } from "../services/dispatch-run-service";
import { getRunContext } from "../services/get-run-context-service";
import { getRunSummary } from "../services/get-run-service";
import { listRunArtifacts } from "../services/list-run-artifacts-service";
import { continueRun, retryRun } from "../services/run-control-service";

export async function registerRunRoutes(app: FastifyInstance) {
  const runSummaryStore = new RunSummaryStore();
  const executionEventRepository = new ExecutionEventRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const workspaceOverrideSchema = z.enum(["workspace_root", "git_worktree"]).nullable();

  app.get("/runs/:runId", async (request, reply) => {
    const params = z.object({ runId: z.string().min(1) }).parse(request.params);
    const runSummary = await getRunSummary(params.runId);

    if (!runSummary) {
      reply.status(404);
      return {
        ok: false,
        error: {
          code: "not_found",
          message: `Run not found: ${params.runId}`,
        },
      };
    }

    return {
      ok: true,
      data: runSummary,
    };
  });

  app.get("/runs/:runId/context", async (request, reply) => {
    const params = z.object({ runId: z.string().min(1) }).parse(request.params);
    const runContext = await getRunContext(params.runId);

    if (!runContext) {
      reply.status(404);
      return {
        ok: false,
        error: {
          code: "not_found",
          message: `Run not found: ${params.runId}`,
        },
      };
    }

    return {
      ok: true,
      data: runContext,
    };
  });

  app.get("/runs/:runId/artifacts", async (request, reply) => {
    const params = z.object({ runId: z.string().min(1) }).parse(request.params);
    const runSummary = await getRunSummary(params.runId);

    if (!runSummary) {
      reply.status(404);
      return {
        ok: false,
        error: {
          code: "not_found",
          message: `Run not found: ${params.runId}`,
        },
      };
    }

    const items = await listRunArtifacts(params.runId);
    return {
      ok: true,
      data: {
        runId: params.runId,
        items,
      },
    };
  });

  app.post("/runs/:runId/artifacts/cleanup", async (request, reply) => {
    const params = z.object({ runId: z.string().min(1) }).parse(request.params);
    const runSummary = await getRunSummary(params.runId);

    if (!runSummary) {
      reply.status(404);
      return {
        ok: false,
        error: {
          code: "not_found",
          message: `Run not found: ${params.runId}`,
        },
      };
    }

    return {
      ok: true,
      data: await cleanupRunArtifacts(params.runId),
    };
  });

  app.post("/runs/:runId/dispatch", async (request, reply) => {
    const params = z.object({ runId: z.string().min(1) }).parse(request.params);
    const body = z
      .object({
        workspaceStrategyOverride: workspaceOverrideSchema.optional(),
      })
      .parse(request.body ?? {});
    if (Object.prototype.hasOwnProperty.call(body, "workspaceStrategyOverride")) {
      await roleRuntimeRepository.update(params.runId, {
        workspaceStrategyOverride: body.workspaceStrategyOverride ?? null,
      });
    }
    const result = await dispatchRun(params.runId);

    if (!result) {
      reply.status(404);
      return {
        ok: false,
        error: {
          code: "not_found",
          message: `Run not found: ${params.runId}`,
        },
      };
    }

    if (!result.ok) {
      reply.status(409);
      return {
        ok: false,
        error: {
          code: result.code,
          message: result.message,
        },
      };
    }

    return {
      ok: true,
      data: result,
    };
  });

  app.post("/runs/:runId/retry", async (request, reply) => {
    const params = z.object({ runId: z.string().min(1) }).parse(request.params);
    const body = z
      .object({
        workspaceStrategyOverride: workspaceOverrideSchema.optional(),
      })
      .parse(request.body ?? {});
    const retryResult = await retryRun(params.runId, {
      ...(Object.prototype.hasOwnProperty.call(body, "workspaceStrategyOverride")
        ? { workspaceStrategyOverride: body.workspaceStrategyOverride ?? null }
        : {}),
    });

    if (!retryResult.ok) {
      reply.status(retryResult.code === "not_found" ? 404 : 409);
      return {
        ok: false,
        error: {
          code: retryResult.code,
          message: retryResult.message,
        },
      };
    }

    if (!retryResult.result.ok) {
      reply.status(409);
      return {
        ok: false,
        error: {
          code: retryResult.result.code,
          message: retryResult.result.message,
        },
      };
    }

    return {
      ok: true,
      data: retryResult.result,
    };
  });

  app.post("/runs/:runId/continue", async (request, reply) => {
    const params = z.object({ runId: z.string().min(1) }).parse(request.params);
    const continueResult = await continueRun(params.runId);

    if (!continueResult.ok) {
      reply.status(continueResult.code === "not_found" ? 404 : 409);
      return {
        ok: false,
        error: {
          code: continueResult.code,
          message: continueResult.message,
        },
      };
    }

    return {
      ok: true,
      data: { message: continueResult.message },
    };
  });

  app.get("/runs/:runId/stream", async (request, reply) => {
    const params = z.object({ runId: z.string().min(1) }).parse(request.params);
    const [runSummary, events] = await Promise.all([
      runSummaryStore.get(params.runId),
      executionEventRepository.listByRoleRuntimeId(params.runId),
    ]);

    if (!runSummary) {
      reply.status(404);
      return {
        ok: false,
        error: {
          code: "not_found",
          message: `Run not found: ${params.runId}`,
        },
      };
    }

    reply.header("content-type", "text/event-stream; charset=utf-8");
    reply.header("cache-control", "no-cache");
    reply.header("connection", "keep-alive");

    return [
      "event: run.snapshot",
      `data: ${JSON.stringify({ run: runSummary, events })}`,
      "",
    ].join("\n");
  });
}
