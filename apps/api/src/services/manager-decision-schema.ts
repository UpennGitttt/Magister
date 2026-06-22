import { FOLLOWUP_ROLE_IDS } from "./planner-hints";
import { isManagerSkillAllowedForRole, isManagerSkillId } from "./skill-registry-service";

export const MANAGER_TASK_TYPES = [
  "conversation",
  "coding",
  "mixed",
  "clarify",
  "wait",
] as const;

export const MANAGER_DECISIONS = [
  "direct_answer",
  "ask_user",
  "use_skill",
  "spawn_work_items",
  "sleep_until",
] as const;

export const MANAGER_EXECUTION_MODES = [
  "immediate",
  "bounded_execution",
  "long_running",
] as const;

export type ManagerTaskType = (typeof MANAGER_TASK_TYPES)[number];

export type ManagerDecisionType = (typeof MANAGER_DECISIONS)[number];

export type ManagerExecutionMode = (typeof MANAGER_EXECUTION_MODES)[number];

export type ManagerSkill = {
  skillId: string;
  goal: string;
};

export const MANAGER_WORKSPACE_STRATEGIES = ["workspace_root", "git_worktree"] as const;

export type ManagerWorkspaceStrategy = (typeof MANAGER_WORKSPACE_STRATEGIES)[number];

export type ManagerChildExecutionBudget = {
  maxAttempts?: number;
  maxSteps?: number;
  maxRuntimeMinutes?: number;
};

export type ManagerChildRoutingHints = {
  primaryAdapterId?: string;
  routingStrategy?: "agent_only" | "prefer_agent" | "fallback_model" | "model_only";
  fallbackAdapterId?: string;
  executorClass?: "coding_agent" | "model";
};

export type ManagerChildWorkItem = {
  subagentType: (typeof FOLLOWUP_ROLE_IDS)[number];
  roleId: (typeof FOLLOWUP_ROLE_IDS)[number];
  skillId: string;
  goal: string;
  dependsOn: Array<(typeof FOLLOWUP_ROLE_IDS)[number]>;
  executionKind?: "delegated_subagent";
  whyThisInvocation?: string;
  whyThisWorkItem?: string;
  completionSignal?: string;
  handoffNotes?: string;
  executionBudget?: ManagerChildExecutionBudget;
  workspaceStrategy?: ManagerWorkspaceStrategy;
  routingHints?: ManagerChildRoutingHints;
  primaryAdapterId?: string;
  routingStrategy?: "agent_only" | "prefer_agent" | "fallback_model" | "model_only";
  fallbackAdapterId?: string;
  executorClass?: "coding_agent" | "model";
};

export type ManagerDecision = {
  taskType: ManagerTaskType;
  executionMode: ManagerExecutionMode;
  decision: ManagerDecisionType;
  confidence: "high" | "medium" | "low";
  reply: string | null;
  skills: ManagerSkill[];
  childWorkItems: ManagerChildWorkItem[];
  waitingFor: string | null;
  nextWakeupAt: string | null;
  warnings: string[];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeTaskType(value: unknown): ManagerTaskType | null {
  if (isManagerTaskType(value)) {
    return value;
  }

  if (value === "greeting" || value === "general_greeting") {
    return "conversation";
  }

  if (value === "ask_user" || value === "clarification") {
    return "clarify";
  }

  return null;
}

function normalizeWaitingFor(value: unknown) {
  const direct = readString(value);
  if (direct) {
    return direct;
  }

  if (Array.isArray(value) && value.length === 0) {
    return null;
  }

  return null;
}

const ISO_TIMESTAMP_WITH_TIMEZONE_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/;

function readTimestampString(value: unknown) {
  const normalized = readString(value);
  if (!normalized) {
    return null;
  }

  if (!ISO_TIMESTAMP_WITH_TIMEZONE_PATTERN.test(normalized)) {
    return null;
  }

  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function isManagerTaskType(value: unknown): value is ManagerTaskType {
  return typeof value === "string" && (MANAGER_TASK_TYPES as readonly string[]).includes(value);
}

function isManagerDecisionType(value: unknown): value is ManagerDecisionType {
  return typeof value === "string" && (MANAGER_DECISIONS as readonly string[]).includes(value);
}

function isManagerExecutionMode(value: unknown): value is ManagerExecutionMode {
  return typeof value === "string" && (MANAGER_EXECUTION_MODES as readonly string[]).includes(value);
}

function isManagerConfidence(value: unknown): value is ManagerDecision["confidence"] {
  return value === "high" || value === "medium" || value === "low";
}

function normalizeConfidence(value: unknown): ManagerDecision["confidence"] | null {
  if (isManagerConfidence(value)) {
    return value;
  }

  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return normalizeConfidence(numeric);
    }
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    if (value >= 0.85) {
      return "high";
    }

    if (value >= 0.5) {
      return "medium";
    }

    return "low";
  }

  return null;
}

function isFollowupRoleId(value: unknown): value is ManagerChildWorkItem["roleId"] {
  return typeof value === "string" && (FOLLOWUP_ROLE_IDS as readonly string[]).includes(value);
}

function isManagerWorkspaceStrategy(value: unknown): value is ManagerWorkspaceStrategy {
  return (
    typeof value === "string" &&
    (MANAGER_WORKSPACE_STRATEGIES as readonly string[]).includes(value)
  );
}

function readPositiveInteger(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  if (value < 1) {
    return null;
  }

  return Math.floor(value);
}

function normalizeExecutionBudget(value: unknown): ManagerChildExecutionBudget | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const maxAttempts = readPositiveInteger(value.maxAttempts);
  const maxSteps = readPositiveInteger(value.maxSteps);
  const maxRuntimeMinutes = readPositiveInteger(value.maxRuntimeMinutes);

  const normalized: ManagerChildExecutionBudget = {
    ...(maxAttempts ? { maxAttempts } : {}),
    ...(maxSteps ? { maxSteps } : {}),
    ...(maxRuntimeMinutes ? { maxRuntimeMinutes } : {}),
  };

  return Object.keys(normalized).length > 0 ? normalized : null;
}

function normalizeRoutingHints(value: unknown): ManagerChildRoutingHints | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const primaryAdapterId = readString(value.primaryAdapterId);
  const fallbackAdapterId = readString(value.fallbackAdapterId);

  const normalized: ManagerChildRoutingHints = {
    ...(primaryAdapterId ? { primaryAdapterId } : {}),
    ...(value.routingStrategy === "agent_only" ||
    value.routingStrategy === "prefer_agent" ||
    value.routingStrategy === "fallback_model" ||
    value.routingStrategy === "model_only"
      ? { routingStrategy: value.routingStrategy }
      : {}),
    ...(fallbackAdapterId ? { fallbackAdapterId } : {}),
    ...(value.executorClass === "coding_agent" || value.executorClass === "model"
      ? { executorClass: value.executorClass }
      : {}),
  };

  return Object.keys(normalized).length > 0 ? normalized : null;
}

function normalizeStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    const normalized = readString(item);
    return normalized ? [normalized] : [];
  });
}

function normalizeSkills(value: unknown): ManagerSkill[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!isPlainObject(item)) {
      return [];
    }

    const skillId = readString(item.skillId);
    const goal = readString(item.goal);
    if (!skillId || !goal || !isManagerSkillId(skillId)) {
      return [];
    }

    return [{ skillId, goal }];
  });
}

function hasCyclicChildWorkItemDependencies(childWorkItems: ManagerChildWorkItem[]) {
  const dependsOnByRoleId = new Map<
    ManagerChildWorkItem["roleId"],
    ManagerChildWorkItem["dependsOn"]
  >(
    childWorkItems.map((childWorkItem) => [
      childWorkItem.roleId,
      childWorkItem.dependsOn,
    ]),
  );
  const visiting = new Set<ManagerChildWorkItem["roleId"]>();
  const visited = new Set<ManagerChildWorkItem["roleId"]>();

  const visit = (roleId: ManagerChildWorkItem["roleId"]): boolean => {
    if (visited.has(roleId)) {
      return false;
    }

    if (visiting.has(roleId)) {
      return true;
    }

    visiting.add(roleId);
    for (const dependencyRoleId of dependsOnByRoleId.get(roleId) ?? []) {
      if (visit(dependencyRoleId)) {
        return true;
      }
    }

    visiting.delete(roleId);
    visited.add(roleId);
    return false;
  };

  for (const roleId of dependsOnByRoleId.keys()) {
    if (visit(roleId)) {
      return true;
    }
  }

  return false;
}

function normalizeChildWorkItems(value: unknown): ManagerChildWorkItem[] | null {
  if (!Array.isArray(value)) {
    return [];
  }

  const seenRoleIds = new Set<string>();
  const normalized: ManagerChildWorkItem[] = [];

  for (const item of value) {
    if (!isPlainObject(item)) {
      continue;
    }

    const subagentType = isFollowupRoleId(item.subagentType) ? item.subagentType : null;
    const roleId = isFollowupRoleId(item.roleId) ? item.roleId : null;
    const resolvedRoleId = roleId ?? subagentType;
    const skillId = readString(item.skillId);
    const goal = readString(item.goal);

    if (roleId && subagentType && roleId !== subagentType) {
      continue;
    }

    if (
      !resolvedRoleId ||
      !skillId ||
      !goal ||
      !isManagerSkillId(skillId) ||
      !isManagerSkillAllowedForRole(skillId, resolvedRoleId)
    ) {
      continue;
    }

    const dependsOn = normalizeStringArray(item.dependsOn).filter(
      (dependencyRoleId, index, array): dependencyRoleId is ManagerChildWorkItem["dependsOn"][number] =>
        isFollowupRoleId(dependencyRoleId) &&
        dependencyRoleId !== resolvedRoleId &&
        array.indexOf(dependencyRoleId) === index,
    );

    if (seenRoleIds.has(resolvedRoleId)) {
      return null;
    }
    seenRoleIds.add(resolvedRoleId);

    const whyThisInvocation =
      (typeof item.whyThisInvocation === "string" && item.whyThisInvocation.trim().length > 0
        ? item.whyThisInvocation.trim()
        : null) ??
      (typeof item.whyThisWorkItem === "string" && item.whyThisWorkItem.trim().length > 0
        ? item.whyThisWorkItem.trim()
        : null);

    const hasExecutionBudget = Object.prototype.hasOwnProperty.call(item, "executionBudget");
    const executionBudget = normalizeExecutionBudget(item.executionBudget);
    if (hasExecutionBudget && !executionBudget) {
      continue;
    }

    const hasWorkspaceStrategy = Object.prototype.hasOwnProperty.call(item, "workspaceStrategy");
    const workspaceStrategy = isManagerWorkspaceStrategy(item.workspaceStrategy)
      ? item.workspaceStrategy
      : null;
    if (hasWorkspaceStrategy && !workspaceStrategy) {
      continue;
    }

    const normalizedRoutingHintsFromLegacy = normalizeRoutingHints({
      primaryAdapterId: item.primaryAdapterId,
      routingStrategy: item.routingStrategy,
      fallbackAdapterId: item.fallbackAdapterId,
      executorClass: item.executorClass,
    });
    const hasRoutingHints = Object.prototype.hasOwnProperty.call(item, "routingHints");
    const routingHints = normalizeRoutingHints(item.routingHints) ?? normalizedRoutingHintsFromLegacy;
    if (hasRoutingHints && !routingHints) {
      continue;
    }

    normalized.push({
      subagentType: subagentType ?? resolvedRoleId,
      roleId: resolvedRoleId,
      skillId,
      goal,
      dependsOn,
      executionKind: "delegated_subagent",
      ...(whyThisInvocation
        ? { whyThisInvocation }
        : {}),
      ...(whyThisInvocation
        ? { whyThisWorkItem: whyThisInvocation }
        : {}),
      ...(typeof item.completionSignal === "string" && item.completionSignal.trim().length > 0
        ? { completionSignal: item.completionSignal.trim() }
        : {}),
      ...(typeof item.handoffNotes === "string" && item.handoffNotes.trim().length > 0
        ? { handoffNotes: item.handoffNotes.trim() }
        : {}),
      ...(executionBudget
        ? { executionBudget }
        : {}),
      ...(workspaceStrategy
        ? { workspaceStrategy }
        : {}),
      ...(routingHints
        ? { routingHints }
        : {}),
      ...(routingHints?.primaryAdapterId
        ? { primaryAdapterId: routingHints.primaryAdapterId }
        : {}),
      ...(routingHints?.routingStrategy
        ? { routingStrategy: routingHints.routingStrategy }
        : {}),
      ...(routingHints?.fallbackAdapterId
        ? { fallbackAdapterId: routingHints.fallbackAdapterId }
        : {}),
      ...(routingHints?.executorClass
        ? { executorClass: routingHints.executorClass }
        : {}),
    });
  }

  const definedRoleIds = new Set(
    normalized.map((childWorkItem) => childWorkItem.roleId),
  );
  for (const childWorkItem of normalized) {
    if (
      childWorkItem.dependsOn.some(
        (dependencyRoleId) => !definedRoleIds.has(dependencyRoleId),
      )
    ) {
      return null;
    }
  }

  if (hasCyclicChildWorkItemDependencies(normalized)) {
    return null;
  }

  return normalized;
}

function inferExecutionMode(decision: ManagerDecisionType): ManagerExecutionMode {
  if (decision === "direct_answer" || decision === "ask_user") {
    return "immediate";
  }

  if (decision === "sleep_until") {
    return "long_running";
  }

  return "bounded_execution";
}

export function parseManagerDecision(value: unknown): ManagerDecision | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const taskType = normalizeTaskType(value.taskType);
  const confidence = normalizeConfidence(value.confidence);

  if (
    !taskType ||
    !isManagerDecisionType(value.decision) ||
    !confidence
  ) {
    return null;
  }

  const childWorkItems = normalizeChildWorkItems(value.childWorkItems);
  const skills = normalizeSkills(value.skills);
  const waitingFor = normalizeWaitingFor(value.waitingFor);
  const nextWakeupAt = readTimestampString(value.nextWakeupAt);
  const explicitExecutionMode =
    value.executionMode === undefined ? null : isManagerExecutionMode(value.executionMode) ? value.executionMode : null;

  if (!childWorkItems) {
    return null;
  }

  if (value.executionMode !== undefined && explicitExecutionMode === null) {
    return null;
  }

  if (value.decision === "spawn_work_items" && childWorkItems.length === 0) {
    return null;
  }

  if (value.decision === "use_skill" && skills.length === 0) {
    return null;
  }

  if (value.decision === "sleep_until" && !nextWakeupAt) {
    return null;
  }

  const reply = readString(value.reply);

  if (value.decision === "direct_answer" || value.decision === "ask_user") {
    if (!reply || skills.length > 0 || childWorkItems.length > 0 || nextWakeupAt !== null) {
      return null;
    }
  }

  if (value.decision === "use_skill" && childWorkItems.length > 0) {
    return null;
  }

  if (value.decision === "sleep_until" && (skills.length > 0 || childWorkItems.length > 0 || reply)) {
    return null;
  }

  const executionMode = explicitExecutionMode ?? inferExecutionMode(value.decision);

  if (
    ((value.decision === "direct_answer" || value.decision === "ask_user") && executionMode !== "immediate") ||
    (value.decision === "use_skill" && executionMode !== "bounded_execution") ||
    (value.decision === "sleep_until" && executionMode !== "long_running") ||
    (value.decision === "spawn_work_items" &&
      executionMode !== "bounded_execution" &&
      executionMode !== "long_running")
  ) {
    return null;
  }

  return {
    taskType,
    executionMode,
    decision: value.decision,
    confidence,
    reply,
    skills,
    childWorkItems,
    waitingFor,
    nextWakeupAt,
    warnings: normalizeStringArray(value.warnings),
  };
}

export function isManagerDecision(value: unknown): value is ManagerDecision {
  return parseManagerDecision(value) !== null;
}
