import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquireProcessLock } from "../../src/utils/process-lock";

const tempDirs: string[] = [];

function createTempLockPath() {
  const root = mkdtempSync(join(tmpdir(), "ultimate-process-lock-"));
  tempDirs.push(root);
  return join(root, "api-server.lock");
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const root = tempDirs.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("acquireProcessLock creates and releases lock files", async () => {
  const lockPath = createTempLockPath();
  const lock = await acquireProcessLock(lockPath);

  await expect(Bun.file(lockPath).exists()).resolves.toBe(true);

  await lock.release();
  await expect(Bun.file(lockPath).exists()).resolves.toBe(false);
});

test("acquireProcessLock rejects when an active OTHER process already owns the lock", async () => {
  const lockPath = createTempLockPath();
  // Use the parent pid — guaranteed alive (it's running this test)
  // but distinct from process.pid. The OUR-own-pid case is treated as
  // stale (covered separately below) so `bun --watch` can re-acquire
  // when re-running the entry script in-process.
  const otherLivePid = typeof process.ppid === "number" && process.ppid > 0 ? process.ppid : 1;
  writeFileSync(lockPath, JSON.stringify({ pid: otherLivePid, createdAt: new Date().toISOString() }));

  await expect(acquireProcessLock(lockPath)).rejects.toThrow("Process lock already held");
});

test("acquireProcessLock takes over a lock written by our own pid (bun --watch reentry)", async () => {
  const lockPath = createTempLockPath();
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));

  const lock = await acquireProcessLock(lockPath);
  await expect(Bun.file(lockPath).exists()).resolves.toBe(true);
  await lock.release();
});

test("acquireProcessLock replaces stale lock files from dead pids", async () => {
  const lockPath = createTempLockPath();
  writeFileSync(lockPath, JSON.stringify({ pid: 999999, createdAt: "2026-01-01T00:00:00.000Z" }));

  const lock = await acquireProcessLock(lockPath);
  await expect(Bun.file(lockPath).exists()).resolves.toBe(true);

  await lock.release();
  await expect(Bun.file(lockPath).exists()).resolves.toBe(false);
});

