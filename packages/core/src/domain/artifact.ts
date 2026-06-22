export const ARTIFACT_TYPES = [
  "clarified-requirement",
  "spec",
  "plan",
  "design-decision",
  "diff",
  "review-feedback",
  "test-result",
  "pr-link",
] as const;

export type ArtifactType = (typeof ARTIFACT_TYPES)[number];
