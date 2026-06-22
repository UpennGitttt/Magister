import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cleanupStaleRuntimeWorkspaces,
  finalizeRuntimeWorkspace,
  listCleanupEligibleRuntimeWorkspaceRunIds,
  prepareRuntimeWorkspace,
  resolveWorkspaceBaseDir,
} from "../../src/services/runtime-workspace-service";
import { RuntimeWorkspaceRepository } from "../../src/repositories/runtime-workspace-repository";

const tempDirs: string[] = [];
const ORIGINAL_WORKSPACE_PATH_MAP = process.env.MAGISTER_WORKSPACE_PATH_MAP;
const ORIGINAL_WORKSPACE_ROOT_DIR = process.env.MAGISTER_WORKSPACE_ROOT_DIR;
const ORIGINAL_WORKTREE_ENABLED = process.env.MAGISTER_RUNTIME_WORKTREE_ENABLED;
const ORIGINAL_WORKSPACE_TTL_MS = process.env.MAGISTER_RUNTIME_WORKSPACE_TTL_MS;

function createTempDirectory(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

afterEach(() => {
  process.env.MAGISTER_WORKSPACE_PATH_MAP = ORIGINAL_WORKSPACE_PATH_MAP;
  process.env.MAGISTER_WORKSPACE_ROOT_DIR = ORIGINAL_WORKSPACE_ROOT_DIR;
  process.env.MAGISTER_RUNTIME_WORKTREE_ENABLED = ORIGINAL_WORKTREE_ENABLED;
  process.env.MAGISTER_RUNTIME_WORKSPACE_TTL_MS = ORIGINAL_WORKSPACE_TTL_MS;

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("resolveWorkspaceBaseDir honors explicit workspace path mappings", async () => {
  const workspaceDir = createTempDirectory("ultimate-workspace-map-");
  process.env.MAGISTER_WORKSPACE_PATH_MAP = JSON.stringify({
    workspace_main: workspaceDir,
  });

  const resolved = await resolveWorkspaceBaseDir("workspace_main");
  expect(resolved).toBe(workspaceDir);
});

test("prepareRuntimeWorkspace materializes runtime metadata and finalizeRuntimeWorkspace marks completion", async () => {
  const workspaceDir = createTempDirectory("ultimate-runtime-workspace-");
  process.env.MAGISTER_WORKSPACE_PATH_MAP = JSON.stringify({
    workspace_main: workspaceDir,
  });
  process.env.MAGISTER_RUNTIME_WORKTREE_ENABLED = "false";

  const lease = await prepareRuntimeWorkspace({
    runId: "runtime_workspace_1",
    taskId: "task_workspace_1",
    roleId: "coder",
    workspaceId: "workspace_main",
  });

  expect(lease.baseWorkspaceDir).toBe(workspaceDir);
  expect(lease.workspaceDir).toBe(workspaceDir);
  expect(lease.strategy).toBe("workspace_root");
  expect(lease.artifactsBaseDir).toContain("executor-artifacts");
  expect(lease.codexHomeDir).toContain("codex-home");

  await finalizeRuntimeWorkspace({
    metadataPath: lease.metadataPath,
    status: "completed",
  });

  const metadata = JSON.parse(
    readFileSync(lease.metadataPath, "utf8"),
  ) as {
    status: string;
    strategy: string;
    workspaceDir: string;
    finishedAt?: string;
  };
  expect(metadata.status).toBe("completed");
  expect(metadata.strategy).toBe("workspace_root");
  expect(metadata.workspaceDir).toBe(workspaceDir);
  expect(typeof metadata.finishedAt).toBe("string");
});

test("prepareRuntimeWorkspace also persists runtime workspace state in the control plane", async () => {
  const workspaceDir = createTempDirectory("ultimate-runtime-workspace-db-");
  const workspaceId = "workspace_runtime_db_test";
  process.env.MAGISTER_WORKSPACE_PATH_MAP = JSON.stringify({
    [workspaceId]: workspaceDir,
  });
  process.env.MAGISTER_RUNTIME_WORKTREE_ENABLED = "false";

  const lease = await prepareRuntimeWorkspace({
    runId: "runtime_workspace_db_1",
    taskId: "task_workspace_db_1",
    roleId: "coder",
    workspaceId,
  });

  await finalizeRuntimeWorkspace({
    metadataPath: lease.metadataPath,
    status: "completed",
  });

  const repository = new RuntimeWorkspaceRepository();
  const record = await repository.getByRunId("runtime_workspace_db_1");

  expect(record).toMatchObject({
    runId: "runtime_workspace_db_1",
    taskId: "task_workspace_db_1",
    workspaceId,
    roleId: "coder",
    requestedStrategy: "git_worktree",
    strategy: "workspace_root",
    decisionReason: "coding_lane_default",
    fallbackReason: "worktree_isolation_disabled",
    status: "completed",
    baseWorkspaceDir: workspaceDir,
    workspaceDir,
    metadataPath: lease.metadataPath,
  });
  expect(record?.finishedAt).toBeInstanceOf(Date);
});

test("prepareRuntimeWorkspace records the base revision for git workspaces", async () => {
  const workspaceDir = createTempDirectory("ultimate-runtime-workspace-base-rev-");
  git(workspaceDir, ["init"]);
  git(workspaceDir, ["config", "user.email", "runtime@example.test"]);
  git(workspaceDir, ["config", "user.name", "Runtime Test"]);
  writeFileSync(join(workspaceDir, "README.md"), "# Base\n", "utf8");
  git(workspaceDir, ["add", "."]);
  git(workspaceDir, ["commit", "-m", "base"]);
  const baseRevision = git(workspaceDir, ["rev-parse", "HEAD"]);
  process.env.MAGISTER_WORKSPACE_PATH_MAP = JSON.stringify({
    workspace_main: workspaceDir,
  });
  process.env.MAGISTER_RUNTIME_WORKTREE_ENABLED = "false";

  const lease = await prepareRuntimeWorkspace({
    runId: "runtime_workspace_base_revision_1",
    taskId: "task_workspace_base_revision_1",
    roleId: "coder",
    workspaceId: "workspace_main",
  });

  expect(lease.baseRevision).toBe(baseRevision);
  const metadata = JSON.parse(readFileSync(lease.metadataPath, "utf8")) as {
    baseRevision?: string | null;
  };
  expect(metadata.baseRevision).toBe(baseRevision);

  const record = await new RuntimeWorkspaceRepository().getByRunId(
    "runtime_workspace_base_revision_1",
  );
  expect(record?.baseRevision).toBe(baseRevision);
});

test("runtime workspace lifecycle exposes cleanup-eligible terminal workspaces", async () => {
  const workspaceDir = createTempDirectory("ultimate-runtime-workspace-cleanup-");
  process.env.MAGISTER_WORKSPACE_PATH_MAP = JSON.stringify({
    workspace_main: workspaceDir,
  });
  process.env.MAGISTER_RUNTIME_WORKTREE_ENABLED = "false";

  const lease = await prepareRuntimeWorkspace({
    runId: "runtime_workspace_cleanup_1",
    taskId: "task_workspace_cleanup_1",
    roleId: "coder",
    workspaceId: "workspace_main",
  });

  await finalizeRuntimeWorkspace({
    metadataPath: lease.metadataPath,
    status: "completed",
  });

  const cleanupEligibleRunIds = await listCleanupEligibleRuntimeWorkspaceRunIds();
  expect(cleanupEligibleRunIds).toContain("runtime_workspace_cleanup_1");
});

test("cleanupStaleRuntimeWorkspaces removes metadata but keeps the shared root workspace on disk", async () => {
  const workspaceDir = createTempDirectory("ultimate-runtime-workspace-shared-root-");
  process.env.MAGISTER_WORKSPACE_PATH_MAP = JSON.stringify({
    workspace_main: workspaceDir,
  });
  process.env.MAGISTER_RUNTIME_WORKTREE_ENABLED = "false";
  process.env.MAGISTER_RUNTIME_WORKSPACE_TTL_MS = "1";

  const lease = await prepareRuntimeWorkspace({
    runId: "runtime_workspace_shared_root_cleanup_1",
    taskId: "task_workspace_shared_root_cleanup_1",
    roleId: "coder",
    workspaceId: "workspace_main",
  });

  await finalizeRuntimeWorkspace({
    metadataPath: lease.metadataPath,
    status: "completed",
  });

  await new Promise((resolve) => setTimeout(resolve, 5));
  await cleanupStaleRuntimeWorkspaces(workspaceDir);

  expect(existsSync(workspaceDir)).toBe(true);
  expect(existsSync(lease.metadataPath)).toBe(false);
});

// Helper for the orphan-tolerant cleanup tests below: synthesize a
// runs/<taskId>/<runId>/ directory with a chosen mtime so we can drive
// TTL + cap behavior without spinning up real prepareRuntimeWorkspace.
function makeOrphanWorkspace(
  workspaceDir: string,
  runId: string,
  ageMs: number,
) {
  const dir = join(workspaceDir, ".magister", "runtime-workspaces", "runs", `task_${runId}`, runId);
  mkdirSync(dir, { recursive: true });
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(dir, t, t);
  return dir;
}

test("cleanupStaleRuntimeWorkspaces removes orphans past TTL even without metadata", async () => {
  const workspaceDir = createTempDirectory("ultimate-runtime-workspace-orphan-ttl-");
  process.env.MAGISTER_RUNTIME_WORKSPACE_TTL_MS = "1000"; // 1 second

  const fresh = makeOrphanWorkspace(workspaceDir, "fresh", 100); // 100ms old → keep
  const stale = makeOrphanWorkspace(workspaceDir, "stale", 5000); // 5s old → drop

  await cleanupStaleRuntimeWorkspaces(workspaceDir);

  expect(existsSync(fresh)).toBe(true);
  expect(existsSync(stale)).toBe(false);
});

test("cleanupStaleRuntimeWorkspaces enforces the recent-N cap regardless of TTL", async () => {
  const workspaceDir = createTempDirectory("ultimate-runtime-workspace-cap-");
  // TTL very long so it can't be the reason anything is dropped.
  process.env.MAGISTER_RUNTIME_WORKSPACE_TTL_MS = String(365 * 24 * 60 * 60 * 1000);
  process.env.MAGISTER_RUNTIME_WORKSPACE_MAX = "3";

  // Five workspaces with strictly-increasing ages — the 3 youngest
  // (small ageMs) should survive; the 2 oldest should be dropped.
  const dirs = [
    makeOrphanWorkspace(workspaceDir, "a_newest", 100),
    makeOrphanWorkspace(workspaceDir, "b", 200),
    makeOrphanWorkspace(workspaceDir, "c", 300),
    makeOrphanWorkspace(workspaceDir, "d", 400),
    makeOrphanWorkspace(workspaceDir, "e_oldest", 500),
  ];

  await cleanupStaleRuntimeWorkspaces(workspaceDir);

  expect(existsSync(dirs[0]!)).toBe(true);  // a_newest
  expect(existsSync(dirs[1]!)).toBe(true);  // b
  expect(existsSync(dirs[2]!)).toBe(true);  // c
  expect(existsSync(dirs[3]!)).toBe(false); // d
  expect(existsSync(dirs[4]!)).toBe(false); // e_oldest

  // Empty parent task dirs are also cleaned up — otherwise leftover
  // task_* directories accumulate forever even when their child runs
  // are gone.
  delete process.env.MAGISTER_RUNTIME_WORKSPACE_MAX;
  const runsDir = join(workspaceDir, ".magister", "runtime-workspaces", "runs");
  const remainingTaskDirs = readdirSync(runsDir);
  expect(remainingTaskDirs.length).toBe(3);
});
