import { parseTavilyWebSearchConfigFromEnv } from "./tavily-web-search-service";
import { isManagerBaseToolName } from "./manager-capability-registry-service";
import { executeBashTool } from "./manager-tools/bash-tool";
import { executeGrepRepoTool } from "./manager-tools/grep-repo-tool";
import { executeListDirTool } from "./manager-tools/list-dir-tool";
import { executeReadFileTool } from "./manager-tools/read-file-tool";
import { executeTimeNowTool } from "./manager-tools/time-now-tool";
import { executeWebFetchTool } from "./manager-tools/web-fetch-tool";
import { executeWebSearchTool } from "./manager-tools/web-search-tool";

type ManagerToolFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type ManagerToolObservation = {
  toolName: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  summary: string;
};

export async function executeManagerTool(input: {
  workspaceDir: string;
  toolName: string;
  arguments: Record<string, unknown>;
  now?: () => Date;
  fetchImpl?: ManagerToolFetch;
  tavilyConfig?: {
    enabled: boolean;
    apiKey?: string;
    baseUrl: string;
    timeoutSeconds: number;
  };
}): Promise<ManagerToolObservation> {
  if (!isManagerBaseToolName(input.toolName)) {
    return {
      toolName: input.toolName,
      ok: false,
      error: `Unknown manager base tool: ${input.toolName}`,
      summary: `Unknown tool ${input.toolName}`,
    };
  }

  try {
    if (input.toolName === "time_now") {
      const result = executeTimeNowTool({ ...(input.now ? { now: input.now } : {}) });
      return {
        toolName: input.toolName,
        ok: true,
        result,
        summary: `Local time ${result.localTime} (${result.timezone})`,
      };
    }

    if (input.toolName === "read_file") {
      const path = typeof input.arguments.path === "string" ? input.arguments.path : null;
      if (!path) {
        throw new Error("read_file requires a relative path");
      }
      const result = await executeReadFileTool({
        workspaceDir: input.workspaceDir,
        path,
        ...(typeof input.arguments.startLine === "number" ? { startLine: input.arguments.startLine } : {}),
        ...(typeof input.arguments.endLine === "number" ? { endLine: input.arguments.endLine } : {}),
      });
      return {
        toolName: input.toolName,
        ok: true,
        result,
        summary: `Read ${result.path}:${result.startLine}-${result.endLine}`,
      };
    }

    if (input.toolName === "list_dir") {
      const result = await executeListDirTool({
        workspaceDir: input.workspaceDir,
        ...(typeof input.arguments.path === "string" ? { path: input.arguments.path } : {}),
      });
      return {
        toolName: input.toolName,
        ok: true,
        result,
        summary: `Listed ${result.path} (${result.entries.length} entries)`,
      };
    }

    if (input.toolName === "grep_repo") {
      const query = typeof input.arguments.query === "string" ? input.arguments.query : null;
      if (!query) {
        throw new Error("grep_repo requires a query");
      }
      const result = await executeGrepRepoTool({
        workspaceDir: input.workspaceDir,
        query,
        ...(typeof input.arguments.path === "string" ? { path: input.arguments.path } : {}),
      });
      return {
        toolName: input.toolName,
        ok: true,
        result,
        summary: `Found ${result.matches.length} matches for ${query}`,
      };
    }

    if (input.toolName === "bash") {
      const command = typeof input.arguments.command === "string" ? input.arguments.command : null;
      if (!command) {
        throw new Error("bash requires a command");
      }
      const result = await executeBashTool({
        workspaceDir: input.workspaceDir,
        command,
      });
      return {
        toolName: input.toolName,
        ok: result.exitCode === 0,
        result,
        ...(result.exitCode === 0 ? {} : { error: result.stderr || `Command exited ${result.exitCode}` }),
        summary: `bash exit ${result.exitCode}`,
      };
    }

    if (input.toolName === "web_search") {
      const query = typeof input.arguments.query === "string" ? input.arguments.query : null;
      if (!query) {
        throw new Error("web_search requires a query");
      }
      const result = await executeWebSearchTool({
        query,
        ...(typeof input.arguments.maxResults === "number" ? { maxResults: input.arguments.maxResults } : {}),
        ...(input.arguments.topic === "general" || input.arguments.topic === "news"
          ? { topic: input.arguments.topic }
          : {}),
        tavilyConfig: input.tavilyConfig ?? parseTavilyWebSearchConfigFromEnv(),
        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      });
      return {
        toolName: input.toolName,
        ok: true,
        result,
        summary: `Web search returned ${result.results.length} results for ${result.query}`,
      };
    }

    if (input.toolName === "web_fetch") {
      const url = typeof input.arguments.url === "string" ? input.arguments.url : null;
      if (!url) {
        throw new Error("web_fetch requires a url");
      }
      const result = await executeWebFetchTool({
        url,
        tavilyConfig: input.tavilyConfig ?? parseTavilyWebSearchConfigFromEnv(),
        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      });
      return {
        toolName: input.toolName,
        ok: true,
        result,
        summary: `Fetched ${result.url}`,
      };
    }

    throw new Error(`Unsupported tool ${input.toolName}`);
  } catch (error) {
    return {
      toolName: input.toolName,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      summary: `${input.toolName} failed`,
    };
  }
}
