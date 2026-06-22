import {
  areMagisterChannelsDisabled,
} from "../../integrations/feishu/feishu-config";
import {
  buildApprovalBodyMarkdown,
  buildApprovalCard,
  buildApprovalResolvedCard,
  buildCallbackResponse,
} from "../../integrations/feishu/feishu-cards";
import {
  buildEnvelope,
  decodeEnvelope,
} from "../../integrations/feishu/card-envelope";
import {
  enqueue,
  feishuChatKey,
} from "../../integrations/feishu/sequential-queue";
import { ApprovalRepository } from "../../repositories/approval-repository";
import { ChannelSessionRepository } from "../../repositories/channel-session-repository";
import { ConversationBindingRepository } from "../../repositories/conversation-binding-repository";
import {
  getApproval as commandGetApproval,
  onApprovalCreated,
  type ApprovalRecord,
} from "../command-approval-service";
import {
  buildFeishuClientIfConfigured,
} from "./feishu-chat-session";

/**
 * Feishu router — single entry point for all Feishu-specific message
 * dispatch beyond raw WS plumbing. Owns:
 *
 *   - Approval card outbound on `createApproval` hook (sends card +
 *     remembers messageId so resolve hook can replace it later)
 *   - card.action.trigger handler (decodes envelope, resolves
 *     approval, builds replacement card)
 *   - Slash command dispatch (/stop, /ws, /verbose, /new, /help)
 *
 * Replaces the scattered logic that used to live in:
 *   - feishu-approval-outbound-service.ts (sending approval cards)
 *   - feishu-channel-command-service.ts (slash command parsing)
 *   - process-channel-event-service.ts inline card_action branch
 *
 * Streaming card lifecycle is owned by feishu-chat-session.ts; this
 * router is concerned with control-flow events (approvals + commands).
 */

const APPROVAL_TTL_MINUTES_DEFAULT = 5;
const SECRET_FALLBACK = "magister-approval-secret-change-me";

/** Map approvalId → outbound delivery (so resolve hook can locate it). */
const approvalCardIndex = new Map<
  string,
  { chatId: string; bindingId: string; messageId: string; expiresAtMs: number }
>();

function getApprovalSecret(): string {
  const fromEnv = process.env.MAGISTER_FEISHU_APPROVAL_SECRET?.trim();
  if (fromEnv) return fromEnv;
  if (process.env.NODE_ENV === "production") {
    throw new Error("MAGISTER_FEISHU_APPROVAL_SECRET must be set in production");
  }
  return SECRET_FALLBACK;
}

function getApprovalTtlMinutes(): number {
  const raw = process.env.MAGISTER_FEISHU_APPROVAL_TTL_MINUTES;
  if (!raw) return APPROVAL_TTL_MINUTES_DEFAULT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return APPROVAL_TTL_MINUTES_DEFAULT;
  return parsed;
}

/**
 * Lookup the feishu binding for a task. Used to figure out which chat
 * an approval card should go to. Returns null when the task wasn't
 * created via Feishu.
 */
async function resolveBindingForTask(
  taskId: string,
): Promise<{ bindingId: string; chatId: string } | null> {
  const sessionRepo = new ChannelSessionRepository();
  const session = await sessionRepo.findByCurrentTaskId(taskId);
  if (!session || session.channel !== "feishu") return null;
  const bindingRepo = new ConversationBindingRepository();
  const binding = await bindingRepo.getById(session.bindingId);
  if (!binding || binding.channel !== "feishu") return null;
  return { bindingId: binding.id, chatId: binding.chatId };
}

/**
 * Send an approval card to the chat the task was created from.
 * Wired as a `command-approval-service.onApprovalCreated` hook in
 * `register()` below.
 */
async function sendApprovalCard(approval: ApprovalRecord): Promise<void> {
  if (areMagisterChannelsDisabled()) return;
  const client = buildFeishuClientIfConfigured();
  if (!client) return;
  const target = await resolveBindingForTask(approval.taskId);
  if (!target) return;

  const args = approval.toolArgs ?? {};
  const command =
    typeof args.command === "string"
      ? args.command
      : typeof args.input === "string"
        ? args.input
        : null;
  const reason =
    typeof args.reason === "string"
      ? args.reason
      : typeof args.danger_reason === "string"
        ? (args.danger_reason as string)
        : typeof args.justification === "string"
          ? (args.justification as string)
          : null;
  const isQuestion = approval.toolName === "request_human_input";

  const ttlMinutes = getApprovalTtlMinutes();
  const expiresAtMs = Date.now() + ttlMinutes * 60_000;
  const secret = getApprovalSecret();

  const approveEnvelope = buildEnvelope({
    kind: "button",
    action: "approval.approve",
    context: {
      s: approval.id,
      h: target.chatId,
      e: expiresAtMs,
      t: "group",
    },
    metadata: { taskId: approval.taskId, toolName: approval.toolName },
    secret,
  });
  const rejectEnvelope = buildEnvelope({
    kind: "button",
    action: "approval.reject",
    context: {
      s: approval.id,
      h: target.chatId,
      e: expiresAtMs,
      t: "group",
    },
    metadata: { taskId: approval.taskId, toolName: approval.toolName },
    secret,
  });

  const card = buildApprovalCard({
    envelope: { approve: approveEnvelope, reject: rejectEnvelope },
    toolName: approval.toolName,
    bodyMarkdown: buildApprovalBodyMarkdown({
      toolName: approval.toolName,
      command,
      reason,
      summary: approval.summary,
      isQuestion,
    }),
    isQuestion,
    ttlMinutes,
    taskIdShort: approval.taskId.slice(-8),
  });

  try {
    const result = await enqueue(feishuChatKey(target.bindingId), () =>
      client.sendCardMessage({ chatId: target.chatId, card }),
    );
    approvalCardIndex.set(approval.id, {
      chatId: target.chatId,
      bindingId: target.bindingId,
      messageId: result.messageId,
      expiresAtMs,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[feishu-router] sendApprovalCard ${approval.id.slice(-8)} failed:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Handle a `card.action.trigger` event. Returns the WS callback
 * response (`{toast, card}`) which the gateway returns to Feishu —
 * Feishu replaces the original card in-place with this response.
 *
 * Audit drift fix:
 *   - Previous approval-outbound-service ALSO sent a separate
 *     resolved-state card via `handleResolved` hook → user saw TWO
 *     cards per resolve. Now the WS response IS the replacement; the
 *     hook is no longer registered.
 *   - Response wrapper uses `{toast, card:{type:"raw",data:...}}` per
 *     schema 2.0 canonical shape (bare `{card:...}` returns 200672).
 */
export async function handleCardActionEvent(input: {
  /** The card_action payload's flattened action.value object. */
  payload: Record<string, unknown>;
  /** Open chat id from the event context. */
  chatId: string;
  /** Clicker's open_id, if known. */
  operatorOpenId?: string | undefined;
  /** Resolved conversation binding row. */
  binding: { id: string; channel: string };
}): Promise<{
  ok: boolean;
  errorCode?: string;
  cardResponse?: object;
  /** Real ids surfaced for observability/log payloads (avoid synthetic placeholders in intake). */
  approvalId?: string;
  taskId?: string;
  state?: "approved" | "rejected" | "expired";
}> {
  try {
    return await handleCardActionEventInner(input);
  } catch (err) {
    // Top-level safety net: an unexpected throw (DB hiccup, approval-
    // service exception) must NOT bubble out as a WS-level 500. We
    // need to return a Feishu-compatible callback payload so the
    // user gets a toast instead of a generic protocol error.
    // eslint-disable-next-line no-console
    console.error(
      "[feishu-router] handleCardActionEvent unexpected error:",
      err instanceof Error ? err.message : err,
    );
    return { ok: false, errorCode: "internal_error" };
  }
}

async function handleCardActionEventInner(input: {
  payload: Record<string, unknown>;
  chatId: string;
  operatorOpenId?: string | undefined;
  binding: { id: string; channel: string };
}): Promise<{
  ok: boolean;
  errorCode?: string;
  cardResponse?: object;
  approvalId?: string;
  taskId?: string;
  state?: "approved" | "rejected" | "expired";
}> {
  if (input.binding.channel !== "feishu") {
    return { ok: false, errorCode: "wrong_channel" };
  }

  // Unwrap the JSON-stringified envelope. v1 cards can only carry
  // scalar values in button.value, so we packed the ocf1 envelope as
  // `value: { envelope: "<json>" }` (audit confirmed this is correct
  // for v1 — schema 2.0 would use `behaviors`).
  let envelopeCandidate: unknown = input.payload;
  const envelopeString = (input.payload as Record<string, unknown>).envelope;
  if (typeof envelopeString === "string") {
    try {
      envelopeCandidate = JSON.parse(envelopeString);
    } catch {
      /* fall through and let decodeEnvelope reject */
    }
  }

  const decoded = decodeEnvelope({
    value: envelopeCandidate,
    context: {
      secret: getApprovalSecret(),
      eventChatId: input.chatId,
      ...(input.operatorOpenId ? { operatorOpenId: input.operatorOpenId } : {}),
      // Single-operator Magister: don't bind clicks to a specific user.
      skipUserCheck: true,
    },
  });

  if (decoded.kind !== "structured") {
    return {
      ok: false,
      errorCode: decoded.kind === "invalid" ? `envelope_${decoded.reason}` : "envelope_legacy",
    };
  }

  const envelope = decoded.envelope;
  const approvalId = envelope.c?.s;
  if (!approvalId) {
    return { ok: false, errorCode: "envelope_missing_approval_id" };
  }

  const action = envelope.a;
  const resolution: "approved" | "rejected" | null =
    action === "approval.approve" || action === "approval.continue"
      ? "approved"
      : action === "approval.reject" || action === "approval.stop"
        ? "rejected"
        : null;
  if (!resolution) {
    return { ok: false, errorCode: `envelope_unknown_action:${action}` };
  }

  // Resolve via the approval-service (web path) so all the same
  // observability + side-effect machinery fires.
  const { resolveApproval } = await import("../approval-service");
  const approval = await commandGetApproval(approvalId);
  if (!approval) {
    return { ok: false, errorCode: "approval_not_found" };
  }
  const resolved = await resolveApproval({
    approvalId,
    resolution,
    source: "feishu",
    ...(input.operatorOpenId ? { actorId: input.operatorOpenId } : {}),
  });
  if (!resolved) {
    return { ok: false, errorCode: "approval_not_found" };
  }

  // Build the replacement card showing the resolved state.
  const args = approval.toolArgs ?? {};
  const command =
    typeof args.command === "string"
      ? args.command
      : typeof args.input === "string"
        ? (args.input as string)
        : null;
  const isQuestion = approval.toolName === "request_human_input";

  const resolvedAtMs =
    typeof resolved.resolvedAt === "string"
      ? new Date(resolved.resolvedAt).getTime()
      : Date.now();
  const replacement = buildApprovalResolvedCard({
    state: resolved.state as "approved" | "rejected" | "expired",
    resolvedBy: input.operatorOpenId ?? "user",
    toolName: approval.toolName,
    bodyMarkdown: buildApprovalBodyMarkdown({
      toolName: approval.toolName,
      command,
      reason: null,
      summary: approval.summary,
      isQuestion,
    }),
    resolvedAtMs,
  });

  // Clean up the index — this approval is done.
  approvalCardIndex.delete(approvalId);

  return {
    ok: true,
    approvalId,
    taskId: approval.taskId,
    state: resolved.state as "approved" | "rejected" | "expired",
    cardResponse: buildCallbackResponse({
      replacementCard: replacement,
      toastType:
        resolved.state === "approved"
          ? "success"
          : resolved.state === "rejected"
            ? "error"
            : "warning",
      toastContent:
        resolved.state === "approved"
          ? "Approved"
          : resolved.state === "rejected"
            ? "Rejected"
            : "Expired",
    }),
  };
}

/**
 * Handle resolve from a NON-feishu channel (e.g. web clicks). The
 * original approval card in Feishu still has active buttons; send a
 * replacement notification card so the operator sees what happened.
 *
 * For Feishu-source resolutions, `handleCardActionEvent` already
 * replaced the card in-place — we DON'T need to fire here. Detected
 * by checking the `payload.source` written during resolution.
 */
async function sendResolvedNotificationCardForWebResolve(approval: ApprovalRecord): Promise<void> {
  if (areMagisterChannelsDisabled()) return;
  const indexed = approvalCardIndex.get(approval.id);
  if (!indexed) return; // never had a Feishu card

  // Check source: if Feishu resolved, the WS handler already
  // replaced the original card; skip to avoid double-send.
  const repo = new ApprovalRepository();
  const row = await repo.getById(approval.id);
  let source: string | null = null;
  if (row?.payloadJson) {
    try {
      const parsed = JSON.parse(row.payloadJson) as Record<string, unknown>;
      if (typeof parsed.source === "string") source = parsed.source;
    } catch {
      /* ignore */
    }
  }
  if (source === "feishu") {
    approvalCardIndex.delete(approval.id);
    return;
  }

  const client = buildFeishuClientIfConfigured();
  if (!client) return;
  const args = approval.toolArgs ?? {};
  const command =
    typeof args.command === "string"
      ? args.command
      : typeof args.input === "string"
        ? (args.input as string)
        : null;
  const isQuestion = approval.toolName === "request_human_input";
  const card = buildApprovalResolvedCard({
    state: approval.status as "approved" | "rejected" | "expired",
    resolvedBy: approval.resolvedBy ?? "web",
    toolName: approval.toolName,
    bodyMarkdown: buildApprovalBodyMarkdown({
      toolName: approval.toolName,
      command,
      reason: null,
      summary: approval.summary,
      isQuestion,
    }),
    resolvedAtMs: approval.resolvedAt ?? Date.now(),
  });

  try {
    // Main lane (same as streaming-card content PATCHes) so a
    // resolution-notification card can't overtake a trailing content
    // PATCH at Feishu's API — mirrors the close-time fix in
    // feishu-chat-session.ts.
    await enqueue(feishuChatKey(indexed.bindingId), () =>
      client.sendCardMessage({ chatId: indexed.chatId, card }),
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[feishu-router] sendResolvedNotificationCard ${approval.id.slice(-8)} failed:`,
      err instanceof Error ? err.message : err,
    );
  }
  approvalCardIndex.delete(approval.id);
}

/**
 * Register all Feishu-side hooks. Idempotent — calling twice cleans
 * up the first registration. Called from server.ts at startup.
 */
let unregister: (() => void) | null = null;

export function registerFeishuRouter(): void {
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
  // We intentionally do NOT subscribe to onApprovalResolved here.
  // Feishu-source resolutions are handled in-band via the WS card
  // action callback's replacement card; web-source resolutions are
  // surfaced via a separate notification card flow that we trigger
  // explicitly from the approval-service if/when we want it.
  unregister = () => {
    unsubCreated();
  };
}

export function unregisterFeishuRouter(): void {
  if (unregister) {
    unregister();
    unregister = null;
  }
  approvalCardIndex.clear();
}

/** Diagnostic snapshot. */
export function getRouterSnapshot() {
  return {
    pendingApprovalCards: approvalCardIndex.size,
    approvals: Array.from(approvalCardIndex.entries()).map(([id, entry]) => ({
      approvalIdShort: id.slice(-12),
      chatId: entry.chatId,
      ttlMs: Math.max(0, entry.expiresAtMs - Date.now()),
    })),
  };
}

/** Test helper. */
export function __resetApprovalIndexForTests(): void {
  approvalCardIndex.clear();
}

// Re-export for callers that want to send a resolved-state card
// after a web-channel resolution (called from approval-service or
// similar, NOT a hook to avoid double-firing on feishu source).
export { sendResolvedNotificationCardForWebResolve };
