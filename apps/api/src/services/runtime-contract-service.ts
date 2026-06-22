import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { RuntimeContextDocument } from "./build-runtime-context-document-service";

export type RuntimeContractInput = {
  workspaceDir: string;
  runId: string;
  taskId: string;
  roleId: string;
  runtimeContextJsonPath: string;
  runtimeContextMarkdownPath: string;
  runtimeContext: RuntimeContextDocument;
  managerDecisionSummary?: string | null;
};

export type RuntimeContractResult = {
  filePath: string;
  content: string;
};

function formatListItem(label: string, value: string | null | undefined) {
  return `- ${label}: ${value && value.trim().length > 0 ? `\`${value.trim()}\`` : "`none`"}`;
}

function buildContractContent(input: RuntimeContractInput) {
  const managerPlan = input.runtimeContext.managerPlan;
  const plannedCapabilities =
    managerPlan && managerPlan.plannedCapabilities.length > 0
      ? managerPlan.plannedCapabilities.map((capability) => `\`${capability}\``).join(", ")
      : "`none`";

  return [
    "# Magister Runtime Contract",
    "",
    formatListItem("Task ID", input.taskId),
    formatListItem("Run ID", input.runId),
    formatListItem("Role", input.roleId),
    formatListItem("Runtime Context JSON", input.runtimeContextJsonPath),
    formatListItem("Runtime Context Markdown", input.runtimeContextMarkdownPath),
    "- Source of truth: control-plane task/run artifacts",
    "",
    "## Task",
    `- Title: ${input.runtimeContext.task.title}`,
    `- State: \`${input.runtimeContext.task.state}\``,
    `- Source: \`${input.runtimeContext.task.source}\``,
    "",
    "## Continuity",
    formatListItem("Prior Session", input.runtimeContext.continuity.priorSessionId),
    formatListItem("Prior Workdir", input.runtimeContext.continuity.priorWorkdir),
    formatListItem("Resume Policy", input.runtimeContext.continuity.resumePolicy),
    "",
    "## Manager Decision",
    `- Summary: ${input.managerDecisionSummary?.trim().length ? input.managerDecisionSummary.trim() : "Review the runtime context before taking action."}`,
    `- Planned Capabilities: ${plannedCapabilities}`,
    "",
    "## Output Discipline",
    "- Treat this file and the runtime context document as the authoritative execution contract.",
    "- Keep final reports concise and structured as Objective, Actions, Outcome.",
    "- Report blockers explicitly when they stop completion.",
    "- Do not use bootstrap or session setup as a completion signal.",
  ].join("\n");
}

export async function writeRuntimeContract(input: RuntimeContractInput): Promise<RuntimeContractResult> {
  const filePath = join(input.workspaceDir, ".magister", "runtime-contracts", input.runId, "AGENTS.md");
  await mkdir(dirname(filePath), { recursive: true });
  const content = buildContractContent(input);
  await writeFile(filePath, `${content}\n`, "utf8");
  return {
    filePath,
    content,
  };
}
