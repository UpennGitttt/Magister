import type { LeaderTool } from "./autonomous-types";

export function findToolByName(tools: readonly LeaderTool[], name: string): LeaderTool | undefined {
  return tools.find((t) => t.name === name || t.aliases?.includes(name));
}