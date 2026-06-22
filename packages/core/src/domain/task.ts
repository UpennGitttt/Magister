export const TASK_STATES = [
  "INTAKE",
  "CLARIFYING",
  "PLANNING",
  "EXECUTING",
  "REVIEWING",
  "TESTING",
  "PR_OPEN",
  "MERGE_WAITING",
  "DONE",
  "FAILED",
  "PAUSED",
] as const;

export type TaskState = (typeof TASK_STATES)[number];
