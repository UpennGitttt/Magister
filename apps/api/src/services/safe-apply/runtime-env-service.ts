import { join } from "node:path";

import type { RuntimeSource } from "./safe-apply-types";

export type RuntimeEnvInput = {
  baseEnv?: NodeJS.ProcessEnv;
  userEnv?: Record<string, string>;
  runtimeSource: RuntimeSource;
  runtimeHomeDir: string;
  runtimeTmpDir: string;
  extraAllowlist?: string[];
  isolateHome?: boolean;
};

export type RuntimeEnvBuildResult = {
  env: Record<string, string>;
  permissionHints: string[];
  strippedKeys: string[];
};

const DEFAULT_ALLOWLIST = new Set([
  "PATH",
  "USER",
  "USERNAME",
  "LANG",
  "LC_ALL",
  "TERM",
  "SHELL",
  "NODE_PATH",
  "NPM_CONFIG_PREFIX",
  "CI",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
]);

const EXACT_STRIP_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "VOLCENGINE_ARK_API_KEY",
  "MOONSHOT_API_KEY",
  "DASHSCOPE_API_KEY",
  "GITHUB_TOKEN",
  "SSH_AUTH_SOCK",
  "MAGISTER_DB_PATH",
  "DATABASE_URL",
  "OPENCODE_PERMISSION",
]);

const CONTROLLED_PATH_KEYS = new Set(["HOME", "TMPDIR", "TMP", "TEMP"]);

function isSensitiveKey(key: string) {
  if (EXACT_STRIP_KEYS.has(key)) return true;
  if (key.startsWith("FEISHU_")) return true;
  if (key.startsWith("AWS_")) return true;
  if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key)) return true;
  return false;
}

function permissionHintForKey(key: string) {
  if (key === "IS_SANDBOX") return "IS_SANDBOX";
  if (key === "OPENCODE_PERMISSION") return "OPENCODE_PERMISSION";
  if (key.toUpperCase().includes("PERMISSION")) return key;
  return null;
}

function isPermissionOverrideKey(key: string) {
  return permissionHintForKey(key) !== null;
}

function addPermissionHint(hints: Set<string>, key: string) {
  const hint = permissionHintForKey(key);
  if (hint) hints.add(hint);
}

function addUserEnv(
  target: Record<string, string>,
  hints: Set<string>,
  strippedKeys: Set<string>,
  userEnv: Record<string, string> | undefined,
  extraAllowlist: Set<string>,
) {
  if (!userEnv) return;
  for (const [key, value] of Object.entries(userEnv)) {
    if (
      CONTROLLED_PATH_KEYS.has(key)
      || isPermissionOverrideKey(key)
      || (isSensitiveKey(key) && !extraAllowlist.has(key))
    ) {
      strippedKeys.add(key);
      continue;
    }
    target[key] = value;
    addPermissionHint(hints, key);
  }
}

export function buildRuntimeEnv(input: RuntimeEnvInput): RuntimeEnvBuildResult {
  const baseEnv = input.baseEnv ?? process.env;
  const extraAllowlist = new Set(input.extraAllowlist ?? []);
  const allowlist = new Set([...DEFAULT_ALLOWLIST, ...extraAllowlist]);
  const env: Record<string, string> = {};
  const permissionHints = new Set<string>();
  const strippedKeys = new Set<string>();
  const shouldIsolateHome =
    input.isolateHome ??
    (input.runtimeSource !== "opencode" && input.runtimeSource !== "claude-code" && input.runtimeSource !== "kiro");

  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value !== "string") continue;
    if (key === "HOME" && !shouldIsolateHome) {
      env.HOME = value;
      continue;
    }
    if (
      isPermissionOverrideKey(key)
      || !allowlist.has(key)
      || (isSensitiveKey(key) && !extraAllowlist.has(key))
    ) {
      strippedKeys.add(key);
      continue;
    }
    env[key] = value;
    addPermissionHint(permissionHints, key);
  }

  addUserEnv(env, permissionHints, strippedKeys, input.userEnv, extraAllowlist);

  if (shouldIsolateHome || !env.HOME) {
    env.HOME = input.runtimeHomeDir;
  }
  env.TMPDIR = input.runtimeTmpDir;
  env.TMP = input.runtimeTmpDir;
  env.TEMP = input.runtimeTmpDir;

  if (input.runtimeSource === "codex" && !env.CODEX_HOME) {
    env.CODEX_HOME = join(input.runtimeHomeDir, ".codex");
  }

  return {
    env,
    permissionHints: [...permissionHints].sort(),
    strippedKeys: [...strippedKeys].sort(),
  };
}
