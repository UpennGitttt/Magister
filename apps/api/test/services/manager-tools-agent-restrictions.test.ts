import { expect, test } from "bun:test";

import type { AgentProfile } from "../../src/services/agent-profile-service";
import type { LeaderTool } from "../../src/services/manager-automation/autonomous-loop/autonomous-types";
import {
  applyPerAgentToolRestrictions,
  composeSpawnTeammateDescription,
} from "../../src/services/manager-automation/autonomous-loop/manager-tools-adapter";

function tool(name: string): LeaderTool {
  return { name } as LeaderTool;
}

function profile(partial: Partial<AgentProfile>): AgentProfile {
  return {
    roleId: "custom_role",
    label: "Custom Role",
    displayName: "Custom Role",
    description: null,
    avatarEmoji: null,
    runtimeType: "ucm",
    modelName: null,
    provider: null,
    providerId: null,
    reasoningMode: null,
    reasoningEffort: null,
    contextWindow: null,
    maxOutputTokens: null,
    fallbackModelName: null,
    fallbackProviderId: null,
    commandPath: null,
    customEnv: null,
    customArgs: null,
    modelOverride: null,
    status: null,
    lastHeartbeatAt: null,
    mcpConfig: null,
    maxConcurrentTasks: null,
    maxTurns: 60,
    systemPromptOverride: null,
    toolProfile: null,
    allowedTools: null,
    disallowedTools: null,
    omitSkills: false,
    isBuiltin: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...partial,
  };
}

test("per-agent tool restrictions leave unrestricted tools unchanged", () => {
  const tools = [tool("bash"), tool("read_file")];
  const result = applyPerAgentToolRestrictions(tools, profile({}));
  expect(result.map((item) => item.name)).toEqual(["bash", "read_file"]);
});

test("per-agent allowedTools narrows by intersection", () => {
  const tools = [tool("bash"), tool("read_file"), tool("web_search")];
  const result = applyPerAgentToolRestrictions(tools, profile({
    allowedTools: ["bash", "web_search"],
  }));
  expect(result.map((item) => item.name)).toEqual(["bash", "web_search"]);
});

test("per-agent disallowedTools subtracts matching tools", () => {
  const tools = [tool("bash"), tool("read_file"), tool("web_search")];
  const result = applyPerAgentToolRestrictions(tools, profile({
    disallowedTools: ["web_search"],
  }));
  expect(result.map((item) => item.name)).toEqual(["bash", "read_file"]);
});

test("per-agent restrictions apply allowlist before denylist", () => {
  const tools = [tool("bash"), tool("read_file"), tool("web_search")];
  const result = applyPerAgentToolRestrictions(tools, profile({
    allowedTools: ["bash", "read_file"],
    disallowedTools: ["bash"],
  }));
  expect(result.map((item) => item.name)).toEqual(["read_file"]);
});

test("teammate invariants are removed after per-agent allowlist filtering", () => {
  const tools = [tool("bash"), tool("spawn_teammate"), tool("enter_plan_mode"), tool("exit_plan_mode")];
  const result = applyPerAgentToolRestrictions(tools, profile({
    allowedTools: ["bash", "spawn_teammate", "enter_plan_mode", "exit_plan_mode"],
  }), { enforceTeammateInvariants: true });
  expect(result.map((item) => item.name)).toEqual(["bash"]);
});

test("spawn teammate description omits custom section when there are no custom profiles", () => {
  const description = composeSpawnTeammateDescription([]);
  expect(description).toContain("Builtin roles");
  expect(description).not.toContain("Custom roles");
});

test("spawn teammate description lists custom profiles with descriptions", () => {
  const description = composeSpawnTeammateDescription([
    profile({
      roleId: "i18n_translator",
      description: "Translates UI strings to multiple locales",
    }),
  ]);
  expect(description).toContain("Custom roles (configured in this workspace):");
  expect(description).toContain("- `i18n_translator`: Translates UI strings to multiple locales");
});

test("spawn teammate description uses fallback text for missing custom descriptions", () => {
  const description = composeSpawnTeammateDescription([
    profile({
      roleId: "db_migration_writer",
      description: null,
    }),
  ]);
  expect(description).toContain("- `db_migration_writer`: (no description provided)");
});

test("spawn teammate description does not duplicate builtin role ids", () => {
  const description = composeSpawnTeammateDescription([
    profile({
      roleId: "coder",
      description: "Custom coder override",
      isBuiltin: 0,
    }),
  ]);
  expect(description).toContain("- `coder`: Implements code changes");
  expect(description).not.toContain("Custom coder override");
});
