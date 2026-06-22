import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { CommandApprovalRuleRepository } from "../repositories/command-approval-rule-repository";
import { validatePrefixRule } from "../services/safe-apply/command-rule-matcher";

/**
 * Persistent approval-rule management.
 *
 * Read-only listing + targeted mutations (revoke / re-enable /
 * delete). Rule CREATION goes through the bash approval flow's
 * "Approve + save rule" decision path; this surface does not
 * expose a direct POST that creates rules.
 */
export async function registerApprovalRuleRoutes(app: FastifyInstance) {
  const repo = new CommandApprovalRuleRepository();

  app.get("/approval-rules", async () => {
    const rules = await repo.listAll();
    return {
      ok: true,
      data: {
        items: rules.map((r) => ({
          id: r.id,
          tool: r.tool,
          patternKind: r.patternKind,
          patternJson: r.patternJson,
          patternPreview: previewPattern(r.patternKind, r.patternJson),
          scope: r.scope,
          projectPath: r.projectPath,
          approvedBy: r.approvedBy,
          approvedAt: r.approvedAt,
          expiresAt: r.expiresAt,
          enabled: r.enabled === 1,
          hitCount: r.hitCount,
          lastHitAt: r.lastHitAt,
          justificationTemplate: r.justificationTemplate,
        })),
      },
    };
  });

  app.post<{
    Params: { id: string };
    Body: { enabled?: boolean };
  }>("/approval-rules/:id", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = z.object({ enabled: z.boolean().optional() }).parse(request.body ?? {});
    const existing = await repo.getById(params.id);
    if (!existing) {
      reply.status(404);
      return { ok: false, error: { code: "not_found", message: `Rule ${params.id} not found` } };
    }
    if (typeof body.enabled === "boolean") {
      await repo.setEnabled(params.id, body.enabled);
    }
    const updated = await repo.getById(params.id);
    return { ok: true, data: updated };
  });

  app.delete<{ Params: { id: string } }>("/approval-rules/:id", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const existing = await repo.getById(params.id);
    if (!existing) {
      reply.status(404);
      return { ok: false, error: { code: "not_found", message: `Rule ${params.id} not found` } };
    }
    await repo.delete(params.id);
    return { ok: true, data: { deleted: params.id } };
  });

  /**
   * Diagnostic helper — surface the banned-prefix list so Settings
   * UI can render rule-creation guidance without grepping plugin
   * internals. Read-only.
   */
  app.get("/approval-rules/validation/banned-prefixes", async () => {
    const samples = [
      ["python"],
      ["bash", "-c"],
      ["sudo"],
      ["rm"],
      ["curl"],
    ];
    const banned: Array<{ prefix: string[]; reason: string }> = [];
    for (const sample of samples) {
      const error = validatePrefixRule(sample);
      if (error) banned.push({ prefix: sample, reason: error });
    }
    return { ok: true, data: { samples: banned } };
  });
}

function previewPattern(kind: string, patternJson: string): string {
  try {
    const parsed = JSON.parse(patternJson) as unknown;
    if (kind === "argv_prefix" && Array.isArray(parsed)) {
      return (parsed as string[]).join(" ");
    }
    if (typeof parsed === "string") return parsed;
    return patternJson;
  } catch {
    return patternJson;
  }
}
