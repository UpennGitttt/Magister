import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import type { ChangedFileSummary, RuntimeDiffArtifact } from "./safe-apply-types";

const DIFF_COMMAND = [
  "git",
  "diff",
  "--no-color",
  "--binary",
  "--full-index",
  "--find-renames=50%",
] as const;

const DIFF_ARGS = [...DIFF_COMMAND.slice(1)];

type CommandResult = {
  ok: boolean;
  stdout: Buffer;
  stderr: string;
};

type CommandOptions = {
  env?: NodeJS.ProcessEnv;
};

const GIT_COMMAND_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "USERNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
] as const;

function buildGitCommandEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of GIT_COMMAND_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  return env;
}

async function runCommand(
  cwd: string,
  command: string,
  args: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: buildGitCommandEnv(options.env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      resolve({
        ok: false,
        stdout: Buffer.concat(stdout),
        stderr: `${stderr}${error instanceof Error ? error.message : String(error)}`,
      });
    });
    child.on("close", (code) => {
      resolve({
        ok: code === 0,
        stdout: Buffer.concat(stdout),
        stderr,
      });
    });
  });
}

async function gitText(cwd: string, args: string[], env?: NodeJS.ProcessEnv) {
  const result = await runCommand(cwd, "git", args, env ? { env } : {});
  return result.ok ? result.stdout.toString("utf8").trim() : "";
}

export async function readGitHeadRevision(workspaceDir: string): Promise<string | null> {
  const value = await gitText(workspaceDir, ["rev-parse", "HEAD"]);
  return value || null;
}

function mapStatus(status: string): ChangedFileSummary["status"] {
  const code = status[0] ?? "";
  if (code === "A") return "added";
  if (code === "M") return "modified";
  if (code === "D") return "deleted";
  if (code === "R") return "renamed";
  if (code === "C") return "copied";
  return "unknown";
}

function parseNameStatus(input: string) {
  const rows = new Map<string, Pick<ChangedFileSummary, "path" | "oldPath" | "status">>();
  for (const line of input.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const statusCode = parts[0] ?? "";
    if (statusCode.startsWith("R") || statusCode.startsWith("C")) {
      const oldPath = parts[1] ?? "";
      const path = parts[2] ?? oldPath;
      rows.set(path, { path, oldPath, status: mapStatus(statusCode) });
      continue;
    }
    const path = parts[1] ?? "";
    if (!path) continue;
    rows.set(path, { path, status: mapStatus(statusCode) });
  }
  return rows;
}

function parseNumstat(input: string) {
  const rows = new Map<string, { additions: number; deletions: number; isBinary: boolean }>();
  for (const line of input.split("\n")) {
    if (!line.trim()) continue;
    const [rawAdditions, rawDeletions, ...pathParts] = line.split("\t");
    const path = pathParts.join("\t");
    if (!path) continue;
    const isBinary = rawAdditions === "-" || rawDeletions === "-";
    rows.set(path, {
      additions: isBinary ? 0 : Number.parseInt(rawAdditions ?? "0", 10) || 0,
      deletions: isBinary ? 0 : Number.parseInt(rawDeletions ?? "0", 10) || 0,
      isBinary,
    });
  }
  return rows;
}

function parseExecutablePaths(summary: string) {
  const paths = new Set<string>();
  for (const line of summary.split("\n")) {
    const trimmed = line.trim();
    let match = trimmed.match(/^(?:create mode|mode change \d+ =>) 100755 (.+)$/);
    if (match?.[1]) {
      paths.add(match[1]);
      continue;
    }
    match = trimmed.match(/^mode change 100\d+ => 100755 (.+)$/);
    if (match?.[1]) {
      paths.add(match[1]);
    }
  }
  return paths;
}

function buildDiffArgs(baseRevision: string | null | undefined, extraArgs: string[] = []) {
  return [
    "diff",
    ...extraArgs,
    ...(baseRevision ? [baseRevision] : []),
  ];
}

function buildPatchDiffArgs(baseRevision: string | null | undefined) {
  return buildDiffArgs(baseRevision, DIFF_ARGS.slice(1));
}

function isUcmInternalUntrackedPath(path: string) {
  return path === ".magister" || path.startsWith(".magister/");
}

async function listUntrackedFiles(workspaceDir: string): Promise<string[]> {
  const result = await runCommand(workspaceDir, "git", [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  if (!result.ok) return [];
  return result.stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .filter((entry) => entry.startsWith("?? "))
    .map((entry) => entry.slice(3))
    .filter((path) => !isUcmInternalUntrackedPath(path))
    .filter((path) => path.length > 0);
}

async function prepareDiffIndexEnv(input: {
  workspaceDir: string;
  artifactsDir: string;
  artifactId: string;
}): Promise<NodeJS.ProcessEnv> {
  const indexPath = await gitText(input.workspaceDir, ["rev-parse", "--git-path", "index"]);
  const sourceIndexPath = isAbsolute(indexPath) ? indexPath : join(input.workspaceDir, indexPath);
  const tempIndexPath = join(input.artifactsDir, `${input.artifactId}.index`);
  const env: NodeJS.ProcessEnv = { GIT_INDEX_FILE: tempIndexPath };

  await copyFile(sourceIndexPath, tempIndexPath).catch(async () => {
    await runCommand(input.workspaceDir, "git", ["read-tree", "HEAD"], { env });
  });

  const untrackedFiles = await listUntrackedFiles(input.workspaceDir);
  if (untrackedFiles.length > 0) {
    await runCommand(input.workspaceDir, "git", [
      "add",
      "--intent-to-add",
      "--",
      ...untrackedFiles,
    ], { env });
  }

  return env;
}

async function summarizeChangedFiles(
  workspaceDir: string,
  patchBytes: Buffer,
  baseRevision: string | null | undefined,
  env: NodeJS.ProcessEnv,
) {
  const [nameStatus, numstat, summary] = await Promise.all([
    gitText(workspaceDir, buildDiffArgs(baseRevision, ["--name-status", "--find-renames=50%"]), env),
    gitText(workspaceDir, buildDiffArgs(baseRevision, ["--numstat", "--find-renames=50%"]), env),
    gitText(workspaceDir, buildDiffArgs(baseRevision, ["--summary", "--find-renames=50%"]), env),
  ]);
  const statusByPath = parseNameStatus(nameStatus);
  const numstatByPath = parseNumstat(numstat);
  const executablePaths = parseExecutablePaths(summary);
  const patchText = patchBytes.toString("utf8");
  const paths = new Set([...statusByPath.keys(), ...numstatByPath.keys()]);

  const changedFiles: ChangedFileSummary[] = [...paths].sort().map((path) => {
    const status = statusByPath.get(path);
    const stats = numstatByPath.get(path);
    return {
      path,
      ...(status?.oldPath ? { oldPath: status.oldPath } : {}),
      status: status?.status ?? "unknown",
      additions: stats?.additions ?? 0,
      deletions: stats?.deletions ?? 0,
      isBinary: Boolean(stats?.isBinary) || patchText.includes("GIT binary patch"),
      isExecutable: executablePaths.has(path),
    };
  });

  return changedFiles;
}

export async function collectRuntimeDiff(input: {
  workspaceDir: string;
  artifactsDir: string;
  artifactId: string;
  baseRevision?: string | null;
}): Promise<RuntimeDiffArtifact> {
  await mkdir(input.artifactsDir, { recursive: true });
  const discoveredBaseRevision = input.baseRevision === undefined
    ? await readGitHeadRevision(input.workspaceDir)
    : input.baseRevision;
  const diffEnv = await prepareDiffIndexEnv({
    workspaceDir: input.workspaceDir,
    artifactsDir: input.artifactsDir,
    artifactId: input.artifactId,
  });
  const diffArgs = buildPatchDiffArgs(discoveredBaseRevision);
  const diffResult = await runCommand(input.workspaceDir, "git", diffArgs, { env: diffEnv });
  const patchBytes = diffResult.ok ? diffResult.stdout : Buffer.alloc(0);
  const storageRef = join(input.artifactsDir, `${input.artifactId}.patch`);
  await writeFile(storageRef, patchBytes);

  const [gitVersion, changedFiles] = await Promise.all([
    gitText(input.workspaceDir, ["--version"]),
    summarizeChangedFiles(input.workspaceDir, patchBytes, discoveredBaseRevision, diffEnv),
  ]);

  const addedLines = changedFiles.reduce((sum, file) => sum + file.additions, 0);
  const removedLines = changedFiles.reduce((sum, file) => sum + file.deletions, 0);

  return {
    artifactId: input.artifactId,
    artifactType: "runtime_diff",
    storageKind: "file",
    storageRef,
    diffHash: createHash("sha256").update(patchBytes).digest("hex"),
    diffAlgorithm: {
      command: ["git", ...diffArgs],
      gitVersion,
      hash: "sha256",
    },
    baseRevision: discoveredBaseRevision,
    changedFiles,
    addedLines,
    removedLines,
    isEmpty: patchBytes.length === 0,
  };
}
