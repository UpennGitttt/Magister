import { getManagerSkillDefinitions, type ManagerSkillId } from "./skill-registry-service";

export type ManagerBaseToolName =
  | "time_now"
  | "read_file"
  | "list_dir"
  | "grep_repo"
  | "bash"
  | "web_search"
  | "web_fetch";

export type ManagerBaseToolDefinition = {
  kind: "base_tool";
  name: ManagerBaseToolName;
  toolName: ManagerBaseToolName;
  description: string;
  argumentSchemaSummary: string;
  whenToUse: string;
  whenNotToUse: string;
  returnsSummary: string;
};

export type ManagerDelegatedSubagentDefinition = {
  kind: "delegated_subagent";
  name: "architect" | "coder" | "reviewer" | "lander" | "deepresearcher";
  subagentType: "architect" | "coder" | "reviewer" | "lander" | "deepresearcher";
  description: string;
  whenToUse: string;
  whenNotToUse: string;
  ownedOutcomes: string[];
  defaultSkillIds: ManagerSkillId[];
};

export type ManagerTerminalActionDefinition = {
  kind: "terminal_action";
  name: "respond" | "ask_user_question" | "wait";
  actionKind: "respond" | "ask_user" | "wait";
  description: string;
  whenToUse: string;
  whenNotToUse: string;
};

export type ManagerCapabilityDefinition =
  | ManagerBaseToolDefinition
  | ManagerDelegatedSubagentDefinition
  | ManagerTerminalActionDefinition;

const BASE_TOOL_DEFINITIONS: readonly ManagerBaseToolDefinition[] = [
  {
    kind: "base_tool",
    name: "time_now",
    toolName: "time_now",
    description: "Read the current local wall clock from this Mac host and return a normalized timestamp with timezone context.",
    argumentSchemaSummary: "{}",
    whenToUse: "Use for questions about the current time, date, day, or timezone-sensitive runtime context.",
    whenNotToUse: "Do not delegate or hallucinate realtime access when the question is only asking for the current local time/date.",
    returnsSummary: "Returns ISO time, formatted local time, and timezone details.",
  },
  {
    kind: "base_tool",
    name: "read_file",
    toolName: "read_file",
    description: "Read a file inside the current workspace and optionally slice by line range.",
    argumentSchemaSummary: '{ "path": "relative/path", "startLine?": number, "endLine?": number }',
    whenToUse: "Use when you need exact file contents from the current workspace before answering or delegating.",
    whenNotToUse: "Do not use for paths outside the current workspace or as a substitute for broad repo search when you do not know the file yet.",
    returnsSummary: "Returns normalized file content, line range metadata, and the resolved workspace-relative path.",
  },
  {
    kind: "base_tool",
    name: "list_dir",
    toolName: "list_dir",
    description: "List files and directories inside the current workspace with compact metadata.",
    argumentSchemaSummary: '{ "path?": "relative/path" }',
    whenToUse: "Use when you need to understand local project structure before reading or explaining the repository.",
    whenNotToUse: "Do not use for paths outside the workspace or when you already know the exact file you need.",
    returnsSummary: "Returns workspace-relative entries with type and basic size metadata.",
  },
  {
    kind: "base_tool",
    name: "grep_repo",
    toolName: "grep_repo",
    description: "Search text content across workspace files and return structured matches.",
    argumentSchemaSummary: '{ "query": "text", "path?": "relative/path" }',
    whenToUse: "Use when you need to find where a symbol, phrase, TODO, route, or config appears in the local repository.",
    whenNotToUse: "Do not use for internet search or when exact file location is already known and direct read is cheaper.",
    returnsSummary: "Returns matched files, line numbers, and short snippets.",
  },
  {
    kind: "base_tool",
    name: "bash",
    toolName: "bash",
    description: "Run a workspace-scoped shell command on this local Mac runtime and capture compact stdout/stderr results.",
    argumentSchemaSummary: '{ "command": "shell command" }',
    whenToUse: "Use for local inspection, git status, package scripts, or other deterministic workspace shell commands.",
    whenNotToUse: "Do not use outside the workspace or for destructive commands when read-only inspection would suffice.",
    returnsSummary: "Returns exit code, stdout, stderr, and a compact execution summary.",
  },
  {
    kind: "base_tool",
    name: "web_search",
    toolName: "web_search",
    description: "Use the configured Tavily-backed web search integration to search the public web.",
    argumentSchemaSummary:
      '{ "query": "search text", "maxResults?": number, "topic?": "general|news" }',
    whenToUse: "Use for realtime information, news, web facts, or sources not available in the local workspace.",
    whenNotToUse: "Do not use for repository-local questions or when the answer should come from current workspace files.",
    returnsSummary: "Returns Tavily answer text plus structured search results.",
  },
  {
    kind: "base_tool",
    name: "web_fetch",
    toolName: "web_fetch",
    description: "Use the configured Tavily extract API to fetch and summarize a specific public URL.",
    argumentSchemaSummary: '{ "url": "https://..." }',
    whenToUse: "Use when you already know the target URL and need page contents rather than generic web search results.",
    whenNotToUse: "Do not use for local files or when you first need to discover sources via web_search.",
    returnsSummary: "Returns extracted page title, canonical URL, and a compact excerpt.",
  },
] as const;

const SUBAGENT_DEFINITIONS: readonly ManagerDelegatedSubagentDefinition[] = [
  {
    kind: "delegated_subagent",
    name: "architect",
    subagentType: "architect",
    description: "Explain architecture, frontend/backend structure, design intent, and technical approach for the current repository.",
    whenToUse: "Use when the user wants explanation, walkthrough, architecture synthesis, or structural understanding of the codebase.",
    whenNotToUse: "Do not use for direct code implementation or pure bug review when no architecture synthesis is needed.",
    ownedOutcomes: ["architecture walkthrough", "frontend explanation", "design summary"],
    defaultSkillIds: ["inspect_repo"],
  },
  {
    kind: "delegated_subagent",
    name: "coder",
    subagentType: "coder",
    description: "Inspect files, implement code changes, run local validation commands, and produce concrete workspace results.",
    whenToUse: "Use when the task needs code edits, local commands, or concrete implementation work inside the repository.",
    whenNotToUse: "Do not use for pure explanation or review when no code execution is required.",
    ownedOutcomes: ["code implementation", "workspace inspection", "command execution"],
    defaultSkillIds: ["inspect_repo", "implement_code", "run_tests"],
  },
  {
    kind: "delegated_subagent",
    name: "reviewer",
    subagentType: "reviewer",
    description: "Inspect code and changes for bugs, regressions, missing tests, and quality or safety issues.",
    whenToUse: "Use when the user asks whether code has problems, wants critique, or needs a review-style verdict.",
    whenNotToUse: "Do not use for direct implementation or broad architecture explanation.",
    ownedOutcomes: ["code review", "risk assessment", "quality verdict"],
    defaultSkillIds: ["review_changes", "run_tests"],
  },
  {
    kind: "delegated_subagent",
    name: "lander",
    subagentType: "lander",
    description: "Prepare final delivery, merge/release handoff, or landing instructions after implementation and review are done.",
    whenToUse: "Use when the task is in its final delivery stage and needs release or landing preparation.",
    whenNotToUse: "Do not use before implementation/review are complete or for repository inspection.",
    ownedOutcomes: ["delivery summary", "release handoff", "landing preparation"],
    defaultSkillIds: ["prepare_delivery"],
  },
  {
    kind: "delegated_subagent",
    name: "deepresearcher",
    subagentType: "deepresearcher",
    description: "Conducts multi-step web research, cross-references sources, and produces structured analytical reports with cited evidence.",
    whenToUse: "Use when the task requires external research, technology evaluation, alternative comparison, or gathering context from web sources before making design decisions.",
    whenNotToUse: "Do not use for repository-local code changes, architecture design, code review, or delivery landing — delegate to coder, architect, reviewer, or lander instead.",
    ownedOutcomes: ["research report", "technology evaluation", "source analysis"],
    defaultSkillIds: ["web_research"],
  },
] as const;

const TERMINAL_ACTION_DEFINITIONS: readonly ManagerTerminalActionDefinition[] = [
  {
    kind: "terminal_action",
    name: "respond",
    actionKind: "respond",
    description: "Return a direct user-facing answer and end the manager loop without delegating child work.",
    whenToUse: "Use when the current context and tool observations are sufficient to answer immediately.",
    whenNotToUse: "Do not use when you still need local observations, web data, or delegated execution to answer correctly.",
  },
  {
    kind: "terminal_action",
    name: "ask_user_question",
    actionKind: "ask_user",
    description: "Ask the user a concrete follow-up question when a required piece of external information is genuinely missing.",
    whenToUse: "Use only when the missing information can only come from the user and is not available from the workspace, wall clock, or tools.",
    whenNotToUse: "Do not use for information that can be obtained from base tools, runtime context, repository inspection, or web search.",
  },
  {
    kind: "terminal_action",
    name: "wait",
    actionKind: "wait",
    description: "Pause the task durably until a future wakeup time or external condition is met.",
    whenToUse: "Use when execution must stop and resume later because of durable waiting conditions.",
    whenNotToUse: "Do not use for immediate user clarifications or when you can continue with tools or delegated subagents right now.",
  },
] as const;

export function getManagerBaseToolDefinitions() {
  return [...BASE_TOOL_DEFINITIONS];
}

export function getManagerSubagentDefinitions() {
  return [...SUBAGENT_DEFINITIONS];
}

export function getManagerTerminalActionDefinitions() {
  return [...TERMINAL_ACTION_DEFINITIONS];
}

export function getManagerCapabilityDefinitions() {
  return [...BASE_TOOL_DEFINITIONS, ...SUBAGENT_DEFINITIONS, ...TERMINAL_ACTION_DEFINITIONS];
}

export function isManagerBaseToolName(value: unknown): value is ManagerBaseToolName {
  return (
    typeof value === "string" &&
    BASE_TOOL_DEFINITIONS.some((definition) => definition.toolName === value)
  );
}

export function isManagerSubagentType(
  value: unknown,
): value is ManagerDelegatedSubagentDefinition["subagentType"] {
  return (
    typeof value === "string" &&
    SUBAGENT_DEFINITIONS.some((definition) => definition.subagentType === value)
  );
}

export function getManagerCapabilityPromptLines() {
  return [
    "Terminal manager actions:",
    ...TERMINAL_ACTION_DEFINITIONS.map(
      (definition) =>
        `- ${definition.name}: ${definition.description} When to use: ${definition.whenToUse} When not to use: ${definition.whenNotToUse}`,
    ),
    "Delegated subagents:",
    ...SUBAGENT_DEFINITIONS.map(
      (definition) =>
        `- ${definition.subagentType}: ${definition.description} When to use: ${definition.whenToUse} When not to use: ${definition.whenNotToUse}`,
    ),
    "Base tools:",
    ...BASE_TOOL_DEFINITIONS.map(
      (definition) =>
        `- ${definition.toolName}: ${definition.description} Args: ${definition.argumentSchemaSummary} Returns: ${definition.returnsSummary}`,
    ),
    "Canonical skill IDs:",
    ...getManagerSkillDefinitions().map(
      (definition) =>
        `- ${definition.skillId}: ${definition.description} Allowed roles: ${
          definition.allowedRoles.length > 0 ? definition.allowedRoles.join(", ") : "manager only"
        }.`,
    ),
    "Child work items must use canonical fields only: roleId or subagentType, skillId, goal, and dependsOn.",
  ];
}
