import { eq } from "@magister/db";

import {
  createDb,
  runtimeWorkspaces,
  type RuntimeWorkspaceInsert,
} from "@magister/db";

export class RuntimeWorkspaceRepository {
  async listAll() {
    const db = createDb();
    return db.query.runtimeWorkspaces.findMany();
  }

  async upsert(input: RuntimeWorkspaceInsert) {
    const db = createDb();
    await db
      .insert(runtimeWorkspaces)
      .values(input)
      .onConflictDoUpdate({
        target: runtimeWorkspaces.id,
        set: {
          runId: input.runId,
          taskId: input.taskId,
          workspaceId: input.workspaceId,
          roleId: input.roleId,
          requestedStrategy: input.requestedStrategy ?? null,
          strategy: input.strategy,
          decisionReason: input.decisionReason ?? null,
          fallbackReason: input.fallbackReason ?? null,
          status: input.status,
          baseWorkspaceDir: input.baseWorkspaceDir,
          workspaceDir: input.workspaceDir,
          baseRevision: input.baseRevision ?? null,
          metadataPath: input.metadataPath,
          createdAt: input.createdAt,
          updatedAt: input.updatedAt,
          finishedAt: input.finishedAt ?? null,
        },
      });
  }

  async getByRunId(runId: string) {
    const db = createDb();
    return db.query.runtimeWorkspaces.findFirst({
      where: eq(runtimeWorkspaces.runId, runId),
    });
  }
}
