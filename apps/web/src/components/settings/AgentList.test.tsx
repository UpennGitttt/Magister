import "../../test-setup";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { AgentList } from "./AgentList";

const originalFetch = globalThis.fetch;

function apiResponse(data: unknown) {
  return new Response(JSON.stringify({ ok: true, data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("AgentList settings form", () => {
  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  test("preserves minimal reasoning effort when editing an agent", async () => {
    let savedBody: Record<string, unknown> | null = null;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url === "/api/settings/agents" && method === "GET") {
        return apiResponse({
          items: [
            {
              roleId: "reviewer",
              label: "Reviewer",
              description: "Reviews changes",
              runtimeType: "ucm",
              providerId: "moonshot",
              modelName: "kimi-k2.6",
              reasoningMode: "auto",
              reasoningEffort: "minimal",
              contextWindow: null,
              maxOutputTokens: 4096,
              isBuiltin: 1,
            },
          ],
        });
      }

      if (url === "/api/settings/providers") {
        return apiResponse({
          items: [
            {
              id: "moonshot",
              label: "Moonshot",
              vendor: "moonshot",
              transport: "api",
              apiDialect: "openai_chat_completions",
            },
          ],
        });
      }

      if (url === "/api/settings/tools") {
        return apiResponse({ items: [] });
      }

      if (url === "/api/settings/models") {
        return apiResponse({
          items: [
            {
              id: "kimi-k2.6",
              label: "Kimi K2.6",
              modelName: "kimi-k2.6",
              providerRefs: { api: "moonshot" },
              maxOutputTokens: 4096,
              contextWindow: 262144,
              defaultReasoning: { mode: "auto", effort: "minimal" },
              capabilityHints: {},
            },
          ],
        });
      }

      if (url === "/api/settings/agents/reviewer" && method === "PUT") {
        savedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return apiResponse({
          roleId: "reviewer",
          label: "Reviewer",
          reasoningEffort: savedBody.reasoningEffort,
        });
      }

      return apiResponse({});
    }) as unknown as typeof fetch;

    const view = render(<AgentList />);

    const summary = await view.findByRole("button", {
      name: /expand reviewer agent profile/i,
    });
    const legacyRuntimeLabel = "U" + "CM";
    expect(view.getByText("Magister")).toBeTruthy();
    expect(view.queryByText(legacyRuntimeLabel)).toBeNull();
    fireEvent.click(summary);

    const effortSelect = await view.findByLabelText("Reasoning effort") as HTMLSelectElement;
    expect(effortSelect.value).toBe("minimal");

    fireEvent.click(view.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(savedBody?.reasoningEffort).toBe("minimal");
    });
  });

  test("hides raw tool override controls and only offers legacy reset", async () => {
    let toolsRequested = false;
    let savedBody: Record<string, unknown> | null = null;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url === "/api/settings/agents" && method === "GET") {
        return apiResponse({
          items: [
            {
              roleId: "custom_tools",
              label: "Custom Tools",
              description: "Has legacy overrides",
              runtimeType: "ucm",
              providerId: "moonshot",
              modelName: "kimi-k2.6",
              allowedTools: ["bash"],
              disallowedTools: ["web_search"],
              isBuiltin: 0,
            },
          ],
        });
      }

      if (url === "/api/settings/providers") {
        return apiResponse({
          items: [
            {
              id: "moonshot",
              label: "Moonshot",
              vendor: "moonshot",
              transport: "api",
              apiDialect: "openai_chat_completions",
            },
          ],
        });
      }

      if (url === "/api/settings/tools") {
        toolsRequested = true;
        return apiResponse({
          items: [
            { name: "bash", description: "Run shell commands" },
            { name: "web_search", description: "Search the web" },
          ],
        });
      }

      if (url === "/api/settings/models") {
        return apiResponse({
          items: [
            {
              id: "kimi-k2.6",
              label: "Kimi K2.6",
              modelName: "kimi-k2.6",
              providerRefs: { api: "moonshot" },
              maxOutputTokens: 4096,
              contextWindow: 262144,
              defaultReasoning: { mode: "auto", effort: "minimal" },
              capabilityHints: {},
            },
          ],
        });
      }

      if (url === "/api/settings/agents/custom_tools" && method === "PUT") {
        savedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return apiResponse({
          roleId: "custom_tools",
          label: "Custom Tools",
          allowedTools: null,
          disallowedTools: null,
        });
      }

      return apiResponse({});
    }) as unknown as typeof fetch;

    const view = render(<AgentList />);

    const summary = await view.findByRole("button", {
      name: /expand custom_tools agent profile/i,
    });
    expect(toolsRequested).toBe(false);

    fireEvent.click(summary);

    expect(view.queryByText("Additionally allow")).toBeNull();
    expect(view.queryByText("Additionally disallow")).toBeNull();
    expect(view.getByText(/legacy tool overrides/i)).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Reset legacy overrides" }));

    await waitFor(() => {
      expect(savedBody).toEqual({
        allowedTools: null,
        disallowedTools: null,
      });
    });
  });

  test("uses PATH-resolved CLI command names when switching runtime", async () => {
    const modelRequests: string[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url === "/api/settings/agents" && method === "GET") {
        return apiResponse({
          items: [
            {
              roleId: "coder",
              label: "Coder",
              description: "Writes changes",
              runtimeType: "ucm",
              providerId: "openai",
              modelName: "gpt-5.4",
              isBuiltin: 1,
            },
          ],
        });
      }

      if (url === "/api/settings/providers") {
        return apiResponse({ items: [] });
      }

      if (url === "/api/settings/models") {
        return apiResponse({ items: [] });
      }

      if (url.startsWith("/api/settings/agents/coder/models")) {
        modelRequests.push(url);
        return apiResponse({
          models: [
            {
              id: "gpt-5.5",
              provider: "openai",
              label: "GPT-5.5",
            },
          ],
          supported: true,
        });
      }

      return apiResponse({});
    }) as unknown as typeof fetch;

    const view = render(<AgentList />);
    const summary = await view.findByRole("button", {
      name: /expand coder agent profile/i,
    });
    fireEvent.click(summary);

    const runtimeSelect = await view.findByLabelText("Runtime Type") as HTMLSelectElement;
    fireEvent.change(runtimeSelect, { target: { value: "codex" } });

    await waitFor(() => {
      expect(modelRequests.some((url) => url.includes("runtimeType=codex"))).toBe(true);
    });

    const latestRequest = modelRequests.at(-1) ?? "";
    expect(decodeURIComponent(latestRequest)).toContain("commandPath=codex");
    expect(decodeURIComponent(latestRequest)).not.toContain("/usr/bin/codex");
  });

  test("normalizes saved Linux CLI paths during Mac onboarding", async () => {
    const modelRequests: string[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url === "/api/settings/agents" && method === "GET") {
        return apiResponse({
          items: [
            {
              roleId: "coder",
              label: "Coder",
              description: "Writes changes",
              runtimeType: "codex",
              commandPath: "/usr/bin/codex",
              modelName: "gpt-5.4",
              isBuiltin: 1,
            },
          ],
        });
      }

      if (url === "/api/settings/providers") {
        return apiResponse({ items: [] });
      }

      if (url === "/api/settings/models") {
        return apiResponse({ items: [] });
      }

      if (url.startsWith("/api/settings/agents/coder/models")) {
        modelRequests.push(url);
        return apiResponse({
          models: [
            {
              id: "gpt-5.5",
              provider: "openai",
              label: "GPT-5.5",
            },
          ],
          supported: true,
        });
      }

      return apiResponse({});
    }) as unknown as typeof fetch;

    const view = render(<AgentList />);
    const summary = await view.findByRole("button", {
      name: /expand coder agent profile/i,
    });
    fireEvent.click(summary);

    await waitFor(() => {
      expect(modelRequests.length).toBeGreaterThan(0);
    });

    const latestRequest = modelRequests.at(-1) ?? "";
    expect(decodeURIComponent(latestRequest)).toContain("commandPath=codex");
    expect(decodeURIComponent(latestRequest)).not.toContain("/usr/bin/codex");
  });
});
