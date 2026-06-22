import { eq, inArray } from "@magister/db";

import { artifacts, createDb, type ArtifactInsert } from "@magister/db";

export class ArtifactRepository {
  async create(input: ArtifactInsert) {
    const db = createDb();
    await db.insert(artifacts).values(input);
  }

  async listAll() {
    const db = createDb();
    return db.query.artifacts.findMany();
  }

  async getById(id: string) {
    const db = createDb();
    return db.query.artifacts.findFirst({
      where: eq(artifacts.id, id),
    });
  }

  async listByTaskId(taskId: string) {
    const db = createDb();
    return db.query.artifacts.findMany({
      where: eq(artifacts.taskId, taskId),
    });
  }

  async listByRoleRuntimeId(roleRuntimeId: string) {
    const db = createDb();
    return db.query.artifacts.findMany({
      where: eq(artifacts.roleRuntimeId, roleRuntimeId),
    });
  }

  async deleteByIds(ids: string[]) {
    if (ids.length === 0) {
      return;
    }

    const db = createDb();
    await db.delete(artifacts).where(inArray(artifacts.id, ids));
  }
}
