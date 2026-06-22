import type { FastifyInstance } from "fastify";

import {
  createManualSkill,
  deleteSkill,
  importSkillFromGithub,
  listAllSkills,
  listSkillsForAgent,
  refreshSkill,
  setAgentSkills,
  updateManualSkill,
} from "../services/skill-management-service";
import {
  discoverCodexSkills,
  invalidateCodexSkillsCache,
} from "../services/codex-skills/discover-codex-skills";

/**
 * Skill management routes. Single front-door for the skill system —
 * delegates filesystem + DB orchestration to skill-management-service.
 *
 * Endpoints:
 *   GET    /skills                   → list pool entries with attachments
 *   POST   /skills/import            → install from GitHub (npx skills add)
 *   POST   /skills                   → create manual skill (writes SKILL.md)
 *   PUT    /skills/:name             → edit manual skill content
 *   POST   /skills/:name/refresh     → re-pull from upstream (npx skills update)
 *   DELETE /skills/:name             → remove from pool + symlinks + DB
 *   GET    /agents/:roleId/skills    → list skills attached to one agent
 *   PUT    /agents/:roleId/skills    → set the full attachment set
 */

export async function registerSkillRoutes(app: FastifyInstance) {
  app.get("/skills", async () => {
    const items = await listAllSkills();
    return { ok: true, data: { items } };
  });

  // External skills — what each CLI runtime sees beyond the Magister
  // pool. Currently codex-only (it auto-loads from .system/ and
  // any installed superpowers meta-pack on top of the pool).
  // Read-only: the user can't edit/attach/detach these from Magister —
  // they're owned by the CLI's own installer. The Skills tab uses
  // this to surface the full picture of "what's loaded" in a
  // dedicated section below the editable pool list.
  app.get<{ Querystring: { refresh?: string } }>(
    "/skills/external",
    async (request) => {
      const refresh = request.query.refresh === "1" || request.query.refresh === "true";
      const codex = await discoverCodexSkills({ refresh });
      return {
        ok: true,
        data: {
          codex: {
            skills: codex.skills,
            countsBySource: codex.countsBySource,
            totalCount: codex.totalCount,
            method: codex.method,
            ...(codex.fallbackReason ? { fallbackReason: codex.fallbackReason } : {}),
            takenAt: codex.takenAt,
          },
        },
      };
    },
  );

  // Read a single skill including its full SKILL.md body. The list
  // endpoint deliberately omits `content` to keep payloads small —
  // for the Edit form (and any future deep view) callers fetch
  // the body explicitly via this endpoint.
  app.get("/skills/:name", async (request, reply) => {
    const { name } = request.params as { name: string };
    const items = await listAllSkills();
    const skill = items.find((s) => s.name === name);
    if (!skill) {
      return reply.status(404).send({
        ok: false,
        error: { code: "not_found", message: `Skill "${name}" is not in the pool.` },
      });
    }
    const { readSkillContent } = await import("../services/skill-pool-service");
    // Pass roleId="leader" for bundled skills so the Edit form
    // pre-fills with the EFFECTIVE body (override + bundled
    // fallback). Otherwise the textarea would show the bundled
    // default and silently overwrite the user's override on save.
    const content = await readSkillContent(
      name,
      skill.sourceKind === "builtin" ? "leader" : undefined,
    );
    if (content == null) {
      return reply.status(404).send({
        ok: false,
        error: { code: "missing_skill_md", message: `~/.agents/skills/${name}/SKILL.md is missing.` },
      });
    }
    // Strip the frontmatter from the returned body so the Edit
    // form can pre-fill the textarea with just the body. The
    // frontmatter is reconstructed on save from the description
    // field — keeping them as separate concerns avoids parsing
    // YAML on the client.
    const body = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n*/, "");
    return { ok: true, data: { ...skill, content: body } };
  });

  app.post("/skills/:name/reset", async (request, reply) => {
    const { name } = request.params as { name: string };
    try {
      const { resetBundledSkillOverride } = await import(
        "../services/skill-management-service"
      );
      await resetBundledSkillOverride("leader", name);
      return { ok: true };
    } catch (err) {
      return reply.status(400).send({
        ok: false,
        error: {
          code: "reset_failed",
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  });

  // Install a skill from a GitHub source string. Body shape:
  //   { source: "owner/repo" } or { source: "owner/repo@skill" }
  // The handler runs `npx skills add` synchronously; clients are
  // expected to show a spinner — installs typically finish in 5-30s.
  app.post("/skills/import", async (request, reply) => {
    const body = request.body as { source?: unknown } | null;
    const source = typeof body?.source === "string" ? body.source.trim() : "";
    if (!source) {
      return reply.status(400).send({
        ok: false,
        error: { code: "invalid_body", message: "Expected `source: string` in request body." },
      });
    }
    const result = await importSkillFromGithub(source);
    if (!result.ok) {
      return reply.status(422).send({
        ok: false,
        error: {
          code: "import_failed",
          message: result.cli.stderr.trim() || "Skill install failed.",
          stderr: result.cli.stderr,
          stdout: result.cli.stdout,
          exitCode: result.cli.exitCode,
          timedOut: result.cli.timedOut,
        },
      });
    }
    // Kimi review M4 — pool changed, codex's view changed too.
    invalidateCodexSkillsCache();
    return { ok: true, data: result };
  });

  // Create a brand-new manually-authored skill. The handler writes
  // ~/.agents/skills/<name>/SKILL.md with frontmatter (name +
  // description) followed by the body. No interaction with the
  // skill-lock file — manual skills aren't tracked there.
  app.post("/skills", async (request, reply) => {
    const body = request.body as { name?: unknown; description?: unknown; content?: unknown } | null;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const description = typeof body?.description === "string" ? body.description : "";
    const content = typeof body?.content === "string" ? body.content : "";
    try {
      const skill = await createManualSkill({ name, description, content });
      invalidateCodexSkillsCache();
      return { ok: true, data: skill };
    } catch (err) {
      return reply.status(400).send({
        ok: false,
        error: { code: "create_failed", message: err instanceof Error ? err.message : String(err) },
      });
    }
  });

  // Edit a manual skill's description and/or content. GitHub-sourced
  // skills are rejected — editing them locally would silently
  // diverge from upstream and break refresh.
  app.put("/skills/:name", async (request, reply) => {
    const { name } = request.params as { name: string };
    const body = request.body as { description?: unknown; content?: unknown } | null;
    const patch: { description?: string; content?: string } = {};
    if (typeof body?.description === "string") patch.description = body.description;
    if (typeof body?.content === "string") patch.content = body.content;
    if (Object.keys(patch).length === 0) {
      return reply.status(400).send({
        ok: false,
        error: { code: "invalid_body", message: "Expected `description` and/or `content` in request body." },
      });
    }
    try {
      const skill = await updateManualSkill(name, patch);
      invalidateCodexSkillsCache();
      return { ok: true, data: skill };
    } catch (err) {
      return reply.status(400).send({
        ok: false,
        error: { code: "update_failed", message: err instanceof Error ? err.message : String(err) },
      });
    }
  });

  // Re-pull a GitHub-sourced skill from upstream. Manual skills
  // get a clear error rather than a no-op success — the user
  // probably hit the wrong button.
  app.post("/skills/:name/refresh", async (request, reply) => {
    const { name } = request.params as { name: string };
    const result = await refreshSkill(name);
    if (!result.ok) {
      return reply.status(422).send({
        ok: false,
        error: {
          code: "refresh_failed",
          message: result.cli.stderr.trim() || "Skill refresh failed.",
          stderr: result.cli.stderr,
          stdout: result.cli.stdout,
          exitCode: result.cli.exitCode,
          timedOut: result.cli.timedOut,
        },
      });
    }
    invalidateCodexSkillsCache();
    return { ok: true, data: result };
  });

  // Universal delete — removes the pool entry, all CLI symlinks,
  // the leader DB attachment, and the skill-lock entry. Idempotent:
  // deleting a skill that's already gone is a no-op success.
  app.delete("/skills/:name", async (request, reply) => {
    const { name } = request.params as { name: string };
    try {
      const result = await deleteSkill(name);
      invalidateCodexSkillsCache();
      return { ok: true, data: result };
    } catch (err) {
      return reply.status(400).send({
        ok: false,
        error: { code: "delete_failed", message: err instanceof Error ? err.message : String(err) },
      });
    }
  });

  app.get("/agents/:roleId/skills", async (request) => {
    const { roleId } = request.params as { roleId: string };
    const items = await listSkillsForAgent(roleId);
    return { ok: true, data: { items } };
  });

  app.put("/agents/:roleId/skills", async (request, reply) => {
    const { roleId } = request.params as { roleId: string };

    // Accept both `skillNames` (the new shape) and `skillIds` (the
    // pre-pool legacy shape) so any in-flight clients keep working
    // through a build-and-restart. The DB-id form is treated as a
    // name since IDs in the new model just don't apply.
    const body = request.body as { skillNames?: unknown; skillIds?: unknown };
    const raw = Array.isArray(body.skillNames)
      ? body.skillNames
      : Array.isArray(body.skillIds)
        ? body.skillIds
        : null;
    if (!raw) {
      return reply.status(400).send({
        ok: false,
        error: { code: "invalid_body", message: "Expected `skillNames: string[]` in request body." },
      });
    }
    const names = [
      ...new Set(
        raw
          .filter((v): v is string => typeof v === "string")
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
      ),
    ];

    const result = await setAgentSkills(roleId, names);
    return { ok: true, data: result };
  });
}
