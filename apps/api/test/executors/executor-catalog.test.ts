import { expect, test } from "bun:test";

import {
  getDefaultAdapterIdForRole,
  getExecutorCatalogEntry,
  listExecutorCatalog,
} from "../../src/executors/executor-catalog";

test("executor catalog exposes the supported heterogeneous adapter set", () => {
  expect(listExecutorCatalog().map((entry) => entry.adapterId)).toEqual([
    "codex",
    "qoder",
    "opencode",
    "claude_code",
    "model",
  ]);

  expect(getExecutorCatalogEntry("codex")).toMatchObject({
    adapterId: "codex",
    displayName: "Codex",
    executorType: "coding_agent",
    roleTargets: ["leader", "architect", "coder", "reviewer", "lander"],
    configKey: "MAGISTER_MODEL_CODEX",
  });

  expect(getExecutorCatalogEntry("model")).toMatchObject({
    adapterId: "model",
    executorType: "model",
    executionMode: "api",
  });

  expect(getDefaultAdapterIdForRole("leader")).toBe("model");
  expect(getDefaultAdapterIdForRole("reviewer")).toBe("qoder");
  expect(getDefaultAdapterIdForRole("unknown")).toBeNull();
});
