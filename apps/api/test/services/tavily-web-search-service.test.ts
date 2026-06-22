import { afterEach, expect, test } from "bun:test";

import {
  parseTavilyWebSearchConfigFromEnv,
  runTavilyWebSearch,
} from "../../src/services/tavily-web-search-service";

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  delete process.env.MAGISTER_TAVILY_WEB_SEARCH_ENABLED;
  delete process.env.MAGISTER_TAVILY_WEB_SEARCH_API_KEY;
  delete process.env.MAGISTER_TAVILY_WEB_SEARCH_BASE_URL;
  delete process.env.MAGISTER_TAVILY_WEB_SEARCH_TIMEOUT_SECONDS;
  delete process.env.TAVILY_API_KEY;
  delete process.env.TAVILY_BASE_URL;
  globalThis.fetch = ORIGINAL_FETCH;
});

test("parseTavilyWebSearchConfigFromEnv supports the ULTIMATE tavily_web_search env shape", () => {
  process.env.MAGISTER_TAVILY_WEB_SEARCH_ENABLED = "true";
  process.env.MAGISTER_TAVILY_WEB_SEARCH_API_KEY = "tvly-test-key";
  process.env.MAGISTER_TAVILY_WEB_SEARCH_BASE_URL = "https://api.tavily.com/search";
  process.env.MAGISTER_TAVILY_WEB_SEARCH_TIMEOUT_SECONDS = "30";

  expect(parseTavilyWebSearchConfigFromEnv()).toEqual({
    enabled: true,
    apiKey: "tvly-test-key",
    baseUrl: "https://api.tavily.com/search",
    timeoutSeconds: 30,
  });
});

test("runTavilyWebSearch posts to the configured Tavily endpoint and returns answer plus snippets", async () => {
  globalThis.fetch = (async (url, init) => {
    expect(String(url)).toBe("https://api.tavily.com/search");
    expect(init?.method).toBe("POST");

    const body = JSON.parse(String(init?.body)) as {
      api_key: string;
      query: string;
      include_answer: boolean;
      max_results: number;
    };
    expect(body).toMatchObject({
      api_key: "tvly-test-key",
      query: "OpenAI 是什么",
      include_answer: true,
      max_results: 5,
    });

    return new Response(
      JSON.stringify({
        answer: "OpenAI 是一家研发通用人工智能系统的公司。",
        results: [
          {
            title: "OpenAI",
            url: "https://openai.com",
            content: "OpenAI builds general-purpose AI systems and products.",
            score: 0.98,
          },
        ],
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      },
    );
  }) as typeof fetch;

  const result = await runTavilyWebSearch(
    {
      enabled: true,
      apiKey: "tvly-test-key",
      baseUrl: "https://api.tavily.com/search",
      timeoutSeconds: 30,
    },
    {
      query: "OpenAI 是什么",
    },
  );

  expect(result.answer).toContain("OpenAI");
  expect(result.results).toEqual([
    expect.objectContaining({
      title: "OpenAI",
      url: "https://openai.com",
      content: expect.stringContaining("general-purpose"),
    }),
  ]);
});
