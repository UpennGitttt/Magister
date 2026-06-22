import { afterEach, beforeEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upsertMemory } from "../../../src/services/memory/memory-fs-service";
import { sweepAging } from "../../../src/services/memory/memory-aging-sweeper";
import {
  initMemoryRuntime,
  resetMemoryRuntimeForTests,
} from "../../../src/services/memory/memory-runtime";

let userDir: string;
let projectDir: string;

beforeEach(async () => {
  userDir = await fs.mkdtemp(join(tmpdir(), "magister-mem-aging-user-"));
  projectDir = await fs.mkdtemp(join(tmpdir(), "magister-mem-aging-proj-"));
  initMemoryRuntime({ userScopeRoot: userDir, projectScopeRoot: projectDir });
});

afterEach(async () => {
  resetMemoryRuntimeForTests();
  await fs.rm(userDir, { recursive: true, force: true });
  await fs.rm(projectDir, { recursive: true, force: true });
});

async function backdateAccess(path: string, daysAgo: number) {
  const raw = await fs.readFile(path, "utf8");
  const target = new Date(Date.now() - daysAgo * 86400_000).toISOString();
  const replaced = raw.replace(
    /lastAccessedAt:.*/,
    `lastAccessedAt: ${target}`
  );
  await fs.writeFile(path, replaced);
}

test("entries newer than aging threshold get no flag", async () => {
  await upsertMemory({
    path: "user-global/user/fresh",
    description: "x",
    body: "x",
  }, "leader-tool");
  await sweepAging();
  const raw = await fs.readFile(join(userDir, "user", "fresh.md"), "utf8");
  expect(raw).not.toContain("agingFlag:");
});

test("entries older than 30 days get agingFlag: aging", async () => {
  await upsertMemory({
    path: "user-global/user/old",
    description: "x",
    body: "x",
  }, "leader-tool");
  await backdateAccess(join(userDir, "user", "old.md"), 31);
  await sweepAging();
  const raw = await fs.readFile(join(userDir, "user", "old.md"), "utf8");
  expect(raw).toContain("agingFlag: aging");
});

test("entries older than 90 days get agingFlag: stale", async () => {
  await upsertMemory({
    path: "user-global/user/ancient",
    description: "x",
    body: "x",
  }, "leader-tool");
  await backdateAccess(join(userDir, "user", "ancient.md"), 100);
  await sweepAging();
  const raw = await fs.readFile(join(userDir, "user", "ancient.md"), "utf8");
  expect(raw).toContain("agingFlag: stale");
});

test("sweep does not flip stale back when re-run without activity", async () => {
  await upsertMemory({
    path: "user-global/user/ancient",
    description: "x",
    body: "x",
  }, "leader-tool");
  await backdateAccess(join(userDir, "user", "ancient.md"), 100);
  await sweepAging();
  await sweepAging();
  const raw = await fs.readFile(join(userDir, "user", "ancient.md"), "utf8");
  expect(raw).toContain("agingFlag: stale");
});

// ---- Phase 3: dangling-ref repair ----

test("sweep repairs supersedes pointing at a deleted entry", async () => {
  await upsertMemory({
    path: "user-global/user/source",
    description: "src",
    body: "ok",
    supersedes: "user-global/user/never-here",
  }, "leader-tool");
  // The supersedes target was never written → it's a dead link.
  await sweepAging();
  const raw = await fs.readFile(join(userDir, "user", "source.md"), "utf8");
  expect(raw).not.toContain("supersedes:");
});

test("sweep prunes only the dangling members of `related[]`", async () => {
  await upsertMemory({
    path: "user-global/user/target",
    description: "target",
    body: "ok",
  }, "leader-tool");
  await upsertMemory({
    path: "user-global/user/source",
    description: "src",
    body: "ok",
    related: ["user-global/user/target", "user-global/user/ghost"],
  }, "leader-tool");
  await sweepAging();
  const raw = await fs.readFile(join(userDir, "user", "source.md"), "utf8");
  expect(raw).toContain("user-global/user/target");
  expect(raw).not.toContain("user-global/user/ghost");
});

// ---- P0-1: mtime guard against concurrent writers ----

test("sweep skips rewrite when mtime advances between read and write", async () => {
  await upsertMemory({
    path: "user-global/feedback/race",
    description: "x",
    body: "x",
  }, "leader-tool");
  const filePath = join(userDir, "feedback", "race.md");
  await backdateAccess(filePath, 31);

  // Monkey-patch fs.stat: second call on our race file returns a
  // bumped mtimeMs, simulating a concurrent rewrite landing between
  // our read and our write. Guard must detect and skip.
  const realStat = fs.stat;
  let callCount = 0;
  (fs as any).stat = async (p: any) => {
    const s = await realStat(p);
    if (typeof p === "string" && p === filePath) {
      callCount++;
      if (callCount === 2) {
        return { ...s, mtimeMs: s.mtimeMs + 1_000_000 } as any;
      }
    }
    return s;
  };
  try {
    await sweepAging();
  } finally {
    (fs as any).stat = realStat;
  }

  const raw = await require("node:fs").promises.readFile(filePath, "utf8");
  // The aging flag was NOT written — sweep skipped due to mtime race.
  expect(raw).not.toContain("agingFlag:");
});

test("sweep leaves live references untouched + is idempotent", async () => {
  await upsertMemory({
    path: "user-global/user/target",
    description: "t",
    body: "ok",
  }, "leader-tool");
  await upsertMemory({
    path: "user-global/user/source",
    description: "s",
    body: "ok",
    supersedes: "user-global/user/target",
  }, "leader-tool");
  await sweepAging();
  const after1 = await fs.readFile(join(userDir, "user", "source.md"), "utf8");
  expect(after1).toContain("supersedes: user-global/user/target");
  await sweepAging();
  const after2 = await fs.readFile(join(userDir, "user", "source.md"), "utf8");
  expect(after2).toBe(after1);
});
