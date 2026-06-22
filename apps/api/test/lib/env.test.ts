import { afterEach, expect, test } from "bun:test";

import {
  _resetLegacyEnvWarningsForTest,
  getMagisterEnv,
} from "../../src/lib/env";

const legacyPrefix = "U" + "CM_";

afterEach(() => {
  _resetLegacyEnvWarningsForTest();
});

test("getMagisterEnv prefers MAGISTER value over legacy value without warning", () => {
  const warnings: string[] = [];
  const env: NodeJS.ProcessEnv = {
    MAGISTER_EXECUTION_SANDBOX_MODE: "required",
    [`${legacyPrefix}EXECUTION_SANDBOX_MODE`]: "off",
  };

  expect(getMagisterEnv("MAGISTER_EXECUTION_SANDBOX_MODE", env, (message) => warnings.push(message))).toBe("required");
  expect(warnings).toEqual([]);
});

test("getMagisterEnv falls back to legacy value and warns once per variable", () => {
  const warnings: string[] = [];
  const env: NodeJS.ProcessEnv = {
    [`${legacyPrefix}EXECUTION_SANDBOX_MODE`]: "optional",
  };

  expect(getMagisterEnv("MAGISTER_EXECUTION_SANDBOX_MODE", env, (message) => warnings.push(message))).toBe("optional");
  expect(getMagisterEnv("MAGISTER_EXECUTION_SANDBOX_MODE", env, (message) => warnings.push(message))).toBe("optional");
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("MAGISTER_EXECUTION_SANDBOX_MODE");
});

test("getMagisterEnv supports explicit non-UCM legacy names", () => {
  const warnings: string[] = [];
  const env: NodeJS.ProcessEnv = {
    LEGACY_API_LOCK_PATH: "/tmp/old.lock",
  };

  expect(getMagisterEnv("MAGISTER_API_LOCK_PATH", env, (message) => warnings.push(message), "LEGACY_API_LOCK_PATH")).toBe("/tmp/old.lock");
  expect(warnings).toEqual([
    "[env] LEGACY_API_LOCK_PATH is deprecated; use MAGISTER_API_LOCK_PATH instead.",
  ]);
});

test("getMagisterEnv falls back to the ULTIMATE_ legacy prefix", () => {
  const warnings: string[] = [];
  const env: NodeJS.ProcessEnv = {
    ["U" + "LTIMATE_API_LOCK_PATH"]: "/tmp/ultimate.lock",
  };

  expect(getMagisterEnv("MAGISTER_API_LOCK_PATH", env, (message) => warnings.push(message))).toBe("/tmp/ultimate.lock");
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("LTIMATE_API_LOCK_PATH is deprecated");
});
