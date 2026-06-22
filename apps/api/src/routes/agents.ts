import type { FastifyInstance } from "fastify";
import { createDb, agentProfiles } from "@magister/db";
import { eq } from "@magister/db";

export async function registerAgentRoutes(app: FastifyInstance) {
  const db = createDb();

  app.get("/agents", async () => {
    const items = await db.query.agentProfiles.findMany();
    // Seed defaults if empty
    if (items.length === 0) {
      const defaults = [
        { roleId: "leader", displayName: "Leader", avatarEmoji: "\u{1F916}", description: "Orchestrates tasks and delegates to teammates" },
        { roleId: "coder", displayName: "Coder", avatarEmoji: "\u{1F4BB}", description: "Implements code changes, runs tests" },
        { roleId: "reviewer", displayName: "Reviewer", avatarEmoji: "\u{1F4DD}", description: "Reviews code for bugs and quality" },
        { roleId: "architect", displayName: "Architect", avatarEmoji: "\u{1F3D7}", description: "Analyzes codebase, proposes designs" },
        { roleId: "lander", displayName: "Lander", avatarEmoji: "\u{1F680}", description: "Creates commits, branches, PRs" },
      ];
      const now = new Date();
      for (const d of defaults) {
        await db.insert(agentProfiles).values({ ...d, createdAt: now, updatedAt: now }).onConflictDoNothing();
      }
      const seeded = await db.query.agentProfiles.findMany();
      return { ok: true, data: { items: seeded } };
    }
    return { ok: true, data: { items } };
  });

  app.put("/agents/:roleId", async (request) => {
    const { roleId } = request.params as { roleId: string };
    const body = request.body as Record<string, unknown>;
    await db.update(agentProfiles).set({
      ...(typeof body.displayName === "string" ? { displayName: body.displayName } : {}),
      ...(typeof body.description === "string" ? { description: body.description } : {}),
      ...(typeof body.avatarEmoji === "string" ? { avatarEmoji: body.avatarEmoji } : {}),
      ...(typeof body.modelOverride === "string" ? { modelOverride: body.modelOverride } : {}),
      ...(typeof body.maxTurns === "number" ? { maxTurns: body.maxTurns } : {}),
      ...(typeof body.systemPromptOverride === "string" ? { systemPromptOverride: body.systemPromptOverride } : {}),
      updatedAt: new Date(),
    }).where(eq(agentProfiles.roleId, roleId));
    return { ok: true };
  });
}
