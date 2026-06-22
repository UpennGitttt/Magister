import { expect, test } from "bun:test";

import {
  getManagerBaseToolDefinitions,
  getManagerCapabilityDefinitions,
  getManagerSubagentDefinitions,
  getManagerTerminalActionDefinitions,
} from "../../src/services/manager-capability-registry-service";

test("manager capability registry exposes required base tools with rich local-runtime metadata", () => {
  const baseTools = getManagerBaseToolDefinitions();

  expect(baseTools.map((tool) => tool.toolName)).toEqual([
    "time_now",
    "read_file",
    "list_dir",
    "grep_repo",
    "bash",
    "web_search",
    "web_fetch",
  ]);

  for (const tool of baseTools) {
    expect(tool.description.trim().length).toBeGreaterThan(0);
    expect(tool.argumentSchemaSummary.trim().length).toBeGreaterThan(0);
    expect(tool.whenToUse.trim().length).toBeGreaterThan(0);
    expect(tool.whenNotToUse.trim().length).toBeGreaterThan(0);
    expect(tool.returnsSummary.trim().length).toBeGreaterThan(0);
  }

  const webSearch = baseTools.find((tool) => tool.toolName === "web_search");
  const webFetch = baseTools.find((tool) => tool.toolName === "web_fetch");
  const bash = baseTools.find((tool) => tool.toolName === "bash");
  const readFile = baseTools.find((tool) => tool.toolName === "read_file");

  expect(webSearch).toBeDefined();
  expect(webSearch?.description).toContain("Tavily");
  expect(webFetch).toBeDefined();
  expect(webFetch?.description).toContain("Tavily");
  expect(bash).toBeDefined();
  expect(`${bash?.description} ${bash?.whenNotToUse}`).toContain("workspace");
  expect(readFile).toBeDefined();
  expect(`${readFile?.description} ${readFile?.whenNotToUse}`).toContain("workspace");
});

test("manager capability registry exposes delegated subagents without duplicates", () => {
  const subagents = getManagerSubagentDefinitions();

  expect(subagents.map((subagent) => subagent.subagentType)).toEqual([
    "architect",
    "coder",
    "reviewer",
    "lander",
    "deepresearcher",
  ]);

  const uniqueSubagentTypes = new Set(subagents.map((subagent) => subagent.subagentType));
  expect(uniqueSubagentTypes.size).toBe(subagents.length);

  for (const subagent of subagents) {
    expect(subagent.description.trim().length).toBeGreaterThan(0);
    expect(subagent.whenToUse.trim().length).toBeGreaterThan(0);
    expect(subagent.whenNotToUse.trim().length).toBeGreaterThan(0);
    expect(subagent.ownedOutcomes.length).toBeGreaterThan(0);
    expect(subagent.defaultSkillIds.length).toBeGreaterThan(0);
  }
});

test("manager capability registry exposes terminal manager actions including ask_user_question", () => {
  const actions = getManagerTerminalActionDefinitions();

  expect(actions.map((action) => action.name)).toEqual([
    "respond",
    "ask_user_question",
    "wait",
  ]);

  for (const action of actions) {
    expect(action.description.trim().length).toBeGreaterThan(0);
    expect(action.whenToUse.trim().length).toBeGreaterThan(0);
    expect(action.whenNotToUse.trim().length).toBeGreaterThan(0);
  }
});

test("manager capability registry returns a unified capability list with unique names", () => {
  const definitions = getManagerCapabilityDefinitions();

  const names = definitions.map((definition) => definition.name);
  const uniqueNames = new Set(names);
  expect(uniqueNames.size).toBe(definitions.length);

  expect(definitions.filter((definition) => definition.kind === "base_tool")).toHaveLength(7);
  expect(definitions.filter((definition) => definition.kind === "delegated_subagent")).toHaveLength(5);
  expect(definitions.filter((definition) => definition.kind === "terminal_action")).toHaveLength(3);
});
