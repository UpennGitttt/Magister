export const APPROVAL_STATES = [
  "pending",
  "approved",
  "rejected",
  "expired",
] as const;

export type ApprovalState = (typeof APPROVAL_STATES)[number];
