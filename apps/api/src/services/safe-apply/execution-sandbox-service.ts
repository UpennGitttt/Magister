import { constants, existsSync, readdirSync, realpathSync } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

import { getMagisterEnv } from "../../lib/env";
import { parseExtraAccessRoots } from "../../lib/extra-access-roots";
import type { FileSystemEntry } from "./additional-permissions";
import { classifyPathSensitivity, type ClassifyPathOptions } from "./path-sensitivity";
import type {
  ExecutionSandboxMetadata,
  ExecutionSandboxMode,
  ExecutionSandboxProviderPreference,
  RuntimeSource,
} from "./safe-apply-types";

export type ExecutionSandboxConfig = {
  mode: ExecutionSandboxMode;
  provider: ExecutionSandboxProviderPreference;
  network: ExecutionSandboxMetadata["network"];
  env?: NodeJS.ProcessEnv;
  commandResolver?: (command: string, env: NodeJS.ProcessEnv) => Promise<string | null>;
};

export type AssessExecutionSandboxInput = {
  runtimeSource: RuntimeSource;
  runtimeWorkspaceDir: string;
  baseWorkspaceDir?: string | null;
  runtimeHomeDir: string;
  runtimeTmpDir: string;
  homeIsolated: boolean;
  config?: Partial<ExecutionSandboxConfig>;
};

export type BubblewrapSandboxCommandInput = {
  bwrapCommandPath: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  baseWorkspaceDir: string | null;
  runtimeWorkspaceDir: string;
  runtimeHomeDir: string;
  runtimeTmpDir: string;
  network: ExecutionSandboxMetadata["network"];
  systemReadOnlyBinds?: string[];
  /**
   * Sandbox-elevation v4.3 §4.4 — additional file_system entries
   * granted via `with_additional_permissions` (or inherited from
   * trust-ledger). Each entry's `path` is the canonical path that
   * was approved; we re-canonicalize at bind time as TOCTOU defense.
   * Empty / undefined → no extra binds added.
   */
  extraBinds?: ReadonlyArray<{ path: string; access: "read" | "write" }>;
  /**
   * Path-sensitivity classifier options (homeDir, magisterInstallDir,
   * workspaceRoot) so the bind-time defense-in-depth check uses the
   * same protected-path table as approval-time validation.
   */
  classifyOptions?: ClassifyPathOptions;
  /**
   * v4.3 §4.4 — override the metadata network setting. When
   * `additional_permissions.network.enabled === true`, the caller
   * passes true here to override `network === "disabled"` to allow
   * host network for this command.
   */
  allowNetwork?: boolean;
};

export type ExecutionSandboxCommandInput = Omit<
  BubblewrapSandboxCommandInput,
  "bwrapCommandPath" | "network"
> & {
  executionSandbox: ExecutionSandboxMetadata | null;
  /**
   * Spec §1 V1.1 (2026-05-17): opt-in to sandbox-wrap even when
   * `baseWorkspaceDir` equals `runtimeWorkspaceDir` (i.e., leader
   * is running in the user's cwd, no separate worktree). When set,
   * the bypass at `runtime_workspace_not_isolated` is skipped, and
   * bwrap binds the workspace RW (no separate RO base bind). The
   * leader still benefits from sandbox isolation: env allowlist,
   * separate `/tmp`/`HOME`, optional network unshare. The trade-off
   * is that writes to the workspace are NOT diff'd by safe-apply
   * (no worktree → no review draft), so the user sees changes land
   * directly in their cwd.
   *
   * Used by the leader's `bash` tool when no worktree is configured,
   * so the sandbox escalation protocol's CRITICAL hard-block and
   * MEDIUM-default-sandboxed semantics actually engage in the
   * everyday "leader runs in repo cwd" workflow (not just in V4B's
   * safe-apply worktree mode).
   */
  allowSameWorkspace?: boolean;
};

export type ExecutionSandboxCommandPlan =
  | {
      type: "unwrapped";
      command: string;
      args: string[];
      cwd: string;
      env: Record<string, string>;
      executionSandbox: ExecutionSandboxMetadata | null;
    }
  | {
      type: "wrapped";
      command: string;
      args: string[];
      cwd: string;
      env: Record<string, string>;
      executionSandbox: ExecutionSandboxMetadata;
    }
  | {
      type: "failed";
      command: string;
      args: string[];
      cwd: string;
      env: Record<string, string>;
      executionSandbox: ExecutionSandboxMetadata | null;
      failureReason: string;
    };

const VALID_MODES = new Set<ExecutionSandboxMode>(["off", "optional", "required"]);
const VALID_PROVIDERS = new Set<ExecutionSandboxProviderPreference>(["auto", "bubblewrap", "none"]);
const VALID_NETWORK = new Set<ExecutionSandboxMetadata["network"]>(["host", "disabled", "unknown"]);
const DEFAULT_SYSTEM_READ_ONLY_BINDS = ["/usr", "/bin", "/lib", "/lib64", "/etc"];

/** Resolve the host's `/etc/resolv.conf` symlink target so we can bind
 *  the REAL file (not the dangling-inside-sandbox link) over
 *  `/etc/resolv.conf` inside the sandbox.
 *
 *  Why this is needed: most modern Linux distros symlink
 *  `/etc/resolv.conf → /run/systemd/resolve/resolv.conf` (or
 *  `/run/NetworkManager/resolv.conf`). The bwrap sandbox binds
 *  `/etc` read-only from host, so the symlink IS visible inside,
 *  but `/run/` is NOT bound — making the link dangle. DNS breaks for
 *  every tool that resolves names (curl, npm, pip, uv, git over
 *  https, ...). Pre-fix workaround was to write a fresh resolv.conf
 *  into the sandbox tmp on every bash invocation. This is the proper
 *  one-time fix: bind the actual file the host's symlink chain
 *  terminates at, overriding the link inside the sandbox.
 *
 *  Returns null when we can't determine a stable target (no resolv.conf,
 *  unreadable, etc.) — caller falls through with whatever was already
 *  in the bind list. */
export function resolveHostDnsConfigPath(): string | null {
  try {
    // realpath chases the symlink chain. If the target exists and is
    // a real file we get its canonical absolute path.
    const real = realpathSync("/etc/resolv.conf");
    if (real && existsSync(real)) return real;
    return null;
  } catch {
    return null;
  }
}

export function resolveExecutionSandboxConfig(
  env: NodeJS.ProcessEnv = process.env,
): Omit<ExecutionSandboxConfig, "env" | "commandResolver"> {
  return {
    // Spec §1.10 locked decision #1 (2026-05-17) — default
    // `MAGISTER_EXECUTION_SANDBOX_MODE=optional`. bwrap is used when
    // available; falls back to unsandboxed if missing. Pre-fix,
    // the default was "off", which left the entire sandbox
    // escalation protocol (CRITICAL hard-block, env allowlist,
    // /tmp isolation) inactive — leader prompt and approval-
    // pipeline implied sandboxing was on, but the bwrap wrap
    // never engaged. Codex final review #1 (2026-05-17): flipping
    // the default brings runtime behavior in line with the
    // shipped spec + system prompt.
    mode: parseConfigValue(getMagisterEnv("MAGISTER_EXECUTION_SANDBOX_MODE", env), VALID_MODES, "optional"),
    provider: parseConfigValue(getMagisterEnv("MAGISTER_EXECUTION_SANDBOX_PROVIDER", env), VALID_PROVIDERS, "auto"),
    network: parseConfigValue(getMagisterEnv("MAGISTER_EXECUTION_SANDBOX_NETWORK", env), VALID_NETWORK, "host"),
  };
}

export async function assessExecutionSandbox(
  input: AssessExecutionSandboxInput,
): Promise<ExecutionSandboxMetadata> {
  const defaults = resolveExecutionSandboxConfig(input.config?.env ?? process.env);
  const config: ExecutionSandboxConfig = {
    mode: input.config?.mode ?? defaults.mode,
    provider: input.config?.provider ?? defaults.provider,
    network: input.config?.network ?? defaults.network,
    ...(input.config?.env ? { env: input.config.env } : {}),
    ...(input.config?.commandResolver ? { commandResolver: input.config.commandResolver } : {}),
  };
  const filesystem = {
    mainWorkspace: "not_isolated" as const,
    runtimeWorkspace: "host_writable" as const,
    home: input.homeIsolated ? "isolated" as const : "host" as const,
    // /tmp shares host (was "isolated"). See
    // buildBubblewrapSandboxCommand for the rationale: localhost
    // single-operator workflow needs `tail /tmp/foo.log` to work
    // across the sandbox boundary, and detached children that log
    // to /tmp need their FD targets to survive sandbox teardown.
    tmp: "host" as const,
  };

  if (config.mode === "off") {
    return {
      mode: config.mode,
      provider: "none",
      status: "disabled",
      commandPath: null,
      reason: "mode_off",
      network: config.network,
      filesystem,
    };
  }

  if (config.provider === "none") {
    return {
      mode: config.mode,
      provider: "none",
      status: "disabled",
      commandPath: null,
      reason: "provider_none",
      network: config.network,
      filesystem,
    };
  }

  const resolver = config.commandResolver ?? resolveCommandPath;
  const commandPath = await resolver("bwrap", config.env ?? process.env);
  if (!commandPath) {
    return {
      mode: config.mode,
      provider: "bubblewrap",
      status: "unavailable",
      commandPath: null,
      reason: "provider_not_found",
      network: config.network,
      filesystem,
    };
  }

  return {
    mode: config.mode,
    provider: "bubblewrap",
    status: "available",
    commandPath,
    reason: "provider_available_not_wrapping",
    network: config.network,
    filesystem,
  };
}

export function prepareExecutionSandboxCommand(
  input: ExecutionSandboxCommandInput,
): ExecutionSandboxCommandPlan {
  const passthrough = {
    command: input.command,
    args: input.args,
    cwd: input.cwd,
    env: input.env,
  };
  const sandbox = input.executionSandbox;
  if (!sandbox || sandbox.mode === "off") {
    return {
      type: "unwrapped",
      ...passthrough,
      executionSandbox: sandbox,
    };
  }

  if (sandbox.status === "disabled") {
    if (sandbox.mode === "required") {
      return failedPlan(passthrough, sandbox);
    }
    return {
      type: "unwrapped",
      ...passthrough,
      executionSandbox: sandbox,
    };
  }

  if (
    input.baseWorkspaceDir
    && canonicalPath(input.baseWorkspaceDir) === canonicalPath(input.runtimeWorkspaceDir)
    && !input.allowSameWorkspace
  ) {
    // Spec §1 V1.1: pre-fix, leader-in-cwd always bypassed the
    // sandbox here because base === runtime (no worktree).
    // Callers that explicitly opt in via `allowSameWorkspace: true`
    // now keep the sandbox engaged with workspace bound RW.
    const unavailable = {
      ...sandbox,
      status: "unavailable" as const,
      reason: "runtime_workspace_not_isolated",
    };
    if (sandbox.mode === "required") {
      return failedPlan(passthrough, unavailable);
    }
    return {
      type: "unwrapped",
      ...passthrough,
      executionSandbox: unavailable,
    };
  }

  if (sandbox.provider !== "bubblewrap" || sandbox.status !== "available" || !sandbox.commandPath) {
    if (sandbox.mode === "required") {
      return failedPlan(passthrough, sandbox);
    }
    return {
      type: "unwrapped",
      ...passthrough,
      executionSandbox: sandbox,
    };
  }

  // Same-workspace opt-in (spec §1 V1.1) reports the main workspace
  // as `sandbox_writable` since we bind it RW; safe-apply metadata
  // consumers can distinguish this from worktree-isolated mode by
  // observing `mainWorkspace === runtimeWorkspace`.
  const sameWorkspace = input.allowSameWorkspace === true
    && input.baseWorkspaceDir != null
    && canonicalPath(input.baseWorkspaceDir) === canonicalPath(input.runtimeWorkspaceDir);
  const wrappedSandbox: ExecutionSandboxMetadata = {
    ...sandbox,
    status: "active",
    reason: sameWorkspace ? "wrapped_same_workspace" : "wrapped",
    filesystem: {
      mainWorkspace: input.baseWorkspaceDir
        ? (sameWorkspace ? "sandbox_writable" : "read_only")
        : "unknown",
      runtimeWorkspace: "sandbox_writable",
      home: sandbox.filesystem.home,
      tmp: sandbox.filesystem.tmp,
    },
  };
  const wrapped = buildBubblewrapSandboxCommand({
    ...input,
    bwrapCommandPath: sandbox.commandPath,
    network: sandbox.network,
    // Drop the RO base bind when caller opted into same-workspace
    // mode — the RW runtime bind covers the same path and a second
    // RO bind on the same path is at best wasteful and at worst
    // depends on bwrap's bind-order semantics for the final RW/RO
    // outcome (which differs across versions). Skipping is the
    // safe-by-construction choice.
    ...(sameWorkspace ? { baseWorkspaceDir: null } : {}),
  });
  return {
    type: "wrapped",
    command: wrapped.command,
    args: wrapped.args,
    cwd: wrapped.cwd,
    env: wrapped.env,
    executionSandbox: wrappedSandbox,
  };
}

export function buildBubblewrapSandboxCommand(input: BubblewrapSandboxCommandInput): {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /**
   * Sandbox-elevation v4.3 §4.4 + codex A.3 review Q3 — extra-bind
   * paths that returned ENOENT at bind time (approved but no longer
   * exist). Caller surfaces these to the model via
   * `permissionNotices.boundPathMissing` in the bash tool result so
   * the model isn't blind to "I asked for X but X wasn't bound".
   */
  missingExtraBinds: string[];
} {
  // Codex A.3 review HIGH (Q4): when extraBinds is non-empty, the
  // bind-time defense-in-depth deny-list re-check needs valid
  // classifyOptions. Without them, a path that just landed on the
  // critical deny-list (e.g. sandbox-deny.json update) silently
  // re-binds. Fail loud so callers can't quietly skip this.
  if (input.extraBinds && input.extraBinds.length > 0 && !input.classifyOptions) {
    throw new Error(
      "buildBubblewrapSandboxCommand: classifyOptions is required when extraBinds is non-empty (defense-in-depth deny-list re-check needs install-dir + workspace-root)",
    );
  }
  const systemBinds = (input.systemReadOnlyBinds ?? DEFAULT_SYSTEM_READ_ONLY_BINDS)
    .filter((path) => path.length > 0)
    .filter((path, index, paths) => paths.indexOf(path) === index)
    .filter((path) => input.systemReadOnlyBinds ? true : existsSync(path));
  const commandBinds = collectCommandReadOnlyBinds(input.command, input.env);
  const readOnlyBinds = [...systemBinds, ...commandBinds]
    .filter((path, index, paths) => paths.indexOf(path) === index);
  const args = [
    "--die-with-parent",
    "--dev", "/dev",
    "--proc", "/proc",
  ];
  // v4.3 §4.4 — allowNetwork=true overrides metadata "disabled" so the
  // model's per-call `additional_permissions.network.enabled` ask can
  // engage network even when the default sandbox isolated it.
  if (input.network === "disabled" && !input.allowNetwork) {
    args.push("--unshare-net");
  }
  for (const path of readOnlyBinds) {
    args.push("--ro-bind", path, path);
  }
  // MAGISTER_EXTRA_ACCESS_ROOTS — operator-approved roots outside the
  // workspace so the leader's bash/git can read sibling repos etc. ro
  // roots get `--ro-bind`, `:rw` roots get `--bind`. Bound BEFORE the
  // workspace / runtime binds below so an enclosing root (e.g. a parent
  // dir that contains the workspace) is overridden by the more specific
  // workspace RW bind — bwrap resolves overlaps in favour of the later
  // bind. Nothing is hard-coded: empty env → no extra binds at all.
  const extraBoundRoots = new Set(readOnlyBinds);
  for (const extra of parseExtraAccessRoots(input.env)) {
    if (extraBoundRoots.has(extra.root)) continue;
    if (!existsSync(extra.root)) continue;
    extraBoundRoots.add(extra.root);
    args.push(extra.writable ? "--bind" : "--ro-bind", extra.root, extra.root);
  }
  // /tmp shares host. Previously only the per-runtime
  // `runtimeTmpDir` (mkdtemp'd under host /tmp) was bound, which made
  // `/tmp` inside the sandbox an empty bwrap-placeholder with exactly
  // one visible subdir. That broke the common "leader writes a log to
  // /tmp/foo.log then operator tails it from ssh" workflow — the log
  // either landed in the bwrap-tmpfs and vanished, or the write failed
  // outright. Worse: when the sandbox tore down, child processes that
  // had FDs into the sandbox-private /tmp died with it, so
  // `nohup uvicorn ... > /tmp/log &` couldn't survive the bash call's
  // exit.
  //
  // Single-operator localhost model: there's no other tenant to
  // protect /tmp content from, and the operator already has full bash
  // on host. Per-runtime separation is preserved by uniqueness —
  // `runtimeTmpDir` is still `mkdtemp(/tmp, "magister-…-")` so
  // collisions across runtimes are statistically impossible.
  //
  // Bind ordering matters: this fires BEFORE the workspace / home
  // binds below so a workspace that happens to live under /tmp (test
  // fixtures, ad-hoc playground) still gets its specific ro-bind /
  // bind applied on top, overriding the writable /tmp default for
  // that subtree.
  args.push("--bind", "/tmp", "/tmp");
  if (input.baseWorkspaceDir) {
    args.push("--ro-bind", input.baseWorkspaceDir, input.baseWorkspaceDir);
  }
  args.push(
    "--bind", input.runtimeWorkspaceDir, input.runtimeWorkspaceDir,
    "--bind", input.runtimeHomeDir, input.runtimeHomeDir,
  );

  // Sandbox-elevation v4.3 §4.4 — extra binds from
  // `additional_permissions`. Each goes AFTER the system + runtime
  // binds so overlapping bind-paths can intentionally override
  // (e.g. `--bind ~/.cache/uv` lands inside the RO `/home` parent).
  //
  // Defense in depth:
  //  (a) collision check — refuse to bind paths that target the
  //      base/runtime workspace, runtime home, or runtime tmp,
  //      since those have intentionally-set permissions (codex A.3
  //      review Q1 MEDIUM)
  //  (b) re-canonicalize at bind time and verify match — TOCTOU defense
  //  (c) re-classify; refuse critical paths that may have been added
  //      to the deny-list since approval (sandbox-deny.json update)
  const missingExtraBinds: string[] = [];
  if (input.extraBinds && input.extraBinds.length > 0) {
    const reservedTargets = new Set<string>([
      ...(input.baseWorkspaceDir ? [input.baseWorkspaceDir] : []),
      input.runtimeWorkspaceDir,
      input.runtimeHomeDir,
      input.runtimeTmpDir,
    ]);
    for (const bind of input.extraBinds) {
      // (a) Collision check — never let an approved path mutate the
      // runtime-managed bind targets (e.g. write-bind workspace dir,
      // overriding the RO base bind).
      if (reservedTargets.has(bind.path)) {
        throw new Error(
          `extra bind targets a runtime-reserved path (${bind.path}) — refusing to override base/runtime workspace bind`,
        );
      }
      // (b) TOCTOU re-canonicalize
      let canonical: string;
      try {
        canonical = realpathSync.native(bind.path);
      } catch (err) {
        const code = (err as { code?: string } | null)?.code;
        if (code === "ENOENT") {
          // Approved path no longer exists at bind time. Skip the bind
          // but accumulate the path so the caller can surface a
          // model-visible notice (codex A.3 review Q3 MEDIUM).
          missingExtraBinds.push(bind.path);
          continue;
        }
        throw new Error(
          `extra bind canonicalize failed (${code ?? "unknown"}) for approved path — refusing to bind to avoid TOCTOU`,
        );
      }
      if (canonical !== bind.path) {
        throw new Error(
          `extra bind path changed between approval and bind (canonical mismatch) — refusing to bind`,
        );
      }
      // (c) Re-classify defense in depth
      const classification = classifyPathSensitivity(canonical, bind.access, input.classifyOptions);
      if (classification.level === "critical") {
        throw new Error(
          `extra bind path is now on the critical deny-list (${classification.reason}) — refusing to bind even though it was approved`,
        );
      }
      args.push(bind.access === "write" ? "--bind" : "--ro-bind", canonical, canonical);
    }
  }
  // DNS fix. /etc/resolv.conf is typically a symlink to
  // /run/systemd/resolve/resolv.conf. The sandbox binds /etc but not
  // /run, so the symlink dangles. We must create the parent dirs with
  // --dir then bind the real file at its canonical path.
  const hostDnsPath = resolveHostDnsConfigPath();
  if (hostDnsPath && hostDnsPath.startsWith("/")) {
    const parentSegments = dirname(hostDnsPath).split("/").filter(Boolean);
    let accumulated = "";
    for (const seg of parentSegments) {
      accumulated += `/${seg}`;
      args.push("--dir", accumulated);
    }
    args.push("--ro-bind", hostDnsPath, hostDnsPath);
  }
  // Credential masking — kernel-level, applied LAST so it overrides the
  // workspace RW bind above. Even though the workspace is bound writable,
  // a sandboxed command (incl. a prompt-injected one) must not be able to
  // read live provider keys. The string-pattern sensitive-path bash gate is
  // honest-actor-only and trivially obfuscated; this is the structural deny.
  // /dev/null overlay → the file reads empty; tmpfs over .magister → the
  // runtime-state dir reads empty.
  pushSensitivePathMasks(args, input.runtimeWorkspaceDir);
  if (input.baseWorkspaceDir && input.baseWorkspaceDir !== input.runtimeWorkspaceDir) {
    pushSensitivePathMasks(args, input.baseWorkspaceDir);
  }

  args.push(
    "--chdir", input.cwd,
    "--",
    input.command,
    ...input.args,
  );

  return {
    command: input.bwrapCommandPath,
    args,
    cwd: input.cwd,
    env: input.env,
    missingExtraBinds,
  };
}

/** Overlay credential-bearing paths inside a bound workspace with empty
 *  mounts so a sandboxed command cannot read live secrets, regardless of
 *  the RW workspace bind. Files → `/dev/null` (read as empty); the
 *  `.magister` runtime-state dir → tmpfs (read as empty). Only masks paths
 *  that exist on the host; `.env.example` is left visible (no secrets). */
function pushSensitivePathMasks(args: string[], dir: string | undefined): void {
  if (!dir) return;
  const fileMasks = new Set<string>(["config/secrets.json"]);
  try {
    for (const name of readdirSync(dir)) {
      if (name === ".env" || (name.startsWith(".env.") && name !== ".env.example")) {
        fileMasks.add(name);
      }
    }
  } catch {
    // dir unreadable — nothing to mask
  }
  for (const rel of fileMasks) {
    const target = join(dir, rel);
    if (existsSync(target)) args.push("--ro-bind", "/dev/null", target);
  }
  const magisterDir = join(dir, ".magister");
  if (existsSync(magisterDir)) args.push("--tmpfs", magisterDir);
}

function collectCommandReadOnlyBinds(command: string, env: Record<string, string>): string[] {
  const candidatePaths = isAbsolute(command)
    ? [command]
    : (env.PATH ?? "")
        .split(delimiter)
        .filter((dir) => dir.length > 0)
        .map((dir) => join(dir, command));
  const binds: string[] = [];
  for (const candidate of candidatePaths) {
    if (!existsSync(candidate)) {
      continue;
    }
    binds.push(dirname(candidate));
    try {
      binds.push(dirname(realpathSync(candidate)));
    } catch {
      // Best effort: the direct command directory is still useful for non-symlink binaries.
    }
    break;
  }
  return binds.filter((path) => path.length > 0 && path !== "/");
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

async function resolveCommandPath(command: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  if (isAbsolute(command)) {
    return await isExecutable(command) ? command : null;
  }

  const pathValue = env.PATH ?? process.env.PATH ?? "";
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }
  return null;
}

function failedPlan(
  passthrough: Pick<ExecutionSandboxCommandPlan, "command" | "args" | "cwd" | "env">,
  sandbox: ExecutionSandboxMetadata | null,
): ExecutionSandboxCommandPlan {
  const reason = sandbox?.reason ?? sandbox?.status ?? "unavailable";
  return {
    type: "failed",
    ...passthrough,
    executionSandbox: sandbox,
    failureReason: `Execution sandbox required but not active: ${reason}`,
  };
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function parseConfigValue<T extends string>(
  value: string | undefined,
  valid: Set<T>,
  fallback: T,
): T {
  const normalized = value?.trim().toLowerCase();
  return normalized && valid.has(normalized as T) ? normalized as T : fallback;
}
