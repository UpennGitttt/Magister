export const ROLE_RUNTIME_STATES = [
  "CREATED",
  "READY",
  "RUNNING",
  "WAITING_FOR_EXECUTOR",
  "WAITING_FOR_INPUT",
  "BLOCKED",
  "FAILED",
  "COMPLETED",
  "CANCELLED",
] as const;

export type RoleRuntimeState = (typeof ROLE_RUNTIME_STATES)[number];
