import {
  CURRENT_MEMORY_SCHEMA_VERSION,
  type MemoryScope,
} from "./memory-types";

export interface MemoryRuntimeConfig {
  userScopeRoot: string;
  projectScopeRoot: string;
}

export interface MemoryRuntime {
  readonly roots: Record<MemoryScope, string>;
  readonly schemaVersion: number;
}

let runtime: MemoryRuntime | null = null;

export function initMemoryRuntime(cfg: MemoryRuntimeConfig): void {
  runtime = {
    roots: {
      "user-global": cfg.userScopeRoot,
      project: cfg.projectScopeRoot,
    },
    schemaVersion: CURRENT_MEMORY_SCHEMA_VERSION,
  };
}

export function getMemoryRuntime(): MemoryRuntime {
  if (!runtime) {
    throw new Error(
      "[memory] runtime not initialized; call initMemoryRuntime() at server startup"
    );
  }
  return runtime;
}

export function resetMemoryRuntimeForTests(rt: MemoryRuntime | null = null): void {
  runtime = rt;
}
