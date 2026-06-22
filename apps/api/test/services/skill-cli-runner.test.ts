/**
 * Pure-unit tests for the validators in `skill-cli-runner`. The
 * actual subprocess invocation isn't tested here because it would
 * either hit the real `npx skills` binary (slow + needs network)
 * or require mocking out `Bun.spawn` (no clean hook). End-to-end
 * coverage of the spawn path lives in the management orchestrator
 * tests where we exercise the routes via shell-out.
 */
import { expect, test } from "bun:test";

import { isValidSkillName, isValidSkillSource } from "../../src/services/skill-cli-runner";

test("isValidSkillSource accepts owner/repo and owner/repo@skill formats", () => {
  expect(isValidSkillSource("vercel-labs/skills")).toBe(true);
  expect(isValidSkillSource("vercel-labs/agent-skills@web-design-guidelines")).toBe(true);
  expect(isValidSkillSource("user.name/repo_v2")).toBe(true);
});

test("isValidSkillSource rejects shell-injection style inputs", () => {
  expect(isValidSkillSource("; rm -rf /")).toBe(false);
  expect(isValidSkillSource("owner/repo; ls")).toBe(false);
  expect(isValidSkillSource("$(echo pwn)/repo")).toBe(false);
  expect(isValidSkillSource("../etc/passwd")).toBe(false);
  expect(isValidSkillSource("")).toBe(false);
});

test("isValidSkillSource rejects flag-like inputs (defense-in-depth)", () => {
  expect(isValidSkillSource("-foo/bar")).toBe(false);
  expect(isValidSkillSource("--source=evil")).toBe(false);
});

test("isValidSkillName accepts well-formed slugs and rejects garbage", () => {
  expect(isValidSkillName("simple")).toBe(true);
  expect(isValidSkillName("with-dashes")).toBe(true);
  expect(isValidSkillName("a")).toBe(true);
  expect(isValidSkillName("a".repeat(64))).toBe(true);

  expect(isValidSkillName("")).toBe(false);
  expect(isValidSkillName("UPPERCASE")).toBe(false);
  expect(isValidSkillName("with spaces")).toBe(false);
  expect(isValidSkillName("with/slash")).toBe(false);
  // Colon is allowed by the meta-pack convention but NOT by the
  // create-time slug validator — meta-packs come in via npx,
  // never via our manual create endpoint.
  expect(isValidSkillName("ckm:banner-design")).toBe(false);
  expect(isValidSkillName("3starts-with-digit")).toBe(false);
  expect(isValidSkillName("a".repeat(65))).toBe(false);
});
