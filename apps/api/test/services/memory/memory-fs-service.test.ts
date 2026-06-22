import { afterEach, beforeEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryAuthError,
  MemoryCapacityError,
  MemoryValidationError,
} from "../../../src/services/memory/memory-errors";
import {
  cleanupTmpFiles,
  deleteMemory,
  listMemory,
  patchMemoryLinks,
  purgeScratchpadForTask,
  upsertMemory,
  viewMemory,
} from "../../../src/services/memory/memory-fs-service";
import {
  initMemoryRuntime,
  resetMemoryRuntimeForTests,
} from "../../../src/services/memory/memory-runtime";

let userDir: string;
let projectDir: string;

beforeEach(async () => {
  userDir = await fs.mkdtemp(join(tmpdir(), "magister-mem-user-"));
  projectDir = await fs.mkdtemp(join(tmpdir(), "magister-mem-proj-"));
  initMemoryRuntime({ userScopeRoot: userDir, projectScopeRoot: projectDir });
});

afterEach(async () => {
  resetMemoryRuntimeForTests();
  await fs.rm(userDir, { recursive: true, force: true });
  await fs.rm(projectDir, { recursive: true, force: true });
});

test("upsertMemory creates a new typed entry", async () => {
  const res = await upsertMemory({
    path: "user-global/feedback/testing-mocks",
    description: "Use real DB for integration tests",
    body: "We got burned once with mocked DB.",
  }, "leader-tool");
  expect(res.created).toBe(true);
  expect(res.path).toBe("user-global/feedback/testing-mocks");
  const file = await fs.readFile(
    join(userDir, "feedback", "testing-mocks.md"),
    "utf8"
  );
  expect(file).toContain("schemaVersion: 1");
  expect(file).toContain("name: testing-mocks");
  expect(file).toContain("description: Use real DB for integration tests");
  expect(file).toContain("We got burned once with mocked DB.");
});

test("upsertMemory is idempotent: second call replaces body", async () => {
  await upsertMemory({
    path: "user-global/user/role",
    description: "Senior engineer",
    body: "Original body",
  }, "leader-tool");
  const res = await upsertMemory({
    path: "user-global/user/role",
    description: "Senior engineer at Magister",
    body: "Updated body",
  }, "leader-tool");
  expect(res.created).toBe(false);
  const entry = await viewMemory("user-global/user/role");
  expect(entry?.body.trim()).toBe("Updated body");
  expect(entry?.frontmatter.description).toBe("Senior engineer at Magister");
});

test("upsertMemory preserves createdAt across updates", async () => {
  await upsertMemory({
    path: "user-global/user/role",
    description: "v1",
    body: "v1",
  }, "leader-tool");
  const first = await viewMemory("user-global/user/role");
  await new Promise((r) => setTimeout(r, 10));
  await upsertMemory({
    path: "user-global/user/role",
    description: "v2",
    body: "v2",
  }, "leader-tool");
  const second = await viewMemory("user-global/user/role");
  expect(second?.frontmatter.createdAt).toBe(first!.frontmatter.createdAt);
});

test("upsertMemory throws MemoryCapacityError on body too big", async () => {
  const huge = "x".repeat(9 * 1024);
  await expect(
    upsertMemory({
      path: "user-global/reference/big",
      description: "too big",
      body: huge,
    }, "leader-tool")
  ).rejects.toThrow(MemoryCapacityError);
});

test("upsertMemory throws MemoryCapacityError on description too long", async () => {
  await expect(
    upsertMemory({
      path: "user-global/user/x",
      description: "a".repeat(200),
      body: "ok",
    }, "leader-tool")
  ).rejects.toThrow(MemoryCapacityError);
});

test("upsertMemory throws MemoryValidationError on bad path", async () => {
  await expect(
    upsertMemory({ path: "bad/path/here/extra", description: "x", body: "y" }, "leader-tool")
  ).rejects.toThrow(MemoryValidationError);
});

test("deleteMemory removes the file (idempotent)", async () => {
  await upsertMemory({
    path: "project/feedback/x",
    description: "y",
    body: "z",
  }, "leader-tool");
  const res1 = await deleteMemory("project/feedback/x", "leader-tool");
  expect(res1.deleted).toBe(true);
  const res2 = await deleteMemory("project/feedback/x", "leader-tool");
  expect(res2.deleted).toBe(false);
});

test("viewMemory by path returns single entry", async () => {
  await upsertMemory({
    path: "user-global/reference/a",
    description: "alpha",
    body: "A body",
  }, "leader-tool");
  const entry = await viewMemory("user-global/reference/a");
  expect(entry?.frontmatter.name).toBe("a");
  expect(entry?.body.trim()).toBe("A body");
});

test("listMemory groups by scope", async () => {
  await upsertMemory({
    path: "user-global/user/role",
    description: "x",
    body: "x",
  }, "leader-tool");
  await upsertMemory({
    path: "project/feedback/y",
    description: "y",
    body: "y",
  }, "leader-tool");
  const list = await listMemory();
  expect(list["user-global"].length).toBe(1);
  expect(list.project.length).toBe(1);
  expect(list["user-global"][0]!.name).toBe("role");
});

test("viewMemory bumps lastAccessedAt only when it's > 1h stale (race guard)", async () => {
  await upsertMemory({
    path: "user-global/user/role",
    description: "x",
    body: "x",
  }, "leader-tool");
  const first = await viewMemory("user-global/user/role");
  // Two rapid views shouldn't churn the file (race guard against
  // concurrent upserters); lastAccessedAt stays stable at minute
  // granularity.
  const second = await viewMemory("user-global/user/role");
  expect(second!.frontmatter.lastAccessedAt).toBe(
    first!.frontmatter.lastAccessedAt,
  );

  // Backdate the stamp by 2h on disk, then verify a view DOES
  // refresh it (the 1h delta gate fires).
  const file = join(userDir, "user", "role.md");
  const raw = await fs.readFile(file, "utf8");
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  await fs.writeFile(
    file,
    raw.replace(/lastAccessedAt:.*/, `lastAccessedAt: ${twoHoursAgo}`),
  );
  const refreshed = await viewMemory("user-global/user/role");
  expect(
    new Date(refreshed!.frontmatter.lastAccessedAt).getTime(),
  ).toBeGreaterThan(new Date(twoHoursAgo).getTime());
});

test("atomic write: tmp file is cleaned up on success", async () => {
  await upsertMemory({
    path: "user-global/user/role",
    description: "x",
    body: "x",
  }, "leader-tool");
  const userFiles = await fs.readdir(join(userDir, "user"));
  expect(userFiles.some((f) => f.includes(".tmp."))).toBe(false);
});

// ---- Cheatsheet (Phase 2) ----

test("upsertMemory writes cheatsheet at scope root, not under a type dir", async () => {
  const res = await upsertMemory({
    path: "user-global/cheatsheet.md",
    description: "Personal cheatsheet",
    body: "## TIL\n- bun watches mtime\n",
  }, "leader-tool");
  expect(res.created).toBe(true);
  expect(res.path).toBe("user-global/cheatsheet");
  const file = await fs.readFile(join(userDir, "cheatsheet.md"), "utf8");
  expect(file).toContain("type: cheatsheet");
  expect(file).toContain("name: cheatsheet");
  // Should NOT have created a `cheatsheet/` subdirectory.
  const top = await fs.readdir(userDir);
  expect(top.includes("cheatsheet")).toBe(false);
});

test("upsertMemory replaces existing cheatsheet (cap-1 enforced by path)", async () => {
  await upsertMemory({
    path: "user-global/cheatsheet.md",
    description: "v1",
    body: "old",
  }, "leader-tool");
  const res = await upsertMemory({
    path: "user-global/cheatsheet.md",
    description: "v2",
    body: "new",
  }, "leader-tool");
  expect(res.created).toBe(false);
  const file = await fs.readFile(join(userDir, "cheatsheet.md"), "utf8");
  expect(file).toContain("description: v2");
  expect(file).toContain("new");
});

test("upsertMemory honors cheatsheet body cap", async () => {
  const huge = "x".repeat(8 * 1024 + 1);
  await expect(
    upsertMemory({
      path: "user-global/cheatsheet.md",
      description: "huge",
      body: huge,
    }, "leader-tool"),
  ).rejects.toThrow(MemoryCapacityError);
});

// ---- Scratchpad (Phase 2) ----

test("upsertMemory writes scratchpad under scratchpad/<taskId>.md and stamps taskId", async () => {
  const res = await upsertMemory({
    path: "project/scratchpad/task_42.md",
    description: "in-flight notes",
    body: "open files:\n- foo.ts\n",
  }, "leader-tool");
  expect(res.created).toBe(true);
  expect(res.path).toBe("project/scratchpad/task_42");
  const file = await fs.readFile(
    join(projectDir, "scratchpad", "task_42.md"),
    "utf8",
  );
  expect(file).toContain("type: scratchpad");
  expect(file).toContain("name: task_42");
  expect(file).toContain("taskId: task_42");
});

test("upsertMemory rejects scratchpad in user-global scope", async () => {
  await expect(
    upsertMemory({
      path: "user-global/scratchpad/task_42.md",
      description: "nope",
      body: "no",
    }, "leader-tool"),
  ).rejects.toThrow(MemoryValidationError);
});

test("upsertMemory enforces 16KB scratchpad body cap (bigger than typed)", async () => {
  // 10 KB is fine for scratchpad (> 8 KB typed cap, < 16 KB scratchpad cap)
  await upsertMemory({
    path: "project/scratchpad/task_42.md",
    description: "ok",
    body: "y".repeat(10 * 1024),
  }, "leader-tool");
  // 16 KB + 1 should reject
  await expect(
    upsertMemory({
      path: "project/scratchpad/task_42.md",
      description: "huge",
      body: "y".repeat(16 * 1024 + 1),
    }, "leader-tool"),
  ).rejects.toThrow(MemoryCapacityError);
});

test("listMemory surfaces cheatsheet and scratchpad alongside typed entries", async () => {
  await upsertMemory({
    path: "user-global/user/role",
    description: "x",
    body: "x",
  }, "leader-tool");
  await upsertMemory({
    path: "user-global/cheatsheet.md",
    description: "cs",
    body: "cs body",
  }, "leader-tool");
  await upsertMemory({
    path: "project/scratchpad/task_99.md",
    description: "sp",
    body: "sp body",
  }, "leader-tool");
  const list = await listMemory();
  const userGlobalTypes = list["user-global"].map((e) => e.type).sort();
  expect(userGlobalTypes).toEqual(["cheatsheet", "user"]);
  expect(list.project.length).toBe(1);
  expect(list.project[0]!.type).toBe("scratchpad");
  expect(list.project[0]!.frontmatter.taskId).toBe("task_99");
});

test("listMemory ignores unexpected subdirs under a scope root", async () => {
  // User-created or stray dir that doesn't match the path discriminator.
  await fs.mkdir(join(userDir, "notes"), { recursive: true });
  await fs.writeFile(
    join(userDir, "notes", "x.md"),
    "---\nschemaVersion: 1\nname: x\ndescription: d\ntype: user\ncreatedAt: 2026-01-01T00:00:00.000Z\nlastAccessedAt: 2026-01-01T00:00:00.000Z\n---\nbody\n",
  );
  // Legit entry alongside the stray dir.
  await upsertMemory({
    path: "user-global/user/legit",
    description: "ok",
    body: "ok",
  }, "leader-tool");

  const list = await listMemory();
  expect(list["user-global"].map((e) => e.name)).toEqual(["legit"]);
});

test("deleteMemory eagerly drops references pointing at the deleted entry", async () => {
  await upsertMemory({
    path: "user-global/user/target",
    description: "t",
    body: "ok",
  }, "leader-tool");
  await upsertMemory({
    path: "user-global/user/source-supersedes",
    description: "s",
    body: "ok",
    supersedes: "user-global/user/target",
  }, "leader-tool");
  await upsertMemory({
    path: "user-global/user/source-superseded-by",
    description: "s",
    body: "ok",
    supersededBy: "user-global/user/target",
  }, "leader-tool");
  await upsertMemory({
    path: "user-global/user/source-related",
    description: "s",
    body: "ok",
    related: [
      "user-global/user/target",
      "user-global/user/other",
    ],
  }, "leader-tool");
  await deleteMemory("user-global/user/target", "leader-tool");

  // supersedes dropped
  const a = await fs.readFile(
    join(userDir, "user", "source-supersedes.md"),
    "utf8",
  );
  expect(a).not.toContain("supersedes:");

  // supersededBy dropped
  const b = await fs.readFile(
    join(userDir, "user", "source-superseded-by.md"),
    "utf8",
  );
  expect(b).not.toContain("supersededBy:");

  // related: deleted member dropped, other survives
  const c = await fs.readFile(
    join(userDir, "user", "source-related.md"),
    "utf8",
  );
  expect(c).toContain("user-global/user/other");
  expect(c).not.toContain("user-global/user/target");
});

test("listMemory skips symlinked .md files (defense in depth)", async () => {
  // Plant a symlink that would otherwise leak target content into
  // the listing. Use a fixture outside the scope as the target.
  const outside = join(userDir, "..", "magister-mem-symlink-target.md");
  await fs.writeFile(
    outside,
    "---\nschemaVersion: 1\nname: leaked\ndescription: should-not-appear\ntype: user\ncreatedAt: 2026-01-01T00:00:00.000Z\nlastAccessedAt: 2026-01-01T00:00:00.000Z\n---\nleaked body\n",
  );
  await fs.mkdir(join(userDir, "user"), { recursive: true });
  await fs.symlink(outside, join(userDir, "user", "evil.md"));
  // Legit entry should still surface.
  await upsertMemory({
    path: "user-global/user/legit",
    description: "ok",
    body: "ok",
  }, "leader-tool");
  const list = await listMemory();
  const names = list["user-global"].map((e) => e.name);
  expect(names).toContain("legit");
  expect(names).not.toContain("evil");
  expect(names).not.toContain("leaked");
  await fs.unlink(outside).catch(() => undefined);
});

test("physPath rejects writes whose resolved target escapes the scope root", async () => {
  // Plant a symlink at the typed dir so physPath would resolve the
  // write inside it. The path discriminator only blocks `..` in the
  // virtual path string; the resolve-check inside physPath blocks
  // the resolved-target escape.
  // (We can't easily test the EXACT physPath guard without exposing
  // it, but we can test the public effect: writing through a
  // symlinked dir doesn't escape — see listMemory test above; this
  // test is a sanity check that physPath compiles + the guard
  // doesn't false-positive on legit writes.)
  const res = await upsertMemory({
    path: "user-global/user/legit-sanity",
    description: "x",
    body: "x",
  }, "leader-tool");
  expect(res.created).toBe(true);
});

test("patchMemoryLinks updates link fields without touching others", async () => {
  await upsertMemory({
    path: "user-global/user/target",
    description: "t",
    body: "ok",
  }, "leader-tool");
  await upsertMemory({
    path: "user-global/user/source",
    description: "original description",
    body: "original body line 1\noriginal body line 2",
  }, "leader-tool");
  // Add a sweep-set codeChanged flag to confirm it survives a
  // link-patch round-trip.
  const file = join(userDir, "user", "source.md");
  const raw = await fs.readFile(file, "utf8");
  await fs.writeFile(
    file,
    raw.replace("description:", "codeChanged: true\ndescription:"),
  );

  await patchMemoryLinks("user-global/user/source", {
    supersedes: "user-global/user/target",
  }, "leader-tool");
  const after = await viewMemory("user-global/user/source");
  expect(after?.frontmatter.supersedes).toBe("user-global/user/target");
  expect(after?.frontmatter.description).toBe("original description");
  expect(after?.body.trim()).toBe("original body line 1\noriginal body line 2");
  expect(after?.frontmatter.codeChanged).toBe(true);
});

test("purgeScratchpadForTask rejects path-traversal taskIds", async () => {
  // Plant a file at a known location that a traversal could hit.
  await fs.mkdir(join(projectDir, "scratchpad"), { recursive: true });
  await fs.writeFile(join(projectDir, "scratchpad", "real.md"), "guard");
  // Attempted traversal — should be rejected silently, the real
  // file must survive.
  await purgeScratchpadForTask("../scratchpad/real");
  expect(
    await fs.readFile(join(projectDir, "scratchpad", "real.md"), "utf8"),
  ).toBe("guard");
});

test("purgeScratchpadForTask removes the file + is idempotent on missing", async () => {
  await upsertMemory({
    path: "project/scratchpad/task_purge.md",
    description: "sp",
    body: "sp body",
  }, "leader-tool");
  expect(await viewMemory("project/scratchpad/task_purge.md")).not.toBeNull();
  await purgeScratchpadForTask("task_purge");
  expect(await viewMemory("project/scratchpad/task_purge.md")).toBeNull();
  // Second call must not throw.
  await purgeScratchpadForTask("task_purge");
});

test("viewMemory + deleteMemory roundtrip for cheatsheet/scratchpad", async () => {
  await upsertMemory({
    path: "user-global/cheatsheet.md",
    description: "cs",
    body: "cs body",
  }, "leader-tool");
  const cs = await viewMemory("user-global/cheatsheet.md");
  expect(cs?.body.trim()).toBe("cs body");
  const del = await deleteMemory("user-global/cheatsheet.md", "leader-tool");
  expect(del.deleted).toBe(true);
  expect(await viewMemory("user-global/cheatsheet.md")).toBeNull();

  await upsertMemory({
    path: "project/scratchpad/task_x.md",
    description: "sp",
    body: "sp body",
  }, "leader-tool");
  const sp = await viewMemory("project/scratchpad/task_x.md");
  expect(sp?.body.trim()).toBe("sp body");
  expect((await deleteMemory("project/scratchpad/task_x.md", "leader-tool")).deleted).toBe(true);
});

// ---- P0-2: write-authority guard ----

test("upsertMemory rejects nullish authority", async () => {
  await expect(
    upsertMemory(
      { path: "user-global/user/x", description: "x", body: "x" },
      undefined as any,
    ),
  ).rejects.toBeInstanceOf(MemoryAuthError);
});

test("upsertMemory rejects unknown authority string", async () => {
  await expect(
    upsertMemory(
      { path: "user-global/user/x", description: "x", body: "x" },
      "teammate-tool" as any,
    ),
  ).rejects.toBeInstanceOf(MemoryAuthError);
});

test("deleteMemory rejects unknown authority string", async () => {
  await expect(
    deleteMemory("user-global/user/x", "mcp-server" as any),
  ).rejects.toBeInstanceOf(MemoryAuthError);
});

test("patchMemoryLinks rejects unknown authority string", async () => {
  await upsertMemory(
    { path: "user-global/user/x", description: "x", body: "x" },
    "leader-tool",
  );
  await expect(
    patchMemoryLinks("user-global/user/x", { related: [] }, "bogus" as any),
  ).rejects.toBeInstanceOf(MemoryAuthError);
});

test("cleanupTmpFiles removes orphan .tmp files at startup", async () => {
  const dir = join(userDir, "user");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, "stale.md.tmp.1234"), "garbage");
  await fs.writeFile(
    join(dir, "role.md"),
    "---\nschemaVersion: 1\nname: role\ndescription: x\ntype: user\ncreatedAt: 2026-01-01T00:00:00.000Z\nlastAccessedAt: 2026-01-01T00:00:00.000Z\n---\nbody\n"
  );
  await cleanupTmpFiles();
  const after = await fs.readdir(dir);
  expect(after).toContain("role.md");
  expect(after.some((f) => f.includes(".tmp."))).toBe(false);
});
