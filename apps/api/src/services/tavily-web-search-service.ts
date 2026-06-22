type TavilyWebSearchConfig = {
  enabled: boolean;
  apiKey?: string;
  baseUrl: string;
  timeoutSeconds: number;
};

type TavilySearchResultItem = {
  title: string;
  url: string;
  content: string;
  score?: number;
};

type TavilyWebSearchResult = {
  query: string;
  answer?: string;
  results: TavilySearchResultItem[];
};

type TavilyWebSearchInput = {
  query: string;
  maxResults?: number;
  includeAnswer?: boolean;
  searchDepth?: "basic" | "advanced";
  topic?: "general" | "news";
};

const DEFAULT_TAVILY_BASE_URL = "https://api.tavily.com/search";
const DEFAULT_TIMEOUT_SECONDS = 30;
const DEFAULT_MAX_RESULTS = 5;

function normalizeBoolean(value?: string) {
  if (!value) {
    return undefined;
  }

  const candidate = value.trim().toLowerCase();
  if (candidate === "true" || candidate === "1" || candidate === "yes" || candidate === "on") {
    return true;
  }
  if (candidate === "false" || candidate === "0" || candidate === "no" || candidate === "off") {
    return false;
  }
  return undefined;
}

function normalizePositiveInteger(value?: string, fallback = DEFAULT_TIMEOUT_SECONDS) {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function normalizeBaseUrl(value?: string) {
  const candidate = value?.trim();
  if (!candidate) {
    return DEFAULT_TAVILY_BASE_URL;
  }

  try {
    const url = new URL(candidate);
    if (url.pathname.endsWith("/search")) {
      return url.toString();
    }
    url.pathname = `${url.pathname.replace(/\/$/, "")}/search`;
    return url.toString();
  } catch {
    return DEFAULT_TAVILY_BASE_URL;
  }
}

export function parseTavilyWebSearchConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TavilyWebSearchConfig {
  const apiKey =
    env.MAGISTER_TAVILY_WEB_SEARCH_API_KEY?.trim() || env.TAVILY_API_KEY?.trim() || undefined;
  const enabled =
    normalizeBoolean(env.MAGISTER_TAVILY_WEB_SEARCH_ENABLED) ??
    normalizeBoolean(env.TAVILY_ENABLED) ??
    Boolean(apiKey);

  return {
    enabled,
    ...(apiKey ? { apiKey } : {}),
    baseUrl: normalizeBaseUrl(
      env.MAGISTER_TAVILY_WEB_SEARCH_BASE_URL?.trim() || env.TAVILY_BASE_URL?.trim(),
    ),
    timeoutSeconds: normalizePositiveInteger(
      env.MAGISTER_TAVILY_WEB_SEARCH_TIMEOUT_SECONDS?.trim() ||
        env.TAVILY_TIMEOUT_SECONDS?.trim(),
      DEFAULT_TIMEOUT_SECONDS,
    ),
  };
}

export async function runTavilyWebSearch(
  config: TavilyWebSearchConfig,
  input: TavilyWebSearchInput,
  options?: {
    fetchImpl?: typeof fetch;
  },
): Promise<TavilyWebSearchResult> {
  if (!config.enabled) {
    throw new Error("tavily_web_search is disabled");
  }
  if (!config.apiKey) {
    throw new Error("tavily_web_search requires an API key");
  }

  const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), config.timeoutSeconds * 1000);

  try {
    const response = await fetchImpl(config.baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-client-source": "magister",
      },
      body: JSON.stringify({
        api_key: config.apiKey,
        query: input.query,
        include_answer: input.includeAnswer ?? true,
        max_results: input.maxResults ?? DEFAULT_MAX_RESULTS,
        ...(input.searchDepth ? { search_depth: input.searchDepth } : {}),
        ...(input.topic ? { topic: input.topic } : {}),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Tavily request failed with status ${response.status}`);
    }

    const payload = (await response.json()) as {
      answer?: unknown;
      results?: unknown;
    };

    const results = Array.isArray(payload.results)
      ? payload.results.flatMap((item) => {
          if (!item || typeof item !== "object") {
            return [];
          }

          const record = item as Record<string, unknown>;
          if (
            typeof record.title !== "string" ||
            typeof record.url !== "string" ||
            typeof record.content !== "string"
          ) {
            return [];
          }

          return [
            {
              title: record.title,
              url: record.url,
              content: record.content,
              ...(typeof record.score === "number" ? { score: record.score } : {}),
            } satisfies TavilySearchResultItem,
          ];
        })
      : [];

    return {
      query: input.query,
      ...(typeof payload.answer === "string" && payload.answer.trim().length > 0
        ? { answer: payload.answer.trim() }
        : {}),
      results,
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}
