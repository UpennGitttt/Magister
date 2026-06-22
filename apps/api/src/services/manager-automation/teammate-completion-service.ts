/**
 * Async teammate completion injection.
 *
 * When a background teammate (spawned with wait: false) finishes, this
 * service writes a structured mailbox message so the leader's next turn
 * sees the result, then re-enqueues the leader if it is sitting in
 * AWAITING_TEAMMATES.
 */

import { TaskMailboxRepository } from "../../repositories/task-mailbox-repository";
import { TaskRepository } from "../../repositories/task-repository";
import { RoleRuntimeRepository } from "../../repositories/role-runtime-repository";
import { ExecutionEventRepository } from "../../repositories/execution-event-repository";

export type TeammateCompletionEvent = {
  parentTaskId: string;
  teammateRunId: string;
  role: string;
  status: "COMPLETED" | "FAILED" | "CANCELLED";
  summary: string;
  spawnedAtMs: number;
  completedAtMs: number;
  usage?: { inputTokens: number; outputTokens: number };
  failureReason?: string;
  /**
   * Parallel-group id this teammate belongs to, if it was spawned as
   * part of a `spawn_teammates` batch. When set, completion of the last
   * group member triggers a consolidated "group all done" mailbox line.
   */
  parallelGroupId?: string | null;
};

const TERMINAL_STATES = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

/**
 * True when every teammate sharing `groupId` has reached a terminal
 * state. Used to append a one-line "parallel group all done" note to
 * the last member's completion mailbox so the leader can resume the
 * cohort as a unit.
 */
export async function isParallelGroupComplete(groupId: string): Promise<boolean> {
  const members = await new RoleRuntimeRepository().listByParallelGroupId(groupId);
  const m = /_(\d+)$/.exec(groupId);
  const expected = m ? Number(m[1]) : 0;
  // Need the full cohort present AND all terminal. If the id has no
  // encoded size (shouldn't happen for batch spawns), fall back to
  // "non-empty and all terminal". The encoded-size gate is what prevents
  // a premature "all done" fire while sibling rows are still being created
  // concurrently (members.length < expected => not yet complete).
  if (expected > 0) {
    return (
      members.length >= expected && members.every((x) => TERMINAL_STATES.has(x.state))
    );
  }
  return members.length > 0 && members.every((x) => TERMINAL_STATES.has(x.state));
}

/**
 * Write a structured mailbox message recording this async teammate's
 * completion. Best-effort with 3 attempts + 100 ms backoff. On final
 * failure, writes an execution event for audit.
 *
 * If the teammate belongs to a parallel group (`parallelGroupId`) and
 * its completion makes the whole group terminal, a single consolidated
 * "all done" line is appended best-effort — purely additive on top of
 * the per-teammate note, never replacing it.
 */
export async function writeTeammateCompletionMailbox(
  event: TeammateCompletionEvent,
): Promise<void> {
  const mailbox = new TaskMailboxRepository();
  const summaryPreview = event.summary.split("\n")[0]?.slice(0, 120) ?? "";
  const text = `[teammate completed] ${event.role} (${event.teammateRunId}): ${summaryPreview}`;
  const metadata = {
    type: "teammate_completion",
    teammateRunId: event.teammateRunId,
    role: event.role,
    status: event.status,
    summary: event.summary.slice(0, 50_000),
    spawnedAtMs: event.spawnedAtMs,
    completedAtMs: event.completedAtMs,
    durationMs: event.completedAtMs - event.spawnedAtMs,
    ...(event.usage ? { usage: event.usage } : {}),
    ...(event.failureReason ? { failureReason: event.failureReason } : {}),
  };

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await mailbox.create({
        id: `msg_async_${event.teammateRunId}_${event.completedAtMs}`,
        taskId: event.parentTaskId,
        sender: "system",
        content: text,
        metadataJson: JSON.stringify(metadata),
        createdAt: new Date(event.completedAtMs),
      });
      // Additive consolidated note: if this teammate was the last
      // member of its parallel group to reach a terminal state, append a
      // consolidated "all done" message carrying every member's summary so
      // the leader receives the full cohort output in one turn, even when
      // earlier members' per-teammate rows were injected in prior turns.
      // Best-effort — never lets a failure here break the (already
      // persisted) per-teammate completion.
      if (event.parallelGroupId) {
        try {
          if (await isParallelGroupComplete(event.parallelGroupId)) {
            const members = await new RoleRuntimeRepository().listByParallelGroupId(
              event.parallelGroupId,
            );
            const groupId = event.parallelGroupId;

            // Recover each group member's summary from their earlier
            // teammate_completion mailbox rows (consumed or not).
            const allMailboxRows = await mailbox.listByTaskId(event.parentTaskId);
            const memberRunIds = new Set(members.map((m) => m.id));

            type MemberSummary = { role: string; runId: string; summary: string };
            const memberSummaries: MemberSummary[] = [];
            for (const row of allMailboxRows) {
              if (!row.metadataJson) continue;
              try {
                const meta = JSON.parse(row.metadataJson) as {
                  type?: string;
                  teammateRunId?: string;
                  role?: string;
                  summary?: string;
                };
                if (
                  meta.type === "teammate_completion" &&
                  meta.teammateRunId &&
                  memberRunIds.has(meta.teammateRunId) &&
                  meta.role &&
                  meta.summary
                ) {
                  memberSummaries.push({
                    role: meta.role,
                    runId: meta.teammateRunId,
                    summary: meta.summary,
                  });
                }
              } catch {
                // malformed row — skip
              }
            }

            // Include the current (last) member's summary too, since its
            // mailbox row was just written in this same iteration but we
            // already committed above, so it should appear in listByTaskId.
            // However listByTaskId is called right after the per-member insert,
            // so the row IS present. But just in case it's somehow missing,
            // add it from the in-memory event data.
            const alreadyHasLast = memberSummaries.some(
              (s) => s.runId === event.teammateRunId,
            );
            if (!alreadyHasLast) {
              memberSummaries.push({
                role: event.role,
                runId: event.teammateRunId,
                summary: event.summary,
              });
            }

            // Build the consolidated content, capped to ~40 000 chars total.
            // Per-summary cap: ~12 000 chars each with a truncation marker.
            const PER_SUMMARY_CAP = 12_000;
            const TOTAL_CAP = 40_000;

            let sections = memberSummaries.map((s) => {
              const truncated = s.summary.length > PER_SUMMARY_CAP
                ? s.summary.slice(0, PER_SUMMARY_CAP) + "\n…(truncated)"
                : s.summary;
              return `### ${s.role} (${s.runId.slice(0, 12)})\n${truncated}`;
            });

            const header = `All ${members.length} teammates in parallel group ${groupId} have completed. Consolidated outputs:\n\n`;
            let body = sections.join("\n\n");
            if (header.length + body.length > TOTAL_CAP) {
              body = body.slice(0, TOTAL_CAP - header.length);
            }
            const content = header + body;

            await mailbox.create({
              // Stable per-group id (no per-completion suffix) so the rare
              // concurrent last-two-finish double-fire is naturally deduped:
              // the second insert collides on this primary key and throws,
              // which the surrounding try/catch swallows. One note per group.
              id: `msg_async_group_${groupId}`,
              taskId: event.parentTaskId,
              sender: "system",
              content,
              metadataJson: JSON.stringify({
                type: "parallel_group_completion",
                parallelGroupId: groupId,
                memberCount: members.length,
                completedAtMs: event.completedAtMs,
                members: memberSummaries.map((s) => ({
                  role: s.role,
                  runId: s.runId,
                  summary: s.summary.slice(0, PER_SUMMARY_CAP),
                })),
              }),
              createdAt: new Date(event.completedAtMs),
            });
          }
        } catch (groupErr) {
          console.warn(
            `[teammate-completion] consolidated group note failed for group ${event.parallelGroupId}: ${groupErr instanceof Error ? groupErr.message : String(groupErr)}`,
          );
        }
      }
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 100));
    }
  }

  // Final fallback: emit failure event for audit so recovery can detect.
  try {
    const events = new ExecutionEventRepository();
    await events.create({
      id: `event_${crypto.randomUUID()}`,
      type: "leader.teammate_completion_injection_failed",
      taskId: event.parentTaskId,
      severity: "error",
      payloadJson: JSON.stringify({
        event,
        error:
          lastErr instanceof Error ? lastErr.message : String(lastErr),
      }),
      occurredAt: new Date(),
    });
  } catch {
    // Best-effort — if even the audit write fails, log and move on.
    console.error(
      `[teammate-completion] FATAL: could not write completion mailbox or audit event for ${event.teammateRunId}`,
      lastErr,
    );
  }
}

/**
 * Re-enqueue the leader task if it is currently sitting in
 * AWAITING_TEAMMATES. If the task is EXECUTING (leader still running),
 * the mailbox will be drained at the next turn automatically — no
 * re-enqueue needed. If the task is terminal, skip.
 */
export async function reenqueueLeaderIfAwaiting(
  parentTaskId: string,
): Promise<void> {
  const taskRepo = new TaskRepository();
  const task = await taskRepo.getById(parentTaskId);
  if (!task) return;
  if (task.state !== "AWAITING_TEAMMATES") return;

  // Find the leader's runtime row to get runId for checkpoint continuity.
  // The leader runtime has roleId="leader" and should be COMPLETED (set
  // when AWAITING_TEAMMATES was stamped). We pick the most recent one.
  const runtimeRepo = new RoleRuntimeRepository();
  const runtimes = await runtimeRepo.listByTaskId(parentTaskId);
  const leaderRuntime = runtimes
    .filter((rt) => rt.roleId === "leader")
    .sort((a, b) => {
      const ta = a.startedAt?.getTime() ?? a.updatedAt.getTime();
      const tb = b.startedAt?.getTime() ?? b.updatedAt.getTime();
      return tb - ta;
    })[0];

  if (!leaderRuntime) {
    console.warn(
      `[teammate-completion] No leader runtime found for task ${parentTaskId} — cannot re-enqueue`,
    );
    return;
  }

  const { taskWorker } = await import("../task-worker");
  // requeueAfterCurrent (not enqueue): if the leader's previous run is
  // still in the worker's active set, plain enqueue silently drops the
  // re-entry. requeueAfterCurrent defers via setImmediate so the active
  // slot releases first. Same fix pattern as the goal continuation
  // Ralph branch (commit fff7d47).
  taskWorker.requeueAfterCurrent({
    taskId: parentTaskId,
    runId: leaderRuntime.id,
    requestId: `req_async_wake_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
    requestStartedAtMs: Date.now(),
    workspaceId: task.workspaceId,
    prompt: "", // mailbox supplies the actual content
  });
}
