import { mkdtemp, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, expect, test } from "bun:test";

import {
  ApplyLockBusyError,
  acquireApplyLock,
} from "../../../src/services/safe-apply/apply-lock-service";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempWorkspace() {
  const dir = await mkdtemp(join(tmpdir(), "magister-apply-lock-"));
  tempDirs.push(dir);
  return dir;
}

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("serializes active apply attempts per workspace", async () => {
  const workspacePath = await createTempWorkspace();
  const first = await acquireApplyLock({
    workspaceId: "workspace_main",
    workspacePath,
    reviewId: "review_1",
  });

  await expect(acquireApplyLock({
    workspaceId: "workspace_main",
    workspacePath,
    reviewId: "review_2",
  })).rejects.toBeInstanceOf(ApplyLockBusyError);

  await first.release();
  const second = await acquireApplyLock({
    workspaceId: "workspace_main",
    workspacePath,
    reviewId: "review_2",
  });
  await second.release();
});

test("old owner release does not remove a replaced lock", async () => {
  const workspacePath = await createTempWorkspace();
  const first = await acquireApplyLock({
    workspaceId: "workspace_main",
    workspacePath,
    reviewId: "review_1",
    ttlMs: 1,
    now: () => new Date("2026-05-14T00:00:00.000Z"),
  });
  const second = await acquireApplyLock({
    workspaceId: "workspace_main",
    workspacePath,
    reviewId: "review_2",
    ttlMs: 1,
    now: () => new Date("2026-05-14T00:00:01.000Z"),
  });

  await first.release();
  expect(await exists(second.lockPath)).toBe(true);
  await second.release();
  expect(await exists(second.lockPath)).toBe(false);
});
