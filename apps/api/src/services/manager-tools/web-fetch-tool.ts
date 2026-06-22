type ManagerToolFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function buildExtractUrl(baseUrl: string) {
  const normalized = baseUrl.replace(/\/search\/?$/, "");
  return `${normalized}/extract`;
}

export async function executeWebFetchTool(input: {
  url: string;
  tavilyConfig: {
    enabled: boolean;
    apiKey?: string;
    baseUrl: string;
    timeoutSeconds: number;
  };
  fetchImpl?: ManagerToolFetch;
}) {
  if (!input.tavilyConfig.enabled) {
    throw new Error("tavily_web_search is disabled");
  }
  if (!input.tavilyConfig.apiKey) {
    throw new Error("tavily_web_search requires an API key");
  }

  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const response = await fetchImpl(buildExtractUrl(input.tavilyConfig.baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-client-source": "magister",
    },
    body: JSON.stringify({
      api_key: input.tavilyConfig.apiKey,
      urls: [input.url],
    }),
  });

  if (!response.ok) {
    throw new Error(`Tavily extract request failed with status ${response.status}`);
  }

  const payload = (await response.json()) as {
    results?: Array<{
      url?: string;
      title?: string;
      raw_content?: string;
    }>;
  };
  const result = payload.results?.[0];
  if (!result || typeof result.url !== "string") {
    throw new Error("Tavily extract returned no results");
  }

  const rawContent = typeof result.raw_content === "string" ? result.raw_content.trim() : "";

  return {
    url: result.url,
    title: typeof result.title === "string" ? result.title : null,
    excerpt: rawContent.slice(0, 280),
  };
}
