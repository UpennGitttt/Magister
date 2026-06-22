// Phase 1 (§5.4) of the Leader-driven review autonomy RFC.
//
// When the assignment router decides a change_review belongs to
// Leader's inbox, this bridge:
//   1. writes a synthetic "system" message into task_mailbox
//      describing the review (Leader's autonomous loop already reads
//      task_mailbox at the top of every turn)
//   2. wakes the task worker if it isn't already running this task,
//      so a DONE task picks up the new message instead of letting
//      the mailbox row rot. The wake step uses the existing
//      `taskWorker.enqueue` path (idempotent — no-op if a turn is
//      currently in flight or the task is already queued), mirroring
//      the goal-resume flow in `routes/tasks.ts`.
//
// Why both steps: codex v2 review BLOCKER 3 caught that writing only
// to task_mailbox is insufficient on terminal tasks — the autonomous
// loop drains the mailbox only while the worker is running. Without
// the enqueue call, a Leader-assigned review on a DONE task would
// sit in the inbox forever.
//
// This module is intentionally a no-op caller path until §1c flips a
// workspace to `leader-driven`; the bridge is only invoked when the
// router returns `assignee: "leader"`. With every workspace on
// `mode: "hitl"` (the default), the router always returns `"user"`,
// so this code does not execute in production today.

import { randomUUID } from "node:crypto";

import { TaskMailboxRepository } from "../../repositories/task-mailbox-repository";
import { RoleRuntimeRepository } from "../../repositories/role-runtime-repository";
import { TaskRepository } from "../../repositories/task-repository";

export type LeaderReviewInboxPayload = {
  reviewId: string;
  taskId: string;
  workspaceId: string;
  addedLines: number;
  removedLines: number;
  changedFileCount: number;
  risk: string;
  routerReason: string;
};

const MAILBOX_SENDER = "system:change_review";

function buildMailboxContent(payload: LeaderReviewInboxPayload): string {
  // The message goes into task_mailbox.content (a text column the
  // leader loop ingests as a regular conversation turn). Frame it as
  // a system notice with explicit, machine-grep-able tags so the
  // leader prompt's "Images & attachments are auto-forwarded"
  // / "Handling teammate status responses" patterns can be extended
  // in 8.1b-2 to teach Leader about this signal.
  return [
    `<<change_review_assigned>>`,
    ``,
    `A change_review has been assigned to your inbox.`,
    ``,
    `  review_id:       ${payload.reviewId}`,
    `  changed_files:   ${payload.changedFileCount}`,
    `  added:           +${payload.addedLines}`,
    `  removed:         -${payload.removedLines}`,
    `  risk:            ${payload.risk}`,
    `  router_reason:   ${payload.routerReason}`,
    ``,
    `Next steps (tools available in your catalog):`,
    `  - read_change_review('${payload.reviewId}') to inspect the diff`,
    `  - apply_change_review(...) when reviewer verdict is high+APPROVE`,
    `  - reject_change_review(...) when verdict is REJECT`,
    `  - escalate_change_review_to_user(...) when in doubt or medium/low confidence`,
    ``,
    `Follow the routing rules in your system prompt's`,
    `"Handling change_reviews assigned to your inbox" section.`,
  ].join("\n");
}

/**
 * Write a mailbox row describing the review AND wake the task worker
 * if necessary.
 *
 * Safe to call from any code path. Errors are caught and logged
 * rather than re-thrown — the review row itself has already been
 * persisted in change-review-state-service, and a failed mailbox
 * delivery should not retroactively fail the gate's classification.
 * The worst case is a stuck-in-leader-inbox review the operator can
 * still flip to themselves manually via SQL.
 */
export async function notifyLeaderOfAssignedReview(
  payload: LeaderReviewInboxPayload,
): Promise<void> {
  const mailbox = new TaskMailboxRepository();
  const taskRepo = new TaskRepository();
  const runtimes = new RoleRuntimeRepository();

  // Step 1 — always write the mailbox row.
  try {
    await mailbox.create({
      id: `msg_review_${Date.now()}_${randomUUID().slice(0, 8)}`,
      taskId: payload.taskId,
      sender: MAILBOX_SENDER,
      content: buildMailboxContent(payload),
      createdAt: new Date(),
    });
  } catch (error) {
    console.error(
      "[leader-review-inbox-bridge] failed to write mailbox row for review",
      payload.reviewId,
      error,
    );
    return;
  }

  // Step 2 — wake the worker if it isn't already running this task.
  // Mirrors the goal-resume flow in routes/tasks.ts:740-748:
  //   pick the latest leader role_runtime for this task, enqueue a
  //   blank-prompt job. enqueue is idempotent — if the task is
  //   already queued or actively running, this is a no-op and the
  //   loop will see the mailbox row on its next turn naturally.
  try {
    const task = await taskRepo.getById(payload.taskId);
    if (!task) {
      console.warn(
        "[leader-review-inbox-bridge] task missing when waking worker for review",
        payload.reviewId,
        payload.taskId,
      );
      return;
    }
    const runtimeRows = await runtimes.listByTaskId(payload.taskId);
    const leaderRuntime = runtimeRows
      .filter((r) => r.roleId === "leader")
      .sort((a, b) => {
        const at = a.startedAt instanceof Date ? a.startedAt.getTime() : Number(a.startedAt ?? 0);
        const bt = b.startedAt instanceof Date ? b.startedAt.getTime() : Number(b.startedAt ?? 0);
        return bt - at;
      })[0];
    if (!leaderRuntime) {
      // No leader runtime ever ran on this task — strange but
      // possible if the review was created via a non-leader code
      // path. Bail; the mailbox row remains and a future leader
      // session can pick it up on first turn.
      return;
    }
    const { taskWorker } = await import("../task-worker");
    taskWorker.enqueue({
      taskId: payload.taskId,
      runId: leaderRuntime.id,
      requestId: `req_${randomUUID().slice(0, 12)}`,
      workspaceId: payload.workspaceId,
      prompt: "",
      ...(task.rootChannelBindingId ? { channelBindingId: task.rootChannelBindingId } : {}),
    });
  } catch (error) {
    console.error(
      "[leader-review-inbox-bridge] failed to wake worker for review",
      payload.reviewId,
      error,
    );
  }
}
