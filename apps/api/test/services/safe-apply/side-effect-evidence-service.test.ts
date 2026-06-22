import { expect, test } from "bun:test";

import {
  buildObservedSideEffectEvidence,
  isSafeApplySideEffectEvidenceCandidate,
} from "../../../src/services/safe-apply/side-effect-evidence-service";
import type { LeaderLoopEvent } from "../../../src/services/manager-automation/autonomous-loop/autonomous-types";

function event(type: string, data: Record<string, unknown>): LeaderLoopEvent {
  return {
    type,
    timestamp: "2026-05-14T00:00:00.000Z",
    data,
  };
}

test("read-only leader tool calls are not Safe Apply side-effect evidence", () => {
  const events = [
    event("leader.tool_call", {
      toolUseId: "read-1",
      toolName: "read_file",
      toolSafety: {
        classification: "read_only",
        readOnly: true,
        planSafe: true,
      },
    }),
    event("leader.tool_result", {
      toolUseId: "read-1",
      toolName: "read_file",
      isError: false,
    }),
  ];

  expect(events.every(isSafeApplySideEffectEvidenceCandidate)).toBe(true);
  expect(buildObservedSideEffectEvidence(events)).toEqual({
    eventTypes: [],
    toolNames: [],
  });
});

test("mutating, unknown, and unpaired tool events remain side-effect evidence", () => {
  const events = [
    event("leader.tool_call", {
      toolUseId: "bash-1",
      toolName: "bash",
      toolSafety: {
        classification: "mutating",
        readOnly: false,
        planSafe: false,
      },
    }),
    event("leader.tool_result", {
      toolUseId: "bash-1",
      toolName: "bash",
      isError: false,
    }),
    event("leader.tool_call", {
      toolUseId: "custom-1",
      toolName: "custom_tool",
      toolSafety: {
        classification: "unknown",
        readOnly: null,
        planSafe: null,
      },
    }),
    event("leader.tool_result", {
      toolUseId: "legacy-1",
      toolName: "legacy_tool",
      isError: false,
    }),
  ];

  expect(buildObservedSideEffectEvidence(events)).toEqual({
    eventTypes: ["leader.tool_call", "leader.tool_result"],
    toolNames: ["bash", "custom_tool", "legacy_tool"],
  });
});
