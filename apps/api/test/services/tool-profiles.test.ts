import { test, expect } from "bun:test";
import { z } from "zod";

import { filterToolsByProfile, isValidToolProfileId } from "../../src/services/manager-automation/tool-profiles";
import type { LeaderTool } from "../../src/services/manager-automation/autonomous-loop/autonomous-types";

function makeTool(name: string): LeaderTool {
  return {
    name,
    inputSchema: z.any(),
    async call() {
      return { data: null };
    },
    isConcurrencySafe() {
      return true;
    },
    isReadOnly() {
      return true;
    },
  };
}

const toolNames = [
  "read_file",
  "list_dir",
  "grep",
  "time_now",
  "write_file",
  "edit_file",
  "bash",
  "web_search",
  "web_fetch",
  "spawn_teammate",
  "check_teammate_status",
  "wait_for_teammate",
  "custom_tool",
] as const;

const tools = toolNames.map((name) => makeTool(name));

test("full profile keeps all tools", () => {
  expect(filterToolsByProfile(tools, "full").map((tool) => tool.name)).toEqual([...toolNames]);
});

test("coding profile excludes research and teammate delegation tools", () => {
  expect(filterToolsByProfile(tools, "coding").map((tool) => tool.name)).toEqual([
    "read_file",
    "list_dir",
    "grep",
    "time_now",
    "write_file",
    "edit_file",
    "bash",
    "custom_tool",
  ]);
});

test("research profile excludes write and teammate delegation tools", () => {
  expect(filterToolsByProfile(tools, "research").map((tool) => tool.name)).toEqual([
    "read_file",
    "list_dir",
    "grep",
    "time_now",
    "web_search",
    "web_fetch",
    "custom_tool",
  ]);
});

test("minimal profile keeps only allowlisted tools", () => {
  expect(filterToolsByProfile(tools, "minimal").map((tool) => tool.name)).toEqual([
    "read_file",
    "list_dir",
    "grep",
    "time_now",
  ]);
});

test("unknown profile falls back to all tools", () => {
  expect(filterToolsByProfile(tools, "unknown" as any).map((tool) => tool.name)).toEqual([...toolNames]);
});

test("isValidToolProfileId validates known ids and rejects unknown ids", () => {
  expect([
    isValidToolProfileId("full"),
    isValidToolProfileId("coding"),
    isValidToolProfileId("research"),
    isValidToolProfileId("minimal"),
    isValidToolProfileId("unknown"),
  ]).toEqual([true, true, true, true, false]);
});
