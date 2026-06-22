import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

const DEFAULT_APPLY_LOCK_TTL_MS = 10 * 60 * 1000;

export class ApplyLockBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApplyLockBusyError";
  }
}

export type ApplyLockHandle = {
  lockPath: string;
  release(): Promise<void>;
};

export async function acquireApplyLock(input: {
  workspaceId: string;
  workspacePath: string;
  reviewId: string;
  ttlMs?: number;
  now?: () => Date;
}): Promise<ApplyLockHandle> {
  const workspacePath = resolve(input.workspacePath);
  const lockDir = join(workspacePath, ".magister", "safe-apply", "apply-locks");
  const lockName = `${createHash("sha256").update(workspacePath).digest("hex").slice(0, 24)}.lock`;
  const lockPath = join(lockDir, lockName);
  const ttlMs = input.ttlMs ?? DEFAULT_APPLY_LOCK_TTL_MS;
  const now = input.now?.() ?? new Date();
  const ownerToken = randomUUID();
  await mkdir(lockDir, { recursive: true });

  try {
    await writeLockFile(lockPath, {
      workspaceId: input.workspaceId,
      workspacePath,
      reviewId: input.reviewId,
      pid: process.pid,
      ownerToken,
      createdAt: now.toISOString(),
    });
  } catch (error) {
    if (!isAlreadyExistsError(error)) {
      throw error;
    }
    const existing = await readExistingLock(lockPath);
    const createdAtMs = existing?.createdAt ? Date.parse(existing.createdAt) : 0;
    const ageMs = Number.isFinite(createdAtMs) ? Math.max(0, now.getTime() - createdAtMs) : ttlMs + 1;
    if (existing?.pid && isProcessAlive(existing.pid) && ageMs <= ttlMs) {
      throw new ApplyLockBusyError(`Apply lock is already held for workspace ${input.workspaceId}`);
    }
    await unlink(lockPath).catch(() => undefined);
    try {
      await writeLockFile(lockPath, {
        workspaceId: input.workspaceId,
        workspacePath,
        reviewId: input.reviewId,
        pid: process.pid,
        ownerToken,
        createdAt: now.toISOString(),
      });
    } catch (secondError) {
      if (isAlreadyExistsError(secondError)) {
        throw new ApplyLockBusyError(`Apply lock is already held for workspace ${input.workspaceId}`);
      }
      throw secondError;
    }
  }

  return {
    lockPath,
    release: async () => {
      const existing = await readExistingLock(lockPath);
      if (existing?.ownerToken === ownerToken) {
        await unlink(lockPath).catch(() => undefined);
      }
    },
  };
}

async function writeLockFile(lockPath: string, payload: Record<string, unknown>) {
  const handle = await open(lockPath, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(payload)}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

async function readExistingLock(lockPath: string): Promise<{ pid?: number; createdAt?: string; ownerToken?: string } | null> {
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    return {
      ...(typeof record.pid === "number" ? { pid: record.pid } : {}),
      ...(typeof record.createdAt === "string" ? { createdAt: record.createdAt } : {}),
      ...(typeof record.ownerToken === "string" ? { ownerToken: record.ownerToken } : {}),
    };
  } catch {
    return null;
  }
}

function isAlreadyExistsError(error: unknown) {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "EEXIST";
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
