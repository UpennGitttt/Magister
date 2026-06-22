export const EXECUTOR_ERROR_CATEGORIES = [
  "configuration_error",
  "auth_error",
  "runtime_unavailable",
  "capability_mismatch",
  "workspace_error",
  "tool_error",
  "execution_error",
  "rate_limit",
  "timeout",
  "cancelled",
] as const;

export type ExecutorErrorCategory = (typeof EXECUTOR_ERROR_CATEGORIES)[number];
