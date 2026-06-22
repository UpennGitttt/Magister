import { McpServerRepository } from "../../repositories/mcp-server-repository";
import {
  McpToolPolicyRepository,
  isMcpToolPolicy,
  type McpToolPolicySource,
  type McpToolPolicyValue,
} from "../../repositories/mcp-tool-policy-repository";
import {
  isMcpToolName,
  namespacedToolName,
  parseMcpToolName,
} from "../mcp-tool-converter";
import type { McpToolRisk } from "./safe-apply-types";

export type ObservedMcpToolEvent = {
  type?: string;
  toolName?: string;
  data?: Record<string, unknown>;
};

type Candidate = {
  serverId: string;
  serverName: string;
  toolName: string;
  policy: McpToolPolicyValue;
  source: McpToolPolicySource;
};

function getToolName(event: ObservedMcpToolEvent): string | null {
  if (typeof event.toolName === "string" && event.toolName.length > 0) {
    return event.toolName;
  }
  const fromData = event.data?.toolName;
  return typeof fromData === "string" && fromData.length > 0 ? fromData : null;
}

function isToolCallEvent(event: ObservedMcpToolEvent): boolean {
  if (!event.type) return true;
  const normalized = event.type.toLowerCase();
  return (
    normalized.includes("call") ||
    normalized.includes("start") ||
    normalized === "tool_use"
  ) && !normalized.includes("result") && !normalized.includes("error");
}

function isMcpToolPolicySource(value: unknown): value is McpToolPolicySource {
  return value === "discovered" || value === "manual" || value === "imported";
}

function riskForPolicy(policy: McpToolPolicyValue): Pick<McpToolRisk, "risk" | "reason"> {
  if (policy === "read_only") {
    return { risk: "none", reason: "tool_read_only" };
  }
  if (policy === "mutating") {
    return { risk: "requires_review", reason: "tool_mutating" };
  }
  return { risk: "requires_review", reason: "tool_unknown" };
}

export async function buildMcpToolRisk(
  events: readonly ObservedMcpToolEvent[],
): Promise<McpToolRisk[]> {
  const callCounts = new Map<string, number>();
  const order: string[] = [];
  for (const event of events) {
    if (!isToolCallEvent(event)) continue;
    const toolName = getToolName(event);
    if (!toolName || !isMcpToolName(toolName)) continue;
    if (!callCounts.has(toolName)) order.push(toolName);
    callCounts.set(toolName, (callCounts.get(toolName) ?? 0) + 1);
  }
  if (order.length === 0) return [];

  const [servers, policyRows] = await Promise.all([
    new McpServerRepository().listAll(),
    new McpToolPolicyRepository().listAll(),
  ]);
  const serverById = new Map(servers.map((server) => [server.id, server]));
  const policyByServerTool = new Map(
    policyRows.map((row) => [`${row.serverId}\0${row.toolName}`, row]),
  );
  const candidatesByNamespaced = new Map<string, Candidate[]>();

  for (const row of policyRows) {
    const server = serverById.get(row.serverId);
    if (!server) continue;
    const name = namespacedToolName(server.name, row.toolName);
    const candidate: Candidate = {
      serverId: server.id,
      serverName: server.name,
      toolName: row.toolName,
      policy: isMcpToolPolicy(row.policy) ? row.policy : "unknown",
      source: isMcpToolPolicySource(row.source) ? row.source : "discovered",
    };
    const list = candidatesByNamespaced.get(name) ?? [];
    list.push(candidate);
    candidatesByNamespaced.set(name, list);
  }

  const result: McpToolRisk[] = [];
  for (const namespaced of order) {
    const parsed = parseMcpToolName(namespaced);
    const candidates = candidatesByNamespaced.get(namespaced) ?? fallbackCandidates({
      namespaced,
      parsed,
      servers,
      policyByServerTool,
    });
    const callCount = callCounts.get(namespaced) ?? 0;

    if (candidates.length !== 1) {
      result.push({
        namespacedToolName: namespaced,
        serverId: null,
        serverName: parsed?.serverName ?? "unresolved",
        toolName: parsed?.toolName ?? namespaced,
        policy: "unknown",
        source: "unresolved",
        callCount,
        risk: "requires_review",
        reason: "tool_unresolved",
      });
      continue;
    }

    const candidate = candidates[0]!;
    result.push({
      namespacedToolName: namespaced,
      serverId: candidate.serverId,
      serverName: candidate.serverName,
      toolName: candidate.toolName,
      policy: candidate.policy,
      source: candidate.source,
      callCount,
      ...riskForPolicy(candidate.policy),
    });
  }
  return result;
}

function fallbackCandidates(input: {
  namespaced: string;
  parsed: { serverName: string; toolName: string } | null;
  servers: Array<{ id: string; name: string }>;
  policyByServerTool: Map<string, {
    serverId: string;
    toolName: string;
    policy: unknown;
    source: unknown;
  }>;
}): Candidate[] {
  if (!input.parsed) return [];
  const candidates: Candidate[] = [];
  for (const server of input.servers) {
    if (namespacedToolName(server.name, input.parsed.toolName) !== input.namespaced) {
      continue;
    }
    const row = input.policyByServerTool.get(`${server.id}\0${input.parsed.toolName}`);
    candidates.push({
      serverId: server.id,
      serverName: server.name,
      toolName: row?.toolName ?? input.parsed.toolName,
      policy: isMcpToolPolicy(row?.policy) ? row.policy : "unknown",
      source: isMcpToolPolicySource(row?.source) ? row.source : "discovered",
    });
  }
  return candidates;
}
