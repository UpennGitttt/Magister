import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ProviderAuthConfig } from "../providers/types";

export type LocalSecretStoreRecord = {
  value: string;
  updatedAt: string;
};

export type LocalSecretStoreFile = {
  secrets: Record<string, LocalSecretStoreRecord>;
};

export type SecretReadinessSource = "store" | "env" | "missing";

export type SecretStatus = {
  secretRef: string;
  ready: boolean;
  source: SecretReadinessSource;
  updatedAt?: string;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeSecretRef(secretRef: string | undefined | null): string | undefined {
  const trimmed = typeof secretRef === "string" ? secretRef.trim() : "";
  return trimmed ? trimmed : undefined;
}

function getSecretStorePath() {
  return process.env.MAGISTER_SECRET_STORE_PATH?.trim() || join(process.cwd(), "config", "secrets.json");
}

function normalizeSecretRecord(value: unknown): LocalSecretStoreRecord | undefined {
  if (typeof value === "string" && value.length > 0) {
    return {
      value,
      updatedAt: new Date(0).toISOString(),
    };
  }

  if (
    !isPlainObject(value) ||
    typeof value.value !== "string" ||
    !value.value.length
  ) {
    return undefined;
  }

  return {
    value: value.value,
    updatedAt:
      typeof value.updatedAt === "string" && value.updatedAt.trim()
        ? value.updatedAt.trim()
        : new Date(0).toISOString(),
  };
}

function normalizeLocalSecretStore(value: unknown): LocalSecretStoreFile {
  if (!isPlainObject(value)) {
    return { secrets: {} };
  }

  if (isPlainObject(value.secrets)) {
    return {
      secrets: Object.fromEntries(
        Object.entries(value.secrets)
          .map(([secretRef, record]) => [secretRef, normalizeSecretRecord(record)] as const)
          .filter(([, record]) => Boolean(record)),
      ) as Record<string, LocalSecretStoreRecord>,
    };
  }

  const records = Object.fromEntries(
    Object.entries(value)
      .map(([secretRef, record]) => [secretRef, normalizeSecretRecord(record)] as const)
      .filter(([, record]) => Boolean(record)),
  ) as Record<string, LocalSecretStoreRecord>;

  return { secrets: records };
}

export function readLocalSecretStoreFile(): LocalSecretStoreFile {
  const path = getSecretStorePath();

  try {
    const raw = readFileSync(path, "utf8");
    return normalizeLocalSecretStore(JSON.parse(raw));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return { secrets: {} };
    }

    throw cause;
  }
}

export function writeLocalSecretStoreFile(next: LocalSecretStoreFile) {
  const path = getSecretStorePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2));
}

export function resolveSecretValue(
  secretRef: string | undefined | null,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const normalized = normalizeSecretRef(secretRef);
  if (!normalized) {
    return undefined;
  }

  const store = readLocalSecretStoreFile();
  const storeRecord = store.secrets[normalized];
  if (storeRecord?.value?.trim()) {
    return storeRecord.value;
  }

  const envKey = normalized.startsWith("env:") ? normalized.slice(4).trim() : normalized;
  const envValue = env[envKey];
  return typeof envValue === "string" && envValue.trim() ? envValue.trim() : undefined;
}

export function getSecretStatus(
  secretRef: string | undefined | null,
  env: NodeJS.ProcessEnv = process.env,
): SecretStatus {
  const normalized = normalizeSecretRef(secretRef);
  if (!normalized) {
    return {
      secretRef: "",
      ready: false,
      source: "missing",
    };
  }

  const store = readLocalSecretStoreFile();
  const storeRecord = store.secrets[normalized];
  if (storeRecord?.value?.trim()) {
    return {
      secretRef: normalized,
      ready: true,
      source: "store",
      updatedAt: storeRecord.updatedAt,
    };
  }

  const envKey = normalized.startsWith("env:") ? normalized.slice(4).trim() : normalized;
  const envValue = env[envKey];
  if (typeof envValue === "string" && envValue.trim()) {
    return {
      secretRef: normalized,
      ready: true,
      source: "env",
    };
  }

  return {
    secretRef: normalized,
    ready: false,
    source: "missing",
  };
}

export function listSecretStatuses(
  secretRefs: Array<string | undefined | null>,
  env: NodeJS.ProcessEnv = process.env,
): SecretStatus[] {
  const seen = new Set<string>();
  const items: SecretStatus[] = [];

  for (const ref of secretRefs) {
    const normalized = normalizeSecretRef(ref);
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    items.push(getSecretStatus(normalized, env));
  }

  return items;
}

export function writeSecretValue(secretRef: string, value: string): SecretStatus {
  const normalized = normalizeSecretRef(secretRef);
  if (!normalized) {
    throw new Error("secretRef is required");
  }

  const updatedAt = new Date().toISOString();
  const current = readLocalSecretStoreFile();
  current.secrets[normalized] = {
    value,
    updatedAt,
  };
  writeLocalSecretStoreFile(current);

  return {
    secretRef: normalized,
    ready: true,
    source: "store",
    updatedAt,
  };
}

export function getSecretValueForAuth(auth: ProviderAuthConfig | undefined, env: NodeJS.ProcessEnv = process.env) {
  if (!auth) {
    return undefined;
  }

  if (auth.kind === "chatgpt_session") {
    return undefined;
  }

  if (auth.kind === "api_key" || auth.kind === "oauth_token") {
    return resolveSecretValue(auth.secretRef, env);
  }

  return undefined;
}

export function getProviderAuthSecretRefs(auth: ProviderAuthConfig | undefined): string[] {
  if (!auth) {
    return [];
  }

  if (auth.kind === "chatgpt_session") {
    return [];
  }

  if (auth.kind === "api_key" || auth.kind === "oauth_token") {
    return [auth.secretRef];
  }

  return [];
}

export function collectSecretRefsFromHeaderRules(
  headers: Array<{ secretRef?: unknown; envRef?: unknown }> | undefined,
): string[] {
  if (!headers?.length) {
    return [];
  }

  const refs: string[] = [];
  for (const header of headers) {
    const secretRef = normalizeSecretRef(
      typeof header.secretRef === "string" ? header.secretRef : undefined,
    );
    if (secretRef) {
      refs.push(secretRef);
    }

    const envRef = normalizeSecretRef(typeof header.envRef === "string" ? header.envRef : undefined);
    if (envRef) {
      refs.push(envRef);
    }
  }

  return refs;
}
