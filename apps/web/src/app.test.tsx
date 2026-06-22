import { describe, expect, test } from "bun:test";

describe("AppShell", () => {
  test("module exports AppShell", async () => {
    const mod = await import("./AppShell");
    expect(mod.AppShell).toBeDefined();
    expect(typeof mod.AppShell).toBe("function");
  });
});
