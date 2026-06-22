export type ExecutorCapabilities = {
  nativeResume: boolean;
  runtimeWorkspace: boolean;
  runtimeContract: boolean;
};

const DEFAULT_EXECUTOR_CAPABILITIES: ExecutorCapabilities = {
  nativeResume: false,
  runtimeWorkspace: false,
  runtimeContract: false,
};

const EXECUTOR_CAPABILITY_REGISTRY: Record<string, ExecutorCapabilities> = {
  codex: {
    nativeResume: true,
    runtimeWorkspace: true,
    runtimeContract: true,
  },
  qoder: {
    nativeResume: false,
    runtimeWorkspace: true,
    runtimeContract: true,
  },
  opencode: {
    nativeResume: false,
    runtimeWorkspace: true,
    runtimeContract: true,
  },
  claude_code: {
    nativeResume: false,
    runtimeWorkspace: true,
    runtimeContract: true,
  },
  model: {
    nativeResume: false,
    runtimeWorkspace: false,
    runtimeContract: false,
  },
};

export function getExecutorCapabilities(adapterId?: string | null): ExecutorCapabilities {
  const normalizedAdapterId = adapterId?.trim();
  if (!normalizedAdapterId) {
    return { ...DEFAULT_EXECUTOR_CAPABILITIES };
  }

  const capabilities = EXECUTOR_CAPABILITY_REGISTRY[normalizedAdapterId];
  return capabilities ? { ...capabilities } : { ...DEFAULT_EXECUTOR_CAPABILITIES };
}

export function adapterSupportsNativeResume(adapterId?: string | null) {
  return getExecutorCapabilities(adapterId).nativeResume;
}
