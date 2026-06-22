/**
 * Volc Web Search Tool — uses feedcoopapi.com search API
 */

type VolcWebSearchConfig = {
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  timeoutSeconds: number;
  count: number;
};

type VolcSearchResult = {
  title: string;
  url: string;
  summary: string;
};

type VolcWebSearchResponse = {
  code: number;
  msg: string;
  data?: {
    results?: Array<{
      title?: string;
      url?: string;
      summary?: string;
      content?: string;
    }>;
  };
};

const DEFAULT_VOLC_CONFIG: VolcWebSearchConfig = {
  enabled: false,
  apiKey: "",
  baseUrl: "https://open.feedcoopapi.com/search_api/web_search",
  timeoutSeconds: 10,
  count: 10,
};

export function getVolcWebSearchConfig(): VolcWebSearchConfig {
  return {
    enabled: process.env.MAGISTER_VOLC_WEB_SEARCH_ENABLED !== "false",
    apiKey: process.env.MAGISTER_VOLC_WEB_SEARCH_API_KEY ?? DEFAULT_VOLC_CONFIG.apiKey,
    baseUrl: process.env.MAGISTER_VOLC_WEB_SEARCH_BASE_URL ?? DEFAULT_VOLC_CONFIG.baseUrl,
    timeoutSeconds: Number(process.env.MAGISTER_VOLC_WEB_SEARCH_TIMEOUT_SECONDS) || DEFAULT_VOLC_CONFIG.timeoutSeconds,
    count: Number(process.env.MAGISTER_VOLC_WEB_SEARCH_COUNT) || DEFAULT_VOLC_CONFIG.count,
  };
}

export async function executeVolcWebSearch(input: {
  query: string;
  count?: number;
  config?: VolcWebSearchConfig;
}): Promise<{ answer?: string; results: VolcSearchResult[] }> {
  const config = input.config ?? getVolcWebSearchConfig();

  if (!config.enabled || !config.apiKey) {
    return { results: [], answer: "Web search is not configured." };
  }

  const params = new URLSearchParams({
    query: input.query,
    api_key: config.apiKey,
    count: String(input.count ?? config.count),
  });

  const url = `${config.baseUrl}?${params.toString()}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutSeconds * 1000);

    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return { results: [], answer: `Search failed with status ${response.status}` };
    }

    const data = (await response.json()) as VolcWebSearchResponse;

    if (data.code !== 0 || !data.data?.results) {
      return { results: [], answer: data.msg || "No results found" };
    }

    const results: VolcSearchResult[] = data.data.results
      .filter((r) => r.title && r.url)
      .map((r) => ({
        title: r.title!,
        url: r.url!,
        summary: r.summary || r.content || "",
      }));

    // Build a concise answer from top results
    const answer = results.length > 0
      ? results.slice(0, 3).map((r, i) => `${i + 1}. ${r.title}\n   ${r.summary.slice(0, 150)}`).join("\n\n")
      : "No results found";

    return { answer, results };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { results: [], answer: `Search error: ${msg}` };
  }
}
