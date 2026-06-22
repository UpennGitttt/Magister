import { afterEach, beforeEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";

import { registerMemoryRoutes } from "../../src/routes/memory";
import { upsertMemory } from "../../src/services/memory/memory-fs-service";
import {
  initMemoryRuntime,
  resetMemoryRuntimeForTests,
} from "../../src/services/memory/memory-runtime";
import { flushIndexRebuild } from "../../src/services/memory/memory-index-service";

let app: FastifyInstance;
let userDir: string;
let projectDir: string;

beforeEach(async () => {
  userDir = await fs.mkdtemp(join(tmpdir(), "magister-mem-route-user-"));
  projectDir = await fs.mkdtemp(join(tmpdir(), "magister-mem-route-proj-"));
  initMemoryRuntime({ userScopeRoot: userDir, projectScopeRoot: projectDir });

  app = Fastify();
  await app.register(registerMemoryRoutes);
  await app.ready();

  await upsertMemory({
    path: "user-global/user/role",
    description: "Senior engineer",
    body: "Body A",
  }, "leader-tool");
  await upsertMemory({
    path: "project/feedback/testing",
    description: "Use real DB",
    body: "Body B",
  }, "leader-tool");
  await flushIndexRebuild();
});

afterEach(async () => {
  await app.close();
  resetMemoryRuntimeForTests();
  await fs.rm(userDir, { recursive: true, force: true });
  await fs.rm(projectDir, { recursive: true, force: true });
});

test("GET /memory/list returns entries grouped by scope", async () => {
  const res = await app.inject({ method: "GET", url: "/memory/list" });
  expect(res.statusCode).toBe(200);
  const body = res.json() as {
    ok: boolean;
    data: {
      "user-global": Array<{ path: string }>;
      project: Array<{ path: string }>;
    };
  };
  expect(body.ok).toBe(true);
  expect(body.data["user-global"]).toHaveLength(1);
  expect(body.data.project).toHaveLength(1);
  expect(body.data["user-global"][0]?.path).toBe("user-global/user/role");
});

test("GET /memory/entry/* returns single entry", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/memory/entry/user-global/user/role",
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as {
    data: {
      frontmatter: { name: string };
      body: string;
    };
  };
  expect(body.data.frontmatter.name).toBe("role");
  expect(body.data.body.trim()).toBe("Body A");
});

test("GET /memory/entry/* returns 404 when missing", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/memory/entry/user-global/user/nope",
  });
  expect(res.statusCode).toBe(404);
  const body = res.json() as { ok: boolean; error: { code: string } };
  expect(body.ok).toBe(false);
  expect(body.error.code).toBe("not_found");
});

test("GET /memory/entry/* returns 400 on bad path (typed error)", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/memory/entry/garbage/path/here/extra",
  });
  expect(res.statusCode).toBe(400);
});

test("DELETE /memory/entry/* removes the entry", async () => {
  const res = await app.inject({
    method: "DELETE",
    url: "/memory/entry/user-global/user/role",
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { data: { deleted: boolean } };
  expect(body.data.deleted).toBe(true);

  const followup = await app.inject({
    method: "GET",
    url: "/memory/entry/user-global/user/role",
  });
  expect(followup.statusCode).toBe(404);
});

test("DELETE /memory/entry/* is idempotent (200 even when absent)", async () => {
  await app.inject({
    method: "DELETE",
    url: "/memory/entry/user-global/user/role",
  });
  const res = await app.inject({
    method: "DELETE",
    url: "/memory/entry/user-global/user/role",
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { data: { deleted: boolean } };
  expect(body.data.deleted).toBe(false);
});

test("DELETE /memory/entry/* returns 400 on bad path", async () => {
  const res = await app.inject({
    method: "DELETE",
    url: "/memory/entry/x",
  });
  expect(res.statusCode).toBe(400);
});

test("PUT /memory/cheatsheet/:scope creates a cheatsheet", async () => {
  const res = await app.inject({
    method: "PUT",
    url: "/memory/cheatsheet/user-global",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({
      description: "Personal cheatsheet",
      body: "## TIL\n- foo",
    }),
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { data: { created: boolean; path: string } };
  expect(body.data.created).toBe(true);
  expect(body.data.path).toBe("user-global/cheatsheet");

  const view = await app.inject({
    method: "GET",
    url: "/memory/entry/user-global/cheatsheet",
  });
  expect(view.statusCode).toBe(200);
  expect((view.json() as { data: { body: string } }).data.body).toContain("- foo");
});

test("PUT /memory/cheatsheet/:scope idempotently replaces", async () => {
  await app.inject({
    method: "PUT",
    url: "/memory/cheatsheet/project",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ description: "v1", body: "old" }),
  });
  const res = await app.inject({
    method: "PUT",
    url: "/memory/cheatsheet/project",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ description: "v2", body: "new" }),
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { data: { created: boolean } };
  expect(body.data.created).toBe(false);
});

test("PUT /memory/cheatsheet/:scope rejects invalid scope (400)", async () => {
  const res = await app.inject({
    method: "PUT",
    url: "/memory/cheatsheet/bogus",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ description: "x", body: "y" }),
  });
  expect(res.statusCode).toBe(400);
});

test("PUT /memory/cheatsheet/:scope rejects empty description (400)", async () => {
  const res = await app.inject({
    method: "PUT",
    url: "/memory/cheatsheet/user-global",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ description: "  ", body: "y" }),
  });
  expect(res.statusCode).toBe(400);
});

test("PUT /memory/cheatsheet/:scope succeeds when expectedLastAccessedAt matches", async () => {
  await app.inject({
    method: "PUT",
    url: "/memory/cheatsheet/user-global",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ description: "v1", body: "old" }),
  });
  const view = await app.inject({
    method: "GET",
    url: "/memory/entry/user-global/cheatsheet",
  });
  const lastAccessedAt = (view.json() as {
    data: { frontmatter: { lastAccessedAt: string } };
  }).data.frontmatter.lastAccessedAt;

  const res = await app.inject({
    method: "PUT",
    url: "/memory/cheatsheet/user-global",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({
      description: "v2",
      body: "new",
      expectedLastAccessedAt: lastAccessedAt,
    }),
  });
  expect(res.statusCode).toBe(200);
});

test("PUT /memory/cheatsheet/:scope returns 409 on stale expectedLastAccessedAt", async () => {
  await app.inject({
    method: "PUT",
    url: "/memory/cheatsheet/user-global",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ description: "v1", body: "old" }),
  });

  const res = await app.inject({
    method: "PUT",
    url: "/memory/cheatsheet/user-global",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({
      description: "v2",
      body: "new",
      expectedLastAccessedAt: "2020-01-01T00:00:00.000Z",
    }),
  });
  expect(res.statusCode).toBe(409);
  const body = res.json() as { error: { code: string } };
  expect(body.error.code).toBe("conflict");
});
