import { LocalObservabilityAdapter } from "../observability/local-observability-adapter";
import { stripBotMention, type InboundChannelEvent } from "../integrations/feishu/feishu-event-normalizer";
import { createFeishuClient } from "../integrations/feishu/feishu-client";
import { parseFeishuConfigFromEnv } from "../integrations/feishu/feishu-config";
import { getMagisterEnv } from "../lib/env";
import { ChannelInboundEventDedupeRepository } from "../repositories/channel-inbound-event-dedupe-repository";
import { ConversationBindingRepository } from "../repositories/conversation-binding-repository";
import { WorkspaceRepository } from "../repositories/workspace-repository";
import { processTaskIntent } from "./process-task-intent-service";
import {
  ChannelSessionService,
  type ChannelSessionVerboseLevel,
} from "./channel-session-service";
import { resolveFeishuApprovalCallback } from "./feishu-approval-callback-service";
import { deliverLeaderAnswerToFeishu } from "./deliver-feishu-reply-service";

type ChannelBindingStatus = "created" | "resolved" | "duplicate";

type ChannelBindingAcceptance = {
  id: string;
  channel: "feishu";
  accountId: string;
  chatId: string;
  workspaceId: string;
  status: ChannelBindingStatus;
};

type ChannelIntakeAcceptance =
  | {
      action: "task_created" | "task_resumed";
      taskId: string;
      latestRunId: string;
      /** Per-prompt requestId — used by the notification-card gate to
       *  check whether THIS turn's streaming card was delivered (vs the
       *  taskId-level check which could mis-suppress on resume). */
      requestId: string;
      taskState: string;
      latestExecutorId?: string | null;
      latestRunState?: string;
      workspaceId: string;
      source: "feishu";
      title: string;
      finalAnswer?: string;
    }
  | {
      action: "approval_resolved";
      approvalId: string;
      taskId: string;
      bindingId: string;
      state: string;
      /**
       * Optional card-update payload to return as the WS handler's
       * response. Feishu replaces the visible card in-place when the
       * card.action.trigger handler returns `{ card: {...} }`. Used
       * to flip the Approve/Reject buttons into a resolved-state
       * footer ("Approved by X · 14:32:18") without an extra API
       * round-trip.
       */
      cardResponse?: object;
    }
  | {
      action: "ignored";
      reason:
        | "unsupported_event_type"
        | "empty_message_text"
        | "invalid_card_action"
        | "duplicate_event"
        | "control_command"
        | "no_bot_mention";
      errorCode?: string;
    };

type FeishuVerboseCommand =
  | {
      kind: "status";
    }
  | {
      kind: "set";
      verboseLevel: ChannelSessionVerboseLevel;
    };

function resolveDefaultWorkspaceId() {
  const configured = process.env.MAGISTER_DEFAULT_WORKSPACE_ID?.trim();
  return configured && configured.length > 0 ? configured : "workspace_main";
}

function buildConversationBindingId(event: InboundChannelEvent) {
  const base = `${event.channel}:${event.accountId}:${event.chatId}`;
  return event.threadId ? `${base}:${event.threadId}` : base;
}

function buildInboundDedupeKeys(event: InboundChannelEvent) {
  const keys = [
    event.eventId ? `event:${event.eventId}` : null,
    event.platformMessageId ? `platform:${event.platformMessageId}` : null,
  ].filter((value): value is string => Boolean(value));

  return [...new Set(keys)];
}

function parseFeishuVerboseCommand(text?: string | null): FeishuVerboseCommand | null {
  const normalized = text?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "/verbose") return { kind: "status" };
  // Both vocabularies accepted (`on/full` legacy, `low/high` new).
  // `low ≡ on`, `high ≡ full`. Either form writes a canonical value
  // to the DB based on the user's choice — `resolveVerboseLevel`
  // honors both vocabularies on read.
  if (normalized === "/verbose on" || normalized === "/verbose low") {
    return { kind: "set", verboseLevel: "on" };
  }
  if (normalized === "/verbose full" || normalized === "/verbose high") {
    return { kind: "set", verboseLevel: "full" };
  }
  if (normalized === "/verbose off") {
    return { kind: "set", verboseLevel: "off" };
  }
  return null;
}

function buildVerboseCommandReply(input: {
  command: FeishuVerboseCommand;
  currentVerboseLevel: ChannelSessionVerboseLevel;
}) {
  if (input.command.kind === "status") {
    return `当前 Verbose 状态：${input.currentVerboseLevel}`;
  }

  return `Verbose 已切换为 ${input.command.verboseLevel}`;
}

// Exported for unit tests (self-heal of a dangling binding workspace).
export async function resolveConversationBinding(
  normalizedEvent: InboundChannelEvent,
  repository: ConversationBindingRepository,
): Promise<ChannelBindingAcceptance> {
  const now = new Date();
  const workspaceId = resolveDefaultWorkspaceId();
  const bindingId = buildConversationBindingId(normalizedEvent);
  const existing = await repository.getById(bindingId);

  if (!existing) {
    await repository.create({
      id: bindingId,
      channel: normalizedEvent.channel,
      accountId: normalizedEvent.accountId,
      chatId: normalizedEvent.chatId,
      ...(normalizedEvent.threadId ? { threadId: normalizedEvent.threadId } : {}),
      workspaceId,
      createdAt: now,
      updatedAt: now,
      lastInboundAt: new Date(normalizedEvent.occurredAt),
      ...(normalizedEvent.eventId ? { lastEventId: normalizedEvent.eventId } : {}),
      ...(normalizedEvent.platformMessageId
        ? { lastPlatformMessageId: normalizedEvent.platformMessageId }
        : {}),
      lastSenderUserId: normalizedEvent.sender.platformUserId,
      ...(normalizedEvent.sender.displayName
        ? { lastSenderDisplayName: normalizedEvent.sender.displayName }
        : {}),
    });

    return {
      id: bindingId,
      channel: normalizedEvent.channel,
      accountId: normalizedEvent.accountId,
      chatId: normalizedEvent.chatId,
      workspaceId,
      status: "created",
    };
  }

  if (normalizedEvent.eventId && existing.lastEventId === normalizedEvent.eventId) {
    return {
      id: bindingId,
      channel: normalizedEvent.channel,
      accountId: normalizedEvent.accountId,
      chatId: normalizedEvent.chatId,
      workspaceId: existing.workspaceId,
      status: "duplicate",
    };
  }

  if (
    normalizedEvent.platformMessageId &&
    existing.lastPlatformMessageId &&
    normalizedEvent.platformMessageId === existing.lastPlatformMessageId
  ) {
    return {
      id: bindingId,
      channel: normalizedEvent.channel,
      accountId: normalizedEvent.accountId,
      chatId: normalizedEvent.chatId,
      workspaceId: existing.workspaceId,
      status: "duplicate",
    };
  }

  await repository.update(bindingId, {
    updatedAt: now,
    lastInboundAt: new Date(normalizedEvent.occurredAt),
    ...(normalizedEvent.eventId ? { lastEventId: normalizedEvent.eventId } : {}),
    ...(normalizedEvent.platformMessageId
      ? { lastPlatformMessageId: normalizedEvent.platformMessageId }
      : {}),
    lastSenderUserId: normalizedEvent.sender.platformUserId,
    ...(normalizedEvent.sender.displayName
      ? { lastSenderDisplayName: normalizedEvent.sender.displayName }
      : {}),
  });

  // Self-heal a dangling binding: if the bound workspace was deleted out
  // from under this conversation, re-point it to the default before the
  // caller creates a task. Without this, the task would carry a workspaceId
  // that no longer exists and the web picker stays stuck on "Loading…".
  // (Defense-in-depth — workspace delete already re-points bindings, but
  // this also heals any binding orphaned before that cascade existed.)
  let resolvedWorkspaceId = existing.workspaceId;
  const workspaceRepository = new WorkspaceRepository();
  if (!(await workspaceRepository.getById(existing.workspaceId))) {
    const fallbackId =
      (await workspaceRepository.getDefault())?.id ?? resolveDefaultWorkspaceId();
    await repository.setWorkspace(bindingId, fallbackId, now);
    resolvedWorkspaceId = fallbackId;
  }

  return {
    id: bindingId,
    channel: normalizedEvent.channel,
    accountId: normalizedEvent.accountId,
    chatId: normalizedEvent.chatId,
    workspaceId: resolvedWorkspaceId,
    status: "resolved",
  };
}

async function recordFeishuCommandReply(input: {
  observabilityAdapter: LocalObservabilityAdapter;
  channelSessionService: ChannelSessionService;
  feishuClient: ReturnType<typeof createFeishuClient>;
  normalizedEvent: InboundChannelEvent;
  bindingId: string;
  workspaceId: string;
  text: string;
}) {
  if (input.normalizedEvent.channel !== "feishu") {
    return;
  }

  const client = input.feishuClient;
  const occurredAt = new Date();

  try {
    const result = input.normalizedEvent.platformMessageId
      ? await client.replyTextMessage({
          messageId: input.normalizedEvent.platformMessageId,
          text: input.text,
        })
      : await client.sendTextMessage({
          chatId: input.normalizedEvent.chatId,
          text: input.text,
        });

    await input.channelSessionService.recordOutboundDelivery({
      bindingId: input.bindingId,
      channel: "feishu",
      workspaceId: input.workspaceId,
      latestDeliveredMessageId: result.messageId,
      latestAnswerSummary: input.text,
    });

    await input.observabilityAdapter.recordEvent({
      id: `event_${crypto.randomUUID()}`,
      type: "channel.outbound.delivered",
      conversationBindingId: input.bindingId,
      workspaceId: input.workspaceId,
      severity: "info",
      occurredAt,
      payloadJson: JSON.stringify({
        channel: "feishu",
        kind: "control_command_reply",
        bindingId: input.bindingId,
        title: input.text,
        providerMessageId: result.messageId,
      }),
    });
  } catch (error) {
    await input.observabilityAdapter.recordEvent({
      id: `event_${crypto.randomUUID()}`,
      type: "channel.outbound.failed",
      conversationBindingId: input.bindingId,
      workspaceId: input.workspaceId,
      severity: "warn",
      occurredAt,
      payloadJson: JSON.stringify({
        channel: "feishu",
        bindingId: input.bindingId,
        code: "control_command_reply_failed",
        message:
          error instanceof Error ? error.message : "Feishu control command reply failed",
        title: input.text,
      }),
    });
  }
}

async function intakeChannelEventAsTask(
  normalizedEvent: InboundChannelEvent,
  binding: ChannelBindingAcceptance,
  overrideText?: string,
): Promise<ChannelIntakeAcceptance> {
  if (normalizedEvent.eventType === "card_action") {
    const payload = normalizedEvent.content.payload ?? {};

    // Versioned envelope path (ocf1) — delegate to the feishu-router
    // which owns all approval card lifecycle including the
    // replacement-card response.
    const hasVersionedEnvelope =
      typeof (payload as Record<string, unknown>).envelope === "string"
        || (payload as Record<string, unknown>).oc === "ocf1";
    if (hasVersionedEnvelope) {
      const { handleCardActionEvent } = await import("./feishu/feishu-router");
      const result = await handleCardActionEvent({
        payload: payload as Record<string, unknown>,
        chatId: binding.chatId,
        ...(normalizedEvent.sender.platformUserId
          ? { operatorOpenId: normalizedEvent.sender.platformUserId }
          : {}),
        binding: { id: binding.id, channel: binding.channel },
      });
      if (!result.ok) {
        return {
          action: "ignored",
          reason: "invalid_card_action",
          ...(result.errorCode ? { errorCode: result.errorCode } : {}),
        };
      }
      // The router surfaces the real approvalId/taskId/state from the
      // resolved approval row, so observability logs + downstream
      // consumers see real ids (no synthetic `router-handled`
      // placeholders polluting payloadJson blobs).
      return {
        action: "approval_resolved",
        approvalId: result.approvalId ?? "unknown",
        taskId: result.taskId ?? "unknown",
        bindingId: binding.id,
        state: result.state ?? "approved",
        ...(result.cardResponse ? { cardResponse: result.cardResponse } : {}),
      };
    }

    // Legacy path (pre-versioned envelope cards) — left in place for
    // any in-flight cards that were sent before the upgrade. Can be
    // dropped once we're confident no old cards are still clickable.
    const approvalId = typeof payload.approvalId === "string" ? payload.approvalId : undefined;
    const bindingId = typeof payload.bindingId === "string" ? payload.bindingId : undefined;
    const resolution =
      payload.resolution === "approved" || payload.resolution === "rejected"
        ? payload.resolution
        : undefined;
    const expiresAt = typeof payload.expiresAt === "string" ? payload.expiresAt : undefined;
    const signedToken = typeof payload.signedToken === "string" ? payload.signedToken : undefined;

    if (!approvalId || !bindingId || !resolution || !expiresAt || !signedToken) {
      return {
        action: "ignored",
        reason: "invalid_card_action",
        errorCode: "missing_callback_fields",
      };
    }

    const resolutionResult = await resolveFeishuApprovalCallback({
      approvalId,
      bindingId,
      resolution,
      expiresAt,
      signedToken,
      actorId: normalizedEvent.sender.platformUserId,
    });

    if (!resolutionResult.ok) {
      return {
        action: "ignored",
        reason: "invalid_card_action",
        errorCode: resolutionResult.code,
      };
    }

    return {
      action: "approval_resolved",
      approvalId: resolutionResult.approval.id,
      taskId: resolutionResult.taskId,
      bindingId: resolutionResult.bindingId,
      state: resolutionResult.approval.state,
    };
  }

  if (normalizedEvent.eventType !== "message") {
    return {
      action: "ignored",
      reason: "unsupported_event_type",
    };
  }

  const text = (overrideText ?? normalizedEvent.content.text)?.trim();
  if (!text) {
    return {
      action: "ignored",
      reason: "empty_message_text",
    };
  }

  // Slash commands (/ws, /verbose, /help) intercept BEFORE task
  // creation. The handler sends its own reply card; returning
  // `task_resumed: false` here keeps the dedup table consistent.
  if (text.startsWith("/")) {
    const { tryHandleSlashCommand } = await import("./feishu-channel-command-service");
    const slashResult = await tryHandleSlashCommand({
      text,
      binding: {
        id: binding.id,
        workspaceId: binding.workspaceId,
        chatId: binding.chatId,
      },
    });
    if (slashResult.handled) {
      return {
        action: "ignored",
        reason: "unsupported_event_type", // re-uses the existing reason taxonomy; signals "we handled it ourselves, no task created"
      };
    }
  }

  // No ack/typing indicator here — the single-card streaming session
  // (eager-created inside processTaskIntent) is the sole, immediate
  // outbound acknowledgement.

  const result = await processTaskIntent({
    prompt: text,
    source: "feishu",
    workspaceId: binding.workspaceId,
    channelBindingId: binding.id,
    rootChannelBindingId: binding.id,
    createdBy: normalizedEvent.sender.platformUserId,
  });

  return {
    action: result.action === "resumed_session" ? "task_resumed" : "task_created",
    taskId: result.taskId,
    latestRunId: result.runId,
    requestId: result.requestId,
    taskState: result.status === "completed" ? "COMPLETED" : "EXECUTING",
    latestExecutorId: null,
    latestRunState: result.status === "completed" ? "COMPLETED" : "RUNNING",
    workspaceId: binding.workspaceId,
    source: "feishu",
    title: text,
    ...(result.finalAnswer !== undefined ? { finalAnswer: result.finalAnswer } : {}),
  };
}

export async function processChannelEvent(normalizedEvent: InboundChannelEvent) {
  // Diagnostic log: every inbound event entry. Useful when debugging
  // card.action.trigger silent-drop bugs — events arrive at the
  // gateway but never reach the card_action branch. Gated by env so
  // production stdout isn't flooded.
  if (getMagisterEnv("MAGISTER_FEISHU_DEBUG") === "1") {
    // eslint-disable-next-line no-console
    console.log(
      "[process-channel] entry:",
      JSON.stringify({
        eventType: normalizedEvent.eventType,
        eventId: normalizedEvent.eventId,
        chatId: normalizedEvent.chatId,
        accountId: normalizedEvent.accountId,
        hasContent: !!normalizedEvent.content,
        contentKeys: normalizedEvent.content ? Object.keys(normalizedEvent.content) : [],
      }),
    );
  }
  const observabilityAdapter = new LocalObservabilityAdapter();
  const inboundDedupeRepository = new ChannelInboundEventDedupeRepository();
  const conversationBindingRepository = new ConversationBindingRepository();
  const channelSessionService = new ChannelSessionService();

  // Hoist Feishu config and client so they are created once and reused
  const feishuConfig = parseFeishuConfigFromEnv();
  const feishuClient =
    feishuConfig.appId && feishuConfig.appSecret
      ? createFeishuClient({ appId: feishuConfig.appId, appSecret: feishuConfig.appSecret })
      : null;

  const bindingId = buildConversationBindingId(normalizedEvent);
  const inboundDedupeKeys = buildInboundDedupeKeys(normalizedEvent);
  const occurredAt = new Date(normalizedEvent.occurredAt);
  let claimedInboundKeys = false;

  if (inboundDedupeKeys.length > 0) {
    const claim = await inboundDedupeRepository.claimProcessingKeys({
      bindingId,
      dedupeKeys: inboundDedupeKeys,
      occurredAt,
    });

    if (!claim.acquired) {
      const existingBinding = await conversationBindingRepository.getById(bindingId);
      const workspaceId = existingBinding?.workspaceId ?? resolveDefaultWorkspaceId();
      return {
        accepted: true as const,
        binding: {
          id: bindingId,
          channel: normalizedEvent.channel,
          accountId: normalizedEvent.accountId,
          chatId: normalizedEvent.chatId,
          workspaceId,
          status: "duplicate" as const,
        },
        intake: {
          action: "ignored" as const,
          reason: "duplicate_event" as const,
        },
        normalizedEvent,
        recordedEventId: undefined,
      };
    }

    claimedInboundKeys = true;
  }

  try {
    const binding = await resolveConversationBinding(
      normalizedEvent,
      conversationBindingRepository,
    );
    if (binding.status === "duplicate") {
      if (claimedInboundKeys) {
        await inboundDedupeRepository.markProcessingKeysCompleted({
          bindingId,
          dedupeKeys: inboundDedupeKeys,
          occurredAt,
        });
      }
      return {
        accepted: true as const,
        binding,
        intake: {
          action: "ignored" as const,
          reason: "duplicate_event" as const,
        },
        normalizedEvent,
        recordedEventId: undefined,
      };
    }

    // In group chats, ignore messages that don't @mention the bot.
    // Feishu WebSocket mode typically only delivers events where the bot is
    // mentioned, so we treat any mention in a group message as sufficient.
    // We also strip the bot mention placeholder from the prompt text.
    if (normalizedEvent.chatType === "group" && normalizedEvent.eventType === "message") {
      if (!normalizedEvent.mentions || normalizedEvent.mentions.length === 0) {
        if (claimedInboundKeys) {
          await inboundDedupeRepository.markProcessingKeysCompleted({
            bindingId,
            dedupeKeys: inboundDedupeKeys,
            occurredAt,
          });
        }
        return {
          accepted: true as const,
          binding,
          intake: {
            action: "ignored" as const,
            reason: "no_bot_mention" as const,
          },
          normalizedEvent,
          recordedEventId: undefined,
        };
      }
      // Strip the @mention placeholder tokens from message text (without mutating normalizedEvent)
    }

    const strippedText =
      normalizedEvent.chatType === "group" && normalizedEvent.eventType === "message" && normalizedEvent.mentions
        ? stripBotMention(normalizedEvent.content.text, normalizedEvent.mentions)
        : normalizedEvent.content.text;

    const inboundMessageText =
      normalizedEvent.eventType === "message" ? strippedText?.trim() : undefined;
    if (normalizedEvent.platformMessageId) {
      await channelSessionService.recordInboundMessage({
        bindingId: binding.id,
        channel: "feishu",
        workspaceId: binding.workspaceId,
        latestInboundMessageId: normalizedEvent.platformMessageId,
      });
    }
    const verboseCommand = parseFeishuVerboseCommand(inboundMessageText);
    if (verboseCommand) {
      const currentSession = await channelSessionService.getByBindingId(binding.id);
      const currentVerboseLevel = channelSessionService.resolveVerboseLevel(currentSession);
      const nextVerboseLevel =
        verboseCommand.kind === "set" ? verboseCommand.verboseLevel : currentVerboseLevel;

      if (verboseCommand.kind === "set") {
        await channelSessionService.updateVerboseLevel(binding.id, verboseCommand.verboseLevel);
      }

      if (feishuClient) {
        await recordFeishuCommandReply({
          observabilityAdapter,
          channelSessionService,
          feishuClient,
          normalizedEvent,
          bindingId: binding.id,
          workspaceId: binding.workspaceId,
          text: buildVerboseCommandReply({
            command: verboseCommand,
            currentVerboseLevel: nextVerboseLevel,
          }),
        });
      }

      const eventId = `event_${crypto.randomUUID()}`;
      const intake = {
        action: "ignored" as const,
        reason: "control_command" as const,
      };

      await observabilityAdapter.recordEvent({
        id: eventId,
        type: "channel.inbound.received",
        conversationBindingId: binding.id,
        workspaceId: binding.workspaceId,
        severity: "info",
        occurredAt,
        payloadJson: JSON.stringify({
          normalizedEvent,
          binding,
          intake,
        }),
      });

      if (claimedInboundKeys) {
        await inboundDedupeRepository.markProcessingKeysCompleted({
          bindingId,
          dedupeKeys: inboundDedupeKeys,
          occurredAt,
        });
      }

      return {
        accepted: true as const,
        binding,
        intake,
        normalizedEvent,
        recordedEventId: eventId,
      };
    }
    // No separate "已收到 / 正在处理" ack here. The single-card streaming
    // session (started inside processTaskIntent) eager-creates a
    // "⏳ Thinking…" card as the sole, immediate acknowledgement, which
    // then streams in place (Task 8 / S9). The old text-ack + OnIt
    // reaction produced a second, redundant message per turn.
    {
      const intake = await intakeChannelEventAsTask(normalizedEvent, binding, strippedText ?? undefined);
      const eventId = `event_${crypto.randomUUID()}`;

      if (intake.action === "task_created" || intake.action === "task_resumed") {
        await channelSessionService.recordTaskLink({
          bindingId: binding.id,
          channel: "feishu",
          workspaceId: binding.workspaceId,
          currentTaskId: intake.taskId,
        });

        // For queued tasks, processTaskExecution delivers when work completes.
        if (intake.taskState === "COMPLETED" && intake.finalAnswer) {
          // Skip the notification card ONLY when a streaming session
          // actually ran for this task — the streaming card already
          // carries the full answer. If verbose=high but no streaming
          // session was ever started (sync path bypassed setup, or the
          // streaming start failed), fall back to the notification so
          // the user isn't left empty-handed.
          // Codex re-review P2 — the delivery gate must be consulted
          // REGARDLESS of the current verbose level. If verbose was
          // toggled to "off" mid-turn AFTER a card was already delivered,
          // gating this behind `liveVerbose !== "off"` would skip the
          // check and fire a plain-text fallback despite the delivered
          // card → double-delivery. The gate is moved OUTSIDE the verbose
          // guard. (No session → awaitCardDecision resolves immediately
          // and hasDeliveredCardFor is false, so the no-session path is
          // unchanged.)
          const { feishuChatSessionRegistry } = await import("./feishu/feishu-chat-session");
          // Codex P0: the streaming session's eager createCard +
          // sendCardRef may still be IN FLIGHT (taskEventBus.publish
          // doesn't await async listeners). Await the card-creation
          // DECISION first so the hasDeliveredCardFor() read is
          // authoritative and we don't double-deliver (card + text).
          await feishuChatSessionRegistry.awaitCardDecision(intake.requestId);
          // Match by per-request id, NOT taskId — resume turns share
          // taskId but each turn has its own card-delivery decision.
          const streamingStarted = feishuChatSessionRegistry.hasDeliveredCardFor(intake.requestId);
          if (!streamingStarted) {
            await deliverLeaderAnswerToFeishu({
              bindingId: binding.id,
              workspaceId: binding.workspaceId,
              taskId: intake.taskId,
              answer: intake.finalAnswer,
              chatId: normalizedEvent.chatId,
              ...(normalizedEvent.platformMessageId
                ? { replyToMessageId: normalizedEvent.platformMessageId }
                : {}),
            });
          }
        }
      }

      await observabilityAdapter.recordEvent({
        id: eventId,
        type: "channel.inbound.received",
        ...(intake.action === "task_created" || intake.action === "task_resumed" ? { taskId: intake.taskId } : {}),
        conversationBindingId: binding.id,
        workspaceId: binding.workspaceId,
        severity: "info",
        occurredAt,
        payloadJson: JSON.stringify({
          normalizedEvent,
          binding,
          intake,
        }),
      });

      if (claimedInboundKeys) {
        await inboundDedupeRepository.markProcessingKeysCompleted({
          bindingId,
          dedupeKeys: inboundDedupeKeys,
          occurredAt,
        });
      }

      return {
        accepted: true as const,
        binding,
        intake,
        normalizedEvent,
        recordedEventId: eventId,
      };
    }
  } catch (error) {
    if (claimedInboundKeys) {
      await inboundDedupeRepository.releaseProcessingKeys({
        bindingId,
        dedupeKeys: inboundDedupeKeys,
        occurredAt,
      });
    }
    throw error;
  }
}
