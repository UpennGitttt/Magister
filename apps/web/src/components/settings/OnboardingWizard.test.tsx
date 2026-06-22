import "../../test-setup";
import { afterEach, describe, expect, test } from "bun:test";
import { render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { OnboardingWizard } from "./OnboardingWizard";

const originalFetch = globalThis.fetch;

function apiResponse(data: unknown) {
  return new Response(JSON.stringify({ ok: true, data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const FEISHU_STATE = {
  provider: "feishu",
  mode: "websocket",
  ready: false,
  valid: false,
  missingFields: ["MAGISTER_FEISHU_APP_ID", "MAGISTER_FEISHU_APP_SECRET"],
  fields: {
    appId: { present: false, redactedValue: "****" },
    appSecret: { present: false, redactedValue: "****" },
    verificationToken: { present: false, redactedValue: "****" },
    encryptKey: { present: false, redactedValue: "****" },
  },
};

const STATUS_UNCONFIGURED = {
  providers: { total: 0, readyCount: 0, configured: false },
  cliAgents: { items: [], anyReady: false },
  feishu: { state: FEISHU_STATE, channelsDisabled: false, gateway: { connectionState: "disconnected" } },
  complete: false,
};

const PRESETS = [
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    vendor: "anthropic",
    apiDialect: "anthropic_messages",
    baseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-sonnet-4-6",
    requiresBaseUrl: false,
  },
  {
    id: "openai",
    label: "OpenAI",
    vendor: "openai",
    apiDialect: "openai_chat_completions",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-5.3",
    requiresBaseUrl: false,
  },
];

describe("OnboardingWizard", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("renders the steps and configures a provider in one shot", async () => {
    const user = userEvent.setup();
    let postBody: Record<string, unknown> | null = null;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/onboarding/status") return apiResponse(STATUS_UNCONFIGURED);
      if (url === "/api/onboarding/provider-presets") return apiResponse({ items: PRESETS });
      if (url === "/api/onboarding/provider" && method === "POST") {
        postBody = JSON.parse(String(init?.body));
        return apiResponse({ providerId: "anthropic", modelName: "claude-sonnet-4-6" });
      }
      throw new Error(`unexpected ${method} ${url}`);
    }) as typeof fetch;

    const { getByText, container } = render(<OnboardingWizard />);

    // unconfigured banner + the optional step labels
    await waitFor(() => expect(getByText(/Add a provider to finish setup/i)).toBeTruthy());
    expect(getByText("CLI agents")).toBeTruthy();
    expect(getByText("Feishu")).toBeTruthy();

    // the provider step form is active by default; wait for presets to load
    await waitFor(() => expect(getByText("Model provider")).toBeTruthy());
    await waitFor(() => expect(getByText("Anthropic (Claude)")).toBeTruthy());

    const keyInput = container.querySelector('input[type="password"]') as HTMLInputElement;
    expect(keyInput).toBeTruthy();
    await user.type(keyInput, "sk-ant-xyz");
    await user.click(getByText("Save & verify"));

    // success banner appears once the POST resolves
    await waitFor(() => expect(getByText(/leader now uses/i)).toBeTruthy());
    expect(postBody as unknown).toEqual({ presetId: "anthropic", apiKey: "sk-ant-xyz" });
  });

  test("shows the ready banner when a provider is already configured", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/onboarding/status") {
        return apiResponse({ ...STATUS_UNCONFIGURED, providers: { total: 1, readyCount: 1, configured: true }, complete: true });
      }
      if (url === "/api/onboarding/provider-presets") return apiResponse({ items: PRESETS });
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;

    const { getByText } = render(<OnboardingWizard />);
    await waitFor(() => expect(getByText(/Magister is ready/i)).toBeTruthy());
  });
});
