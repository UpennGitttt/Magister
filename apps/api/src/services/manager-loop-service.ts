import {
  getManagerCapabilityPromptLines,
  getManagerSubagentDefinitions,
  isManagerBaseToolName,
  isManagerSubagentType,
} from "./manager-capability-registry-service";
import { parseManagerDecision } from "./manager-decision-schema";
import {
  parseManagerLoopAction,
  type ManagerLoopAction,
} from "./manager-loop-action-schema";
import {
  executeManagerTool,
  type ManagerToolObservation,
} from "./manager-tool-service";

type ManagerLoopTransportResponse = {
  ok: boolean;
  status: number;
  body?: unknown;
  requestId?: string;
  message?: string;
};

type ManagerLoopFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type ManagerLoopResult = {
  response: ManagerLoopTransportResponse;
  finalMessage: string;
  observations: ManagerToolObservation[];
};

export type ManagerLoopToolEvent =
  | {
      type: "tool.call";
      toolName: string;
      arguments: Record<string, unknown>;
    }
  | {
      type: "tool.result" | "tool.error";
      toolName: string;
      arguments: Record<string, unknown>;
      observation: ManagerToolObservation;
    };

export type ManagerLoopValidationFailure =
  | string
  | {
      message: string;
      forcedToolCall?: {
        toolName: string;
        arguments: Record<string, unknown>;
      };
    };

type RunManagerLoopInput = {
  basePrompt: string;
  workspaceDir: string;
  dispatchModel: (prompt: string) => Promise<ManagerLoopTransportResponse>;
  initialResponse?: ManagerLoopTransportResponse;
  tavilyConfig?: {
    enabled: boolean;
    apiKey?: string;
    baseUrl: string;
    timeoutSeconds: number;
  };
  fetchImpl?: ManagerLoopFetch;
  now?: () => Date;
  maxSteps?: number;
  onToolEvent?: (event: ManagerLoopToolEvent) => Promise<void> | void;
  validateTerminalResponse?: (input: {
    observations: ManagerToolObservation[];
    responseMessage: string;
    action: Exclude<ManagerLoopAction, { kind: "call_tool" }> | null;
    managerDecision: ReturnType<typeof parseManagerDecision>;
    step: number;
  }) => ManagerLoopValidationFailure | null;
};

function extractResponseMessage(response: ManagerLoopTransportResponse) {
  return typeof response.body === "object" && response.body && "message" in response.body
    ? String((response.body as { message?: unknown }).message ?? "")
    : response.message ?? "";
}

function extractJsonCandidate(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function buildObservationPrompt(input: {
  basePrompt: string;
  observations: ManagerToolObservation[];
}) {
  const observationLines =
    input.observations.length > 0
      ? input.observations.map(
          (observation, index) =>
            `${index + 1}. ${observation.toolName} | ok=${observation.ok} | ${observation.summary}`,
        )
      : ["none"];

  return [
    input.basePrompt,
    "",
    "Manager loop mode:",
    '- Return one next action JSON object only. Allowed kinds: "respond", "ask_user", "call_tool", "delegate_subagent", "wait".',
    '- For "call_tool", use only registered base tools and provide arguments.',
    '- For "delegate_subagent", use only registered subagent types and canonical fields.',
    'Convert terminal "respond"/"ask_user"/"delegate_subagent"/"wait" actions into canonical ManagerDecision JSON output.',
    ...getManagerCapabilityPromptLines(),
    "",
    "tool observations:",
    ...observationLines,
  ].join("\n");
}

function buildValidationRepairPrompt(input: {
  basePrompt: string;
  observations: ManagerToolObservation[];
  validationFailure: string;
  previousTerminalOutput: string;
}) {
  return [
    buildObservationPrompt({
      basePrompt: input.basePrompt,
      observations: input.observations,
    }),
    "",
    "Validation failure:",
    input.validationFailure,
    "",
    "Previous terminal output:",
    input.previousTerminalOutput,
  ].join("\n");
}

function getValidationFailureMessage(input: ManagerLoopValidationFailure) {
  return typeof input === "string" ? input : input.message;
}

function actionToManagerDecisionJson(action: Exclude<ManagerLoopAction, { kind: "call_tool" }>) {
  if (action.kind === "respond") {
    return JSON.stringify({
      taskType: "conversation",
      executionMode: "immediate",
      decision: "direct_answer",
      confidence: "high",
      reply: action.reply,
      childWorkItems: [],
      waitingFor: null,
      nextWakeupAt: null,
      warnings: [],
    });
  }

  if (action.kind === "ask_user") {
    return JSON.stringify({
      taskType: "clarify",
      executionMode: "immediate",
      decision: "ask_user",
      confidence: "high",
      reply: action.reply,
      childWorkItems: [],
      waitingFor: null,
      nextWakeupAt: null,
      warnings: [],
    });
  }

  if (action.kind === "delegate_subagent") {
    const subagent = getManagerSubagentDefinitions().find(
      (definition) => definition.subagentType === action.subagentType,
    );
    const skillId = action.skillId ?? subagent?.defaultSkillIds[0] ?? "inspect_repo";
    return JSON.stringify({
      taskType: "coding",
      executionMode: "bounded_execution",
      decision: "spawn_work_items",
      confidence: "high",
      reply: null,
      childWorkItems: [
        {
          roleId: action.subagentType,
          skillId,
          goal: action.goal,
          dependsOn: action.dependsOn ?? [],
          ...(action.whyThisInvocation ? { whyThisInvocation: action.whyThisInvocation } : {}),
          ...(action.completionSignal ? { completionSignal: action.completionSignal } : {}),
        },
      ],
      waitingFor: null,
      nextWakeupAt: null,
      warnings: [],
    });
  }

  return JSON.stringify({
    taskType: "wait",
    executionMode: "long_running",
    decision: "sleep_until",
    confidence: "high",
    reply: null,
    childWorkItems: [],
    waitingFor: action.waitingFor ?? null,
    nextWakeupAt: action.nextWakeupAt,
    warnings: [],
  });
}

export async function runManagerLoop(
  input: RunManagerLoopInput,
): Promise<ManagerLoopResult | null> {
  const maxSteps = input.maxSteps ?? 6;
  const observations: ManagerToolObservation[] = [];
  let prompt = buildObservationPrompt({
    basePrompt: input.basePrompt,
    observations,
  });
  let pendingInitialResponse = input.initialResponse ?? null;

  const executeLoopTool = async (toolName: string, argumentsValue: Record<string, unknown>) => {
    await input.onToolEvent?.({
      type: "tool.call",
      toolName,
      arguments: argumentsValue,
    });

    const observation = await executeManagerTool({
      workspaceDir: input.workspaceDir,
      toolName,
      arguments: argumentsValue,
      ...(input.now ? { now: input.now } : {}),
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      ...(input.tavilyConfig ? { tavilyConfig: input.tavilyConfig } : {}),
    });
    observations.push(observation);
    await input.onToolEvent?.({
      type: observation.ok ? "tool.result" : "tool.error",
      toolName,
      arguments: argumentsValue,
      observation,
    });
    prompt = buildObservationPrompt({
      basePrompt: input.basePrompt,
      observations,
    });
  };

  for (let step = 1; step <= maxSteps; step += 1) {
    const response =
      pendingInitialResponse ??
      (await input.dispatchModel(prompt));
    pendingInitialResponse = null;
    const responseMessage = extractResponseMessage(response);
    if (!(response.ok && response.status >= 200 && response.status < 300)) {
      return {
        response,
        finalMessage: responseMessage,
        observations: [...observations],
      };
    }

    const parsed = extractJsonCandidate(responseMessage);
    const parsedDecision = parseManagerDecision(parsed);
    if (parsedDecision) {
      const validationFailure = input.validateTerminalResponse?.({
        observations,
        responseMessage,
        action: null,
        managerDecision: parsedDecision,
        step,
      });
      if (validationFailure) {
        if (
          typeof validationFailure !== "string" &&
          validationFailure.forcedToolCall
        ) {
          await executeLoopTool(
            validationFailure.forcedToolCall.toolName,
            validationFailure.forcedToolCall.arguments,
          );
          continue;
        }
        prompt = buildValidationRepairPrompt({
          basePrompt: input.basePrompt,
          observations,
          validationFailure: getValidationFailureMessage(validationFailure),
          previousTerminalOutput: responseMessage,
        });
        continue;
      }
      return {
        response,
        finalMessage: responseMessage,
        observations: [...observations],
      };
    }
    const action = parseManagerLoopAction(parsed, {
      isToolName: (toolName) => isManagerBaseToolName(toolName),
      isSubagentType: (subagentType) => isManagerSubagentType(subagentType),
    });
    if (!action) {
      return null;
    }

    if (action.kind !== "call_tool") {
      const validationFailure = input.validateTerminalResponse?.({
        observations,
        responseMessage,
        action,
        managerDecision: null,
        step,
      });
      if (validationFailure) {
        if (
          typeof validationFailure !== "string" &&
          validationFailure.forcedToolCall
        ) {
          await executeLoopTool(
            validationFailure.forcedToolCall.toolName,
            validationFailure.forcedToolCall.arguments,
          );
          continue;
        }
        prompt = buildValidationRepairPrompt({
          basePrompt: input.basePrompt,
          observations,
          validationFailure: getValidationFailureMessage(validationFailure),
          previousTerminalOutput: responseMessage,
        });
        continue;
      }
      return {
        response,
        finalMessage: actionToManagerDecisionJson(action),
        observations: [...observations],
      };
    }

    await executeLoopTool(action.toolName, action.arguments);
  }

  const exhaustedReply =
    "Manager loop exceeded the local step budget before reaching a terminal action.";
  return {
    response: {
      ok: true,
      status: 200,
      message: exhaustedReply,
    },
    finalMessage: JSON.stringify({
      taskType: "clarify",
      executionMode: "immediate",
      decision: "ask_user",
      confidence: "low",
      reply: exhaustedReply,
      childWorkItems: [],
      waitingFor: null,
      nextWakeupAt: null,
      warnings: ["manager_loop_step_budget_exhausted"],
    }),
    observations: [...observations],
  };
}
