import type { LeaderMessage } from "./manager-automation/autonomous-loop/autonomous-types";
import type { DoomLoopSnapshot } from "./manager-automation/autonomous-loop/doom-loop-detector";
import type { ExecutionPolicy } from "./leader-execution-policy-service";
import { ExecutionEventRepository } from "../repositories/execution-event-repository";

type CheckpointData = {
  sessionId: string;
  taskId: string;
  runId: string;
  /**
   * The requestId of the user prompt this checkpoint is in the middle of
   * processing. Persisted so crash recovery can resume the leader run with
   * the same request scope — without it, recovered events would be stamped
   * with a fresh (or wrongly synthesized) requestId and split the original
   * turn across two scopes.
   */
  requestId: string;
  turnCount: number;
  messages: LeaderMessage[];
  /** Persist the active execution policy so escalation counters survive resume. */
  executionPolicy?: ExecutionPolicy;
  /** Persist the doom-loop window snapshot so the detector state survives resume. */
  doomState?: DoomLoopSnapshot;
  /**
   * True when this checkpoint was written on the loop's TERMINAL turn (the
   * final answer was produced and the run is about to return "completed").
   * Recovery uses this to distinguish a run that finished but crashed before
   * its terminal task/runtime/event write (→ finalize as DONE) from one that
   * was genuinely mid-flight (→ resume). Without it, recovery would re-enter
   * the model on an already-completed conversation.
   */
  terminal?: boolean;
};

type RestoredCheckpoint = {
  sessionId: string;
  requestId: string | null;
  turnCount: number;
  messages: LeaderMessage[];
  executionPolicy?: ExecutionPolicy;
  doomState?: DoomLoopSnapshot;
  terminal?: boolean;
};

const MAX_CHECKPOINTS_PER_SESSION = 2;

export class LeaderSessionStore {
  private readonly eventRepository = new ExecutionEventRepository();

  async writeCheckpoint(data: CheckpointData): Promise<void> {
    await this.eventRepository.create({
      id: `leader_checkpoint_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: "leader.session_checkpoint",
      taskId: data.taskId,
      roleRuntimeId: data.runId,
      requestId: data.requestId,
      occurredAt: new Date(),
      payloadJson: JSON.stringify({
        sessionId: data.sessionId,
        requestId: data.requestId,
        turnCount: data.turnCount,
        messages: data.messages,
        ...(data.executionPolicy !== undefined ? { executionPolicy: data.executionPolicy } : {}),
        ...(data.doomState !== undefined ? { doomState: data.doomState } : {}),
        ...(data.terminal ? { terminal: true } : {}),
      }),
    });

    await this.eventRepository.deleteOlderCheckpoints(
      data.runId,
      MAX_CHECKPOINTS_PER_SESSION,
    );
  }

  async getLatestCheckpoint(runId: string): Promise<RestoredCheckpoint | null> {
    const event = await this.eventRepository.getLatestCheckpointByRunId(runId);
    if (!event?.payloadJson) return null;

    const payload = JSON.parse(event.payloadJson) as {
      sessionId: string;
      requestId?: string;
      turnCount: number;
      messages: LeaderMessage[];
      executionPolicy?: ExecutionPolicy;
      doomState?: DoomLoopSnapshot;
      terminal?: boolean;
    };

    // Prefer the requestId stored in the payload; fall back to the column
    // for events written before this field existed. Returning null here
    // only happens for legacy checkpoints — the resume code path treats
    // null as "synthesize a fresh requestId on resume" (last-resort
    // backward-compat behavior).
    const requestId = payload.requestId ?? event.requestId ?? null;

    return {
      sessionId: payload.sessionId,
      requestId,
      turnCount: payload.turnCount,
      messages: payload.messages,
      ...(payload.executionPolicy !== undefined ? { executionPolicy: payload.executionPolicy } : {}),
      ...(payload.doomState !== undefined ? { doomState: payload.doomState } : {}),
      ...(payload.terminal ? { terminal: true } : {}),
    };
  }

  /**
   * A session is resumable as long as a checkpoint exists.
   * No TTL — users can resume conversations hours or days later.
   */
  async isSessionActive(runId: string, _lastInteractionAt?: Date): Promise<boolean> {
    const event = await this.eventRepository.getLatestCheckpointByRunId(runId);
    return event !== null;
  }
}
