import { spawnProcess } from "../lib/platform/spawn";
import { resolveCliExecutable } from "./cli-bridge/cli-executable-resolver";
import type { AgentRuntimeType } from "./agent-profile-service";

export type DiscoveredModel = {
  id: string;
  provider: string;
  label: string;
  isDefault?: boolean;
};

export type DiscoveredModelResult = DiscoveredModel[] & {
  models?: DiscoveredModel[];
  supported?: boolean;
};

type CacheEntry = {
  expiresAt: number;
  items: DiscoveredModel[];
};

type DiscoverOptions = {
  refresh?: boolean;
};

const CACHE_TTL_MS = 60_000;
const discoveryCache = new Map<string, CacheEntry>();

const CODEX_MODEL_CATALOG: DiscoveredModel[] = [
  { id: "gpt-5.4", provider: "openai", label: "gpt-5.4", isDefault: true },
  { id: "gpt-5.4-mini", provider: "openai", label: "gpt-5.4-mini" },
  { id: "gpt-5.3-codex", provider: "openai", label: "gpt-5.3-codex" },
  { id: "gpt-5.3-codex-spark", provider: "openai", label: "gpt-5.3-codex-spark" },
  { id: "gpt-5.2", provider: "openai", label: "gpt-5.2" },
  { id: "gpt-5.2-codex", provider: "openai", label: "gpt-5.2-codex" },
  { id: "gpt-5.1-codex-mini", provider: "openai", label: "gpt-5.1-codex-mini" },
];

const CLAUDE_CODE_MODEL_CATALOG: DiscoveredModel[] = [
  { id: "claude-sonnet-4-6", provider: "anthropic", label: "claude-sonnet-4-6", isDefault: true },
  { id: "claude-sonnet-4-5", provider: "anthropic", label: "claude-sonnet-4-5" },
  { id: "claude-opus-4-6", provider: "anthropic", label: "claude-opus-4-6" },
  { id: "claude-haiku-4-5", provider: "anthropic", label: "claude-haiku-4-5" },
  { id: "claude-3-7-sonnet", provider: "anthropic", label: "claude-3-7-sonnet" },
];

function normalizeRuntimeType(runtimeType: AgentRuntimeType | null | undefined): AgentRuntimeType {
  if (runtimeType === "codex" || runtimeType === "opencode" || runtimeType === "claude-code") {
    return runtimeType;
  }

  return "ucm";
}

function cloneModelList(items: DiscoveredModel[]): DiscoveredModel[] {
  return items.map((item) => ({ ...item }));
}

function toDiscoveredModelResult(items: DiscoveredModel[], supported: boolean): DiscoveredModelResult {
  const cloned = cloneModelList(items) as DiscoveredModelResult;
  Object.defineProperty(cloned, "models", {
    value: cloneModelList(items),
    enumerable: false,
  });
  Object.defineProperty(cloned, "supported", {
    value: supported,
    enumerable: false,
  });
  return cloned;
}

function makeCacheKey(runtimeType: AgentRuntimeType, commandPath?: string | null): string {
  return `${runtimeType}:${commandPath?.trim() || ""}`;
}

function getCachedModels(cacheKey: string): DiscoveredModel[] | null {
  const cached = discoveryCache.get(cacheKey);
  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= Date.now()) {
    discoveryCache.delete(cacheKey);
    return null;
  }

  return cloneModelList(cached.items);
}

function setCachedModels(cacheKey: string, items: DiscoveredModel[]) {
  discoveryCache.set(cacheKey, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    items: cloneModelList(items),
  });
}

function parseModelLine(rawLine: string): DiscoveredModel | null {
  const line = rawLine.trim();
  if (line.length === 0) {
    return null;
  }

  const separatorIndex = line.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex >= line.length - 1) {
    return {
      id: line,
      provider: "unknown",
      label: line,
    };
  }

  const provider = line.slice(0, separatorIndex).trim();
  const label = line.slice(separatorIndex + 1).trim();

  if (!provider || !label) {
    return null;
  }

  return {
    id: line,
    provider,
    label,
  };
}

async function discoverOpencodeModels(commandPath?: string | null): Promise<DiscoveredModel[]> {
  try {
    const resolvedCommandPath = (await resolveCliExecutable("opencode", commandPath)).command;
    const proc = spawnProcess([resolvedCommandPath, "models"]);

    const [exitCode, stdout] = await Promise.all([
      proc.exited,
      proc.stdoutText(),
    ]);

    if (exitCode !== 0) {
      return [];
    }

    const unique = new Map<string, DiscoveredModel>();
    for (const line of stdout.split(/\r?\n/)) {
      const parsed = parseModelLine(line);
      if (!parsed) {
        continue;
      }
      if (!unique.has(parsed.id)) {
        unique.set(parsed.id, parsed);
      }
    }

    return [...unique.values()];
  } catch {
    return [];
  }
}

type CodexCatalogModel = {
  slug?: unknown;
  display_name?: unknown;
  displayName?: unknown;
  visibility?: unknown;
};

function parseCodexModelCatalog(rawOutput: string): DiscoveredModel[] {
  const jsonLine = rawOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("{") && line.endsWith("}"));
  if (!jsonLine) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonLine);
  } catch {
    return [];
  }

  const models = Array.isArray((parsed as { models?: unknown }).models)
    ? ((parsed as { models: unknown[] }).models as CodexCatalogModel[])
    : [];
  const visible = models.filter((model) => model.visibility === "list" || model.visibility === undefined);

  return visible
    .map((model, index) => {
      const id = typeof model.slug === "string" ? model.slug.trim() : "";
      if (!id) {
        return null;
      }
      const label =
        typeof model.display_name === "string" && model.display_name.trim()
          ? model.display_name.trim()
          : typeof model.displayName === "string" && model.displayName.trim()
            ? model.displayName.trim()
            : id;
      return {
        id,
        provider: "openai",
        label,
        ...(index === 0 ? { isDefault: true } : {}),
      };
    })
    .filter((model): model is DiscoveredModel => model !== null);
}

async function discoverCodexModels(commandPath?: string | null): Promise<DiscoveredModel[]> {
  try {
    const resolvedCommandPath = (await resolveCliExecutable("codex", commandPath)).command;
    const proc = spawnProcess([resolvedCommandPath, "debug", "models"]);

    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      proc.stdoutText(),
      proc.stderrText(),
    ]);

    if (exitCode !== 0) {
      return [];
    }

    return parseCodexModelCatalog(`${stderr}\n${stdout}`);
  } catch {
    return [];
  }
}

function scoreClaudeModel(id: string): number {
  const familyScore = id.includes("-opus-") ? 300 : id.includes("-sonnet-") ? 200 : id.includes("-haiku-") ? 100 : 0;
  const version = id.match(/-(\d+)-(\d+)/);
  const major = version ? Number(version[1]) : 0;
  const minor = version ? Number(version[2]) : 0;
  return familyScore + major * 10 + minor;
}

function parseClaudeModelTokens(rawOutput: string): DiscoveredModel[] {
  const tokens = rawOutput.match(/claude-(opus|sonnet|haiku)-[A-Za-z0-9.[\]-]+/g) ?? [];
  const unique = new Set<string>();

  for (const token of tokens) {
    const id = token.replace(/[),.;:]+$/g, "");
    if (/\d{8}/.test(id) || id.includes("-v1") || id.includes("@") || id.includes("[") || id.includes(".")) {
      continue;
    }
    if (!/^claude-(opus|sonnet|haiku)-\d+-\d+$/.test(id) && !/^claude-sonnet-3-7$/.test(id)) {
      continue;
    }
    unique.add(id);
  }

  return [...unique]
    .sort((left, right) => scoreClaudeModel(right) - scoreClaudeModel(left) || left.localeCompare(right))
    .map((id) => ({
      id,
      provider: "anthropic",
      label: id,
      ...(id === "claude-sonnet-4-6" ? { isDefault: true } : {}),
    }));
}

async function discoverClaudeCodeModels(commandPath?: string | null): Promise<DiscoveredModel[]> {
  try {
    const resolvedCommandPath = (await resolveCliExecutable("claude-code", commandPath)).command;
    const proc = spawnProcess(["strings", resolvedCommandPath]);
    const [exitCode, stdout] = await Promise.all([proc.exited, proc.stdoutText()]);
    if (exitCode !== 0) {
      return [];
    }
    return parseClaudeModelTokens(stdout);
  } catch {
    return [];
  }
}

export function clearDiscoveredModelCache() {
  discoveryCache.clear();
}

export async function discoverModels(
  runtimeType: AgentRuntimeType | null | undefined,
  commandPath?: string | null,
  options?: DiscoverOptions,
): Promise<DiscoveredModelResult> {
  const normalizedRuntimeType = normalizeRuntimeType(runtimeType);
  const cacheKey = makeCacheKey(normalizedRuntimeType, commandPath);

  const cached = options?.refresh ? null : getCachedModels(cacheKey);
  if (cached) {
    return toDiscoveredModelResult(cached, true);
  }

  let items: DiscoveredModel[] = [];

  if (normalizedRuntimeType === "opencode") {
    items = await discoverOpencodeModels(commandPath);
  } else if (normalizedRuntimeType === "codex") {
    items = await discoverCodexModels(commandPath);
    if (items.length === 0) {
      items = cloneModelList(CODEX_MODEL_CATALOG);
    }
  } else if (normalizedRuntimeType === "claude-code") {
    items = await discoverClaudeCodeModels(commandPath);
    if (items.length === 0) {
      items = cloneModelList(CLAUDE_CODE_MODEL_CATALOG);
    }
  }

  setCachedModels(cacheKey, items);
  return toDiscoveredModelResult(items, true);
}
