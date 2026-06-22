import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const tempRoot = join(process.cwd(), ".tmp-spawn-teammate-test");

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_DB_PATH = join(
    tempRoot,
    `spawn-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
});

afterEach(() => {
  delete process.env.MAGISTER_DB_PATH;
  rmSync(tempRoot, { recursive: true, force: true });
});

test("createLeaderTools includes spawn_teammate with correct schema", async () => {
  const { createLeaderTools } = await import(
    "../../src/services/manager-automation/autonomous-loop/manager-tools-adapter"
  );
  const tools = createLeaderTools(tempRoot);
  const spawnTool = tools.find((t) => t.name === "spawn_teammate");
  expect(spawnTool).toBeDefined();
  expect(spawnTool!.isConcurrencySafe({})).toBe(false);
  expect(spawnTool!.isReadOnly({})).toBe(false);
});

test("spawn_teammate description does not require load_skill before obvious delegation", async () => {
  const { createLeaderTools } = await import(
    "../../src/services/manager-automation/autonomous-loop/manager-tools-adapter"
  );
  const tools = createLeaderTools(tempRoot);
  const spawnTool = tools.find((t) => t.name === "spawn_teammate");
  expect(spawnTool?.description).toContain("do not delay an obvious `spawn_teammate` call");
  expect(spawnTool?.description).not.toContain("also `load_skill(\"magister-delegating\")` first");
});

test("createLeaderTools does not include spawn_subagent or check_task_state", async () => {
  const { createLeaderTools } = await import(
    "../../src/services/manager-automation/autonomous-loop/manager-tools-adapter"
  );
  const tools = createLeaderTools(tempRoot);
  const names = tools.map((t) => t.name);
  expect(names).not.toContain("spawn_subagent");
  expect(names).not.toContain("check_task_state");
});
