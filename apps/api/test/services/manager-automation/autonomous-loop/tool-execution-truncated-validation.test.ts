import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { runToolUse } from "../../../../src/services/manager-automation/autonomous-loop/tool-execution";
import type {
  LeaderTool,
  LeaderToolUseContext,
} from "../../../../src/services/manager-automation/autonomous-loop/autonomous-types";

function makeContext(overrides: Partial<LeaderToolUseContext> = {}): LeaderToolUseContext {
  return {
    taskId: "task_test",
    runId: "run_test",
    requestId: "req_test",
    workspaceDir: "/tmp",
    abortController: new AbortController(),
    messages: [],
    tools: [],
    getInProgressToolUseIDs: () => new Set(),
    setInProgressToolUseIDs: () => {},
    recordEvent: async () => {},
    ...overrides,
  };
}

// A spawn_teammate-shaped schema: role + goal REQUIRED, expected_output
// OPTIONAL. The truncation incident: model emits {role, expected_output}
// with `goal` cut off (truncated before the required field).
const SpawnSchema = z.object({
  role: z.string().min(1),
  goal: z.string(),
  expected_output: z.string().optional(),
});

function makeSpawnTool(): LeaderTool {
  return {
    name: "spawn_teammate",
    inputSchema: SpawnSchema,
    isConcurrencySafe: () => true,
    isReadOnly: () => false,
    call: async () => ({ data: "ok" }),
  };
}

async function firstMessage(
  input: Record<string, unknown>,
): Promise<{ content: string; isError: boolean | undefined }> {
  const tool = makeSpawnTool();
  for await (const u of runToolUse({ id: "tu_1", name: "spawn_teammate", input }, [tool], makeContext())) {
    if (u.message) {
      return {
        content: String((u.message as { content?: unknown }).content ?? ""),
        isError: (u.message as { isError?: boolean }).isError,
      };
    }
  }
  throw new Error("no message produced");
}

describe("fix#1 — actionable validation error on truncated tool call", () => {
  test("partial object missing a required field (goal) → InputValidationError + truncation/shorten hint", async () => {
    const { content, isError } = await firstMessage({
      role: "coder",
      expected_output: "a long shape description",
      // goal MISSING — the truncation hallmark
    });
    expect(isError).toBe(true);
    expect(content).toContain("InputValidationError");
    // Still names the missing required field.
    expect(content).toMatch(/goal/i);
    // The new actionable hint.
    expect(content).toMatch(/truncat/i);
    expect(content).toMatch(/shorter|shorten/i);
  });

  test("genuinely-empty {} call does NOT claim truncation, but still hints at required fields", async () => {
    const { content, isError } = await firstMessage({});
    expect(isError).toBe(true);
    expect(content).toContain("InputValidationError");
    // Must NOT over-fire the truncation diagnosis on an empty call.
    expect(content).not.toMatch(/may have been truncated/i);
    // A gentle required-fields nudge is acceptable.
    expect(content).toMatch(/required field/i);
  });

  test("complete valid input → no validation error at all", async () => {
    const { isError, content } = await firstMessage({
      role: "coder",
      goal: "do the thing",
    });
    // Schema passes — the tool runs; no InputValidationError.
    expect(content).not.toContain("InputValidationError");
    expect(isError).not.toBe(true);
  });
});
