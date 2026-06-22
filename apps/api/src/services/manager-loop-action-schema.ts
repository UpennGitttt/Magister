import type { ManagerBaseToolName } from "./manager-capability-registry-service";

export type ManagerLoopAction =
  | {
      kind: "respond";
      reply: string;
    }
  | {
      kind: "ask_user";
      reply: string;
    }
  | {
      kind: "call_tool";
      toolName: ManagerBaseToolName;
      arguments: Record<string, unknown>;
    }
  | {
      kind: "delegate_subagent";
      subagentType: "architect" | "coder" | "reviewer" | "lander" | "deepresearcher";
      goal: string;
      skillId?: string;
      dependsOn?: string[];
      whyThisInvocation?: string;
      completionSignal?: string;
    }
  | {
      kind: "wait";
      waitingFor?: string;
      nextWakeupAt: string;
    };

type Validators = {
  isToolName?: (toolName: string) => boolean;
  isSubagentType?: (subagentType: string) => boolean;
};

const LEGACY_DELEGATION_FIELDS = [
  "delegateAgent",
  "taskDescription",
  "description",
  "action",
  "details",
  "expectedOutput",
] as const;

const ISO_TIMESTAMP_WITH_TIMEZONE_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeDependsOn(value: unknown) {
  if (!Array.isArray(value)) {
    return [] as string[];
  }

  return value.flatMap((item) => {
    const normalized = readString(item);
    return normalized ? [normalized] : [];
  }).filter((item, index, array) => array.indexOf(item) === index);
}

function readTimestampString(value: unknown) {
  const normalized = readString(value);
  if (!normalized || !ISO_TIMESTAMP_WITH_TIMEZONE_PATTERN.test(normalized)) {
    return null;
  }

  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function parseManagerLoopAction(
  value: unknown,
  validators: Validators = {},
): ManagerLoopAction | null {
  if (!isPlainObject(value) || typeof value.kind !== "string") {
    return null;
  }

  if (value.kind === "respond" || value.kind === "ask_user") {
    const reply = readString(value.reply);
    if (!reply || value.nextWakeupAt !== undefined || value.waitingFor !== undefined) {
      return null;
    }

    return {
      kind: value.kind,
      reply,
    };
  }

  if (value.kind === "call_tool") {
    const toolName = readString(value.toolName);
    if (
      !toolName ||
      !validators.isToolName ||
      !validators.isToolName(toolName) ||
      !isPlainObject(value.arguments)
    ) {
      return null;
    }

    return {
      kind: "call_tool",
      toolName: toolName as ManagerBaseToolName,
      arguments: value.arguments,
    };
  }

  if (value.kind === "delegate_subagent") {
    if (LEGACY_DELEGATION_FIELDS.some((field) => field in value)) {
      return null;
    }

    const subagentType = readString(value.subagentType);
    const goal = readString(value.goal);
    if (
      !subagentType ||
      !goal ||
      !validators.isSubagentType ||
      !validators.isSubagentType(subagentType)
    ) {
      return null;
    }

    return {
      kind: "delegate_subagent",
      subagentType: subagentType as "architect" | "coder" | "reviewer" | "lander",
      goal,
      ...(readString(value.skillId) ? { skillId: readString(value.skillId)! } : {}),
      ...(normalizeDependsOn(value.dependsOn).length > 0
        ? { dependsOn: normalizeDependsOn(value.dependsOn) }
        : {}),
      ...(readString(value.whyThisInvocation)
        ? { whyThisInvocation: readString(value.whyThisInvocation)! }
        : {}),
      ...(readString(value.completionSignal)
        ? { completionSignal: readString(value.completionSignal)! }
        : {}),
    };
  }

  if (value.kind === "wait") {
    const nextWakeupAt = readTimestampString(value.nextWakeupAt);
    if (!nextWakeupAt || value.reply !== undefined) {
      return null;
    }

    return {
      kind: "wait",
      ...(readString(value.waitingFor) ? { waitingFor: readString(value.waitingFor)! } : {}),
      nextWakeupAt,
    };
  }

  return null;
}

export function isManagerLoopAction(
  value: unknown,
  validators: Validators = {},
): value is ManagerLoopAction {
  return parseManagerLoopAction(value, validators) !== null;
}
