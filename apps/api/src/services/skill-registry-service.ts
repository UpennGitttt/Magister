import type { FollowupRoleId } from "./planner-hints";

export const MANAGER_SKILL_IDS = [
  "answer_user",
  "clarify_requirement",
  "inspect_repo",
  "implement_code",
  "review_changes",
  "run_tests",
  "prepare_delivery",
  "web_research",
] as const;

export type ManagerSkillId = (typeof MANAGER_SKILL_IDS)[number];

export type ManagerSkillDefinition = {
  skillId: ManagerSkillId;
  allowedRoles: FollowupRoleId[];
  defaultExecutorClass: "coding_agent" | "model";
  description: string;
};

const MANAGER_SKILL_DEFINITIONS: readonly ManagerSkillDefinition[] = [
  {
    skillId: "answer_user",
    allowedRoles: [],
    defaultExecutorClass: "model",
    description: "Provide a direct user-facing answer without spawning child work items.",
  },
  {
    skillId: "clarify_requirement",
    allowedRoles: [],
    defaultExecutorClass: "model",
    description: "Ask the user for missing information before continuing.",
  },
  {
    skillId: "inspect_repo",
    allowedRoles: ["architect", "coder"],
    defaultExecutorClass: "coding_agent",
    description: "Inspect the repository and summarize implementation constraints.",
  },
  {
    skillId: "implement_code",
    allowedRoles: ["architect", "coder"],
    defaultExecutorClass: "coding_agent",
    description: "Make source changes in the workspace.",
  },
  {
    skillId: "review_changes",
    allowedRoles: ["reviewer"],
    defaultExecutorClass: "coding_agent",
    description: "Review or critique proposed changes.",
  },
  {
    skillId: "run_tests",
    allowedRoles: ["coder", "reviewer"],
    defaultExecutorClass: "coding_agent",
    description: "Run validation commands and summarize failures.",
  },
  {
    skillId: "prepare_delivery",
    allowedRoles: ["lander"],
    defaultExecutorClass: "coding_agent",
    description: "Prepare delivery, release, or landing output.",
  },
  {
    skillId: "web_research",
    allowedRoles: ["deepresearcher"],
    defaultExecutorClass: "model",
    description: "Conduct multi-step web research and produce structured analytical reports with cited evidence.",
  },
] as const;

export function getManagerSkillDefinitions() {
  return [...MANAGER_SKILL_DEFINITIONS];
}

export function isManagerSkillId(value: unknown): value is ManagerSkillId {
  return typeof value === "string" && (MANAGER_SKILL_IDS as readonly string[]).includes(value);
}

export function getManagerSkillDefinition(skillId: string) {
  return MANAGER_SKILL_DEFINITIONS.find((definition) => definition.skillId === skillId) ?? null;
}

export function isManagerSkillAllowedForRole(skillId: string, roleId: FollowupRoleId) {
  const definition = getManagerSkillDefinition(skillId);
  if (!definition) {
    return false;
  }

  return definition.allowedRoles.includes(roleId);
}
