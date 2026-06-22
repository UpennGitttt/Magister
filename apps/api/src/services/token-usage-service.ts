import { sanitizeRawUsage, type TokenUsageSource } from "./token-usage-normalization";

export type TokenUsageRecord = {
  taskId: string;
  runId: string;
  requestId?: string;
  roleId?: string;
  turnNumber: number;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  nonCachedInputTokens?: number;
  /** Cached input tokens served by the provider's prompt cache.
   *  Anthropic: cache_read_input_tokens. OpenAI: cached_tokens. */
  cacheReadTokens?: number;
  /** Tokens written into the provider prompt cache on this request. */
  cacheWriteTokens?: number;
  /** Output-side reasoning/thinking tokens when the dialect reports a
   *  separate breakdown. Undefined for Anthropic Messages today. */
  reasoningTokens?: number;
  totalTokens?: number;
  usageSource?: TokenUsageSource;
  rawUsage?: unknown;
  /** Char-based estimate of the actual prompt sent to the model.
   *  Used only for usageSource='estimated' fallback rows. */
  estimatedPromptTokens?: number;
  timestamp: number;
};

export type TaskUsageSummary = {
  taskId: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  leaderInputTokens: number;
  leaderOutputTokens: number;
  teammateInputTokens: number;
  teammateOutputTokens: number;
  usageSplitKnown: boolean;
  turnCount: number;
  /** Distinct models seen across all turns. Order is insertion-
   *  order (first-seen) — does NOT reflect temporal recency.
   *  Use `latestModel` / `latestProvider` for "what's running
   *  right now" semantics. */
  models: string[];
  /** The leader model from the most recent leader record for this
   *  task. Falls back to the most recent task record only when no
   *  leader-scoped usage exists, for legacy rows without role/run
   *  identity. */
  latestModel: string | null;
  /** Provider paired with latestModel from the same usage row. */
  latestProvider: string | null;
  /** Leader-scoped aliases for callers that need explicit scope.
   *  `latestModel/latestProvider` are kept as backwards-compatible
   *  names but now carry the same leader-only values. */
  leaderLatestModel: string | null;
  leaderLatestProvider: string | null;
  /** Most recent single-call input tokens. Used by the Tokens
   *  panel to show "Context: X% of window used right now". */
  latestInputTokens: number;
  /** Largest single-call input ever recorded for this task. The
   *  high-water mark — useful for "we got close to the cap once". */
  peakInputTokens: number;
  leaderLatestInputTokens: number;
  leaderPeakInputTokens: number;
  /** The leader model's effective context window, resolved from
   *  the leader latest model's profile/config. Pairs with
   *  latestInputTokens to compute % used. Null when unresolved. */
  contextWindow: number | null;
  leaderContextWindow: number | null;
  byRole: Array<{
    roleId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  }>;
};

// Kimi review C — the in-memory `usageRecords[]` LRU was dropped.
// Previously: writes that failed mid-DB-outage lived only in LRU,
// reads went to DB first → silent data loss once DB recovered.
// Now the DB is sole source of truth; if a recordUsage DB write
// throws we surface it (caller may retry). For dashboards during a
// DB outage, the right behavior is to fail-loud (return error) rather
// than show stale/inconsistent counts.

export async function recordUsage(
  record: Omit<TokenUsageRecord, "timestamp">,
): Promise<TokenUsageRecord> {
  // Cost calculation removed — per-model price tables drifted from real
  // provider pricing. Column kept (write NULL) for legacy compatibility.
  const fullRecord: TokenUsageRecord = {
    ...record,
    timestamp: Date.now(),
  };
  // P1 — persist to DB. Source of truth. Awaited so the next read
  // (e.g. dashboard polling /usage/today right after a turn finishes)
  // sees the row. SQLite local write is sub-ms.
  //
  // On DB failure: log loudly but DON'T throw. Re-throwing would
  // fail the user's turn just because usage bookkeeping had a hiccup.
  // Kimi review C — the previous LRU fallback was worse: those rows
  // became orphaned (DB came back, reads hit DB first, never saw the
  // LRU rows). Now: failures genuinely lose that one record, but
  // dashboards stay consistent (only durable rows are visible).
  try {
    await persistUsage(fullRecord);
  } catch (err) {
    // A dropped row means downstream aggregates miss data. Keep
    // best-effort persistence — the user's turn shouldn't fail
    // for bookkeeping — but log at error level.
    console.error(
      `[token-usage] DB persist failed (record dropped): task=${fullRecord.taskId} run=${fullRecord.runId} model=${fullRecord.model} input=${fullRecord.inputTokens} output=${fullRecord.outputTokens}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return fullRecord;
}

async function persistUsage(record: TokenUsageRecord): Promise<void> {
  // Lazy-import to avoid a hot path on every model call paying for
  // module init. The repo is small but its drizzle handle is shared
  // process-wide via createDb caching.
  const { TokenUsageRepository } = await import("../repositories/token-usage-repository");
  const repo = new TokenUsageRepository();
  const rawUsageJson = serializeRawUsage(record.rawUsage);
  await repo.record({
    taskId: record.taskId,
    runId: record.runId,
    ...(record.requestId !== undefined ? { requestId: record.requestId } : {}),
    ...(record.roleId !== undefined ? { roleId: record.roleId } : {}),
    turnNumber: record.turnNumber,
    model: record.model,
    provider: record.provider,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    costUsd: null,
    ...(record.nonCachedInputTokens !== undefined
      ? { nonCachedInputTokens: record.nonCachedInputTokens }
      : {}),
    ...(record.cacheReadTokens !== undefined ? { cacheReadTokens: record.cacheReadTokens } : {}),
    ...(record.cacheWriteTokens !== undefined ? { cacheWriteTokens: record.cacheWriteTokens } : {}),
    ...(record.reasoningTokens !== undefined ? { reasoningTokens: record.reasoningTokens } : {}),
    ...(record.totalTokens !== undefined ? { totalTokens: record.totalTokens } : {}),
    usageSource: record.usageSource ?? "provider",
    ...(rawUsageJson !== undefined ? { rawUsageJson } : {}),
    ...(record.estimatedPromptTokens !== undefined ? { estimatedPromptTokens: record.estimatedPromptTokens } : {}),
  });
}

function serializeRawUsage(rawUsage: unknown): string | undefined {
  if (rawUsage === undefined) return undefined;
  try {
    return JSON.stringify(sanitizeRawUsage(rawUsage));
  } catch {
    return JSON.stringify({ unserializable: true });
  }
}

function parseRawUsageJson(rawUsageJson: string | null): unknown | undefined {
  if (!rawUsageJson) return undefined;
  try {
    return JSON.parse(rawUsageJson);
  } catch {
    return rawUsageJson;
  }
}

/**
 * Read the task's aggregate from the durable store. Promise-returning
 * because the underlying repository is async. P1 — was synchronous
 * before; all known callers (routes, status-service) await it.
 *
 * On DB error: throws. The caller is responsible for surfacing or
 * fallback. We DON'T fall back to a phantom in-memory aggregate —
 * those would be inconsistent with future writes .
 */
export async function getTaskUsage(taskId: string): Promise<TaskUsageSummary> {
  const { TokenUsageRepository } = await import(
    "../repositories/token-usage-repository"
  );
  const repo = new TokenUsageRepository();
  const [aggregate, roleBreakdown] = await Promise.all([
    repo.getTaskAggregate(taskId),
    repo.getTaskUsageByRole(taskId),
  ]);

  // Resolve the contextWindow for the leader latest model so the UI can
  // render "X% of leader context used". Role-level agent profile values
  // are optional overrides; the canonical model window lives in
  // config/executors.json. Best-effort, swallow errors — the panel is
  // diagnostic and should not break task reads.
  let contextWindow: number | null = null;
  if (aggregate.latestModel) {
    try {
      const { createDb, agentProfiles } = await import("@magister/db");
      const { eq } = await import("@magister/db");
      const db = createDb();
      const profiles = await db.query.agentProfiles.findMany({
        where: eq(agentProfiles.modelName, aggregate.latestModel),
      });
      const profile = profiles.find(
        (item) => typeof item.contextWindow === "number" && item.contextWindow > 0,
      );
      if (profile?.contextWindow && profile.contextWindow > 0) {
        contextWindow = profile.contextWindow;
      }
    } catch {
      // ignored — null falls back to UI default.
    }

    if (contextWindow === null) {
      try {
        const { readExecutorConfigFile } = await import("./executor-config-service");
        const config = await readExecutorConfigFile();
        const model =
          config.models[aggregate.latestModel]
          ?? Object.values(config.models).find((item) => item.modelName === aggregate.latestModel);
        if (typeof model?.contextWindow === "number" && model.contextWindow > 0) {
          contextWindow = model.contextWindow;
        }
      } catch {
        // ignored — null falls back to UI default.
      }
    }
  }

  return {
    taskId,
    totalInputTokens: aggregate.totalInputTokens,
    totalOutputTokens: aggregate.totalOutputTokens,
    leaderInputTokens: aggregate.leaderInputTokens,
    leaderOutputTokens: aggregate.leaderOutputTokens,
    teammateInputTokens: aggregate.teammateInputTokens,
    teammateOutputTokens: aggregate.teammateOutputTokens,
    usageSplitKnown: aggregate.usageSplitKnown,
    turnCount: aggregate.turnCount,
    models: aggregate.models,
    latestModel: aggregate.latestModel,
    latestProvider: aggregate.latestProvider,
    leaderLatestModel: aggregate.latestModel,
    leaderLatestProvider: aggregate.latestProvider,
    latestInputTokens: aggregate.latestInputTokens,
    peakInputTokens: aggregate.peakInputTokens,
    leaderLatestInputTokens: aggregate.latestInputTokens,
    leaderPeakInputTokens: aggregate.peakInputTokens,
    contextWindow,
    leaderContextWindow: contextWindow,
    byRole: roleBreakdown.map((r) => ({
      ...r,
      totalTokens: r.inputTokens + r.outputTokens,
    })),
  };
}

export async function getRecentUsage(limit: number = 100): Promise<TokenUsageRecord[]> {
  const normalizedLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 100;
  const { TokenUsageRepository } = await import(
    "../repositories/token-usage-repository"
  );
  const rows = await new TokenUsageRepository().listRecent(normalizedLimit);
  // Map the DB Select shape back to the public TokenUsageRecord
  // shape (snake → camel + epoch ms `timestamp` for the recordedAt
  // Date column).
  return rows.map((row) => ({
    taskId: row.taskId,
    runId: row.runId,
    ...(row.requestId != null ? { requestId: row.requestId } : {}),
    ...(row.roleId != null ? { roleId: row.roleId } : {}),
    turnNumber: row.turnNumber,
    model: row.model,
    provider: row.provider,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    ...(row.nonCachedInputTokens != null ? { nonCachedInputTokens: row.nonCachedInputTokens } : {}),
    ...(row.cacheReadTokens != null ? { cacheReadTokens: row.cacheReadTokens } : {}),
    ...(row.cacheWriteTokens != null ? { cacheWriteTokens: row.cacheWriteTokens } : {}),
    ...(row.reasoningTokens != null ? { reasoningTokens: row.reasoningTokens } : {}),
    ...(row.totalTokens != null ? { totalTokens: row.totalTokens } : {}),
    ...(row.usageSource != null ? { usageSource: row.usageSource as TokenUsageSource } : {}),
    ...(row.rawUsageJson != null ? { rawUsage: parseRawUsageJson(row.rawUsageJson) } : {}),
    ...(row.estimatedPromptTokens != null ? { estimatedPromptTokens: row.estimatedPromptTokens } : {}),
    timestamp: row.recordedAt.getTime(),
  }));
}
