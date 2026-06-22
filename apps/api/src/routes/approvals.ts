import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  getApproval as getStoredApproval,
  listApprovals,
  resolveApproval as resolveStoredApproval,
} from "../services/approval-service";
import {
  addApprovalTrust,
  getPendingApprovals,
  resolveApproval as resolveCommandApproval,
  type ApprovalRecord,
} from "../services/command-approval-service";
import { CommandApprovalRuleRepository } from "../repositories/command-approval-rule-repository";
import { validatePrefixRule } from "../services/safe-apply/command-rule-matcher";

const approvalActionSchema = z.object({
  actorId: z.string().min(1).optional(),
  source: z.enum(["web", "feishu", "cli"]),
  comment: z.string().min(1).optional(),
});

const resolveCommandApprovalSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  // When the approval carries an `escalation.proposed_prefix_rule` and
  // the user clicks "Approve + save rule", set this to true. The route
  // persists a row in `command_approval_rules` alongside the approval
  // resolution so future matching commands auto-pass without prompting.
  save_rule: z.boolean().optional(),
  // Task-scoped trust checkboxes on the approval card. When checked,
  // subsequent approvals for the same (toolKind, subjectKey) auto-pass
  // for the rest of the task / the next N minutes. Trust ledger is
  // process-memory in command-approval-service, cleared on task terminal.
  trust_for_task: z.boolean().optional(),
  trust_for_minutes: z.number().int().min(1).max(1440).optional(),
});

export async function registerApprovalRoutes(app: FastifyInstance) {
  app.get("/approvals", async () => {
    const items = await listApprovals();
    return {
      ok: true,
      data: {
        items,
      },
    };
  });

  app.get("/approvals/pending", async () => {
    return {
      ok: true,
      data: {
        items: await getPendingApprovals(),
      },
    };
  });

  app.post("/approvals/:id/resolve", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = resolveCommandApprovalSchema.parse(request.body);
    const outcome = await resolveCommandApproval(params.id, body.decision);
    const record = outcome?.record ?? null;

    if (!record) {
      reply.status(404);
      return {
        ok: false,
        error: {
          code: "not_found",
          message: `Approval not found: ${params.id}`,
        },
      };
    }

    // Spec §1 — if the approval was an escalation request with a
    // proposed_prefix_rule AND the user opted to save it, persist
    // a command_approval_rules row so future matching commands
    // auto-pass without prompting. Best-effort: failure to persist
    // the rule does NOT roll back the approval (the user already
    // approved this one execution; missing the rule just means
    // they'll get prompted again next time).
    //
    // Return the rule-save result in the response so the UI can show
    // a toast when persist was refused (e.g. prefix on banned list).
    let ruleSaved: "persisted" | "skipped" | "failed" = "skipped";
    let ruleSaveError: string | null = null;
    if (body.decision === "approved" && body.save_rule === true) {
      try {
        await persistRuleFromApproval(record);
        ruleSaved = "persisted";
      } catch (err) {
        ruleSaved = "failed";
        ruleSaveError = err instanceof Error ? err.message : String(err);
        request.log.warn(
          `[approval-rules] persist failed for approval ${params.id}: ${ruleSaveError}`,
        );
      }
    }

    // Task-scoped trust upgrade. If approved AND user checked "trust
    // this server for this task" or "trust 5min", add a trust-ledger
    // entry. Gated on outcome.landed === true (replay must not
    // double-write). Split into two entries when both dangerous-command
    // pattern AND additional_permissions apply (independent revocation).
    let trustApplied: "task" | "minutes" | null = null;
    if (
      outcome
      && outcome.landed
      && body.decision === "approved"
      && (body.trust_for_task || body.trust_for_minutes)
    ) {
      try {
        const payload = record.toolArgs && typeof record.toolArgs === "object"
          ? (record.toolArgs as Record<string, unknown>)
          : {};
        const subjectKey = typeof payload.server === "string" && payload.server.length > 0
          ? payload.server
          : "*";
        const toolKind = (record.toolName === "mcp_tool" || record.toolName === "bash")
          ? record.toolName
          : "bash";
        const durationMs = body.trust_for_task ? null : (body.trust_for_minutes! * 60_000);

        // v4.3 split — read sandbox-elevation metadata from approval payload
        const escalation = payload.escalation && typeof payload.escalation === "object"
          ? (payload.escalation as Record<string, unknown>)
          : null;
        const requestKind = typeof escalation?.request_kind === "string"
          ? escalation.request_kind
          : null;
        type AdditionalPermissions = {
          network?: { enabled?: boolean };
          file_system?: { entries: Array<{ path: string; access: "read" | "write" }> };
        };
        const additionalPermissions = escalation?.additional_permissions as
          | AdditionalPermissions
          | undefined;
        const dangerousPattern = typeof payload.dangerous_command === "object"
          && payload.dangerous_command
          && typeof (payload.dangerous_command as Record<string, unknown>).pattern === "string"
          ? (payload.dangerous_command as { pattern: string }).pattern
          : undefined;

        // Sandbox-elevation v4.3 §4.5 — SPLIT-entry trust (codex
        // Slice-3 review BLOCKER Q2). Pattern-only entries use
        // subjectKey="*" (broad bash trust — matches wildcard lookup
        // for v3 dangerous-command gate). Permission entries use
        // subjectKey="paths:*" and carry additionalPermissions; the
        // bash dispatcher uses `findCoveringPermissionGrant` for
        // SUBSET-AWARE lookup. The two entries are independent: a
        // narrow path grant CANNOT suppress unrelated dangerous-
        // command approvals (the BLOCKER from the prior revert).
        if (requestKind === "sensitive_read") {
          // Sensitive internal path reads are single-use approvals only.
          // Even if an older client sends trust_for_task/save-ish flags,
          // do not seed broad bash trust from a secret-read card.
        } else if (additionalPermissions && dangerousPattern) {
          addApprovalTrust(record.taskId, toolKind, "*", durationMs, {
            dangerousCommandPattern: dangerousPattern,
          });
          addApprovalTrust(record.taskId, toolKind, "paths:*", durationMs, { additionalPermissions });
        } else if (additionalPermissions) {
          // Permission-only grant (e.g. from request_permissions) —
          // ONLY writes the paths entry, NOT the wildcard entry. This
          // prevents the path grant from suppressing later
          // require_escalated approvals.
          addApprovalTrust(record.taskId, toolKind, "paths:*", durationMs, { additionalPermissions });
        } else if (dangerousPattern) {
          // Pure dangerous-command trust (v3 path) — broad wildcard.
          addApprovalTrust(record.taskId, toolKind, subjectKey, durationMs, {
            dangerousCommandPattern: dangerousPattern,
          });
        } else {
          // Legacy/MCP path — broad subject-key entry without extras.
          addApprovalTrust(record.taskId, toolKind, subjectKey, durationMs);
        }
        if (requestKind !== "sensitive_read") {
          trustApplied = body.trust_for_task ? "task" : "minutes";
        }
      } catch (err) {
        request.log.warn(
          `[approval-trust] add failed for approval ${params.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Sandbox-elevation v4.3 §4.5 (codex Q2) — surface dual-channel
    // conflict so the UI can show a yellow toast rather than silently
    // hiding the card.
    return {
      ok: true,
      data: {
        ...record,
        ruleSave: {
          status: ruleSaved,
          ...(ruleSaveError ? { error: ruleSaveError } : {}),
        },
        ...(trustApplied ? { trustApplied } : {}),
        ...(outcome?.conflict
          ? { conflict: true, storedOutcome: outcome.storedOutcome }
          : {}),
      },
    };
  });

  app.get("/approvals/:approvalId", async (request, reply) => {
    const params = z
      .object({ approvalId: z.string().min(1) })
      .parse(request.params);
    const approval = await getStoredApproval(params.approvalId);

    if (!approval) {
      reply.status(404);
      return {
        ok: false,
        error: {
          code: "not_found",
          message: `Approval not found: ${params.approvalId}`,
        },
      };
    }

    return {
      ok: true,
      data: approval,
    };
  });

  app.post("/approvals/:approvalId/approve", async (request, reply) => {
    const params = z
      .object({ approvalId: z.string().min(1) })
      .parse(request.params);
    const body = approvalActionSchema.parse(request.body);
    const approval = await resolveStoredApproval({
      approvalId: params.approvalId,
      resolution: "approved",
      source: body.source,
      ...(body.actorId ? { actorId: body.actorId } : {}),
      ...(body.comment ? { comment: body.comment } : {}),
    });

    if (!approval) {
      reply.status(404);
      return {
        ok: false,
        error: {
          code: "not_found",
          message: `Approval not found: ${params.approvalId}`,
        },
      };
    }

    return {
      ok: true,
      data: approval,
    };
  });

  app.post("/approvals/:approvalId/reject", async (request, reply) => {
    const params = z
      .object({ approvalId: z.string().min(1) })
      .parse(request.params);
    const body = approvalActionSchema.parse(request.body);
    const approval = await resolveStoredApproval({
      approvalId: params.approvalId,
      resolution: "rejected",
      source: body.source,
      ...(body.actorId ? { actorId: body.actorId } : {}),
      ...(body.comment ? { comment: body.comment } : {}),
    });

    if (!approval) {
      reply.status(404);
      return {
        ok: false,
        error: {
          code: "not_found",
          message: `Approval not found: ${params.approvalId}`,
        },
      };
    }

    // M5 Phase 3 — fire failure-driven reflection so the memory
    // extractor can decide whether to record a feedback entry about
    // why this approval was rejected (e.g. "leader keeps trying to
    // run X — block at planning step instead"). Fire-and-forget,
    // dynamic import keeps the route file independent of the
    // memory module's init state.
    try {
      const taskId = (approval as { taskId?: string }).taskId;
      if (typeof taskId === "string" && taskId.length > 0) {
        const { fireFailureReflection } = await import(
          "../services/memory/memory-failure-reflection"
        );
        const detail = [
          `command preview: ${(approval as { commandPreview?: string }).commandPreview ?? "(none)"}`,
          body.comment ? `operator note: ${body.comment}` : "",
        ]
          .filter((line) => line.length > 0)
          .join("\n");
        fireFailureReflection({
          kind: "approval_rejected",
          taskId,
          summary: `Approval rejected by ${body.source}${body.actorId ? ` (${body.actorId})` : ""}`,
          ...(detail ? { detail } : {}),
        });
      }
    } catch {
      // Reflection is best-effort.
    }

    return {
      ok: true,
      data: approval,
    };
  });
}

/**
 * Turn the user's "Approve + save rule" click into a durable
 * `command_approval_rules` row. Reads the proposed prefix_rule + scope
 * + justification template off the approval's payload metadata (which
 * the bash tool wrote when emitting the escalation request).
 * Re-validates the prefix server-side so a compromised client can't
 * slip in a banned overly-broad prefix.
 */
async function persistRuleFromApproval(record: ApprovalRecord): Promise<void> {
  const args = record.toolArgs as Record<string, unknown> | undefined;
  const escalation = args?.escalation as Record<string, unknown> | undefined;
  if (!escalation) {
    throw new Error("approval has no escalation metadata; nothing to persist");
  }
  const proposedPrefix = escalation.proposed_prefix_rule;
  if (!Array.isArray(proposedPrefix)) {
    throw new Error("approval has no proposed_prefix_rule; nothing to persist");
  }
  // Reject the whole array if ANY element is not a non-empty string.
  // Silently filtering non-string elements could produce a broader
  // rule than the user-facing proposal; hard reject instead.
  for (const token of proposedPrefix) {
    if (typeof token !== "string" || token.length === 0) {
      throw new Error(
        `proposed_prefix_rule contains non-string or empty token; refusing to persist`,
      );
    }
  }
  const prefix = proposedPrefix as string[];
  const validationError = validatePrefixRule(prefix);
  if (validationError) {
    throw new Error(`server-side validation: ${validationError}`);
  }

  const scope = (escalation.proposed_scope as string) ?? "project";
  if (scope !== "global" && scope !== "project" && scope !== "session") {
    throw new Error(`invalid scope: ${scope}`);
  }
  const projectPath = scope === "project"
    ? (typeof escalation.project_path === "string" ? escalation.project_path : null)
    : null;
  if (scope === "project" && !projectPath) {
    throw new Error("project-scope rule requires escalation.project_path");
  }

  const justificationTemplate = typeof escalation.justification === "string"
    ? escalation.justification.slice(0, 500)
    : null;

  // Sandbox-elevation v4.3 §4.9 — persist the AdditionalPermissionProfile
  // alongside the prefix rule when present. App-layer size check
  // (8 KiB, matching the DB CHECK constraint) is enforced here so a
  // bad caller gets a clear error rather than a SQLITE_CONSTRAINT.
  const additionalPermissions = escalation.additional_permissions;
  let additionalPermissionsJson: string | null = null;
  if (additionalPermissions !== undefined && additionalPermissions !== null) {
    const serialized = JSON.stringify(additionalPermissions);
    if (serialized.length > 8192) {
      throw new Error(`additional_permissions JSON exceeds 8KiB cap (${serialized.length} bytes); refusing to persist`);
    }
    additionalPermissionsJson = serialized;
  }

  await new CommandApprovalRuleRepository().create({
    id: `rule_${crypto.randomUUID()}`,
    tool: "bash",
    patternKind: "argv_prefix",
    patternJson: JSON.stringify(prefix),
    scope,
    projectPath,
    approvedBy: record.resolvedBy ?? "user",
    approvedAt: new Date(),
    enabled: 1,
    ...(justificationTemplate ? { justificationTemplate } : {}),
    ...(additionalPermissionsJson ? { additionalPermissionsJson } : {}),
  });
}
