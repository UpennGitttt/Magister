import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { spawnProcess } from "../../lib/platform/spawn";
import type { CliRuntime } from "./types";

export type CliExecutableSource =
  | "explicit"
  | "env"
  | "path"
  | "login_shell"
  | "candidate"
  | "logical";

export type CliExecutableResolution = {
  runtime: CliRuntime;
  command: string;
  logicalCommand: string;
  source: CliExecutableSource;
};

type ResolveOptions = {
  env?: NodeJS.ProcessEnv;
  candidates?: string[];
};

const CLI_LOGICAL_COMMAND: Record<CliRuntime, string> = {
  codex: "codex",
  "claude-code": "claude",
  opencode: "opencode",
};

const CLI_ENV_OVERRIDE: Record<CliRuntime, string> = {
  codex: "MAGISTER_CODEX_BIN",
  "claude-code": "MAGISTER_CLAUDE_CODE_BIN",
  opencode: "MAGISTER_OPENCODE_BIN",
};

const CLI_LEGACY_LINUX_DEFAULT: Record<CliRuntime, string> = {
  codex: "/usr/bin/codex",
  "claude-code": "/usr/bin/claude",
  opencode: "/usr/bin/opencode",
};

function defaultCandidates(runtime: CliRuntime, home: string): string[] {
  const logical = CLI_LOGICAL_COMMAND[runtime];
  const shared = [
    join(home, ".local", "bin", logical),
    join(home, ".npm-global", "bin", logical),
    `/opt/homebrew/bin/${logical}`,
    `/usr/local/bin/${logical}`,
  ];

  if (runtime === "opencode") {
    return [join(home, ".opencode", "bin", "opencode"), ...shared];
  }

  if (runtime === "claude-code") {
    return [
      "/Applications/cmux.app/Contents/Resources/bin/claude",
      join(home, ".claude", "local", "claude"),
      ...shared,
    ];
  }

  return shared;
}

async function commandFromProbe(cmd: string[]): Promise<string | null> {
  try {
    const proc = spawnProcess(cmd);
    const [exitCode, stdout] = await Promise.all([proc.exited, proc.stdoutText()]);
    const resolved = stdout.split(/\r?\n/)[0]?.trim();
    return exitCode === 0 && resolved ? resolved : null;
  } catch {
    return null;
  }
}

async function executableCandidate(path: string): Promise<string | null> {
  try {
    await access(path, constants.X_OK);
    return path;
  } catch {
    return null;
  }
}

export function getLogicalCliCommand(runtime: CliRuntime): string {
  return CLI_LOGICAL_COMMAND[runtime];
}

export async function resolveCliExecutable(
  runtime: CliRuntime,
  commandPath?: string | null,
  options: ResolveOptions = {},
): Promise<CliExecutableResolution> {
  const logicalCommand = getLogicalCliCommand(runtime);
  const explicit = commandPath?.trim();
  if (explicit && explicit !== logicalCommand && explicit !== CLI_LEGACY_LINUX_DEFAULT[runtime]) {
    return { runtime, command: explicit, logicalCommand, source: "explicit" };
  }

  const env = options.env ?? process.env;
  const envPath = env[CLI_ENV_OVERRIDE[runtime]]?.trim();
  if (envPath) {
    return { runtime, command: envPath, logicalCommand, source: "env" };
  }

  const directPath = await commandFromProbe(["which", logicalCommand]);
  if (directPath) {
    return { runtime, command: directPath, logicalCommand, source: "path" };
  }

  const loginShellPath = await commandFromProbe(["bash", "-lc", `command -v ${logicalCommand}`]);
  if (loginShellPath) {
    return { runtime, command: loginShellPath, logicalCommand, source: "login_shell" };
  }

  const candidates = options.candidates ?? defaultCandidates(runtime, env.HOME || homedir());
  for (const candidate of candidates) {
    const executable = await executableCandidate(candidate);
    if (executable) {
      return { runtime, command: executable, logicalCommand, source: "candidate" };
    }
  }

  return { runtime, command: logicalCommand, logicalCommand, source: "logical" };
}
