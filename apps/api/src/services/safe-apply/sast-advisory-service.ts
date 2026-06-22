import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { getMagisterEnv } from "../../lib/env";
import type {
  RuntimeDiffArtifact,
  SastAdvisoryFinding,
  SastAdvisoryResult,
} from "./safe-apply-types";

type SastAdvisoryConfig = {
  enabled?: boolean;
  command?: string;
  args?: string[];
  timeoutMs?: number;
};

const DEFAULT_SAST_COMMAND = "semgrep";
const DEFAULT_SAST_ARGS = ["--json", "--quiet", "--config", "auto"] as const;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_FINDINGS = 50;
const TIMEOUT_KILL_GRACE_MS = 250;

const SAST_COMMAND_ENV_ALLOWLIST = [
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

export function parseSemgrepJson(raw: string): SastAdvisoryFinding[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.results)) {
    return [];
  }

  return parsed.results.slice(0, MAX_FINDINGS).map((item): SastAdvisoryFinding | null => {
    if (!isRecord(item)) return null;
    const extra = isRecord(item.extra) ? item.extra : {};
    const start = isRecord(item.start) ? item.start : {};
    const ruleId = stringValue(item.check_id) ?? stringValue(item.checkId) ?? "unknown";
    const path = stringValue(item.path) ?? "unknown";
    const message = stringValue(extra.message) ?? stringValue(item.message) ?? ruleId;
    const metadata = isRecord(extra.metadata) ? extra.metadata : {};
    return {
      scanner: "semgrep",
      ruleId,
      severity: normalizeSeverity(stringValue(extra.severity)),
      path,
      line: numberValue(start.line),
      message,
      metadata,
    };
  }).filter((item): item is SastAdvisoryFinding => item !== null);
}

export async function runSastAdvisory(input: {
  workspaceDir: string;
  diffArtifact: RuntimeDiffArtifact;
  config?: SastAdvisoryConfig;
  now?: () => Date;
}): Promise<SastAdvisoryResult> {
  const startedAt = input.now?.() ?? new Date();
  const startedMs = Date.now();
  const config = resolveConfig(input.config);

  if (!config.enabled) {
    return result({
      status: "skipped",
      scanner: "none",
      reason: "not_configured",
      findings: [],
      command: null,
      startedAt,
      startedMs,
    });
  }

  const scannableFiles = await listScannableFiles(input.workspaceDir, input.diffArtifact);
  if (scannableFiles.length === 0) {
    return result({
      status: "skipped",
      scanner: "semgrep",
      reason: "no_scannable_files",
      findings: [],
      command: [config.command, ...config.args],
      startedAt,
      startedMs,
    });
  }

  const fileArgs = ["--", ...scannableFiles];
  const command = [config.command, ...config.args, ...fileArgs];
  const execution = await runCommand({
    cwd: input.workspaceDir,
    command: config.command,
    args: [...config.args, ...fileArgs],
    timeoutMs: config.timeoutMs,
  });

  if (execution.timedOut) {
    return result({
      status: "timed_out",
      scanner: "semgrep",
      reason: `SAST scanner timed out after ${config.timeoutMs}ms`,
      findings: [],
      command,
      startedAt,
      startedMs,
    });
  }

  let findings: SastAdvisoryFinding[] = [];
  try {
    findings = parseSemgrepJson(execution.stdout);
  } catch (error) {
    if (execution.exitCode === 0) {
      return result({
        status: "error",
        scanner: "semgrep",
        reason: `Unable to parse SAST output: ${error instanceof Error ? error.message : String(error)}`,
        findings: [],
        command,
        startedAt,
        startedMs,
      });
    }
  }

  if (findings.length > 0) {
    return result({
      status: "findings",
      scanner: "semgrep",
      reason: null,
      findings,
      command,
      startedAt,
      startedMs,
    });
  }

  if (execution.exitCode !== 0) {
    return result({
      status: "error",
      scanner: "semgrep",
      reason: execution.stderr || `SAST scanner exited with code ${execution.exitCode}`,
      findings: [],
      command,
      startedAt,
      startedMs,
    });
  }

  return result({
    status: "passed",
    scanner: "semgrep",
    reason: null,
    findings: [],
    command,
    startedAt,
    startedMs,
  });
}

function resolveConfig(input: SastAdvisoryConfig | undefined): Required<SastAdvisoryConfig> {
  const enabled = input?.enabled ?? getMagisterEnv("MAGISTER_SAFE_APPLY_SAST_ENABLED") === "1";
  return {
    enabled,
    command: input?.command ?? getMagisterEnv("MAGISTER_SAFE_APPLY_SAST_COMMAND") ?? DEFAULT_SAST_COMMAND,
    args: input?.args ?? parseArgsJson(getMagisterEnv("MAGISTER_SAFE_APPLY_SAST_ARGS_JSON")) ?? [...DEFAULT_SAST_ARGS],
    timeoutMs: input?.timeoutMs ?? parsePositiveInt(getMagisterEnv("MAGISTER_SAFE_APPLY_SAST_TIMEOUT_MS")) ?? DEFAULT_TIMEOUT_MS,
  };
}

function parseArgsJson(value: string | undefined): string[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function listScannableFiles(workspaceDir: string, diffArtifact: RuntimeDiffArtifact) {
  const workspaceRoot = resolve(workspaceDir);
  const candidates = diffArtifact.changedFiles
    .filter((file) => file.status !== "deleted")
    .filter((file) => !file.isBinary)
    .map((file) => file.path);
  const scannable: string[] = [];
  for (const path of candidates) {
    const absolutePath = resolve(workspaceRoot, path);
    if (!isInsideDirectory(workspaceRoot, absolutePath)) continue;
    await access(absolutePath)
      .then(() => scannable.push(path))
      .catch(() => undefined);
  }
  return scannable;
}

function isInsideDirectory(parent: string, child: string) {
  const rel = relative(parent, child);
  return rel === "" || (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel));
}

function buildSastCommandEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAST_COMMAND_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

async function runCommand(input: {
  cwd: string;
  command: string;
  args: string[];
  timeoutMs: number;
}): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return await new Promise((resolve) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: buildSastCommandEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | null = null;
    const settle = (result: { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
        settle({ exitCode: null, stdout, stderr: stderr.trim(), timedOut: true });
      }, TIMEOUT_KILL_GRACE_MS);
    }, input.timeoutMs);

    child.stdout.on("data", (chunk) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += String(chunk);
      if (stdout.length > MAX_OUTPUT_BYTES) stdout = stdout.slice(0, MAX_OUTPUT_BYTES);
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += String(chunk);
      if (stderr.length > MAX_OUTPUT_BYTES) stderr = stderr.slice(0, MAX_OUTPUT_BYTES);
    });
    child.on("error", (error) => {
      settle({
        exitCode: null,
        stdout,
        stderr: `${stderr}${error instanceof Error ? error.message : String(error)}`,
        timedOut,
      });
    });
    child.on("close", (code) => {
      settle({ exitCode: code, stdout, stderr: stderr.trim(), timedOut });
    });
  });
}

function result(input: {
  status: SastAdvisoryResult["status"];
  scanner: SastAdvisoryResult["scanner"];
  reason: string | null;
  findings: SastAdvisoryFinding[];
  command: string[] | null;
  startedAt: Date;
  startedMs: number;
}): SastAdvisoryResult {
  const durationMs = Math.max(0, Date.now() - input.startedMs);
  const finishedAt = new Date(input.startedAt.getTime() + durationMs);
  return {
    status: input.status,
    scanner: input.scanner,
    reason: input.reason,
    findings: input.findings,
    command: input.command,
    durationMs,
    startedAt: input.startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
  };
}

function normalizeSeverity(value: string | null): SastAdvisoryFinding["severity"] {
  switch (value?.toUpperCase()) {
    case "INFO":
      return "info";
    case "LOW":
    case "MEDIUM":
    case "WARNING":
      return "warning";
    case "HIGH":
    case "ERROR":
      return "error";
    case "CRITICAL":
      return "critical";
    default:
      return "unknown";
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
