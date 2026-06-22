import { promises as fs } from "node:fs";
import path from "node:path";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { WorkspaceRepository } from "../repositories/workspace-repository";

/**
 * `/workspaces` CRUD routes — exposes the per-machine workspace
 * registry. Workspace identity is the slug `id` (e.g. "default",
 * "myapp"); `base_path` is the directory the agent operates in.
 *
 * Path validation is intentionally light: we check that the path
 * exists and is a directory at create/update time. We do NOT check
 * for project markers (`.git`, `package.json`) — Magister should be
 * usable on bare directories too. We do NOT check for read/write
 * permissions — agent tools surface their own permission errors
 * with better context than a registry-time pre-flight could.
 */

// Slug regex: lowercase letters, digits, hyphens, underscores.
// Reserved words ("default" is allowed; it's the seed-default's id;
// "new", "edit" etc. would only collide if we ever wanted a
// `/workspaces/new` form route, which we don't).
const SLUG_RE = /^[a-z0-9_-]+$/;

const createSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(SLUG_RE, "id must be a-z, 0-9, -, _ only")
    .refine((s) => !s.startsWith("-") && !s.endsWith("-"), "id can't start/end with hyphen"),
  label: z.string().min(1).max(120),
  basePath: z.string().min(1),
  isDefault: z.boolean().optional(),
});

const updateSchema = z.object({
  label: z.string().min(1).max(120).optional(),
  basePath: z.string().min(1).optional(),
});

async function pathExistsAsDir(
  p: string,
): Promise<{ ok: true; canonical: string } | { ok: false; error: string }> {
  try {
    // Kimi review M5 — resolve symlinks before storing the path so
    // two registry rows can't both point at the same canonical
    // directory through different symlink chains. The canonical
    // path is what the agent will operate on; the user-typed path
    // can drift later (symlink replaced, etc.). Storing canonical
    // also closes the duplicate-via-symlink bypass of the
    // base_path UNIQUE constraint.
    const canonical = await fs.realpath(p);
    const stat = await fs.stat(canonical);
    if (!stat.isDirectory()) {
      return { ok: false, error: `path is not a directory: ${p}` };
    }
    return { ok: true, canonical };
  } catch (err) {
    return {
      ok: false,
      error: `path does not exist or is not readable: ${p} (${(err as Error).message})`,
    };
  }
}

export async function registerWorkspaceRegistryRoutes(app: FastifyInstance) {
  const repo = new WorkspaceRepository();

  app.get("/workspaces", async () => {
    const items = await repo.listAll();
    return { ok: true, data: { items } };
  });

  app.get<{ Params: { id: string } }>("/workspaces/:id", async (request, reply) => {
    const row = await repo.getById(request.params.id);
    if (!row) {
      reply.status(404);
      return { ok: false, error: { code: "not_found", message: "workspace not found" } };
    }
    return { ok: true, data: row };
  });

  app.post("/workspaces", async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { ok: false, error: { code: "validation_failed", message: parsed.error.message } };
    }
    const input = parsed.data;
    const absolutePath = path.resolve(input.basePath);
    const pathCheck = await pathExistsAsDir(absolutePath);
    if (!pathCheck.ok) {
      reply.status(400);
      return { ok: false, error: { code: "invalid_path", message: pathCheck.error } };
    }
    const canonicalPath = pathCheck.canonical;
    const existingById = await repo.getById(input.id);
    if (existingById) {
      reply.status(409);
      return { ok: false, error: { code: "id_conflict", message: `workspace id already exists: ${input.id}` } };
    }
    const existingByPath = await repo.findByBasePath(canonicalPath);
    if (existingByPath) {
      reply.status(409);
      return {
        ok: false,
        error: {
          code: "path_conflict",
          message: `another workspace already uses this path: ${existingByPath.id}`,
        },
      };
    }
    const created = await repo.create({
      id: input.id,
      label: input.label,
      basePath: canonicalPath,
      isDefault: input.isDefault === true,
    });
    reply.status(201);
    return { ok: true, data: created };
  });

  app.put<{ Params: { id: string } }>("/workspaces/:id", async (request, reply) => {
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { ok: false, error: { code: "validation_failed", message: parsed.error.message } };
    }
    const existing = await repo.getById(request.params.id);
    if (!existing) {
      reply.status(404);
      return { ok: false, error: { code: "not_found", message: "workspace not found" } };
    }
    if (parsed.data.basePath !== undefined) {
      const absolutePath = path.resolve(parsed.data.basePath);
      const pathCheck = await pathExistsAsDir(absolutePath);
      if (!pathCheck.ok) {
        reply.status(400);
        return { ok: false, error: { code: "invalid_path", message: pathCheck.error } };
      }
      const canonicalPath = pathCheck.canonical;
      const conflict = await repo.findByBasePath(canonicalPath);
      if (conflict && conflict.id !== existing.id) {
        reply.status(409);
        return {
          ok: false,
          error: { code: "path_conflict", message: `another workspace uses this path: ${conflict.id}` },
        };
      }
      const patch: { label?: string; basePath?: string } = { basePath: canonicalPath };
      if (parsed.data.label !== undefined) patch.label = parsed.data.label;
      const updated = await repo.update(existing.id, patch);
      return { ok: true, data: updated };
    }
    const patch: { label?: string; basePath?: string } = {};
    if (parsed.data.label !== undefined) patch.label = parsed.data.label;
    if (parsed.data.basePath !== undefined) patch.basePath = parsed.data.basePath;
    const updated = await repo.update(existing.id, patch);
    return { ok: true, data: updated };
  });

  app.post<{ Params: { id: string } }>(
    "/workspaces/:id/set-default",
    async (request, reply) => {
      try {
        const updated = await repo.setDefault(request.params.id);
        return { ok: true, data: updated };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("not found")) {
          reply.status(404);
          return { ok: false, error: { code: "not_found", message } };
        }
        reply.status(500);
        return { ok: false, error: { code: "set_default_failed", message } };
      }
    },
  );

  app.delete<{ Params: { id: string } }>("/workspaces/:id", async (request, reply) => {
    const result = await repo.deleteById(request.params.id);
    if (!result.ok) {
      const map: Record<string, number> = {
        not_found: 404,
        is_default: 409,
        last_workspace: 409,
      };
      reply.status(map[result.reason] ?? 400);
      return { ok: false, error: { code: result.reason, message: refusalMessage(result.reason) } };
    }
    return { ok: true, data: { deleted: true } };
  });
}

function refusalMessage(reason: string): string {
  switch (reason) {
    case "not_found":
      return "workspace not found";
    case "is_default":
      return "cannot delete the default workspace — set another workspace as default first";
    case "last_workspace":
      return "cannot delete the last remaining workspace";
    default:
      return reason;
  }
}
