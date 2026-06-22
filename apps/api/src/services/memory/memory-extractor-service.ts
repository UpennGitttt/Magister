import type {
  LeaderMessage,
  LeaderStreamEvent,
} from "../manager-automation/autonomous-loop/autonomous-types";
import { callStreamingApi } from "../manager-automation/autonomous-loop/streaming-api-caller";
import { resolveAgentForRole } from "../agent-resolution-service";
import { buildApiConfigFromAgent } from "../process-task-intent-service";
import { MEMORY_EXTRACTOR_SYSTEM_PROMPT } from "./memory-extractor-prompt";
import { upsertMemory } from "./memory-fs-service";
import { memoryLog } from "./memory-log";
import {
  recordExtractorCoalesced,
  recordExtractorError,
  recordExtractorRun,
} from "./memory-telemetry";

/**
 * Best-effort durable record of an extractor failure. Writes an
 * `execution_events` row alongside the existing stdout WARN so the
 * Diagnostics tab + any later analytics surface can query
 * extractor health without scraping logs. Fire-and-forget; if the
 * DB write itself fails (no migrations, schema drift, etc.), drop
 * to stdout — the extractor path must never crash on observability.
 * (Codex final review follow-up.)
 */
async function recordExtractorErrorEvent(payload: {
  taskId: string | null;
  reason: ExtractReason;
  errors: string[];
  applied: number;
  skipped: number;
}): Promise<void> {
  try {
    const { ExecutionEventRepository } = await import(
      "../../repositories/execution-event-repository"
    );
    const repo = new ExecutionEventRepository();
    await repo.create({
      id: `memory_extractor_error_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: "memory.extractor_error",
      ...(payload.taskId ? { taskId: payload.taskId } : {}),
      severity: "warning",
      occurredAt: new Date(),
      payloadJson: JSON.stringify({
        reason: payload.reason,
        errors: payload.errors.slice(0, 10),
        applied: payload.applied,
        skipped: payload.skipped,
      }),
    });
  } catch (err) {
    memoryLog.warn("extractor-error-event-write-failed", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Hot-path memory extractor — invoked by Magister infrastructure (NOT the
 * leader's `spawn_teammate` flow) on three triggers:
 *   - pre_compact:         compaction is about to drop messages; harvest facts first
 *   - failure_reflection:  a run failed (task.failed / doom_loop / approval rejected); write feedback/*.md
 *   - amem_link:           an upsert just landed; suggest supersedes/related edges over nearby entries
 *
 * Output contract is enforced by `MEMORY_EXTRACTOR_SYSTEM_PROMPT`:
 * a single fenced ```json``` block with `{ operations: [...] }`. Anything
 * outside the block, or a malformed block, results in zero ops applied.
 *
 * Design constraints:
 *   - Never throws — extractor is best-effort on the hot path. Errors
 *     are caught + logged + returned in the result.
 *   - Caps input prompt size to keep budget bounded.
 *   - Fire-and-forget concurrency: callers may overlap; atomic writes
 *     in `memory-fs-service` are the only shared mutable state.
 */

export type ExtractReason = "pre_compact" | "failure_reflection" | "amem_link";

export interface ExtractMemoryContext {
  reason: ExtractReason;
  /** Current task id, when applicable (pre_compact + failure_reflection). */
  taskId?: string;
  /** Full text fed to the extractor as the single user message. */
  userPrompt: string;
  /**
   * When false, the extractor parses operations but does NOT apply
   * them via upsertMemory — the caller takes ownership of applying.
   * Used by the A-MEM link pass, which must NOT let the model
   * overwrite the entry's body/description via a full upsert; it
   * filters down to link-field merges only. Default: true.
   */
  applyOps?: boolean;
  /**
   * Optional discriminator for the singleflight key. When the same
   * (reason, dedupeKey) is already in-flight, the new call is
   * coalesced (skipped + logged). Defaults to `taskId` when unset;
   * A-MEM passes the new-entry path so different entries' link
   * passes don't collapse into one. Set to `"global"`-equivalent
   * if you want a process-wide singleflight for that reason.
   */
  dedupeKey?: string;
}

export interface ExtractedOperation {
  op: "upsert";
  path: string;
  description: string;
  body: string;
  supersedes?: string;
  supersededBy?: string;
  related?: string[];
}

export interface ExtractMemoryResult {
  /** Operations actually written to disk (zero when applyOps=false). */
  applied: number;
  /** Operations the extractor proposed but we rejected (cap / validation). */
  skipped: number;
  /**
   * Parsed operations — present whether or not we applied them. The
   * A-MEM link pass uses this with `applyOps: false` so it can
   * post-process the ops itself (drop body/description drift, keep
   * only link-field merges).
   */
  parsedOps: ExtractedOperation[];
  /** Raw text returned by the model — kept short for logs. */
  rawText: string;
  /** Per-op errors, if any. Empty array = clean run. */
  errors: string[];
}

const INPUT_PROMPT_CAP_CHARS = 8_000;
const RESPONSE_TIMEOUT_MS = 30_000;
const MAX_OPS_PER_INVOCATION = 10;

const EMPTY_RESULT: ExtractMemoryResult = {
  applied: 0,
  skipped: 0,
  parsedOps: [],
  rawText: "",
  errors: [],
};

/**
 * Process-wide singleflight registry. Key = `${reason}::${dedupeKey}`.
 * When a key is in-flight, repeated callers get a coalesced result
 * immediately (the original invocation keeps running). Without this,
 * a leader with many overlapping triggers (frequent compactions +
 * concurrent A-MEM passes + failure cascade) would stack unbounded
 * 30s model calls. (Codex Phase 3 round-3 review 2026-05-14.)
 */
const inFlightExtractors = new Set<string>();

function singleflightKey(ctx: ExtractMemoryContext): string {
  return `${ctx.reason}::${ctx.dedupeKey ?? ctx.taskId ?? "global"}`;
}

export async function runMemoryExtractor(
  ctx: ExtractMemoryContext,
): Promise<ExtractMemoryResult> {
  const start = Date.now();
  const sfKey = singleflightKey(ctx);
  if (inFlightExtractors.has(sfKey)) {
    memoryLog.info("extractor-coalesced", {
      reason: ctx.reason,
      key: sfKey,
    });
    recordExtractorCoalesced(ctx.reason);
    return { ...EMPTY_RESULT };
  }
  inFlightExtractors.add(sfKey);
  try {
    const agent = await resolveAgentForRole("memory-extractor");
    if (!agent || !agent.provider) {
      memoryLog.info("extractor-skipped-no-agent", { reason: ctx.reason });
      return { ...EMPTY_RESULT };
    }

    const userPrompt = capInputPrompt(ctx.userPrompt);
    const messages: LeaderMessage[] = [
      { type: "user", content: userPrompt },
    ];

    let rawText = "";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RESPONSE_TIMEOUT_MS);

    // Reuse the leader's api-config builder so provider/model/binding
    // shapes stay in lockstep without re-implementing the mapping.
    const apiConfig = buildApiConfigFromAgent(agent);

    // If the operator wiped systemPromptOverride from the agent row,
    // fall back to the source-of-truth prompt rather than running
    // the extractor with no contract. (Codex Phase 3 review.)
    const storedPrompt = agent.agent.systemPromptOverride?.trim() ?? "";
    const systemPrompt =
      storedPrompt.length > 0 ? storedPrompt : MEMORY_EXTRACTOR_SYSTEM_PROMPT;
    if (storedPrompt.length === 0) {
      memoryLog.warn("extractor-prompt-empty-using-fallback", {
        reason: ctx.reason,
      });
    }

    try {
      const stream: AsyncGenerator<LeaderStreamEvent> = callStreamingApi(
        {
          messages,
          systemPrompt,
          model: agent.modelName,
          signal: controller.signal,
          ...(agent.maxOutputTokens
            ? { maxOutputTokens: agent.maxOutputTokens }
            : {}),
        },
        {
          provider: apiConfig.provider,
          model: apiConfig.model,
          binding: apiConfig.binding,
        },
      );
      for await (const event of stream) {
        if (event.type === "text_delta") rawText += event.text;
      }
    } finally {
      clearTimeout(timer);
    }

    const ops = parseOperations(rawText);
    if (ops.length === 0) {
      memoryLog.info("extractor-no-ops", {
        reason: ctx.reason,
        durationMs: Date.now() - start,
        textChars: rawText.length,
      });
      return { ...EMPTY_RESULT, rawText: rawText.slice(0, 240) };
    }

    const applyOps = ctx.applyOps !== false; // default true
    if (!applyOps) {
      // Caller takes ownership of applying — A-MEM uses this so it
      // can post-process ops down to link-field merges only.
      memoryLog.info("extractor-parsed-no-apply", {
        reason: ctx.reason,
        opsCount: ops.length,
        durationMs: Date.now() - start,
      });
      return {
        applied: 0,
        skipped: 0,
        parsedOps: ops,
        rawText: rawText.slice(0, 240),
        errors: [],
      };
    }

    let applied = 0;
    let skipped = 0;
    const errors: string[] = [];
    for (const op of ops.slice(0, MAX_OPS_PER_INVOCATION)) {
      try {
        await upsertMemory(
          {
            path: op.path,
            description: op.description,
            body: op.body,
            ...(op.supersedes !== undefined ? { supersedes: op.supersedes } : {}),
            ...(op.supersededBy !== undefined
              ? { supersededBy: op.supersededBy }
              : {}),
            ...(op.related !== undefined ? { related: op.related } : {}),
            // Recursion guard — every upsert the extractor performs
            // skips the A-MEM link pass so the pass doesn't bounce
            // back here and trigger more model calls. (Phase 3.)
            skipLinkPass: true,
          },
          "leader-extractor",
        );
        applied++;
      } catch (err) {
        skipped++;
        errors.push(
          `${op.path}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (ops.length > MAX_OPS_PER_INVOCATION) {
      skipped += ops.length - MAX_OPS_PER_INVOCATION;
      errors.push(
        `cap exceeded: extractor proposed ${ops.length} ops; only first ${MAX_OPS_PER_INVOCATION} applied`,
      );
    }
    memoryLog.info("extractor-ran", {
      reason: ctx.reason,
      taskId: ctx.taskId ?? null,
      applied,
      skipped,
      durationMs: Date.now() - start,
    });
    if (errors.length > 0) {
      // Surface per-op upsert failures as a durable diagnostic row.
      void recordExtractorErrorEvent({
        taskId: ctx.taskId ?? null,
        reason: ctx.reason,
        errors,
        applied,
        skipped,
      });
    }
    recordExtractorRun({
      reason: ctx.reason,
      durationMs: Date.now() - start,
      applied,
      skipped,
      parsed: ops.length,
      errorCount: errors.length,
    });
    for (const m of errors) recordExtractorError(ctx.reason, m);
    return {
      applied,
      skipped,
      parsedOps: ops.slice(0, MAX_OPS_PER_INVOCATION),
      rawText: rawText.slice(0, 240),
      errors,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    memoryLog.warn("extractor-failed", {
      reason: ctx.reason,
      err: message,
    });
    void recordExtractorErrorEvent({
      taskId: ctx.taskId ?? null,
      reason: ctx.reason,
      errors: [message],
      applied: 0,
      skipped: 0,
    });
    recordExtractorRun({
      reason: ctx.reason,
      durationMs: Date.now() - start,
      applied: 0,
      skipped: 0,
      parsed: 0,
      errorCount: 1,
    });
    recordExtractorError(ctx.reason, message);
    return {
      applied: 0,
      skipped: 0,
      parsedOps: [],
      rawText: "",
      errors: [message],
    };
  } finally {
    inFlightExtractors.delete(sfKey);
  }
}

function capInputPrompt(text: string): string {
  if (text.length <= INPUT_PROMPT_CAP_CHARS) return text;
  const head = text.slice(0, INPUT_PROMPT_CAP_CHARS);
  return `${head}\n\n[... input truncated at ${INPUT_PROMPT_CAP_CHARS} chars for budget; ${
    text.length - INPUT_PROMPT_CAP_CHARS
  } chars dropped]`;
}

/**
 * Pull the first ```json fenced block out of the extractor's raw
 * response and parse it. Resilient to leading/trailing whitespace
 * and to JSON parse failures.
 */
export function parseOperations(raw: string): ExtractedOperation[] {
  if (!raw || raw.length === 0) return [];
  const match = raw.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!match || !match[1]) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return [];
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("operations" in parsed) ||
    !Array.isArray((parsed as { operations: unknown }).operations)
  ) {
    return [];
  }
  const raws = (parsed as { operations: unknown[] }).operations;
  const ops: ExtractedOperation[] = [];
  for (const candidate of raws) {
    if (!candidate || typeof candidate !== "object") continue;
    const c = candidate as Record<string, unknown>;
    if (c.op !== "upsert") continue;
    if (typeof c.path !== "string" || typeof c.description !== "string") continue;
    if (typeof c.body !== "string") continue;
    const op: ExtractedOperation = {
      op: "upsert",
      path: c.path,
      description: c.description,
      body: c.body,
    };
    if (typeof c.supersedes === "string") op.supersedes = c.supersedes;
    if (typeof c.supersededBy === "string") op.supersededBy = c.supersededBy;
    if (Array.isArray(c.related)) {
      const related = c.related.filter((p): p is string => typeof p === "string");
      if (related.length > 0) op.related = related;
    }
    ops.push(op);
  }
  return ops;
}
