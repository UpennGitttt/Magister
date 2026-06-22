import type {
  AnthropicMessagesRequestPatch,
  ExecutorBinding,
  ModelProfile,
  ProviderAuthConfig,
  ProviderConfig,
  ProviderHeaderRule,
} from "./types";
import { buildAnthropicMessagesRequestPatch } from "./anthropic-messages";
import { resolveSecretValue } from "../services/local-secret-store-service";

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resolveHeaderValue(
  header: ProviderHeaderRule,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const explicitValue = normalizeString(header.value);
  if (explicitValue) {
    return explicitValue;
  }

  return (
    resolveSecretValue(header.secretRef, env) ||
    resolveSecretValue(header.envRef, env)
  );
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

function resolveAuthHeader(
  auth: ProviderAuthConfig,
  env: NodeJS.ProcessEnv,
): { name: string; value: string } | undefined {
  if (auth.kind === "none") {
    return undefined;
  }

  if (auth.kind === "chatgpt_session") {
    const value = resolveSecretValue("OPENAI_API_KEY", env);
    return value
      ? {
          name: "Authorization",
          value: `Bearer ${value}`,
        }
      : undefined;
  }

  const secret = resolveSecretValue(auth.secretRef, env);
  if (!secret) {
    return undefined;
  }

  const defaultHeaderName = auth.kind === "api_key" ? "x-api-key" : "Authorization";
  const headerName = normalizeString(auth.headerName) || defaultHeaderName;
  const defaultPrefix =
    headerName.toLowerCase() === "authorization"
      ? "Bearer "
      : undefined;
  const prefix = typeof auth.prefix === "string" ? auth.prefix : defaultPrefix;

  return {
    name: headerName,
    value: prefix && prefix.length > 0 ? `${prefix}${secret}` : secret,
  };
}

export type PreparedAnthropicMessagesRequest = AnthropicMessagesRequestPatch & {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
};

export function prepareAnthropicMessagesHttpRequest(params: {
  provider: ProviderConfig;
  model: ModelProfile;
  binding: ExecutorBinding;
  prompt: string;
  env?: NodeJS.ProcessEnv;
}): PreparedAnthropicMessagesRequest {
  const requestPatch = buildAnthropicMessagesRequestPatch({
    provider: params.provider,
    model: params.model,
    binding: params.binding,
  });
  const env = params.env ?? process.env;
  const baseUrl = normalizeString(requestPatch.requestMetadata.baseUrl) || normalizeString(params.provider.baseUrl);
  if (!baseUrl) {
    throw new Error(`Provider ${params.provider.id} is missing a baseUrl`);
  }

  const authHeader = resolveAuthHeader(params.provider.auth, env);
  if (params.provider.auth.kind !== "none" && !authHeader) {
    const secretRef =
      params.provider.auth.kind === "chatgpt_session"
        ? "OPENAI_API_KEY"
        : params.provider.auth.secretRef;
    throw new Error(`Provider ${params.provider.id} is missing secretRef ${secretRef}`);
  }

  const headers = new Headers({
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  });

  if (authHeader) {
    headers.set(authHeader.name, authHeader.value);
  }

  const missingHeaderSecrets: string[] = [];
  for (const header of requestPatch.requestMetadata.headers) {
    const value = resolveHeaderValue(header, env);
    if (!value) {
      if (header.secretRef || header.envRef) {
        missingHeaderSecrets.push(header.name);
      }
      continue;
    }

    headers.set(header.name, value);
  }

  if (missingHeaderSecrets.length > 0) {
    throw new Error(
      `Provider ${params.provider.id} is missing header secret(s): ${missingHeaderSecrets.join(", ")}`,
    );
  }

  const body = {
    ...requestPatch.requestBodyPatch,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: params.prompt,
          },
        ],
      },
    ],
  };

  return {
    ...requestPatch,
    url: new URL(
      requestPatch.requestMetadata.requestPath.replace(/^\//, ""),
      normalizeBaseUrl(baseUrl),
    ).toString(),
    init: {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
    body,
  };
}

