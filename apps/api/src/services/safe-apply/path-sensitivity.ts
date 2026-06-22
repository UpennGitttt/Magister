/**
 * Sandbox-elevation v4.3 §4.7 — path sensitivity classifier.
 *
 * Input: a CANONICAL absolute path (post path.resolve + realpath; see
 * sandbox-elevation v4 spec §4.1 validation step 2) + access mode.
 * Output: a sensitivity level — `critical` paths are REFUSED at
 * validation and never reach the approval UI; `caution` paths render
 * yellow in the approval card; `safe` paths render green.
 *
 * The classifier accepts an optional `homeDir` so tests can fix the
 * value regardless of where they run. Production callers use the
 * default (process.env.HOME ?? os.homedir()).
 *
 * Symlink + traversal bypasses are closed UPSTREAM in §4.1 step 2 —
 * this classifier does not call fs.realpath. It operates on the
 * canonical string the caller passed in.
 */
import { homedir } from "node:os";

export type PathSensitivity = "safe" | "caution" | "critical";
export type AccessMode = "read" | "write";

export type ClassifyPathOptions = {
  /** Override home dir (testing). Defaults to process.env.HOME ?? os.homedir(). */
  homeDir?: string;
  /**
   * Magister install directory — must be explicitly resolved by the
   * caller (e.g. the bash-tool dispatcher reads it from a known
   * source: env var MAGISTER_INSTALL_DIR or a startup-resolved
   * constant). When undefined, the Magister-specific critical
   * protections (config/secrets.json, .magister/, .ultimate/) are
   * SKIPPED — the path falls through to default classification.
   *
   * Codex review #3 (A.1): `process.cwd()` is unreliable here. A
   * leader running in a teammate worktree has cwd == worktree, not
   * install root, so secrets.json at the real install path would
   * slip past. Forcing the caller to pass it explicitly closes that.
   */
  magisterInstallDir?: string;
  /**
   * Workspace root for protecting `.env` files inside the workspace.
   * When undefined, workspace-`.env` write critical rule is SKIPPED —
   * `.env` falls through to caution catch-all. Callers must pass
   * the workspace explicitly to engage this protection.
   */
  workspaceRoot?: string;
};

export type ClassifyPathResult = {
  level: PathSensitivity;
  reason: string;
};

function resolveHome(opts: ClassifyPathOptions): string {
  return opts.homeDir ?? process.env.HOME ?? homedir();
}

function startsWithDirOrEquals(path: string, prefix: string): boolean {
  if (!prefix) return false;
  if (path === prefix) return true;
  // Append `/` so `/home/u/.ssh-backup` does NOT match prefix `/home/u/.ssh`.
  return path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
}

function isUnder(path: string, ...prefixes: string[]): boolean {
  return prefixes.some((p) => startsWithDirOrEquals(path, p));
}

// Files where ANY access (read or write) is critical. /etc/shadow leaks
// hashes on read; /etc/sudoers reveals sudo config on read. /etc/passwd
// is publicly readable on every Linux box — it's only critical on
// WRITE (account injection), not read. /etc/gshadow same as shadow.
// (codex A.1 review item 1.)
const CRITICAL_SYSTEM_FILES_ANY_ACCESS = [
  "/etc/shadow",
  "/etc/gshadow",
  "/etc/sudoers",
];

// Critical on write only — public on Linux but never user-mutable.
const CRITICAL_SYSTEM_FILES_WRITE_ONLY = [
  "/etc/passwd",
];

const CRITICAL_DEV_BLOCK_PATTERNS: RegExp[] = [
  /^\/dev\/(?:sd[a-z]|nvme\w+|hd[a-z]|vd[a-z]|xvd[a-z]|mmcblk\d+|loop\d*|dm-\d+|md\d+|disk)(?:\/|$|\d)/,
  /^\/proc\/\d+\/mem$/,
];

const CAUTION_AUTH_CATCH_ALL: RegExp[] = [
  /(?:^|\/)[^/]*credentials[^/]*$/i,
  /(?:^|\/)[^/]*secret[^/]*$/i,
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /\.pfx$/,
];

/**
 * Classify a CANONICAL absolute path's sensitivity for the requested
 * access mode.
 *
 * Contract:
 *  - Input MUST be canonical (no `~`, no `..`, no symlinks). Callers
 *    that haven't canonicalized yet must do so first.
 *  - Input MUST be absolute (starts with `/`).
 *  - Non-canonical / non-absolute input throws — fail loud, never
 *    misclassify silently.
 */
export function classifyPathSensitivity(
  absolutePath: string,
  access: AccessMode,
  options: ClassifyPathOptions = {},
): ClassifyPathResult {
  if (typeof absolutePath !== "string" || absolutePath.length === 0) {
    throw new Error("classifyPathSensitivity: path must be a non-empty string");
  }
  if (!absolutePath.startsWith("/")) {
    throw new Error(`classifyPathSensitivity: path must be absolute, got ${absolutePath}`);
  }
  if (absolutePath.includes("/../") || absolutePath.endsWith("/..") || absolutePath.includes("/./")) {
    throw new Error(`classifyPathSensitivity: path must be canonical (no .. or .), got ${absolutePath}`);
  }
  if (absolutePath.includes("~")) {
    throw new Error(`classifyPathSensitivity: path must be canonical (no ~), got ${absolutePath}`);
  }

  const home = resolveHome(options);
  // Codex A.1 review HIGH #3: no `process.cwd()` fallback. If caller
  // didn't pass magisterInstallDir, Magister-specific critical rules
  // are skipped (path falls through to default classification).
  const magisterDir = options.magisterInstallDir;
  const workspaceRoot = options.workspaceRoot;

  // ---------- CRITICAL ----------

  // System-credential files where any access is critical.
  if (CRITICAL_SYSTEM_FILES_ANY_ACCESS.includes(absolutePath)) {
    return { level: "critical", reason: `system credential file (${absolutePath})` };
  }
  if (access === "write" && CRITICAL_SYSTEM_FILES_WRITE_ONLY.includes(absolutePath)) {
    return { level: "critical", reason: `system identity file write (${absolutePath})` };
  }
  if (isUnder(absolutePath, "/etc/sudoers.d")) {
    return { level: "critical", reason: "system sudoers.d entry" };
  }
  if (isUnder(absolutePath, "/etc/ssh")) {
    return { level: "critical", reason: "host SSH config or host keys" };
  }

  // Direct memory / disk access — write-only critical
  if (access === "write") {
    for (const pattern of CRITICAL_DEV_BLOCK_PATTERNS) {
      if (pattern.test(absolutePath)) {
        return { level: "critical", reason: "direct memory/disk device write" };
      }
    }
  }

  // SSH key write — backdoor surface
  if (access === "write") {
    if (absolutePath === `${home}/.ssh/authorized_keys`) {
      return { level: "critical", reason: "SSH authorized_keys (auth backdoor)" };
    }
    if (absolutePath.endsWith(".pub") && isUnder(absolutePath, `${home}/.ssh`)) {
      return { level: "critical", reason: "SSH public key tamper" };
    }
    if (isUnder(absolutePath, `${home}/.ssh`)) {
      return { level: "critical", reason: "SSH key directory write" };
    }
  }

  // /etc/* write (except resolv.conf which our own DNS bind needs as RO)
  if (access === "write" && absolutePath.startsWith("/etc/") && absolutePath !== "/etc/resolv.conf") {
    return { level: "critical", reason: "system /etc write" };
  }

  // Magister's own secrets (only when caller passed install dir)
  if (magisterDir) {
    const magisterSecretsPath = `${magisterDir}/config/secrets.json`;
    if (absolutePath === magisterSecretsPath) {
      return { level: "critical", reason: "Magister provider keys (config/secrets.json)" };
    }
  }

  // .env file write inside workspace = critical (injection surface);
  // .env file read = caution (leak surface, handled below)
  if (workspaceRoot && access === "write" && isUnder(absolutePath, workspaceRoot)) {
    const basename = absolutePath.slice(absolutePath.lastIndexOf("/") + 1);
    if (basename === ".env" || basename.startsWith(".env.")) {
      return { level: "critical", reason: "workspace .env write (injection surface)" };
    }
  }

  // Magister runtime state — write could forge approvals/tasks/trust
  if (magisterDir && access === "write") {
    if (isUnder(absolutePath, `${magisterDir}/.magister`, `${magisterDir}/.ultimate`)) {
      return { level: "critical", reason: "Magister runtime state write" };
    }
  }

  // ---------- CAUTION ----------

  // SSH read paths
  if (isUnder(absolutePath, `${home}/.ssh`)) {
    return { level: "caution", reason: "SSH directory (keys / config / known_hosts)" };
  }

  // Cloud creds
  if (isUnder(absolutePath, `${home}/.aws`)) {
    return { level: "caution", reason: "AWS credentials directory" };
  }
  if (isUnder(absolutePath, `${home}/.config/gcloud`)) {
    return { level: "caution", reason: "GCP credentials directory (ADC + gcloud)" };
  }
  if (isUnder(absolutePath, `${home}/.azure`)) {
    return { level: "caution", reason: "Azure CLI credentials directory" };
  }
  if (isUnder(absolutePath, `${home}/.kube`)) {
    return { level: "caution", reason: "Kubernetes config directory" };
  }
  if (isUnder(absolutePath, `${home}/.docker`)) {
    return { level: "caution", reason: "Docker config (registry tokens + contexts)" };
  }

  // Git/GH/network creds
  if (absolutePath === `${home}/.git-credentials` || absolutePath === `${home}/.netrc`) {
    return { level: "caution", reason: "git/netrc credentials" };
  }
  if (isUnder(absolutePath, `${home}/.config/gh`)) {
    return { level: "caution", reason: "GitHub CLI credentials" };
  }

  // Package manager tokens
  if (
    absolutePath === `${home}/.npmrc`
    || absolutePath === `${home}/.yarnrc`
    || absolutePath === `${home}/.yarnrc.yml`
    || absolutePath === `${home}/.pnpmrc`
  ) {
    return { level: "caution", reason: "package manager auth token file" };
  }
  if (absolutePath === `${home}/.pypirc`) {
    return { level: "caution", reason: "PyPI publish credentials" };
  }
  if (isUnder(absolutePath, `${home}/.config/pip`)) {
    return { level: "caution", reason: "pip configuration (index URLs / tokens)" };
  }

  // GPG keyring
  if (isUnder(absolutePath, `${home}/.gnupg`)) {
    return { level: "caution", reason: "GPG keyring" };
  }

  // Shell history — may contain pasted secrets
  const historyFiles = [".bash_history", ".zsh_history", ".python_history", ".node_repl_history", ".sh_history"];
  for (const historyFile of historyFiles) {
    if (absolutePath === `${home}/${historyFile}`) {
      return { level: "caution", reason: "shell history (may contain pasted secrets)" };
    }
  }

  // $PATH supply-chain vectors — writing to common bin dirs on PATH
  // means future invocations pick up attacker-controlled binaries.
  if (access === "write") {
    const pathBinDirs = [
      `${home}/.cargo/bin`,
      `${home}/.local/bin`,
      `${home}/.npm-global/bin`,
      `${home}/.yarn/bin`,
    ];
    for (const binDir of pathBinDirs) {
      if (isUnder(absolutePath, binDir)) {
        return { level: "caution", reason: `${binDir} — write to a directory commonly on $PATH (supply-chain vector)` };
      }
    }
    // rustup toolchain bin (path looks like ~/.rustup/toolchains/*/bin/<binary>)
    if (
      isUnder(absolutePath, `${home}/.rustup/toolchains`)
      && absolutePath.includes("/bin/")
    ) {
      return { level: "caution", reason: "rustup toolchain bin (supply-chain vector)" };
    }
  }

  // Workspace .env read (write was critical above)
  if (workspaceRoot && isUnder(absolutePath, workspaceRoot)) {
    const basename = absolutePath.slice(absolutePath.lastIndexOf("/") + 1);
    if (basename === ".env" || basename.startsWith(".env.")) {
      return { level: "caution", reason: "workspace .env file (secrets leak surface)" };
    }
  }

  // ---------- CAUTION catch-all (credential-shaped filenames) ----------
  //
  // Codex A.1 review MEDIUM #5: this MUST run BEFORE the SAFE rules
  // below — otherwise `/tmp/private.pem` write or `~/.cache/uv/secret`
  // matches the safe-cache rule first and returns safe. The catch-all
  // is meant to be a backstop for filenames that LOOK like creds even
  // when they live in otherwise-safe parents.
  for (const pattern of CAUTION_AUTH_CATCH_ALL) {
    if (pattern.test(absolutePath)) {
      return { level: "caution", reason: "filename suggests a credential / key file" };
    }
  }

  // ---------- SAFE ----------

  if (access === "write") {
    // Build / package caches — content-addressed or self-contained,
    // generally safe to share across runs. Tooltip in the UI should
    // still note "can affect future installs/builds" (lifecycle hooks).
    const safeCacheDirs = [
      `${home}/.cache/uv`,
      `${home}/.cache/pip`,
      `${home}/.cache/pnpm`,
      `${home}/.cache/yarn`,
      `${home}/.cache/go-build`,
      `${home}/.npm/_cacache`,
      `${home}/.cargo/registry`,
      `${home}/.cargo/git`,
      `${home}/.local/share/uv`,
      `${home}/.rustup/downloads`,
    ];
    for (const cacheDir of safeCacheDirs) {
      if (isUnder(absolutePath, cacheDir)) {
        return { level: "safe", reason: "build cache — usually safe but can affect future installs/builds" };
      }
    }
    // Shared tmp
    if (
      absolutePath === "/var/tmp"
      || absolutePath.startsWith("/var/tmp/")
      || absolutePath === "/tmp"
      || absolutePath.startsWith("/tmp/")
    ) {
      return { level: "safe", reason: "shared temp directory" };
    }
  }

  if (access === "read") {
    // git identity
    if (absolutePath === `${home}/.gitconfig` || absolutePath === "/etc/gitconfig") {
      return { level: "safe", reason: "git identity (name / email)" };
    }
  }

  // ---------- Default ----------
  // Anything else: caution. Forces user to explicitly approve before
  // the path lands in the bind list.
  if (absolutePath.startsWith(home)) {
    return { level: "caution", reason: "user home (default — user must explicitly approve)" };
  }
  return { level: "caution", reason: "filesystem path (default — user must explicitly approve)" };
}

/**
 * Tag indicating whether a path is on the critical hard-deny list.
 * Exposed so callers (validation in §4.1 step 4) can reject at schema
 * time without reading the human-readable `reason`.
 */
export function isCriticallyDenied(
  absolutePath: string,
  access: AccessMode,
  options: ClassifyPathOptions = {},
): boolean {
  return classifyPathSensitivity(absolutePath, access, options).level === "critical";
}
