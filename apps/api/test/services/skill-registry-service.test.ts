import { expect, test } from "bun:test";

import {
  getManagerSkillDefinition,
  getManagerSkillDefinitions,
  isManagerSkillAllowedForRole,
  isManagerSkillId,
} from "../../src/services/skill-registry-service";

test("manager skill registry exposes the canonical skills for the manager agent", () => {
  const definitions = getManagerSkillDefinitions();

  expect(definitions.map((definition) => definition.skillId)).toEqual([
    "answer_user",
    "clarify_requirement",
    "inspect_repo",
    "implement_code",
    "review_changes",
    "run_tests",
    "prepare_delivery",
    "web_research",
  ]);
});

test("manager skill registry resolves metadata and role compatibility", () => {
  expect(isManagerSkillId("implement_code")).toBe(true);
  expect(isManagerSkillId("unknown_skill")).toBe(false);

  expect(getManagerSkillDefinition("review_changes")).toEqual(
    expect.objectContaining({
      skillId: "review_changes",
      allowedRoles: ["reviewer"],
      defaultExecutorClass: "coding_agent",
    }),
  );

  expect(isManagerSkillAllowedForRole("implement_code", "coder")).toBe(true);
  expect(isManagerSkillAllowedForRole("implement_code", "reviewer")).toBe(false);
  expect(isManagerSkillAllowedForRole("prepare_delivery", "lander")).toBe(true);
  expect(isManagerSkillAllowedForRole("prepare_delivery", "coder")).toBe(false);
});
