import { afterEach, beforeEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveWorkspaceHeadSha,
  upsertMemory,
  viewMemory,
} from "../../../src/services/memory/memory-fs-service";
import { sweepAging } from "../../../src/services/memory/memory-aging-sweeper";
import {
  initMemoryRuntime,
  resetMemoryRuntimeForTests,
} from "../../../src/services/memory/memory-runtime";

let workspace: string;
let userDir: string;
let projectDir: string;

async function git(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "magister-test",
      GIT_AUTHOR_EMAIL: "magister-test@example.com",
      GIT_COMMITTER_NAME: "magister-test",
      GIT_COMMITTER_EMAIL: "magister-test@example.com",
    },
  });
  await proc.exited;
  return (await new Response(proc.stdout).text()).trim();
}

async function gitAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn({
      cmd: ["git", "--version"],
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  // Set up a workspace-shaped layout: <workspace>/.magister/memory/{user,project}.
  // `resolveWorkspaceFromProjectRoot` reaches `<workspace>` by walking
  // two levels up from `projectScopeRoot`.
  workspace = await fs.mkdtemp(join(tmpdir(), "magister-mem-git-ws-"));
  const memoryRoot = join(workspace, ".magister", "memory");
  await fs.mkdir(memoryRoot, { recursive: true });
  userDir = join(memoryRoot, "_user");
  projectDir = join(memoryRoot);
  await fs.mkdir(userDir, { recursive: true });
  // Re-init runtime with the workspace-rooted paths.
  initMemoryRuntime({
    userScopeRoot: userDir,
    projectScopeRoot: projectDir,
  });
});

afterEach(async () => {
  resetMemoryRuntimeForTests();
  await fs.rm(workspace, { recursive: true, force: true });
});

test("upsertMemory stamps gitAnchor on project entries inside a git repo", async () => {
  if (!(await gitAvailable())) return; // skip when git not installed
  await git(["init", "-q"], workspace);
  await fs.writeFile(join(workspace, "README.md"), "hi\n");
  await git(["add", "."], workspace);
  await git(["commit", "-q", "-m", "init"], workspace);
  const head = await resolveWorkspaceHeadSha(projectDir);
  expect(head).not.toBeNull();

  await upsertMemory({
    path: "project/project/arch-leader-loop",
    description: "loop arch",
    body: "body",
  }, "leader-tool");
  const entry = await viewMemory("project/project/arch-leader-loop");
  expect(entry?.frontmatter.gitAnchor).toBe(head!);
});

test("upsertMemory leaves gitAnchor undefined for user-global entries", async () => {
  if (!(await gitAvailable())) return;
  await git(["init", "-q"], workspace);
  await fs.writeFile(join(workspace, "x"), "1");
  await git(["add", "."], workspace);
  await git(["commit", "-q", "-m", "init"], workspace);

  await upsertMemory({
    path: "user-global/user/role",
    description: "x",
    body: "x",
  }, "leader-tool");
  const entry = await viewMemory("user-global/user/role");
  expect(entry?.frontmatter.gitAnchor).toBeUndefined();
});

test("upsertMemory in a non-git workspace leaves gitAnchor undefined", async () => {
  await upsertMemory({
    path: "project/project/arch",
    description: "x",
    body: "x",
  }, "leader-tool");
  const entry = await viewMemory("project/project/arch");
  expect(entry?.frontmatter.gitAnchor).toBeUndefined();
});

test("aging sweep flips codeChanged=true when HEAD has moved since the anchor", async () => {
  if (!(await gitAvailable())) return;
  await git(["init", "-q"], workspace);
  await fs.writeFile(join(workspace, "a.txt"), "1\n");
  await git(["add", "."], workspace);
  await git(["commit", "-q", "-m", "first"], workspace);

  await upsertMemory({
    path: "project/project/arch",
    description: "x",
    body: "x",
  }, "leader-tool");
  // Before any new commits, sweep should leave codeChanged unset.
  await sweepAging();
  const before = await viewMemory("project/project/arch");
  expect(before?.frontmatter.codeChanged).toBeUndefined();

  // Advance HEAD; codeChanged should flip true on next sweep.
  await fs.writeFile(join(workspace, "b.txt"), "2\n");
  await git(["add", "."], workspace);
  await git(["commit", "-q", "-m", "second"], workspace);
  await sweepAging();
  const after = await viewMemory("project/project/arch");
  expect(after?.frontmatter.codeChanged).toBe(true);
});

test("aging sweep clears codeChanged when HEAD goes back to the anchor", async () => {
  if (!(await gitAvailable())) return;
  await git(["init", "-q"], workspace);
  await fs.writeFile(join(workspace, "a.txt"), "1\n");
  await git(["add", "."], workspace);
  await git(["commit", "-q", "-m", "first"], workspace);
  const firstSha = await resolveWorkspaceHeadSha(projectDir);

  await upsertMemory({
    path: "project/project/arch",
    description: "x",
    body: "x",
  }, "leader-tool");

  // Advance + sweep → codeChanged true.
  await fs.writeFile(join(workspace, "b.txt"), "2\n");
  await git(["add", "."], workspace);
  await git(["commit", "-q", "-m", "second"], workspace);
  await sweepAging();
  const moved = await viewMemory("project/project/arch");
  expect(moved?.frontmatter.codeChanged).toBe(true);

  // Reset HEAD back to the anchor → codeChanged cleared.
  await git(["reset", "--hard", "-q", firstSha!], workspace);
  await sweepAging();
  const back = await viewMemory("project/project/arch");
  expect(back?.frontmatter.codeChanged).toBeUndefined();
});

test("aging sweep does not touch user-global entries' codeChanged", async () => {
  if (!(await gitAvailable())) return;
  await git(["init", "-q"], workspace);
  await fs.writeFile(join(workspace, "a.txt"), "1\n");
  await git(["add", "."], workspace);
  await git(["commit", "-q", "-m", "first"], workspace);

  await upsertMemory({
    path: "user-global/user/role",
    description: "x",
    body: "x",
  }, "leader-tool");

  await fs.writeFile(join(workspace, "b.txt"), "2\n");
  await git(["add", "."], workspace);
  await git(["commit", "-q", "-m", "second"], workspace);

  await sweepAging();
  const u = await viewMemory("user-global/user/role");
  expect(u?.frontmatter.codeChanged).toBeUndefined();
});
