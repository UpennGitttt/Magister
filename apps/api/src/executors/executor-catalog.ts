export type ExecutorAdapterId = string;

/** Canonical orchestration role is `leader`. `manager` was the original
 *  name and is still accepted on the wire (config files, old DB rows) —
 *  see alias normalization in role-routing-service.ts. */
export type ExecutorRoleId = "leader" | "architect" | "coder" | "reviewer" | "lander" | "deepresearcher";
export type ExecutorType = "coding_agent" | "model";
export type RoleRoutingStrategy =
  | "agent_only"
  | "prefer_agent"
  | "fallback_model"
  | "model_only";

export type RoleRoutingConfigRecord = {
  adapterId: ExecutorAdapterId;
  strategy: RoleRoutingStrategy;
  fallbackAdapterId?: ExecutorAdapterId;
};

type ExecutorCatalogEntryCore = {
  adapterId: ExecutorAdapterId;
  displayName: string;
  roleTargets: readonly ExecutorRoleId[];
  configKey: string;
  executionMode: "cli" | "api";
  notes: string;
};

export type ExecutorCatalogEntry =
  | (ExecutorCatalogEntryCore & { executorType: ExecutorType })
  | (ExecutorCatalogEntryCore & { executorType?: undefined });

export const EXECUTOR_CATALOG: readonly ExecutorCatalogEntry[] = [
  {
    adapterId: "codex",
    displayName: "Codex",
    executorType: "coding_agent",
    roleTargets: ["leader", "architect", "coder", "reviewer", "lander"],
    configKey: "MAGISTER_MODEL_CODEX",
    executionMode: "cli",
    notes: "Primary coding-agent slot for design, implementation, and landing work.",
  },
  {
    adapterId: "qoder",
    displayName: "Qoder",
    executorType: "coding_agent",
    roleTargets: ["reviewer"],
    configKey: "MAGISTER_MODEL_QODER",
    executionMode: "cli",
    notes: "Primary review slot for the current Codex/Qoder delivery chain.",
  },
  {
    adapterId: "opencode",
    displayName: "OpenCode",
    executorType: "coding_agent",
    roleTargets: ["architect", "coder"],
    configKey: "MAGISTER_MODEL_OPENCODE",
    executionMode: "cli",
    notes: "Secondary coding slot for heterogeneous execution and fallback routing.",
  },
  {
    adapterId: "claude_code",
    displayName: "Claude Code",
    executorType: "coding_agent",
    roleTargets: ["leader"],
    configKey: "MAGISTER_MODEL_CLAUDE_CODE",
    executionMode: "cli",
    notes: "Optional compatibility slot for leader-style orchestration when Claude access is available again.",
  },
  {
    adapterId: "model",
    displayName: "Model Fallback",
    executorType: "model",
    roleTargets: ["leader", "architect", "reviewer"],
    configKey: "MAGISTER_MODEL_GENERAL_MODEL",
    executionMode: "api",
    notes: "General-purpose model slot for leader-first planning, review, and fallback cognition.",
  },
];

export const DEFAULT_ROLE_ROUTING: Record<ExecutorRoleId, RoleRoutingConfigRecord> = {
  leader: {
    adapterId: "model",
    strategy: "model_only",
  },
  architect: {
    adapterId: "codex",
    strategy: "agent_only",
  },
  coder: {
    adapterId: "codex",
    strategy: "agent_only",
  },
  reviewer: {
    adapterId: "qoder",
    strategy: "fallback_model",
    fallbackAdapterId: "model",
  },
  lander: {
    adapterId: "codex",
    strategy: "agent_only",
  },
  deepresearcher: {
    adapterId: "model",
    strategy: "model_only",
  },
};

export function listExecutorCatalog(): ExecutorCatalogEntry[] {
  return EXECUTOR_CATALOG.map((entry) => ({
    ...entry,
    roleTargets: [...entry.roleTargets],
  }));
}

export function getExecutorCatalogEntry(adapterId: string): ExecutorCatalogEntry | null {
  return EXECUTOR_CATALOG.find((entry) => entry.adapterId === adapterId) ?? null;
}

export function getDefaultAdapterIdForRole(roleId: string): ExecutorAdapterId | null {
  return roleId in DEFAULT_ROLE_ROUTING
    ? DEFAULT_ROLE_ROUTING[roleId as ExecutorRoleId].adapterId
    : null;
}

export function getDefaultRoleRoutingForRole(roleId: string): RoleRoutingConfigRecord | null {
  if (!(roleId in DEFAULT_ROLE_ROUTING)) {
    return null;
  }

  return { ...DEFAULT_ROLE_ROUTING[roleId as ExecutorRoleId] };
}
