/**
 * Magister-pushed ledger — tracks which MCP servers Magister itself wrote to
 * each CLI's config. Without this, the propagation logic would
 * silently delete servers the user added directly via `codex mcp
 * add` / `claude mcp add-json` etc. (kimi I1 fix from plan v2 review).
 *
 * Storage: JSON file at `<cwd>/.magister/cli-bridge-pushed.json`,
 * gitignored. Atomic write + proper-lockfile-protected R-M-W.
 *
 * Schema:
 *   { entries: [{ cli, name, configHash, pushedAt }] }
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import lockfile from "proper-lockfile";

import type { CliRuntime } from "./types";

export type PushedEntry = {
  cli: CliRuntime;
  name: string;
  configHash: string;     // sha256 of canonical configJson — drift detection
  pushedAt: number;
};

type Ledger = { entries: PushedEntry[] };

function ledgerPath(cwd: string = process.cwd()): string {
  return join(cwd, ".magister", "cli-bridge-pushed.json");
}

async function readLedger(path: string): Promise<Ledger> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as Ledger;
  } catch {
    return { entries: [] };
  }
}

async function writeLedger(path: string, ledger: Ledger): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(ledger, null, 2), "utf8");
  await rename(tmp, path);
}

async function withLock<T>(path: string, op: () => Promise<T>): Promise<T> {
  // proper-lockfile requires the lock target to exist. Ensure the
  // ledger file exists (touch if not) before acquiring.
  try {
    await readFile(path, "utf8");
  } catch {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ entries: [] }, null, 2), "utf8").catch(() => undefined);
  }
  let release: (() => Promise<void>) | null = null;
  try {
    release = await lockfile.lock(path, {
      retries: { retries: 5, factor: 2, minTimeout: 100, maxTimeout: 2000 },
      stale: 10_000,
      realpath: false,
    });
  } catch {
    // If we can't acquire the lock, proceed best-effort. Magister is
    // single-user; lock contention is rare.
    release = null;
  }
  try {
    return await op();
  } finally {
    if (release) await release().catch(() => undefined);
  }
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Record that Magister pushed this server to this CLI. Idempotent —
 * re-marking the same (cli, name) updates configHash + pushedAt.
 */
export async function markPushed(
  cli: CliRuntime,
  name: string,
  configJson: string,
  cwd?: string,
): Promise<void> {
  const path = ledgerPath(cwd);
  await withLock(path, async () => {
    const ledger = await readLedger(path);
    const hash = await sha256(configJson);
    const idx = ledger.entries.findIndex((e) => e.cli === cli && e.name === name);
    const entry: PushedEntry = { cli, name, configHash: hash, pushedAt: Date.now() };
    if (idx >= 0) ledger.entries[idx] = entry;
    else ledger.entries.push(entry);
    await writeLedger(path, ledger);
  });
}

/**
 * Drop a pushed-record after Magister removed the server from this CLI.
 */
export async function unmarkPushed(
  cli: CliRuntime,
  name: string,
  cwd?: string,
): Promise<void> {
  const path = ledgerPath(cwd);
  await withLock(path, async () => {
    const ledger = await readLedger(path);
    const next = ledger.entries.filter((e) => !(e.cli === cli && e.name === name));
    if (next.length !== ledger.entries.length) {
      await writeLedger(path, { entries: next });
    }
  });
}

/**
 * Whether Magister itself pushed (cli, name). Drives the safety gate in
 * propagateMcpToClis: only call removeXxx if isUcmPushed returns
 * true; otherwise the user installed it directly and we never
 * touch it.
 */
export async function isUcmPushed(
  cli: CliRuntime,
  name: string,
  cwd?: string,
): Promise<boolean> {
  const ledger = await readLedger(ledgerPath(cwd));
  return ledger.entries.some((e) => e.cli === cli && e.name === name);
}

/**
 * Read the full ledger. Used by drift detection to compare ledger
 * vs scan output (Stage 4).
 */
export async function readPushedLedger(cwd?: string): Promise<PushedEntry[]> {
  const ledger = await readLedger(ledgerPath(cwd));
  return ledger.entries;
}
