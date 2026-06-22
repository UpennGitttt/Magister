import { expect, test } from "bun:test";

import { buildRuntimeEnv } from "../../../src/services/safe-apply/runtime-env-service";

test("scrubs inherited secrets and replaces home and temp dirs", () => {
  const result = buildRuntimeEnv({
    runtimeSource: "codex",
    runtimeHomeDir: "/tmp/magister-home",
    runtimeTmpDir: "/tmp/magister-tmp",
    baseEnv: {
      PATH: "/usr/bin",
      USER: "ucm",
      CI: "1",
      OPENAI_API_KEY: "sk-secret",
      DATABASE_URL: "sqlite://secret",
      FEISHU_BOT_SECRET: "secret",
      GITHUB_TOKEN: "ghs_secret",
      SSH_AUTH_SOCK: "/tmp/ssh.sock",
      MAGISTER_DB_PATH: "/tmp/control.sqlite",
      OPENCODE_PERMISSION: "{\"*\":\"allow\"}",
      IS_SANDBOX: "1",
    },
  });

  expect(result.env).toMatchObject({
    PATH: "/usr/bin",
    USER: "ucm",
    CI: "1",
    HOME: "/tmp/magister-home",
    TMPDIR: "/tmp/magister-tmp",
    TMP: "/tmp/magister-tmp",
    TEMP: "/tmp/magister-tmp",
  });
  expect(result.env.OPENAI_API_KEY).toBeUndefined();
  expect(result.env.DATABASE_URL).toBeUndefined();
  expect(result.env.FEISHU_BOT_SECRET).toBeUndefined();
  expect(result.env.GITHUB_TOKEN).toBeUndefined();
  expect(result.env.SSH_AUTH_SOCK).toBeUndefined();
  expect(result.env.MAGISTER_DB_PATH).toBeUndefined();
  expect(result.env.OPENCODE_PERMISSION).toBeUndefined();
  expect(result.env.IS_SANDBOX).toBeUndefined();
  expect(result.permissionHints).toEqual([]);
  expect(result.strippedKeys).toEqual(
    expect.arrayContaining([
      "OPENAI_API_KEY",
      "DATABASE_URL",
      "FEISHU_BOT_SECRET",
      "GITHUB_TOKEN",
      "SSH_AUTH_SOCK",
      "MAGISTER_DB_PATH",
      "OPENCODE_PERMISSION",
      "IS_SANDBOX",
    ]),
  );
});

test("passes caller-provided env but strips permission override and sensitive keys", () => {
  const result = buildRuntimeEnv({
    runtimeSource: "opencode",
    runtimeHomeDir: "/tmp/opencode-home",
    runtimeTmpDir: "/tmp/opencode-tmp",
    baseEnv: {
      PATH: "/usr/bin",
      OPENAI_API_KEY: "base-secret",
    },
    userEnv: {
      PHASE_B_TEST_ENV: "visible",
      CUSTOM_API_KEY: "custom-secret",
      GITHUB_TOKEN: "custom-token",
      OPENCODE_PERMISSION: "{\"*\":\"allow\"}",
    },
  });

  expect(result.env.PHASE_B_TEST_ENV).toBe("visible");
  expect(result.env.CUSTOM_API_KEY).toBeUndefined();
  expect(result.env.GITHUB_TOKEN).toBeUndefined();
  expect(result.env.OPENCODE_PERMISSION).toBeUndefined();
  expect(result.env.OPENAI_API_KEY).toBeUndefined();
  expect(result.permissionHints).toEqual([]);
  expect(result.strippedKeys).toEqual(
    expect.arrayContaining(["OPENAI_API_KEY", "CUSTOM_API_KEY", "GITHUB_TOKEN", "OPENCODE_PERMISSION"]),
  );
});

test("allows sensitive inherited keys only through explicit extra allowlist", () => {
  const result = buildRuntimeEnv({
    runtimeSource: "codex",
    runtimeHomeDir: "/tmp/codex-home",
    runtimeTmpDir: "/tmp/codex-tmp",
    baseEnv: {
      PATH: "/usr/bin",
      CUSTOM_API_KEY: "runtime-required-key",
      OPENAI_API_KEY: "base-secret",
    },
    extraAllowlist: ["CUSTOM_API_KEY"],
  });

  expect(result.env.CUSTOM_API_KEY).toBe("runtime-required-key");
  expect(result.env.OPENAI_API_KEY).toBeUndefined();
  expect(result.strippedKeys).toContain("OPENAI_API_KEY");
  expect(result.strippedKeys).not.toContain("CUSTOM_API_KEY");
});

test("preserves Magister-controlled runtime homes such as CODEX_HOME", () => {
  const result = buildRuntimeEnv({
    runtimeSource: "codex",
    runtimeHomeDir: "/tmp/codex-home-shell",
    runtimeTmpDir: "/tmp/codex-tmp",
    baseEnv: {
      PATH: "/usr/bin",
      CODEX_HOME: "/root/.codex",
    },
    userEnv: {
      CODEX_HOME: "/tmp/magister-codex-home",
    },
  });

  expect(result.env.HOME).toBe("/tmp/codex-home-shell");
  expect(result.env.CODEX_HOME).toBe("/tmp/magister-codex-home");
  expect(result.env.CODEX_HOME).not.toBe("/root/.codex");
});

test("preserves proxy and certificate environment needed by local CLIs", () => {
  const result = buildRuntimeEnv({
    runtimeSource: "codex",
    runtimeHomeDir: "/tmp/codex-home",
    runtimeTmpDir: "/tmp/codex-tmp",
    baseEnv: {
      PATH: "/usr/bin",
      HTTPS_PROXY: "http://127.0.0.1:7890",
      NO_PROXY: "127.0.0.1,localhost",
      SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
      NODE_EXTRA_CA_CERTS: "/etc/ssl/local.pem",
    },
  });

  expect(result.env.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
  expect(result.env.NO_PROXY).toBe("127.0.0.1,localhost");
  expect(result.env.SSL_CERT_FILE).toBe("/etc/ssl/certs/ca-certificates.crt");
  expect(result.env.NODE_EXTRA_CA_CERTS).toBe("/etc/ssl/local.pem");
});

test("does not isolate OpenCode or Claude host HOME by default before config seeding exists", () => {
  const opencode = buildRuntimeEnv({
    runtimeSource: "opencode",
    runtimeHomeDir: "/tmp/opencode-home",
    runtimeTmpDir: "/tmp/opencode-tmp",
    baseEnv: {
      PATH: "/usr/bin",
      HOME: "/home/host-opencode",
    },
  });
  const claude = buildRuntimeEnv({
    runtimeSource: "claude-code",
    runtimeHomeDir: "/tmp/claude-home",
    runtimeTmpDir: "/tmp/claude-tmp",
    baseEnv: {
      PATH: "/usr/bin",
      HOME: "/home/host-claude",
    },
  });

  expect(opencode.env.HOME).toBe("/home/host-opencode");
  expect(opencode.env.TMPDIR).toBe("/tmp/opencode-tmp");
  expect(claude.env.HOME).toBe("/home/host-claude");
  expect(claude.env.TMPDIR).toBe("/tmp/claude-tmp");
});

test("isolates OpenCode or Claude HOME only when explicitly enabled", () => {
  const result = buildRuntimeEnv({
    runtimeSource: "opencode",
    runtimeHomeDir: "/tmp/opencode-home",
    runtimeTmpDir: "/tmp/opencode-tmp",
    isolateHome: true,
    baseEnv: {
      PATH: "/usr/bin",
      HOME: "/home/host-opencode",
    },
  });

  expect(result.env.HOME).toBe("/tmp/opencode-home");
});
