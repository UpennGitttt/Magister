import { runTavilyWebSearch } from "../tavily-web-search-service";

type ManagerToolFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export async function executeWebSearchTool(input: {
  query: string;
  maxResults?: number;
  topic?: "general" | "news";
  tavilyConfig: {
    enabled: boolean;
    apiKey?: string;
    baseUrl: string;
    timeoutSeconds: number;
  };
  fetchImpl?: ManagerToolFetch;
}) {
  return runTavilyWebSearch(
    input.tavilyConfig,
    {
      query: input.query,
      includeAnswer: true,
      searchDepth: "basic",
      ...(typeof input.maxResults === "number" ? { maxResults: input.maxResults } : {}),
      ...(input.topic ? { topic: input.topic } : {}),
    },
    {
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl as typeof fetch } : {}),
    },
  );
}
