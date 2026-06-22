import type { TaskManagerCoordinationAction } from "./planner-hints";

export type TaskManagerDecisionMode =
  | "direct_answer"
  | "tool_answer"
  | "clarify"
  | "heuristic"
  | "explicit_hints"
  | "autonomous_loop";

export function deriveCoordinationAction(input: {
  decisionMode?: TaskManagerDecisionMode | null | undefined;
  childRunCount: number;
  hintedCoordinationAction?: TaskManagerCoordinationAction | null | undefined;
}): TaskManagerCoordinationAction {
  if (input.hintedCoordinationAction) {
    return input.hintedCoordinationAction;
  }

  if (input.decisionMode === "direct_answer") {
    return "direct_answer";
  }

  if (input.decisionMode === "tool_answer") {
    return "tool_answer";
  }

  if (input.decisionMode === "clarify") {
    return "clarify";
  }

  if (input.decisionMode === "autonomous_loop") {
    return "autonomous_delegate";
  }

  return input.childRunCount > 0 ? "assign" : "direct_answer";
}

export function mapLegacyPlanningModeToDecisionMode(
  planningMode?: string | null,
): TaskManagerDecisionMode | undefined {
  switch (planningMode) {
    case "conversational_shortcut":
      return "direct_answer";
    case "information_shortcut":
      return "tool_answer";
    case "clarify":
      return "clarify";
    case "heuristic":
      return "heuristic";
    case "explicit_hints":
      return "explicit_hints";
    default:
      return undefined;
  }
}
