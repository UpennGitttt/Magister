export const FOLLOWUP_ROLE_IDS = ["architect", "coder", "reviewer", "lander", "deepresearcher"] as const;

export type FollowupRoleId = (typeof FOLLOWUP_ROLE_IDS)[number];

export type TaskManagerCoordinationAction =
  | "direct_answer"
  | "tool_answer"
  | "clarify"
  | "assign"
  | "handoff"
  | "send_message"
  | "autonomous_delegate";
