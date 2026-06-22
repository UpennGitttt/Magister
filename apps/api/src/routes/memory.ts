import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  MemoryError,
  MemoryNotFoundError,
  mapMemoryErrorToHttpStatus,
} from "../services/memory/memory-errors";
import {
  deleteMemory,
  listMemory,
  upsertMemory,
  viewMemory,
} from "../services/memory/memory-fs-service";
import { parseMemoryFile } from "../services/memory/memory-frontmatter";
import { promises as fs } from "node:fs";
import { memoryLog } from "../services/memory/memory-log";
import type { MemoryEntry, MemoryScope } from "../services/memory/memory-types";

/**
 * Memory routes — read + delete only. Upserts happen exclusively
 * through the leader's `upsert_memory` tool (see PR-3) so the
 * provenance trail (who wrote, why, when) flows through the runtime
 * event log rather than a user-driven HTTP path.
 *
 * Routes:
 *   GET    /memory/list          → entries grouped by scope (no body)
 *   GET    /memory/entry/*       → single entry with frontmatter + body
 *   DELETE /memory/entry/*       → idempotent delete by path
 *
 * The `*` wildcard captures the canonical virtual path
 * `<scope>/<type>/<name>` (e.g. `user-global/user/role`). We use
 * the `/entry/` prefix to keep it disjoint from `/list` — Fastify's
 * radix tree would otherwise treat `list` as a wildcard match.
 */
export async function registerMemoryRoutes(app: FastifyInstance) {
  app.get("/memory/list", async (_request, reply) => {
    try {
      const listing = await listMemory();
      return {
        ok: true,
        data: {
          "user-global": listing["user-global"].map(serialize),
          project: listing.project.map(serialize),
        },
      };
    } catch (err) {
      return sendMemoryError(reply, "<list>", err);
    }
  });

  app.get<{ Params: { "*": string } }>(
    "/memory/entry/*",
    async (request, reply) => {
      const virtualPath = request.params["*"];
      try {
        const entry = await viewMemory(virtualPath);
        if (!entry) {
          return reply.status(404).send({
            ok: false,
            error: {
              code: "not_found",
              message: `Memory not found: ${virtualPath}`,
            },
          });
        }
        return {
          ok: true,
          data: {
            path: entry.path,
            frontmatter: entry.frontmatter,
            body: entry.body,
          },
        };
      } catch (err) {
        return sendMemoryError(reply, virtualPath, err);
      }
    },
  );

  app.delete<{ Params: { "*": string } }>(
    "/memory/entry/*",
    async (request, reply) => {
      const virtualPath = request.params["*"];
      try {
        const res = await deleteMemory(virtualPath, "user-rest");
        return { ok: true, data: res };
      } catch (err) {
        return sendMemoryError(reply, virtualPath, err);
      }
    },
  );

  // Cheatsheet write path — dedicated route, not generic /entry/*
  // upsert. Cheatsheets are user-curated by design (commands /
  // gotchas / TILs they want at hand every session); typed entries
  // and scratchpads stay behind the leader's upsert_memory tool so
  // their provenance flows through the runtime trace.
  const cheatsheetBodySchema = z.object({
    description: z.string().min(1).max(120),
    body: z.string(),
    // Optional optimistic-concurrency etag. When provided, the
    // server compares it against the on-disk frontmatter's
    // lastAccessedAt and rejects with 409 if they differ. UI passes
    // the value it received in the prior GET; if a leader
    // upsert_memory call landed in between, the user's stale save
    // is blocked instead of silently clobbering. (Codex final
    // review follow-up — decisions doc §117 single-writer mitigation.)
    expectedLastAccessedAt: z.string().optional(),
  });
  app.put<{
    Params: { scope: string };
  }>("/memory/cheatsheet/:scope", async (request, reply) => {
    const scope = request.params.scope as MemoryScope;
    if (scope !== "user-global" && scope !== "project") {
      return reply.status(400).send({
        ok: false,
        error: {
          code: "validation",
          message: `invalid cheatsheet scope: ${scope}`,
        },
      });
    }
    // Strict schema validation so non-string / oversized inputs
    // surface as a clean 400 instead of an internal 500.
    const parsed = cheatsheetBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        ok: false,
        error: {
          code: "validation",
          message: parsed.error.issues
            .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
            .join("; "),
        },
      });
    }
    const description = parsed.data.description.trim();
    const body = parsed.data.body;
    if (description.length === 0) {
      return reply.status(400).send({
        ok: false,
        error: {
          code: "validation",
          message: "description is required",
        },
      });
    }

    // Optimistic-concurrency check via lastAccessedAt etag. We read
    // the on-disk file directly (NOT viewMemory, which would bump
    // the timestamp and race with our own check) and compare. Hard
    // 409 on mismatch so the UI surfaces a reload prompt.
    if (parsed.data.expectedLastAccessedAt) {
      const currentLastAccessedAt = await readCurrentLastAccessedAt(
        `${scope}/cheatsheet.md`,
      );
      if (
        currentLastAccessedAt !== null &&
        currentLastAccessedAt !== parsed.data.expectedLastAccessedAt
      ) {
        return reply.status(409).send({
          ok: false,
          error: {
            code: "conflict",
            message:
              "cheatsheet was modified elsewhere; reload before saving",
            currentLastAccessedAt,
          },
        });
      }
    }

    try {
      const result = await upsertMemory(
        {
          path: `${scope}/cheatsheet.md`,
          description,
          body,
        },
        "user-rest",
      );
      memoryLog.info("cheatsheet-edit", { scope, bytes: Buffer.byteLength(body, "utf8") });
      return { ok: true, data: result };
    } catch (err) {
      return sendMemoryError(reply, `${scope}/cheatsheet`, err);
    }
  });
}

/**
 * Read the on-disk frontmatter's lastAccessedAt without going
 * through viewMemory (which would bump the timestamp). Returns
 * null when the file doesn't exist yet (creation path — no
 * conflict possible).
 */
async function readCurrentLastAccessedAt(
  virtualPath: string,
): Promise<string | null> {
  try {
    const { parseMemoryPath } = await import(
      "../services/memory/memory-path"
    );
    const { getMemoryRuntime } = await import(
      "../services/memory/memory-runtime"
    );
    const parsed = parseMemoryPath(virtualPath);
    if (parsed.kind !== "cheatsheet") return null;
    const rt = getMemoryRuntime();
    const path = `${rt.roots[parsed.scope]}/cheatsheet.md`;
    const raw = await fs.readFile(path, "utf8");
    const file = parseMemoryFile(raw);
    return file.frontmatter.lastAccessedAt;
  } catch {
    return null;
  }
}


function serialize(e: MemoryEntry) {
  return {
    path: e.path,
    scope: e.scope,
    type: e.type,
    name: e.name,
    description: e.frontmatter.description,
    createdAt: e.frontmatter.createdAt,
    lastAccessedAt: e.frontmatter.lastAccessedAt,
    agingFlag: e.frontmatter.agingFlag,
    codeChanged: e.frontmatter.codeChanged,
    gitAnchor: e.frontmatter.gitAnchor,
    supersededBy: e.frontmatter.supersededBy,
  };
}

function sendMemoryError(
  reply: import("fastify").FastifyReply,
  virtualPath: string,
  err: unknown,
) {
  if (err instanceof MemoryError) {
    const status = mapMemoryErrorToHttpStatus(err);
    memoryLog.warn("route-error", { path: virtualPath, tag: err.tag, status });
    return reply.status(status).send({
      ok: false,
      error: {
        code:
          err instanceof MemoryNotFoundError
            ? "not_found"
            : err.tag,
        message: err.message,
      },
    });
  }
  memoryLog.error("route-unexpected", err);
  return reply.status(500).send({
    ok: false,
    error: { code: "internal", message: "Internal Server Error" },
  });
}
