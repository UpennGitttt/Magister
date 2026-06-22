import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

type CircuitState = "closed" | "open" | "half_open";

type CircuitEntry = {
  consecutiveFailures: number;
  lastFailureCode: string | null;
  lastFailureAt: string | null;
  openUntil: string | null;
};

type CircuitStore = {
  version: 1;
  adapters: Record<string, CircuitEntry>;
};

export type ExecutorCircuitState = {
  adapterId: string;
  state: CircuitState;
  consecutiveFailures: number;
  lastFailureCode: string | null;
  lastFailureAt: string | null;
  openUntil: string | null;
};

type CircuitTimestampOptions = {
  now?: Date;
};

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_OPEN_MS = 2 * 60 * 1000;

function parsePositiveInteger(value: string | undefined, fallback: number) {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function getFailureThreshold() {
  return parsePositiveInteger(
    process.env.MAGISTER_EXECUTOR_CIRCUIT_FAILURE_THRESHOLD,
    DEFAULT_FAILURE_THRESHOLD,
  );
}

function getOpenWindowMs() {
  return parsePositiveInteger(
    process.env.MAGISTER_EXECUTOR_CIRCUIT_OPEN_MS,
    DEFAULT_OPEN_MS,
  );
}

function getStorePath() {
  const explicitPath = process.env.MAGISTER_EXECUTOR_CIRCUIT_STORE_PATH?.trim();
  if (explicitPath) {
    return explicitPath;
  }

  return join(process.cwd(), ".magister", "executor-circuit-breakers.json");
}

function defaultEntry(): CircuitEntry {
  return {
    consecutiveFailures: 0,
    lastFailureCode: null,
    lastFailureAt: null,
    openUntil: null,
  };
}

async function readStore(): Promise<CircuitStore> {
  const storePath = getStorePath();
  try {
    const content = await readFile(storePath, "utf8");
    const parsed = JSON.parse(content) as CircuitStore;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      parsed.version !== 1 ||
      !parsed.adapters ||
      typeof parsed.adapters !== "object"
    ) {
      return { version: 1, adapters: {} };
    }
    return parsed;
  } catch {
    return { version: 1, adapters: {} };
  }
}

async function writeStore(store: CircuitStore) {
  const storePath = getStorePath();
  await mkdir(dirname(storePath), { recursive: true });
  await writeFile(storePath, JSON.stringify(store, null, 2), "utf8");
}

function resolveState(entry: CircuitEntry, now: Date): CircuitState {
  if (!entry.openUntil) {
    return "closed";
  }

  const openUntilMs = Date.parse(entry.openUntil);
  if (!Number.isFinite(openUntilMs)) {
    return "closed";
  }

  return openUntilMs > now.getTime() ? "open" : "half_open";
}

function toResource(
  adapterId: string,
  entry: CircuitEntry,
  now: Date,
): ExecutorCircuitState {
  return {
    adapterId,
    state: resolveState(entry, now),
    consecutiveFailures: entry.consecutiveFailures,
    lastFailureCode: entry.lastFailureCode,
    lastFailureAt: entry.lastFailureAt,
    openUntil: entry.openUntil,
  };
}

export async function getExecutorCircuitState(
  adapterId: string,
  options: CircuitTimestampOptions = {},
): Promise<ExecutorCircuitState> {
  const now = options.now ?? new Date();
  const store = await readStore();
  const entry = store.adapters[adapterId] ?? defaultEntry();
  return toResource(adapterId, entry, now);
}

export async function recordExecutorCircuitFailure(
  adapterId: string,
  input: {
    code: string;
    now?: Date;
  },
): Promise<ExecutorCircuitState> {
  const now = input.now ?? new Date();
  const threshold = getFailureThreshold();
  const openWindowMs = getOpenWindowMs();
  const store = await readStore();
  const current = store.adapters[adapterId] ?? defaultEntry();
  const currentState = resolveState(current, now);

  const consecutiveFailures =
    currentState === "half_open"
      ? threshold
      : Math.max(current.consecutiveFailures, 0) + 1;

  const next: CircuitEntry = {
    consecutiveFailures,
    lastFailureCode: input.code,
    lastFailureAt: now.toISOString(),
    openUntil:
      consecutiveFailures >= threshold
        ? new Date(now.getTime() + openWindowMs).toISOString()
        : current.openUntil,
  };

  store.adapters[adapterId] = next;
  await writeStore(store);
  return toResource(adapterId, next, now);
}

export async function recordExecutorCircuitSuccess(
  adapterId: string,
  options: CircuitTimestampOptions = {},
): Promise<ExecutorCircuitState> {
  const now = options.now ?? new Date();
  const store = await readStore();
  const next: CircuitEntry = {
    consecutiveFailures: 0,
    lastFailureCode: null,
    lastFailureAt: null,
    openUntil: null,
  };

  store.adapters[adapterId] = next;
  await writeStore(store);
  return toResource(adapterId, next, now);
}

export async function resetExecutorCircuitsForTests() {
  const storePath = getStorePath();
  await rm(storePath, { force: true });
}
