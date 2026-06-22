import { expect, test } from "bun:test";

import type { LeaderMessage } from "../../src/services/manager-automation/autonomous-loop/autonomous-types";
import { buildProgressArtifact } from "../../src/services/manager-automation/autonomous-loop/progress-artifacts";

test("buildProgressArtifact extracts completed steps from messages", () => {
  const messages: LeaderMessage[] = [
    { type: "user", content: "Please fix tests" },
    { type: "assistant", content: [{ type: "text", text: "Read failing tests and identified root cause." }] },
    { type: "tool_result", toolUseId: "tool_1", content: "ok" },
    { type: "assistant", content: [{ type: "text", text: "Implemented patch for parser edge-case." }] },
    { type: "tool_result", toolUseId: "tool_2", content: "ok" },
  ];

  const artifact = buildProgressArtifact(messages);

  expect(artifact.completedSteps).toEqual([
    "Read failing tests and identified root cause.",
    "Implemented patch for parser edge-case.",
  ]);
  expect(artifact.currentStep).toBeNull();
  expect(artifact.turnCount).toBe(1);
});

test("buildProgressArtifact extracts current step from last assistant message", () => {
  const longText = "a".repeat(240);
  const messages: LeaderMessage[] = [
    { type: "user", content: "Continue" },
    { type: "assistant", content: [{ type: "text", text: longText }] },
  ];

  const artifact = buildProgressArtifact(messages);

  expect(artifact.currentStep).toBe(longText.slice(-200));
  expect(artifact.completedSteps).toEqual([]);
  expect(artifact.turnCount).toBe(1);
});

test("buildProgressArtifact lists modified files from tool results", () => {
  const messages: LeaderMessage[] = [
    { type: "user", content: "Update files" },
    {
      type: "assistant",
      content: [
        { type: "tool_use", id: "tool_1", name: "write_file", input: { path: "src/auth.ts" } },
        { type: "tool_use", id: "tool_2", name: "edit_file", input: { file_path: "src/auth.ts" } },
        { type: "tool_use", id: "tool_3", name: "read_file", input: { path: "README.md" } },
        { type: "tool_use", id: "tool_4", name: "bash", input: { command: "ls" } },
      ],
    },
    { type: "tool_result", toolUseId: "tool_1", content: "written" },
    { type: "tool_result", toolUseId: "tool_2", content: "edited" },
    { type: "tool_result", toolUseId: "tool_3", content: "read" },
  ];

  const artifact = buildProgressArtifact(messages);

  expect(artifact.modifiedFiles).toEqual(["src/auth.ts", "README.md"]);
  expect(artifact.toolsUsed).toEqual(["write_file", "edit_file", "read_file", "bash"]);
});

test("buildProgressArtifact returns empty for no messages", () => {
  const artifact = buildProgressArtifact([]);

  expect(artifact).toEqual({
    completedSteps: [],
    currentStep: null,
    modifiedFiles: [],
    toolsUsed: [],
    turnCount: 0,
  });
});
