import { and, desc, eq, or, sql } from "@magister/db";

import {
  commandApprovalRules,
  createDb,
  type CommandApprovalRuleInsert,
  type CommandApprovalRuleSelect,
} from "@magister/db";

/**
 * Persistent approval-rule store for the sandbox escalation protocol.
 * CRUD + lookup helpers used by:
 *   - `command-rule-matcher.ts` (match a candidate command against
 *     enabled rules before requesting user approval)
 *   - `command-approval-service.ts` (insert on user "Approve + save
 *     rule" decision)
 *   - `apps/api/src/routes/approval-rules.ts` (Settings UI: list +
 *     revoke + scope edit)
 */

export type CommandApprovalRule = CommandApprovalRuleSelect;

export class CommandApprovalRuleRepository {
  async create(input: CommandApprovalRuleInsert): Promise<void> {
    const db = createDb();
    await db.insert(commandApprovalRules).values(input);
  }

  async getById(id: string): Promise<CommandApprovalRule | undefined> {
    const db = createDb();
    return db.query.commandApprovalRules.findFirst({
      where: eq(commandApprovalRules.id, id),
    });
  }

  async listAll(): Promise<CommandApprovalRule[]> {
    const db = createDb();
    return db.query.commandApprovalRules.findMany({
      orderBy: [desc(commandApprovalRules.approvedAt)],
    });
  }

  /**
   * Fetch enabled, non-expired rules that could apply to a given
   * (tool, projectPath) — global scope always applies; project
   * scope only when projectPath matches the canonical cwd the rule
   * was approved for; session scope is intentionally NOT supported
   * by this repo (session rules live in-memory per leader runtime).
   */
  async listCandidatesForLookup(
    tool: string,
    projectPath: string | null,
  ): Promise<CommandApprovalRule[]> {
    const db = createDb();
    const now = Date.now();
    // Codex review #4 (2026-05-17): project-scope rules match ONLY
    // when the caller supplies a concrete projectPath AND it equals
    // the rule's `projectPath`. Pre-fix, a null-projectPath lookup
    // matched project-scope rows whose `projectPath` was also NULL
    // (a malformed row could behave as a global rule). Now project-
    // scope rules with NULL `projectPath` are simply unreachable
    // (the matcher returns no hit; the rule sits as a dead row that
    // Settings UI can surface for the user to clean up).
    const whereClause = projectPath != null
      ? and(
          eq(commandApprovalRules.tool, tool),
          eq(commandApprovalRules.enabled, 1),
          or(
            eq(commandApprovalRules.scope, "global"),
            and(
              eq(commandApprovalRules.scope, "project"),
              eq(commandApprovalRules.projectPath, projectPath),
            ),
          ),
        )
      : and(
          eq(commandApprovalRules.tool, tool),
          eq(commandApprovalRules.enabled, 1),
          eq(commandApprovalRules.scope, "global"),
        );
    const rows = await db.query.commandApprovalRules.findMany({ where: whereClause });
    // Filter out expired rules in-process (drizzle's where doesn't
    // play well with null-or-future comparisons here).
    return rows.filter((row) => row.expiresAt == null || row.expiresAt.getTime() > now);
  }

  /**
   * Atomically increment hit_count + stamp last_hit_at. Called from
   * the matcher when a rule fires so the Settings UI can show
   * usage stats and (V2) suggest TTL extension for proven rules.
   */
  async bumpHit(id: string): Promise<void> {
    const db = createDb();
    await db
      .update(commandApprovalRules)
      .set({
        hitCount: sql`${commandApprovalRules.hitCount} + 1`,
        lastHitAt: new Date(),
      })
      .where(eq(commandApprovalRules.id, id));
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const db = createDb();
    await db
      .update(commandApprovalRules)
      .set({ enabled: enabled ? 1 : 0 })
      .where(eq(commandApprovalRules.id, id));
  }

  async delete(id: string): Promise<void> {
    const db = createDb();
    await db.delete(commandApprovalRules).where(eq(commandApprovalRules.id, id));
  }
}
