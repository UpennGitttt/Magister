import type { LeaderTool } from "./autonomous-loop/autonomous-types";

export type ToolProfileId = "full" | "coding" | "research" | "minimal";

// Plan-mode tools are leader-only and must never reach a teammate.
// Every named-profile branch that uses `exclude` includes them; `minimal`
// uses `include` (default-allow only those listed) so it never picks them
// up. See docs/specs/2026-04-26-plan-mode-spec.md §7 / Codex review.
export const PLAN_MODE_TOOLS = ["enter_plan_mode", "exit_plan_mode"];

const TOOL_PROFILES: Record<ToolProfileId, { include: string[] } | { exclude: string[] }> = {
  full: { exclude: [...PLAN_MODE_TOOLS] },
  coding: {
    exclude: [
      "web_search", "web_fetch", "spawn_teammate", "spawn_teammates", "check_teammate_status", "wait_for_teammate",
      ...PLAN_MODE_TOOLS,
    ],
  },
  research: {
    exclude: [
      "write_file", "edit_file", "bash", "spawn_teammate", "spawn_teammates", "check_teammate_status", "wait_for_teammate",
      ...PLAN_MODE_TOOLS,
    ],
  },
  minimal: { include: ["read_file", "list_dir", "grep", "time_now"] },
};

export function filterToolsByProfile(
  tools: readonly LeaderTool[],
  profileId: ToolProfileId,
): LeaderTool[] {
  const profile = TOOL_PROFILES[profileId] as { include: string[] } | { exclude: string[] } | undefined;
  if (!profile) {
    // Unknown profile — return all tools as safe fallback
    return tools as LeaderTool[];
  }
  if ("include" in profile) {
    return tools.filter((t) => profile.include.includes(t.name)) as LeaderTool[];
  }
  if (profile.exclude.length === 0) return tools as LeaderTool[];
  return tools.filter((t) => !profile.exclude.includes(t.name)) as LeaderTool[];
}

export function isValidToolProfileId(value: string): value is ToolProfileId {
  return value === "full" || value === "coding" || value === "research" || value === "minimal";
}
