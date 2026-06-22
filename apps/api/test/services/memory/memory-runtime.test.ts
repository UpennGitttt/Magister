import { afterEach, expect, test } from "bun:test";
import {
  getMemoryRuntime,
  initMemoryRuntime,
  resetMemoryRuntimeForTests,
} from "../../../src/services/memory/memory-runtime";

afterEach(() => {
  resetMemoryRuntimeForTests();
});

test("getMemoryRuntime throws when uninitialized", () => {
  expect(() => getMemoryRuntime()).toThrow(/not initialized/);
});

test("initMemoryRuntime sets singleton; getMemoryRuntime returns it", () => {
  initMemoryRuntime({
    userScopeRoot: "/tmp/u",
    projectScopeRoot: "/tmp/p",
  });
  const rt = getMemoryRuntime();
  expect(rt.roots["user-global"]).toBe("/tmp/u");
  expect(rt.roots.project).toBe("/tmp/p");
  expect(rt.schemaVersion).toBe(1);
});

test("initMemoryRuntime called twice overrides previous (idempotent for restarts)", () => {
  initMemoryRuntime({ userScopeRoot: "/tmp/u1", projectScopeRoot: "/tmp/p1" });
  initMemoryRuntime({ userScopeRoot: "/tmp/u2", projectScopeRoot: "/tmp/p2" });
  expect(getMemoryRuntime().roots["user-global"]).toBe("/tmp/u2");
});

test("resetMemoryRuntimeForTests with no arg clears", () => {
  initMemoryRuntime({ userScopeRoot: "/tmp/u", projectScopeRoot: "/tmp/p" });
  resetMemoryRuntimeForTests();
  expect(() => getMemoryRuntime()).toThrow();
});

test("resetMemoryRuntimeForTests accepts injected runtime for DI in tests", () => {
  resetMemoryRuntimeForTests({
    roots: { "user-global": "/x", project: "/y" },
    schemaVersion: 1,
  });
  expect(getMemoryRuntime().roots["user-global"]).toBe("/x");
});
