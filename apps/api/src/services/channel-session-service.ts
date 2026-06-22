import type { ChannelSessionSelect } from "@magister/db";

import { ChannelSessionRepository } from "../repositories/channel-session-repository";

export type ChannelSessionContinuityMode =
  | "reaction_only"
  | "reply_preferred"
  | "top_level_preferred"
  | "always_visible_ack";

// `"on"`/`"full"` are the legacy vocabulary used by the existing
// runtime-trace flow. `"low"`/`"high"` are the new vocabulary used
// by the feishu-streaming-projector (P2 of the web-parity spec).
// Both accepted — `normalizeVerbose` in the projector normalizes
// either form. `"on"` ≈ `"low"`, `"full"` ≈ `"high"`.
export type ChannelSessionVerboseLevel = "off" | "on" | "full" | "low" | "high";

type EnsureChannelSessionInput = {
  bindingId: string;
  channel: "feishu";
  workspaceId: string;
  continuityMode?: ChannelSessionContinuityMode;
  verboseLevel?: ChannelSessionVerboseLevel;
  currentTaskId?: string | null;
  latestInboundMessageId?: string | null;
  latestDeliveredMessageId?: string | null;
  latestAnswerSummary?: string | null;
};

const DEFAULT_CONTINUITY_MODE: ChannelSessionContinuityMode = "reply_preferred";
// Default to "high" so new channel sessions get streaming tool-call
// cards out of the box. Operators who don't want the noise can run
// `/verbose off` to turn it off per chat. "off" was the historical
// default but feishu UX is so much better with streaming that the
// trade-off flipped.
const DEFAULT_VERBOSE_LEVEL: ChannelSessionVerboseLevel = "high";

const RECOGNIZED_VERBOSE_LEVELS = new Set<ChannelSessionVerboseLevel>([
  "off",
  "on",
  "full",
  "low",
  "high",
]);

export class ChannelSessionService {
  private readonly repository = new ChannelSessionRepository();

  async getByBindingId(bindingId: string): Promise<ChannelSessionSelect | null> {
    return (await this.repository.getByBindingId(bindingId)) ?? null;
  }

  async ensureForBinding(input: EnsureChannelSessionInput): Promise<ChannelSessionSelect> {
    const existing = await this.repository.getByBindingId(input.bindingId);
    const now = new Date();

    if (!existing) {
      await this.repository.create({
        id: input.bindingId,
        bindingId: input.bindingId,
        channel: input.channel,
        workspaceId: input.workspaceId,
        continuityMode: input.continuityMode ?? DEFAULT_CONTINUITY_MODE,
        verboseLevel: input.verboseLevel ?? DEFAULT_VERBOSE_LEVEL,
        ...(input.currentTaskId !== undefined ? { currentTaskId: input.currentTaskId } : {}),
        ...(input.latestInboundMessageId !== undefined
          ? { latestInboundMessageId: input.latestInboundMessageId }
          : {}),
        ...(input.latestDeliveredMessageId !== undefined
          ? { latestDeliveredMessageId: input.latestDeliveredMessageId }
          : {}),
        ...(input.latestAnswerSummary !== undefined
          ? { latestAnswerSummary: input.latestAnswerSummary }
          : {}),
        createdAt: now,
        updatedAt: now,
      });
      const created = await this.repository.getByBindingId(input.bindingId);
      if (!created) {
        throw new Error(`Failed to create channel session: ${input.bindingId}`);
      }
      return created;
    }

    await this.repository.update(existing.id, {
      ...(input.verboseLevel !== undefined ? { verboseLevel: input.verboseLevel } : {}),
      ...(input.currentTaskId !== undefined ? { currentTaskId: input.currentTaskId } : {}),
      ...(input.latestInboundMessageId !== undefined
        ? { latestInboundMessageId: input.latestInboundMessageId }
        : {}),
      ...(input.latestDeliveredMessageId !== undefined
        ? { latestDeliveredMessageId: input.latestDeliveredMessageId }
        : {}),
      ...(input.latestAnswerSummary !== undefined
        ? { latestAnswerSummary: input.latestAnswerSummary }
        : {}),
      updatedAt: now,
    });

    const updated = await this.repository.getByBindingId(input.bindingId);
    if (!updated) {
      throw new Error(`Failed to update channel session: ${input.bindingId}`);
    }

    return updated;
  }

  /**
   * Return the channel's verbose level.
   *
   * Returns the channel's verbose level. Honors ANY recognized value
   * and only falls back to DEFAULT when the session is missing or
   * stores an unrecognized value.
   */
  resolveVerboseLevel(session: ChannelSessionSelect | null): ChannelSessionVerboseLevel {
    const stored = session?.verboseLevel as ChannelSessionVerboseLevel | undefined;
    if (stored && RECOGNIZED_VERBOSE_LEVELS.has(stored)) {
      return stored;
    }
    return DEFAULT_VERBOSE_LEVEL;
  }

  async updateVerboseLevel(
    bindingId: string,
    verboseLevel: ChannelSessionVerboseLevel,
  ): Promise<ChannelSessionSelect> {
    const session = await this.repository.getByBindingId(bindingId);
    if (!session) {
      throw new Error(`Cannot update verbose level for missing channel session: ${bindingId}`);
    }

    await this.repository.update(session.id, {
      verboseLevel,
      updatedAt: new Date(),
    });

    const updated = await this.repository.getByBindingId(bindingId);
    if (!updated) {
      throw new Error(`Failed to update channel session verbose level: ${bindingId}`);
    }

    return updated;
  }

  async recordInboundMessage(input: {
    bindingId: string;
    channel: "feishu";
    workspaceId: string;
    latestInboundMessageId: string;
    currentTaskId?: string | null;
  }) {
    return this.ensureForBinding({
      bindingId: input.bindingId,
      channel: input.channel,
      workspaceId: input.workspaceId,
      latestInboundMessageId: input.latestInboundMessageId,
      ...(input.currentTaskId !== undefined ? { currentTaskId: input.currentTaskId } : {}),
    });
  }

  async recordTaskLink(input: {
    bindingId: string;
    channel: "feishu";
    workspaceId: string;
    currentTaskId: string;
  }) {
    return this.ensureForBinding({
      bindingId: input.bindingId,
      channel: input.channel,
      workspaceId: input.workspaceId,
      currentTaskId: input.currentTaskId,
    });
  }

  async recordOutboundDelivery(input: {
    bindingId: string;
    channel: "feishu";
    workspaceId: string;
    latestDeliveredMessageId: string;
    latestAnswerSummary?: string | null;
  }) {
    return this.ensureForBinding({
      bindingId: input.bindingId,
      channel: input.channel,
      workspaceId: input.workspaceId,
      latestDeliveredMessageId: input.latestDeliveredMessageId,
      ...(input.latestAnswerSummary !== undefined
        ? { latestAnswerSummary: input.latestAnswerSummary }
        : {}),
    });
  }

  async recordLeaderSession(input: {
    bindingId: string;
    currentLeaderSessionId: string;
    currentTaskId: string;
  }) {
    const session = await this.repository.getByBindingId(input.bindingId);
    if (!session) {
      throw new Error(`Cannot record leader session for missing channel session: ${input.bindingId}`);
    }
    await this.repository.update(session.id, {
      currentLeaderSessionId: input.currentLeaderSessionId,
      currentTaskId: input.currentTaskId,
      updatedAt: new Date(),
    });
  }

  async getActiveLeaderSession(bindingId: string): Promise<{
    sessionId: string;
    taskId: string;
  } | null> {
    const session = await this.repository.getByBindingId(bindingId);
    if (!session?.currentLeaderSessionId || !session?.currentTaskId) {
      return null;
    }
    return {
      sessionId: session.currentLeaderSessionId,
      taskId: session.currentTaskId,
    };
  }

  resolveDeliveryMode(input: {
    session: ChannelSessionSelect | null;
    kind: string;
    hasReplyToMessageId: boolean;
  }): ChannelSessionContinuityMode {
    const continuityMode = input.session?.continuityMode ?? DEFAULT_CONTINUITY_MODE;

    if (input.kind === "task_created") {
      return continuityMode === "always_visible_ack"
        ? "always_visible_ack"
        : input.hasReplyToMessageId
          ? "reaction_only"
          : "top_level_preferred";
    }

    if (continuityMode === "always_visible_ack" || continuityMode === "top_level_preferred") {
      return "top_level_preferred";
    }

    return input.hasReplyToMessageId ? "reply_preferred" : "top_level_preferred";
  }
}
