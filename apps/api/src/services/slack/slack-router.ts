import { areMagisterChannelsDisabled } from "../../integrations/feishu/feishu-config";
import { buildEnvelope, decodeEnvelope } from "../../integrations/feishu/card-envelope";
import { buildSlackClientIfConfigured } from "../../integrations/slack/slack-client";
import { parseSlackConfig } from "../../integrations/slack/slack-config";
import type { NormalizedSlackInteraction } from "../../integrations/slack/slack-event-normalizer";
import { ChannelSessionRepository } from "../../repositories/channel-session-repository";
import { ConversationBindingRepository } from "../../repositories/conversation-binding-repository";
import { ExecutionEventRepository } from "../../repositories/execution-event-repository";
import {
  getApproval as commandGetApproval,
  onApprovalCreated,
  type ApprovalRecord,
} from "../command-approval-service";
import {
  DIGEST_ACTION_DISMISSED_EVENT_TYPE,
  DIGEST_ACTION_TAKEN_EVENT_TYPE,
} from "../digest-service";

/**
 * Slack router — the Slack counterpart of feishu-router.ts, scoped to
 * approval control flow only (Slack v1 has no streaming session):
 *
 *   - Approval card outbound on `onApprovalCreated` (Block Kit message
 *     with Approve/Reject buttons carrying signed ocf1 envelopes)
 *   - block_actions callback (decode envelope → resolveApproval →
 *     chat.update the original message into a resolved-state notice)
 *
 * The envelope scheme (buildEnvelope/decodeEnvelope) is channel-
 * agnostic HMAC signing; Slack packs the envelope JSON directly into
 * the button `value` (Feishu wraps it as `{envelope: "<json>"}` due to
 * card v1 scalar-value limits — Slack has no such limit but we keep
 * the same JSON-string transport for symmetry).
 */

const APPROVAL_TTL_MINUTES_DEFAULT = 5;
const SECRET_FALLBACK = "magister-approval-secret-change-me";

/** Map approvalId → outbound delivery (for the resolved-state chat.update). */
const approvalCardIndex = new Map<
  string,
  { chatId: string; bindingId: string; messageTs: string; expiresAtMs: number }
>();

function getApprovalSecret(): string {
  const fromEnv =
    process.env.MAGISTER_SLACK_APPROVAL_SECRET?.trim()
    || process.env.MAGISTER_FEISHU_APPROVAL_SECRET?.trim();
  if (fromEnv) return fromEnv;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "MAGISTER_SLACK_APPROVAL_SECRET (or MAGISTER_FEISHU_APPROVAL_SECRET) must be set in production",
    );
  }
  return SECRET_FALLBACK;
}

function getApprovalTtlMinutes(): number {
  const raw = process.env.MAGISTER_SLACK_APPROVAL_TTL_MINUTES;
  if (!raw) return APPROVAL_TTL_MINUTES_DEFAULT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return APPROVAL_TTL_MINUTES_DEFAULT;
  return parsed;
}

async function resolveBindingForTask(
  taskId: string,
): Promise<{ bindingId: string; chatId: string } | null> {
  const sessionRepo = new ChannelSessionRepository();
  const session = await sessionRepo.findByCurrentTaskId(taskId);
  if (!session || session.channel !== "slack") return null;
  const bindingRepo = new ConversationBindingRepository();
  const binding = await bindingRepo.getById(session.bindingId);
  if (!binding || binding.channel !== "slack") return null;
  return { bindingId: binding.id, chatId: binding.chatId };
}

function describeApproval(approval: ApprovalRecord): string {
  const args = approval.toolArgs ?? {};
  const command =
    typeof args.command === "string"
      ? args.command
      : typeof args.input === "string"
        ? args.input
        : null;
  const lines = [`*Approval required:* \`${approval.toolName}\``];
  if (approval.summary) lines.push(approval.summary);
  if (command) lines.push(`\`\`\`${command.slice(0, 2000)}\`\`\``);
  lines.push(`Task \`…${approval.taskId.slice(-8)}\` · auto-approves in ${getApprovalTtlMinutes()} min`);
  return lines.join("\n");
}

function buildApprovalBlocks(input: {
  bodyMarkdown: string;
  approveValue: string;
  rejectValue: string;
}): unknown[] {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: input.bodyMarkdown },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: "magister_approval_approve",
          style: "primary",
          text: { type: "plain_text", text: "Approve" },
          value: input.approveValue,
        },
        {
          type: "button",
          action_id: "magister_approval_reject",
          style: "danger",
          text: { type: "plain_text", text: "Reject" },
          value: input.rejectValue,
        },
      ],
    },
  ];
}

function buildResolvedBlocks(input: {
  bodyMarkdown: string;
  state: string;
  resolvedBy: string;
}): unknown[] {
  const icon = input.state === "approved" ? "✅" : input.state === "rejected" ? "❌" : "⏰";
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: input.bodyMarkdown },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `${icon} *${input.state}* by <@${input.resolvedBy}>`,
        },
      ],
    },
  ];
}

// Entries normally clear on click-resolution, but timeout-resolved
// approvals never get a click — sweep those lazily so the index can't
// grow unbounded across long uptimes. Grace period keeps entries
// available for a late click's chat.update fallback.
const INDEX_SWEEP_GRACE_MS = 10 * 60_000;

function sweepExpiredCardIndexEntries(): void {
  const cutoff = Date.now() - INDEX_SWEEP_GRACE_MS;
  for (const [id, entry] of approvalCardIndex) {
    if (entry.expiresAtMs < cutoff) approvalCardIndex.delete(id);
  }
}

/** Wired as an `onApprovalCreated` hook in registerSlackRouter(). */
async function sendApprovalCard(approval: ApprovalRecord): Promise<void> {
  if (areMagisterChannelsDisabled()) return;
  sweepExpiredCardIndexEntries();
  const client = buildSlackClientIfConfigured(parseSlackConfig().botToken);
  if (!client) return;
  const target = await resolveBindingForTask(approval.taskId);
  if (!target) return;

  const expiresAtMs = Date.now() + getApprovalTtlMinutes() * 60_000;
  const secret = getApprovalSecret();
  const context = {
    s: approval.id,
    h: target.chatId,
    e: expiresAtMs,
    t: "group" as const,
  };
  const metadata = { taskId: approval.taskId, toolName: approval.toolName };

  const approveEnvelope = buildEnvelope({
    kind: "button",
    action: "approval.approve",
    context,
    metadata,
    secret,
  });
  const rejectEnvelope = buildEnvelope({
    kind: "button",
    action: "approval.reject",
    context,
    metadata,
    secret,
  });

  const bodyMarkdown = describeApproval(approval);
  try {
    const result = await client.postMessage({
      channel: target.chatId,
      text: `Approval required: ${approval.toolName}`,
      blocks: buildApprovalBlocks({
        bodyMarkdown,
        approveValue: JSON.stringify(approveEnvelope),
        rejectValue: JSON.stringify(rejectEnvelope),
      }),
    });
    approvalCardIndex.set(approval.id, {
      chatId: result.channel,
      bindingId: target.bindingId,
      messageTs: result.ts,
      expiresAtMs,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[slack-router] sendApprovalCard ${approval.id.slice(-8)} failed:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Handle a block_actions click forwarded by the Socket Mode gateway.
 * Decodes the signed envelope, resolves the approval, then replaces
 * the original message's buttons with a resolved-state footer.
 */
export async function handleSlackBlockAction(
  interaction: NormalizedSlackInteraction,
): Promise<void> {
  try {
    await handleSlackBlockActionInner(interaction);
  } catch (err) {
    // Slack already got its ack from the gateway — a throw here would
    // only kill the async handler. Log and move on.
    // eslint-disable-next-line no-console
    console.error(
      "[slack-router] handleSlackBlockAction unexpected error:",
      err instanceof Error ? err.message : err,
    );
  }
}

export interface DigestActionDependencies {
  eventRepository?: ExecutionEventRepository;
  /** Injectable for tests; defaults to processTaskIntent. */
  runIntent?: (input: {
    prompt: string;
    source: "web";
    workspaceId: string;
    createdBy: string;
  }) => Promise<{ taskId: string }>;
  /** Injectable for tests; `null` skips the ack reply. */
  slackClient?: ReturnType<typeof buildSlackClientIfConfigured>;
}

/**
 * Digest card button clicks (acted-on metric). Unlike approval buttons
 * these carry a plain `{actionText}` value, not a signed envelope —
 * clicking only records an event and (for "Do it") creates an ordinary
 * task, both benign in a single-operator workspace.
 */
export async function handleDigestAction(
  interaction: NormalizedSlackInteraction,
  dependencies: DigestActionDependencies = {},
): Promise<void> {
  const { event, messageTs } = interaction;
  const actionId = event.content.actionId;
  const eventRepo = dependencies.eventRepository ?? new ExecutionEventRepository();

  let actionText = "";
  const rawValue = interaction.actions[0]?.value;
  if (typeof rawValue === "string") {
    try {
      const parsed = JSON.parse(rawValue) as { actionText?: unknown };
      if (typeof parsed.actionText === "string") actionText = parsed.actionText;
    } catch {
      // eslint-disable-next-line no-console
      console.error(`[slack-router] digest action value is not valid JSON (action ${actionId})`);
    }
  }

  const taken = actionId === "digest_act";
  let spawnedTaskId: string | undefined;
  if (taken && actionText) {
    const runIntent =
      dependencies.runIntent ??
      (async (input: { prompt: string; source: "web"; workspaceId: string; createdBy: string }) => {
        const { processTaskIntent } = await import("../process-task-intent-service");
        return processTaskIntent(input);
      });
    let workspaceId = "workspace_main";
    try {
      const { WorkspaceRepository } = await import("../../repositories/workspace-repository");
      workspaceId = (await new WorkspaceRepository().getDefault())?.id ?? workspaceId;
    } catch {
      // fall through to the legacy literal (same posture as the scheduler)
    }
    try {
      const spawned = await runIntent({
        prompt: actionText,
        source: "web",
        workspaceId,
        createdBy: `digest:slack:${event.sender.platformUserId}`,
      });
      spawnedTaskId = spawned.taskId;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        "[slack-router] digest_act task intake failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  await eventRepo.create({
    id: `event_digest_${crypto.randomUUID()}`,
    type: taken ? DIGEST_ACTION_TAKEN_EVENT_TYPE : DIGEST_ACTION_DISMISSED_EVENT_TYPE,
    ...(spawnedTaskId ? { taskId: spawnedTaskId } : {}),
    severity: "info",
    occurredAt: new Date(),
    payloadJson: JSON.stringify({
      actionText,
      actorId: event.sender.platformUserId,
      ...(messageTs ? { messageTs } : {}),
    }),
  });

  // Ack in-thread instead of chat.update: the digest holds several
  // items/buttons and we no longer have its original blocks — an update
  // would wipe the whole card for one click.
  const client =
    dependencies.slackClient !== undefined
      ? dependencies.slackClient
      : buildSlackClientIfConfigured(parseSlackConfig().botToken);
  if (client && messageTs) {
    const ack = taken
      ? spawnedTaskId
        ? `✅ Scheduled as task \`…${spawnedTaskId.slice(-8)}\``
        : "⚠️ Couldn't schedule that action — check the API logs"
      : "Dismissed";
    try {
      await client.postMessage({ channel: event.chatId, text: ack, threadTs: messageTs });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        "[slack-router] digest ack reply failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }
}

async function handleSlackBlockActionInner(
  interaction: NormalizedSlackInteraction,
): Promise<void> {
  const { event, messageTs } = interaction;
  const actionId = event.content.actionId;
  if (actionId === "digest_act" || actionId === "digest_dismiss") {
    await handleDigestAction(interaction);
    return;
  }
  const envelopeString = (event.content.payload as Record<string, unknown> | undefined)?.envelope;
  if (typeof envelopeString !== "string") return;

  let envelopeCandidate: unknown;
  try {
    envelopeCandidate = JSON.parse(envelopeString);
  } catch {
    return;
  }

  const decoded = decodeEnvelope({
    value: envelopeCandidate,
    context: {
      secret: getApprovalSecret(),
      eventChatId: event.chatId,
      operatorOpenId: event.sender.platformUserId,
      // Single-operator Magister: don't bind clicks to a specific user.
      skipUserCheck: true,
    },
  });
  if (decoded.kind !== "structured") {
    // eslint-disable-next-line no-console
    console.warn(
      "[slack-router] block action envelope rejected:",
      decoded.kind === "invalid" ? decoded.reason : "legacy",
    );
    return;
  }

  const envelope = decoded.envelope;
  const approvalId = envelope.c?.s;
  if (!approvalId) return;
  const resolution: "approved" | "rejected" | null =
    envelope.a === "approval.approve"
      ? "approved"
      : envelope.a === "approval.reject"
        ? "rejected"
        : null;
  if (!resolution) return;

  const approval = await commandGetApproval(approvalId);
  if (!approval) return;

  const { resolveApproval } = await import("../approval-service");
  const resolved = await resolveApproval({
    approvalId,
    resolution,
    source: "slack",
    actorId: event.sender.platformUserId,
  });
  if (!resolved) return;

  // Replace the original card's buttons with the resolved state.
  const client = buildSlackClientIfConfigured(parseSlackConfig().botToken);
  const indexed = approvalCardIndex.get(approvalId);
  const updateTs = messageTs ?? indexed?.messageTs;
  if (client && updateTs) {
    try {
      await client.updateMessage({
        channel: indexed?.chatId ?? event.chatId,
        ts: updateTs,
        text: `Approval ${resolved.state}: ${approval.toolName}`,
        blocks: buildResolvedBlocks({
          bodyMarkdown: describeApproval(approval),
          state: resolved.state,
          resolvedBy: event.sender.platformUserId,
        }),
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[slack-router] resolved-card update ${approvalId.slice(-8)} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  approvalCardIndex.delete(approvalId);
}

/** Idempotent hook registration — mirrors registerFeishuRouter. */
let unregister: (() => void) | null = null;

export function registerSlackRouter(): void {
  if (unregister) {
    unregister();
    unregister = null;
  }
  if (areMagisterChannelsDisabled()) {
    approvalCardIndex.clear();
    return;
  }
  const unsubCreated = onApprovalCreated((rec) => {
    void sendApprovalCard(rec);
  });
  unregister = () => {
    unsubCreated();
  };
}

export function unregisterSlackRouter(): void {
  if (unregister) {
    unregister();
    unregister = null;
  }
  approvalCardIndex.clear();
}

/** Test helper. */
export function __resetSlackApprovalIndexForTests(): void {
  approvalCardIndex.clear();
}
