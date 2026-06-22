const activeAsyncTeammatesByTask = new Map<string, Set<string>>();

export function registerActiveAsyncTeammate(taskId: string, teammateRunId: string): void {
  if (!taskId || !teammateRunId) return;
  const existing = activeAsyncTeammatesByTask.get(taskId);
  if (existing) {
    existing.add(teammateRunId);
    return;
  }
  activeAsyncTeammatesByTask.set(taskId, new Set([teammateRunId]));
}

export function unregisterActiveAsyncTeammate(taskId: string, teammateRunId: string): void {
  const existing = activeAsyncTeammatesByTask.get(taskId);
  if (!existing) return;
  existing.delete(teammateRunId);
  if (existing.size === 0) {
    activeAsyncTeammatesByTask.delete(taskId);
  }
}

export function isActiveAsyncTeammate(taskId: string, teammateRunId: string): boolean {
  return activeAsyncTeammatesByTask.get(taskId)?.has(teammateRunId) ?? false;
}

export function __resetActiveAsyncTeammatesForTest(): void {
  activeAsyncTeammatesByTask.clear();
}
