import { afterEach, beforeEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upsertMemory } from "../../../src/services/memory/memory-fs-service";
import {
  flushIndexRebuild,
  rebuildIndex,
} from "../../../src/services/memory/memory-index-service";
import {
  initMemoryRuntime,
  resetMemoryRuntimeForTests,
} from "../../../src/services/memory/memory-runtime";

let userDir: string;
let projectDir: string;

beforeEach(async () => {
  userDir = await fs.mkdtemp(join(tmpdir(), "magister-mem-idx-user-"));
  projectDir = await fs.mkdtemp(join(tmpdir(), "magister-mem-idx-proj-"));
  initMemoryRuntime({ userScopeRoot: userDir, projectScopeRoot: projectDir });
});

afterEach(async () => {
  resetMemoryRuntimeForTests();
  await fs.rm(userDir, { recursive: true, force: true });
  await fs.rm(projectDir, { recursive: true, force: true });
});

test("rebuildIndex writes _index.md with grouped entries", async () => {
  await upsertMemory({
    path: "user-global/user/role",
    description: "Senior engineer",
    body: "ok",
  }, "leader-tool");
  await upsertMemory({
    path: "user-global/feedback/testing",
    description: "Use real DB",
    body: "ok",
  }, "leader-tool");
  await rebuildIndex();
  const content = await fs.readFile(join(userDir, "_index.md"), "utf8");
  expect(content).toContain("## user");
  expect(content).toContain("- role — Senior engineer");
  expect(content).toContain("## feedback");
  expect(content).toContain("- testing — Use real DB");
});

test("rebuildIndex writes index per scope", async () => {
  await upsertMemory({
    path: "project/project/arch",
    description: "Architecture overview",
    body: "ok",
  }, "leader-tool");
  await rebuildIndex();
  const projectIndex = await fs.readFile(
    join(projectDir, "_index.md"),
    "utf8"
  );
  expect(projectIndex).toContain("- arch — Architecture overview");
  const userIndex = await fs.readFile(join(userDir, "_index.md"), "utf8");
  expect(userIndex).toContain("# Memory Index (user-global)");
});

test("rebuildIndex includes aging flag when present", async () => {
  await upsertMemory({
    path: "user-global/user/role",
    description: "x",
    body: "ok",
  }, "leader-tool");
  const file = join(userDir, "user", "role.md");
  const orig = await fs.readFile(file, "utf8");
  await fs.writeFile(
    file,
    orig.replace("schemaVersion: 1", "schemaVersion: 1\nagingFlag: stale")
  );
  await rebuildIndex();
  const content = await fs.readFile(join(userDir, "_index.md"), "utf8");
  expect(content).toContain("- role — x [stale]");
});

test("upsertMemory schedules debounced rebuild; flushIndexRebuild forces it", async () => {
  await upsertMemory({
    path: "user-global/user/a",
    description: "alpha",
    body: "ok",
  }, "leader-tool");
  // before flush: _index.md may not exist yet
  await flushIndexRebuild();
  const content = await fs.readFile(join(userDir, "_index.md"), "utf8");
  expect(content).toContain("- a — alpha");
});

test("multiple rapid upserts coalesce into single rebuild via debounce", async () => {
  await upsertMemory({
    path: "user-global/user/a",
    description: "alpha",
    body: "ok",
  }, "leader-tool");
  await upsertMemory({
    path: "user-global/user/b",
    description: "beta",
    body: "ok",
  }, "leader-tool");
  await upsertMemory({
    path: "user-global/user/c",
    description: "gamma",
    body: "ok",
  }, "leader-tool");
  await flushIndexRebuild();
  const content = await fs.readFile(join(userDir, "_index.md"), "utf8");
  expect(content).toContain("- a — alpha");
  expect(content).toContain("- b — beta");
  expect(content).toContain("- c — gamma");
});

// ---- Phase 3: _refs.json reverse index ----

type ReverseEdge = { from: string; kind: "supersedes" | "supersededBy" | "related" };
type ReverseIndex = Record<string, ReverseEdge[]>;

async function readRefs(scopeDir: string): Promise<ReverseIndex> {
  const raw = await fs.readFile(join(scopeDir, "_refs.json"), "utf8");
  return JSON.parse(raw) as ReverseIndex;
}

test("rebuildIndex writes _refs.json grouping incoming edges by target", async () => {
  await upsertMemory({
    path: "user-global/user/role",
    description: "v1",
    body: "ok",
  }, "leader-tool");
  await upsertMemory({
    path: "user-global/user/role-v2",
    description: "v2",
    body: "ok",
    supersedes: "user-global/user/role",
  }, "leader-tool");
  await upsertMemory({
    path: "user-global/feedback/lesson",
    description: "lesson",
    body: "ok",
    related: ["user-global/user/role"],
  }, "leader-tool");
  await rebuildIndex();
  const refs = await readRefs(userDir);
  expect(refs["user-global/user/role"]).toEqual([
    { from: "user-global/feedback/lesson", kind: "related" },
    { from: "user-global/user/role-v2", kind: "supersedes" },
  ]);
});

test("rebuildIndex skips edges that point at non-existent targets (ghosts)", async () => {
  await upsertMemory({
    path: "user-global/user/orphan-source",
    description: "x",
    body: "ok",
    supersedes: "user-global/user/never-existed",
  }, "leader-tool");
  await rebuildIndex();
  const refs = await readRefs(userDir);
  // The ghost target shouldn't appear as a key.
  expect(refs["user-global/user/never-existed"]).toBeUndefined();
});

test("_refs.json is stable across rebuilds (sorted edges)", async () => {
  await upsertMemory({
    path: "user-global/user/target",
    description: "t",
    body: "ok",
  }, "leader-tool");
  await upsertMemory({
    path: "user-global/user/b",
    description: "b",
    body: "ok",
    related: ["user-global/user/target"],
  }, "leader-tool");
  await upsertMemory({
    path: "user-global/user/a",
    description: "a",
    body: "ok",
    related: ["user-global/user/target"],
  }, "leader-tool");
  await rebuildIndex();
  const first = await fs.readFile(join(userDir, "_refs.json"), "utf8");
  await rebuildIndex();
  const second = await fs.readFile(join(userDir, "_refs.json"), "utf8");
  expect(first).toBe(second);
});
