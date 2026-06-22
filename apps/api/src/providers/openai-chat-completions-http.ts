import type {
  ExecutorBinding,
  ModelProfile,
  OpenAIChatCompletionsRequestPatch,
  ProviderAuthConfig,
  ProviderConfig,
  ProviderHeaderRule,
  ProviderReasoningPolicy,
} from "./types";
import { buildOpenAIChatCompletionsRequestPatch } from "./openai-chat-completions";
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

  const headerName = normalizeString(auth.headerName) || "Authorization";
  const prefix =
    typeof auth.prefix === "string" && auth.prefix.length > 0
      ? auth.prefix
      : headerName === "Authorization"
        ? "Bearer "
        : undefined;

  return {
    name: headerName,
    value: prefix ? `${prefix}${secret}` : secret,
  };
}

export type PreparedOpenAIChatCompletionsRequest = OpenAIChatCompletionsRequestPatch & {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
};

export function prepareOpenAIChatCompletionsHttpRequest(params: {
  provider: ProviderConfig;
  model: ModelProfile;
  binding: ExecutorBinding;
  prompt: string;
  reasoningPolicy?: ProviderReasoningPolicy;
  env?: NodeJS.ProcessEnv;
}): PreparedOpenAIChatCompletionsRequest {
  const requestPatch = buildOpenAIChatCompletionsRequestPatch({
    provider: params.provider,
    model: params.model,
    binding: params.binding,
    ...(params.reasoningPolicy ? { reasoningPolicy: params.reasoningPolicy } : {}),
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
        role: "system",
        content: params.prompt,
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
