import { runMemoryExtractor } from "./memory-extractor-service";
import { memoryLog } from "./memory-log";

/**
 * Phase 3 — failure-driven reflection. Callers fire this on three
 * triggers (per decisions doc):
 *   - task.failed:              the leader loop threw / hit a terminal failure
 *   - doom_loop_detected:        leader is fingerprint-looping a tool call;
 *                                the event blocks the offending call but the
 *                                loop CONTINUES — so the outer catch never
 *                                sees it. Must hook directly. (codex round-3
 *                                review 2026-05-14.)
 *   - approval.rejected:        user rejected a dangerous command approval
 *
 * Fire-and-forget. The extractor runs in the background, never
 * blocks the caller's return path. Errors are logged but never
 * surfaced — failure reflection is observational, it must NEVER
 * cause additional cascade failures.
 */

export interface FailureReflectionInput {
  kind: "task_failed" | "doom_loop_detected" | "approval_rejected";
  taskId: string;
  /** One-line summary of what failed; used in the extractor prompt. */
  summary: string;
  /** Optional additional context (recent error message, rejected command, etc.). */
  detail?: string;
}

export function fireFailureReflection(input: FailureReflectionInput): void {
  // Detach: callers don't want this on their hot path.
  void (async () => {
    try {
      const prompt = buildFailurePrompt(input);
      const result = await runMemoryExtractor({
        reason: "failure_reflection",
        taskId: input.taskId,
        userPrompt: prompt,
      });
      if (result.errors.length > 0) {
        memoryLog.warn("failure-reflection-errors", {
          kind: input.kind,
          taskId: input.taskId,
          applied: result.applied,
          skipped: result.skipped,
          errors: result.errors.slice(0, 5),
        });
      } else {
        memoryLog.info("failure-reflection-fired", {
          kind: input.kind,
          taskId: input.taskId,
          applied: result.applied,
          skipped: result.skipped,
        });
      }
    } catch (err) {
      memoryLog.warn("failure-reflection-error", {
        kind: input.kind,
        taskId: input.taskId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  })();
}

function buildFailurePrompt(input: FailureReflectionInput): string {
  const lines: string[] = [];
  lines.push(`# Failure-driven reflection`);
  lines.push(``);
  lines.push(`A Magister task hit a terminal failure or rejection. Decide whether anything from this incident is worth distilling into a durable \`feedback\` memory entry under the project scope. Refuse to invent — if nothing here is clearly actionable, return an empty operations array.`);
  lines.push(``);
  lines.push(`## Trigger`);
  lines.push(`- kind: ${input.kind}`);
  lines.push(`- taskId: ${input.taskId}`);
  lines.push(``);
  lines.push(`## Summary`);
  lines.push(input.summary || "(none)");
  if (input.detail) {
    lines.push(``);
    lines.push(`## Detail`);
    lines.push(input.detail);
  }
  lines.push(``);
  lines.push(`Target path for any extraction: \`project/feedback/<kebab-name>.md\`. Keep descriptions to one actionable lesson — "next time, X" framing.`);
  return lines.join("\n");
}
