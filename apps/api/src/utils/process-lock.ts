import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";

type LockFilePayload = {
  pid: number;
  createdAt: string;
};

export type ProcessLockHandle = {
  lockPath: string;
  release: () => Promise<void>;
};

function parsePidFromLockFile(raw: string) {
  try {
    const parsed = JSON.parse(raw) as Partial<LockFilePayload>;
    return typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0
      ? parsed.pid
      : undefined;
  } catch {
    const asNumber = Number(raw.trim());
    return Number.isInteger(asNumber) && asNumber > 0 ? asNumber : undefined;
  }
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      return true;
    }
    return false;
  }
}

async function readLockedPid(lockPath: string) {
  try {
    const raw = await readFile(lockPath, "utf8");
    return parsePidFromLockFile(raw);
  } catch {
    return undefined;
  }
}

async function writeFreshLock(lockPath: string) {
  await mkdir(dirname(lockPath), { recursive: true });
  const handle = await open(lockPath, "wx");
  try {
    const payload: LockFilePayload = {
      pid: process.pid,
      createdAt: new Date().toISOString(),
    };
    await handle.writeFile(JSON.stringify(payload), "utf8");
  } finally {
    await handle.close();
  }
}

export async function acquireProcessLock(lockPath: string): Promise<ProcessLockHandle> {
  try {
    await writeFreshLock(lockPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") {
      throw error;
    }

    const lockedPid = await readLockedPid(lockPath);
    // `bun --watch` reruns the script in-process on file changes, so
    // the lock pid we just wrote is OUR OWN pid. Treat that as stale
    // and take over — without this the dev workflow stalls every time
    // a file changes ("Process lock already held by pid <self>").
    // Real cross-process contention still trips the alive check below.
    if (lockedPid && lockedPid !== process.pid && isProcessAlive(lockedPid)) {
      throw new Error(`Process lock already held by pid ${lockedPid} (${lockPath}).`);
    }

    await unlink(lockPath).catch(() => undefined);
    await writeFreshLock(lockPath);
  }

  return {
    lockPath,
    release: async () => {
      await unlink(lockPath).catch(() => undefined);
    },
  };
}

